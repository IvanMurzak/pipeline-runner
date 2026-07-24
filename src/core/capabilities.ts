/**
 * D17 capability advertisement (department-mesh d7 —
 * `07-runtime-contract.md` §2.2, `06-department-registry.md` §5): each
 * runner instance advertises what ISOLATION TIERS, GPU access, OS, and
 * resource hints it can offer, so the mesh scheduler can match a
 * department's `requiredIsolation`/labels against runners that can actually
 * satisfy them — never placing a `container`-only department on a
 * `process`-tier runner, or vice versa.
 *
 * PROTOCOL FOLLOW-UP (flagged, not fixed here): protocol 0.4.0's
 * `RegisterMessageSchema` has no typed `capabilities` field — only
 * `labels`/`capacity`/`os` plus the mesh's own `departments`/`mesh_protocol`
 * additions (`08-protocol-delta.md` §7). It IS built with `wireVariant()` →
 * `.passthrough()`
 * (`node_modules/@baizor/pipeline-protocol/dist/wire/handshake.js`), so an
 * extra `capabilities` key survives the parse untouched on both sides. This
 * task carries it that way per its scope note ("advertise via the frame's
 * additive `.passthrough()`... do NOT modify the protocol package here").
 * A typed field belongs to a future protocol change, once
 * `runner_connections.capabilities` (task `c16`) needs to validate the shape
 * server-side rather than accept it opaquely.
 */

import { cpus, totalmem } from 'node:os';
import { detectOs } from './config';

/** Isolation tiers a runner instance can host (07 §2.2). `container` — the
 *  strong tier, required for cross-org/public work (D18) — is task `d8`;
 *  this runner always advertises `['process']` until that adapter exists. */
export const ISOLATION_TIERS = ['process', 'container'] as const;
export type IsolationTier = (typeof ISOLATION_TIERS)[number];

/** Resource hints the scheduler can use for capacity-aware spreading
 *  (`06-department-registry.md` §5 point 5) — informational, not enforced
 *  by this runner. */
export interface ResourceHints {
  /** Logical CPU count. */
  cpu_count: number;
  /** Total system memory, in MiB. */
  total_memory_mb: number;
}

/** The D17 capability advertisement carried on `register` — see the
 *  PROTOCOL FOLLOW-UP note above (additive passthrough, not a typed field
 *  yet). */
export interface RunnerCapabilities {
  /** Isolation tiers this instance can host. Always `['process']` pre-d8. */
  isolation: IsolationTier[];
  /** Whether this instance has GPU access to offer. Operator-declared
   *  (`register --gpu`) — same posture as `--capacity`/`--label` today;
   *  there is no portable, dependency-free way to auto-detect a GPU across
   *  Windows/macOS/Linux from this package. */
  gpu: boolean;
  /** Duplicated from the register frame's top-level `os` field for
   *  capability-object completeness — 06 §5 groups isolation/gpu/os/
   *  resources together as one match input. */
  os: string;
  resources: ResourceHints;
}

export interface DetectCapabilitiesInputs {
  gpu?: boolean;
  isolation?: IsolationTier[];
  platform?: string;
  cpuCount?: number;
  totalMemoryBytes?: number;
}

/**
 * Build this instance's capability advertisement. Every input is injectable
 * so tests never depend on the real machine's core count/RAM/platform.
 */
export function detectCapabilities(inputs: DetectCapabilitiesInputs = {}): RunnerCapabilities {
  const cpuCount = inputs.cpuCount ?? cpus().length;
  const totalMemoryBytes = inputs.totalMemoryBytes ?? totalmem();
  return {
    isolation: inputs.isolation ?? ['process'],
    gpu: inputs.gpu ?? false,
    os: detectOs(inputs.platform),
    resources: {
      cpu_count: cpuCount,
      total_memory_mb: Math.round(totalMemoryBytes / (1024 * 1024)),
    },
  };
}

/** Narrow an unknown value loaded from disk (the persisted config file) back
 *  into a `RunnerCapabilities`, or `undefined` if it is not well-formed —
 *  mirrors `ConfigStore.load()`'s tolerant-parse philosophy for every other
 *  field (`core/config.ts`). */
export function narrowRunnerCapabilities(raw: unknown): RunnerCapabilities | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.isolation)) return undefined;
  if (typeof r.gpu !== 'boolean') return undefined;
  if (typeof r.os !== 'string') return undefined;
  const resources = r.resources;
  if (typeof resources !== 'object' || resources === null) return undefined;
  const res = resources as Record<string, unknown>;
  if (typeof res.cpu_count !== 'number' || typeof res.total_memory_mb !== 'number') return undefined;
  return {
    isolation: r.isolation.filter((t): t is IsolationTier => (ISOLATION_TIERS as readonly string[]).includes(t as string)),
    gpu: r.gpu,
    os: r.os,
    resources: { cpu_count: res.cpu_count, total_memory_mb: res.total_memory_mb },
  };
}
