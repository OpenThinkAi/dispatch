import { listIssuesSince, listOpenIssues } from "../github.ts";
import type { GitHubIssue, GitHubIssuesSource, Item } from "../types.ts";

/**
 * Read items from a github_issues source.
 *
 * If `opts.since` (ISO timestamp) is set, fetches issues updated at or after
 * that cursor — used in normal polling and in cursor-aware dry-runs. With no
 * `since`, falls back to the most recently-updated open issues (cap 25 by
 * default) — used for first-sight backfills and cursor-less dry-runs.
 *
 * Items emitted here have `type = null` (triage hasn't run) but `labels` is
 * populated from the GH issue's labels, so label-gated rules can already
 * fire pre-triage.
 */
export function readGitHubIssues(
  source: GitHubIssuesSource,
  opts: { since?: string; cap?: number } = {},
): Item[] {
  const issues = opts.since
    ? listIssuesSince(source.slug, opts.since)
    : listOpenIssues(source.slug, opts.cap ?? 25);
  return issues.map(issue => issueToItem(source, issue));
}

/** Pure mapper — exported so it can be exercised without hitting gh. */
export function issueToItem(source: GitHubIssuesSource, issue: GitHubIssue): Item {
  return {
    source: { name: source.name, kind: "github_issues" },
    external_id: `${source.slug}#${issue.number}`,
    url: issue.html_url,
    title: issue.title,
    body: issue.body ?? "",
    author: issue.user?.login ?? null,
    repo: source.slug,
    labels: issue.labels.map(l => l.name),
    type: null,
    created_at: issue.created_at,
    raw: issue,
  };
}
