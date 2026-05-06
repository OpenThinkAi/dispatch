# dispatch

Auto-route GitHub issues into [oteam](https://www.npmjs.com/package/@openthink/team) vaults.

A launchd-driven Bun CLI that polls every configured GitHub repo on a
fixed interval, runs each new issue through a small Claude triage call,
holds anything flagged as a security risk, and otherwise files the issue
into the configured vault project via `oteam pull github`. Optionally
writes labels back to the issue for repos where you have write access.

The vault's existing role pipeline (`oteam assign`) handles deeper triage
downstream. dispatch's job ends at the pull — it gets new work in front
of the agents that will pick it up.

Part of the [OpenThink](https://openthink.dev) suite.

## What it does

```
gh poll → for each new issue:
  ├── Claude pre-filter → { summary, security_flag, label_hints }
  ├── if security_flag → osascript notify, write to security-inbox/, skip pull
  └── else → oteam pull github <url> --vault X --project Y
              + gh issue edit --add-label … (where can_label = true)
```

## Prerequisites

- macOS, Bun ≥ 1.3
- [`gh`](https://cli.github.com) logged in (`gh auth status`)
- [`@openthink/team`](https://www.npmjs.com/package/@openthink/team) (`oteam`)
  on PATH with the target vaults registered (`oteam config vault add ...`)
- A `triage-inbox` project (or whatever you configure) already in each
  vault — dispatch never auto-creates projects:
  ```sh
  oteam project init triage-inbox --vault <vault> --no-edit
  ```
- A Claude account — either Claude Code logged in (`claude /login`) or an
  `ANTHROPIC_API_KEY` env var. The triage call uses the
  [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
  which prefers the local Claude Code login and falls back to the API key.

## Install

```sh
git clone git@github.com:OpenThinkAi/dispatch ~/Development/dispatch
cd ~/Development/dispatch
bun install
bun run typecheck                       # sanity

# detect paths, write the launchd plist, seed the config from the example
bun src/cli.ts setup

# put `dispatch` on PATH
mkdir -p ~/.local/bin
ln -s "$PWD/bin/dispatch" ~/.local/bin/dispatch

# edit your config
$EDITOR ~/.config/dispatch/dispatch.toml

# verify and smoke-test before bootstrapping the timer
dispatch config validate
dispatch process https://github.com/<your-org>/<your-repo>/issues/<n>
# (no API key needed if Claude Code is logged in)

# bootstrap the launchd timer
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.${USER}.dispatch.plist
```

## Configuration

`~/.config/dispatch/dispatch.toml`:

```toml
[defaults]
state_dir              = "~/.local/state/dispatch"
log_dir                = "~/Library/Logs/dispatch"
poll_interval_minutes  = 5
triage_model           = "claude-haiku-4-5-20251001"
body_truncate_chars    = 8000

[[repo]]
slug      = "myorg/my-app"
vault     = "my-vault"          # must be registered with `oteam config vault`
project   = "triage-inbox"      # must already exist in <vault>
can_label = true                # may dispatch write labels back to the issue?
```

`dispatch config validate` cross-checks every `(vault, project)` pair
against `oteam project list` and refuses to start if anything is
missing. Use `--no-vault-check` to skip the cross-check (structural
parse only).

`[defaults]` controls the state directory, log directory, polling
cadence, the model used for triage, and the body-truncate length passed
to the model. Everything has reasonable defaults — most setups only need
to add `[[repo]]` blocks.

### Routing model

The recommended default is **a single `triage-inbox` project per vault**:
every repo funnels into it, and the vault's role pipeline (`oteam assign`)
re-files into active work streams. Tickets keep their `source_repo`
metadata so you can slice the inbox by repo (`oteam list --grep <repo>`).

For repos with active, well-defined work streams, override the project
on a per-repo basis to route directly:

```toml
[[repo]]
slug    = "myorg/critical-thing"
vault   = "my-vault"
project = "critical-thing-launch"   # must exist
can_label = true
```

## Day-to-day

| Situation | What you do |
| --- | --- |
| Add or remove a repo | edit `dispatch.toml`; next tick picks it up — no restart |
| Issue didn't get filed | `tail -f ~/Library/Logs/dispatch/stdout.log` |
| Manually triage one issue | `dispatch process <url>` |
| See what's been processed | `dispatch state show` |
| Pause | `launchctl bootout gui/$(id -u)/com.${USER}.dispatch` |
| Re-enable | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.${USER}.dispatch.plist` |

## State

```
~/.local/state/dispatch/
  cursors.json              # { "owner/repo": "ISO timestamp last consumed" }
  seen.sqlite               # (slug, number) → vault_ticket_id, content_hash
  security-inbox/           # one .md per held issue; review and `dispatch process` to retry
```

**First-run behavior:** when dispatch sees a repo for the first time, it
seeds the cursor to *now* and ingests *nothing* historical. To backfill,
edit `cursors.json` and write an *older* timestamp for the slug, then
run `dispatch poll`. (Just deleting the entry re-seeds it forward — the
absent-cursor path always seeds to *now* to avoid floods.)

## Security flag

If the triage model flags an issue as `secret-leak`, `vuln-disclosure`,
`pii`, or `abuse`:

- The vault is **not** filed (avoid leaking secrets into a synced
  markdown tree).
- Labels are **not** applied (don't tip off attackers via a public label).
- A redacted markdown file lands in `~/.local/state/dispatch/security-inbox/`.
- A macOS notification fires.
- Operator triages manually. To file after redaction, copy the relevant
  content into the vault by hand.

The redaction is a defence-in-depth pass over obvious token shapes
(`ghp_…`, `sk-…`, PEM blocks, long hex). It is not a robust scrubber.

## Multiple machines

Two machines both running dispatch against the same repos = duplicate
vault tickets and merge conflicts (the vault is git-synced; both
machines will write the same ticket from different cursors).

The expected pattern is **one machine bootstrapped, others ready**:

- Clone the repo and run `bun src/cli.ts setup` on each machine.
- Only run `launchctl bootstrap` on the machine you treat as primary.
- To switch primary: `launchctl bootout` on old, `launchctl bootstrap`
  on new. Don't copy `seen.sqlite` between them; cursors will diverge
  briefly until both machines have polled, which is fine.

## Debugging

```sh
# what did launchd just do?
tail -f ~/Library/Logs/dispatch/stdout.log
tail -f ~/Library/Logs/dispatch/stderr.log

# verify the plist's PATH includes bun, gh, oteam
plutil -p ~/Library/LaunchAgents/com.${USER}.dispatch.plist | grep -A1 PATH

# run the same thing launchd runs, manually, with debug logging
DISPATCH_DEBUG=1 dispatch poll

# typecheck after edits
bun run typecheck
```

## Project layout

```
src/
  cli.ts              # command dispatch
  config.ts           # TOML loader + zod validation
  state.ts            # cursors.json + bun:sqlite seen table
  github.ts           # gh api wrappers
  triage.ts           # Claude call + JSON parse
  poll.ts             # main loop (pollOnce, processIssue)
  setup.ts            # `dispatch setup` — path detection + plist render
  log.ts              # structured JSON logging
  types.ts            # shared types
  sinks/
    vault.ts          # oteam pull + project ensure
    labels.ts         # gh issue edit --add-label
    security.ts       # osascript notify + on-disk inbox
dispatch.toml.example # generic illustration of the config schema
bin/dispatch          # bash shim → bun src/cli.ts
```

## Known gotchas

- **dispatch never auto-creates vault projects.** If a configured project
  is missing, `dispatch config validate` reports it and the runtime
  refuses to file. Run `oteam project init <project> --vault <vault>
  --no-edit` to create what's missing.
- **`oteam pull` accepts URLs in the form
  `https://github.com/owner/repo/issues/N`.** If your version of `oteam`
  expects a different ref form, the vault sink will need adjustment.
- **`gh issue edit --add-label` requires the label to exist on the repo.**
  Triage suggests labels from a small standard set; if the repo doesn't
  have those labels, the apply silently fails (logged as a warning).
- **The launchd plist's PATH is rendered once at `dispatch setup` time.**
  If you switch node versions via nvm, or move `bun`/`gh`/`claude`/`oteam`
  to a different prefix, re-run `dispatch setup --force` to regenerate.

## License

MIT
