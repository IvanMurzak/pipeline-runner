/**
 * The event-shipper composition seam (c2) — closes E4: the shipped daemon
 * constructed no `EventShipper`, so a cloud-dispatched run produced ZERO
 * server-side events (its run row never left `created`, the executor's
 * `run_status` frames were the only signal at all).
 *
 * `JobExecutor.onWorkspaceReady` ([../jobs/executor.ts]) is the documented
 * composition seam: it fires once per job, right after the isolated checkout
 * is ready, carrying everything an `EventShipper` needs to tail THAT job's
 * journal (`executor.ts` docs: "the shipper tails the run's events
 * independently; onWorkspaceReady ... tells it WHERE"). This module is the
 * glue: one `EventShipper` per ACTIVE job, keyed by `job_id`, started on
 * `onWorkspaceReady` and stopped on `onJobFinished` (the manager's terminal
 * event — success or failure, mirroring `JobManagerOptions.events.onJobFinished`).
 *
 * Kept OUT of `cli.ts` (not inlined) so it stays unit-testable: `cli.ts`'s
 * top-level script dispatches on `process.argv` immediately at import time,
 * so nothing meant to be exercised by `bun test` can live there — the same
 * reason `attachJobExecution` (./manager.ts) and `runService` (../service)
 * are separate testable modules cli.ts merely wires up.
 *
 * Transport: the WSS `upload` frame (`WireUploadTransport`, runner-token
 * authenticated via the already-registered connection) is the DEFAULT and
 * only wiring here — the HTTP fallback (`HttpUploadTransport`) stays
 * non-default; it authenticates PAT/session only and has no runner-token
 * story yet (auth gap, `upload-transport.ts` module doc).
 *
 * The lease's `job_jwt` ([../jobs/executor.ts] `JobWorkspaceContext.job_jwt`,
 * SECRET, never logged) is surfaced here for any future per-job authz the
 * transport grows; today's `WireUploadTransport` has no such seam — the
 * connection's own runner-token auth already covers the WSS channel this
 * upload rides.
 */

import { join } from 'node:path';
import type { Clock } from '../core/clock';
import type { Dispatcher } from '../core/dispatcher';
import type { Logger } from '../core/log';
import { nullLogger } from '../core/log';
import type { WireFrame } from '../core/wire';
import { nodeShipperFs, type ShipperFileSystem } from '../shipper/fs';
import { EventShipper, shipperStateDir } from '../shipper/shipper';
import { DiskStatsSource, statsDirForJournal, type StatsSource } from '../shipper/stats';
import { WireUploadTransport, type UploadTransport } from '../shipper/upload-transport';
import type { JobResult, JobWorkspaceContext } from './executor';
import type { JobManagerEvents } from './manager';

export interface ShipperLifecycleOptions {
  /** Send a frame on the live agent connection (the WSS `upload` transport). */
  send(frame: WireFrame): boolean;
  /** The agent connection's dispatcher — `upload_ack` frames arrive here. */
  dispatcher: Pick<Dispatcher, 'on'>;
  fs?: ShipperFileSystem;
  clock?: Clock;
  logger?: Logger;
  env?: Record<string, string | undefined>;
  /** Override the upload transport (tests only; default: the WSS frame). */
  transport?: UploadTransport;
  /** Override per-journal state-dir derivation (tests only; default:
   *  `shipperStateDir`, a hash of the journal path under the agent data dir). */
  stateDirFor?(journalPath: string): string;
  /** Override `.stats` record lookup (tests only; default: `DiskStatsSource`
   *  over the checkout's `.claude/pipeline/.stats` dir). */
  statsSourceFor?(context: JobWorkspaceContext): StatsSource;
}

/** Derive the journal path the design pins: `<checkout>/.claude/pipeline/.runtime/events.jsonl`. */
export function journalPathFor(context: Pick<JobWorkspaceContext, 'dir'>): string {
  return join(context.dir, '.claude', 'pipeline', '.runtime', 'events.jsonl');
}

/** The lifecycle events PLUS the graceful-shutdown drain (c6). */
export type ShipperLifecycle = Required<
  Pick<JobManagerEvents, 'onWorkspaceReady' | 'onJobFinished' | 'onTerminalFlush'>
> & {
  /** c6 graceful shutdown: final flush + drain of EVERY active shipper. */
  stopAll(): Promise<void>;
};

/**
 * Build the `onWorkspaceReady` / `onTerminalFlush` / `onJobFinished` set to
 * pass as `attachJobExecution(client, { events: createShipperLifecycle(...),
 * ... })`. One `EventShipper` per active job; a job that never reaches
 * `onWorkspaceReady` (prep failure) never gets one — nothing to tail.
 *
 * c6 ordered completion (the c5 terminal-state race): `onTerminalFlush` is
 * the executor's pre-run_status await — it STOPS this job's shipper (final
 * poll + flush + drain attempt), so the terminal journal events are shipped
 * (or durably spooled with retries pending) BEFORE the terminal `run_status`
 * frame goes out and before the run leaves `active_run_ids`. `onJobFinished`
 * remains as the safety net for paths that never flush (cancel, crash
 * containment) — stopping an already-stopped job's shipper finds nothing.
 */
export function createShipperLifecycle(options: ShipperLifecycleOptions): ShipperLifecycle {
  const fs = options.fs ?? nodeShipperFs();
  const logger = options.logger ?? nullLogger;
  const shippers = new Map<string, EventShipper>();

  const stopShipper = async (jobId: string): Promise<void> => {
    const shipper = shippers.get(jobId);
    if (shipper === undefined) return;
    shippers.delete(jobId);
    try {
      await shipper.stop();
    } catch (err) {
      logger.warn(`shipper stop failed for job ${jobId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return {
    onWorkspaceReady: (context: JobWorkspaceContext): void => {
      const journalPath = journalPathFor(context);
      const transport =
        options.transport ??
        new WireUploadTransport({ sendFrame: options.send, dispatcher: options.dispatcher, clock: options.clock });
      const statsSource = options.statsSourceFor
        ? options.statsSourceFor(context)
        : new DiskStatsSource(fs, statsDirForJournal(journalPath));
      const shipper = new EventShipper({
        journalPath,
        transport,
        stateDir: options.stateDirFor ? options.stateDirFor(journalPath) : shipperStateDir(journalPath, options.env),
        projectRoot: context.dir,
        statsSource,
        fs,
        clock: options.clock,
        logger,
        env: options.env,
        // c6 (06.8.2): attempt fencing — a lease/record that carries an
        // event_seq_base starts this run's seq counter there, so a new
        // attempt's events land in their own window and can never collide
        // with (or be dedup-dropped against) a prior attempt's.
        ...(context.event_seq_base !== undefined
          ? { seqBase: { runId: context.run_id, base: context.event_seq_base } }
          : {}),
      });
      const previous = shippers.get(context.job_id);
      if (previous !== undefined) {
        // Defensive: onWorkspaceReady is documented as firing once per job.
        // A second firing for the same job_id would leak a running shipper.
        logger.warn(`job ${context.job_id}: onWorkspaceReady fired again — stopping the previous shipper`);
        void previous.stop();
      }
      shippers.set(context.job_id, shipper);
      shipper.start();
      logger.info(`shipper started for job ${context.job_id} (run ${context.run_id}, journal ${journalPath})`);
    },
    onTerminalFlush: (jobId: string): Promise<void> => stopShipper(jobId),
    onJobFinished: (result: JobResult): void => {
      void stopShipper(result.job_id);
    },
    stopAll: async (): Promise<void> => {
      await Promise.all([...shippers.keys()].map((jobId) => stopShipper(jobId)));
    },
  };
}
