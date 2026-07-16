/**
 * Minimal injectable logger seam. Every core module takes a `Logger` so tests
 * can capture output and assert — most importantly — that the runner token
 * NEVER appears in any log line. Never pass raw frames or the identity object
 * into a log call; log type names and redacted views only (see
 * `describeIdentity` in `config.ts`).
 */

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Default logger: plain console with a level prefix. */
export const consoleLogger: Logger = {
  debug: (message) => console.debug(`[pipeline-runner] ${message}`),
  info: (message) => console.log(`[pipeline-runner] ${message}`),
  warn: (message) => console.warn(`[pipeline-runner] warn: ${message}`),
  error: (message) => console.error(`[pipeline-runner] error: ${message}`),
};

/** Silent logger (default for library use in tests). */
export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
