import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type { Config } from "./types.ts";

const RepoSchema = z.object({
  slug: z.string().regex(/^[^/]+\/[^/]+$/, "slug must be owner/repo"),
  vault: z.string().min(1),
  project: z.string().min(1),
  can_label: z.boolean().default(true),
  description: z.string().optional(),
});

const DefaultsSchema = z.object({
  state_dir: z.string().default("~/.local/state/dispatch"),
  log_dir: z.string().default("~/Library/Logs/dispatch"),
  poll_interval_minutes: z.number().int().positive().default(5),
  triage_model: z.string().default("claude-haiku-4-5-20251001"),
  body_truncate_chars: z.number().int().positive().default(8000),
});

const ConfigFileSchema = z.object({
  defaults: DefaultsSchema.default({}),
  repo: z.array(RepoSchema).min(1),
});

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return resolve(p);
}

export function configPath(): string {
  if (process.env.DISPATCH_CONFIG) return expandHome(process.env.DISPATCH_CONFIG);
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "dispatch/dispatch.toml");
  return join(homedir(), ".config/dispatch/dispatch.toml");
}

export function loadConfig(path: string = configPath()): Config {
  if (!existsSync(path)) {
    throw new Error(`dispatch config not found at ${path}. Copy dispatch.toml.example and edit, or run "dispatch setup".`);
  }
  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (e) {
    throw new Error(`failed to parse ${path}: ${(e as Error).message}`);
  }

  const result = ConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map(i => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`config validation failed for ${path}:\n${issues}`);
  }

  const data = result.data;
  // duplicate-slug check
  const seen = new Set<string>();
  for (const r of data.repo) {
    if (seen.has(r.slug)) throw new Error(`duplicate repo slug: ${r.slug}`);
    seen.add(r.slug);
  }

  return {
    defaults: {
      state_dir: expandHome(data.defaults.state_dir),
      log_dir: expandHome(data.defaults.log_dir),
      config_path: path,
      poll_interval_minutes: data.defaults.poll_interval_minutes,
      triage_model: data.defaults.triage_model,
      body_truncate_chars: data.defaults.body_truncate_chars,
    },
    repos: data.repo,
  };
}

export function repoBySlug(cfg: Config, slug: string) {
  return cfg.repos.find(r => r.slug.toLowerCase() === slug.toLowerCase());
}
