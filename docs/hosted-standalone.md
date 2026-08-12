# Hosted `standalone` — what is guaranteed, and what is not

Task `f1-runner-standalone-select`
(`.taskflow/2026-08-03-execution-modes/`, decisions E3 / E9 / E13).

A **hosted** run is one executing on *our* hardware rather than a user's
machine. There is no user's Claude Code installation there, no user's
subscription and no user's configuration, so `standalone` — our own drive loop
plus the Agent SDK executor — is the only mode that can run (E3).

This page records what the runner enforces today, **and the two preconditions
it does not enforce**, so neither is later mistaken for a guarantee.

**Status as of 2026-08-12: both preconditions below are WAIVED, not met.** The
owner reviewed them and cleared hosted `standalone` to ship with the exposure
unchanged — see §5 for the decision. The findings in §2 and §3 remain accurate
and are unchanged by that decision.

---

## 1. What the runner enforces

Everything here lives in [`src/jobs/standalone.ts`](../src/jobs/standalone.ts)
and is proven by [`src/jobs/standalone.test.ts`](../src/jobs/standalone.test.ts).

| Guarantee | Mechanism |
| --- | --- |
| The run executes with `--executor=claude-sdk` | `HOSTED_EXECUTOR`, emitted on **every** invocation — start, resume and answer |
| The provider key is the **org's** | `hostedDriveEnv` sets `ANTHROPIC_API_KEY` explicitly; it is never inherited |
| An ambient `ANTHROPIC_API_KEY` is never used | the same set, which replaces whatever the machine carried |
| A machine-configured key **helper** cannot win | `PIPELINE_API_KEY_HELPER` is unset — see below, this is the easy one to miss |
| No org key ⇒ **no run** | `resolveHostedCredential` throws; no process is spawned |
| The key reaches no log | an off-object holder (`WeakMap`) + `redactingLogger` |
| An **explicit** `runner: session`/`manager`/`driver` is refused before any resource is provisioned | task `f2-reject-nonstandalone` — [`src/jobs/hosted-mode.ts`](../src/jobs/hosted-mode.ts) / [`hosted-mode.test.ts`](../src/jobs/hosted-mode.test.ts) |

### f2 — rejecting a declared non-`standalone` runner

`session` and `manager` need an interactive Claude Code session on our server;
`driver` needs the user's own Claude Code installation and subscription on our
hardware. None of the three can run here (E3), so `driveLoop` refuses them
before resolving the org credential or spawning any process — see
`assertHostedRunnerAllowed` in `hosted-mode.ts`.

The one thing worth restating here because it is easy to get backwards: the
CLI's own `pipeline plan`/`Manifest.runner` **already defaults an absent
`runner:` key to `'manager'`** (E10). Reading that resolved value would reject
every ordinary hosted pipeline that never mentioned `runner:` at all — exactly
the "accidental gate" the DoD forbids. `hosted-mode.ts` therefore reads the
manifest **source** (`pipeline.yml`, or v1 `PIPELINE.md` frontmatter) directly
through `JobFs.readFile`, so it can tell an EXPLICIT `manager` apart from an
absent key — only the former is refused. No flag or environment variable
relaxes this (`hosted-mode.test.ts` plants bypass-shaped env vars and proves
they change nothing).

### Why the environment, and not `--api-key`

The CLI's key ladder (c1, `pipeline`'s `src/lib/provider-key.ts`) is, first
match wins:

1. `--api-key <value>` — argv
2. `PIPELINE_API_KEY_HELPER=<command>` — a command that prints a key
3. `ANTHROPIC_API_KEY` — the environment
4. the machine's own credential store

We deliver at **rung 3**, and c1's own header is the argument: a value passed on
the command line "is visible to `ps` … for as long as the process lives". On a
hosted runner that is disqualifying, because the thing running on that machine
is a pipeline step executing arbitrary code from a repository we did not write,
and `ps` is one shell-out away from it.

Delivering at rung 3 also means the runner adds **no second key path and no
second store** — it feeds the existing ladder rather than teaching the CLI a new
way to be handed a key.

### Rung 2 is the subtle one

`PIPELINE_API_KEY_HELPER` is an ordinary environment variable that sits **above**
the one we set. A helper configured on the machine would therefore outrank the
org key we just supplied and hand the run *somebody else's* credential — the
cross-tenant failure, through a door one rung up. The overlay unsets it.

Rung 4 is unreachable: rung 3 always matches on a hosted run, and when there is
no org key we never spawn at all.

### How c2's scrubber ends up armed

c2's output scrubber redacts values it has been *told*. c1 tells it: before the
ladder runs it reads `ANTHROPIC_API_KEY` and calls `registerSecret` on it
unconditionally — *"every key the ladder can produce in one run, not only the one
in use"*. Delivering the org key at rung 3 is therefore precisely what arms c2
against that value **inside the drive child**, where the SDK, its errors and its
stack traces live. Had we delivered by argv, the key would have arrived somewhere
c1 does not register from.

---

## 2. ⚠ Precondition NOT met — WAIVED 2026-08-12, see §5: `settingSources: ["project"]` cannot be pinned

**E9 asks for `settingSources: ["project"]` on hosted runs. This repository
cannot set it, and does not pretend to.**

The chain is: runner → spawns `pipeline drive` → `drive.ts` → `sdkDriveSeams()`
→ `sdk.ts` → the Agent SDK. `settingSources` is a **query option**, reachable
only in-process.

Evidence, in `public/package/pipeline` at the commit this task was built against:

- `src/lib/executors/sdk.ts` exposes `settingSources` and documents it as
  *"The hosted runner pins `['project']` instead — its own task."*
- `src/lib/executors/sdk-seams.ts` accepts it (`SdkSeamOptions` omits only
  `schema`, `agent` and `permissionMode`).
- **But `src/commands/drive.ts` never passes it** — it builds the seams as
  `sdkDriveSeams({ err, onToolCall, pluginDir })`, and a repo-wide search for
  `settingSources` / `--setting-sources` / `SETTING_SOURCES` in that package
  finds no CLI flag and no environment variable.

So there is no surface for an out-of-process caller. Consequences, stated plainly:

- **`user` and `local` scope are NOT closed on hosted runs today.** The SDK's
  documented default is equivalent to `["user", "project", "local"]`.
- The DoD item *"a test proves a planted `user`-scope agent is not loaded"* is
  therefore **not satisfied**. A test asserting it would be asserting something
  false.

`src/jobs/standalone.test.ts` carries a **tripwire** in its place: it asserts
the runner sends no setting-sources flag, so nobody can come to believe the
option is already being sent. **When the CLI gains the surface, replace that
test with the real planted-agent assertion.**

The fix belongs in `public/package/pipeline` — a `--setting-sources` flag (or
equivalent) on `drive`, forwarded into `sdkDriveSeams`. It is a one-line change
there and a one-line change here.

---

## 3. ⚠ Precondition NOT met — WAIVED 2026-08-12, see §5: there is no per-run *sandbox*

The task spec is explicit that project scope executes repository content —
`.claude/settings.json` can define hooks, and hooks are shell commands — and
that this is acceptable **only** inside a disposable per-run sandbox, which is
*"a precondition to assert, not an assumption to inherit"*.

### What IS true: the workspace is per-run and disposable

| Property | Evidence |
| --- | --- |
| One directory per job | `src/jobs/workspace.ts` — `<root>/<sanitized-job-id>` |
| A stale directory is wiped before reuse | `prepareWorkspace`: `if (fs.exists(dir)) fs.removeDir(dir)` |
| The checkout is fresh, never a shared clone | `git init` → `remote add` → `fetch --depth 1` → `checkout --detach FETCH_HEAD` |
| It is torn down at a terminal outcome | `src/jobs/manager.ts#teardownWorkspace` → `fs.removeDir(checkout_dir)`, called on terminal, cancel, unrecoverable, and by the retention GC |
| Immediate teardown is the **default** | `src/jobs/retention.ts#resolveRetentionPolicy` — `{keepForever:false, retentionMs:null}` |

Operators can extend that (`PIPELINE_RUNNER_WORKSPACE_RETENTION`) or disable it
(`PIPELINE_RUNNER_KEEP_WORKSPACES=1`), so "disposable" is the default rather
than an invariant.

### What is NOT true: a directory is not a sandbox

**Pipeline jobs run directly on the host, as the runner's own OS user, with no
container, no filesystem confinement and no egress control.**

- The runner *does* ship a container adapter — `src/department/container.ts`,
  with a read-only root, explicit mounts and an egress allowlist — but it is
  reachable **only** when a *department's* `RuntimeConfig.adapterId ===
  'container'`. Nothing under `src/jobs/` references it; `pipeline drive` is
  spawned through the plain `JobExec` seam (`src/jobs/types.ts#nodeJobExec`).
- The default workspace root is `<configDir>/jobs`
  (`src/core/home.ts#resolveWorkspaceRoot`), and `<configDir>` is where the
  runner's **own registration token** lives — `config.json`, mode `0600`
  (`src/core/config.ts`). On Linux that is:

  ```
  ~/.config/pipeline-runner/
  ├── config.json      ← the runner's token (0600)
  └── jobs/<job-id>/   ← the customer's checkout; a repo hook executes HERE
  ```

  `0600` protects against *other users*, not against the *same* user — and a
  repo hook runs as that same user, two directories below the token.
- Capacity is configurable above 1 (`src/jobs/manager.ts`, `src/core/config.ts`),
  so concurrent jobs are siblings in one tree, mutually reachable.

**Conclusion: the per-run disposability precondition holds; the sandbox
precondition does not.** Enabling project scope on hosted hardware — once §2 is
fixed — would mean executing untrusted repository hooks with read access to the
runner's credentials, to other tenants' checkouts, and to the network.

The two gaps are **coupled, and in our favour**: project scope cannot currently
be pinned, and project scope is also what makes repository hooks load. Fixing §2
without a real sandbox would open the hole. **They must be fixed in the opposite
order.**

---

## 4. Out of scope here: pooled machines (task `f4` — **landed**)

Auto memory and the global `~/.claude.json` are read **regardless** of
`settingSources`. On a fresh per-run container both are empty, which is what made
this task survivable when it shipped alone.

`f4-runner-pooling-isolation` owns the reused-machine case and **has since
landed**: a fresh per-run `$HOME`, `CLAUDE_CONFIG_DIR`,
`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, and a two-tenant test that proves nothing
crosses in either direction. See
[`docs/runner-pooling-isolation.md`](./runner-pooling-isolation.md) —
`src/jobs/agent-home.ts`, applied at the same hosted funnel in `driveLoop` that
this task's overlay is applied at.

**f4 does not close §3.** It removes the *ambient* path — `~` no longer resolves
anywhere a previous tenant wrote, and the runner's own token is no longer
reachable by tilde expansion from inside a run — but jobs still execute on the
host as the runner's OS user, and any absolute path that user can read is still
readable. The sandbox is still owed — as of 2026-08-12 the owner has waived it
as a shipping precondition rather than closing it; see §5.

---

## 5. 2026-08-12 — Owner decision: both preconditions waived, hosted `standalone` cleared to ship

**On 2026-08-12 the owner waived both preconditions above (§2 and §3) and
lifted the release block on hosted `standalone`.** This section records the
decision. It does not change, supersede, or soften anything found in §2 or §3
— both remain accurate descriptions of the runner as it exists today.

- **The per-run container sandbox described in §3 is not going to be built.**
  The owner's first call was to build it before shipping further, then
  reversed that call the same day, judging it disproportionate to the value of
  hosted `standalone`. There is no scheduled work closing §3.
- **Hosted `standalone` is cleared to ship with the exposure in §3 exactly as
  measured.** A customer repository's `.claude/settings.json` hooks can still
  execute, as shell commands, on the host as the runner's own OS user — see
  "What is NOT true" in §3, which this decision leaves unchanged.
- **§2 and §3 are WAIVED, not met.** This decision adds no flag, no container,
  and no sandbox. A future reader must not infer, from the fact that hosted
  `standalone` ships, that either precondition was ever closed.
- This risk was raised before the decision was made; the owner reaffirmed the
  waiver after hearing it. It is recorded here as an accepted risk, not an
  oversight.

**What limits the exposure, without closing it:** `f4`'s fresh per-run `$HOME`
(§4) means `~` no longer resolves anywhere a previous tenant wrote, and the
runner's own token is not reachable by tilde expansion from inside a run; the
per-job workspace is also disposable and torn down at a terminal outcome (§3,
"What IS true"). **Neither is a sandbox.** Any absolute path the runner's OS
user can read — including the token at `~/.config/pipeline-runner/config.json`
reached by its literal absolute path rather than by `~` — is still readable
from inside a hosted job.

The per-run container sandbox described in §3
(`src/department/container.ts`, currently reachable only from department
runs) remains the right long-term fix. It is simply not being built now.

---

## 6. Wiring a hosted runner

`JobExecutorOptions.hostedStandalone` — its **presence** makes a runner hosted.
Absent, behaviour is byte-identical to before this task.

```ts
new JobExecutor({
  /* … */
  hostedStandalone: {
    credential: async ({ jobId, jobJwt, secretSlugs }) =>
      new HostedProviderCredential(slug, await fetchOrgKey(jobJwt, secretSlugs)),
  },
});
```

No default source ships: the only correct one is the control plane's
`POST /api/v1/secrets/deliver` (job-JWT authenticated, decrypts only the job's
declared slugs), and wiring that HTTP fetch is separate, separately-reviewed
work. **A runner with no source configured is simply not a hosted runner** —
it is never a runner that quietly falls back to a machine key.
