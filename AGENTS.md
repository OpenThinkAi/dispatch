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

## Stamp-protected repository — agent instructions (READ THIS BEFORE ANY GIT COMMAND)

**You — the AI agent reading this — are required to use the stamp flow for any
change to this repository's protected branches (typically `main`).** Direct
`git commit` to `main` and direct `git push origin main` are explicit
violations of this repo's process, even though the remote will technically
accept them.

The remote does not reject unsigned pushes (this is local-only / advisory mode
— see "How enforcement works here" below). That means **enforcement is on you,
not the server**. Bypassing the stamp flow because "the push will succeed
anyway" is the most common failure mode and is exactly what this notice exists
to prevent.

### The required workflow for every change to a protected branch

```sh
git checkout -b feature
# ...edit, commit, repeat on the feature branch...

stamp review --diff main..feature       # all configured reviewers run in parallel
stamp status --diff main..feature       # exit 0 if every required reviewer approved

# When green:
git checkout main
stamp merge feature --into main         # signs an Ed25519 attestation into the merge trailer
git push origin main                    # plain git push — remote accepts anything,
                                        # but the merge commit now carries a verifiable signature
```

If a reviewer returns `changes_requested`, read its prose in the `stamp review`
output (or via `stamp log --reviews --limit 1`), fix on the feature branch,
commit, and re-review. Verdicts are bound to `(base_sha, head_sha)`, so a new
commit invalidates prior approvals.

### What you must NOT do

- **Do not** `git commit` directly to `main`. Always work on a feature branch.
- **Do not** `git push origin main` of a commit that wasn't produced by `stamp merge`.
- **Do not** use `--no-verify` to skip hooks.
- **Do not** edit `.stamp/config.yml` or `.stamp/reviewers/*.md` outside the stamp
  review/merge cycle. Those changes go through the same reviewer gate.
- **Do not** rationalize bypassing the gate because "this is local-only mode
  so it doesn't matter." The mode describes who enforces the gate
  (server vs. agent discipline), not whether the gate exists. **The gate exists.**

### The one exception: the bootstrap commit

When `stamp init` runs on a repo that doesn't have stamp installed yet, the
commit that ADDS `.stamp/` + `AGENTS.md` + `CLAUDE.md` is a chicken-and-egg
case — there is no prior trusted state to review against, so `stamp review`
has no meaningful base. That single commit is allowed to land directly on the
current branch. Recent versions of stamp-cli handle this commit automatically
inside `stamp init`; if you're working with an older version, make exactly
that one commit + push by hand and then go through the stamp flow for
everything afterward. **This exception is for the literal first stamp commit
only**, not for any subsequent change to `.stamp/` or any other code.

### How enforcement works here (and why you have to be the enforcer)

This repo's origin is a public forge (GitHub / GitLab / etc.) directly, not a
stamp server with a pre-receive hook. So:

- The remote will accept any push, including unsigned ones, force-pushes, and
  direct GitHub web-UI merges.
- The reviewer prompts and config in `.stamp/` are committed code-as-policy,
  not server-enforced rules.
- **The agent following these instructions is the gate.**

If the operator wants real server-side enforcement, they need to migrate to a
stamp server: deploy [stamp-cli's server image](./docs/quickstart-server.md),
repoint `origin` at it, configure GitHub as a downstream mirror with a Ruleset
locking direct pushes, and regenerate this guidance via
`stamp init --mode server-gated`. Until that happens, the rules above are
mandatory but unenforced — your job is to follow them anyway.

`stamp verify <sha>` works on any clone to validate a merge commit's
attestation, so the audit trail is preserved even without server-side rejection.

### Where things live

- `.stamp/config.yml` — branch rules (which reviewers are required, optional `required_checks`)
- `.stamp/reviewers/*.md` — reviewer prompt files
- `.stamp/trusted-keys/*.pub` — Ed25519 public keys (would be enforced by a server hook if one existed)
- `~/.stamp/keys/ed25519{,.pub}` — your local signing keypair

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
