import { spawnSync } from "node:child_process";
import type { GitHubIssue, RepoConfig } from "../types.ts";

function oteam(args: string[]): { ok: true; stdout: string } | { ok: false; stderr: string } {
  const r = spawnSync("oteam", args, { encoding: "utf-8" });
  if (r.error) return { ok: false, stderr: r.error.message };
  if (r.status !== 0) return { ok: false, stderr: r.stderr || `oteam exited ${r.status}` };
  return { ok: true, stdout: r.stdout };
}

export function ensureProject(vault: string, project: string): void {
  const list = oteam(["project", "list", "--vault", vault]);
  if (list.ok) {
    const exists = list.stdout
      .split("\n")
      .map(l => l.trim().split(/\s+/)[0])
      .some(id => id === project);
    if (exists) return;
  }
  const init = oteam(["project", "init", project, "--vault", vault, "--no-edit"]);
  if (!init.ok) {
    throw new Error(`oteam project init ${project} failed (vault=${vault}): ${init.stderr}`);
  }
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
