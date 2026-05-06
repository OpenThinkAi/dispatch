import { listIssuesSince } from "./github.ts";
import { log } from "./log.ts";
import { State, hashIssueContent } from "./state.ts";
import { triageIssue } from "./triage.ts";
import { applyLabels } from "./sinks/labels.ts";
import { holdForSecurityReview } from "./sinks/security.ts";
import { ensureProject, pullIntoVault } from "./sinks/vault.ts";
import type { Config, GitHubIssue, ProcessOutcome, RepoConfig } from "./types.ts";

export async function pollOnce(cfg: Config): Promise<{ processed: number; errors: number }> {
  const state = new State(cfg.defaults.state_dir);
  let processed = 0;
  let errors = 0;

  try {
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
          const outcome = await processIssue({ issue, repo, cfg, state });
          processed += 1;
          if (outcome.kind === "error") errors += 1;
          if (issue.updated_at > maxUpdated) maxUpdated = issue.updated_at;
        }
        state.setCursor(repo.slug, maxUpdated);
      } catch (e) {
        errors += 1;
        log.error("repo poll failed", { slug: repo.slug, error: (e as Error).message });
      }
    }
  } finally {
    state.close();
  }

  log.info("poll complete", { processed, errors });
  return { processed, errors };
}

export async function processIssue(args: {
  issue: GitHubIssue;
  repo: RepoConfig;
  cfg: Config;
  state: State;
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
    });
    return { kind: "security-held", flag: triage.security_flag };
  }

  try {
    ensureProject(repo.vault, repo.project);
  } catch (e) {
    log.error("project ensure failed", {
      slug: repo.slug,
      project: repo.project,
      vault: repo.vault,
      error: (e as Error).message,
    });
    return { kind: "error", error: (e as Error).message };
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
