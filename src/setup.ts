import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { configPath, loadConfig } from "./config.ts";
import { ensureStandardLabels } from "./sinks/labels.ts";

type Detected = {
  user: string;
  homeDir: string;
  bunPath: string;
  dispatchRepo: string;
  cliEntrypoint: string;
  configPath: string;
  logDir: string;
  plistPath: string;
  plistLabel: string;
};

function detect(): Detected {
  const user = userInfo().username;
  const home = homedir();
  const bunPath = which("bun") ?? join(home, ".bun/bin/bun");
  const dispatchRepo = resolve(import.meta.dir, "..");
  const cliEntrypoint = join(dispatchRepo, "src/cli.ts");
  return {
    user,
    homeDir: home,
    bunPath,
    dispatchRepo,
    cliEntrypoint,
    configPath: configPath(),
    logDir: join(home, "Library/Logs/dispatch"),
    plistPath: join(home, "Library/LaunchAgents", `com.${user}.dispatch.plist`),
    plistLabel: `com.${user}.dispatch`,
  };
}

function which(cmd: string): string | null {
  const r = spawnSync("/usr/bin/which", [cmd], { encoding: "utf-8" });
  if (r.status === 0) return r.stdout.trim() || null;
  return null;
}

function renderPlist(d: Detected, intervalSec: number): string {
  const ghPath = which("gh") ?? "/opt/homebrew/bin/gh";
  const oteamPath = which("oteam") ?? "/opt/homebrew/bin/oteam";
  const claudePath = which("claude") ?? join(d.homeDir, ".local/bin/claude");
  const pathDirs = [
    "/opt/homebrew/bin",
    join(d.homeDir, ".bun/bin"),
    join(d.homeDir, ".local/bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    dirname(ghPath),
    dirname(oteamPath),
    dirname(claudePath),
  ];
  const path = Array.from(new Set(pathDirs)).join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>            <string>${d.plistLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${d.bunPath}</string>
    <string>${d.cliEntrypoint}</string>
    <string>poll</string>
  </array>
  <key>StartInterval</key>    <integer>${intervalSec}</integer>
  <key>RunAtLoad</key>        <true/>
  <key>StandardOutPath</key>  <string>${join(d.logDir, "stdout.log")}</string>
  <key>StandardErrorPath</key><string>${join(d.logDir, "stderr.log")}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${path}</string>
    <key>HOME</key><string>${d.homeDir}</string>
    <key>DISPATCH_CONFIG</key><string>${d.configPath}</string>
  </dict>
  <key>ProcessType</key>      <string>Background</string>
  <key>LowPriorityIO</key>    <true/>
  <key>Nice</key>             <integer>5</integer>
</dict>
</plist>
`;
}

export type SetupOptions = {
  force?: boolean;
  intervalSec?: number;
  dryRun?: boolean;
  createLabels?: boolean;
};

export function runSetup(opts: SetupOptions = {}): void {
  const d = detect();
  const intervalSec = opts.intervalSec ?? 300;

  console.log("dispatch setup");
  console.log(`  user             ${d.user}`);
  console.log(`  bun              ${d.bunPath}`);
  console.log(`  repo             ${d.dispatchRepo}`);
  console.log(`  config           ${d.configPath}`);
  console.log(`  log dir          ${d.logDir}`);
  console.log(`  plist            ${d.plistPath}`);
  console.log(`  poll interval    ${intervalSec}s`);

  const tag = opts.dryRun ? "[dry-run] " : "";

  // 1. Ensure config dir + seed dispatch.toml from example if missing
  const configDir = dirname(d.configPath);
  if (!opts.dryRun) mkdirSync(configDir, { recursive: true });
  const examplePath = join(d.dispatchRepo, "dispatch.toml.example");
  if (!existsSync(d.configPath)) {
    if (existsSync(examplePath)) {
      if (!opts.dryRun) copyFileSync(examplePath, d.configPath);
      console.log(`  → ${tag}seed ${d.configPath} from dispatch.toml.example`);
    } else {
      console.log(`  ! dispatch.toml.example missing; skipping config seed`);
    }
  } else {
    console.log(`  • config already exists, leaving in place`);
  }

  // 2. Log dir
  if (!opts.dryRun) mkdirSync(d.logDir, { recursive: true });

  // 3. Plist
  if (existsSync(d.plistPath) && !opts.force) {
    console.log(`  ! plist already exists at ${d.plistPath}; pass --force to overwrite`);
  } else {
    const plist = renderPlist(d, intervalSec);
    if (!opts.dryRun) {
      mkdirSync(dirname(d.plistPath), { recursive: true });
      writeFileSync(d.plistPath, plist);
    }
    console.log(`  → ${tag}write ${d.plistPath}`);
  }

  // 4. Optional: create the standard label set on every can_label=true repo.
  if (opts.createLabels) {
    console.log("");
    console.log("Creating standard label set on can_label=true repos:");
    let cfg;
    try {
      cfg = loadConfig();
    } catch (e) {
      console.error(`  ! could not load config: ${(e as Error).message}`);
      console.error(`    --create-labels needs a valid config; fix the above and re-run.`);
      return;
    }
    const targets = cfg.repos.filter(r => r.can_label);
    const skipped = cfg.repos.filter(r => !r.can_label);
    for (const repo of skipped) {
      console.log(`  • ${repo.slug.padEnd(40)} skipped (can_label=false)`);
    }
    if (targets.length === 0) {
      console.log(`  (no can_label=true repos in config)`);
    }
    for (const repo of targets) {
      if (opts.dryRun) {
        console.log(`  → [dry-run] would ensure 11 standard labels on ${repo.slug}`);
        continue;
      }
      try {
        const r = ensureStandardLabels(repo.slug);
        const parts = [
          `${r.created.length} created`,
          `${r.existing.length} already present`,
        ];
        if (r.failed.length > 0) parts.push(`${r.failed.length} failed`);
        console.log(`  → ${repo.slug.padEnd(40)} ${parts.join(", ")}`);
        if (r.created.length > 0) {
          console.log(`      created: ${r.created.join(", ")}`);
        }
        for (const f of r.failed) {
          console.log(`      ! ${f.name}: ${f.error}`);
        }
      } catch (e) {
        console.error(`  ! ${repo.slug.padEnd(40)} ${(e as Error).message}`);
      }
    }
  }

  // 5. PATH check on shim
  const shimTarget = join(d.dispatchRepo, "bin/dispatch");
  console.log("");
  console.log("Next:");
  console.log(`  1. Edit your config:           $EDITOR ${d.configPath}`);
  console.log(`  2. Make sure 'dispatch' is on PATH (symlink the shim):`);
  console.log(`         ln -s ${shimTarget} ~/.local/bin/dispatch`);
  console.log(`  3. Make sure Claude Code is logged in (or ANTHROPIC_API_KEY is set), then verify:`);
  console.log(`         claude /login                  # if not already logged in`);
  console.log(`         dispatch config validate`);
  console.log(`         dispatch poll                  # one-shot run`);
  console.log(`  4. Bootstrap the launchd timer:`);
  console.log(`         launchctl bootstrap gui/$(id -u) ${d.plistPath}`);
  console.log(`  5. Verify it's running:`);
  console.log(`         launchctl list | grep dispatch`);
  console.log(`         tail -f ${join(d.logDir, "stdout.log")}`);
  console.log("");
  console.log("To stop later:  launchctl bootout gui/$(id -u)/" + d.plistLabel);
}
