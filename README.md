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
unit / launchd plist / `sc.exe create` command without touching the system.

Identity is stored at `%APPDATA%\pipeline-runner\config.json` (Windows) or
`$XDG_CONFIG_HOME/pipeline-runner/config.json` (elsewhere; `~/.config`
fallback) with restrictive file permissions where the OS supports them. The
runner token is a secret: it is persisted (it is the runner's credential) but
never logged.

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

`src/core/wire.ts` (and the smaller vendored copies under `src/jobs/wire.ts`,
`src/relay/wire-relay.ts`, `src/shipper/wire-ingest.ts`) are hand-rolled
copies of the control plane's wire protocol, kept in sync by hand. They will
be replaced by the published `@baizor/protocol` npm package once it ships;
until then, treat these files as the source of truth for this repo only.

## Develop

```sh
bun install
bun test            # unit tests (no network, no real home dir)
bun run typecheck   # bunx tsc --noEmit
```

---

Formerly `apps/pipeline-agent` in [`IvanMurzak/Claude-Pipeline`](https://github.com/IvanMurzak/Claude-Pipeline); extracted to this standalone repo and renamed to `pipeline-runner`.
