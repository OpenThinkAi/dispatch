import { configPath } from "./config.ts";
import { loadConfigV2 } from "./config-v2.ts";
import { planIngest, type IngestPlan } from "./rules.ts";
import { readFolder } from "./sources/folder.ts";
import { readGitHubIssues } from "./sources/github_issues.ts";
import { State } from "./state.ts";
import { triageIssue } from "./triage.ts";
import type {
  ConfigV2,
  GitHubIssue,
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
  let totalTriaged = 0;
  let totalTriageCostUsd = 0;
  let triageBudgetRemaining = opts.withTriage ? opts.triageLimit : 0;

  for (const source of cfg.sources) {
    const cursorNote = describeCursor(source, state);
    let items: Item[] | null;
    try {
      items = readSource(source, state);
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
    for (let i = 0; i < items.length; i++) {
      let item = items[i];
      let triageNote = "";
      if (opts.withTriage && triageable(item) && triageBudgetRemaining > 0) {
        try {
          const out = await triageItem(item, cfg);
          item = out.enriched;
          triageBudgetRemaining--;
          totalTriaged++;
          if (out.cost_usd !== null) totalTriageCostUsd += out.cost_usd;
          triageNote =
            `\n      triage: type=${out.enriched.type ?? "null"}` +
            `  labels=[${out.enriched.labels.join(", ")}]` +
            `  cost=$${(out.cost_usd ?? 0).toFixed(4)}`;
        } catch (e) {
          triageNote = `\n      triage ERROR: ${(e as Error).message}`;
        }
      } else if (opts.withTriage && triageable(item) && triageBudgetRemaining === 0) {
        triageNote = "\n      triage: SKIPPED (budget exhausted)";
      }
      const plan = planIngest(item, cfg);
      console.log(`  • "${item.title}" → ${formatPlan(plan)}${triageNote}`);
      if (plan.via === "drop") totalDrops++;
    }
    if (items.length === 0) console.log("  (no items)");
    console.log();
    totalItems += items.length;
  }

  const triageSummary = opts.withTriage
    ? `  ${totalTriaged} triaged ($${totalTriageCostUsd.toFixed(4)} total).`
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
  };
  return { enriched, cost_usd: out.cost_usd, triage: out.result };
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

function readSource(source: SourceConfig, state: State): Item[] | null {
  switch (source.kind) {
    case "folder":
      return readFolder(source);
    case "github_issues": {
      const since = state.getV2Cursor(source.name);
      return readGitHubIssues(source, since ? { since } : {});
    }
    case "github_prs":
      return null;
  }
}

/**
 * Short human-readable note describing this source's cursor state, for
 * dry-run output. Empty for sources without cursor semantics (folder).
 */
function describeCursor(source: SourceConfig, state: State): string {
  if (source.kind !== "github_issues") return "";
  const cursor = state.getV2Cursor(source.name);
  if (!cursor) return ", cursor: none (recent open issues)";
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
