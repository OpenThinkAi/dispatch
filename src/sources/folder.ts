import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { FolderSource, Item } from "../types.ts";

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return resolve(p);
}

/**
 * Scan a folder source for files matching its pattern. Each match becomes
 * one Item, ready to feed into triage + the rule engine. Items emitted
 * here have `type = null` (triage hasn't run) and `labels = []` (folder
 * sources don't carry source-side labels).
 *
 * After successful downstream processing, call `archiveFolderItem` to move
 * or delete the file so it isn't re-ingested next tick.
 */
export function readFolder(cfg: FolderSource): Item[] {
  const dir = expandHome(cfg.path);
  if (!existsSync(dir)) return [];

  const archiveAbs = cfg.archive ? expandHome(cfg.archive) : null;

  const glob = new Bun.Glob(cfg.pattern);
  const items: Item[] = [];
  for (const rel of glob.scanSync({ cwd: dir, onlyFiles: true })) {
    const abs = join(dir, rel);
    if (archiveAbs && abs.startsWith(archiveAbs)) continue;
    const stat = statSync(abs);
    const body = readFileSync(abs, "utf-8");
    items.push({
      source: { name: cfg.name, kind: "folder" },
      external_id: abs,
      url: null,
      title: titleFor(abs, body),
      body,
      author: null,
      repo: null,
      labels: [],
      type: null,
      created_at: stat.mtime.toISOString(),
      raw: { path: abs, mtime_ms: stat.mtimeMs, size: stat.size },
    });
  }
  return items;
}

/** Move (or delete, if no `archive` set) the file backing this Item. */
export function archiveFolderItem(cfg: FolderSource, item: Item): void {
  const abs = item.external_id;
  if (!existsSync(abs)) return;
  if (cfg.archive) {
    const archiveDir = expandHome(cfg.archive);
    mkdirSync(archiveDir, { recursive: true });
    renameSync(abs, join(archiveDir, basename(abs)));
  } else {
    unlinkSync(abs);
  }
}

/** First `# Heading` in the body, otherwise the filename sans extension. */
function titleFor(abs: string, body: string): string {
  const m = body.match(/^#\s+(.+)$/m);
  if (m) return m[1].trim();
  return basename(abs).replace(/\.[^.]+$/, "");
}
