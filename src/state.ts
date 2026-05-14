import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { CuratorAction, TriageStatus } from "./types.ts";

export type SeenRow = {
  slug: string;
  number: number;
  vault_ticket_id: string | null;
  content_hash: string;
  triage_status: TriageStatus;
  first_processed_at: string;
  last_processed_at: string;
  /** Vault ticket `state:` field at the time dispatch last fired
   * `oteam assign` for this row. NULL until the first fire. Used by the
   * drive loop to detect phase advances (current state != last_fired_for_state). */
  last_fired_for_state: string | null;
  /** PID of the most recent `oteam assign` spawn dispatch issued for this
   * row. NULL until the first spawn. The drive loop checks this with
   * `kill -0` before firing the next phase: if the prior process is still
   * alive (e.g. spike auto-proceeded into in-progress mid-process), dispatch
   * must NOT spawn a second concurrent agent. */
  spawned_pid: number | null;
  /** ISO timestamp of when `spawned_pid` was recorded. Used by future
   * follow-ups to bound trust in the PID against process-id reuse on long-
   * running daemons; not consulted by the current liveness check. */
  spawned_at: string | null;
};

export type V2SeenRow = {
  source_name: string;
  external_id: string;
  content_hash: string;
  vault_ticket_id: string | null;
  status: string;
  plan_via: string | null;
  plan_rule_name: string | null;
  /** Latest curator action for this row: "fire" | "gh-comment" | "hold" | null. */
  curator_decision: string | null;
  /** PID of the most recent `oteam assign` spawn for this row (fire/drive autopilot). */
  spawned_pid: number | null;
  spawned_at: string | null;
  first_seen_at: string;
  last_processed_at: string;
};

export type V2TicketStateRow = {
  ticket_id: string;
  vault: string;
  project: string | null;
  ticket_type: string | null;
  state: string;
  state_entered_at: string;
  last_seen_at: string;
};

export type CuratorDecisionRow = {
  slug: string;
  number: number;
  decided_at: string;
  decision: CuratorAction;
  reasoning: string;
  related_tickets: string;     // JSON array
  related_gh_issues: string;   // JSON array
  cost_usd: number | null;
};

export class State {
  private db: Database;
  private cursorsPath: string;
  private cursors: Record<string, string>;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.db = new Database(join(stateDir, "seen.sqlite"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS seen (
        slug TEXT NOT NULL,
        number INTEGER NOT NULL,
        vault_ticket_id TEXT,
        content_hash TEXT NOT NULL,
        first_processed_at TEXT NOT NULL,
        last_processed_at TEXT NOT NULL,
        PRIMARY KEY (slug, number)
      );
      CREATE INDEX IF NOT EXISTS seen_last_idx ON seen(last_processed_at);

      CREATE TABLE IF NOT EXISTS curator_decisions (
        slug TEXT NOT NULL,
        number INTEGER NOT NULL,
        decided_at TEXT NOT NULL,
        decision TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        related_tickets TEXT NOT NULL DEFAULT '[]',
        related_gh_issues TEXT NOT NULL DEFAULT '[]',
        cost_usd REAL,
        PRIMARY KEY (slug, number, decided_at)
      );
      CREATE INDEX IF NOT EXISTS curator_decisions_recent_idx ON curator_decisions(decided_at);

      -- spike/sources-and-rules: v2 state. Parallel tables so v0 code is undisturbed.
      CREATE TABLE IF NOT EXISTS v2_seen (
        source_name        TEXT NOT NULL,
        external_id        TEXT NOT NULL,
        content_hash       TEXT NOT NULL,
        vault_ticket_id    TEXT,
        status             TEXT NOT NULL,
        plan_via           TEXT,
        plan_rule_name     TEXT,
        first_seen_at      TEXT NOT NULL,
        last_processed_at  TEXT NOT NULL,
        PRIMARY KEY (source_name, external_id)
      );
      CREATE INDEX IF NOT EXISTS v2_seen_last_idx ON v2_seen(last_processed_at);

      CREATE TABLE IF NOT EXISTS v2_cursors (
        source_name TEXT PRIMARY KEY,
        cursor      TEXT NOT NULL
      );

      -- lifecycle engine state. v2_ticket_state snapshots each vault ticket's
      -- frontmatter state field across ticks so we can detect transitions.
      -- v2_lifecycle_fired records which (ticket, rule, state-entry) triples
      -- have already had the rule fire, so the same rule doesn't run twice
      -- on the same state entry.
      CREATE TABLE IF NOT EXISTS v2_ticket_state (
        ticket_id        TEXT PRIMARY KEY,
        vault            TEXT NOT NULL,
        project          TEXT,
        ticket_type      TEXT,
        state            TEXT NOT NULL,
        state_entered_at TEXT NOT NULL,
        last_seen_at     TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS v2_lifecycle_fired (
        ticket_id        TEXT NOT NULL,
        rule_name        TEXT NOT NULL,
        state_entered_at TEXT NOT NULL,
        fired_at         TEXT NOT NULL,
        outcome          TEXT NOT NULL,
        PRIMARY KEY (ticket_id, rule_name, state_entered_at)
      );
      CREATE INDEX IF NOT EXISTS v2_lifecycle_fired_recent_idx ON v2_lifecycle_fired(fired_at);
    `);

    // Migrate: add triage_status column if missing.
    const seenCols = this.db
      .query<{ name: string }, []>("PRAGMA table_info(seen)")
      .all();
    const hasTriageStatus = seenCols.some(c => c.name === "triage_status");
    if (!hasTriageStatus) {
      this.db.exec(
        `ALTER TABLE seen ADD COLUMN triage_status TEXT NOT NULL DEFAULT 'awaiting-curation';`
      );
    }
    // Migrate: add last_fired_for_state column for drive-mode tracking.
    const hasLastFiredForState = seenCols.some(c => c.name === "last_fired_for_state");
    if (!hasLastFiredForState) {
      this.db.exec(`ALTER TABLE seen ADD COLUMN last_fired_for_state TEXT;`);
    }
    // Migrate: add spawned_pid + spawned_at for drive-loop PID liveness check.
    const hasSpawnedPid = seenCols.some(c => c.name === "spawned_pid");
    if (!hasSpawnedPid) {
      this.db.exec(`ALTER TABLE seen ADD COLUMN spawned_pid INTEGER;`);
    }
    const hasSpawnedAt = seenCols.some(c => c.name === "spawned_at");
    if (!hasSpawnedAt) {
      this.db.exec(`ALTER TABLE seen ADD COLUMN spawned_at TEXT;`);
    }

    // Migrate: v2_seen columns for the autopilot slice. Same pattern as v0's
    // seen-table migrations — idempotent ALTERs gated by PRAGMA table_info.
    const v2SeenCols = this.db
      .query<{ name: string }, []>("PRAGMA table_info(v2_seen)")
      .all();
    const v2HasCuratorDecision = v2SeenCols.some(c => c.name === "curator_decision");
    if (!v2HasCuratorDecision) {
      this.db.exec(`ALTER TABLE v2_seen ADD COLUMN curator_decision TEXT;`);
    }
    const v2HasSpawnedPid = v2SeenCols.some(c => c.name === "spawned_pid");
    if (!v2HasSpawnedPid) {
      this.db.exec(`ALTER TABLE v2_seen ADD COLUMN spawned_pid INTEGER;`);
    }
    const v2HasSpawnedAt = v2SeenCols.some(c => c.name === "spawned_at");
    if (!v2HasSpawnedAt) {
      this.db.exec(`ALTER TABLE v2_seen ADD COLUMN spawned_at TEXT;`);
    }

    this.cursorsPath = join(stateDir, "cursors.json");
    this.cursors = existsSync(this.cursorsPath)
      ? JSON.parse(readFileSync(this.cursorsPath, "utf-8"))
      : {};
  }

  getCursor(slug: string): string | null {
    return this.cursors[slug] ?? null;
  }

  setCursor(slug: string, iso: string): void {
    this.cursors[slug] = iso;
    writeFileSync(this.cursorsPath, JSON.stringify(this.cursors, null, 2));
  }

  /**
   * On first sight of a repo, seed its cursor to "now" so we don't flood
   * the vault with the entire backlog. Returns true if seeding happened.
   */
  ensureCursorSeeded(slug: string): boolean {
    if (this.cursors[slug]) return false;
    this.setCursor(slug, new Date().toISOString());
    return true;
  }

  getSeen(slug: string, number: number): SeenRow | null {
    const row = this.db
      .query("SELECT * FROM seen WHERE slug = ? AND number = ?")
      .get(slug, number) as SeenRow | null;
    return row ?? null;
  }

  markSeen(args: {
    slug: string;
    number: number;
    vault_ticket_id: string | null;
    content_hash: string;
    triage_status?: TriageStatus;
  }): void {
    const now = new Date().toISOString();
    const status: TriageStatus = args.triage_status ?? "awaiting-curation";
    const existing = this.getSeen(args.slug, args.number);
    if (existing) {
      this.db.run(
        `UPDATE seen SET vault_ticket_id = ?, content_hash = ?, triage_status = ?, last_processed_at = ?
         WHERE slug = ? AND number = ?`,
        [args.vault_ticket_id, args.content_hash, status, now, args.slug, args.number]
      );
    } else {
      this.db.run(
        `INSERT INTO seen (slug, number, vault_ticket_id, content_hash, triage_status, first_processed_at, last_processed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [args.slug, args.number, args.vault_ticket_id, args.content_hash, status, now, now]
      );
    }
  }

  setTriageStatus(slug: string, number: number, status: TriageStatus): void {
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE seen SET triage_status = ?, last_processed_at = ? WHERE slug = ? AND number = ?`,
      [status, now, slug, number]
    );
  }

  /** Record the vault ticket state we just fired against. Drive-mode reads
   * this each tick to decide whether the ticket has advanced. */
  setLastFiredForState(slug: string, number: number, vaultState: string): void {
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE seen SET last_fired_for_state = ?, last_processed_at = ? WHERE slug = ? AND number = ?`,
      [vaultState, now, slug, number]
    );
  }

  /** Persist the PID of the most recent `oteam assign` spawn so the drive
   * loop can check liveness before firing the next phase (prevents the
   * double-fire that happens when spike auto-proceeds mid-process). */
  setSpawn(slug: string, number: number, pid: number): void {
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE seen SET spawned_pid = ?, spawned_at = ? WHERE slug = ? AND number = ?`,
      [pid, now, slug, number]
    );
  }

  /** Clear the spawn record. Called on terminal transitions so a stale PID
   * doesn't sit on a row whose phase pipeline already ended. */
  clearSpawn(slug: string, number: number): void {
    this.db.run(
      `UPDATE seen SET spawned_pid = NULL, spawned_at = NULL WHERE slug = ? AND number = ?`,
      [slug, number]
    );
  }

  /** Find all seen rows in a given lifecycle status (newest first). */
  listByStatus(status: TriageStatus, limit = 100): SeenRow[] {
    return this.db
      .query("SELECT * FROM seen WHERE triage_status = ? ORDER BY last_processed_at DESC LIMIT ?")
      .all(status, limit) as SeenRow[];
  }

  recordCuratorDecision(args: {
    slug: string;
    number: number;
    decision: CuratorAction;
    reasoning: string;
    related_tickets: string[];
    related_gh_issues: number[];
    cost_usd: number | null;
  }): void {
    this.db.run(
      `INSERT INTO curator_decisions
         (slug, number, decided_at, decision, reasoning, related_tickets, related_gh_issues, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        args.slug,
        args.number,
        new Date().toISOString(),
        args.decision,
        args.reasoning,
        JSON.stringify(args.related_tickets),
        JSON.stringify(args.related_gh_issues),
        args.cost_usd,
      ]
    );
  }

  recentSeen(limit = 50): SeenRow[] {
    return this.db
      .query("SELECT * FROM seen ORDER BY last_processed_at DESC LIMIT ?")
      .all(limit) as SeenRow[];
  }

  recentCuratorDecisions(limit = 20): CuratorDecisionRow[] {
    return this.db
      .query("SELECT * FROM curator_decisions ORDER BY decided_at DESC LIMIT ?")
      .all(limit) as CuratorDecisionRow[];
  }

  allCursors(): Record<string, string> {
    return { ...this.cursors };
  }

  // ─── v2 seen (per (source_name, external_id)) ──────────────────────────

  getV2Seen(sourceName: string, externalId: string): V2SeenRow | null {
    const row = this.db
      .query("SELECT * FROM v2_seen WHERE source_name = ? AND external_id = ?")
      .get(sourceName, externalId) as V2SeenRow | null;
    return row ?? null;
  }

  /**
   * Insert or update a v2_seen row. `status` is the terminal outcome:
   * "filed" | "dropped" | "skipped" | "security-held" | "error".
   * Callers pass the planned action's `via` and `rule_name` so we can
   * audit how the item was routed.
   */
  markV2Seen(args: {
    source_name: string;
    external_id: string;
    content_hash: string;
    vault_ticket_id: string | null;
    status: string;
    plan_via: string | null;
    plan_rule_name: string | null;
  }): void {
    const now = new Date().toISOString();
    const existing = this.getV2Seen(args.source_name, args.external_id);
    if (existing) {
      this.db.run(
        `UPDATE v2_seen
            SET content_hash = ?, vault_ticket_id = ?, status = ?,
                plan_via = ?, plan_rule_name = ?, last_processed_at = ?
          WHERE source_name = ? AND external_id = ?`,
        [
          args.content_hash,
          args.vault_ticket_id,
          args.status,
          args.plan_via,
          args.plan_rule_name,
          now,
          args.source_name,
          args.external_id,
        ],
      );
    } else {
      this.db.run(
        `INSERT INTO v2_seen
            (source_name, external_id, content_hash, vault_ticket_id, status,
             plan_via, plan_rule_name, first_seen_at, last_processed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          args.source_name,
          args.external_id,
          args.content_hash,
          args.vault_ticket_id,
          args.status,
          args.plan_via,
          args.plan_rule_name,
          now,
          now,
        ],
      );
    }
  }

  /**
   * Update a v2_seen row after the curator runs (and, for autopilot=fire/drive,
   * after the orchestrator spawn attempt): records the curator decision, new
   * status, and optional spawned_pid in one statement. Doesn't touch
   * content_hash, vault_ticket_id, plan_via, or plan_rule_name.
   */
  updateV2SeenAfterCurator(args: {
    source_name: string;
    external_id: string;
    curator_decision: string;
    status: string;
    spawned_pid?: number | null;
  }): void {
    const now = new Date().toISOString();
    const pid = args.spawned_pid ?? null;
    const spawnedAt = pid !== null ? now : null;
    this.db.run(
      `UPDATE v2_seen
          SET curator_decision = ?, status = ?, last_processed_at = ?,
              spawned_pid = ?, spawned_at = ?
        WHERE source_name = ? AND external_id = ?`,
      [args.curator_decision, args.status, now, pid, spawnedAt, args.source_name, args.external_id],
    );
  }

  // ─── v2 cursors (per source name, not per repo slug) ────────────────────

  getV2Cursor(sourceName: string): string | null {
    const row = this.db
      .query("SELECT cursor FROM v2_cursors WHERE source_name = ?")
      .get(sourceName) as { cursor: string } | null;
    return row?.cursor ?? null;
  }

  setV2Cursor(sourceName: string, iso: string): void {
    this.db.run(
      `INSERT INTO v2_cursors (source_name, cursor) VALUES (?, ?)
       ON CONFLICT(source_name) DO UPDATE SET cursor = excluded.cursor`,
      [sourceName, iso],
    );
  }

  /**
   * On first sight of a v2 source, seed its cursor to `iso` (usually "now")
   * so the first real poll doesn't flood the vault with the entire backlog.
   * Returns true if seeding happened. Mirrors `ensureCursorSeeded`.
   */
  ensureV2CursorSeeded(sourceName: string, iso: string): boolean {
    if (this.getV2Cursor(sourceName)) return false;
    this.setV2Cursor(sourceName, iso);
    return true;
  }

  allV2Cursors(): Record<string, string> {
    const rows = this.db
      .query("SELECT source_name, cursor FROM v2_cursors ORDER BY source_name")
      .all() as { source_name: string; cursor: string }[];
    const out: Record<string, string> = {};
    for (const r of rows) out[r.source_name] = r.cursor;
    return out;
  }

  // ─── lifecycle ───────────────────────────────────────────────────────────

  /**
   * Read a ticket's last-known state snapshot. Null if we've never seen it.
   */
  getTicketState(ticketId: string): V2TicketStateRow | null {
    const row = this.db
      .query("SELECT * FROM v2_ticket_state WHERE ticket_id = ?")
      .get(ticketId) as V2TicketStateRow | null;
    return row ?? null;
  }

  /**
   * Upsert a ticket's state snapshot. If the state changed from the prior
   * snapshot, returns `transitioned=true` along with the previous state and
   * the new state_entered_at timestamp. If unchanged, just refreshes
   * last_seen_at.
   */
  upsertTicketState(args: {
    ticket_id: string;
    vault: string;
    project: string | null;
    ticket_type: string | null;
    state: string;
  }): { transitioned: boolean; from_state: string | null; state_entered_at: string } {
    const now = new Date().toISOString();
    const existing = this.getTicketState(args.ticket_id);
    if (!existing) {
      this.db.run(
        `INSERT INTO v2_ticket_state
            (ticket_id, vault, project, ticket_type, state, state_entered_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [args.ticket_id, args.vault, args.project, args.ticket_type, args.state, now, now],
      );
      return { transitioned: false, from_state: null, state_entered_at: now };
    }
    if (existing.state === args.state) {
      this.db.run(
        `UPDATE v2_ticket_state SET last_seen_at = ? WHERE ticket_id = ?`,
        [now, args.ticket_id],
      );
      return {
        transitioned: false,
        from_state: existing.state,
        state_entered_at: existing.state_entered_at,
      };
    }
    // State changed → reset state_entered_at.
    this.db.run(
      `UPDATE v2_ticket_state
          SET vault = ?, project = ?, ticket_type = ?, state = ?,
              state_entered_at = ?, last_seen_at = ?
        WHERE ticket_id = ?`,
      [args.vault, args.project, args.ticket_type, args.state, now, now, args.ticket_id],
    );
    return { transitioned: true, from_state: existing.state, state_entered_at: now };
  }

  /** Has this lifecycle rule already fired for (ticket, current state-entry)? */
  lifecycleHasFired(ticketId: string, ruleName: string, stateEnteredAt: string): boolean {
    const row = this.db
      .query(
        `SELECT 1 FROM v2_lifecycle_fired
          WHERE ticket_id = ? AND rule_name = ? AND state_entered_at = ?`,
      )
      .get(ticketId, ruleName, stateEnteredAt);
    return row !== null;
  }

  /** Record a lifecycle rule firing so future ticks dedup it. */
  markLifecycleFired(args: {
    ticket_id: string;
    rule_name: string;
    state_entered_at: string;
    outcome: string;
  }): void {
    this.db.run(
      `INSERT OR REPLACE INTO v2_lifecycle_fired
          (ticket_id, rule_name, state_entered_at, fired_at, outcome)
        VALUES (?, ?, ?, ?, ?)`,
      [args.ticket_id, args.rule_name, args.state_entered_at, new Date().toISOString(), args.outcome],
    );
  }

  close(): void {
    this.db.close();
  }
}

export function hashIssueContent(title: string, body: string | null): string {
  return createHash("sha256")
    .update(title + "\n---\n" + (body ?? ""))
    .digest("hex");
}
