# Cross-machine resume — the cursor travels, the session does not

Task `f3-cross-machine-resume`
(`.taskflow/2026-08-03-execution-modes/`, decisions D12 / E13, refs `01-modes.md`
and `02-standalone-executor.md`).

At fleet width a parked run almost certainly resumes **somewhere else**. That is
not a hypothetical: it is D12's funding-failure path, where a run that cannot be
funded releases the machine, keeps its durable cursor, and resumes once funded.
On a fleet, "resumes" means "on a different machine."

Agent SDK session files are machine-local — *"the session file still needs to
exist on the current machine."* `02-standalone-executor.md:169` states the fork
this page closes:

> A hosted run parked and resumed elsewhere (D12) needs a `SessionStore`
> adapter, **or must not rely on session resume.**

**Decision: we do not rely on SDK session resume.** Transcripts are never
mirrored — not to shared storage, not to the control plane, not anywhere. What
crosses a machine boundary is the durable cursor and nothing else.

This page records the evidence that decided it, what the decision actually
costs, and the three residual limits it does **not** solve.

---

## 1. What was measured before choosing

The task spec is explicit that the burden of proof sits on the expensive option:
*"Establish what is actually lost under the second option before choosing the
first."* Four findings decided it, all from live code rather than from the
design's summary of it.

| # | Finding | Where |
| --- | --- | --- |
| 1 | **Nothing engine-visible crosses a step boundary in a session.** Each step's session id is a fresh `randomUUID()`, keyed per step at `.runtime/<run_id>/sessions/<step>.json`. No variable in the drive loop carries a session id from step N to step N+1 | pipeline CLI `src/commands/drive.ts` — the fresh-session branch; `lib/step-transcripts.ts`: *"each session file belongs to exactly one step"* |
| 2 | **Even re-running the same step mints a new session.** A graph loop-back is *"a brand new spawn … never a resume of the halted one"* | pipeline CLI `src/lib/next.ts` |
| 3 | **Session identity already carries no engine-visible semantics.** The merged executor-conformance task excludes session ids from comparison as legitimately differing, while requiring *the run cursor* to match | task `d2-executor-conformance` |
| 4 | **The runner already treats a step-boundary park as session-free.** `reconcile.ts`'s `transcriptsPresent` demands a transcript only for a session whose status is `running` or `awaiting-input`. At a clean step boundary every session is `done`, so the check passes with **zero** transcripts | [`src/jobs/reconcile.ts`](../src/jobs/reconcile.ts) |

Finding 4 is the one worth pausing on. The code already encodes "a session is not
needed at a step boundary" — building a `SessionStore` would have been building
storage, a lifecycle and a privacy exposure to carry something the resume path
does not consult at the boundary where runs actually move.

**So the loss at a step boundary is nil.** Steps run in fresh contexts by design;
that is the product's premise, and the durable cursor is what makes a run
resumable in the first place. The cheap answer is also the correct one.

### The privacy argument, stated out loud

The DoD requires the `ux-v2` implication to be stated *if* transcripts are
mirrored. They are not — so the promise stays untouched, and that is a deliberate
outcome rather than an accident of scope:

- `ux-v2`'s standing promise is that we ship **metadata, never content**.
  Transcripts are content: prompts, tool output, file contents.
- **E11 is the precedent.** Server-side storage of *pipeline text* was rejected
  on exactly this ground — it *"would invert the privacy promise"* — and AI Fix
  was moved to a CLI command instead. Transcripts are a strictly larger content
  surface than pipeline text.
- `02-standalone-executor.md` documents that on the telemetry path there is
  *"no credential or entropy detector"*. Mirroring raw transcripts would route
  full content past every mechanism that section names as the only defence.
- Sibling task `f4-runner-pooling-isolation` exists to **wipe** `~/.claude`
  between runs so a pooled machine cannot leak one tenant's state into another's.
  A `SessionStore` would build deliberate, durable persistence into precisely the
  directory `f4` is chartered to erase.
- `f1` established that hosted jobs are **not sandboxed** — they run as the
  runner's own OS user. Mirrored transcripts would be readable by any repository
  hook of any tenant that shares the machine.

There is consequently **no transcript storage lifecycle to define**, because
there is no transcript storage.

---

## 2. What travels

The handoff lives in [`src/jobs/run-state.ts`](../src/jobs/run-state.ts) and is
wired into [`src/jobs/executor.ts`](../src/jobs/executor.ts).

| `.runtime/<run_id>/…` | Travels? | Why |
| --- | --- | --- |
| `next.json` | **yes** | the durable cursor — the run's entire engine-visible position |
| `sessions/*.json` | **no** | pinned claude session ids, meaningless off their machine |
| `~/.claude/projects/**/*.jsonl` | **no** | the transcripts themselves: content, never mirrored |
| the working tree | **no** | machine B takes a fresh checkout of the same ref (see §5) |
| the `JobRecord` | **no** | machine-local by design (`job-store.ts`) |

The allowlist (`PORTABLE_RUN_STATE_FILES`) is **positive and iterated**, never a
subtraction from the directory listing, so a file added to `.runtime/` later
cannot start travelling by accident. Same structural property the privacy filter
relies on.

**An absent `sessions/` directory is the mechanism, not an omission.** On the
receiving machine drive finds no session file for the step the cursor names,
takes its `prior === null` branch, and spawns a **fresh** session. That is the
whole trick: leaving `sessions/` behind is what makes the restored run start
clean instead of issuing `--resume <id>` against a session that does not exist
there — which would burn the crash-resume budget and halt.

### The lifecycle of what *is* stored

Metadata only, and small: `{ run_id, cursor, captured_at, pending_question }`.

| Event | Effect |
| --- | --- |
| every `pipeline drive` invocation returns | the cursor is **published** (`publishRunState`) |
| a terminal outcome (completed / halted / failed) | the bundle is **discarded** — `reportTerminal` is the one funnel |
| a server `cancel` | discarded explicitly (cancel bypasses `reportTerminal` by design) |
| a cursor naming machine-local paths | **never published at all** |

Publishing happens *after* a drive invocation returns and *before* the interrupt
check, so a graceful-shutdown suspend — the release that most often precedes a
pickup elsewhere — publishes the cursor it just stopped on instead of stranding
the run.

---

## 3. Wiring it

Opt-in, and deliberately given **no default**:

```sh
PIPELINE_RUNNER_RUN_STATE_DIR=/mnt/shared/pipeline-run-state pipeline-runner start
```

Every other path the runner resolves is machine-local; a machine-local default
here would look configured while never letting a run reach a second machine. The
directory must be storage every machine in the pool can see.

Unset ⇒ no store ⇒ nothing is published or fetched, and the runner behaves
exactly as it did before `f3`. Single-machine resume (c6's records, reconcile and
adoption) is untouched either way.

A control-plane-backed store is the obvious follow-up and needs no change to this
module: `RunStateStore` is the seam, and the payload is already metadata-only by
construction.

---

## 4. What is proven, and how the machine boundary was built

[`tests/cross-machine-resume.test.ts`](../tests/cross-machine-resume.test.ts)
boots two `JobManager` daemons over disk state sharing **nothing** except the
handoff directory and the repository the checkouts come from. Each machine has
its own workspace root, its own job-record store, and its own `HOME` — so
machine A's `~/.claude/projects/**` transcripts are unreachable from B, B has no
`JobRecord` for the run, and B cannot take c6's same-machine resume path.

The scripted `pipeline drive` is a real little engine over the cursor: `--start`
begins at step 0, `--resume` **reads** `.runtime/<run_id>/next.json`. Every step
it executes is appended to a ledger, so the run's whole history across both
machines is one list.

| Property | Evidence |
| --- | --- |
| **No step re-executed, none skipped** | ledger is exactly `['01-plan','02-build','03-test','04-ship']` — machine A ran the first two, B ran the last two |
| The handoff is what does it | **control test**: same harness with no store yields `['01-plan','02-build','01-plan','02-build','03-test','04-ship']` |
| B resumed rather than restarted | B's argv contains `--resume` and not `--start`, in a checkout under B's own workspace root |
| Nothing session-shaped travelled | the serialized bundle contains no `sess-`, no `transcript`, and neither of A's paths; A's session files are absent from B's checkout while B's own are present |
| A finished run cannot be picked up again | the bundle is gone after `completed` |
| Machine-local cursors are refused | a `worktree_provisioned` cursor makes B start clean and log the refusal |
| A non-`resume_hint` lease never consults the store | the server, not the runner, decides that a run is being continued |

`src/jobs/run-state.test.ts` covers the module directly: the allowlist, each
guarded cursor field, an unreadable cursor, refusal to overwrite local state, and
re-validation on the way **in** as well as out (the store is shared storage; a
bundle can be stale, tampered with, or written by an older runner).

---

## 5. ⚠ Three limits this does not remove

Recorded plainly, because each is a real constraint on when cross-machine resume
is safe — and none of them would have been fixed by a `SessionStore` either.

### 5.1 The working tree does not travel

The cursor carries the run's **control** state. It does not carry the checkout.
Machine B takes a fresh shallow clone of the same ref, so **uncommitted files
written by steps that already ran on machine A are gone.** A pipeline whose step
N writes files that step N+1 reads, without committing, pushing or uploading them
as artifacts, will not survive a machine change.

This is the sharpest precondition on this page and it is orthogonal to the
session question. Pipelines intended to run at fleet width must pass state
between steps through the repository or artifacts, not through the working tree.

### 5.2 An answer to a parked question is bound to its machine

Session continuity **is** load-bearing in exactly one place: within a single
step. Answer delivery (`--resume` with `--answer`) and crash-resume both
re-enter the *same* claude session, and that session lives on the machine that
spawned it.

So if a run parked on a needs-input question moves, the step **re-runs from the
top and asks again**; a previously given answer is not delivered to a session
that never asked for it. The bundle carries a `pending_question` flag purely so
the receiving runner logs this rather than appearing to lose an answer silently.

Un-parking on the machine that parked is unaffected — that path never consults
the handoff store.

### 5.3 A hard-killed daemon publishes nothing

Publication happens when a drive invocation returns. A `kill -9` during a drive
returns nothing, so the newest published cursor is the one from the previous
invocation. On the same machine this costs nothing — c6's reconcile resumes from
the local record and the local `.runtime`, which are both still there. It matters
only if that machine never comes back, in which case another machine resumes from
the last published cursor, or starts clean if there is none.

The natural fix is to publish on cursor change rather than on invocation
boundary (the shipper already tails files in the same checkout). Deliberately not
built here.

---

## 6. What an interrupted step does — and why that is still "no step re-executed"

Worth stating precisely, because D12's funding-failure path lands mid-step rather
than at a clean boundary: a provider-limit halt leaves the step's session
`running`, not `done`.

That run is still portable, and this is not a compromise. The step produced no
record — which is *why* the cursor still names it — so the receiving machine
dispatches that step afresh in a new session. Nothing that completed is repeated.
The interrupted attempt's partial work is discarded, which is exactly what
happens when a step is retried on a single machine.

`captureRunState` therefore refuses only two things: a cursor it cannot read, and
a cursor naming a path that exists only on the machine that wrote it (a
provisioned run-level worktree, `isolation: external`). Both fail closed to a
clean start rather than resuming over a guess.
