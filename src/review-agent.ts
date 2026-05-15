import { query } from "@anthropic-ai/claude-agent-sdk";

export type ReviewVerdict = "approve" | "request-changes" | "comment";

export type ReviewDecision = {
  verdict: ReviewVerdict;
  /** Top-level review body posted alongside the verdict. Plain markdown. */
  body: string;
  reasoning: string;
};

export type ReviewOutcome = {
  decision: ReviewDecision;
  cost_usd: number | null;
};

const SYSTEM_PROMPT = `You are an automated pull-request reviewer. Read a PR's title, body, and unified diff, then return ONE verdict on the change as a whole.

Output strict JSON with no prose, no code fences:

{
  "verdict": "approve" | "request-changes" | "comment",
  "body": "<the comment body to post on the PR — markdown — 1-3 paragraphs at most>",
  "reasoning": "<2-4 sentences of internal reasoning, NOT posted to GH>"
}

Verdict rules:

- "approve" — only when ALL hold:
  - No bugs, security issues, or correctness concerns visible in the diff.
  - The change is bounded enough that a human reviewer would also approve it.
  - No load-bearing context is missing (e.g. a referenced ticket / discussion you can't see).

- "request-changes" — when ANY hold:
  - A concrete bug or security issue visible in the diff (name it).
  - A clearly-broken contract: missing rollback / unbounded mutation /
    breaking-change in shared surface without a flag.
  - Tests obviously needed and missing (only for code paths where the
    project's existing pattern is "tests exist" — don't invent test
    requirements where the codebase doesn't already have them).
  - The PR is so large or unfocused that a meaningful review is impossible.

- "comment" — DEFAULT when uncertain:
  - The diff looks reasonable but you'd want a human's read on
    something specific (call out what).
  - A nit or minor improvement that wouldn't block a human's approval
    but is worth raising.
  - A question about intent or context.

Quality bar for "body":
- Lead with the verdict-shaped takeaway (1 sentence).
- Specifics over generalities — name files, lines, identifiers.
- Two short paragraphs at most. No checklists, no marketing, no signoff.
- For "approve", a one-liner is fine.
- For "request-changes" or "comment", explain what would change your mind
  (or what a human should weigh in on).

Output JSON ONLY.`;

export async function reviewPullRequest(args: {
  slug: string;
  number: number;
  title: string;
  body: string;
  diff: string;
  model: string;
  perCallMaxBudgetUsd: number;
  diffTruncateChars?: number;
}): Promise<ReviewOutcome> {
  const truncateAt = args.diffTruncateChars ?? 60_000;
  const truncatedDiff = args.diff.length > truncateAt
    ? args.diff.slice(0, truncateAt) +
      `\n\n[... diff truncated at ${truncateAt} chars; full size ${args.diff.length} chars ...]`
    : args.diff;

  const userPrompt = [
    `PR: ${args.slug}#${args.number}`,
    `Title: ${args.title}`,
    "",
    "Description:",
    "```",
    args.body || "(empty)",
    "```",
    "",
    "Unified diff:",
    "```diff",
    truncatedDiff,
    "```",
    "",
    "Respond with ONLY the JSON object — no prose, no code fences.",
  ].join("\n");

  const sdk = query({
    prompt: userPrompt,
    options: {
      systemPrompt: SYSTEM_PROMPT,
      model: args.model,
      maxTurns: 1,
      maxBudgetUsd: args.perCallMaxBudgetUsd,
      tools: [],
      includePartialMessages: false,
    },
  });

  let finalText: string | null = null;
  let cost: number | null = null;
  for await (const msg of sdk) {
    if (msg.type === "result") {
      if (msg.subtype === "success") {
        finalText = msg.result;
        cost = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : null;
        break;
      }
      throw new Error(`review-agent SDK returned error result: ${msg.subtype}`);
    }
  }
  if (finalText === null) throw new Error("review-agent SDK ended without result");

  const decision = parseReviewJSON(finalText);
  return { decision, cost_usd: cost };
}

/**
 * Defense-in-depth secret scan over a PR diff. Mirrors the regex shapes
 * `src/sinks/security.ts:redact` uses (token prefixes + PEM private-key
 * blocks). NOT a full secret scanner — it catches the common, obvious
 * shapes that show up in accidental commits. When this fires, the
 * caller refuses to send the diff to the review-agent (and therefore
 * to the Anthropic API). Items where the diff trips this gate are
 * better off held for manual review than processed by an automated
 * lane that would exfiltrate the secret to a third-party API.
 *
 * The "long hex" pattern from redact() is intentionally omitted here
 * because diffs naturally contain long hex strings in their headers
 * (commit SHAs, blob hashes) and would false-positive every diff.
 */
export function diffLikelyContainsSecrets(
  diff: string,
): { found: false } | { found: true; reason: string } {
  if (/-----BEGIN [A-Z ]+PRIVATE KEY-----/.test(diff)) {
    return { found: true, reason: "PEM private-key block" };
  }
  const tokenRe =
    /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghu_[A-Za-z0-9]{20,}|ghr_[A-Za-z0-9]{20,}|xox[bpars]-[A-Za-z0-9-]{10,})\b/;
  const m = diff.match(tokenRe);
  if (m) return { found: true, reason: `token-shaped string (prefix "${m[1].slice(0, 5)}…")` };
  return { found: false };
}

function parseReviewJSON(text: string): ReviewDecision {
  // Match the existing curator + triage parser pattern: strip ```json fences
  // if present before JSON.parse. The prompt asks for JSON-only output, but
  // models occasionally wrap it anyway. The earlier curator/triage code
  // already does this strip and it's the established project precedent;
  // a previous review iteration removed the strip here on the assumption
  // those parsers throw on fenced output, but they don't. Live test against
  // claude-sonnet-4-6 confirmed the model returns fenced output for review
  // even with explicit "no code fences" in the system prompt — keeping the
  // strip is the operational reality, not a soft-rescue fallback.
  const trimmed = text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    throw new Error(`review-agent returned non-JSON: ${(e as Error).message}\n--- raw ---\n${text}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error("review-agent JSON not an object");
  const o = parsed as Record<string, unknown>;

  const verdict = o.verdict;
  if (verdict !== "approve" && verdict !== "request-changes" && verdict !== "comment") {
    throw new Error(`review-agent returned unknown verdict: ${String(verdict)}`);
  }
  const body = typeof o.body === "string" ? o.body : "";
  if (!body) throw new Error("review-agent decision missing body");
  const reasoning = typeof o.reasoning === "string" ? o.reasoning : "";

  return { verdict, body, reasoning };
}
