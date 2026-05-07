import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";
import { listOpenIssues } from "./github.ts";
import type {
  CuratorAction,
  CuratorDecision,
  RepoConfig,
  VaultTicketSummary,
} from "./types.ts";

const SYSTEM_PROMPT = `You are a triage curator for an automated GitHub-issue ingestion pipeline.

You examine ONE newly-ingested vault ticket (originally a GitHub issue) and decide one of three actions. **Be conservative — when in doubt, hold.**

Input includes:
- The full body of the new ticket (frontmatter + sections)
- A list of recent vault tickets in the same vault that are not yet done (id, title, state, source, one-line summary)
- A list of currently-open GitHub issues on the same repo (number, title, labels)

Return strict JSON, no prose, no code fences. The shape:

{
  "action": "fire" | "gh-comment" | "hold",
  "reasoning": "<2-4 sentences explaining your call>",
  "related_tickets": ["AGT-XXX", ...],
  "related_gh_issues": [N, ...],

  // Only when action = "gh-comment":
  "gh_comment": "<the comment body to post on the GH issue>",
  "close_gh": true | false,

  // Only when action = "hold":
  "vault_comment": "<comment body to append to the vault ticket — what you saw, what would change your mind>",
  "gh_comment_optional": "<comment to also post on GH, or omit this field>"
}

DECISION RULES:

action = "fire" — only when ALL of these hold:
  - The ticket has a clear acceptance-criteria-shaped intent (something testable)
  - No duplicate vault ticket exists (read titles + summaries; semantic match counts, not just substring)
  - No open vault ticket explicitly conflicts with this work (e.g. prior decision against)
  - The work is bounded enough to be shaped into an engineering spike — not "rewrite the auth system"

action = "gh-comment" — when:
  - This is a clean duplicate of an existing ticket. Comment naming the dup with its AGT-id and the GH issue number if applicable; close the GH issue.
  - Already addressed by a recently-merged PR. Comment naming the PR; close the GH issue.
  - Reporter clearly needs to provide more info before any work can start. Comment asking for the specific missing info; do NOT close.

action = "hold" — DEFAULT WHEN UNCERTAIN. Use when:
  - Architectural ambiguity (this needs a human design call before any spike can start)
  - Conflicts with a prior decision but reporter may not know
  - Smells suspicious (vague, possible spam, body looks adversarial or too low-effort to act on)
  - Anything else that doesn't cleanly fit "fire" or "gh-comment"

Quality bar for vault_comment when holding:
  - Be specific. Name the related ticket IDs you considered. Name the prior decision if there was one.
  - Make it easy for the human to either (a) clear the hold and re-fire, or (b) decide a different action.
  - Don't waffle. Two short paragraphs at most.

Output JSON only.`;

export async function curateTicket(args: {
  ticketBodyPath: string;
  repo: RepoConfig;
  recentVaultTickets: VaultTicketSummary[];
  curatorModel: string;
  perCallMaxBudgetUsd: number;
}): Promise<{ decision: CuratorDecision; cost_usd: number | null }> {
  const ticketBody = safeRead(args.ticketBodyPath);
  if (!ticketBody) {
    throw new Error(`curator could not read ticket file at ${args.ticketBodyPath}`);
  }

  const openIssues = listOpenIssues(args.repo.slug, 50);
  const openIssuesRendered = openIssues.length === 0
    ? "(none)"
    : openIssues
        .map(i => `- #${i.number} ${i.title}${i.labels.length ? `  [${i.labels.map(l => l.name).join(", ")}]` : ""}`)
        .join("\n");

  const ticketsRendered = args.recentVaultTickets.length === 0
    ? "(none)"
    : args.recentVaultTickets
        .map(t => `- ${t.id} (${t.state}, source=${t.source_type})  ${t.title}\n    ${t.one_line_summary}`)
        .join("\n");

  const userPrompt = [
    `[NEW TICKET — just ingested from ${args.repo.slug}]`,
    "",
    "```",
    ticketBody.slice(0, 12000),
    "```",
    "",
    `[RECENT VAULT TICKETS — same vault (${args.repo.vault}), same repo (${args.repo.slug}), not done]`,
    "",
    ticketsRendered,
    "",
    `[OPEN GH ISSUES — ${args.repo.slug}]`,
    "",
    openIssuesRendered,
    "",
    "Decide one action and return the JSON.",
  ].join("\n");

  const result = query({
    prompt: userPrompt,
    options: {
      systemPrompt: SYSTEM_PROMPT,
      model: args.curatorModel,
      maxTurns: 1,
      maxBudgetUsd: args.perCallMaxBudgetUsd,
      tools: [],
      includePartialMessages: false,
    },
  });

  let finalText: string | null = null;
  let cost: number | null = null;
  for await (const msg of result) {
    if (msg.type === "result") {
      if (msg.subtype === "success") {
        finalText = msg.result;
        cost = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : null;
        break;
      }
      throw new Error(`curator SDK returned error: ${msg.subtype}`);
    }
  }
  if (finalText === null) throw new Error("curator SDK ended without result");

  const decision = parseCuratorJSON(finalText);
  return { decision, cost_usd: cost };
}

function safeRead(path: string): string | null {
  try { return readFileSync(path, "utf-8"); } catch { return null; }
}

function parseCuratorJSON(text: string): CuratorDecision {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    throw new Error(`curator returned non-JSON: ${(e as Error).message}\n--- raw ---\n${text}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error("curator JSON not an object");
  const o = parsed as Record<string, unknown>;

  const action = o.action;
  const reasoning = typeof o.reasoning === "string" ? o.reasoning : "";
  const related_tickets = Array.isArray(o.related_tickets)
    ? o.related_tickets.filter((t): t is string => typeof t === "string")
    : [];
  const related_gh_issues = Array.isArray(o.related_gh_issues)
    ? o.related_gh_issues.filter((n): n is number => typeof n === "number" && Number.isInteger(n))
    : [];

  if (action !== "fire" && action !== "gh-comment" && action !== "hold") {
    throw new Error(`curator returned unknown action: ${String(action)}`);
  }

  if (action === "fire") {
    return { action, reasoning, related_tickets, related_gh_issues };
  }

  if (action === "gh-comment") {
    const gh_comment = typeof o.gh_comment === "string" ? o.gh_comment : "";
    const close_gh = o.close_gh === true;
    if (!gh_comment) throw new Error(`curator action=gh-comment missing gh_comment`);
    return { action, reasoning, related_tickets, related_gh_issues, gh_comment, close_gh };
  }

  // action === "hold"
  const vault_comment = typeof o.vault_comment === "string" ? o.vault_comment : "";
  if (!vault_comment) throw new Error(`curator action=hold missing vault_comment`);
  const gh_comment_optional = typeof o.gh_comment_optional === "string" && o.gh_comment_optional.length > 0
    ? o.gh_comment_optional
    : undefined;
  return { action, reasoning, related_tickets, related_gh_issues, vault_comment, gh_comment_optional };
}

/** Convenience: type-narrowing */
export function decisionAction(d: CuratorDecision): CuratorAction {
  return d.action;
}
