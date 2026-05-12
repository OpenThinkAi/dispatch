import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, loadConfig } from "./config.ts";
import { curateTicket } from "./curator.ts";
import { buildProjectIndex, findMissingProjects } from "./sinks/vault.ts";
import { triageIssue } from "./triage.ts";
import type { Config, GitHubIssue } from "./types.ts";

type StageOk = { ok: true; detail: string; cost_usd?: number };
type StageFail = { ok: false; detail: string; cost_usd?: number };
type StageSkip = { skip: true; detail: string };
type StageResult = StageOk | StageFail | StageSkip;
type Stage = { label: string; result: StageResult };

function which(cmd: string): string | null {
  const r = spawnSync("/usr/bin/which", [cmd], { encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

function runCmd(cmd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: "utf-8" });
  if (r.error) return { ok: false, stdout: "", stderr: r.error.message };
  return { ok: r.status === 0, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function checkTools(): StageResult {
  const gh = which("gh");
  const oteam = which("oteam");
  const missing: string[] = [];
  if (!gh) missing.push("gh");
  if (!oteam) missing.push("oteam");
  if (missing.length > 0) {
    return {
      ok: false,
      detail: `not on PATH: ${missing.join(", ")} — re-run \`dispatch setup --force\` after fixing PATH`,
    };
  }
  const ghVer = runCmd("gh", ["--version"]);
  const oteamVer = runCmd("oteam", ["--version"]);
  const ghLine = ghVer.stdout.split("\n")[0]?.trim() || "gh (unknown version)";
  const oteamLine = oteamVer.stdout.split("\n")[0]?.trim() || "oteam (unknown version)";
  return { ok: true, detail: `${ghLine}; ${oteamLine}` };
}

function checkGhAuth(): StageResult {
  const r = runCmd("gh", ["auth", "status"]);
  if (!r.ok) {
    const summary = (r.stderr || r.stdout).split("\n").find(l => l.trim()) ?? "gh auth status failed";
    return { ok: false, detail: summary.trim() };
  }
  const userLine = (r.stderr || r.stdout)
    .split("\n")
    .map(l => l.trim())
    .find(l => /Logged in to|account /i.test(l));
  return { ok: true, detail: userLine ?? "gh auth status: ok" };
}

function checkConfigLoad(): { result: StageResult; cfg: Config | null } {
  try {
    const cfg = loadConfig();
    return {
      result: { ok: true, detail: `${cfg.repos.length} repo(s); config at ${cfg.defaults.config_path}` },
      cfg,
    };
  } catch (e) {
    return {
      result: { ok: false, detail: (e as Error).message.split("\n")[0] ?? "config load failed" },
      cfg: null,
    };
  }
}

function checkProjectIndex(cfg: Config | null): StageResult {
  if (!cfg) return { skip: true, detail: "skipped (config did not load)" };
  const { index, errors } = buildProjectIndex(cfg);
  const missing = findMissingProjects(cfg, index);
  if (errors.length > 0) {
    const first = errors[0]!;
    return { ok: false, detail: `vault unavailable: ${first.vault} — ${first.reason}` };
  }
  if (missing.length > 0) {
    const list = missing.map(r => `${r.vault}/${r.project}`).join(", ");
    return { ok: false, detail: `missing project(s): ${list}` };
  }
  const vaults = Array.from(index.keys()).join(", ") || "(none)";
  return { ok: true, detail: `${index.size} vault(s) reachable [${vaults}], no missing projects` };
}

function syntheticIssue(slug: string): GitHubIssue {
  return {
    url: `https://api.github.com/repos/${slug}/issues/0`,
    html_url: `https://github.com/${slug}/issues/0`,
    number: 0,
    title: "Smoketest: synthetic issue — please ignore",
    body:
      "This is a synthetic issue used by `dispatch smoketest` to verify the triage model is reachable and returning a parseable JSON object. " +
      "It is never filed to a vault and never posted to GitHub. The expected triage classification is a benign, low-priority feature/docs item with no security flag.",
    state: "open",
    labels: [],
    assignees: [],
    user: { login: "dispatch-smoketest" },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

const SYNTHETIC_TICKET = `---
id: AGT-SMOKETEST
title: "Smoketest: synthetic ticket — please ignore"
state: triage
team: product
created: 2026-01-01
updated: 2026-01-01
project: triage-inbox
repo: SMOKETEST/synthetic
linked-github: https://github.com/SMOKETEST/synthetic/issues/0
priority: low
labels: [docs]
source: { type: github, url: "https://github.com/SMOKETEST/synthetic/issues/0", id: "SMOKETEST/synthetic#0", fetched-at: "2026-01-01T00:00:00Z" }
---

## Problem Statement

Synthetic ticket used by \`dispatch smoketest\` to verify the curator model is reachable and returning a parseable decision. It is never written to a real vault and the curator's decision is discarded after validation.

## Acceptance Criteria

1. The curator returns a JSON decision with a known action (fire, gh-comment, or hold).
2. The smoketest does not write to any production vault or modify any GitHub issue.

## Comments
`;

async function checkTriageSdk(cfg: Config | null): Promise<StageResult> {
  if (!cfg) return { skip: true, detail: "skipped (config did not load)" };
  const repo = cfg.repos[0];
  if (!repo) return { skip: true, detail: "skipped (no repos in config)" };
  const issue = syntheticIssue(repo.slug);
  try {
    const { result: r, cost_usd } = await triageIssue({
      issue,
      repo,
      model: cfg.defaults.triage_model,
      bodyTruncate: cfg.defaults.body_truncate_chars,
    });
    if (typeof r.summary !== "string" || r.summary.length === 0) {
      return { ok: false, detail: `${cfg.defaults.triage_model}: empty summary` };
    }
    if (!Array.isArray(r.labels_to_add)) {
      return { ok: false, detail: `${cfg.defaults.triage_model}: labels_to_add not an array` };
    }
    const detail = `${cfg.defaults.triage_model}: summary="${r.summary.slice(0, 60)}..."; labels=${JSON.stringify(r.labels_to_add)}`;
    return cost_usd !== null
      ? { ok: true, detail, cost_usd }
      : { ok: true, detail };
  } catch (e) {
    return { ok: false, detail: `${cfg.defaults.triage_model}: ${(e as Error).message.split("\n")[0]}` };
  }
}

async function checkCuratorSdk(cfg: Config | null): Promise<StageResult> {
  if (!cfg) return { skip: true, detail: "skipped (config did not load)" };
  const repo = cfg.repos[0];
  if (!repo) return { skip: true, detail: "skipped (no repos in config)" };
  const dir = mkdtempSync(join(tmpdir(), "dispatch-smoketest-"));
  const ticketPath = join(dir, "AGT-SMOKETEST-synthetic.md");
  writeFileSync(ticketPath, SYNTHETIC_TICKET);
  try {
    const { decision, cost_usd } = await curateTicket({
      ticketBodyPath: ticketPath,
      repo,
      recentVaultTickets: [],
      curatorModel: cfg.defaults.curator_model,
      perCallMaxBudgetUsd: cfg.defaults.per_call_max_budget_usd,
    });
    const detail = `${cfg.defaults.curator_model}: action=${decision.action}`;
    return cost_usd !== null
      ? { ok: true, detail, cost_usd }
      : { ok: true, detail };
  } catch (e) {
    return { ok: false, detail: `${cfg.defaults.curator_model}: ${(e as Error).message.split("\n")[0]}` };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function statusGlyph(r: StageResult): string {
  if ("skip" in r) return "·";
  return r.ok ? "✓" : "✗";
}

function renderReport(stages: Stage[]): { passed: number; failed: number; skipped: number; totalCost: number } {
  const labelWidth = Math.max(...stages.map(s => s.label.length));
  let passed = 0, failed = 0, skipped = 0, totalCost = 0;
  console.log("");
  for (const s of stages) {
    const glyph = statusGlyph(s.result);
    const cost = "ok" in s.result && s.result.ok && typeof s.result.cost_usd === "number"
      ? `  ($${s.result.cost_usd.toFixed(4)})`
      : "";
    console.log(`  ${glyph} ${s.label.padEnd(labelWidth)}  ${s.result.detail}${cost}`);
    if ("skip" in s.result) skipped += 1;
    else if (s.result.ok) {
      passed += 1;
      if (typeof s.result.cost_usd === "number") totalCost += s.result.cost_usd;
    } else failed += 1;
  }
  console.log("");
  if (totalCost > 0) console.log(`  total cost:  $${totalCost.toFixed(4)}`);
  const verdict = failed > 0 ? "FAIL" : "PASS";
  console.log(`  result:      ${verdict} (${passed} passed, ${failed} failed, ${skipped} skipped)`);
  console.log("");
  return { passed, failed, skipped, totalCost };
}

/**
 * Exercise every external integration the dispatch pipeline depends on
 * (gh, oteam, Claude SDK triage + curator) against synthetic in-memory
 * fixtures. Never writes to any vault and never modifies any GitHub
 * issue. Returns 0 on all-green, 1 on any failure.
 *
 * Coverage gap (acknowledged): `oteam pull github` and `gh issue edit
 * --add-label` are not exercised — both have unavoidable side effects.
 * For full vault-write verification, run `dispatch process <url>`
 * against a known issue with a scratch vault.
 */
export async function runSmoketest(): Promise<number> {
  console.log(`dispatch smoketest`);
  console.log(`  config:      ${configPath()}`);

  const stages: Stage[] = [];

  stages.push({ label: "tools on PATH", result: checkTools() });
  stages.push({ label: "gh auth", result: checkGhAuth() });

  const { result: cfgResult, cfg } = checkConfigLoad();
  stages.push({ label: "config load", result: cfgResult });
  stages.push({ label: "project index", result: checkProjectIndex(cfg) });
  stages.push({ label: "triage SDK", result: await checkTriageSdk(cfg) });
  stages.push({ label: "curator SDK", result: await checkCuratorSdk(cfg) });

  const { failed } = renderReport(stages);
  if (failed > 0) {
    console.error(
      "  next: read the failing stage(s); rerun after fixing. For the SDK stages, " +
      "make sure Claude Code is logged in (`claude /login`) or `ANTHROPIC_API_KEY` is set."
    );
  }
  return failed > 0 ? 1 : 0;
}
