/**
 * Needs-input RELAY (T1-13): surface `pipeline drive` questions over the WSS
 * `/agent/v1` channel as `needs_input` frames, and route the control plane's
 * `answer` frames back into `drive`'s resume path via an injectable
 * {@link DriveSession} seam.
 *
 * c3: `PullRelayAdapter` (`./adapter.ts`) is the production wiring — it
 * plugs into the executor's PULL seam (`../jobs/executor.ts`) and this
 * bridge's PUSH seam simultaneously, closing E3 ("T1-13 not wired"). See
 * `../cli.ts` for the construction order.
 */

export * from './wire-relay';
export * from './bridge';
export * from './adapter';
