/**
 * Test fakes for the `service` module: a scriptable exec that records the exact
 * command sequence, and an in-memory service fs that records writes/removes.
 * Underscore-prefixed so `bun test` does not run it as a suite.
 */

import type { ServiceExec, ServiceExecResult, ServiceFs } from '../src/service/types';

export interface ExecCall {
  cmd: string;
  args: string[];
}

/**
 * Records every `run` and returns a scripted result. The handler gets each call
 * and returns a partial result (defaults: code 0, empty stdout/stderr).
 */
export class FakeExec implements ServiceExec {
  calls: ExecCall[] = [];

  constructor(private readonly handler: (call: ExecCall) => Partial<ServiceExecResult> = () => ({})) {}

  run(cmd: string, args: string[]): ServiceExecResult {
    this.calls.push({ cmd, args });
    const r = this.handler({ cmd, args });
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  /** Flat "cmd arg arg" strings, in order — convenient for sequence asserts. */
  get sequence(): string[] {
    return this.calls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
  }
}

/** In-memory service filesystem; `seed` pre-populates a file (e.g. for status). */
export class FakeServiceFs implements ServiceFs {
  files = new Map<string, string>();
  dirs = new Set<string>();
  removed: string[] = [];

  seed(path: string, data = ''): this {
    this.files.set(path, data);
    return this;
  }

  writeFileText(path: string, data: string): void {
    this.files.set(path, data);
  }

  readFileText(path: string): string | null {
    return this.files.get(path) ?? null;
  }

  removeFile(path: string): void {
    this.files.delete(path);
    this.removed.push(path);
  }

  mkdirp(path: string): void {
    this.dirs.add(path);
  }

  exists(path: string): boolean {
    return this.files.has(path);
  }
}
