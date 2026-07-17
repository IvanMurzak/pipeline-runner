/**
 * Job execution (T2-03) — public surface.
 *
 *   lease (WSS) → accept → isolated workspace checkout → `pipeline drive`
 *   → run_status started → completed/halted, with provider-limit
 *   pause + auto-resume and an injectable needs-input seam (T1-13 relay).
 *
 * Everything is construction-time-lazy: importing this module starts no
 * timers, spawns no processes, opens no sockets. Wire it onto a running
 * `AgentClient` with `attachJobExecution(client, { runnerId, workspaceRoot, … })`.
 *
 * `./shipper-lifecycle` (c2) is the event-shipper composition seam: build it
 * with `createShipperLifecycle({ send, dispatcher, … })` and pass the result
 * as `attachJobExecution`'s `events` — one `EventShipper` per active job,
 * started at `onWorkspaceReady`, stopped at `onJobFinished`.
 */

export * from './wire';
export * from './types';
export * from './workspace';
export * from './drive';
export * from './executor';
export * from './manager';
export * from './shipper-lifecycle';
