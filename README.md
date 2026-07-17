# pipeline-runner

Standalone, long-running runner daemon for [ai-pipeline.dev](https://ai-pipeline.dev):
install it on a machine to execute cloud-dispatched pipeline runs. It dials
OUT to the control plane's `/agent/v1` WSS channel (no inbound ports),
registers with a scoped runner token, heartbeats, accepts job leases, checks
out an isolated workspace, drives the run through the `pipeline` CLI, ships
events back, and relays `needs_input` prompts. It can also install itself as
a native OS service (systemd on Linux, launchd on macOS, a Windows Service).

## Prerequisite: the `pipeline` CLI must be on PATH

The runner does not execute pipelines itself — it shells out to the
[`pipeline`](https://github.com/IvanMurzak/ai-pipeline-plugin) CLI (from the
`ai-pipeline` Claude Code plugin) to match and drive runs
(`pipeline match`, `pipeline drive`). Install the plugin on any machine you
intend to register as a runner so `pipeline` resolves on PATH before running
`register`/`start`.

## Usage

```sh
# one-time: store identity + validate the token against the control plane
bun src/cli.ts register --url <base-url> --token <runner-token> \
    [--label repo:acme/api]... [--capacity 2] [--store-only]

# run the runner loop (connect, register, heartbeat, reconnect, accept jobs)
bun src/cli.ts start

# inspect the stored identity (token redacted)
bun src/cli.ts status

# install/uninstall/status as a native OS service
bun src/cli.ts service <install|uninstall|status> [--dry-run]
```

`register` flags:

| Flag | Required | Meaning |
|---|---|---|
| `--url <base-url>` | yes | Control-plane base URL, e.g. `https://api.ai-pipeline.dev`. |
| `--token <runner-token>` | yes | Scoped runner token issued by the control plane. |
| `--label <k:v>` | no, repeatable | Matchable label, e.g. `--label repo:acme/api`. `os:<detected>` is always added. |
| `--capacity <n>` | no | Max parallel runs this runner accepts (positive integer). |
| `--cli-version <v>` | no | Detected `pipeline` CLI version, for server-side compatibility checks. |
| `--plugin-version <v>` | no | Detected `ai-pipeline` plugin version, or omit if not installed. |
| `--store-only` | no | Store the identity but skip the one-time connect-and-validate step. |

`service install` supports `--dry-run` to print the generated systemd
unit / launchd plist / `sc.exe create` + `sc.exe failure` commands without
touching the system.

### Reboot/logout recovery of the installed service

Crash-resume (below) only helps if the daemon actually comes back after it
dies — `service install` now also configures the OS side of that, per
platform:

- **Linux (systemd, user unit):** install additionally runs
  `loginctl enable-linger` so the user's systemd instance — and this unit —
  keeps running after logout and starts again at boot, without an active
  login session. This is best-effort: if lingering can't be enabled (e.g. no
  polkit/D-Bus permission in a locked-down or containerized session), install
  still succeeds — a warning names the exact command to run yourself:
  `loginctl enable-linger "$USER"`.
  **System-unit alternative:** for boot-level start that does not depend on
  lingering at all, run the daemon as a root SYSTEM unit instead: copy the
  `[Unit]`/`[Service]` block from `service install --dry-run` into
  `/etc/systemd/system/pipeline-runner.service` (drop the user-only
  `WantedBy=default.target` line in favor of `multi-user.target` if you want
  it before any login), then `sudo systemctl enable --now
  pipeline-runner.service`. This is a manual step — `service install` never
  requests elevation and does not manage system units itself.
- **Windows (SCM):** install additionally runs
  `sc.exe failure <name> reset= 86400 actions= restart/5000`, so the Service
  Control Manager restarts the process 5s after a crash (the failure counter
  resets after 24h of uninterrupted uptime). `sc.exe create ... start= auto`
  alone — what this backend did before — starts the service at boot but
  configures NO recovery action, so the SCM never restarted a crashed
  process. Verify the configured recovery action with
  `sc.exe qfailure pipeline-runner`.
- **macOS (launchd, LaunchAgent):** `RunAtLoad` + `KeepAlive` restart the
  daemon on crash and at LOGIN, but explicitly **not at boot** before anyone
  logs in — there is no root LaunchDaemon (`/Library/LaunchDaemons`) support
  yet; that option is deferred. `service install` prints this caveat. A
  headless Mac with auto-login is unaffected; one that waits at the login
  window after a reboot will not run the runner until someone logs in.

### Transcript retention (crash-resume requirement)

Crash-resume below re-enters a pinned Claude Code step session mid-thought by
reading its transcript. Claude Code prunes transcripts older than
`cleanupPeriodDays` (default 30) at the startup of ANY `claude` process on the
host — independent of this runner. On any machine that runs
`pipeline-runner` as a service, set `cleanupPeriodDays >= 14` in Claude
Code's settings: the control plane parks an unanswered `awaiting_input` run
for up to 14 days before ending it `abandoned-needs-input`, so the transcript
must outlive that whole window or a resumable crash silently becomes an
UNRECOVERABLE one (record dropped, `run_status halted`) the next time the
runner reconciles.

### Crash resume + workspace retention

A daemon death never loses a run: every accepted job persists a durable
record under the runner DATA dir (`%LOCALAPPDATA%\pipeline-runner\jobs\` on
Windows, `$XDG_STATE_HOME/pipeline-runner/jobs/` elsewhere — no secrets, the
job JWT is never written to disk). On `start` the runner reconciles those
records BEFORE connecting: a record younger than its lease TTL resumes
in-place (`pipeline drive --resume` in the recorded checkout — pause windows
restored, parked questions re-surfaced); an older one is QUARANTINED and only
resumed when the control plane re-offers the run (`resume_hint` lease →
adoption in the recorded checkout) or discarded on `cancel`; a record whose
resume substrate is gone (checkout / `next.json` / claude session transcript
deleted) is dropped with a `run_status halted`. `SIGTERM`/`SIGINT` drain
gracefully: stop accepting leases, persist records, terminate drive children
(their per-step state is durable), flush the event spool, exit 0. (Windows:
an SCM `stop` is a hard terminate — that is fine; hard death is the design's
baseline assumption.)

Terminal workspaces (completed / cleanly halted / cancelled runs) are deleted
by default. Environment knobs:

| Variable | Meaning |
|---|---|
| `PIPELINE_RUNNER_WORKSPACE_RETENTION=<dur>` | Keep terminal workspaces for a window (`30s`, `15m`, `12h`, `7d`, or plain seconds); a boot-time + hourly GC reaps expired ones. |
| `PIPELINE_RUNNER_KEEP_WORKSPACES=1` | Never delete workspaces or job records (infinite retention, GC off). |

Quarantined crash leftovers that no re-offer ever claims are reaped after
14 days (or the configured retention window, whichever is longer).

Identity is stored at `%APPDATA%\pipeline-runner\config.json` (Windows) or
`$XDG_CONFIG_HOME/pipeline-runner/config.json` (elsewhere; `~/.config`
fallback) with restrictive file permissions where the OS supports them. The
runner token is a secret: it is persisted (it is the runner's credential) but
never logged.

## Run-stats sync and the `sync_local_stats` flag

A registered runner syncs per-run **statistics records** to the control plane
through its event shipper: durations, step statuses/outcomes, token and cost
counts, tool-call/failure counts, model/effort ids — **metrics only, never
transcripts, prompts, code, file contents, or error text**. Tool-failure
entries are stripped down to the tool name, step id and count before anything
leaves the machine; the failure's error excerpt text never ships, on any
privacy tier. Every record is validated against the published
`@baizor/pipeline-protocol` `RunRecordStatsSchema` before it is buffered or
uploaded.

**Disclosure (shown at runner registration):** on a machine registered as a
runner, this covers *cloud-dispatched* runs **and** pipeline runs you start
*locally* on that machine — local-run metric sync is **on by default** so
your dashboards see your whole fleet's activity. Records are tagged
`origin: "dispatched" | "local"` so analytics can tell them apart. Late token
enrichment is picked up by a periodic rescan (14-day window per record) and
re-synced as a superseding revision of the same record.

Opt out of local-run sync at any time with `sync_local_stats=0` — set the
environment variable `PIPELINE_SYNC_LOCAL_STATS=0` for the runner process
(cloud-dispatched runs keep syncing; they are the product's job telemetry).
Unrecognized values fail toward privacy (treated as opt-out). The broader
privacy tier of the event stream is governed separately by
`PIPELINE_PRIVACY_TIER` (default `metadata` — content never leaves the
machine).

## Layout

```
src/core/wire.ts        # vendored wire-protocol subset (see header) — envelope,
                         # register/register_ack/register_reject, heartbeat/heartbeat_ack
src/core/config.ts       # identity/config store (injectable fs + path)
src/core/register.ts     # register frame build + ack/reject interpretation
src/core/backoff.ts      # exponential backoff + bounded jitter, capped
src/core/dispatcher.ts   # inbound frame router (log-and-ignore for future types)
src/core/heartbeat.ts    # heartbeat loop (injectable clock; ack pairing; directives)
src/core/transport.ts    # transport seam: WSS primary + provisional long-poll fallback
src/core/connection.ts   # the connection state machine tying it all together
src/dispatch/            # task-dispatch pipeline resolution (`pipeline match`)
src/jobs/                # lease -> accept -> workspace -> `pipeline drive`
src/shipper/             # event shipper: tails run artifacts, batches, uploads
src/relay/               # needs-input relay over the WSS channel
src/service/             # OS service install/uninstall/status (systemd/launchd/Windows)
src/cli.ts               # thin CLI: register / start / status / service
```

## Wire protocol

The wire protocol comes from the published
[`@baizor/pipeline-protocol`](https://www.npmjs.com/package/@baizor/pipeline-protocol)
npm package (repo [`IvanMurzak/pipeline-protocol`](https://github.com/IvanMurzak/pipeline-protocol))
— zod schemas + inferred TS types, additive-only within a protocol major.
`src/core/wire.ts`, `src/jobs/wire.ts`, `src/relay/wire-relay.ts`, and
`src/shipper/wire-ingest.ts` are thin re-export seams over it: they keep the
runner's internal import paths stable and hold the few runner-local helpers
(frame builders, deliberately tolerant inbound guards) the package does not
provide.

## Develop

```sh
bun install
bun test            # unit tests (no network, no real home dir)
bun run typecheck   # bunx tsc --noEmit
```

---

Formerly `apps/pipeline-agent` in [`IvanMurzak/Claude-Pipeline`](https://github.com/IvanMurzak/Claude-Pipeline); extracted to this standalone repo and renamed to `pipeline-runner`.
