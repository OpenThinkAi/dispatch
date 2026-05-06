export type RepoConfig = {
  slug: string;
  vault: string;
  project: string;
  can_label: boolean;
  description?: string;
};

export type Defaults = {
  state_dir: string;
  log_dir: string;
  config_path: string;
  poll_interval_minutes: number;
  triage_model: string;
  body_truncate_chars: number;
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
