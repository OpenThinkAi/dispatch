import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@openthink/dispatch";
const LAUNCHD_LABEL = "com.mattpardini.dispatch";

function currentVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(here, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  return pkg.version;
}

function fetchLatestVersion(): { ok: true; version: string } | { ok: false; error: string } {
  const r = spawnSync("npm", ["view", PACKAGE_NAME, "version"], { encoding: "utf-8" });
  if (r.status !== 0) {
    return { ok: false, error: r.stderr.trim() || `npm view exited ${r.status}` };
  }
  return { ok: true, version: r.stdout.trim() };
}

function installLatest(): { ok: true } | { ok: false; error: string } {
  const r = spawnSync("npm", ["install", "-g", `${PACKAGE_NAME}@latest`], {
    encoding: "utf-8",
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (r.status !== 0) {
    return { ok: false, error: `npm install -g exited ${r.status}` };
  }
  return { ok: true };
}

function restartLaunchd(): { ok: true } | { ok: false; error: string } {
  const uid = process.getuid?.();
  if (typeof uid !== "number") {
    return { ok: false, error: "could not determine uid (non-POSIX?)" };
  }
  const r = spawnSync(
    "launchctl",
    ["kickstart", "-k", `gui/${uid}/${LAUNCHD_LABEL}`],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) {
    // launchctl returns non-zero if the label isn't loaded; treat as
    // soft-warn rather than fatal — user may not have the daemon running.
    return { ok: false, error: r.stderr.trim() || `launchctl kickstart exited ${r.status}` };
  }
  return { ok: true };
}

export function runUpdate(): number {
  const current = currentVersion();
  process.stdout.write(`current: ${PACKAGE_NAME}@${current}\n`);

  const latest = fetchLatestVersion();
  if (!latest.ok) {
    console.error(`could not fetch latest version: ${latest.error}`);
    return 1;
  }
  process.stdout.write(`latest:  ${PACKAGE_NAME}@${latest.version}\n`);

  if (current === latest.version) {
    process.stdout.write("up to date.\n");
    return 0;
  }

  process.stdout.write(`installing ${PACKAGE_NAME}@${latest.version}…\n`);
  const installed = installLatest();
  if (!installed.ok) {
    console.error(`install failed: ${installed.error}`);
    return 1;
  }

  process.stdout.write(`restarting launchd service ${LAUNCHD_LABEL}…\n`);
  const restarted = restartLaunchd();
  if (!restarted.ok) {
    process.stdout.write(
      `note: could not restart daemon (${restarted.error}). ` +
        `Run 'launchctl kickstart -k gui/$(id -u)/${LAUNCHD_LABEL}' manually if needed.\n`,
    );
    return 0;
  }

  process.stdout.write("done.\n");
  return 0;
}
