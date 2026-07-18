/**
 * Graceful shutdown (c6, design 04 §Graceful shutdown): the SIGTERM/SIGINT
 * drain the daemon never had (ground truth §1.8). Sequence:
 *
 *   1. Stop accepting leases (the caller's `drain()` sets the flag the
 *      manager's `draining()` reads).
 *   2. Suspend every active job — persist records (phase current, freshly
 *      touched so a prompt service restart classifies them FRESH) and
 *      SIGTERM the drive children (their per-step state is durable; E7/E8
 *      resume machinery covers the re-entry).
 *   3. Flush the shipper spool (final poll + flush + drain attempt per job).
 *   4. Close the socket, exit 0.
 *
 * The whole drain is capped by `timeoutMs` — shutdown must never hang on an
 * offline cloud (the spool is durable; whatever did not upload ships on the
 * next boot).
 *
 * SEAM-DRIVEN + PORTABLE (Windows CI): this module owns only the ORDER; the
 * signals are wired in `cli.ts`. Platform caveats (mirroring the design's
 * service-recovery notes): on Windows, SCM `stop` is a hard terminate — this
 * drain is an OPTIMIZATION; the whole design assumes hard death is survivable.
 * Node emulates SIGINT (ctrl-c) and SIGTERM-via-`process.kill` on Windows,
 * but no signal is delivered for a console close — again: hard death is fine.
 *
 * Idempotent: a second invocation (double ctrl-c) returns the SAME in-flight
 * promise — it never restarts the sequence.
 */

import type { Clock } from '../core/clock';
import { systemClock } from '../core/clock';
import type { Logger } from '../core/log';
import { nullLogger } from '../core/log';

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;

export interface GracefulShutdownDeps {
  /** Stop accepting new leases (sets the flag `draining()` reads). */
  drain(): void;
  /** Suspend all active jobs + persist their records (manager.suspendAll). */
  suspendJobs(): Promise<void>;
  /** Final flush + drain of every active shipper (lifecycle.stopAll). */
  flushShippers(): Promise<void>;
  /** Close the agent connection (client.stop). */
  closeConnection(): void;
  /** Process exit (injectable for tests). */
  exit(code: number): void;
  timeoutMs?: number;
  clock?: Clock;
  logger?: Logger;
}

/** Build the (idempotent) shutdown routine `cli.ts` wires to SIGTERM/SIGINT. */
export function createGracefulShutdown(deps: GracefulShutdownDeps): () => Promise<void> {
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger ?? nullLogger;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  let inFlight: Promise<void> | null = null;

  const run = async (): Promise<void> => {
    logger.info('shutdown: draining (no new leases will be accepted)');
    deps.drain();

    let timer: unknown = null;
    const capped = new Promise<'timeout'>((resolve) => {
      timer = clock.setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const work = (async (): Promise<'done'> => {
      await deps.suspendJobs();
      logger.info('shutdown: jobs suspended, records persisted');
      await deps.flushShippers();
      logger.info('shutdown: shipper spool flushed');
      return 'done';
    })();
    const outcome = await Promise.race([work, capped]);
    if (timer !== null) clock.clearTimeout(timer);
    if (outcome === 'timeout') {
      logger.warn(`shutdown: drain exceeded ${timeoutMs}ms — exiting anyway (spool is durable; records persisted at suspend)`);
    }
    deps.closeConnection();
    logger.info('shutdown: connection closed — bye');
    deps.exit(0);
  };

  return () => {
    if (inFlight === null) inFlight = run();
    return inFlight;
  };
}
