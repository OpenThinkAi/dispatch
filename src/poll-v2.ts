import { createHash } from "node:crypto";
// SPIKE: poll-v2 deliberately uses console.log for per-item display lines and
// the per-tick summary line — these are CLI-mode rendering, not log events.
// All operational events (source/archive/curator/add-labels failures, security
// overrides) go through log.* per the AGENTS.md "structured JSON via log.ts"
// rule. Broader CLI-vs-daemon split happens when v2 daemon-mode wiring lands.

import { configPath } from "./config.ts";
import { loadConfigV2 } from "./config-v2.ts";
import { curateTicket } from "./curator.ts";
import {
  addLabels,
  claimIssue,
  fetchPullRequestDiff,
  postPullRequestReview,
} from "./github.ts";
import { log } from "./log.ts";
import { planIngest, type IngestPlan } from "./rules.ts";
import {
  executeGhCommentDecision,
  executeHoldDecision,
  spawnOteamAssign,
} from "./sinks/curator-actions.ts";
import { holdItemForSecurityReview } from "./sinks/security.ts";
import { fileLocalItemToVault, pullUrlIntoVault } from "./sinks/vault.ts";
import { runLifecycle } from "./lifecycle.ts";
import {
  diffLikelyContainsSecrets,
  reviewPullRequest,
  type ReviewVerdict,
} from "./review-agent.ts";
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
  GitHubPR,
  IngestAction,
  Item,
  LinearIssue,
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
    let items: Item[];
    try {
      items = await readSource(source, state);
    } catch (e) {
      log.warn("v2 source read failed", {
        source: source.name,
        kind: source.kind,
        error: (e as Error).message,
      });
      console.log(`${source.name} (${source.kind})${cursorNote}: ERROR — ${(e as Error).message}`);
      console.log();
      totalErrors++;
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
  // Folder items are user-authored and skip triage. Triage runs on every
  // non-folder source: github_issues / github_prs (externally-authored on
  // the GH side) and linear (team-internal but the workspace can have
  // guest seats or external integrations, so we don't trust it blanket).
  return (
    item.source.kind === "github_issues" ||
    item.source.kind === "github_prs" ||
    item.source.kind === "linear"
  );
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
  if (
    item.source.kind !== "github_issues" &&
    item.source.kind !== "github_prs" &&
    item.source.kind !== "linear"
  ) {
    throw new Error(`triage not implemented for source kind: ${item.source.kind}`);
  }
  // The triage prompt is issue-shaped (title/body/labels/user/state/number).
  // PRs share that shape directly; Linear maps with light translation
  // (state.name → "open"|"closed"; identifier → integer suffix; creator
  // email → user.login). The pull_request marker on the PR shim is unused
  // by the prompt itself but satisfies the GitHubIssue type.
  let issue: GitHubIssue;
  if (item.source.kind === "github_issues") {
    issue = item.raw as GitHubIssue;
  } else if (item.source.kind === "github_prs") {
    const pr = item.raw as GitHubPR;
    issue = {
      url: pr.url,
      html_url: pr.html_url,
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      labels: pr.labels,
      user: pr.user,
      created_at: pr.created_at,
      updated_at: pr.updated_at,
      pull_request: {},
    };
  } else {
    const li = item.raw as LinearIssue;
    const closed =
      li.state.name === "Done" || li.state.name === "Cancelled" || li.state.name === "Canceled";
    const numMatch = li.identifier.match(/(\d+)$/);
    issue = {
      url: li.url,
      html_url: li.url,
      number: numMatch ? parseInt(numMatch[1], 10) : 0,
      title: li.title,
      body: li.description,
      state: closed ? "closed" : "open",
      labels: (li.labels.nodes ?? []).map(l => ({ name: l.name })),
      user: li.creator ? { login: li.creator.email } : null,
      created_at: li.createdAt,
      updated_at: li.updatedAt,
    };
  }
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

type ReviewActionOutcome = {
  verdict: ReviewVerdict;
  cost_usd: number | null;
  posted: boolean;
};

/**
 * Distinguishes review failures that should retry on the next tick
 * ("transient" — network, SDK throw, gh post failure) from failures that
 * shouldn't ("permanent" — secret-scan refused the diff; re-fetching the
 * same diff would produce the same refusal). Threaded into canAdvanceCursor
 * so transient failures hold the cursor for retry, permanent ones don't.
 */
type ReviewFailureKind = "transient" | "permanent";

type ExecOutcome =
  | {
      kind: "filed";
      ticket_ref: string | null;
      labels_added: number;
      curator?: CuratorOutcome;
      curator_error?: string;
      review?: ReviewActionOutcome;
      review_error?: string;
      review_error_kind?: ReviewFailureKind;
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

    let items: Item[];
    try {
      items = await readSource(source, state);
    } catch (e) {
      log.warn("v2 source read failed", {
        source: source.name,
        kind: source.kind,
        error: (e as Error).message,
      });
      console.log(`${source.name} (${source.kind}): SOURCE ERROR — ${(e as Error).message}`);
      console.log();
      totals.sourceErrors++;
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
        outcome.kind === "needs-triage" ||
        (outcome.kind === "filed" && outcome.curator_error) ||
        (outcome.kind === "filed" && outcome.review_error_kind === "transient")
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
          log.warn("v2 folder archive failed", {
            source: source.name,
            external_id: item.external_id,
            error: (e as Error).message,
          });
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

  // Lifecycle pass after the source loop: scan every vault referenced by
  // any rule, snapshot ticket state, detect transitions, fire any matching
  // [[rule.lifecycle]] rules that haven't yet fired for the current
  // state-entry. Runs every tick regardless of whether sources had items.
  // Lifecycle errors are operational (one ticket file moved, one spawn
  // misconfigured) and are logged but deliberately don't trip the exit
  // code — a single bad rule shouldn't make every poll tick exit non-zero.
  const lifecycle = runLifecycle(cfg, state);
  if (cfg.lifecycle_rules.length > 0) {
    log.info("v2 lifecycle tick", {
      scanned: lifecycle.tickets_scanned,
      transitions: lifecycle.transitions,
      fired: lifecycle.rules_fired,
      skipped_dedup: lifecycle.rules_skipped_dedup,
      errors: lifecycle.errors,
    });
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
  // status="filed" alone is terminal ONLY when no autopilot lane was supposed
  // to follow the file. For github_prs + autopilot=review, the file step runs
  // first and marks status="filed", then the review-agent runs after. A
  // transient review failure (network, SDK throw, gh post blip) leaves the
  // row at "filed" with no curator_decision recorded — the next tick should
  // retry the review lane, not short-circuit. So already-filed only triggers
  // when the curator_decision was recorded (terminal pipeline) OR when the
  // matched rule wouldn't have run anything after file.
  if (existing && existing.status === "filed") {
    const wouldRunPostFileLane =
      source.kind === "github_prs" &&
      plan.via !== "drop" &&
      plan.action.autopilot === "review";
    if (!wouldRunPostFileLane || existing.curator_decision) {
      return { kind: "already-filed" };
    }
    // Fall through — re-enter the review lane to retry the post-file work.
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

  // SECURITY INVARIANT (defense-in-depth): if triage flagged this item, the
  // engine routes it to security-inbox regardless of what the rule said. The
  // rule list still expresses intent, but the invariant "security_flag never
  // reaches the vault" is enforced here, not by rule ordering.
  if (item.triage_result?.security_flag && sink !== "security-inbox") {
    log.warn("v2 security flag overrides rule routing", {
      source: source.name,
      external_id: item.external_id,
      flag_kind: item.triage_result.security_flag.kind,
      rule_sink: sink,
      rule_name: plan.via === "rule" ? plan.rule_name : null,
    });
    const held = holdItemForSecurityReview({
      item,
      flag: item.triage_result.security_flag,
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

  // sink === "vault" from here on. All four source kinds now file to vault:
  //   github_issues — full pipeline (triage + curator + orchestrator)
  //   github_prs    — autopilot=off (file only) or "review" (file + run the
  //                   review-agent and post the verdict back to GH)
  //   folder        — autopilot=off only, file via `oteam ticket new` + body
  //                   append (oteam owns the AGT-NNN allocation + frontmatter)
  //   linear        — autopilot=off only, same file-via-ticket-new path as
  //                   folder, with a `**Linear:** <url>` backlink prepended
  //                   to the body so the upstream issue stays linked
  if (source.kind === "github_prs" && autopilot !== "off" && autopilot !== "review") {
    return {
      kind: "unimplemented",
      reason: `autopilot="${autopilot}" not implemented for github_prs (only "off" and "review" are valid PR autopilots)`,
    };
  }
  if (source.kind !== "github_prs" && autopilot === "review") {
    return {
      kind: "unimplemented",
      reason: `autopilot="review" is only valid for github_prs sources, not ${source.kind}`,
    };
  }
  if (source.kind === "folder" && autopilot !== "off") {
    return {
      kind: "unimplemented",
      reason: `autopilot="${autopilot}" not implemented for folder source yet (folder-specific lane is a separate slice)`,
    };
  }
  if (source.kind === "linear" && autopilot !== "off") {
    return {
      kind: "unimplemented",
      reason: `autopilot="${autopilot}" not implemented for linear source yet (linear-specific lane is a separate slice)`,
    };
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

  // SECURITY GATE: external-source bodies are attacker-controlled (anyone
  // with read access on the GH repo can file an issue / PR; Linear
  // workspaces can carry guest seats or external integrations). Triage is
  // the load-bearing filter that decides whether content can reach the
  // vault — without it, the security-flag classifier never fires and
  // secret/PII content lands unscreened. So: if triage hasn't run, refuse
  // the vault write and don't advance the cursor; the item retries on a
  // tick where --with-triage is set.
  //
  // Folder is the only source kind that bypasses this gate — folder items
  // are authored locally by the operator on disk, so trust is direct.
  if (source.kind !== "folder") {
    if (!item.url) {
      return { kind: "error", error: `${source.kind} item has no URL to pull` };
    }
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
  }

  let r:
    | { ok: true; ref: string | null; path?: string | null }
    | { ok: false; error: string };
  if (source.kind === "folder") {
    r = fileLocalItemToVault({
      title: item.title,
      body: item.body,
      vault: action.vault,
      project: action.project,
      labels: action.add_labels,
    });
  } else if (source.kind === "linear") {
    // For Linear, prepend a `**Linear:** <url>` backlink so the vault ticket
    // links back to the upstream issue. external_id is the Linear identifier
    // (e.g. "ENG-123"); url is the linear.app URL. Keep backlink assembly
    // separate from body concatenation so the paragraph break between them
    // survives — `.filter(Boolean)` over an interleaved array would drop the
    // blank-line separator and the backlink would render inline with the body.
    const backlinks = [
      item.url ? `**Linear:** ${item.url}` : "",
      item.external_id ? `**Linear ID:** ${item.external_id}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const linearBody = backlinks ? `${backlinks}\n\n${item.body}` : item.body;
    r = fileLocalItemToVault({
      title: item.title,
      body: linearBody,
      vault: action.vault,
      project: action.project,
      labels: action.add_labels,
    });
  } else if (source.kind === "github_issues" || source.kind === "github_prs") {
    r = pullUrlIntoVault({ htmlUrl: item.url!, vault: action.vault, project: action.project });
  } else {
    // Exhaustiveness: every SourceKind must be handled above. A future
    // source kind added without a vault-file path will fail typecheck here.
    const _exhaustive: never = source;
    return {
      kind: "error",
      error: `vault sink: unhandled source kind ${(_exhaustive as { kind: string }).kind}`,
    };
  }
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

  // do.add_labels — apply post-file. github_issues only: github_prs doesn't
  // carry a can_label gate today (PR sources are read-only on the github
  // side in this slice). Skip when can_label=false on issue sources.
  // Failures don't fail the file outcome; the vault ticket already exists.
  let labelsAdded = 0;
  const wantLabels = action.add_labels ?? [];
  if (wantLabels.length > 0 && source.kind === "github_issues") {
    if (!source.can_label) {
      log.info("v2 add_labels skipped: can_label=false", {
        source: source.name,
        labels: wantLabels,
      });
    } else {
      const issueNumber = (item.raw as GitHubIssue).number;
      try {
        addLabels(source.slug, issueNumber, wantLabels);
        labelsAdded = wantLabels.length;
      } catch (e) {
        log.warn("v2 add_labels failed", {
          slug: source.slug,
          number: issueNumber,
          labels: wantLabels,
          error: (e as Error).message,
        });
      }
    }
  } else if (wantLabels.length > 0 && source.kind === "github_prs") {
    log.info("v2 add_labels skipped: not yet wired for github_prs", {
      source: source.name,
      labels: wantLabels,
    });
  } else if (
    wantLabels.length > 0 &&
    (source.kind === "folder" || source.kind === "linear")
  ) {
    // Labels were already passed to `oteam ticket new --label` inside
    // fileLocalItemToVault; surface the count in the FILED outcome line.
    labelsAdded = wantLabels.length;
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

  // github_prs + autopilot=review → fetch diff, run review-agent, post the
  // verdict back to GH as a PR review. Separate lane from the github_issues
  // curator chain below (which doesn't apply to PRs).
  if (source.kind === "github_prs" && autopilot === "review") {
    return await runPrReviewLane({
      item,
      source,
      cfg,
      state,
      plan,
      ticket_ref: r.ref,
      labels_added: labelsAdded,
    });
  }

  // autopilot in {curate-only, fire, drive} → run curator, apply decision.
  // For "fire"/"drive" + curator-fire, fireOrchestrator claims the GH issue
  // and spawns oteam-assign; for "curate-only" + curator-fire we just record
  // green-lit. gh-comment / hold decisions are the same across all three tiers.
  //
  // github_prs with non-off autopilot returned unimpl earlier, so by the
  // time we're here source must be github_issues. TypeScript can't see this
  // through the separate early-return; cast to the narrowed type so a
  // future refactor that breaks the invariant fails at compile time, not at
  // runtime.
  const issueSource = source as Extract<SourceConfig, { kind: "github_issues" }>;
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
    can_label: issueSource.can_label,
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
    const issueNumber = (item.raw as GitHubIssue).number;
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
        // The curator branch is only reachable for github_issues with
        // autopilot in {curate-only, fire, drive} — review returned early
        // via runPrReviewLane and curate-only goes through the green-lit
        // path above. Cast the autopilot to the narrowed union so the
        // fireOrchestrator signature matches.
        const spawn = await fireOrchestrator({
          slug: issueSource.slug,
          number: issueNumber,
          botIdentity: cfg.defaults.bot_identity,
          ticketPath,
          logDir: cfg.defaults.log_dir,
          autopilot: autopilot as "fire" | "drive",
        });
        curator.spawn = spawn;
        recordSpawnOutcome(state, source.name, item.external_id, spawn);
      }
    }
  } catch (e) {
    // Curator threw after file landed. Record a distinct status so the next
    // tick can re-attempt the curator instead of the already-filed guard
    // short-circuiting. The vault ticket exists; only the curator action is
    // unfinished. The caller holds the cursor so the item is re-fetched.
    state.updateV2SeenAfterCurator({
      source_name: source.name,
      external_id: item.external_id,
      curator_decision: "",
      status: "curator-errored",
    });
    log.warn("v2 curator threw after file landed", {
      source: source.name,
      external_id: item.external_id,
      vault_ticket: r.ref,
      error: (e as Error).message,
    });
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

/**
 * github_prs + autopilot=review path: fetch the PR diff, run the review-agent,
 * post the verdict back to GH. Returns a "filed" ExecOutcome enriched with
 * the review action's verdict + cost + posted status. Diff-fetch failures
 * and reviewer SDK failures land in `review_error`; gh post failures land
 * in `review_error` too but the verdict still records as the local outcome.
 */
async function runPrReviewLane(args: {
  item: Item;
  source: Extract<SourceConfig, { kind: "github_prs" }>;
  cfg: ConfigV2;
  state: State;
  plan: IngestPlan;
  ticket_ref: string | null;
  labels_added: number;
}): Promise<ExecOutcome> {
  const pr = args.item.raw as GitHubPR;
  let diff: string;
  try {
    diff = fetchPullRequestDiff(args.source.slug, pr.number);
  } catch (e) {
    // Transient — `gh pr diff` could fail on network/auth blips.
    // Hold the cursor so the next tick retries; don't mark v2_seen.
    return {
      kind: "filed",
      ticket_ref: args.ticket_ref,
      labels_added: args.labels_added,
      review_error: `failed to fetch PR diff: ${(e as Error).message}`,
      review_error_kind: "transient",
    };
  }

  // Defense-in-depth: scan the diff for obvious secret shapes BEFORE
  // sending it to the Anthropic API. The triage/security-flag gate runs
  // on the PR's title+body via the issue API payload — diff content is
  // fetched in a secondary call and never sees the gate. If the local
  // regex detector flags a token or private key, refuse to send the diff;
  // the ticket is still filed but the verdict step is skipped. Record
  // the refusal in v2_seen so it's visible in audit and so subsequent
  // ticks know the refusal already happened (cursor still advances —
  // this is a content-based PERMANENT gate, not a transient failure).
  const scan = diffLikelyContainsSecrets(diff);
  if (scan.found) {
    log.warn("v2 review-agent refused: diff secret-scan tripped", {
      slug: args.source.slug,
      number: pr.number,
      reason: scan.reason,
    });
    args.state.updateV2SeenAfterCurator({
      source_name: args.source.name,
      external_id: args.item.external_id,
      curator_decision: "review:refused-secret-scan",
      status: "review-refused-secret-scan",
    });
    return {
      kind: "filed",
      ticket_ref: args.ticket_ref,
      labels_added: args.labels_added,
      review_error: `diff secret-scan tripped (${scan.reason}); refusing to send diff to review-agent — review this PR manually`,
      review_error_kind: "permanent",
    };
  }

  let outcome: ReviewActionOutcome;
  try {
    const out = await reviewPullRequest({
      slug: args.source.slug,
      number: pr.number,
      title: pr.title,
      body: pr.body ?? "",
      diff,
      model: args.cfg.defaults.curator_model,
      perCallMaxBudgetUsd: args.cfg.defaults.per_call_max_budget_usd,
    });
    const post = postPullRequestReview({
      slug: args.source.slug,
      number: pr.number,
      verdict: out.decision.verdict,
      body: out.decision.body,
    });
    outcome = {
      verdict: out.decision.verdict,
      cost_usd: out.cost_usd,
      posted: post.ok,
    };
    if (!post.ok) {
      // Transient — the verdict was computed (LLM cost was paid) but the
      // gh post hit a network/auth blip. Don't mark v2_seen; hold the
      // cursor so the next tick retries. Re-running the LLM call burns
      // another call, but the alternative is a silently un-reviewed PR.
      // A future slice could cache the verdict between ticks to skip the
      // LLM re-call on retry.
      log.warn("v2 review post failed", {
        slug: args.source.slug,
        number: pr.number,
        verdict: out.decision.verdict,
        error: post.error,
      });
      return {
        kind: "filed",
        ticket_ref: args.ticket_ref,
        labels_added: args.labels_added,
        review: outcome,
        review_error: `gh pr review post failed: ${post.error}`,
        review_error_kind: "transient",
      };
    }
    // Posted successfully — terminal happy path.
    args.state.updateV2SeenAfterCurator({
      source_name: args.source.name,
      external_id: args.item.external_id,
      curator_decision: `review:${out.decision.verdict}`,
      status: "reviewed",
    });
    return {
      kind: "filed",
      ticket_ref: args.ticket_ref,
      labels_added: args.labels_added,
      review: outcome,
    };
  } catch (e) {
    // Transient — SDK errors (network, rate-limit, model unavailable) are
    // recoverable on a later tick. Hold the cursor; don't mark v2_seen.
    log.warn("v2 review-agent threw", {
      slug: args.source.slug,
      number: pr.number,
      error: (e as Error).message,
    });
    return {
      kind: "filed",
      ticket_ref: args.ticket_ref,
      labels_added: args.labels_added,
      review_error: (e as Error).message,
      review_error_kind: "transient",
    };
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
      if (o.review) {
        const cost = o.review.cost_usd !== null ? ` cost=$${o.review.cost_usd.toFixed(4)}` : "";
        const post = o.review.posted ? "" : " (post failed)";
        return `${ref}${labels}  review: ${o.review.verdict}${cost}${post}`;
      }
      if (o.review_error) {
        return `${ref}${labels}  review ERROR: ${o.review_error}`;
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
      return "NEEDS-TRIAGE (vault sink for external sources requires --with-triage)";
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

async function readSource(source: SourceConfig, state: State): Promise<Item[]> {
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
