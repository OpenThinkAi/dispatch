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

  close(): void {
    this.db.close();
  }
}

export function hashIssueContent(title: string, body: string | null): string {
  return createHash("sha256")
    .update(title + "\n---\n" + (body ?? ""))
    .digest("hex");
}
