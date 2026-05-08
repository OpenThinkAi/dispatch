# AGENTS.md — agent guidance for dispatch

This file is read by AI agents working in this repo.

## What this is

dispatch is a launchd-driven Bun CLI that polls configured GitHub repos,
runs each new issue through a small Claude triage call, and files the
issue into an oteam vault via `oteam pull github`. Optionally writes
labels back to the issue. Holds anything flagged as a security risk and
routes it to a local inbox instead of the vault.

Part of the OpenThink suite. Sits "upstream" of `@openthink/team`:
dispatch puts new tickets into the vault; oteam drives them through the
role pipeline.

## Source layout

- `src/cli.ts` — command dispatch (`poll`, `watch`, `process`, `setup`,
  `state show`, `config validate`)
- `src/config.ts` — TOML loader + zod validation
- `src/state.ts` — cursors.json + `bun:sqlite` seen table
- `src/github.ts` — `gh` CLI wrappers (issues since, fetch, add labels)
- `src/triage.ts` — Anthropic SDK call + strict JSON parse
- `src/poll.ts` — main loop (`pollOnce`, `processIssue`)
- `src/setup.ts` — `dispatch setup` — path detection + plist generation
- `src/sinks/vault.ts` — `oteam pull` + project ensure
- `src/sinks/labels.ts` — `gh issue edit --add-label`
- `src/sinks/security.ts` — osascript notify + on-disk inbox + redaction

## Conventions

- **Bun + TypeScript**, strict, `bun run typecheck` must pass.
- **Shell out** to `gh` and `oteam` rather than reimplementing their
  surfaces. Keep these wrappers thin and in `github.ts` / `sinks/vault.ts`.
- **Logging is structured JSON** (one line per event) via `src/log.ts`.
  Never `console.log` a free-form string outside `cli.ts`.
- **No prompt or labeling decisions are silently dropped.** If triage
  returns something we don't understand, log it and skip — never crash
  the tick.
- **Failures in one repo must not poison the rest of the tick.** The
  poll loop catches per-repo and per-issue errors and continues.
- **Cursors only advance after successful processing.** A failure on
  issue N leaves the cursor at the previous value so the next tick will
  retry.

## Making changes

- After editing `.ts` files, always run `bun run typecheck` before
  declaring done.
- After editing the triage prompt, do a `dispatch process <url>` smoke
  test against a real issue before relying on the change.
- Don't bundle a config change with a code change; keep `dispatch.toml.example`
  edits in their own commit.
- New `[[repo]]` schema fields require updates to: `src/types.ts`,
  `src/config.ts` (zod schema), and the README config section.

## Known gotchas

- The launchd plist's PATH is rendered once at `dispatch setup` time. If
  the user switches node versions via nvm (and `oteam` sits under
  `~/.nvm/...`), or moves any of `bun`/`gh`/`claude`/`oteam` to a different
  prefix, re-run `dispatch setup --force` to regenerate the plist.
- The triage call uses `@anthropic-ai/claude-agent-sdk`, which spawns the
  `claude` binary as a subprocess in headless mode. That subprocess uses
  Claude Code's OAuth login if available, falling back to
  `ANTHROPIC_API_KEY`. Either path is fine; both must be missing for
  triage to fail.

## Out of scope

- Running on Linux as a systemd unit. Possible later, not now.
- Webhooks / push triggers. The 5-minute poll cadence is intentional and
  removes the need for a public endpoint.
- Extending sinks beyond oteam (Linear, Notion, raw markdown). Could
  happen if there's demand; today the abstraction is "vault file" and it
  hard-requires `oteam`.

## Related tools

- [`@openthink/team`](https://www.npmjs.com/package/@openthink/team) — drives the
  role pipeline against tickets dispatch files
- [`@openthink/think`](https://www.npmjs.com/package/@openthink/think) — persistent
  memory shared across agents
- [`@openthink/stamp`](https://www.npmjs.com/package/@openthink/stamp) — agent-to-agent
  code review with cryptographic merge gating

<!-- think:retro:begin (managed by `think init --retro` — do not edit between markers) -->
# Iterative Learning

This repo participates in agentic iterative learning via `think retro`. Treat retros as a peer-to-future-agents channel: read what others have left for you, and leave behind what would have helped you.

**Read at task start.** Before any non-trivial task in this repo, run:

```
think brief --cortex dispatch
```

Use the output to inform the work — prior conventions, invariants, decisions, and gotchas other agents have already learned.

**Write when you notice something worth remembering.** When you discover a convention, invariant, prior decision, or gotcha another agent would benefit from knowing, run:

```
think retro "<observation>" --cortex dispatch
```

Loose guidance — you decide when to emit. Examples:

- an undocumented convention you had to figure out
- a missing or stale type contract that blocked work
- a surprising invariant in the code
- a gotcha that looks like a bug but is intentional
- a prior decision worth not re-litigating
<!-- think:retro:end -->
