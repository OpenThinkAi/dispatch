import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { VaultTicketSummary } from "./types.ts";

/** Resolve a registered vault name to its absolute path via oteam config. */
export function resolveVaultPath(vault: string): string | null {
  const r = spawnSync("oteam", ["config", "vault", "list"], { encoding: "utf-8" });
  if (r.status !== 0) return null;
  for (const line of r.stdout.split("\n")) {
    const m = line.match(/^\s*(\S+)\s+→\s+(\/.+)$/);
    if (m && m[1] === vault) return m[2];
  }
  return null;
}

/**
 * Read recent vault tickets across triage / refined / in-progress / qa folders.
 * Returns lightweight summaries suitable for feeding to the curator.
 *
 * Filters:
 *   - same vault only
 *   - if `repo` is provided, only tickets whose `repo:` matches
 *   - mtime within `windowDays`
 *   - cap at `cap` items, newest first
 */
export function readRecentVaultTickets(args: {
  vault: string;
  repo?: string | null;
  windowDays: number;
  cap: number;
}): VaultTicketSummary[] {
  const vaultPath = resolveVaultPath(args.vault);
  if (!vaultPath) return [];
  const ticketsRoot = join(vaultPath, "tickets");
  if (!existsSync(ticketsRoot)) return [];

  const folders = ["triage", "refined", "in-progress", "qa"];
  const cutoffMs = Date.now() - args.windowDays * 86_400_000;
  const all: { mtime: number; summary: VaultTicketSummary }[] = [];

  for (const folder of folders) {
    const dir = join(ticketsRoot, folder);
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".md")) continue;
      const path = join(dir, name);
      let st;
      try { st = statSync(path); } catch { continue; }
      if (st.mtimeMs < cutoffMs) continue;

      let raw: string;
      try { raw = readFileSync(path, "utf-8"); } catch { continue; }
      const summary = summariseTicket(path, raw);
      if (!summary) continue;
      if (args.repo && summary.repo && summary.repo.toLowerCase() !== args.repo.toLowerCase()) continue;
      all.push({ mtime: st.mtimeMs, summary });
    }
  }

  all.sort((a, b) => b.mtime - a.mtime);
  return all.slice(0, args.cap).map(x => x.summary);
}

function summariseTicket(path: string, raw: string): VaultTicketSummary | null {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) return null;
  const fmBlock = fmMatch[1];
  const body = fmMatch[2];

  const id = pickField(fmBlock, "id");
  const title = pickField(fmBlock, "title")?.replace(/^["']|["']$/g, "") ?? "";
  const state = pickField(fmBlock, "state") ?? "";
  const repoField = pickField(fmBlock, "repo");
  const repo = repoField && repoField.length > 0 ? repoField : null;
  const sourceLine = pickField(fmBlock, "source") ?? "";
  const sourceTypeMatch = sourceLine.match(/type:\s*([a-z]+)/);
  const source_type = sourceTypeMatch ? sourceTypeMatch[1] : "manual";

  if (!id) return null;

  const psMatch = body.match(/##\s+Problem Statement\s*\n([\s\S]*?)(?:\n##\s|$)/);
  const ps = (psMatch ? psMatch[1] : body).trim();
  const one_line_summary = ps
    .split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("<!--"))
    .slice(0, 1)
    .join(" ")
    .slice(0, 220);

  return { id, title, state, repo, source_type, one_line_summary, path };
}

function pickField(fm: string, key: string): string | null {
  const m = fm.match(new RegExp(`^${key}\\s*:\\s*(.+?)\\s*$`, "m"));
  return m ? m[1] : null;
}
