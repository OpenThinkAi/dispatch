#!/usr/bin/env bun
import { loadConfig, configPath, repoBySlug } from "./config.ts";
import { log } from "./log.ts";
import { fetchIssue, parseIssueRef } from "./github.ts";
import { pollOnce, processIssue } from "./poll.ts";
import { runSetup } from "./setup.ts";
import { State } from "./state.ts";
import { runView } from "./view.ts";

const HELP = `dispatch — GitHub-issue ingestion + triage router for oteam vaults

Usage:
  dispatch <command> [args]

Commands:
  poll                       One-shot: ingest, curate, orchestrate
  watch [--interval SEC]     Foreground loop calling poll (default 300s); for dev/debug
  process <url-or-ref>       Manually ingest one issue (does NOT trigger curation)
  config validate            Parse config + cross-check vault projects; exit non-zero on failure
  config path                Print resolved config path
  state show                 Print cursors, recent processed issues, recent curator decisions
  view                       Open a browser-based live event feed of dispatch + oteam telemetry
  setup [--force] [--interval SEC] [--dry-run]
                             Detect machine, write the launchd plist, and seed config
  help                       Show this message

Environment:
  DISPATCH_CONFIG            Override config path (default ~/.config/dispatch/dispatch.toml)
  ANTHROPIC_API_KEY          Used by triage + curator if Claude Code isn't logged in
  DISPATCH_DEBUG=1           Verbose logging
`;

async function main(argv: string[]): Promise<number> {
  const [cmd, sub, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(HELP);
      return 0;

    case "poll": {
      const cfg = loadConfig();
      const r = await pollOnce(cfg);
      return r.errors > 0 ? 1 : 0;
    }

    case "watch": {
      const cfg = loadConfig();
      const intervalArg = rest.find(a => a.startsWith("--interval="));
      const intervalSec = intervalArg
        ? Number(intervalArg.split("=")[1])
        : cfg.defaults.poll_interval_minutes * 60;
      log.info("watch starting", { interval_sec: intervalSec });
      while (true) {
        try {
          await pollOnce(cfg);
        } catch (e) {
          log.error("watch tick failed", { error: (e as Error).message });
        }
        await sleep(intervalSec * 1000);
      }
    }

    case "process": {
      if (!sub) { console.error("usage: dispatch process <url-or-ref>"); return 2; }
      const cfg = loadConfig();
      const { slug } = parseIssueRef(sub);
      const repo = repoBySlug(cfg, slug);
      if (!repo) {
        console.error(`no repo config for ${slug}; add it to ${configPath()}`);
        return 2;
      }
      const issue = fetchIssue(sub);
      const state = new State(cfg.defaults.state_dir);
      try {
        const outcome = await processIssue({ issue, repo, cfg, state });
        console.log(JSON.stringify(outcome, null, 2));
        return outcome.kind === "error" ? 1 : 0;
      } finally {
        state.close();
      }
    }

    case "config": {
      if (sub === "validate") {
        let cfg;
        try {
          cfg = loadConfig();
        } catch (e) {
          console.error((e as Error).message);
          return 1;
        }
        const skipVaults = rest.includes("--no-vault-check");
        if (skipVaults) {
          console.log(`OK (structural only): ${cfg.repos.length} repos, config at ${cfg.defaults.config_path}`);
          return 0;
        }
        const { buildProjectIndex, findMissingProjects } = await import("./sinks/vault.ts");
        const { index, errors: idxErrors } = buildProjectIndex(cfg);
        for (const e of idxErrors) console.error(`vault unavailable: ${e.vault} — ${e.reason}`);
        const missing = findMissingProjects(cfg, index);
        if (missing.length > 0) {
          console.error(`Missing projects (${missing.length}):`);
          for (const r of missing) console.error(`  ${r.slug.padEnd(48)}  vault=${r.vault}  project=${r.project}`);
          console.error("");
          console.error("Create them with:  oteam project init <project> --vault <vault> --no-edit");
          return 1;
        }
        if (idxErrors.length > 0) return 1;
        console.log(`OK: ${cfg.repos.length} repos, config at ${cfg.defaults.config_path}`);
        return 0;
      }
      if (sub === "path") {
        console.log(configPath());
        return 0;
      }
      console.error("usage: dispatch config <validate [--no-vault-check] | path>");
      return 2;
    }

    case "state": {
      if (sub === "show") {
        const cfg = loadConfig();
        const state = new State(cfg.defaults.state_dir);
        try {
          const cursors = state.allCursors();
          const recent = state.recentSeen(20);
          const decisions = state.recentCuratorDecisions(10);
          console.log("Cursors:");
          for (const [slug, ts] of Object.entries(cursors)) {
            console.log(`  ${slug.padEnd(50)}  ${ts}`);
          }
          console.log("\nMost recent processed:");
          for (const r of recent) {
            const status = (r.triage_status ?? "?").padEnd(18);
            console.log(`  ${r.last_processed_at}  ${status}  ${r.slug}#${r.number}  ${r.vault_ticket_id ?? "(held)"}`);
          }
          console.log("\nRecent curator decisions:");
          for (const d of decisions) {
            console.log(`  ${d.decided_at}  ${d.decision.padEnd(11)}  ${d.slug}#${d.number}  $${(d.cost_usd ?? 0).toFixed(4)}`);
            console.log(`    ${d.reasoning.split("\n")[0].slice(0, 140)}`);
          }
          return 0;
        } finally {
          state.close();
        }
      }
      console.error("usage: dispatch state <show>");
      return 2;
    }

    case "setup": {
      const force = rest.includes("--force") || sub === "--force";
      const dryRun = rest.includes("--dry-run") || sub === "--dry-run";
      const intervalArg = [sub, ...rest].find(a => a?.startsWith("--interval="));
      const intervalSec = intervalArg ? Number(intervalArg.split("=")[1]) : 300;
      runSetup({ force, intervalSec, dryRun });
      return 0;
    }

    case "view": {
      return runView();
    }

    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      return 2;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

main(process.argv.slice(2)).then(
  code => process.exit(code),
  e => {
    console.error("fatal:", (e as Error).message);
    process.exit(1);
  }
);
