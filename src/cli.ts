#!/usr/bin/env bun
import { loadConfig, configPath, repoBySlug } from "./config.ts";
import { loadConfigV2 } from "./config-v2.ts";
import { pollV2DryRun } from "./poll-v2.ts";
import { log } from "./log.ts";
import { fetchIssue, parseIssueRef } from "./github.ts";
import { pollOnce, processIssue } from "./poll.ts";
import { runSetup } from "./setup.ts";
import { runSmoketest } from "./smoketest.ts";
import { State } from "./state.ts";
import { runView } from "./view.ts";
import { runUpdate } from "./update.ts";

const HELP = `dispatch — GitHub-issue ingestion + triage router for oteam vaults

Usage:
  dispatch <command> [args]

Commands:
  poll                       One-shot: ingest, curate, orchestrate
                             --v2 --dry-run scans the spike sources+rules pipeline and prints
                             what would happen (no triage, no sink writes, no archive)
  watch [--interval SEC]     Foreground loop calling poll (default 300s); for dev/debug
  process <url-or-ref>       Manually ingest one issue (does NOT trigger curation)
  smoketest                  Exercise every external integration (gh, oteam, Claude SDK
                             triage + curator) against a synthetic fixture. No vault
                             writes, no GH issue mutations. Run after a model upgrade,
                             oteam version bump, or \`dispatch setup --force\`.
  config validate            Parse config + cross-check vault projects; exit non-zero on failure
                             --v2 validates the spike sources+rules schema instead (structural only)
  config path                Print resolved config path
  state show                 Print cursors, recent processed issues, recent curator decisions
  view [--views-root=PATH] [--shell=tab|app]
                             Open a browser-based live event feed of dispatch + oteam telemetry.
                             --views-root points at a custom views directory containing your own
                             log-stream.tsx (see README "Custom views"). --shell=app opens a
                             chromeless Chrome --app window instead of a regular tab.
  update                     Self-update to the latest @openthink/dispatch on npm; restart the daemon
  setup [--force] [--interval SEC] [--dry-run] [--create-labels]
                             Detect machine, write the launchd plist, and seed config.
                             --create-labels also creates the standard 11-label
                             set on every can_label=true repo (idempotent).
  help                       Show this message

Environment:
  DISPATCH_CONFIG            Override config path (default ~/.config/dispatch/dispatch.toml)
  ANTHROPIC_API_KEY          Used by triage + curator if Claude Code isn't logged in
  DISPATCH_DEBUG=1           Verbose logging
  DISPATCH_VIEWS_ROOT        Custom views directory for \`dispatch view\` (fallback for --views-root)
  DISPATCH_VIEW_SHELL=app    Open \`dispatch view\` in a chromeless Chrome --app window (fallback for --shell)
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
      const args = sub ? [sub, ...rest] : rest;
      if (args.includes("--v2")) {
        if (!args.includes("--dry-run")) {
          console.error("`dispatch poll --v2` requires --dry-run (v2 execution not implemented yet).");
          return 2;
        }
        return await pollV2DryRun();
      }
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
        if (rest.includes("--v2")) {
          try {
            const cfgV2 = loadConfigV2(configPath());
            console.log(
              `OK (v2 structural): ${cfgV2.sources.length} sources, ` +
                `${cfgV2.ingest_rules.length} ingest rules, ` +
                `${cfgV2.lifecycle_rules.length} lifecycle rules` +
                (cfgV2.default_action ? ", [default] present" : ", no [default]"),
            );
            return 0;
          } catch (e) {
            console.error((e as Error).message);
            return 1;
          }
        }
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
      const args = [sub, ...rest];
      const force = args.includes("--force");
      const dryRun = args.includes("--dry-run");
      const createLabels = args.includes("--create-labels");
      const intervalArg = args.find(a => a?.startsWith("--interval="));
      const intervalSec = intervalArg ? Number(intervalArg.split("=")[1]) : 300;
      runSetup({ force, intervalSec, dryRun, createLabels });
      return 0;
    }

    case "smoketest": {
      return runSmoketest();
    }

    case "view": {
      const args = sub ? [sub, ...rest] : rest;
      let viewsRoot: string | undefined;
      let shell: "tab" | "app" | undefined;
      for (const a of args) {
        if (a.startsWith("--views-root=")) {
          viewsRoot = a.slice("--views-root=".length);
          continue;
        }
        if (a.startsWith("--shell=")) {
          const v = a.slice("--shell=".length);
          if (v !== "tab" && v !== "app") {
            console.error(`invalid --shell value: ${v} (expected "tab" or "app")`);
            return 2;
          }
          shell = v;
          continue;
        }
        console.error(
          `unknown argument for \`dispatch view\`: ${a}\n` +
            `expected --views-root=PATH and/or --shell=tab|app (use \`=\`, not space)`,
        );
        return 2;
      }
      return runView({ viewsRoot, shell });
    }

    case "update": {
      return runUpdate();
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
