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
