import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export type SeenRow = {
  slug: string;
  number: number;
  vault_ticket_id: string | null;
  content_hash: string;
  first_processed_at: string;
  last_processed_at: string;
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
    `);
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
  }): void {
    const now = new Date().toISOString();
    const existing = this.getSeen(args.slug, args.number);
    if (existing) {
      this.db.run(
        `UPDATE seen SET vault_ticket_id = ?, content_hash = ?, last_processed_at = ?
         WHERE slug = ? AND number = ?`,
        [args.vault_ticket_id, args.content_hash, now, args.slug, args.number]
      );
    } else {
      this.db.run(
        `INSERT INTO seen (slug, number, vault_ticket_id, content_hash, first_processed_at, last_processed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [args.slug, args.number, args.vault_ticket_id, args.content_hash, now, now]
      );
    }
  }

  recentSeen(limit = 50): SeenRow[] {
    return this.db
      .query("SELECT * FROM seen ORDER BY last_processed_at DESC LIMIT ?")
      .all(limit) as SeenRow[];
  }

  allCursors(): Record<string, string> {
    return { ...this.cursors };
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
