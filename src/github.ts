import { spawnSync } from "node:child_process";
import type { GitHubIssue, GitHubPR } from "./types.ts";

function gh(args: string[]): { ok: true; stdout: string } | { ok: false; stderr: string } {
  const r = spawnSync("gh", args, { encoding: "utf-8" });
  if (r.error) return { ok: false, stderr: r.error.message };
  if (r.status !== 0) return { ok: false, stderr: r.stderr || `gh exited ${r.status}` };
  return { ok: true, stdout: r.stdout };
}

function ghWithInput(args: string[], input: string): { ok: true; stdout: string } | { ok: false; stderr: string } {
  const r = spawnSync("gh", args, { encoding: "utf-8", input });
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

/**
 * Fetch the unified diff for a PR via `gh pr diff`. Returns the raw diff
 * text. Used by the review-agent autopilot before invoking the LLM.
 */
export function fetchPullRequestDiff(slug: string, number: number): string {
  const r = gh(["pr", "diff", String(number), "--repo", slug]);
  if (!r.ok) throw new Error(`gh pr diff failed for ${slug}#${number}: ${r.stderr}`);
  return r.stdout;
}

/**
 * Post a top-level pull-request review with one of three verdicts.
 * GH requires the verdict-specific flag (--approve / --request-changes /
 * --comment) plus an optional body.
 */
export function postPullRequestReview(args: {
  slug: string;
  number: number;
  verdict: "approve" | "request-changes" | "comment";
  body: string;
}): { ok: true } | { ok: false; error: string } {
  const verdictFlag =
    args.verdict === "approve"
      ? "--approve"
      : args.verdict === "request-changes"
        ? "--request-changes"
        : "--comment";
  const r = gh([
    "pr", "review", String(args.number),
    "--repo", args.slug,
    verdictFlag,
    "--body", args.body,
  ]);
  if (!r.ok) return { ok: false, error: r.stderr };
  return { ok: true };
}

/** List open PRs sorted by most recently updated, capped at `perPage`. */
export function listOpenPrs(slug: string, perPage = 25): GitHubPR[] {
  const r = gh([
    "api",
    `repos/${slug}/pulls?state=open&per_page=${perPage}&sort=updated&direction=desc`,
    "-H", "Accept: application/vnd.github+json",
  ]);
  if (!r.ok) throw new Error(`gh open-prs fetch failed for ${slug}: ${r.stderr}`);
  let arr: GitHubPR[];
  try { arr = JSON.parse(r.stdout); } catch (e) {
    throw new Error(`gh open-prs returned non-JSON for ${slug}: ${(e as Error).message}`);
  }
  return Array.isArray(arr) ? arr : [];
}

/**
 * List PRs updated at or after `since`. The /pulls endpoint doesn't accept
 * a `since` param, so we sort by updated desc and stop walking as soon as
 * we cross the cursor — same pagination shape as listIssuesSince.
 */
export function listPrsSince(slug: string, since: string, perPage = 100): GitHubPR[] {
  const sinceTs = Date.parse(since);
  if (Number.isNaN(sinceTs)) throw new Error(`listPrsSince: invalid since: ${since}`);
  const all: GitHubPR[] = [];
  let page = 1;
  while (true) {
    const r = gh([
      "api",
      `repos/${slug}/pulls?state=all&per_page=${perPage}&page=${page}&sort=updated&direction=desc`,
      "-H", "Accept: application/vnd.github+json",
    ]);
    if (!r.ok) throw new Error(`gh prs list failed for ${slug}: ${r.stderr}`);
    let arr: GitHubPR[];
    try { arr = JSON.parse(r.stdout); } catch (e) {
      throw new Error(`gh prs list returned non-JSON for ${slug}: ${(e as Error).message}`);
    }
    if (!Array.isArray(arr) || arr.length === 0) break;
    let crossedCursor = false;
    for (const pr of arr) {
      if (Date.parse(pr.updated_at) < sinceTs) {
        crossedCursor = true;
        break;
      }
      all.push(pr);
    }
    if (crossedCursor || arr.length < perPage) break;
    page += 1;
    if (page > 50) {
      throw new Error(`gh prs list paginated past 50 pages for ${slug}; refusing to continue`);
    }
  }
  return all;
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

export function removeLabels(slug: string, number: number, labels: string[]): void {
  if (labels.length === 0) return;
  const args = ["issue", "edit", String(number), "--repo", slug];
  for (const l of labels) args.push("--remove-label", l);
  const r = gh(args);
  if (!r.ok) throw new Error(`gh remove-labels failed for ${slug}#${number}: ${r.stderr}`);
}

/** List repo-level label definitions (not labels on a particular issue). */
export function listLabels(slug: string): { name: string }[] {
  const r = gh([
    "label", "list",
    "--repo", slug,
    "--json", "name",
    "--limit", "200",
  ]);
  if (!r.ok) throw new Error(`gh label list failed for ${slug}: ${r.stderr}`);
  let arr: unknown;
  try { arr = JSON.parse(r.stdout); } catch (e) {
    throw new Error(`gh label list returned non-JSON for ${slug}: ${(e as Error).message}`);
  }
  if (!Array.isArray(arr)) throw new Error(`gh label list returned non-array for ${slug}`);
  return arr.filter((l): l is { name: string } =>
    !!l && typeof (l as { name?: unknown }).name === "string"
  );
}

/** Create a single repo label. Throws on any gh failure (including "already exists");
 *  callers should pre-diff against `listLabels` to keep this idempotent. */
export function createLabel(
  slug: string,
  label: { name: string; color: string; description: string },
): void {
  const r = gh([
    "label", "create", label.name,
    "--repo", slug,
    "--color", label.color,
    "--description", label.description,
  ]);
  if (!r.ok) throw new Error(`gh label create failed for ${slug} "${label.name}": ${r.stderr}`);
}

/** List currently-open issues on a repo (excluding PRs), capped. Used as curator context. */
export function listOpenIssues(slug: string, cap = 50): GitHubIssue[] {
  const r = gh([
    "api",
    `repos/${slug}/issues?state=open&per_page=${cap}&sort=updated&direction=desc`,
    "-H", "Accept: application/vnd.github+json",
  ]);
  if (!r.ok) throw new Error(`gh open-issues fetch failed for ${slug}: ${r.stderr}`);
  let arr: GitHubIssue[];
  try { arr = JSON.parse(r.stdout); } catch (e) {
    throw new Error(`gh open-issues returned non-JSON for ${slug}: ${(e as Error).message}`);
  }
  return Array.isArray(arr) ? arr.filter(it => !(it as GitHubIssue).pull_request) : [];
}

export function commentOnIssue(slug: string, number: number, body: string): void {
  const r = gh([
    "issue", "comment", String(number),
    "--repo", slug,
    "--body", body,
  ]);
  if (!r.ok) throw new Error(`gh issue comment failed for ${slug}#${number}: ${r.stderr}`);
}

export function closeIssue(slug: string, number: number, reason: "completed" | "not_planned" = "completed"): void {
  const r = gh([
    "issue", "close", String(number),
    "--repo", slug,
    "--reason", reason,
  ]);
  if (!r.ok) throw new Error(`gh issue close failed for ${slug}#${number}: ${r.stderr}`);
}

export type IssueClaim =
  | { ok: true; assignees: string[] }
  | { ok: false; reason: "issue-closed" }
  | { ok: false; reason: "already-claimed"; assignees: string[] }
  | { ok: false; reason: "no-write-access" }
  | { ok: false; reason: "api-error"; error: string };

/**
 * Atomically claim a GH issue for `identity` before doing work on it.
 *
 * Protocol:
 *   1. GET the issue.
 *   2. If state=closed → bail (issue-closed).
 *   3. If already assigned to someone other than identity → bail (already-claimed).
 *   4. PATCH assignees: [identity].
 *   5. Inspect PATCH response. If assignees came back empty, the operator's
 *      token doesn't have push access (GitHub silently drops assignee changes
 *      without it) → bail (no-write-access). If assignees != [identity] —
 *      a race with another writer — bail (already-claimed).
 *
 * The race window between step 1 and step 4 is tiny but non-zero. The post-PATCH
 * verification catches the case where two callers both saw the issue unassigned
 * and both PATCHed; whoever reads back themselves alone wins, the other bails.
 */
export function claimIssue(slug: string, number: number, identity: string): IssueClaim {
  if (!identity) {
    return { ok: false, reason: "api-error", error: "claimIssue called with empty identity" };
  }

  const getR = gh([
    "api", `repos/${slug}/issues/${number}`,
    "-H", "Accept: application/vnd.github+json",
  ]);
  if (!getR.ok) return { ok: false, reason: "api-error", error: getR.stderr };

  let issue: GitHubIssue;
  try {
    issue = JSON.parse(getR.stdout);
  } catch (e) {
    return { ok: false, reason: "api-error", error: `non-JSON GET response: ${(e as Error).message}` };
  }

  if (issue.state === "closed") return { ok: false, reason: "issue-closed" };

  const existing = (issue.assignees ?? []).map(a => a.login);
  if (existing.length > 0 && !existing.includes(identity)) {
    return { ok: false, reason: "already-claimed", assignees: existing };
  }

  const patchR = ghWithInput(
    [
      "api", `repos/${slug}/issues/${number}`,
      "-X", "PATCH",
      "--input", "-",
      "-H", "Accept: application/vnd.github+json",
    ],
    JSON.stringify({ assignees: [identity] }),
  );
  if (!patchR.ok) return { ok: false, reason: "api-error", error: patchR.stderr };

  let updated: GitHubIssue;
  try {
    updated = JSON.parse(patchR.stdout);
  } catch (e) {
    return { ok: false, reason: "api-error", error: `non-JSON PATCH response: ${(e as Error).message}` };
  }

  if (updated.state === "closed") return { ok: false, reason: "issue-closed" };

  const after = (updated.assignees ?? []).map(a => a.login);
  if (after.length === 0) return { ok: false, reason: "no-write-access" };
  if (after.length !== 1 || after[0] !== identity) {
    return { ok: false, reason: "already-claimed", assignees: after };
  }

  return { ok: true, assignees: after };
}
