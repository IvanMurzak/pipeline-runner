/**
 * @baizor/pipeline-runner — public surface of the runner CORE: identity/config
 * store, register handshake, WSS connection with reconnect/backoff + long-poll
 * fallback seam, heartbeat. Job execution, the event shipper, the needs-input
 * relay, and service install live in `./jobs`, `./shipper`, `./relay`, and
 * `./service` respectively (not re-exported here — see `src/cli.ts`).
 */

export * from './core/wire';
export * from './core/log';
export * from './core/clock';
export * from './core/config';
export * from './core/backoff';
export * from './core/dispatcher';
export * from './core/register';
// department-mesh d5 (P6): which credential the register frame carries.
export * from './core/register-credential';
export * from './core/heartbeat';
export * from './core/transport';
export * from './core/connection';
