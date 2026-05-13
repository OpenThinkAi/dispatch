import { listOpenIssues } from "../github.ts";
import type { GitHubIssue, GitHubIssuesSource, Item } from "../types.ts";

/**
 * Read the most recently-updated open issues for a github_issues source
 * and normalize them into Items for the v2 rule engine. Default cap of
 * 25 keeps dry-runs cheap; the eventual cursored read for real polling
 * lives elsewhere.
 *
 * Items emitted here have `type = null` (triage hasn't run) but `labels`
 * is populated from the GH issue's labels, so label-gated rules can
 * already fire pre-triage.
 */
export function readGitHubIssues(
  source: GitHubIssuesSource,
  opts: { cap?: number } = {},
): Item[] {
  const issues = listOpenIssues(source.slug, opts.cap ?? 25);
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
