import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claimIssue, listIssuesSince } from "./github.ts";
import { log } from "./log.ts";
import { State, hashIssueContent } from "./state.ts";
import { triageIssue } from "./triage.ts";
import { applyLabels, clearLabels } from "./sinks/labels.ts";
import { holdForSecurityReview } from "./sinks/security.ts";
import { buildProjectIndex, pullIntoVault, type ProjectIndex } from "./sinks/vault.ts";
import { curateTicket } from "./curator.ts";
import { readRecentVaultTickets, resolveVaultPath } from "./vault-read.ts";
import {
  appendVaultComment,
  executeGhCommentDecision,
  executeHoldDecision,
  spawnOteamAssign,
} from "./sinks/curator-actions.ts";
import type { Config, GitHubIssue, ProcessOutcome, RepoConfig } from "./types.ts";

export type PollSummary = {
  ingested: number;
  curated: number;
  fired: number;
  held: number;
  gh_resolved: number;
  errors: number;
  curator_cost_usd: number;
};

export async function pollOnce(cfg: Config): Promise<PollSummary> {
  const state = new State(cfg.defaults.state_dir);
  const summary: PollSummary = {
    ingested: 0,
    curated: 0,
    fired: 0,
    held: 0,
    gh_resolved: 0,
    errors: 0,
    curator_cost_usd: 0,
  };

  const { index: projectIndex, errors: indexErrors } = buildProjectIndex(cfg);
  for (const e of indexErrors) {
    log.error("project index unavailable", { vault: e.vault, reason: e.reason });
    summary.errors += 1;
  }

  try {
    // ── Phase A: ingest ──────────────────────────────────────────────────
    for (const repo of cfg.repos) {
      try {
        const seeded = state.ensureCursorSeeded(repo.slug);
        if (seeded) {
          log.info("cursor seeded to now (no backfill on first run)", { slug: repo.slug });
          continue;
        }
        const since = state.getCursor(repo.slug)!;
        const issues = listIssuesSince(repo.slug, since);
        if (issues.length === 0) {
          log.debug("no new issues", { slug: repo.slug, since });
          continue;
        }
        log.info("issues to consider", { slug: repo.slug, count: issues.length, since });

        let maxUpdated = since;
        for (const issue of issues) {
          const outcome = await processIssue({ issue, repo, cfg, state, projectIndex });
          if (outcome.kind === "filed" || outcome.kind === "updated") summary.ingested += 1;
          if (outcome.kind === "error") summary.errors += 1;
          if (issue.updated_at > maxUpdated) maxUpdated = issue.updated_at;
        }
        state.setCursor(repo.slug, maxUpdated);
      } catch (e) {
        summary.errors += 1;
        log.error("repo poll failed", { slug: repo.slug, error: (e as Error).message });
      }
    }

    // ── Phase B: sweep previously-deferred green-lit rows ───────────────
    // Rows landed in "green-lit" because a prior tick hit the spawn cap, the
    // claim API failed transiently, or the oteam assign spawn failed. Without
    // a sweeper they were stranded — neither curate nor drive queried that
    // status. Sweep runs before curate so older deferred work doesn't starve
    // against fresh ingestion.
    sweepGreenLit(cfg, state, summary);

    // ── Phase C: curate new awaiting-curation rows, fire on green decision ──
    await curateAndOrchestrate(cfg, state, summary);

    // ── Phase D: drive in-flight tickets through the role pipeline ───────
    driveInFlight(cfg, state, summary);
  } finally {
    state.close();
  }

  log.info("poll complete", { ...summary });
  return summary;
}

async function curateAndOrchestrate(cfg: Config, state: State, summary: PollSummary): Promise<void> {
  const awaiting = state.listByStatus("awaiting-curation", 100);
  if (awaiting.length === 0) {
    log.debug("no tickets awaiting curation");
    return;
  }

  // Share the per-tick spawn budget with the sweep that ran before us so
  // fresh curation can't blow past the cap that the sweeper already started
  // consuming.
  let spawnsThisTick = summary.fired;
  const maxSpawns = cfg.defaults.max_orchestrator_spawns_per_tick;

  for (const row of awaiting) {
    const repo = cfg.repos.find(r => r.slug.toLowerCase() === row.slug.toLowerCase());
    if (!repo) {
      log.warn("awaiting-curation row references repo not in config; skipping", { slug: row.slug, number: row.number });
      continue;
    }
    if (repo.autopilot === "off") {
      // Repo wasn't intended for autopilot; leave the row alone (or sweep to terminal). Skip silently.
      continue;
    }

    if (summary.curator_cost_usd >= cfg.defaults.per_tick_max_budget_usd) {
      log.warn("per-tick curator budget reached; deferring remaining curation", {
        spent_usd: summary.curator_cost_usd,
        cap_usd: cfg.defaults.per_tick_max_budget_usd,
        deferred: awaiting.length - summary.curated,
      });
      break;
    }

    const ticketPath = vaultTicketPath(state, repo.vault, row);
    if (!ticketPath) {
      log.error("could not resolve vault ticket path; marking failed", { slug: row.slug, number: row.number });
      state.setTriageStatus(row.slug, row.number, "failed");
      summary.errors += 1;
      continue;
    }

    const recent = readRecentVaultTickets({
      vault: repo.vault,
      repo: repo.slug,
      windowDays: cfg.defaults.recent_vault_tickets_window_days,
      cap: cfg.defaults.recent_vault_tickets_cap,
    });

    let decision;
    let cost: number | null = null;
    try {
      const r = await curateTicket({
        ticketBodyPath: ticketPath,
        repo,
        recentVaultTickets: recent,
        curatorModel: cfg.defaults.curator_model,
        perCallMaxBudgetUsd: cfg.defaults.per_call_max_budget_usd,
      });
      decision = r.decision;
      cost = r.cost_usd;
    } catch (e) {
      log.error("curator call failed", {
        slug: row.slug,
        number: row.number,
        error: (e as Error).message,
      });
      summary.errors += 1;
      continue;
    }

    summary.curated += 1;
    if (cost !== null) summary.curator_cost_usd += cost;

    state.recordCuratorDecision({
      slug: row.slug,
      number: row.number,
      decision: decision.action,
      reasoning: decision.reasoning,
      related_tickets: decision.related_tickets,
      related_gh_issues: decision.related_gh_issues,
      cost_usd: cost,
    });

    try {
      if (decision.action === "gh-comment") {
        executeGhCommentDecision({ repo, number: row.number, decision, ticketPath });
        state.setTriageStatus(row.slug, row.number, "gh-resolved");
        summary.gh_resolved += 1;
        continue;
      }
      if (decision.action === "hold") {
        executeHoldDecision({ repo, number: row.number, decision, ticketPath });
        state.setTriageStatus(row.slug, row.number, "held-for-human");
        summary.held += 1;
        continue;
      }
      // action === "fire"
      if (repo.autopilot === "curate-only") {
        // Curator green-lit, but the repo's autopilot is curate-only.
        // Mark green-lit so a future tick (or manual flip) can fire it.
        appendVaultComment(
          ticketPath,
          "Curator",
          `**Curator decision:** fire (autopilot=curate-only, NOT executing)\n\n${decision.reasoning}`
        );
        state.setTriageStatus(row.slug, row.number, "green-lit");
        continue;
      }
      // autopilot is "fire" or "drive" — both proceed to spawn the
      // first phase. The two modes diverge at the post-spawn bookkeeping
      // below: "fire" terminates after one phase, "drive" transitions to
      // "driving" so the drive loop continues firing subsequent phases.
      if (spawnsThisTick >= maxSpawns) {
        log.info("orchestrator spawn cap reached; deferring fire to next tick", {
          slug: row.slug,
          number: row.number,
        });
        state.setTriageStatus(row.slug, row.number, "green-lit");
        continue;
      }

      // Claim the GH issue before invoking oteam assign so other actors
      // (humans, other dispatch instances) see this work is taken.
      const claim = claimIssue(row.slug, row.number, cfg.defaults.bot_identity);
      if (!claim.ok) {
        if (claim.reason === "already-claimed") {
          log.info("issue already claimed; skipping fire", {
            slug: row.slug,
            number: row.number,
            assignees: claim.assignees,
          });
          appendVaultComment(
            ticketPath,
            "Curator",
            `**Curator decision:** fire (autopilot=fire, NOT executing — issue assigned to ${claim.assignees.join(", ")})\n\n${decision.reasoning}`
          );
          state.setTriageStatus(row.slug, row.number, "lost-race");
          continue;
        }
        if (claim.reason === "issue-closed") {
          log.info("issue closed before claim; skipping fire", { slug: row.slug, number: row.number });
          state.setTriageStatus(row.slug, row.number, "gh-resolved");
          summary.gh_resolved += 1;
          continue;
        }
        // no-write-access or api-error: leave green-lit so the next tick can retry.
        log.error("claim failed; deferring fire", {
          slug: row.slug,
          number: row.number,
          reason: claim.reason,
          error: claim.reason === "api-error" ? claim.error : undefined,
        });
        state.setTriageStatus(row.slug, row.number, "green-lit");
        summary.errors += 1;
        continue;
      }

      const spawn = spawnOteamAssign(ticketPath, cfg.defaults.log_dir);
      if (!spawn.ok) {
        log.error("oteam assign spawn failed", {
          slug: row.slug,
          number: row.number,
          error: spawn.error,
        });
        state.setTriageStatus(row.slug, row.number, "green-lit");
        summary.errors += 1;
        continue;
      }
      // Claim succeeded and we've spawned the agent — mark the GH issue
      // visually so operators scanning the board can distinguish
      // "currently being worked by an agent" from any other open issue.
      // applyLabels is best-effort (respects can_label, swallows errors).
      applyLabels(repo, row.number, ["agent:assigned"]);
      appendVaultComment(
        ticketPath,
        "Curator",
        `**Curator decision:** fire (autopilot=${repo.autopilot}, oteam assign spawned pid=${spawn.pid})\n\n${decision.reasoning}`
      );
      // autopilot=fire stops here (one phase only). autopilot=drive transitions
      // to "driving" so the drive loop watches subsequent phases.
      if (repo.autopilot === "drive") {
        const initial = readVaultTicketState(ticketPath) ?? "triage";
        state.setTriageStatus(row.slug, row.number, "driving");
        state.setLastFiredForState(row.slug, row.number, initial);
      } else {
        state.setTriageStatus(row.slug, row.number, "fired");
      }
      summary.fired += 1;
      spawnsThisTick += 1;
    } catch (e) {
      log.error("curator action execution failed", {
        slug: row.slug,
        number: row.number,
        action: decision.action,
        error: (e as Error).message,
      });
      summary.errors += 1;
    }
  }
}

/**
 * Re-attempt the fire path for rows the curator already decided to fire on but
 * which got deferred to "green-lit" by a prior tick — spawn cap reached,
 * claim failed transiently, or oteam assign failed. Without this sweep these
 * rows would sit forever: curateAndOrchestrate only queries "awaiting-curation"
 * and driveInFlight only queries "driving".
 *
 * Skipped: repos with autopilot "off" (orphan rows; operator decides) or
 * "curate-only" (those are intentionally green-lit for human review).
 */
function sweepGreenLit(cfg: Config, state: State, summary: PollSummary): void {
  const greenLit = state.listByStatus("green-lit", 100);
  if (greenLit.length === 0) return;

  const maxSpawns = cfg.defaults.max_orchestrator_spawns_per_tick;

  for (const row of greenLit) {
    if (summary.fired >= maxSpawns) {
      log.debug("sweep: spawn cap reached; deferring remaining green-lit", {
        cap: maxSpawns,
      });
      return;
    }

    const repo = cfg.repos.find(r => r.slug.toLowerCase() === row.slug.toLowerCase());
    if (!repo) continue;
    if (repo.autopilot === "off" || repo.autopilot === "curate-only") continue;

    const ticketPath = vaultTicketPath(state, repo.vault, row);
    if (!ticketPath) {
      log.error("sweep: vault ticket file gone; marking failed", {
        slug: row.slug,
        number: row.number,
        vault_ticket_id: row.vault_ticket_id,
      });
      state.setTriageStatus(row.slug, row.number, "failed");
      summary.errors += 1;
      continue;
    }

    const claim = claimIssue(row.slug, row.number, cfg.defaults.bot_identity);
    if (!claim.ok) {
      if (claim.reason === "already-claimed") {
        log.info("sweep: issue claimed by other actor; marking lost-race", {
          slug: row.slug,
          number: row.number,
          assignees: claim.assignees,
        });
        state.setTriageStatus(row.slug, row.number, "lost-race");
        continue;
      }
      if (claim.reason === "issue-closed") {
        log.info("sweep: issue closed before claim; marking gh-resolved", {
          slug: row.slug,
          number: row.number,
        });
        state.setTriageStatus(row.slug, row.number, "gh-resolved");
        summary.gh_resolved += 1;
        continue;
      }
      log.warn("sweep: claim failed; leaving green-lit for next tick", {
        slug: row.slug,
        number: row.number,
        reason: claim.reason,
        error: claim.reason === "api-error" ? claim.error : undefined,
      });
      summary.errors += 1;
      continue;
    }

    const spawn = spawnOteamAssign(ticketPath, cfg.defaults.log_dir);
    if (!spawn.ok) {
      log.error("sweep: oteam assign spawn failed; leaving green-lit", {
        slug: row.slug,
        number: row.number,
        error: spawn.error,
      });
      summary.errors += 1;
      continue;
    }

    applyLabels(repo, row.number, ["agent:assigned"]);

    log.info("sweep: fired previously-deferred green-lit row", {
      slug: row.slug,
      number: row.number,
      ticket: row.vault_ticket_id,
      autopilot: repo.autopilot,
      pid: spawn.pid,
    });

    if (repo.autopilot === "drive") {
      const initial = readVaultTicketState(ticketPath) ?? "triage";
      state.setTriageStatus(row.slug, row.number, "driving");
      state.setLastFiredForState(row.slug, row.number, initial);
    } else {
      state.setTriageStatus(row.slug, row.number, "fired");
    }
    summary.fired += 1;
  }
}

function vaultTicketPath(_state: State, vault: string, row: { vault_ticket_id: string | null }): string | null {
  if (!row.vault_ticket_id) return null;
  const vaultPath = resolveVaultPath(vault);
  if (!vaultPath) return null;
  // Search the standard ticket folders for a file matching <ID>-*.md.
  const folders = ["triage", "refined", "in-progress", "qa", "blocked"];
  for (const folder of folders) {
    const dir = join(vaultPath, "tickets", folder);
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    const match = entries.find(n => n.startsWith(`${row.vault_ticket_id}-`) && n.endsWith(".md"));
    if (match) {
      const candidate = join(dir, match);
      if (existsSync(candidate)) return candidate;
    }
  }
  // Also search archive subdirs (organized as archive/<YYYY-MM>/<ID>-*.md).
  // oteam writes archives to <vault>/archive/. The <vault>/tickets/archive/
  // fallback covers older vault layouts that nested archive under tickets.
  const archiveRoots = [
    join(vaultPath, "archive"),
    join(vaultPath, "tickets", "archive"),
  ];
  for (const archiveRoot of archiveRoots) {
    let monthDirs: string[];
    try { monthDirs = readdirSync(archiveRoot); } catch { continue; }
    for (const month of monthDirs) {
      const dir = join(archiveRoot, month);
      let entries: string[];
      try { entries = readdirSync(dir); } catch { continue; }
      const match = entries.find(n => n.startsWith(`${row.vault_ticket_id}-`) && n.endsWith(".md"));
      if (match) {
        const candidate = join(dir, match);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

/** Read the YAML frontmatter `state:` field from a vault ticket. */
function readVaultTicketState(ticketPath: string): string | null {
  let text: string;
  try { text = readFileSync(ticketPath, "utf-8"); } catch { return null; }
  // Frontmatter is delimited by --- on the first line and the next ---.
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 4);
  if (end < 0) return null;
  const fm = text.slice(4, end);
  const m = fm.match(/^state:\s*(\S+)\s*$/m);
  return m ? m[1]! : null;
}

/** True when the ticket has reached a terminal vault state and the drive
 * loop should stop watching. Note that `blocked` is NOT terminal here —
 * it has its own dedicated transition to pipeline-held in the drive loop. */
function isTerminalVaultState(state: string): boolean {
  return state === "done" || state === "archive";
}

const STUCK_THRESHOLD_MS = 60 * 60 * 1000; // 60 min

/** Scan ~/.open-team/telemetry/runs.jsonl for the most recent line referencing
 * `ticketId`, return its latest timestamp (started-at or ended-at) in ms.
 * Returns null if no entries match or the file is unavailable.
 *
 * Telemetry rows are appended on phase completion, so this only catches
 * multi-phase progression — within-phase activity is covered by the worktree
 * heartbeat below. */
function latestTelemetryActivity(ticketId: string): number | null {
  if (!ticketId) return null;
  const path = join(homedir(), ".open-team", "telemetry", "runs.jsonl");
  let text: string;
  try { text = readFileSync(path, "utf-8"); } catch { return null; }
  const needle = `"ticket":"${ticketId}"`;
  let maxMs = 0;
  for (const line of text.split("\n")) {
    if (!line.includes(needle)) continue;
    let row: { "started-at"?: unknown; "ended-at"?: unknown };
    try { row = JSON.parse(line); } catch { continue; }
    for (const key of ["started-at", "ended-at"] as const) {
      const v = row[key];
      if (typeof v !== "string") continue;
      const ms = Date.parse(v);
      if (!Number.isNaN(ms) && ms > maxMs) maxMs = ms;
    }
  }
  return maxMs > 0 ? maxMs : null;
}

/** Recursive max mtime across the per-ticket oteam worktree (skipping `.git`
 * and bounding depth so a deeply nested dep tree doesn't blow the stuck check
 * budget). Catches within-phase file activity — agent edits, build artifacts,
 * test runs — that no other signal sees. Returns null when the worktree is
 * absent (e.g. orphan row, agent never spawned, or workspace already GC'd). */
function latestWorktreeMtime(ticketId: string, maxDepth = 4): number | null {
  if (!ticketId) return null;
  const root = join("/tmp", "open-team-issues", ticketId.toLowerCase(), "repo");
  if (!existsSync(root)) return null;
  let maxMs = 0;
  const walk = (dir: string, depth: number): void => {
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        // Skip .git (huge object store, only ever changes via git plumbing
        // we'd see via top-level repo activity anyway) and standard build
        // output dirs (cargo target, node_modules, etc. can each hold tens
        // of thousands of stats per call without the agent making meaningful
        // progress through them).
        if (e.name === ".git" || e.name === "node_modules" || e.name === "target"
          || e.name === "dist" || e.name === "build" || e.name === ".next"
          || e.name === ".turbo" || e.name === "vendor") continue;
        if (depth < maxDepth) walk(full, depth + 1);
      } else if (e.isFile()) {
        try {
          const ms = statSync(full).mtimeMs;
          if (ms > maxMs) maxMs = ms;
        } catch { /* ignore unreadable file */ }
      }
    }
  };
  walk(root, 0);
  return maxMs > 0 ? maxMs : null;
}

/** Most recent activity timestamp across every signal we have. Used by the
 * stuck-detection check to avoid false-flagging long-but-active phases. */
function latestActivityMs(row: {
  last_processed_at: string;
  vault_ticket_id: string | null;
}): { ms: number; source: "row" | "telemetry" | "worktree" } {
  const rowMs = new Date(row.last_processed_at).getTime();
  let best: { ms: number; source: "row" | "telemetry" | "worktree" } = { ms: rowMs, source: "row" };
  if (!row.vault_ticket_id) return best;
  const tele = latestTelemetryActivity(row.vault_ticket_id);
  if (tele !== null && tele > best.ms) best = { ms: tele, source: "telemetry" };
  const wt = latestWorktreeMtime(row.vault_ticket_id);
  if (wt !== null && wt > best.ms) best = { ms: wt, source: "worktree" };
  return best;
}

function driveInFlight(cfg: Config, state: State, summary: PollSummary): void {
  const inFlight = state.listByStatus("driving", 100);
  if (inFlight.length === 0) return;

  let spawnsThisTick = summary.fired;
  const maxSpawns = cfg.defaults.max_orchestrator_spawns_per_tick;

  for (const row of inFlight) {
    const repo = cfg.repos.find(r => r.slug.toLowerCase() === row.slug.toLowerCase());
    if (!repo) {
      log.warn("driving row references repo not in config; skipping", { slug: row.slug, number: row.number });
      continue;
    }
    if (repo.autopilot !== "drive") {
      // Operator flipped the repo's autopilot mid-flight. Surface so the
      // abandoned row is visible in logs; leave it in place for manual
      // cleanup (we don't presume to know whether they want it killed).
      log.info("driving row: repo no longer in drive mode; leaving for manual cleanup", {
        slug: row.slug,
        number: row.number,
        ticket: row.vault_ticket_id,
        current_autopilot: repo.autopilot,
      });
      continue;
    }

    const ticketPath = vaultTicketPath(state, repo.vault, row);
    if (!ticketPath) {
      log.error("driving row: vault ticket file gone; marking pipeline-held", {
        slug: row.slug,
        number: row.number,
        vault_ticket_id: row.vault_ticket_id,
      });
      clearLabels(repo, row.number, ["agent:assigned"]);
      state.setTriageStatus(row.slug, row.number, "pipeline-held");
      summary.errors += 1;
      continue;
    }

    const currentState = readVaultTicketState(ticketPath);
    if (!currentState) {
      log.error("driving row: could not read state from frontmatter", {
        slug: row.slug,
        number: row.number,
        ticket_path: ticketPath,
      });
      continue;
    }

    if (isTerminalVaultState(currentState) || ticketPath.includes("/archive/")) {
      log.info("driving row: pipeline complete", {
        slug: row.slug,
        number: row.number,
        ticket: row.vault_ticket_id,
        final_state: currentState,
      });
      // oteam's QA-close path already strips agent:assigned on the happy
      // path; this clearLabels call is defense-in-depth for terminal
      // transitions that didn't go through QA close (e.g. issue closed
      // externally before QA, ticket moved straight to archive).
      clearLabels(repo, row.number, ["agent:assigned"]);
      state.setTriageStatus(row.slug, row.number, "pipeline-complete");
      continue;
    }

    if (currentState === "blocked") {
      log.info("driving row: ticket blocked; marking pipeline-held", {
        slug: row.slug,
        number: row.number,
        ticket: row.vault_ticket_id,
      });
      clearLabels(repo, row.number, ["agent:assigned"]);
      state.setTriageStatus(row.slug, row.number, "pipeline-held");
      continue;
    }

    if (currentState === row.last_fired_for_state) {
      // Phase still in flight (the agent for this state is presumably
      // still running) OR the agent finished a phase that returned a
      // pause-point without advancing state (spike plan review,
      // implementation taste call, QA changes_requested). Either way we
      // wait — but only up to the stuck threshold. Past that, transition
      // to pipeline-held so the row leaves the active set and shows up
      // in operator dashboards as needing attention. Self-quarantines
      // rather than silently piling up.
      //
      // last_processed_at is wall-clock-only: a long-but-active impl phase
      // (cargo build retries, large test suite) looks identical to a
      // genuinely hung phase. Augment with telemetry (per-phase completion
      // records — catches multi-phase progression) and worktree mtime
      // (within-phase file activity — catches the slow-impl case).
      const activity = latestActivityMs(row);
      const sinceActivity = Date.now() - activity.ms;
      if (sinceActivity > STUCK_THRESHOLD_MS) {
        log.warn("driving row: stuck past threshold; marking pipeline-held", {
          slug: row.slug,
          number: row.number,
          ticket: row.vault_ticket_id,
          state: currentState,
          activity_source: activity.source,
          minutes_since_activity: Math.round(sinceActivity / 60000),
          threshold_minutes: Math.round(STUCK_THRESHOLD_MS / 60000),
        });
        clearLabels(repo, row.number, ["agent:assigned"]);
        state.setTriageStatus(row.slug, row.number, "pipeline-held");
      }
      continue;
    }

    // State advanced — fire the next phase.
    if (spawnsThisTick >= maxSpawns) {
      log.info("drive: spawn cap reached; deferring next phase to next tick", {
        slug: row.slug,
        number: row.number,
        ticket: row.vault_ticket_id,
        state: currentState,
      });
      continue;
    }

    const spawn = spawnOteamAssign(ticketPath, cfg.defaults.log_dir);
    if (!spawn.ok) {
      log.error("drive: oteam assign re-spawn failed", {
        slug: row.slug,
        number: row.number,
        ticket: row.vault_ticket_id,
        state: currentState,
        error: spawn.error,
      });
      summary.errors += 1;
      continue;
    }

    log.info("drive: fired next phase", {
      slug: row.slug,
      number: row.number,
      ticket: row.vault_ticket_id,
      state: currentState,
      previous_state: row.last_fired_for_state,
      pid: spawn.pid,
    });
    state.setLastFiredForState(row.slug, row.number, currentState);
    summary.fired += 1;
    spawnsThisTick += 1;
  }
}

export async function processIssue(args: {
  issue: GitHubIssue;
  repo: RepoConfig;
  cfg: Config;
  state: State;
  projectIndex?: ProjectIndex;
}): Promise<ProcessOutcome> {
  const { issue, repo, cfg, state } = args;
  const hash = hashIssueContent(issue.title, issue.body);

  const existing = state.getSeen(repo.slug, issue.number);
  if (existing && existing.content_hash === hash) {
    log.debug("already seen, content unchanged", { slug: repo.slug, number: issue.number });
    return { kind: "skipped", reason: "unchanged" };
  }

  let triage;
  try {
    triage = await triageIssue({
      issue,
      repo,
      model: cfg.defaults.triage_model,
      bodyTruncate: cfg.defaults.body_truncate_chars,
    });
  } catch (e) {
    log.error("triage failed", {
      slug: repo.slug,
      number: issue.number,
      error: (e as Error).message,
    });
    return { kind: "error", error: (e as Error).message };
  }

  if (triage.security_flag) {
    holdForSecurityReview({
      issue,
      repo,
      flag: triage.security_flag,
      stateDir: cfg.defaults.state_dir,
    });
    state.markSeen({
      slug: repo.slug,
      number: issue.number,
      vault_ticket_id: null,
      content_hash: hash,
      triage_status: "held-for-human",
    });
    return { kind: "security-held", flag: triage.security_flag };
  }

  const index = args.projectIndex ?? buildProjectIndex(cfg).index;
  const projects = index.get(repo.vault);
  if (!projects || !projects.has(repo.project)) {
    const reason = !projects
      ? `vault ${repo.vault} not registered with oteam (or list failed)`
      : `project ${repo.project} does not exist in vault ${repo.vault}`;
    log.error("project verification failed", {
      slug: repo.slug,
      project: repo.project,
      vault: repo.vault,
      reason,
    });
    return { kind: "error", error: reason };
  }

  const isUpdate = !!existing;
  const pullResult = pullIntoVault({ issue, repo });
  if (!pullResult.ok) {
    log.error("oteam pull failed", {
      slug: repo.slug,
      number: issue.number,
      error: pullResult.error,
    });
    return { kind: "error", error: pullResult.error };
  }

  applyLabels(repo, issue.number, triage.labels_to_add);

  state.markSeen({
    slug: repo.slug,
    number: issue.number,
    vault_ticket_id: pullResult.ref,
    content_hash: hash,
    triage_status: "awaiting-curation",
  });

  log.info(isUpdate ? "issue updated in vault" : "issue filed to vault", {
    slug: repo.slug,
    number: issue.number,
    vault: repo.vault,
    project: repo.project,
    ticket: pullResult.ref,
    summary: triage.summary,
  });

  return isUpdate
    ? { kind: "updated", ticketRef: pullResult.ref }
    : { kind: "filed", ticketRef: pullResult.ref };
}
