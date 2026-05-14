import type { Item, LinearIssue, LinearSource } from "../types.ts";

const LINEAR_ENDPOINT = "https://api.linear.app/graphql";

const ISSUES_QUERY = `
  query Issues($filter: IssueFilter, $first: Int) {
    issues(filter: $filter, first: $first, orderBy: updatedAt) {
      nodes {
        id
        identifier
        title
        description
        url
        state { name }
        labels { nodes { name } }
        creator { name email }
        team { key }
        project { name }
        createdAt
        updatedAt
      }
    }
  }
`;

/**
 * Read items from a Linear source. Uses the LINEAR_API_KEY env var; no SDK
 * dependency — direct GraphQL over fetch keeps the spike footprint small.
 *
 * Filtering:
 *   - `team` is required (Linear's `team.key` like "ENG"; not the UUID)
 *   - optional `state` filters by state name (e.g. "Todo", "In Progress")
 *   - optional `project` filters by project name
 *   - `opts.since` (ISO cursor) → only issues updated at/after that timestamp;
 *     without it, fetches the most-recently-updated `opts.cap ?? 25`
 *
 * Items emitted carry the issue's Linear labels but `type = null`.
 */
export async function readLinear(
  source: LinearSource,
  opts: { since?: string; cap?: number } = {},
): Promise<Item[]> {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error("LINEAR_API_KEY is not set in the environment");
  }

  const filter: Record<string, unknown> = {
    team: { key: { eq: source.team } },
  };
  if (source.state) filter.state = { name: { eq: source.state } };
  if (source.project) filter.project = { name: { eq: source.project } };
  if (opts.since) filter.updatedAt = { gte: opts.since };

  const res = await fetch(LINEAR_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({
      query: ISSUES_QUERY,
      variables: { filter, first: opts.cap ?? 25 },
    }),
  });

  if (!res.ok) {
    throw new Error(`linear API HTTP ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    data?: { issues?: { nodes?: LinearIssue[] } };
    errors?: { message: string }[];
  };
  if (json.errors && json.errors.length > 0) {
    throw new Error(`linear API errors: ${json.errors.map(e => e.message).join("; ")}`);
  }
  const nodes = json.data?.issues?.nodes ?? [];
  return nodes.map(issue => linearIssueToItem(source, issue));
}

/** Pure mapper — exported so it can be exercised without hitting the API. */
export function linearIssueToItem(source: LinearSource, issue: LinearIssue): Item {
  return {
    source: { name: source.name, kind: "linear" },
    external_id: issue.identifier, // e.g. "ENG-123"
    url: issue.url,
    title: issue.title,
    body: issue.description ?? "",
    author: issue.creator?.email ?? issue.creator?.name ?? null,
    repo: null,
    labels: (issue.labels.nodes ?? []).map(l => l.name),
    type: null,
    created_at: issue.createdAt,
    raw: issue,
  };
}
