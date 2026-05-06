import { spawnSync } from "node:child_process";
import type { GitHubIssue } from "./types.ts";

function gh(args: string[]): { ok: true; stdout: string } | { ok: false; stderr: string } {
  const r = spawnSync("gh", args, { encoding: "utf-8" });
  if (r.error) return { ok: false, stderr: r.error.message };
  if (r.status !== 0) return { ok: false, stderr: r.stderr || `gh exited ${r.status}` };
  return { ok: true, stdout: r.stdout };
}

/**
 * List issues in a repo updated at or after `since`. Excludes pull requests.
 * Returns up to `perPage` items per page across all pages.
 */
export function listIssuesSince(slug: string, since: string, perPage = 100): GitHubIssue[] {
  const all: GitHubIssue[] = [];
  let page = 1;
  while (true) {
    const r = gh([
      "api",
      `repos/${slug}/issues?state=all&since=${encodeURIComponent(since)}&per_page=${perPage}&page=${page}&sort=updated&direction=asc`,
      "-H", "Accept: application/vnd.github+json",
      "-H", "X-GitHub-Api-Version: 2022-11-28",
    ]);
    if (!r.ok) throw new Error(`gh issues list failed for ${slug}: ${r.stderr}`);
    let arr: GitHubIssue[];
    try {
      arr = JSON.parse(r.stdout);
    } catch (e) {
      throw new Error(`gh issues list returned non-JSON for ${slug}: ${(e as Error).message}`);
    }
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const it of arr) {
      if ((it as GitHubIssue).pull_request) continue; // skip PRs (they leak through /issues)
      all.push(it);
    }
    if (arr.length < perPage) break;
    page += 1;
    if (page > 50) {
      throw new Error(`gh issues list paginated past 50 pages for ${slug}; refusing to continue`);
    }
  }
  return all;
}

/** Fetch one issue by URL (https://github.com/owner/repo/issues/N) or owner/repo#N. */
export function fetchIssue(ref: string): GitHubIssue {
  const parsed = parseIssueRef(ref);
  const r = gh([
    "api", `repos/${parsed.slug}/issues/${parsed.number}`,
    "-H", "Accept: application/vnd.github+json",
  ]);
  if (!r.ok) throw new Error(`gh issue fetch failed for ${ref}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

export function parseIssueRef(ref: string): { slug: string; number: number } {
  const url = ref.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/);
  if (url) return { slug: url[1], number: Number(url[2]) };
  const short = ref.match(/^([^/]+\/[^/]+)#(\d+)$/);
  if (short) return { slug: short[1], number: Number(short[2]) };
  throw new Error(`unparseable issue ref: ${ref}`);
}

export function addLabels(slug: string, number: number, labels: string[]): void {
  if (labels.length === 0) return;
  const args = ["issue", "edit", String(number), "--repo", slug];
  for (const l of labels) args.push("--add-label", l);
  const r = gh(args);
  if (!r.ok) throw new Error(`gh add-labels failed for ${slug}#${number}: ${r.stderr}`);
}
