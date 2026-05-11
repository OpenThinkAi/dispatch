import { addLabels as ghAddLabels, createLabel, listLabels, removeLabels as ghRemoveLabels } from "../github.ts";
import { STANDARD_LABELS } from "../labels-standard.ts";
import { log } from "../log.ts";
import type { RepoConfig } from "../types.ts";

export function applyLabels(repo: RepoConfig, number: number, labels: string[]): void {
  if (labels.length === 0) return;
  if (!repo.can_label) {
    log.debug("skipping labels (can_label=false)", { slug: repo.slug, number, labels });
    return;
  }
  try {
    ghAddLabels(repo.slug, number, labels);
    log.info("labels applied", { slug: repo.slug, number, labels });
  } catch (e) {
    // never fatal — vault filing already succeeded
    log.warn("labels apply failed", {
      slug: repo.slug,
      number,
      labels,
      error: (e as Error).message,
    });
  }
}

export function clearLabels(repo: RepoConfig, number: number, labels: string[]): void {
  if (labels.length === 0) return;
  if (!repo.can_label) {
    log.debug("skipping label clear (can_label=false)", { slug: repo.slug, number, labels });
    return;
  }
  try {
    ghRemoveLabels(repo.slug, number, labels);
    log.info("labels cleared", { slug: repo.slug, number, labels });
  } catch (e) {
    // best-effort: a missing label or a closed issue both produce non-zero
    // exits from `gh issue edit --remove-label`; neither should fail the tick.
    log.warn("labels clear failed", {
      slug: repo.slug,
      number,
      labels,
      error: (e as Error).message,
    });
  }
}

export type EnsureLabelsResult = {
  created: string[];
  existing: string[];
  failed: { name: string; error: string }[];
};

/**
 * Ensure every label in `STANDARD_LABELS` exists on `slug`. Lists current
 * labels first, then creates only the missing ones (no `--force`, so existing
 * labels' colors/descriptions are never overwritten — operator customizations
 * are preserved).
 *
 * Per-label create failures are collected, not thrown; one bad label must not
 * abort the rest. If the initial `listLabels` fails (auth, network, 404), the
 * whole call throws so the caller can surface the repo as failed.
 */
export function ensureStandardLabels(slug: string): EnsureLabelsResult {
  const present = new Set(listLabels(slug).map(l => l.name));
  const created: string[] = [];
  const existing: string[] = [];
  const failed: { name: string; error: string }[] = [];

  for (const label of STANDARD_LABELS) {
    if (present.has(label.name)) {
      existing.push(label.name);
      continue;
    }
    try {
      createLabel(slug, label);
      created.push(label.name);
    } catch (e) {
      failed.push({ name: label.name, error: (e as Error).message });
    }
  }

  return { created, existing, failed };
}
