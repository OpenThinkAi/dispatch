import { addLabels as ghAddLabels } from "../github.ts";
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
