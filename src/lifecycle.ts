import { spawn, spawnSync } from "node:child_process";
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
 * 1. Enumerate every vault referenced by any ingest rule, [default], or a
 *    `when.vault` on a lifecycle rule.
 * 2. For each vault, walk tickets and snapshot frontmatter state into
 *    `v2_ticket_state`. Detect transitions vs the prior snapshot.
 * 3. For each ticket, build a LifecycleEvent and match it against the
 *    configured `[[rule.lifecycle]]` rules.
 * 4. For each matched rule that hasn't fired for the current state-entry,
 *    execute the rule's action and record the firing in
 *    `v2_lifecycle_fired` so it won't fire again on the next tick.
 *
 * Actions:
 *   - `do.spawn = "<cmd>"`   → detached spawn, argv split on whitespace.
 *     The ticket's absolute path is appended as the final argv element so
 *     the spawned command always has its target.
 *   - `do.notify = true`     → best-effort macOS notification.
 *
 * Vault state mutations live on the oteam side of the workspace — there is
 * no `do.transition` action here. Phase advances are expressed by spawning
 * an orchestrator command that updates state itself.
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
  if (vaults.length === 0) {
    log.warn("v2 lifecycle: lifecycle rules configured but no vaults referenced anywhere", {
      lifecycle_rules: cfg.lifecycle_rules.length,
    });
    return summary;
  }

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
        const outcome = executeLifecycleAction(rule, t.path);
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
  for (const rule of cfg.lifecycle_rules) {
    if (rule.when.vault) set.add(rule.when.vault);
  }
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
 * Execute a single lifecycle rule's action against the ticket. Returns an
 * outcome string the caller records for audit. Failures are non-fatal — the
 * scan continues; the rule is still recorded as fired so a broken action
 * doesn't infinite-loop on the same state entry.
 */
function executeLifecycleAction(rule: LifecycleRule, ticketPath: string): string {
  const action = rule.do;
  if (action.spawn) {
    const r = spawnLifecycle(action.spawn, ticketPath);
    if (!r.ok) return `error: ${r.error}`;
    return `spawned pid=${r.pid}`;
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
 * Spawn a `do.spawn` command with the ticket path appended as the final
 * argv element. argv is split on whitespace ONLY — never invoked via a
 * shell. Operators wanting shell features (pipes, redirects, env-var
 * expansion, &&, quoted args with spaces) must put them in a wrapper
 * script and reference the script directly. The strict argv split
 * prevents an operator config that ever interpolates ticket content
 * from silently introducing command injection.
 */
function spawnLifecycle(
  cmd: string,
  ticketPath: string,
): { ok: true; pid: number } | { ok: false; error: string } {
  const argv = cmd.trim().split(/\s+/).filter(Boolean);
  if (argv.length === 0) return { ok: false, error: "empty do.spawn command" };
  const [exe, ...args] = argv;
  args.push(ticketPath);
  try {
    const child = spawn(exe, args, {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.unref();
    if (typeof child.pid !== "number") return { ok: false, error: "no pid returned by spawn" };
    log.info("v2 lifecycle spawn", { exe, args, pid: child.pid, ticket_path: ticketPath });
    return { ok: true, pid: child.pid };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return {
        ok: false,
        error: `executable not found: "${exe}" (do.spawn splits on whitespace only; use a wrapper script for quoted args)`,
      };
    }
    return { ok: false, error: err.message };
  }
}

/**
 * Best-effort macOS notification. Values are passed via env vars and read
 * with osascript's `system attribute` so we never embed user-controlled
 * strings into AppleScript literals — AppleScript has no `\"` escape, so
 * any `q()`-style backslash escaping is implementation-specific and would
 * be exploitable if a ticket filename ever contained a quote.
 */
function notify(args: { title: string; message: string }): void {
  if (process.platform !== "darwin") return;
  const script =
    `display notification (system attribute "NOTIFY_MSG") ` +
    `with title (system attribute "NOTIFY_TITLE")`;
  spawnSync("osascript", ["-e", script], {
    stdio: "ignore",
    env: { ...process.env, NOTIFY_MSG: args.message, NOTIFY_TITLE: args.title },
  });
}
