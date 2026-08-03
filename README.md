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
[`pipeline`](https://github.com/IvanMurzak/pipeline-claude) CLI (from the
`ai-pipeline` Claude Code plugin) to match and drive runs
(`pipeline match`, `pipeline drive`). Install the plugin on any machine you
intend to register as a runner so `pipeline` resolves on PATH before running
`register`/`start`.

## Usage

```sh
# one-time: store identity + validate the credential against the control plane
bun src/cli.ts register --url <base-url> --token <runner-token> \
    [--label repo:acme/api]... [--capacity 2] [--store-only]

# ...or register with OAuth client credentials instead of a plaintext token
bun src/cli.ts register --url <base-url> \
    --client-id <runner-id> --client-secret <secret>

# migrate an already-registered runner onto OAuth client credentials
bun src/cli.ts set-credentials --client-id <runner-id> --client-secret <secret>

# run the runner loop (connect, register, heartbeat, reconnect, accept jobs)
bun src/cli.ts start

# inspect the stored identity (credentials redacted)
bun src/cli.ts status

# install/uninstall/status as a native OS service
bun src/cli.ts service <install|uninstall|status> [--dry-run]

# start / stop / restart an ALREADY-INSTALLED service, without re-registering it
bun src/cli.ts service <start|stop|restart> [--name <n>] [--home <path>]

# department runtime bindings — what this machine will actually execute
bun src/cli.ts bind --department <id> --command <cmd> [--arg=<a>]... \
    [--adapter <id>] [--cwd <path>] [--lifecycle <l>] [--spec <json>]
bun src/cli.ts unbind --department <id>
bun src/cli.ts bindings [--json]

# what this machine has recorded for one department (local read, never ships)
bun src/cli.ts journal --department <id> [--json] [--limit <n>]
```

`register` flags:

| Flag | Required | Meaning |
|---|---|---|
| `--url <base-url>` | yes | Control-plane base URL, e.g. `https://api.ai-pipeline.dev`. |
| `--token <runner-token>` | one of | Scoped runner token issued by the control plane. |
| `--client-id <id>` + `--client-secret <s>` | one of | OAuth client credentials for this runner (see below). `--client-id` is the runner id. |
| `--label <k:v>` | no, repeatable | Matchable label, e.g. `--label repo:acme/api`. `os:<detected>` is always added. |
| `--capacity <n>` | no | Max parallel runs this runner accepts (positive integer). |
| `--cli-version <v>` | no | Detected `pipeline` CLI version, for server-side compatibility checks. |
| `--plugin-version <v>` | no | Detected `ai-pipeline` plugin version, or omit if not installed. |
| `--store-only` | no | Store the identity but skip the one-time connect-and-validate step. |

### Registering with OAuth client credentials

A runner can register with a short-lived OAuth `runner:register` token instead
of a plaintext long-lived runner token. The control plane issues the credential
pair (`clientId` = the runner id, `clientSecret` shown once) when the runner is
minted, or on demand from `POST /api/v1/runners/:id/oauth-credentials`. The
runner then exchanges them at `POST /oauth/token`
(`grant_type=client_credentials`, `scope=runner:register`) on every connect and
puts the resulting token on the register frame.

| Env var | Meaning |
|---|---|
| `PIPELINE_RUNNER_OAUTH_CLIENT_ID` | Alternative to `--client-id`. |
| `PIPELINE_RUNNER_OAUTH_CLIENT_SECRET` | Alternative to `--client-secret` — keeps the secret out of argv and shell history. |

**Nothing breaks if you do not do this.** A runner with no client secret keeps
using its runner token, and the control plane keeps accepting it. Even a runner
that *has* client credentials falls back to its runner token whenever the token
exchange cannot complete — endpoint unreachable, credential refused, malformed
response, slow — so migrating can never leave a runner unable to register.

The runner token is **kept, not replaced**: `register` carries an existing one
forward when you do not pass `--token`, and says so. It is removed only by the
explicit `set-credentials --drop-token`, which you should run once the control
plane's `GET /api/v1/runners/credential-window` reports this runner clear.

The `PIPELINE_RUNNER_OAUTH_*` variables are read by `register` only when you
also pass `--client-id` or `--client-secret` on the command line, so exporting
them cannot attach credentials to an unrelated `register --token`.
`set-credentials`, whose whole purpose is installing them, always reads them.

`set-credentials` flags:

| Flag | Required | Meaning |
|---|---|---|
| `--client-id <id>` | yes | The runner id (the OAuth `client_id`). Env: `PIPELINE_RUNNER_OAUTH_CLIENT_ID`. |
| `--client-secret <s>` | yes | The OAuth client secret. Env: `PIPELINE_RUNNER_OAUTH_CLIENT_SECRET`. |
| `--drop-token` | no | Also remove the legacy runner token from the config. Removes the fallback — only do this once the credential-window report is clear. |
| `--home <path>` | no | Which isolated runner home to migrate, when several runners share this host. |

`service install` supports `--dry-run` to print the generated systemd
unit / launchd plist / `sc.exe create` + `sc.exe failure` commands without
touching the system.

### `service start` / `stop` / `restart`

`install` **registers** the service (and on a re-run stop+deletes+recreates it,
which needs an elevated shell on Windows). Use these when the service is
already installed and you just want it up, down, or bounced:

| Verb | Not installed | Already in that state | Otherwise |
|---|---|---|---|
| `start` | **fails**, naming `service install` | success, "already running" | starts it, then **re-queries** and refuses to report success it did not observe |
| `stop` | success, "nothing to stop" | success, "already stopped" | stops it, keeping it installed |
| `restart` | **fails**, naming `service install` | — | stop then start, verified the same way |

Notes worth knowing before you rely on the exit code:

- A failure that is genuinely a **privilege** problem says so (Windows exit 5,
  launchd's "Operation not permitted"); one that is not, does not.
- Windows `START_PENDING` / `STOP_PENDING` and a launchd agent that is loaded
  but has not been given a pid yet are reported as **inconclusive**, not as
  success. Re-check with `service status`.
- On macOS, `stop` **unloads** the agent (`launchctl unload -w`): `install`
  writes `KeepAlive`, so a plain `launchctl stop` would be relaunched
  instantly. The plist is kept, and the agent stays down until `service start`.
- `stop` does not disable a systemd unit or a Windows service — both come back
  at the next boot. `service uninstall` is what removes them.

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

## Department runtime bindings

A **binding** says which `department_id` this machine will execute and how. It
is the local half of a department: the control plane holds the advertised
manifest and structurally refuses to store `command` / `args` /
`workingDirectory` / `environment`, so nothing remote can change what runs
here.

```sh
bun src/cli.ts bind --department 018f…-uuid --command unity-department --arg=--stdio
bun src/cli.ts bindings
bun src/cli.ts unbind --department 018f…-uuid
```

Bindings live in `departments.json` next to `config.json` (so
`PIPELINE_RUNNER_HOME` isolates them per instance), written mode `0600` inside
a `0700` directory. **A running runner re-reads the file** — on a filesystem
watch, on `SIGHUP` (POSIX), and on a slow safety-net poll — so binding or
unbinding a department takes effect without a restart. Unbinding stops new
offers being accepted; executions already running are left to finish.

Everything about the file **fails closed**: missing, unreadable, not JSON, the
wrong shape, an `apiVersion` this runner does not know, or a file that is
group-/world-writable or owned by another account all resolve to *no
departments configured*, with the reason stated in the log. A broken or
half-written file can therefore only ever narrow what this machine runs, never
widen it. (On Windows POSIX modes are meaningless, so the per-user profile ACL
is the control there — the same posture `config.json` has always had.)

`bindings` exits non-zero when the store is refused, so a script can tell.

`--adapter` is checked against this build's own engine registry
(`src/department/engine.ts`), and an adapter this runner has no module for is
**refused**, naming the ones it has — `claude-code`, `container`,
`jsonl-process` (`engine: process`), `pipeline-drive` (`engine: pipeline`).
Before this, `bind` stored whatever string it was given, so a wrong id produced
a stored binding, a success line, and a `capability` reject on the first task
that ever arrived. Callers can therefore stop mirroring this table and just ask.

### What the runner puts in a department session's environment

When the runner can mint an execution token for a task, it injects the
department MCP connection into the spawned process's environment — that is the
whole of "point a model-driven runtime at `/mcp`". A JSONL runtime is free to
ignore these; an MCP-speaking one becomes its own client with nothing else.

| Variable | Meaning |
|---|---|
| `PIPELINE_DEPARTMENT_MCP_URL` | The department MCP endpoint for this execution. |
| `PIPELINE_DEPARTMENT_EXECUTION_TOKEN` | A short-lived, audience-restricted bearer for it. Never logged, never on a command line. |
| `PIPELINE_DEPARTMENT_HELPER_URL` | Loopback endpoint that hands back a FRESH token, so a session outliving its token keeps its tools. |
| `PIPELINE_DEPARTMENT_HELPER_SECRET` | Per-execution secret authorizing exactly that one call. Never logged, never on a command line. |

All four are injected only when the runner actually has something to inject:
no registration, no execution token, or a refused loopback grant each mean the
corresponding variables are simply absent, and every shipped engine tolerates
that.

**These were named `PIPELINE_MESH_*` before.** For the duration of the rename
window the runner sets **both** spellings on every spawn, pointing at the same
values, and reads the new name first and the old one as a fallback. A runtime
written against either generation keeps working, with no flag and no
configuration. The old names will be dropped in a later release that says so.

### `PIPELINE_RUNNER_DEPARTMENTS` is deprecated

The old environment variable still works, unchanged, **when no binding file
exists** — and it now prints a deprecation warning. It is boot-time immutable
by construction: a runner configured that way cannot learn about a new
department without a restart, which is the whole reason the file exists.

If a binding file exists, the file is the **sole authority** and the variable
is ignored with a warning naming both. There is no merge: a security-critical
answer gets one author.

## `journal` — what this machine ran for a department

```sh
bun src/cli.ts journal --department 018f…-uuid --json
```

Reads the per-department **admission index** the runner writes under its data
dir and prints, per execution, who addressed the task (`sender`), which engine
ran it, when, and where that execution's own journal is. `--json` is a stable
contract: every documented key is always present, `null` where a value is
genuinely absent.

It exists because a reader in another package has to resolve the runner's data
dir **as the invoking user**, which finds nothing when the runner runs as a
service under a different OS account — the shape `service install` produces on
Windows, where the SCM defaults to `LocalSystem`. This command additionally
reads the *installed service definition*: it follows a `--home` the definition
pins, and when it still finds nothing it names the account that owns the
journal instead of reporting an unexplained blank.

`--json` keys (all always present):

| Key | Meaning |
|---|---|
| `schema` | Version of this output shape. Adding a key is additive and does not move it. |
| `department_id` | The id that was asked about. |
| `status` | `ok` \| `absent` \| `unreadable` \| `unlocatable`. |
| `message` | Why, for a non-`ok` status; `null` when there is nothing to explain. |
| `path` | The index file read (or that would have been); `null` only when nothing could be located. |
| `home_source` | Which home answered: `flag` \| `env` \| `service` \| `default` \| `none`. |
| `executions[]` | `run_id`, `task_id`, `context_id`, `sender`, `engine`, `ts`, `journal_path` — append-ordered, oldest first. |
| `tasks{}` | `task_id` → `{ sender, engine, run_id, ts }` for its **most recent** execution. |
| `counts` | `{ executions, skipped, limit, truncated }`. `skipped` counts unparseable lines (a truncated last line after a hard kill). |
| `supervisor` | The installed definition's `{ backend, installed, home, account, systemAccount, note }`, or `null` when no probe was needed. |

Exit codes: **0** for a journal that was read *and* for one that is simply not
there (never having served a department here is a normal state); **1** when the
file exists but cannot be read, or the data dir cannot be resolved at all. The
JSON is printed in every case, so the reason is always machine-readable.

**Privacy.** This is a local read of a file already on this machine, printed to
the stdout of a process you started. It reads only the admission index — not
the per-execution journals — so no message body, question, artifact, or failure
reason is reachable through it. `sender` appears in the clear here because that
is what is on disk; the *shipping* path fingerprints it (`src/shipper/privacy.ts`
maps `sender: 'fingerprint'`), so what leaves the machine at the metadata tier
is `fp:<sha256-16>` and never the identity. This command writes nothing, ships
nothing, and stores no field that was not already being stored.

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
your dashboards see every runner you have in one place. Records are tagged
`origin: "dispatched" | "local"` so analytics can tell them apart. Late token
enrichment is picked up by a periodic rescan (14-day window per record) and
re-synced as a superseding revision of the same record.

Retention note: the runner remembers which run records it has already sent for
as long as those records stay inside the 14-day rescan window, and forgets them
afterwards. That bookkeeping is deliberately independent of its other state
bounds — forgetting a record the watcher can still see would make an
already-synced run look brand new and send it a second time.

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
src/service/             # OS service install/uninstall/status/start/stop/restart
                         #   (systemd/launchd/Windows) + inspect.ts: read the INSTALLED
                         #   definition (pinned home, service account)
src/department/bindings.ts # file-backed, reloadable department runtime bindings
src/department/engine.ts   # the engine registry — what `bind --adapter` is checked against
src/department/journal-read.ts # `journal`: the local department journal, read back
src/cli.ts               # thin CLI: register / start / status / service / bind / journal
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
