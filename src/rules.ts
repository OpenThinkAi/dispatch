import type {
  ConfigV2,
  IngestAction,
  IngestMatch,
  IngestRule,
  Item,
  LifecycleEvent,
  LifecycleMatch,
  LifecycleRule,
} from "./types.ts";

/**
 * Match `item` against an ordered list of ingest rules. First match wins.
 * Returns the matched rule (so the caller can read both `rule.do` and
 * `rule.name` for logging) or null if no rule matched.
 *
 * `when` semantics:
 *   - keys are AND-ed; an omitted key matches anything
 *   - `labels` is all-of (every listed label must be present on the item)
 *   - string fields compare with strict equality
 */
export function matchIngest(item: Item, rules: IngestRule[]): IngestRule | null {
  for (const rule of rules) {
    if (matchesIngestWhen(item, rule.when)) return rule;
  }
  return null;
}

function matchesIngestWhen(item: Item, when: IngestMatch): boolean {
  if (when.source !== undefined && when.source !== item.source.name) return false;
  if (when.source_prefix !== undefined && !item.source.name.startsWith(when.source_prefix)) return false;
  if (when.kind !== undefined && when.kind !== item.source.kind) return false;
  if (when.type !== undefined && when.type !== item.type) return false;
  if (when.repo !== undefined && when.repo !== item.repo) return false;
  if (
    when.repo_prefix !== undefined &&
    (item.repo === null || !item.repo.startsWith(when.repo_prefix))
  ) {
    return false;
  }
  if (when.author !== undefined && when.author !== item.author) return false;
  if (when.labels !== undefined && when.labels.length > 0) {
    const itemLabels = new Set(item.labels);
    for (const required of when.labels) {
      if (!itemLabels.has(required)) return false;
    }
  }
  return true;
}

/**
 * Match a lifecycle event against the rule list. Unlike ingest rules,
 * lifecycle rules are **all-match** — multiple rules can fire on the
 * same event (e.g. "advance phase" + "notify-on-advance"). The runtime
 * is responsible for deduping per (ticket, rule, state-entry).
 *
 * SPIKE: caller (the vault-state diffing lifecycle engine) arrives in
 * the next slice; this is pure-function pre-work so the matcher's
 * semantics are pinned down ahead of time.
 *
 * Returns matched rules in declaration order so action ordering is
 * deterministic.
 *
 * `when` semantics:
 *   - keys are AND-ed
 *   - `from_state` only matches when a transition is observed
 *     (event.from_state !== null) and equals the declared value
 *   - `to_state` and `state` both compare against the current state;
 *     they're synonyms in matching, but `to_state` reads as
 *     "fire on the transition into" while `state` reads as
 *     "match any tick where current state is"
 *   - `stuck_for_minutes` matches when the ticket has been in its
 *     current state for at least the declared minutes
 */
export function matchLifecycle(
  event: LifecycleEvent,
  rules: LifecycleRule[],
): LifecycleRule[] {
  return rules.filter(r => matchesLifecycleWhen(event, r.when));
}

/**
 * Resolve an item into a concrete plan: first try the rule list, then
 * fall back to `[default]`, then `drop`. Pure — no side effects.
 */
export type IngestPlan =
  | { via: "rule"; rule_name: string; action: IngestAction }
  | { via: "default"; action: IngestAction }
  | { via: "drop" };

export function planIngest(item: Item, cfg: ConfigV2): IngestPlan {
  const rule = matchIngest(item, cfg.ingest_rules);
  if (rule) return { via: "rule", rule_name: rule.name, action: rule.do };
  if (cfg.default_action) return { via: "default", action: cfg.default_action };
  return { via: "drop" };
}

function matchesLifecycleWhen(event: LifecycleEvent, when: LifecycleMatch): boolean {
  if (when.from_state !== undefined) {
    if (event.from_state === null || event.from_state !== when.from_state) return false;
  }
  if (when.to_state !== undefined && when.to_state !== event.to_state) return false;
  if (when.state !== undefined && when.state !== event.to_state) return false;
  if (when.type !== undefined && when.type !== event.type) return false;
  if (when.vault !== undefined && when.vault !== event.vault) return false;
  if (when.project !== undefined && when.project !== event.project) return false;
  if (
    when.stuck_for_minutes !== undefined &&
    event.stuck_for_minutes < when.stuck_for_minutes
  ) {
    return false;
  }
  return true;
}
