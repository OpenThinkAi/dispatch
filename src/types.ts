export type Autopilot = "off" | "curate-only" | "fire" | "drive";

export const AUTOPILOT_VALUES: Autopilot[] = ["off", "curate-only", "fire", "drive"];

export type RepoConfig = {
  slug: string;
  vault: string;
  project: string;
  can_label: boolean;
  autopilot: Autopilot;
  description?: string;
};

export type Defaults = {
  state_dir: string;
  log_dir: string;
  config_path: string;
  poll_interval_minutes: number;
  triage_model: string;
  body_truncate_chars: number;
  curator_model: string;
  per_tick_max_budget_usd: number;
  per_call_max_budget_usd: number;
  max_orchestrator_spawns_per_tick: number;
  recent_vault_tickets_window_days: number;
  recent_vault_tickets_cap: number;
  /**
   * GitHub login the curator uses to claim issues before firing the
   * orchestrator. Must be a valid assignee on every repo that has
   * `autopilot = "fire"`. Required when any repo is in fire mode;
   * otherwise unused.
   */
  bot_identity: string;
};

export type Config = {
  defaults: Defaults;
  repos: RepoConfig[];
};

export type GitHubPR = {
  url: string;
  html_url: string;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  draft?: boolean;
  merged_at?: string | null;
  labels: { name: string }[];
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
};

export type GitHubIssue = {
  url: string;
  html_url: string;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: { name: string }[];
  assignees?: { login: string }[];
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
};

export type SecurityFlag = {
  kind: "secret-leak" | "vuln-disclosure" | "pii" | "abuse";
  reason: string;
};

export type TriageResult = {
  summary: string;
  reasoning: string;
  security_flag: SecurityFlag | null;
  labels_to_add: string[];
};

export type ProcessOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "security-held"; flag: SecurityFlag }
  | { kind: "filed"; ticketRef: string | null }
  | { kind: "updated"; ticketRef: string | null }
  | { kind: "error"; error: string };

/**
 * Lifecycle of an ingested issue, post-triage.
 *
 *   awaiting-curation ── curator ─┬─ (gh-comment) ─→ gh-resolved (terminal)
 *                                 │
 *                                 ├─ (hold)        ─→ held-for-human (terminal until human acts)
 *                                 │
 *                                 └─ (fire)        ─→ green-lit
 *                                                          │
 *                                                          │ claim attempt
 *                                                          ├─→ lost-race (someone else has the GH issue)
 *                                                          │
 *                                                          │ orchestrator picks up
 *                                                          ↓
 *                                                  ┌── autopilot=fire  ──→ fired (terminal — one phase only)
 *                                                  │
 *                                                  └── autopilot=drive ──→ driving ── role pipeline ──┐
 *                                                                            │                       │
 *                                                                            ├─ (state advances)     │ each tick
 *                                                                            │                       │ re-fires next phase
 *                                                                            ├─ (state=done/archive) ─→ pipeline-complete (terminal good)
 *                                                                            │
 *                                                                            └─ (state=blocked or stuck >60min) ─→ pipeline-held (terminal until human acts)
 */
export type TriageStatus =
  | "awaiting-curation"
  | "green-lit"
  | "held-for-human"
  | "gh-resolved"
  | "fired"
  | "driving"
  | "pipeline-complete"
  | "pipeline-held"
  | "completed"
  | "failed"
  | "lost-race";

export const TRIAGE_STATUS_VALUES: TriageStatus[] = [
  "awaiting-curation",
  "green-lit",
  "held-for-human",
  "gh-resolved",
  "fired",
  "driving",
  "pipeline-complete",
  "pipeline-held",
  "completed",
  "failed",
  "lost-race",
];

export type CuratorAction = "fire" | "gh-comment" | "hold";

export type CuratorDecision =
  | {
      action: "fire";
      reasoning: string;
      related_tickets: string[];
      related_gh_issues: number[];
    }
  | {
      action: "gh-comment";
      reasoning: string;
      related_tickets: string[];
      related_gh_issues: number[];
      gh_comment: string;
      close_gh: boolean;
    }
  | {
      action: "hold";
      reasoning: string;
      related_tickets: string[];
      related_gh_issues: number[];
      vault_comment: string;
      gh_comment_optional?: string;
    };

/** Lightweight summary of a vault ticket, used as curator input. */
export type VaultTicketSummary = {
  id: string;
  title: string;
  state: string;
  repo: string | null;
  source_type: string;
  one_line_summary: string;
  path: string;
};

// ─────────────────────────────────────────────────────────────────────────
// spike/sources-and-rules — sketch of the new config shape.
//
// Coexists with the v0 `Config` / `RepoConfig` types above during the
// experiment. Nothing imports these yet; they exist so the schema is
// concrete enough to review.
// ─────────────────────────────────────────────────────────────────────────

export type SourceKind = "github_issues" | "github_prs" | "folder" | "linear";

export type GitHubIssuesSource = {
  kind: "github_issues";
  name: string;
  slug: string;
  can_label: boolean;
};

export type GitHubPrsSource = {
  kind: "github_prs";
  name: string;
  slug: string;
};

export type FolderSource = {
  kind: "folder";
  name: string;
  path: string;
  archive: string | null;
  pattern: string;
};

/**
 * Linear issues source. `team` is the team key (short code like "ENG"), not
 * the team UUID. Optional filters narrow the fetched set client-side after
 * the GraphQL query.
 */
export type LinearSource = {
  kind: "linear";
  name: string;
  team: string;
  state?: string;
  project?: string;
};

/** Raw Linear issue payload preserved in Item.raw. */
export type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  state: { name: string };
  labels: { nodes: { name: string }[] };
  creator: { name: string; email: string } | null;
  team: { key: string };
  project: { name: string } | null;
  createdAt: string;
  updatedAt: string;
};

export type SourceConfig = GitHubIssuesSource | GitHubPrsSource | FolderSource | LinearSource;

/** Conditions on `when` — keys are AND-ed, omitted keys match anything. */
export type IngestMatch = {
  source?: string;            // source name (strict equality)
  source_prefix?: string;     // source name startsWith
  kind?: SourceKind;
  type?: string;              // classified type from triage (e.g. "bug", "feature", "security")
  labels?: string[];          // ALL listed labels must be present on the item
  repo?: string;              // github sources only — owner/repo slug (strict equality)
  repo_prefix?: string;       // github sources only — repo slug startsWith
  author?: string;            // github sources only — issue/PR author login
};

export type IngestSink = "vault" | "security-inbox" | "drop";

export type IngestAction = {
  sink?: IngestSink;      // default: "vault"
  vault?: string;
  project?: string;
  autopilot?: Autopilot;
  add_labels?: string[];
  skip?: boolean;         // matched-and-discarded (rule-level kill switch)
};

export type IngestRule = {
  name: string;
  when: IngestMatch;
  do: IngestAction;
};

export type LifecycleMatch = {
  from_state?: string;
  to_state?: string;
  state?: string;                // matches the current state every tick (no transition required)
  type?: string;
  vault?: string;
  project?: string;
  stuck_for_minutes?: number;    // matches when ticket has been in current state >= N min
};

export type LifecycleAction = {
  /**
   * Argv string for a detached spawn. Split on whitespace only — no shell
   * interpretation. The matched ticket's absolute path is automatically
   * appended as the final argv element so the spawned command knows which
   * ticket triggered the rule (mirrors `oteam assign --inline <path>`
   * semantics). Operators wanting shell features must use a wrapper script.
   */
  spawn?: string;
  /**
   * Best-effort macOS notification. Silent no-op on other platforms.
   */
  notify?: boolean;
};

export type LifecycleRule = {
  name: string;
  when: LifecycleMatch;
  do: LifecycleAction;
};

/** Same shape as IngestAction; applies when no [[rule.ingest]] matches. */
export type DefaultAction = IngestAction;

/** New top-level config shape. Built by `loadConfigV2` (not yet written). */
export type ConfigV2 = {
  defaults: Defaults;
  sources: SourceConfig[];
  ingest_rules: IngestRule[];
  lifecycle_rules: LifecycleRule[];
  default_action: DefaultAction | null;
};

/**
 * Normalized shape every source emits into the rule engine. The rule
 * matcher inspects only these fields; `raw` is preserved for sinks.
 */
export type Item = {
  source: { name: string; kind: SourceKind };
  external_id: string;            // unique-per-source identifier (e.g. "myorg/repo#42" or file path)
  url: string | null;
  title: string;
  body: string;
  author: string | null;
  repo: string | null;            // github sources only
  labels: string[];               // source-side labels merged with triage-suggested labels
  type: string | null;            // classified type from triage; null pre-triage
  created_at: string;             // ISO 8601
  raw: unknown;                   // kind-specific payload preserved for sinks
  /**
   * Full triage result attached when triage ran. Distinct from `type` (which
   * is the matcher-friendly summary) — this carries the original
   * `security_flag` (kind + reason) and the full `labels_to_add`, useful
   * downstream (e.g. the security-inbox sink wants the actual flag, not the
   * abuse-default fallback).
   */
  triage_result?: TriageResult | null;
};

/**
 * A lifecycle event — what the lifecycle matcher gets per ticket on each
 * poll tick. `from_state` is null on first observation. `stuck_for_minutes`
 * is computed by the runtime from state-entry timestamps.
 */
export type LifecycleEvent = {
  ticket_id: string;
  vault: string;
  project: string | null;
  type: string | null;
  from_state: string | null;
  to_state: string;
  stuck_for_minutes: number;
};
