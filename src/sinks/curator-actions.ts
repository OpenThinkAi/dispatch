import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { closeIssue, commentOnIssue } from "../github.ts";
import { log } from "../log.ts";
import type { CuratorDecision, RepoConfig } from "../types.ts";

/** Append a markdown comment block to a vault ticket. */
export function appendVaultComment(ticketPath: string, header: string, body: string): void {
  if (!existsSync(ticketPath)) {
    throw new Error(`vault ticket not found at ${ticketPath}`);
  }
  const stamp = new Date().toISOString().slice(0, 10);
  const block = `\n### ${stamp} — ${header}\n\n${body.trim()}\n`;
  const existing = readFileSync(ticketPath, "utf-8");
  if (!/##\s+Comments/.test(existing)) {
    // Add a Comments section if the ticket doesn't have one.
    writeFileSync(ticketPath, existing.trimEnd() + "\n\n## Comments\n" + block);
    return;
  }
  appendFileSync(ticketPath, block);
}

/**
 * Apply a curator gh-comment decision: post the comment, optionally close the issue.
 * Errors are logged and rethrown to the caller.
 */
export function executeGhCommentDecision(args: {
  repo: RepoConfig;
  number: number;
  decision: Extract<CuratorDecision, { action: "gh-comment" }>;
  ticketPath: string | null;
}): void {
  const { repo, number, decision, ticketPath } = args;
  commentOnIssue(repo.slug, number, decision.gh_comment);
  if (decision.close_gh) {
    closeIssue(repo.slug, number, "completed");
  }
  if (ticketPath) {
    const reasoning = `**Curator decision:** gh-comment${decision.close_gh ? " + close" : ""}\n\n${decision.reasoning}`;
    appendVaultComment(ticketPath, "Curator", reasoning);
  }
  log.info("curator action: gh-comment", {
    slug: repo.slug,
    number,
    closed: decision.close_gh,
  });
}

/**
 * Apply a curator hold decision: append vault comment, optionally GH comment.
 */
export function executeHoldDecision(args: {
  repo: RepoConfig;
  number: number;
  decision: Extract<CuratorDecision, { action: "hold" }>;
  ticketPath: string | null;
}): void {
  const { repo, number, decision, ticketPath } = args;
  if (ticketPath) {
    const body = `**Curator decision:** hold\n\n${decision.reasoning}\n\n---\n\n${decision.vault_comment}`;
    appendVaultComment(ticketPath, "Curator", body);
  }
  if (decision.gh_comment_optional) {
    try {
      commentOnIssue(repo.slug, number, decision.gh_comment_optional);
    } catch (e) {
      // Don't crash the tick on a comment failure — the vault comment is the source of truth.
      log.warn("curator hold: GH comment failed", {
        slug: repo.slug,
        number,
        error: (e as Error).message,
      });
    }
  }
  log.warn("curator action: hold", {
    slug: repo.slug,
    number,
    reasoning: decision.reasoning.slice(0, 200),
  });
}

/**
 * Spawn `oteam assign --inline <ticket-path>` as a detached background process.
 * Returns the spawned PID (or null if spawn failed).
 *
 * This intentionally does NOT wait — the orchestrator exits while oteam runs
 * its multi-phase pipeline. State is monitored on the next tick by reading the
 * ticket's frontmatter (state field migrates as the pipeline advances).
 */
export function spawnOteamAssign(ticketPath: string, logDir: string): { ok: true; pid: number } | { ok: false; error: string } {
  if (!existsSync(ticketPath)) {
    return { ok: false, error: `ticket not found at ${ticketPath}` };
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const ticketName = ticketPath.split("/").pop() ?? "ticket";
  const logPath = `${logDir}/oteam-assign-${stamp}-${ticketName}.log`;

  try {
    const child = spawn("oteam", ["assign", "--inline", ticketPath], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      // Keep simple: stdout/stderr inherit-then-discard. Real run logs land in
      // ~/.open-team/runs/ via oteam's own logging.
    });
    child.unref();
    if (typeof child.pid !== "number") {
      return { ok: false, error: "spawned but no pid returned" };
    }
    // Emit the AGT-NNN ID as `ticket` (matching every other dispatch log
     // line), with the full path as a separate `ticket_path` field.
     // Earlier this emission used `ticket: ticketPath`, which made
     // downstream consumers (the dispatch view feed, log greps) display a
     // truncated file path where the AGT-ID was expected.
    const ticketId = ticketPath.split("/").pop()?.match(/^(AGT-\d+)-/)?.[1] ?? null;
    log.info("orchestrator spawned oteam assign", {
      pid: child.pid,
      ticket: ticketId,
      ticket_path: ticketPath,
      log_hint: logPath,
    });
    return { ok: true, pid: child.pid };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
