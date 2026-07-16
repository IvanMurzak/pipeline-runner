/**
 * Needs-input RELAY (T1-13): surface `pipeline drive` questions over the WSS
 * `/agent/v1` channel as `needs_input` frames, and route the control plane's
 * `answer` frames back into `drive`'s resume path via an injectable
 * {@link DriveSession} seam. Unwired for now — the lease->execute loop that
 * drives it is a later task.
 */

export * from './wire-relay';
export * from './bridge';
