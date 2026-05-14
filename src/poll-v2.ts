import { createHash } from "node:crypto";
import { configPath } from "./config.ts";
import { loadConfigV2 } from "./config-v2.ts";
import { curateTicket } from "./curator.ts";
import { addLabels, claimIssue } from "./github.ts";
import { planIngest, type IngestPlan } from "./rules.ts";
import {
  executeGhCommentDecision,
  executeHoldDecision,
  spawnOteamAssign,
} from "./sinks/curator-actions.ts";
import { holdItemForSecurityReview } from "./sinks/security.ts";
import { pullUrlIntoVault } from "./sinks/vault.ts";
import { findVaultTicketPath, readRecentVaultTickets } from "./vault-read.ts";
import { archiveFolderItem, readFolder } from "./sources/folder.ts";
import { readGitHubIssues } from "./sources/github_issues.ts";
import { readGitHubPrs } from "./sources/github_prs.ts";
import { readLinear } from "./sources/linear.ts";
import { State } from "./state.ts";
import { triageIssue } from "./triage.ts";
import type {
  ConfigV2,
  GitHubIssue,
  IngestAction,
  Item,
  RepoConfig,
  SourceConfig,
  TriageResult,
} from "./types.ts";

export type DryRunOptions = {
  withTriage: boolean;
  triageLimit: number;
};

/**
 * Spike dry-run of the v2 pipeline. Reads each configured source, optionally
 * runs triage on github_issues items (off by default), then runs planIngest
 * against the rule list and prints what *would* happen. Mutates nothing —
 * no archive, no sink writes, no label writes.
 *
 * Sources without a v2 reader yet (github_prs) are reported as SKIPPED.
 * Per-source errors are isolated; one failing source doesn't poison the tick.
 */
export async function pollV2DryRun(opts: DryRunOptions): Promise<number> {
  const cfg = loadConfigV2(configPath());
  console.log(
    `[v2 dry-run] scanning ${cfg.sources.length} source${plural(cfg.sources.length)} ` +
      `from ${cfg.defaults.config_path}` +
      (opts.withTriage ? `  (triage on, limit ${opts.triageLimit})` : "") +
      "\n",
  );

  const state = new State(cfg.defaults.state_dir);
  try {
    return await runDryRun(cfg, opts, state);
  } finally {
    state.close();
  }
}

async function runDryRun(
  cfg: ConfigV2,
  opts: DryRunOptions,
  state: State,
): Promise<number> {

  let totalItems = 0;
  let totalDrops = 0;
  let totalErrors = 0;
  const budget = {
    remaining: opts.withTriage ? opts.triageLimit : 0,
    cost_usd: 0,
    triaged: 0,
  };

  for (const source of cfg.sources) {
    const cursorNote = describeCursor(source, state);
    let items: Item[] | null;
    try {
      items = await readSource(source, state);
    } catch (e) {
      console.log(`${source.name} (${source.kind})${cursorNote}: ERROR — ${(e as Error).message}`);
      console.log();
      totalErrors++;
      continue;
    }
    if (items === null) {
      console.log(`${source.name} (${source.kind})${cursorNote}: SKIPPED — no v2 reader yet`);
      console.log();
      continue;
    }
    console.log(`${source.name} (${source.kind}${cursorNote}, ${items.length} item${plural(items.length)}):`);
    for (const original of items) {
      const { item, note } = await maybeTriageItem(original, cfg, opts, budget);
      const plan = planIngest(item, cfg);
      console.log(`  • "${item.title}" → ${formatPlan(plan)}${note}`);
      if (plan.via === "drop") totalDrops++;
    }
    if (items.length === 0) console.log("  (no items)");
    console.log();
    totalItems += items.length;
  }

  const triageSummary = opts.withTriage
    ? `  ${budget.triaged} triaged ($${budget.cost_usd.toFixed(4)} total).`
    : "";
  console.log(
    `[v2 dry-run] ${totalItems} item${plural(totalItems)} planned ` +
      `(${totalDrops} would drop, ${totalErrors} source error${plural(totalErrors)}) ` +
      `across ${cfg.sources.length} source${plural(cfg.sources.length)}.${triageSummary} ` +
      `No state mutated.`,
  );
  return totalErrors > 0 ? 1 : 0;
}

function triageable(item: Item): boolean {
  // Folder items are user-authored; triage is a github_issues affordance for now.
  return item.source.kind === "github_issues";
}

/**
 * Run triage for one Item and return an enriched copy with merged labels +
 * derived type. Today's triage prompt is github-shaped, so this only handles
 * github_issues sources; a kind-generic triage path is a follow-on.
 */
async function triageItem(
  item: Item,
  cfg: ConfigV2,
): Promise<{ enriched: Item; cost_usd: number | null; triage: TriageResult }> {
  if (item.source.kind !== "github_issues") {
    throw new Error(`triage not implemented for source kind: ${item.source.kind}`);
  }
  const issue = item.raw as GitHubIssue;
  const fakeRepo: RepoConfig = {
    slug: item.repo ?? "",
    vault: "",
    project: "",
    can_label: false,
    autopilot: "off",
  };
  const out = await triageIssue({
    issue,
    repo: fakeRepo,
    model: cfg.defaults.triage_model,
    bodyTruncate: cfg.defaults.body_truncate_chars,
  });
  const extraLabels = [...out.result.labels_to_add];
  if (out.result.security_flag) extraLabels.push("security");
  const mergedLabels = Array.from(new Set([...item.labels, ...extraLabels]));
  const enriched: Item = {
    ...item,
    labels: mergedLabels,
    type: deriveType(out.result),
    triage_result: out.result,
  };
  return { enriched, cost_usd: out.cost_usd, triage: out.result };
}

/**
 * Shared budget-aware triage step for both dry-run and execute paths.
 * Mutates `budget` in place. Returns the (possibly enriched) item plus a
 * short note for logging.
 */
async function maybeTriageItem(
  item: Item,
  cfg: ConfigV2,
  opts: { withTriage: boolean; triageLimit: number },
  budget: { remaining: number; cost_usd: number; triaged: number },
): Promise<{ item: Item; note: string }> {
  if (!opts.withTriage || !triageable(item)) return { item, note: "" };
  if (budget.remaining <= 0) {
    return { item, note: "\n      triage: SKIPPED (budget exhausted)" };
  }
  try {
    const out = await triageItem(item, cfg);
    budget.remaining--;
    budget.triaged++;
    if (out.cost_usd !== null) budget.cost_usd += out.cost_usd;
    const note =
      `\n      triage: type=${out.enriched.type ?? "null"}` +
      `  labels=[${out.enriched.labels.join(", ")}]` +
      `  cost=$${(out.cost_usd ?? 0).toFixed(4)}`;
    return { item: out.enriched, note };
  } catch (e) {
    return { item, note: `\n      triage ERROR: ${(e as Error).message}` };
  }
}

/**
 * Map a TriageResult onto an Item.type string. Today's triage doesn't emit
 * `type` directly; we derive it from labels_to_add (priority order) and
 * security_flag. A future slice can extend the triage prompt to emit type
 * explicitly and retire this helper.
 */
export function deriveType(t: TriageResult): string | null {
  if (t.security_flag) return "security";
  const priority = ["bug", "feature", "enhancement", "docs", "question"];
  for (const p of priority) {
    if (t.labels_to_add.includes(p)) return p;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Execute path — `dispatch poll --v2` (no --dry-run).
// Scope of THIS slice: sink=vault on github_issues with autopilot=off, plus
// sink=drop. Everything else is logged as "unimplemented" and does NOT
// advance the cursor (so the next implemented slice picks it up).
// ─────────────────────────────────────────────────────────────────────────

export type ExecOptions = {
  withTriage: boolean;
  triageLimit: number;
};

export async function pollV2Once(opts: ExecOptions): Promise<number> {
  const cfg = loadConfigV2(configPath());
  const state = new State(cfg.defaults.state_dir);
  console.log(
    `[v2 poll] executing across ${cfg.sources.length} source${plural(cfg.sources.length)} ` +
      `from ${cfg.defaults.config_path}` +
      (opts.withTriage ? `  (triage on, limit ${opts.triageLimit})` : "") +
      "\n",
  );
  try {
    return await runExecute(cfg, state, opts);
  } finally {
    state.close();
  }
}

type SpawnOutcome =
  | { kind: "spawned"; status: "fired" | "driving"; pid: number }
  | { kind: "lost-race"; assignees: string[] }
  | { kind: "issue-closed" }
  | { kind: "no-write-access" }
  | { kind: "claim-error"; error: string }
  | { kind: "spawn-failed"; error: string };

type CuratorOutcome = {
  decision: "fire" | "gh-comment" | "hold";
  reasoning: string;
  cost_usd: number | null;
  spawn?: SpawnOutcome;
};

type ExecOutcome =
  | {
      kind: "filed";
      ticket_ref: string | null;
      labels_added: number;
      curator?: CuratorOutcome;
      curator_error?: string;
    }
  | { kind: "dropped" }
  | { kind: "security-held"; path: string }
  | { kind: "already-filed" }
  | { kind: "needs-triage" }
  | { kind: "unimplemented"; reason: string }
  | { kind: "error"; error: string };

async function runExecute(cfg: ConfigV2, state: State, opts: ExecOptions): Promise<number> {
  let totals = {
    filed: 0,
    dropped: 0,
    securityHeld: 0,
    alreadyFiled: 0,
    needsTriage: 0,
    unimplemented: 0,
    errored: 0,
    sourceErrors: 0,
  };
  const budget = {
    remaining: opts.withTriage ? opts.triageLimit : 0,
    cost_usd: 0,
    triaged: 0,
  };

  for (const source of cfg.sources) {
    if (
      source.kind === "github_issues" ||
      source.kind === "github_prs" ||
      source.kind === "linear"
    ) {
      const seeded = state.ensureV2CursorSeeded(source.name, new Date().toISOString());
      if (seeded) {
        console.log(`${source.name} (${source.kind}): seeded cursor to now (first sight; no backfill)`);
        console.log();
        continue;
      }
    }

    let items: Item[] | null;
    try {
      items = await readSource(source, state);
    } catch (e) {
      console.log(`${source.name} (${source.kind}): SOURCE ERROR — ${(e as Error).message}`);
      console.log();
      totals.sourceErrors++;
      continue;
    }
    if (items === null) {
      console.log(`${source.name} (${source.kind}): SKIPPED — no v2 reader yet`);
      console.log();
      continue;
    }

    console.log(`${source.name} (${source.kind}, ${items.length} item${plural(items.length)}):`);
    if (items.length === 0) {
      console.log("  (no new items)");
      console.log();
      continue;
    }

    let canAdvanceCursor = true;
    let maxUpdatedAt = state.getV2Cursor(source.name) ?? "";

    for (const original of items) {
      const { item, note: triageNote } = await maybeTriageItem(original, cfg, opts, budget);
      const plan = planIngest(item, cfg);
      let outcome: ExecOutcome;
      try {
        outcome = await executeItem(item, source, plan, state, cfg);
      } catch (e) {
        outcome = { kind: "error", error: (e as Error).message };
        state.markV2Seen({
          source_name: source.name,
          external_id: item.external_id,
          content_hash: contentHash(item),
          vault_ticket_id: null,
          status: "error",
          plan_via: plan.via,
          plan_rule_name: plan.via === "rule" ? plan.rule_name : null,
        });
      }
      console.log(`  • "${item.title}" → ${formatPlan(plan)}   ${formatOutcome(outcome)}${triageNote}`);
      bumpCounter(totals, outcome);
      if (
        outcome.kind === "unimplemented" ||
        outcome.kind === "error" ||
        outcome.kind === "needs-triage"
      ) {
        canAdvanceCursor = false;
      }
      // Folder items are deduped by the filesystem, not a cursor. Move them
      // out of the source dir on any terminal outcome so the next tick doesn't
      // re-pick-them-up.
      if (
        source.kind === "folder" &&
        (outcome.kind === "filed" ||
          outcome.kind === "dropped" ||
          outcome.kind === "security-held" ||
          outcome.kind === "already-filed")
      ) {
        try {
          archiveFolderItem(source, item);
        } catch (e) {
          console.log(`    (archive failed: ${(e as Error).message})`);
        }
      }
      if (
        source.kind === "github_issues" ||
        source.kind === "github_prs" ||
        source.kind === "linear"
      ) {
        const raw = item.raw as { updated_at?: string; updatedAt?: string };
        const updated = raw.updated_at ?? raw.updatedAt;
        if (updated && updated > maxUpdatedAt) maxUpdatedAt = updated;
      }
    }

    const cursored =
      source.kind === "github_issues" ||
      source.kind === "github_prs" ||
      source.kind === "linear";
    if (cursored && canAdvanceCursor && maxUpdatedAt) {
      state.setV2Cursor(source.name, maxUpdatedAt);
      console.log(`  cursor → ${maxUpdatedAt}`);
    } else if (cursored && !canAdvanceCursor) {
      console.log(`  cursor NOT advanced (errors or unimplemented items will retry next tick)`);
    }
    console.log();
  }

  const triageSummary = opts.withTriage
    ? ` triaged=${budget.triaged} cost=$${budget.cost_usd.toFixed(4)}`
    : "";
  console.log(
    `[v2 poll] filed=${totals.filed} dropped=${totals.dropped} ` +
      `security-held=${totals.securityHeld} already=${totals.alreadyFiled} ` +
      `needs-triage=${totals.needsTriage} unimpl=${totals.unimplemented} ` +
      `errored=${totals.errored} source-errors=${totals.sourceErrors}${triageSummary}`,
  );
  return totals.errored > 0 || totals.sourceErrors > 0 ? 1 : 0;
}

async function executeItem(
  item: Item,
  source: SourceConfig,
  plan: IngestPlan,
  state: State,
  cfg: ConfigV2,
): Promise<ExecOutcome> {
  const existing = state.getV2Seen(source.name, item.external_id);
  if (existing && existing.status === "filed") {
    return { kind: "already-filed" };
  }

  if (plan.via === "drop") {
    state.markV2Seen({
      source_name: source.name,
      external_id: item.external_id,
      content_hash: contentHash(item),
      vault_ticket_id: null,
      status: "dropped",
      plan_via: plan.via,
      plan_rule_name: null,
    });
    return { kind: "dropped" };
  }

  const action: IngestAction = plan.action;
  if (action.skip) {
    state.markV2Seen({
      source_name: source.name,
      external_id: item.external_id,
      content_hash: contentHash(item),
      vault_ticket_id: null,
      status: "dropped",
      plan_via: plan.via,
      plan_rule_name: plan.via === "rule" ? plan.rule_name : null,
    });
    return { kind: "dropped" };
  }

  const sink = action.sink ?? "vault";
  const autopilot = action.autopilot ?? "off";

  if (sink === "drop") {
    state.markV2Seen({
      source_name: source.name,
      external_id: item.external_id,
      content_hash: contentHash(item),
      vault_ticket_id: null,
      status: "dropped",
      plan_via: plan.via,
      plan_rule_name: plan.via === "rule" ? plan.rule_name : null,
    });
    return { kind: "dropped" };
  }

  if (sink === "security-inbox") {
    const held = holdItemForSecurityReview({
      item,
      flag: item.triage_result?.security_flag ?? null,
      stateDir: cfg.defaults.state_dir,
    });
    state.markV2Seen({
      source_name: source.name,
      external_id: item.external_id,
      content_hash: contentHash(item),
      vault_ticket_id: null,
      status: "security-held",
      plan_via: plan.via,
      plan_rule_name: plan.via === "rule" ? plan.rule_name : null,
    });
    return { kind: "security-held", path: held.path };
  }

  // sink === "vault" from here on
  if (source.kind !== "github_issues") {
    return { kind: "unimplemented", reason: `vault sink not implemented for ${source.kind} source yet` };
  }
  // autopilot=drive is partly implemented in this slice: initial fire works
  // the same as autopilot=fire; the re-fire-on-state-advance behavior lives
  // with the lifecycle engine (separate phase). Until then, autopilot=drive
  // tickets land in state="driving" and stay there.
  if (!action.vault || !action.project) {
    return {
      kind: "error",
      error: `sink=vault requires both do.vault and do.project; got vault=${action.vault ?? "(unset)"} project=${action.project ?? "(unset)"}`,
    };
  }

  if (!item.url) {
    return { kind: "error", error: "github_issues item has no URL to pull" };
  }

  // SECURITY GATE: github_issues bodies are externally-authored and may contain
  // secrets, vuln disclosures, PII, or abuse. The triage step is the
  // load-bearing filter that decides whether content can reach the vault. If
  // triage hasn't run, refuse the vault write — don't advance the cursor, so
  // the item retries on a tick where --with-triage is set. (Linear/folder
  // items are user/team-authored and skip this check.)
  if (!item.triage_result) {
    state.markV2Seen({
      source_name: source.name,
      external_id: item.external_id,
      content_hash: contentHash(item),
      vault_ticket_id: null,
      status: "needs-triage",
      plan_via: plan.via,
      plan_rule_name: plan.via === "rule" ? plan.rule_name : null,
    });
    return { kind: "needs-triage" };
  }

  const r = pullUrlIntoVault({ htmlUrl: item.url, vault: action.vault, project: action.project });
  if (!r.ok) {
    state.markV2Seen({
      source_name: source.name,
      external_id: item.external_id,
      content_hash: contentHash(item),
      vault_ticket_id: null,
      status: "error",
      plan_via: plan.via,
      plan_rule_name: plan.via === "rule" ? plan.rule_name : null,
    });
    return { kind: "error", error: r.error };
  }

  // do.add_labels — apply post-file. We're already narrowed to a github_issues
  // source here. Skip when can_label=false. Failures don't fail the file;
  // the vault ticket already exists.
  let labelsAdded = 0;
  const wantLabels = action.add_labels ?? [];
  if (wantLabels.length > 0) {
    if (!source.can_label) {
      console.log(`    (add_labels skipped: source.can_label=false on ${source.name})`);
    } else {
      const issueNumber = (item.raw as { number?: number }).number;
      if (typeof issueNumber === "number") {
        try {
          addLabels(source.slug, issueNumber, wantLabels);
          labelsAdded = wantLabels.length;
        } catch (e) {
          console.log(`    (add_labels failed for ${source.slug}#${issueNumber}: ${(e as Error).message})`);
        }
      }
    }
  }

  state.markV2Seen({
    source_name: source.name,
    external_id: item.external_id,
    content_hash: contentHash(item),
    vault_ticket_id: r.ref,
    status: "filed",
    plan_via: plan.via,
    plan_rule_name: plan.via === "rule" ? plan.rule_name : null,
  });

  // autopilot=off → terminal here.
  if (autopilot === "off") {
    return { kind: "filed", ticket_ref: r.ref, labels_added: labelsAdded };
  }

  // autopilot=curate-only → run curator, apply decision. (fire/drive return
  // unimplemented above; sub-slice D adds the orchestrator spawn.)
  if (!r.ref) {
    return {
      kind: "filed",
      ticket_ref: null,
      labels_added: labelsAdded,
      curator_error: "no ticket ref from oteam — cannot curate",
    };
  }
  const ticketPath = findVaultTicketPath(action.vault, r.ref);
  if (!ticketPath) {
    return {
      kind: "filed",
      ticket_ref: r.ref,
      labels_added: labelsAdded,
      curator_error: `vault ticket file for ${r.ref} not found under vault ${action.vault}`,
    };
  }

  const fakeRepo: RepoConfig = {
    slug: item.repo ?? "",
    vault: action.vault,
    project: action.project,
    can_label: source.can_label,
    autopilot,
  };
  const recentTickets = readRecentVaultTickets({
    vault: action.vault,
    repo: item.repo,
    windowDays: cfg.defaults.recent_vault_tickets_window_days,
    cap: cfg.defaults.recent_vault_tickets_cap,
  });

  let curator: CuratorOutcome;
  try {
    const out = await curateTicket({
      ticketBodyPath: ticketPath,
      repo: fakeRepo,
      recentVaultTickets: recentTickets,
      curatorModel: cfg.defaults.curator_model,
      perCallMaxBudgetUsd: cfg.defaults.per_call_max_budget_usd,
    });
    curator = {
      decision: out.decision.action,
      reasoning: out.decision.reasoning,
      cost_usd: out.cost_usd,
    };
    const issueNumber = (item.raw as { number?: number }).number ?? 0;
    if (out.decision.action === "gh-comment") {
      executeGhCommentDecision({
        repo: fakeRepo,
        number: issueNumber,
        decision: out.decision,
        ticketPath,
      });
      state.updateV2SeenAfterCurator({
        source_name: source.name,
        external_id: item.external_id,
        curator_decision: "gh-comment",
        status: "gh-resolved",
      });
    } else if (out.decision.action === "hold") {
      executeHoldDecision({
        repo: fakeRepo,
        number: issueNumber,
        decision: out.decision,
        ticketPath,
      });
      state.updateV2SeenAfterCurator({
        source_name: source.name,
        external_id: item.external_id,
        curator_decision: "hold",
        status: "held-for-human",
      });
    } else {
      // curator decision = "fire"
      if (autopilot === "curate-only") {
        // green-light but stop here — no orchestrator
        state.updateV2SeenAfterCurator({
          source_name: source.name,
          external_id: item.external_id,
          curator_decision: "fire",
          status: "green-lit",
        });
      } else {
        // autopilot=fire or drive — claim + spawn orchestrator. Reuses the
        // issueNumber computed above for the gh-comment/hold branches.
        const spawn = await fireOrchestrator({
          slug: source.slug,
          number: issueNumber,
          botIdentity: cfg.defaults.bot_identity,
          ticketPath,
          logDir: cfg.defaults.log_dir,
          autopilot,
        });
        curator.spawn = spawn;
        recordSpawnOutcome(state, source.name, item.external_id, spawn);
      }
    }
  } catch (e) {
    return {
      kind: "filed",
      ticket_ref: r.ref,
      labels_added: labelsAdded,
      curator_error: (e as Error).message,
    };
  }

  return { kind: "filed", ticket_ref: r.ref, labels_added: labelsAdded, curator };
}

/**
 * Claim the GH issue for `botIdentity`, then spawn `oteam assign --inline`
 * for the just-filed ticket. Returns a discriminated outcome the caller
 * can both log and persist.
 */
async function fireOrchestrator(args: {
  slug: string;
  number: number;
  botIdentity: string;
  ticketPath: string;
  logDir: string;
  autopilot: "fire" | "drive";
}): Promise<SpawnOutcome> {
  if (!args.botIdentity) {
    return { kind: "claim-error", error: "defaults.bot_identity is empty" };
  }
  const claim = claimIssue(args.slug, args.number, args.botIdentity);
  if (!claim.ok) {
    switch (claim.reason) {
      case "issue-closed":
        return { kind: "issue-closed" };
      case "already-claimed":
        return { kind: "lost-race", assignees: claim.assignees };
      case "no-write-access":
        return { kind: "no-write-access" };
      case "api-error":
        return { kind: "claim-error", error: claim.error };
      default: {
        // Exhaustiveness check. If IssueClaim gains a new failure reason
        // and we forget to handle it here, TypeScript catches it. Without
        // this, control would fall through and we'd spawn the orchestrator
        // after a failed claim — defeating the claim-before-spawn invariant.
        const _exhaustive: never = claim;
        return { kind: "claim-error", error: `unhandled claim outcome: ${JSON.stringify(_exhaustive)}` };
      }
    }
  }
  const r = spawnOteamAssign(args.ticketPath, args.logDir);
  if (!r.ok) return { kind: "spawn-failed", error: r.error };
  return {
    kind: "spawned",
    status: args.autopilot === "drive" ? "driving" : "fired",
    pid: r.pid,
  };
}

/** Map a SpawnOutcome to the right v2_seen status + spawned_pid update. */
function recordSpawnOutcome(
  state: State,
  sourceName: string,
  externalId: string,
  spawn: SpawnOutcome,
): void {
  const base = { source_name: sourceName, external_id: externalId, curator_decision: "fire" };
  switch (spawn.kind) {
    case "spawned":
      state.updateV2SeenAfterCurator({ ...base, status: spawn.status, spawned_pid: spawn.pid });
      return;
    case "lost-race":
      state.updateV2SeenAfterCurator({ ...base, status: "lost-race" });
      return;
    case "issue-closed":
      state.updateV2SeenAfterCurator({ ...base, status: "gh-resolved" });
      return;
    case "no-write-access":
    case "claim-error":
    case "spawn-failed":
      state.updateV2SeenAfterCurator({ ...base, status: "error" });
      return;
  }
}

function contentHash(item: Item): string {
  return createHash("sha256")
    .update(item.title + "\n---\n" + item.body)
    .digest("hex");
}

function formatOutcome(o: ExecOutcome): string {
  switch (o.kind) {
    case "filed": {
      const ref = o.ticket_ref ? `FILED ${o.ticket_ref}` : `FILED (no ref)`;
      const labels = o.labels_added > 0 ? ` +${o.labels_added} labels` : "";
      if (o.curator) {
        const cost = o.curator.cost_usd !== null ? ` cost=$${o.curator.cost_usd.toFixed(4)}` : "";
        const spawn = o.curator.spawn ? `  → ${formatSpawn(o.curator.spawn)}` : "";
        return `${ref}${labels}  curator: ${o.curator.decision}${cost}${spawn}`;
      }
      if (o.curator_error) {
        return `${ref}${labels}  curator ERROR: ${o.curator_error}`;
      }
      return `${ref}${labels}`;
    }
    case "dropped":
      return "DROPPED";
    case "security-held":
      return `SECURITY-HELD → ${o.path}`;
    case "already-filed":
      return "(already filed)";
    case "needs-triage":
      return "NEEDS-TRIAGE (github_issues → vault requires --with-triage)";
    case "unimplemented":
      return `UNIMPL: ${o.reason}`;
    case "error":
      return `ERROR: ${o.error}`;
  }
}

function formatSpawn(s: SpawnOutcome): string {
  switch (s.kind) {
    case "spawned":
      return `SPAWNED ${s.status.toUpperCase()} pid=${s.pid}`;
    case "lost-race":
      return `LOST-RACE (assignees=[${s.assignees.join(", ")}])`;
    case "issue-closed":
      return "ISSUE-CLOSED";
    case "no-write-access":
      return "NO-WRITE-ACCESS (token can't set assignees)";
    case "claim-error":
      return `CLAIM-ERROR: ${s.error}`;
    case "spawn-failed":
      return `SPAWN-FAILED: ${s.error}`;
  }
}

function bumpCounter(
  t: {
    filed: number;
    dropped: number;
    securityHeld: number;
    alreadyFiled: number;
    needsTriage: number;
    unimplemented: number;
    errored: number;
    sourceErrors: number;
  },
  o: ExecOutcome,
): void {
  switch (o.kind) {
    case "filed":
      t.filed++;
      break;
    case "dropped":
      t.dropped++;
      break;
    case "security-held":
      t.securityHeld++;
      break;
    case "already-filed":
      t.alreadyFiled++;
      break;
    case "needs-triage":
      t.needsTriage++;
      break;
    case "unimplemented":
      t.unimplemented++;
      break;
    case "error":
      t.errored++;
      break;
  }
}

async function readSource(source: SourceConfig, state: State): Promise<Item[] | null> {
  switch (source.kind) {
    case "folder":
      return readFolder(source);
    case "github_issues": {
      const since = state.getV2Cursor(source.name);
      return readGitHubIssues(source, since ? { since } : {});
    }
    case "github_prs": {
      const since = state.getV2Cursor(source.name);
      return readGitHubPrs(source, since ? { since } : {});
    }
    case "linear": {
      const since = state.getV2Cursor(source.name);
      return await readLinear(source, since ? { since } : {});
    }
  }
}

/**
 * Short human-readable note describing this source's cursor state, for
 * dry-run output. Empty for sources without cursor semantics (folder).
 */
function describeCursor(source: SourceConfig, state: State): string {
  if (
    source.kind !== "github_issues" &&
    source.kind !== "github_prs" &&
    source.kind !== "linear"
  ) {
    return "";
  }
  const cursor = state.getV2Cursor(source.name);
  if (!cursor) {
    if (source.kind === "github_prs") return ", cursor: none (recent open PRs)";
    if (source.kind === "linear") return ", cursor: none (recent issues)";
    return ", cursor: none (recent open issues)";
  }
  return `, cursor: ${cursor} (${humanAge(cursor)} ago)`;
}

function humanAge(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "?";
  const ms = Date.now() - then;
  if (ms < 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function formatPlan(plan: IngestPlan): string {
  if (plan.via === "drop") return "DROP (no rule matched, no [default])";
  const parts: string[] = [];
  if (plan.via === "rule") parts.push(`rule="${plan.rule_name}"`);
  else parts.push("via [default]");
  const a = plan.action;
  if (a.skip) parts.push("SKIP");
  if (a.sink) parts.push(`sink=${a.sink}`);
  if (a.vault) parts.push(`vault=${a.vault}`);
  if (a.project) parts.push(`project=${a.project}`);
  if (a.autopilot) parts.push(`autopilot=${a.autopilot}`);
  if (a.add_labels?.length) parts.push(`add_labels=[${a.add_labels.join(", ")}]`);
  return parts.join("  ");
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}
