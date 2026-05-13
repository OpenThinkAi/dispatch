import { configPath } from "./config.ts";
import { loadConfigV2 } from "./config-v2.ts";
import { planIngest, type IngestPlan } from "./rules.ts";
import { readFolder } from "./sources/folder.ts";
import { readGitHubIssues } from "./sources/github_issues.ts";
import type { Item, SourceConfig } from "./types.ts";

/**
 * Spike dry-run of the v2 pipeline. Reads each configured source, runs
 * planIngest against the rule list, and prints what *would* happen.
 * Mutates nothing — no triage call, no archive, no sink writes.
 *
 * Sources without a v2 reader yet (github_issues, github_prs) are
 * reported as SKIPPED rather than crashing the run.
 */
export async function pollV2DryRun(): Promise<number> {
  const cfg = loadConfigV2(configPath());
  console.log(
    `[v2 dry-run] scanning ${cfg.sources.length} source${plural(cfg.sources.length)} ` +
      `from ${cfg.defaults.config_path}\n`,
  );

  let totalItems = 0;
  let totalDrops = 0;
  let totalErrors = 0;
  for (const source of cfg.sources) {
    let items: Item[] | null;
    try {
      items = readSource(source);
    } catch (e) {
      console.log(`${source.name} (${source.kind}): ERROR — ${(e as Error).message}`);
      console.log();
      totalErrors++;
      continue;
    }
    if (items === null) {
      console.log(`${source.name} (${source.kind}): SKIPPED — no v2 reader yet`);
      console.log();
      continue;
    }
    console.log(`${source.name} (${source.kind}, ${items.length} item${plural(items.length)}):`);
    for (const item of items) {
      const plan = planIngest(item, cfg);
      console.log(`  • "${item.title}" → ${formatPlan(plan)}`);
      if (plan.via === "drop") totalDrops++;
    }
    if (items.length === 0) console.log("  (no items)");
    console.log();
    totalItems += items.length;
  }

  console.log(
    `[v2 dry-run] ${totalItems} item${plural(totalItems)} planned ` +
      `(${totalDrops} would drop, ${totalErrors} source error${plural(totalErrors)}) ` +
      `across ${cfg.sources.length} source${plural(cfg.sources.length)}. ` +
      `No state mutated.`,
  );
  return totalErrors > 0 ? 1 : 0;
}

function readSource(source: SourceConfig): Item[] | null {
  switch (source.kind) {
    case "folder":
      return readFolder(source);
    case "github_issues":
      return readGitHubIssues(source);
    case "github_prs":
      return null;
  }
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
