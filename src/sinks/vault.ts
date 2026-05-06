import { spawnSync } from "node:child_process";
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

function extractTicketRef(stdout: string): string | null {
  const m = stdout.match(/\b(AGT-\d+)\b/);
  return m ? m[1] : null;
}
