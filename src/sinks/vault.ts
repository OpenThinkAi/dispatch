import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import type { Config, GitHubIssue, RepoConfig } from "../types.ts";

function oteam(args: string[]): { ok: true; stdout: string } | { ok: false; stderr: string } {
  const r = spawnSync("oteam", args, { encoding: "utf-8" });
  if (r.error) return { ok: false, stderr: r.error.message };
  if (r.status !== 0) return { ok: false, stderr: r.stderr || `oteam exited ${r.status}` };
  return { ok: true, stdout: r.stdout };
}

/** List the project IDs registered under a vault, or null if the listing call fails. */
export function listVaultProjects(vault: string): string[] | null {
  const r = oteam(["project", "list", "--vault", vault]);
  if (!r.ok) return null;
  return r.stdout
    .split("\n")
    .map(l => l.trim().split(/\s+/)[0])
    .filter(Boolean);
}

export type ProjectIndex = Map<string, Set<string>>;

/** Build a {vault → set of projects} index for every distinct vault in the config. */
export function buildProjectIndex(cfg: Config): {
  index: ProjectIndex;
  errors: { vault: string; reason: string }[];
} {
  const errors: { vault: string; reason: string }[] = [];
  const index: ProjectIndex = new Map();
  const vaults = new Set(cfg.repos.map(r => r.vault));
  for (const vault of vaults) {
    const projects = listVaultProjects(vault);
    if (projects === null) {
      errors.push({ vault, reason: "oteam project list failed (vault not registered?)" });
      continue;
    }
    index.set(vault, new Set(projects));
  }
  return { index, errors };
}

/** Find every repo whose configured project doesn't exist in its vault. */
export function findMissingProjects(cfg: Config, index: ProjectIndex): RepoConfig[] {
  return cfg.repos.filter(r => {
    const projects = index.get(r.vault);
    if (!projects) return true; // vault unknown → treated as missing
    return !projects.has(r.project);
  });
}

/**
 * File a GitHub issue into the vault as a triage ticket via `oteam pull`.
 * Returns whatever ticket reference oteam emits on stdout (best-effort).
 */
export function pullIntoVault(args: {
  issue: GitHubIssue;
  repo: RepoConfig;
}): { ok: true; ref: string | null } | { ok: false; error: string } {
  const r = oteam([
    "pull", "github", args.issue.html_url,
    "--vault", args.repo.vault,
    "--project", args.repo.project,
  ]);
  if (!r.ok) return { ok: false, error: r.stderr };
  const ref = extractTicketRef(r.stdout);
  return { ok: true, ref };
}

/**
 * v2-friendly variant: file a GitHub-shaped URL into a vault/project,
 * decoupled from the v0 RepoConfig. Same underlying `oteam pull github`
 * call as `pullIntoVault`.
 */
export function pullUrlIntoVault(args: {
  htmlUrl: string;
  vault: string;
  project: string;
}): { ok: true; ref: string | null } | { ok: false; error: string } {
  const r = oteam([
    "pull", "github", args.htmlUrl,
    "--vault", args.vault,
    "--project", args.project,
  ]);
  if (!r.ok) return { ok: false, error: r.stderr };
  const ref = extractTicketRef(r.stdout);
  return { ok: true, ref };
}

function extractTicketRef(stdout: string): string | null {
  const m = stdout.match(/\b(AGT-\d+)\b/);
  return m ? m[1] : null;
}

function extractTicketPath(stdout: string): string | null {
  // oteam emits the absolute path on the line after the AGT-NNN ref. Pick
  // the first absolute path that ends with .md — oteam creates one ticket
  // per invocation, so the first match is the right one.
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("/") && trimmed.endsWith(".md")) return trimmed;
  }
  return null;
}

/**
 * File a locally-authored item (folder, linear, or any future non-URL source)
 * into the vault. oteam doesn't accept a body argument, so we shell out to
 * `oteam ticket new` for the AGT-NNN allocation + frontmatter, then append
 * the caller-supplied body under a "## Source content" section.
 *
 * Callers are responsible for shaping the body — e.g. a Linear caller
 * prepends a `**Linear:** <url>` backlink before the description so the
 * link to the upstream issue is preserved in the vault ticket. Labels are
 * passed through to oteam's `--label` and applied at ticket-creation time.
 */
export function fileLocalItemToVault(args: {
  title: string;
  body: string;
  vault: string;
  project: string;
  labels?: string[];
}): { ok: true; ref: string | null; path: string | null } | { ok: false; error: string } {
  const argv = [
    "ticket", "new", args.title,
    "--workspace", args.vault,
    "--project", args.project,
  ];
  for (const label of args.labels ?? []) {
    argv.push("--label", label);
  }
  const r = oteam(argv);
  if (!r.ok) return { ok: false, error: r.stderr };
  const ref = extractTicketRef(r.stdout);
  const path = extractTicketPath(r.stdout);
  // If there's body content to write but we couldn't parse a path from oteam
  // stdout (output format drift, regex miss), refuse the file rather than
  // silently dropping the user's content. The vault ticket will exist but
  // dispatch returns an error so the caller doesn't advance the cursor.
  if (args.body.trim().length > 0) {
    if (!path) {
      return { ok: false, error: "oteam did not emit a parseable ticket path; body not written" };
    }
    // Separate the auto-generated frontmatter+template from the source body
    // with a "## Source content" header so it's obvious where the user's
    // markdown begins.
    appendFileSync(path, `\n## Source content\n\n${args.body.trim()}\n`);
  }
  return { ok: true, ref, path };
}
