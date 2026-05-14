import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.ts";
import type { GitHubIssue, Item, RepoConfig, SecurityFlag } from "../types.ts";

export function holdForSecurityReview(args: {
  issue: GitHubIssue;
  repo: RepoConfig;
  flag: SecurityFlag;
  stateDir: string;
}): void {
  const inboxDir = join(args.stateDir, "security-inbox");
  mkdirSync(inboxDir, { recursive: true });

  const safeSlug = args.repo.slug.replace("/", "__");
  const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}__${safeSlug}__${args.issue.number}.md`;
  const path = join(inboxDir, filename);

  const body = redact(args.issue.body ?? "");
  const md = [
    `# Security hold: ${args.repo.slug}#${args.issue.number}`,
    "",
    `- **Kind:** ${args.flag.kind}`,
    `- **Reason:** ${args.flag.reason}`,
    `- **URL:** ${args.issue.html_url}`,
    `- **Title:** ${args.issue.title}`,
    `- **Author:** ${args.issue.user?.login ?? "(unknown)"}`,
    `- **Created:** ${args.issue.created_at}`,
    "",
    "## Body (redacted)",
    "",
    "```",
    body,
    "```",
    "",
    "_This issue was held back from the vault. Review manually and decide whether to file with `dispatch replay <url>` after redaction._",
  ].join("\n");

  writeFileSync(path, md);
  notify({
    title: `dispatch: security flag (${args.flag.kind})`,
    subtitle: `${args.repo.slug}#${args.issue.number}`,
    message: args.flag.reason.slice(0, 180),
  });
  log.warn("security held", {
    slug: args.repo.slug,
    number: args.issue.number,
    kind: args.flag.kind,
    inbox_path: path,
  });
}

/**
 * v2 variant — kind-generic security hold that works for any Item shape
 * (github_issues, github_prs, folder, linear). Synthesizes a minimal flag
 * when called from rules that route to sink=security-inbox without triage
 * having produced a security_flag.
 */
export function holdItemForSecurityReview(args: {
  item: Item;
  flag: SecurityFlag | null;
  stateDir: string;
}): { path: string } {
  const inboxDir = join(args.stateDir, "security-inbox");
  mkdirSync(inboxDir, { recursive: true });

  const flag: SecurityFlag = args.flag ?? {
    kind: "abuse",
    reason: "routed by rule to security-inbox (no triage flag)",
  };
  const safeSource = args.item.source.name.replace(/[^A-Za-z0-9._-]/g, "_");
  const safeExtId = args.item.external_id.replace(/[^A-Za-z0-9._-]/g, "_");
  const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}__${safeSource}__${safeExtId}.md`;
  const path = join(inboxDir, filename);

  const body = redact(args.item.body);
  const md = [
    `# Security hold: ${args.item.source.name} / ${args.item.external_id}`,
    "",
    `- **Source:** ${args.item.source.name} (${args.item.source.kind})`,
    `- **Kind:** ${flag.kind}`,
    `- **Reason:** ${flag.reason}`,
    args.item.url ? `- **URL:** ${args.item.url}` : "",
    `- **Title:** ${args.item.title}`,
    args.item.author ? `- **Author:** ${args.item.author}` : "",
    `- **Created:** ${args.item.created_at}`,
    "",
    "## Body (redacted)",
    "",
    "```",
    body,
    "```",
    "",
    "_This item was held back from the vault. Review manually and decide whether to file._",
  ]
    .filter(Boolean)
    .join("\n");

  writeFileSync(path, md);
  notify({
    title: `dispatch: security hold (${flag.kind})`,
    subtitle: `${args.item.source.name}: ${args.item.external_id}`,
    message: flag.reason.slice(0, 180),
  });
  log.warn("v2 security held", {
    source: args.item.source.name,
    external_id: args.item.external_id,
    kind: flag.kind,
    inbox_path: path,
  });
  return { path };
}

/** Best-effort macOS notification; silent failure on other platforms. */
function notify(args: { title: string; subtitle?: string; message: string }): void {
  if (process.platform !== "darwin") return;
  const script = `display notification ${q(args.message)} with title ${q(args.title)}${args.subtitle ? ` subtitle ${q(args.subtitle)}` : ""}`;
  spawnSync("osascript", ["-e", script], { stdio: "ignore" });
}

function q(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Light redaction of obvious-looking secrets in the body before we write it
 * to disk. The point is to make the on-disk file safe to glance at, not to
 * resist a determined adversary; the vault was already skipped.
 */
function redact(text: string): string {
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghu_[A-Za-z0-9]{20,}|ghr_[A-Za-z0-9]{20,}|xox[bpars]-[A-Za-z0-9-]{10,})\b/g, "[REDACTED-TOKEN]")
    .replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g, "[REDACTED-PRIVATE-KEY]")
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, "[REDACTED-LONG-HEX]");
}
