/**
 * `RuntimeConfig` narrowing, plus the DEPRECATED `PIPELINE_RUNNER_DEPARTMENTS`
 * fallback.
 *
 * `narrowRuntimeConfig` is the one place a `department_id`'s runtime spec is
 * validated, shared by both sources: the file-backed store (`./bindings.ts`,
 * the supported one) and the env var below.
 *
 * ## The env var is deprecated (simplified-onboarding b1, D14)
 *
 * This was task d1's placeholder: department install and manifest fetch did
 * not exist on the runner, so an env var stood in. It has a fatal property for
 * the onboarding path — it is BOOT-TIME IMMUTABLE. `cli.ts` parsed it once and
 * closed over the resulting Map, so a supervisor that was already running
 * could never learn about a department created after it started, and
 * `department.config_update` is not an escape hatch (`./manager.ts`: it
 * carries `limits.parkExpiry` only and drops frames for departments the map
 * does not know). `pipeline department serve` therefore ended in "restart the
 * supervisor" instead of `● online`.
 *
 * `./bindings.ts` replaces it with a reloadable file. This module stays for
 * one reason: an existing local setup that exports the variable must keep
 * working. It does — but only when NO binding file exists, and always with a
 * deprecation warning (emitted by the store, which is the thing that knows
 * which source won). Nothing here is deleted until the variable is removed.
 */

import type { Logger } from '../core/log';
import { nullLogger } from '../core/log';
import type { RuntimeConfig, RuntimeLifecycle } from './adapter';
// department-mesh d8: an entry with `adapterId: "container"` carries its
// sandbox spec under a `container` key — parsed the same tolerant way every
// other optional `RuntimeConfig` field here is.
import { narrowContainerSpec } from './container';
// department-mesh d4: an entry with `adapterId: "pipeline-drive"` carries its
// drive-target spec under a `pipelineDrive` key — same tolerant parse.
import { narrowPipelineDriveSpec } from './pipeline-drive';

export const DEPARTMENT_RUNTIMES_ENV = 'PIPELINE_RUNNER_DEPARTMENTS';

const LIFECYCLES: readonly RuntimeLifecycle[] = ['per-task', 'per-context', 'daemon'];

/**
 * Parse `PIPELINE_RUNNER_DEPARTMENTS` — a JSON object `{ [department_id]:
 * RuntimeConfig-ish }` — into a lookup map. Unset/blank/malformed fails
 * CLOSED to an empty map (no configured departments — every offer gets a
 * `capability` reject) rather than crashing the daemon.
 *
 * @deprecated Use `./bindings.ts`'s `DepartmentBindingStore`. Kept so an
 * existing local setup does not break; consulted only when no binding file
 * exists, and always behind a deprecation warning.
 */
export function parseDepartmentRuntimesEnv(raw: string | undefined, logger: Logger = nullLogger): Map<string, RuntimeConfig> {
  const map = new Map<string, RuntimeConfig>();
  if (raw === undefined || raw.trim() === '') return map;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn(`${DEPARTMENT_RUNTIMES_ENV} is not valid JSON — ignoring (no departments configured)`);
    return map;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    logger.warn(`${DEPARTMENT_RUNTIMES_ENV} must be a JSON object keyed by department id — ignoring`);
    return map;
  }

  for (const [departmentId, value] of Object.entries(parsed as Record<string, unknown>)) {
    const config = narrowRuntimeConfig(value);
    if (config === null) {
      logger.warn(`${DEPARTMENT_RUNTIMES_ENV}: entry '${departmentId}' is malformed — skipped`);
      continue;
    }
    map.set(departmentId, config);
  }
  return map;
}

/**
 * Narrow an untrusted value into a `RuntimeConfig`, or null when it cannot be
 * one. Deliberately tolerant on OPTIONAL fields (an unrecognized `lifecycle`,
 * a non-numeric timeout, a malformed `container` spec are dropped, not fatal)
 * and strict on the two that decide what executes: `adapterId` and `command`
 * must both be present, non-empty strings. Dropping a field can only narrow
 * what a runtime is allowed to do; inventing one could widen it.
 *
 * Shared by `./bindings.ts` (the file store) and the deprecated env var above,
 * so both sources apply byte-identical validation.
 */
export function narrowRuntimeConfig(raw: unknown): RuntimeConfig | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.adapterId !== 'string' || r.adapterId.length === 0) return null;
  if (typeof r.command !== 'string' || r.command.length === 0) return null;

  const config: RuntimeConfig = { adapterId: r.adapterId, command: r.command };
  if (Array.isArray(r.args)) config.args = r.args.filter((a): a is string => typeof a === 'string');
  if (typeof r.cwd === 'string') config.cwd = r.cwd;
  if (typeof r.startupTimeoutSeconds === 'number' && Number.isFinite(r.startupTimeoutSeconds)) {
    config.startupTimeoutSeconds = r.startupTimeoutSeconds;
  }
  if (typeof r.gracefulShutdownSeconds === 'number' && Number.isFinite(r.gracefulShutdownSeconds)) {
    config.gracefulShutdownSeconds = r.gracefulShutdownSeconds;
  }
  if (typeof r.parkExpirySeconds === 'number' && Number.isFinite(r.parkExpirySeconds)) {
    config.parkExpirySeconds = r.parkExpirySeconds;
  }
  // b4: `0` is MEANINGFUL here (it disables the stuck watchdog for this
  // department), so the guard admits it and only rejects a negative one —
  // unlike the timeouts above, where any finite number is passed through.
  if (typeof r.stuckAfterSeconds === 'number' && Number.isFinite(r.stuckAfterSeconds) && r.stuckAfterSeconds >= 0) {
    config.stuckAfterSeconds = r.stuckAfterSeconds;
  }
  if (typeof r.lifecycle === 'string' && (LIFECYCLES as readonly string[]).includes(r.lifecycle)) {
    config.lifecycle = r.lifecycle as RuntimeLifecycle;
  }
  // The operator-declared permission posture (see `RuntimeConfig`). Kept as
  // written — NOT validated against the adapter's value set, which this
  // adapter-agnostic module has no business knowing. A bad value is refused at
  // spawn by the adapter that owns the vocabulary; dropping it here would fall
  // back to a WIDER default and quietly grant more than the operator asked for.
  if (typeof r.permissionMode === 'string' && r.permissionMode.length > 0) {
    config.permissionMode = r.permissionMode;
  }
  if (Array.isArray(r.allowedTools)) {
    const tools = r.allowedTools.filter((t): t is string => typeof t === 'string' && t.length > 0);
    if (tools.length > 0) config.allowedTools = tools;
  }
  if (typeof r.settingsFile === 'string' && r.settingsFile.length > 0) {
    config.settingsFile = r.settingsFile;
  }
  if (r.container !== undefined) {
    const containerSpec = narrowContainerSpec(r.container);
    if (containerSpec !== undefined) config.container = containerSpec;
  }
  if (r.pipelineDrive !== undefined) {
    const pipelineDriveSpec = narrowPipelineDriveSpec(r.pipelineDrive);
    if (pipelineDriveSpec !== undefined) config.pipelineDrive = pipelineDriveSpec;
  }
  return config;
}
