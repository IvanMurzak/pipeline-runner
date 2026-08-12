# Pooled runners — what cannot cross between tenants, and what still can

Task `f4-runner-pooling-isolation`
(`.taskflow/2026-08-03-execution-modes/`, decision E13).

`settingSources: ["project"]` closes `user` and `local` scope. **Two inputs are
read regardless of it**, and they are the ones a pooled machine accumulates:

| Input | Where it lives |
| --- | --- |
| the global config | `~/.claude.json` |
| auto memory | `~/.claude/projects/<encoded-project>/memory/` |

Upstream says so plainly: *"Do not rely on default `query()` options for
multi-tenant isolation."*

On a fresh per-run container both are empty, which is what made
[`hosted-standalone.md`](./hosted-standalone.md) survivable — but that is a
**deployment property, not a code one**. At fleet width machines get pooled
(E13), and the moment two tenants' runs share one `$HOME`, one org's accumulated
memory loads into another org's run. Nothing about that failure is visible: the
run succeeds, the records are well-formed, the output is merely — informed by
somebody else's project.

This page records what f4 enforces, **how it is enforced**, and the four things
it deliberately does not close.

---

## 1. What the runner enforces

All of it lives in [`src/jobs/agent-home.ts`](../src/jobs/agent-home.ts), is
applied at the single hosted funnel in
[`src/jobs/executor.ts`](../src/jobs/executor.ts)`#driveLoop`, and is proven by
[`tests/pooling-isolation.test.ts`](../tests/pooling-isolation.test.ts) (the
guarantee) plus [`src/jobs/agent-home.test.ts`](../src/jobs/agent-home.test.ts)
(the mechanism).

| Guarantee | Mechanism |
| --- | --- |
| The drive child's `$HOME` is this run's own, never the machine's | `HOME` **and** `USERPROFILE` (`os.homedir()` reads the latter on Windows) |
| It is **fresh per run**, not wiped afterwards | the home path is keyed by `run_id` — a later tenant never reads the earlier tenant's directory at all |
| A re-`--start` cannot inherit a previous attempt's home | `provisionAgentHome({ fresh: true })` wipes it, the same rule `prepareWorkspace` applies to a stale checkout |
| `~/.claude.json` cannot carry state between tenants | it resolves inside the per-run home; `CLAUDE_CONFIG_DIR` covers the other place it can live |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, unconditionally | in the same overlay, on every hosted invocation — start, resume and answer |
| None of the four is overridable by a caller or by the machine | applied **last** over any base, exactly as f1 applies the provider-key entries |
| A home that cannot be provisioned means **no run** | `provisionAgentHome` throws `JobError`; the job halts before any process is spawned |
| Nothing of a finished tenant is left on the box | `disposeAgentHome` on every terminal exit, in a `finally` |

### Why fresh, and not "wipe between runs"

The spec allowed either. A wipe-afterwards is only as good as the cleanup that
performs it: a daemon killed between two tenants leaves the previous tenant's
home in place, and **the next tenant is the one who would have had to clean it**.

A fresh path removes the dependency. The next tenant resolves a *different
directory*, so isolation holds even when teardown never ran. Teardown still
happens — it is hygiene, not the guarantee.

### Why the key is the run, not the job

A run belongs to exactly one tenant, so run-keying *is* the isolation boundary.
Job-keying would also have been safe, and would have been wrong: c6's adoption
path (`manager.ts#adoptOrReplace`) changes the `job_id` while keeping the
`run_id`, so an adopted run would have been handed a brand-new empty home — and
`~/.claude/projects/**` is exactly the substrate a resume is validated against.

For the same reason a **suspended** job keeps its home (`executor.ts`'s `finally`
skips disposal when `suspend()` fired): graceful shutdown leaves the record
intact for the next boot's reconcile, and wiping here would turn every redeploy
into an unrecoverable run. Every other exit — completed, halted, failed,
cancelled — disposes.

### Why `CLAUDE_CONFIG_DIR` *and* a fresh `HOME`

Belt and braces, deliberately. If the global config lives at `~/.claude.json`,
the fresh `HOME` closes it; if it lives at `<config dir>/.claude.json`, the
relocated `CLAUDE_CONFIG_DIR` closes it. One of the two is redundant on any given
version of Claude Code — **which one is not ours to know**, and the cost of
setting both is nothing.

### Local runners are untouched

The overlay is built only when `JobExecutorOptions.hostedStandalone` is present.
A local runner runs on the *user's own* machine: that home is theirs, holds their
own configuration, and has exactly one tenant. Relocating it would break their
setup to solve a problem they do not have. `agent-home.test.ts` pins that a
non-hosted run's drive env is still `undefined` — byte-identical to before f4.

---

## 2. The test is the deliverable

A test that plants a memory file and then asserts an environment variable was set
proves nothing about isolation — it asserts the configuration it just wrote.

`tests/pooling-isolation.test.ts` therefore asserts on **what a real process
could observe**. It spawns a real child through the runner's own
`nodeJobExec`, with the environment the executor really built; the child resolves
`~` with `os.homedir()`, reads the global config at both places it can live, and
returns a bounded recursive dump of *every file under its home*. A leak through a
path the test never thought of still shows up in that dump.

The machine is pooled by construction: **one** workspace root and **one** ambient
`$HOME`, planted before anything runs with tenant A's `.claude.json`, auto memory
and user-scope `CLAUDE.md`.

| Direction | The claim | How it is made |
| --- | --- | --- |
| **control** | the instrument can detect a leak | same harness, isolation **off** ⇒ A's three markers **are** read, and B's own state lands in the shared home |
| **forward** | A's state never reaches B | B's home is not the machine's; none of A's markers appear anywhere reachable from it; `~/.claude.json` reads as absent |
| **forward** | including state A's *run* wrote | A runs first and accumulates; B still sees nothing of it |
| **reverse** | B writes nothing back | the machine's home after B's run still contains exactly A's files and no B marker |
| **reverse** | B leaves nothing that outlives it | B's home does not exist once the job ends; B's marker appears nowhere under the whole job tree |
| **reverse** | a later A run is clean | A returns for a new run and reads neither B's state **nor its own previous run's** |

The control is not decoration. A negative assertion is worthless until the
instrument has been shown to detect the thing, and it is what makes the six
negative claims mean *"isolation worked"* rather than *"the probe looked in the
wrong place"*.

---

## 3. ⚠ Still open: this is not a sandbox

[`hosted-standalone.md` §3](./hosted-standalone.md) records that hosted jobs run
**directly on the host, as the runner's own OS user**, with no container, no
filesystem confinement and no egress control. **f4 does not change that**, and
this section exists so nobody reads f4 as having closed it.

What f4 removes is the **ambient** path: `~` no longer resolves anywhere a
previous tenant wrote, and `~/.config/pipeline-runner/config.json` — the runner's
own registration token — is no longer reachable by tilde expansion from inside a
run. What it does **not** remove: any absolute path the runner's OS user can
read is still readable by a repository hook. That is a sandbox's job, and the
sandbox is still owed.

---

## 4. ⚠ Still open: `settingSources` is still unpinnable

f4 closes the inputs that are read *regardless* of `settingSources`. It does
nothing about `settingSources` itself, which
[`hosted-standalone.md` §2](./hosted-standalone.md) records as unreachable from
this repository — `pipeline drive` exposes no flag or environment variable that
maps onto the SDK option. `user` and `local` scope remain open on hosted runs.

The two gaps stay coupled in our favour, as f1 noted: project scope cannot
currently be pinned, and project scope is what makes repository hooks load. Fix
§2 without a sandbox and the hole opens.

---

## 5. Server-managed settings are expected, and are **not** a leak

When the process authenticates with an **organisation credential**, Claude Code
fetches that organisation's server-managed settings over the network. They do not
come off this disk, so **no amount of filesystem isolation removes them, and none
should**: they are the org's own policy applied to the org's own run, which is
the correct behaviour for hosted execution.

This is recorded here for one reason: a future reader auditing a hosted run will
see settings that no file on the machine explains, and must not conclude that f4
missed a path. The test above asserts nothing about them, deliberately — there is
nothing on the filesystem to assert.

Cross-tenant contamination through this channel would require the run to
authenticate as the *wrong org*, which is f1's guarantee (`hostedDriveEnv`
delivers the org's own key and closes the higher rungs), not f4's.

---

## 6. ⚠ Owed follow-up: the reconcile's substrate probe assumes one home

`reconcile.ts#fsSubstrateProbe(fs, homeDir)` takes a **single** home directory and
looks for a resumed run's transcripts at
`<homeDir>/.claude/projects/<encoded-checkout>/<session>.jsonl`. `manager.ts`
constructs it with the *daemon's* `homedir()`.

That is correct today and unreachable-by-construction for hosted runs, because
`JobManagerOptions` carries no `hostedStandalone` field at all — **hosted runs are
only wired through `JobExecutor` directly** (an f1 gap, noted here rather than
fixed, because closing it is a wiring task with its own review).

**When hosted runs are wired into `JobManager`, this becomes live:** a hosted
run's transcripts are under its per-run home, not the daemon's, so the probe
would report `transcriptsPresent === false` and `classifyRecord` would call a
perfectly recoverable run *unrecoverable*. The fix is to let the probe resolve a
per-record home — `agentHomeFor(root, record.run_id)` is exported for exactly
that — and it must land in the same change that wires hosted execution into the
manager, not after it.

The suspended-job carve-out in §1 exists so that the substrate is genuinely
*there* when that fix lands; only the probe's idea of where to look is wrong.

---

## 7. ⚠ Owed follow-up: a fresh home has no git identity and no caches

Only the `pipeline drive` child gets the overlay — the runner's own `git`
invocations (`prepareWorkspace`'s checkout) are spawned without it and are
unaffected. But a **pipeline step** that shells out to `git` inside that child
now resolves `~/.gitconfig` inside an empty home, so `git commit` will refuse
with *"Please tell me who you are"*, and package-manager caches under `~` start
cold on every run.

Both are consequences of doing this correctly, not bugs to undo: inheriting the
machine's git identity would stamp *our operator* onto a tenant's commits, and a
shared cache under a shared `~` is another cross-tenant surface. The right fix is
an explicit, per-run identity (`GIT_AUTHOR_*` / `GIT_COMMITTER_*` in the same
overlay) and a cache directory that is deliberately shared because it was
deliberately reasoned about — both belong to whoever wires hosted execution
end to end, and neither is guessed at here.

---

## 8. Wiring

Nothing to configure. `JobExecutorOptions.agentHomeRoot` defaults to
`<workspaceRoot>/.agent-homes`, so isolation is the behaviour of a hosted runner
that configured *nothing* — never of one that remembered to. Set it only to move
the homes onto different storage:

```ts
new JobExecutor({
  /* … */
  hostedStandalone: { credential: fetchOrgKey },
  agentHomeRoot: '/mnt/fast/agent-homes', // optional
});
```

The per-run home is **not** subject to `PIPELINE_RUNNER_KEEP_WORKSPACES` or the
retention window. Retention keeps a *checkout* so an operator can debug a run; a
tenant's accumulated agent state is not debugging material, and "keep everything"
must never quietly become "keep one tenant's memory next to another tenant's
run".
