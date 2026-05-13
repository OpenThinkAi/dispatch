import { listOpenPrs, listPrsSince } from "../github.ts";
import type { GitHubPR, GitHubPrsSource, Item } from "../types.ts";

/**
 * Read items from a github_prs source.
 *
 * Mirrors readGitHubIssues: `opts.since` (ISO cursor) → cursored fetch via
 * listPrsSince; no cursor → listOpenPrs(cap=25) for first-sight backfills
 * and cursorless dry-runs. Both open and closed PRs are returned when
 * cursored — drafts and merged PRs included — so lifecycle/state-based
 * rules see the full picture.
 *
 * Items emitted here carry the PR's labels but `type = null` (triage not run).
 * `repo` is the slug; `external_id` is "slug#number" same as issues but the
 * Item is distinguished by `source.kind = "github_prs"`.
 */
export function readGitHubPrs(
  source: GitHubPrsSource,
  opts: { since?: string; cap?: number } = {},
): Item[] {
  const prs = opts.since
    ? listPrsSince(source.slug, opts.since)
    : listOpenPrs(source.slug, opts.cap ?? 25);
  return prs.map(pr => prToItem(source, pr));
}

/** Pure mapper — exported so it can be exercised without hitting gh. */
export function prToItem(source: GitHubPrsSource, pr: GitHubPR): Item {
  return {
    source: { name: source.name, kind: "github_prs" },
    external_id: `${source.slug}#${pr.number}`,
    url: pr.html_url,
    title: pr.title,
    body: pr.body ?? "",
    author: pr.user?.login ?? null,
    repo: source.slug,
    labels: pr.labels.map(l => l.name),
    type: null,
    created_at: pr.created_at,
    raw: pr,
  };
}
