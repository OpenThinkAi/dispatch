import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { listIssuesSince } from "./github.ts";
import { log } from "./log.ts";
import { State, hashIssueContent } from "./state.ts";
import { triageIssue } from "./triage.ts";
import { applyLabels } from "./sinks/labels.ts";
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

    // ── Phase B+C: curate, then orchestrate ──────────────────────────────
    await curateAndOrchestrate(cfg, state, summary);
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

  let spawnsThisTick = 0;
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
      if (repo.autopilot !== "fire") {
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
      if (spawnsThisTick >= maxSpawns) {
        log.info("orchestrator spawn cap reached; deferring fire to next tick", {
          slug: row.slug,
          number: row.number,
        });
        state.setTriageStatus(row.slug, row.number, "green-lit");
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
      appendVaultComment(
        ticketPath,
        "Curator",
        `**Curator decision:** fire (autopilot=fire, oteam assign spawned pid=${spawn.pid})\n\n${decision.reasoning}`
      );
      state.setTriageStatus(row.slug, row.number, "fired");
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

function vaultTicketPath(_state: State, vault: string, row: { vault_ticket_id: string | null }): string | null {
  if (!row.vault_ticket_id) return null;
  const vaultPath = resolveVaultPath(vault);
  if (!vaultPath) return null;
  // Search the standard ticket folders for a file matching <ID>-*.md.
  const folders = ["triage", "refined", "in-progress", "qa"];
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
  return null;
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
