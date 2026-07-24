/**
 * Placeholder department-runtime resolution (task d1). Department install,
 * manifest fetch, and `department.config_update` caching (task c2 /
 * `06-department-registry.md`) do not exist on the runner yet — this reads
 * an optional env var so the adapter + supervisor wiring (`./manager.ts`,
 * `./jsonl-process.ts`) can be exercised end-to-end (local dev, manual
 * integration testing) without that machinery. Production department
 * resolution replaces this wholesale; nothing else in `./manager.ts` depends
 * on HOW a `department_id` resolves to a `RuntimeConfig`, only that it can.
 */

import type { Logger } from '../core/log';
import { nullLogger } from '../core/log';
import type { RuntimeConfig, RuntimeLifecycle } from './adapter';
// department-mesh d8: an entry with `adapterId: "container"` carries its
// sandbox spec under a `container` key — parsed the same tolerant way every
// other optional `RuntimeConfig` field here is.
import { narrowContainerSpec } from './container';

export const DEPARTMENT_RUNTIMES_ENV = 'PIPELINE_RUNNER_DEPARTMENTS';

const LIFECYCLES: readonly RuntimeLifecycle[] = ['per-task', 'per-context', 'daemon'];

/**
 * Parse `PIPELINE_RUNNER_DEPARTMENTS` — a JSON object `{ [department_id]:
 * RuntimeConfig-ish }` — into a lookup map. Unset/blank/malformed fails
 * CLOSED to an empty map (no configured departments — every offer gets a
 * `capability` reject) rather than crashing the daemon.
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

function narrowRuntimeConfig(raw: unknown): RuntimeConfig | null {
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
  if (typeof r.lifecycle === 'string' && (LIFECYCLES as readonly string[]).includes(r.lifecycle)) {
    config.lifecycle = r.lifecycle as RuntimeLifecycle;
  }
  if (r.container !== undefined) {
    const containerSpec = narrowContainerSpec(r.container);
    if (containerSpec !== undefined) config.container = containerSpec;
  }
  return config;
}
