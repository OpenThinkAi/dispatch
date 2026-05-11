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

<!-- stamp:begin (managed by stamp-cli — do not edit between markers) -->

## Stamp-protected repository — read before changing code

This repository is gated by [stamp-cli](https://github.com/OpenThinkAi/stamp-cli).
Direct commits to protected branches (typically `main`) **will be rejected by
the server-side pre-receive hook**, even with valid credentials. Every change
to a protected branch must be a `stamp merge` signed locally and pushed via
`stamp push`.

### The canonical workflow

```sh
git checkout -b feature
# ...edit, commit, repeat...

stamp review --diff main..feature       # all configured reviewers run in parallel
stamp status --diff main..feature       # exit 0 if every required reviewer approved

# When green:
git checkout main
stamp merge feature --into main         # signs an Ed25519 attestation into the merge trailer
stamp push main                         # server hook verifies; main advances on the remote
```

If a reviewer returns `changes_requested`, read its prose in the `stamp review`
output (or via `stamp log --reviews --limit 1`), fix the code, commit, and
re-review. Verdicts are bound to the exact `(base_sha, head_sha)` pair, so a
new commit invalidates prior approvals.

### What NOT to do

- **Do not** `git push origin main` directly — bypasses the gate; will be rejected.
- **Do not** commit to `main` directly — same.
- **Do not** use `--no-verify` to skip hooks. Investigate hook failures, don't bypass them.
- **Do not** edit `.stamp/config.yml` or `.stamp/reviewers/*.md` casually — those changes
  go through the same reviewer gate as any other code change. Treat them as security-sensitive
  edits.
- **Do not** delete `.stamp/trusted-keys/*.pub` files unless you genuinely intend to revoke
  a signer; doing so locks that signer out of all future merges.

### The one exception: the bootstrap commit

The single commit that ADDS `.stamp/` + `AGENTS.md` + `CLAUDE.md` to a fresh
repo for the first time is the chicken-and-egg moment — `stamp review` has
no base tree to read prompts from. That one commit can land directly on
`main`. Recent `stamp init` runs do this commit automatically; older
versions need it done by hand. Every subsequent change to `.stamp/` (or
anything else) goes through the normal stamp flow.

### Where things live

- `.stamp/config.yml` — branch rules (which reviewers are required, optional `required_checks`)
- `.stamp/reviewers/*.md` — reviewer prompt files; this is your project's review policy as code
- `.stamp/trusted-keys/*.pub` — Ed25519 public keys allowed to sign merges into protected branches
- `~/.stamp/keys/ed25519{,.pub}` — your local signing keypair (generated by `stamp init` /
  `stamp keys generate`; never committed)

### Useful commands

```sh
stamp --help                              # full command list
stamp reviewers list                      # configured reviewers + prompt file status
stamp reviewers test <name> --diff <rev>  # iterate on a reviewer prompt without polluting the DB
stamp log                                 # recent stamped merges with attestation summaries
stamp verify <sha>                        # re-verify a specific merge commit's attestation
```

### When stamp blocks you

See [`docs/troubleshooting.md`](./docs/troubleshooting.md) if it exists in this repo, or the
upstream copy at https://github.com/OpenThinkAi/stamp-cli/blob/main/docs/troubleshooting.md.
Common cases:

- `gate CLOSED: missing approved verdicts` — re-run `stamp review` (verdicts are SHA-bound;
  every new commit invalidates prior approvals)
- `pre-merge checks failed` — a `required_check` exited non-zero; the merge was rolled back
- `remote: stamp-verify: rejecting refs/heads/main` — server hook caught a bypass attempt
- `required by rule but not defined` — chicken-and-egg on a reviewer config change; see the
  troubleshooting entry, or use `stamp bootstrap` for the placeholder→real swap case

### Knowing when to stop the review loop (diminishing returns)

Each `stamp review` run is non-trivial — reviewer LLM calls, your context, and amend
churn to fix what they flag. After 2–3 rounds the value tapers. A useful pattern:

- **Round 1** catches structure (real bugs, missing rollback, wrong source of truth).
- **Round 2** catches consistency (code dup, conflicting defaults, broken back-compat).
- **Round 3** typically surfaces only stylistic polish (comma placement, comment
  wording, JSDoc rot — things no end user will ever notice).

**Heuristic:** if every reviewer's request includes phrases like "minor", "nit",
"not blocking", or "cosmetic", apply the fixes and re-run review **only because
verdicts are SHA-bound and need refreshing** — then merge. Don't iterate further looking
for more issues. By round 4 you're paying full LLM cost for marginal value, and reviewers
will sometimes invent new categories of nit just to fill the response.

Exception: if any reviewer returns `denied` (not `changes_requested`), the change has a
structural problem regardless of round number — keep iterating until the denial is
addressed or the design is reconsidered.

<!-- stamp:end -->
