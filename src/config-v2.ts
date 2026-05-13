import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type {
  ConfigV2,
  DefaultAction,
  FolderSource,
  GitHubIssuesSource,
  GitHubPrsSource,
  IngestRule,
  LifecycleRule,
  LinearSource,
  SourceConfig,
} from "./types.ts";
import { AUTOPILOT_VALUES } from "./types.ts";

const AUTOPILOT_ENUM = z.enum(AUTOPILOT_VALUES as [string, ...string[]]);
const SOURCE_KIND_ENUM = z.enum(["github_issues", "github_prs", "folder", "linear"]);
const SINK_ENUM = z.enum(["vault", "security-inbox", "drop"]);

const SLUG_REGEX = /^[^/]+\/[^/]+$/;

const GitHubIssuesSchema = z.object({
  name: z.string().min(1),
  slug: z.string().regex(SLUG_REGEX, "slug must be owner/repo"),
  can_label: z.boolean().default(true),
});

const GitHubPrsSchema = z.object({
  name: z.string().min(1),
  slug: z.string().regex(SLUG_REGEX, "slug must be owner/repo"),
});

const FolderSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  archive: z.string().nullable().default(null),
  pattern: z.string().default("*.md"),
});

const LinearSchema = z.object({
  name: z.string().min(1),
  team: z.string().min(1),
  state: z.string().optional(),
  project: z.string().optional(),
});

const SourcesSchema = z
  .object({
    github_issues: z.array(GitHubIssuesSchema).default([]),
    github_prs: z.array(GitHubPrsSchema).default([]),
    folder: z.array(FolderSchema).default([]),
    linear: z.array(LinearSchema).default([]),
  })
  .default({});

const IngestMatchSchema = z
  .object({
    source: z.string().optional(),
    source_prefix: z.string().optional(),
    kind: SOURCE_KIND_ENUM.optional(),
    type: z.string().optional(),
    labels: z.array(z.string()).optional(),
    repo: z.string().optional(),
    repo_prefix: z.string().optional(),
    author: z.string().optional(),
  })
  .strict();

const IngestActionSchema = z
  .object({
    sink: SINK_ENUM.optional(),
    vault: z.string().optional(),
    project: z.string().optional(),
    autopilot: AUTOPILOT_ENUM.optional(),
    add_labels: z.array(z.string()).optional(),
    skip: z.boolean().optional(),
  })
  .strict();

const IngestRuleSchema = z.object({
  name: z.string().min(1),
  when: IngestMatchSchema.default({}),
  do: IngestActionSchema.default({}),
});

const LifecycleMatchSchema = z
  .object({
    from_state: z.string().optional(),
    to_state: z.string().optional(),
    state: z.string().optional(),
    type: z.string().optional(),
    vault: z.string().optional(),
    project: z.string().optional(),
    stuck_for_minutes: z.number().int().positive().optional(),
  })
  .strict();

const LifecycleActionSchema = z
  .object({
    spawn: z.string().optional(),
    transition: z.string().optional(),
    notify: z.boolean().optional(),
  })
  .strict();

const LifecycleRuleSchema = z.object({
  name: z.string().min(1),
  when: LifecycleMatchSchema.default({}),
  do: LifecycleActionSchema.default({}),
});

const RulesSchema = z
  .object({
    ingest: z.array(IngestRuleSchema).default([]),
    lifecycle: z.array(LifecycleRuleSchema).default([]),
  })
  .default({});

const DefaultsSchemaV2 = z.object({
  state_dir: z.string().default("~/.local/state/dispatch"),
  log_dir: z.string().default("~/Library/Logs/dispatch"),
  poll_interval_minutes: z.number().int().positive().default(5),
  triage_model: z.string().default("claude-haiku-4-5-20251001"),
  body_truncate_chars: z.number().int().positive().default(8000),
  curator_model: z.string().default("claude-sonnet-4-6"),
  per_tick_max_budget_usd: z.number().positive().default(2.0),
  per_call_max_budget_usd: z.number().positive().default(0.5),
  max_orchestrator_spawns_per_tick: z.number().int().min(0).default(1),
  recent_vault_tickets_window_days: z.number().int().positive().default(60),
  recent_vault_tickets_cap: z.number().int().positive().default(40),
  bot_identity: z.string().default(""),
});

const ConfigV2FileSchema = z.object({
  defaults: DefaultsSchemaV2.default({}),
  source: SourcesSchema,
  rule: RulesSchema,
  default: IngestActionSchema.optional(),
});

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return resolve(p);
}

export function loadConfigV2(path: string): ConfigV2 {
  if (!existsSync(path)) {
    throw new Error(`dispatch config not found at ${path}`);
  }
  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (e) {
    throw new Error(`failed to parse ${path}: ${(e as Error).message}`);
  }

  const result = ConfigV2FileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map(i => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`config validation failed for ${path}:\n${issues}`);
  }
  const data = result.data;

  const sources: SourceConfig[] = [
    ...data.source.github_issues.map((s): GitHubIssuesSource => ({ kind: "github_issues", ...s })),
    ...data.source.github_prs.map((s): GitHubPrsSource => ({ kind: "github_prs", ...s })),
    ...data.source.folder.map((s): FolderSource => ({ kind: "folder", ...s })),
    ...data.source.linear.map((s): LinearSource => ({ kind: "linear", ...s })),
  ];

  const namesSeen = new Set<string>();
  for (const s of sources) {
    if (namesSeen.has(s.name)) throw new Error(`duplicate source name: ${s.name}`);
    namesSeen.add(s.name);
  }

  const ingestNames = new Set<string>();
  for (const r of data.rule.ingest) {
    if (ingestNames.has(r.name)) throw new Error(`duplicate ingest rule name: ${r.name}`);
    ingestNames.add(r.name);
  }
  const lifecycleNames = new Set<string>();
  for (const r of data.rule.lifecycle) {
    if (lifecycleNames.has(r.name)) throw new Error(`duplicate lifecycle rule name: ${r.name}`);
    lifecycleNames.add(r.name);
  }

  for (const r of data.rule.ingest) {
    if (r.when.source && !namesSeen.has(r.when.source)) {
      throw new Error(
        `ingest rule "${r.name}": when.source = "${r.when.source}" does not match any [[source.*]] name`,
      );
    }
  }

  return {
    defaults: {
      state_dir: expandHome(data.defaults.state_dir),
      log_dir: expandHome(data.defaults.log_dir),
      config_path: path,
      poll_interval_minutes: data.defaults.poll_interval_minutes,
      triage_model: data.defaults.triage_model,
      body_truncate_chars: data.defaults.body_truncate_chars,
      curator_model: data.defaults.curator_model,
      per_tick_max_budget_usd: data.defaults.per_tick_max_budget_usd,
      per_call_max_budget_usd: data.defaults.per_call_max_budget_usd,
      max_orchestrator_spawns_per_tick: data.defaults.max_orchestrator_spawns_per_tick,
      recent_vault_tickets_window_days: data.defaults.recent_vault_tickets_window_days,
      recent_vault_tickets_cap: data.defaults.recent_vault_tickets_cap,
      bot_identity: data.defaults.bot_identity,
    },
    sources,
    ingest_rules: data.rule.ingest as IngestRule[],
    lifecycle_rules: data.rule.lifecycle as LifecycleRule[],
    default_action: (data.default ?? null) as DefaultAction | null,
  };
}
