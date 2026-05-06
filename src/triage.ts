import { query } from "@anthropic-ai/claude-agent-sdk";
import type { GitHubIssue, RepoConfig, SecurityFlag, TriageResult } from "./types.ts";

const SECURITY_KINDS: SecurityFlag["kind"][] = ["secret-leak", "vuln-disclosure", "pii", "abuse"];

const SYSTEM_PROMPT = `You are an issue-triage assistant for a GitHub-issue ingestion pipeline.

For each issue, return a strict JSON object with these fields:
- summary: one-line plain-English summary of the issue (<=140 chars).
- reasoning: one or two sentences explaining your classification choices.
- security_flag: null, OR { "kind": <one of "secret-leak" | "vuln-disclosure" | "pii" | "abuse">, "reason": short explanation } if the issue body appears to leak secrets/tokens, disclose a vulnerability that should be handled in a private channel rather than the public issue, expose personally identifiable information about a real person, or constitute abuse/spam.
- labels_to_add: array of GitHub labels to apply (lower-case kebab-case). Pick from a small standard set: "bug", "feature", "enhancement", "docs", "question", "needs-info", "duplicate", "p0", "p1", "p2", "p3". Only include labels you are confident about. Empty array is fine.

Rules:
- Be conservative on security_flag. Setting it skips the public vault and routes to a private inbox; only set it if there is a real signal (an actual token-shaped string, an explicit vulnerability disclosure, real PII, or clear abuse).
- Do not invent priority labels (p0/p1) for things that aren't time-critical.
- Output JSON only, no prose, no code fences.`;

export async function triageIssue(args: {
  issue: GitHubIssue;
  repo: RepoConfig;
  model: string;
  bodyTruncate: number;
}): Promise<TriageResult> {
  const { issue, repo, model, bodyTruncate } = args;

  const truncatedBody = (issue.body ?? "").slice(0, bodyTruncate);
  const existingLabels = issue.labels.map(l => l.name).join(", ") || "(none)";

  const userPrompt = [
    `Repo: ${repo.slug}`,
    repo.description ? `Repo description: ${repo.description}` : "",
    `Issue #${issue.number}: ${issue.title}`,
    `Author: ${issue.user?.login ?? "(unknown)"}`,
    `State: ${issue.state}`,
    `Existing labels: ${existingLabels}`,
    "",
    "Body:",
    "```",
    truncatedBody || "(empty)",
    "```",
    "",
    "Respond with ONLY the JSON object — no prose, no code fences.",
  ].filter(Boolean).join("\n");

  const result = query({
    prompt: userPrompt,
    options: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      maxTurns: 1,
      tools: [],
      includePartialMessages: false,
    },
  });

  let finalText: string | null = null;
  for await (const msg of result) {
    if (msg.type === "result") {
      if (msg.subtype === "success") {
        finalText = msg.result;
        break;
      }
      throw new Error(`triage SDK returned error result: ${msg.subtype}`);
    }
  }

  if (finalText === null) {
    throw new Error("triage SDK ended without a result message");
  }

  return parseTriageJSON(finalText);
}

function parseTriageJSON(text: string): TriageResult {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    throw new Error(`triage model returned non-JSON: ${(e as Error).message}\n--- raw ---\n${text}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error("triage JSON not an object");
  const o = parsed as Record<string, unknown>;

  const summary = typeof o.summary === "string" ? o.summary : "";
  const reasoning = typeof o.reasoning === "string" ? o.reasoning : "";
  const labels_to_add = Array.isArray(o.labels_to_add)
    ? o.labels_to_add.filter((l): l is string => typeof l === "string")
    : [];

  let security_flag: SecurityFlag | null = null;
  if (o.security_flag && typeof o.security_flag === "object") {
    const sf = o.security_flag as Record<string, unknown>;
    if (
      typeof sf.kind === "string" &&
      (SECURITY_KINDS as string[]).includes(sf.kind) &&
      typeof sf.reason === "string"
    ) {
      security_flag = { kind: sf.kind as SecurityFlag["kind"], reason: sf.reason };
    }
  }

  return { summary, reasoning, security_flag, labels_to_add };
}
