/**
 * hosted-mode.ts — REJECT any EXPLICITLY non-`standalone` `runner:` on a
 * hosted run (f2, `.taskflow/2026-08-03-execution-modes/` 01-modes.md E3/E10).
 *
 * `session` and `manager` need an interactive Claude Code session on our own
 * server; `driver` needs the user's own Claude Code installation and
 * subscription on our hardware. None of the three can function here (E3) —
 * this module exists so that mismatch fails FAST and LEGIBLY, at the door,
 * instead of as an obscure error twenty seconds into a run. It is a
 * structural/contractual constraint, not a policy toggle (see below).
 *
 * ── THE ONE DISTINCTION THIS MODULE EXISTS TO GET RIGHT ────────────────────
 *
 * The CLI's OWN resolution already defaults an ABSENT `runner:` key to
 * `'manager'` (E10 — `pipeline`'s `lib/manifest.ts`: `doc.runner === undefined
 * ? 'manager' : ...`, and `lib/plan.ts`'s `Plan.runner` inherits that same
 * default). That default is right for the CLI's own purposes, but it destroys
 * the one bit this module needs: whether the user wrote `runner:` AT ALL.
 *
 * A hosted run cannot reuse that resolved value. An ABSENT key must resolve to
 * `standalone` here (a default the user never chose must never block them from
 * hosted execution), while an EXPLICIT `manager` must be refused (a choice the
 * user DID make, that cannot run on our hardware). Reading `Plan.runner` or
 * `Manifest.runner` cannot tell these two cases apart — both come out as the
 * string `'manager'`. So this module reads the manifest SOURCE directly,
 * before any CLI-side default is applied, through the injectable
 * `JobFs.readFile` seam — never a fresh `pipeline` shell-out, and never a full
 * YAML parse of untrusted repository content (see `topLevelScalar` below). The
 * file is already on disk by the time this runs: `prepareWorkspace`'s checkout
 * happens first, same as every other post-checkout inspection in this package
 * (`pipeline hash`, `pipeline plan`).
 *
 * ── NOT A POLICY TOGGLE ─────────────────────────────────────────────────────
 *
 * No flag, environment variable or option relaxes this: `assertHostedRunnerAllowed`
 * takes no override parameter and reads no environment variable — the whole
 * function is pure over its two arguments. `hosted-mode.test.ts` plants
 * bypass-shaped environment variables before calling it and proves the outcome
 * is unchanged.
 */

import { join } from 'node:path';
import type { JobFs } from './types';

/** The only mode a hosted run may execute (E3). */
export const HOSTED_ONLY_RUNNER = 'standalone';

/**
 * v2 manifest filename — mirrors `pipeline`'s `MANIFEST_FILENAME`
 * (`src/lib/manifest.ts`). ⚠ CROSS-REPOSITORY CONSTANT: this package does not
 * depend on the CLI package (same reasoning as `standalone.ts`'s
 * `PROVIDER_KEY_ENV`), so the name is mirrored rather than imported.
 * `hosted-mode.test.ts` pins it.
 */
export const MANIFEST_FILENAME = 'pipeline.yml';

/**
 * v1 legacy manifest filename — mirrors `pipeline`'s hardcoded `PIPELINE.md`
 * frontmatter source, the same file `computePlan` falls back to when
 * {@link MANIFEST_FILENAME} is absent (`lib/plan.ts`:
 * `existsSync(join(dir,'PIPELINE.md'))`).
 */
export const LEGACY_MANIFEST_FILENAME = 'PIPELINE.md';

/**
 * A hosted run's manifest EXPLICITLY declares a mode other than `standalone`.
 * Thrown at the door (E3) — before any resource is provisioned: before the
 * org credential is resolved and before any process is spawned.
 */
export class RunnerModeRejectedError extends Error {
  /** The mode exactly as the manifest wrote it (e.g. `'manager'`, `'headless'`). */
  readonly requested: string;

  constructor(requested: string) {
    super(
      `hosted runners only run '${HOSTED_ONLY_RUNNER}' pipelines — this pipeline declares ` +
        `'runner: ${requested}'. Run it locally with Claude Code instead, or change the ` +
        `manifest's 'runner:' key to '${HOSTED_ONLY_RUNNER}'.`
    );
    this.name = 'RunnerModeRejectedError';
    this.requested = requested;
  }
}

/**
 * Match a top-level (column-0) `key: value` scalar line — the exact shape a
 * v2 `pipeline.yml` or a v1 `PIPELINE.md` frontmatter block writes `runner:`
 * in (E7: "top-level … beside `execution:` / `isolation:`"). Deliberately NOT
 * a YAML parser: an indented `runner:` under some other key (a step, a
 * nested map) is NOT a manifest-level declaration and must not match, which
 * an anchored, un-indented regex gets right without parsing — or executing —
 * the rest of the document at all.
 */
function topLevelScalar(text: string, key: string): string | null {
  const re = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm');
  const match = re.exec(text);
  if (match === null) return null;
  let value = match[1] ?? '';
  const hashIdx = value.indexOf('#');
  if (hashIdx !== -1) value = value.slice(0, hashIdx);
  value = value.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) value = value.slice(1, -1).trim();
  }
  return value.length > 0 ? value : null;
}

/**
 * The first `---`-delimited frontmatter block at the top of a v1
 * `PIPELINE.md` (the exact boundary `parseFrontmatter` uses CLI-side), or
 * null when the file has no leading `---` line or no closing one.
 */
function frontmatterOf(text: string): string | null {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end === -1) return null;
  return lines.slice(1, end).join('\n');
}

/**
 * The manifest's OWN declared `runner:` value, before any CLI-side default is
 * applied — null when the key is absent, its value is blank, or no manifest
 * file exists at all (which behaves identically to "absent": nothing was
 * declared).
 *
 * v2 (`pipeline.yml`) takes priority, mirroring `computePlan`'s own file
 * detection (`pipeline`'s `lib/plan.ts`: `pipeline.yml` present ⇒ v2, else
 * v1). v1's frontmatter is scanned ONLY within its `---` block, matching
 * `parseFrontmatter`'s own boundary — a `runner:`-shaped line in the
 * markdown body below it is not a declaration.
 */
export function readDeclaredRunner(pipelineRootAbs: string, fs: JobFs): string | null {
  const manifestText = fs.readFile(join(pipelineRootAbs, MANIFEST_FILENAME));
  if (manifestText !== null) return topLevelScalar(manifestText, 'runner');

  const legacyText = fs.readFile(join(pipelineRootAbs, LEGACY_MANIFEST_FILENAME));
  if (legacyText === null) return null;
  const frontmatter = frontmatterOf(legacyText);
  return frontmatter === null ? null : topLevelScalar(frontmatter, 'runner');
}

/**
 * Refuse a hosted run whose manifest EXPLICITLY declares a non-`standalone`
 * mode. Absent ⇒ allowed (the CLI's own default is `manager`, E10, but on
 * hosted infrastructure a default the user never chose must never become a
 * rejection). Declared `standalone` (any case) ⇒ allowed. Anything else
 * declared — `session`, `manager`, `driver`, v1's `headless`, or an unknown
 * value — ⇒ {@link RunnerModeRejectedError}: an unrecognized value is not a
 * safer default to guess at, only `standalone` is provably safe to run here.
 *
 * No override: no parameter, no environment variable, nothing to configure —
 * see the module header. Call ONLY for a hosted run (i.e. only when
 * `JobExecutorOptions.hostedStandalone` is present) — a local run is under no
 * such restriction and must never reach this function.
 */
export function assertHostedRunnerAllowed(pipelineRootAbs: string, fs: JobFs): void {
  const declared = readDeclaredRunner(pipelineRootAbs, fs);
  if (declared === null) return;
  if (declared.toLowerCase() === HOSTED_ONLY_RUNNER) return;
  throw new RunnerModeRejectedError(declared);
}
