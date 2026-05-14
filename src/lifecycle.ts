import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { log } from "./log.ts";
import { matchLifecycle } from "./rules.ts";
import { State } from "./state.ts";
import { walkVaultTickets } from "./vault-read.ts";
import type { ConfigV2, LifecycleEvent, LifecycleRule } from "./types.ts";

export type LifecycleTickSummary = {
  tickets_scanned: number;
  transitions: number;
  rules_fired: number;
  rules_skipped_dedup: number;
  errors: number;
};

/**
 * Per-tick vault-state scan + lifecycle rule execution.
 *
 * 1. Enumerate every vault referenced by any ingest rule or [default].
 * 2. For each vault, walk tickets and snapshot frontmatter state into
 *    `v2_ticket_state`. Detect transitions vs the prior snapshot.
 * 3. For each ticket (transitioned or not), build a LifecycleEvent and
 *    match it against the configured `[[rule.lifecycle]]` rules.
 * 4. For each matched rule that hasn't fired for the current state-entry,
 *    execute the rule's action and record the firing in
 *    `v2_lifecycle_fired` so it won't fire again on the next tick.
 *
 * Actions:
 *   - `do.spawn = "<command>"`  → detached spawn, argv split on whitespace
 *     (no shell:true; complex shell forms must use a wrapper script)
 *   - `do.transition = "<new>"` → rewrite the ticket's `state:` frontmatter
 *     field (file is NOT moved between lifecycle folders; that's still on
 *     the oteam side of the workspace)
 *   - `do.notify = true`        → macOS notification (best-effort)
 */
export function runLifecycle(cfg: ConfigV2, state: State): LifecycleTickSummary {
  const summary: LifecycleTickSummary = {
    tickets_scanned: 0,
    transitions: 0,
    rules_fired: 0,
    rules_skipped_dedup: 0,
    errors: 0,
  };

  if (cfg.lifecycle_rules.length === 0) {
    return summary;
  }

  const vaults = vaultsInConfig(cfg);
  for (const vault of vaults) {
    let tickets;
    try {
      tickets = walkVaultTickets(vault);
    } catch (e) {
      log.warn("v2 lifecycle: vault walk failed", { vault, error: (e as Error).message });
      summary.errors++;
      continue;
    }

    for (const t of tickets) {
      summary.tickets_scanned++;
      const upsert = state.upsertTicketState({
        ticket_id: t.ticket_id,
        vault,
        project: t.project,
        ticket_type: t.ticket_type,
        state: t.state,
      });
      if (upsert.transitioned) summary.transitions++;

      const event: LifecycleEvent = {
        ticket_id: t.ticket_id,
        vault,
        project: t.project,
        type: t.ticket_type,
        from_state: upsert.transitioned ? upsert.from_state : null,
        to_state: t.state,
        stuck_for_minutes: minutesSince(upsert.state_entered_at),
      };

      const matched = matchLifecycle(event, cfg.lifecycle_rules);
      for (const rule of matched) {
        if (state.lifecycleHasFired(t.ticket_id, rule.name, upsert.state_entered_at)) {
          summary.rules_skipped_dedup++;
          continue;
        }
        const outcome = executeLifecycleAction(rule, t.path, cfg.defaults.log_dir);
        state.markLifecycleFired({
          ticket_id: t.ticket_id,
          rule_name: rule.name,
          state_entered_at: upsert.state_entered_at,
          outcome,
        });
        summary.rules_fired++;
        log.info("v2 lifecycle rule fired", {
          rule: rule.name,
          ticket: t.ticket_id,
          vault,
          state: t.state,
          outcome,
        });
      }
    }
  }

  return summary;
}

function vaultsInConfig(cfg: ConfigV2): string[] {
  const set = new Set<string>();
  for (const rule of cfg.ingest_rules) {
    if (rule.do.vault) set.add(rule.do.vault);
  }
  if (cfg.default_action?.vault) set.add(cfg.default_action.vault);
  return [...set];
}

function minutesSince(iso: string): number {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 0;
  const ms = Date.now() - then;
  if (ms < 0) return 0;
  return Math.floor(ms / 60_000);
}

/**
 * Execute a single lifecycle rule's action against the ticket file. Returns
 * an outcome string the caller records for audit (`spawned` / `transitioned`
 * / `notified` / `error:<msg>`). Failures are non-fatal — the lifecycle scan
 * continues; the rule is still recorded as fired so we don't infinite-loop
 * on the same broken action.
 */
function executeLifecycleAction(rule: LifecycleRule, ticketPath: string, logDir: string): string {
  const action = rule.do;
  if (action.spawn) {
    const r = spawnLifecycle(action.spawn, logDir);
    if (!r.ok) return `error: spawn failed (${r.error})`;
    return `spawned pid=${r.pid}`;
  }
  if (action.transition) {
    const r = transitionTicketState(ticketPath, action.transition);
    if (!r.ok) return `error: transition failed (${r.error})`;
    return `transitioned to ${action.transition}`;
  }
  if (action.notify) {
    notify({
      title: `dispatch lifecycle: ${rule.name}`,
      message: ticketPath.split("/").pop() ?? ticketPath,
    });
    return "notified";
  }
  return "error: no action configured";
}

/**
 * Spawn a `do.spawn` command. argv is split on whitespace ONLY — never
 * invoked via a shell. Operators wanting shell features (pipes, redirects,
 * env-var expansion, &&) must put them in a wrapper script and reference
 * the script directly. The strict argv split prevents an operator config
 * with backticks / && / $(...) from silently introducing command injection
 * via untrusted ticket content embedded in the spawn string.
 */
function spawnLifecycle(
  cmd: string,
  logDir: string,
): { ok: true; pid: number } | { ok: false; error: string } {
  const argv = cmd.trim().split(/\s+/).filter(Boolean);
  if (argv.length === 0) return { ok: false, error: "empty do.spawn command" };
  const [exe, ...args] = argv;
  try {
    const child = spawn(exe, args, {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.unref();
    if (typeof child.pid !== "number") return { ok: false, error: "no pid returned by spawn" };
    log.info("v2 lifecycle spawn", { exe, args, pid: child.pid, log_dir: logDir });
    return { ok: true, pid: child.pid };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Rewrite the `state:` frontmatter field in place. Doesn't move the file
 * between lifecycle folders — that's oteam's responsibility on the workspace
 * side. If the existing file has no `state:` line this fails noisily.
 */
function transitionTicketState(
  ticketPath: string,
  newState: string,
): { ok: true } | { ok: false; error: string } {
  if (!existsSync(ticketPath)) return { ok: false, error: `ticket file missing: ${ticketPath}` };
  const raw = readFileSync(ticketPath, "utf-8");
  const updated = raw.replace(/^state:\s*.+$/m, `state: ${newState}`);
  if (updated === raw) return { ok: false, error: "no state: line found in frontmatter" };
  writeFileSync(ticketPath, updated);
  return { ok: true };
}

function notify(args: { title: string; subtitle?: string; message: string }): void {
  if (process.platform !== "darwin") return;
  const script = `display notification ${q(args.message)} with title ${q(args.title)}${
    args.subtitle ? ` subtitle ${q(args.subtitle)}` : ""
  }`;
  spawnSync("osascript", ["-e", script], { stdio: "ignore" });
}

function q(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
