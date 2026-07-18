import { describe, expect, test } from 'bun:test';
import { CaptureLogger, FakeClock, tick } from '../../tests/_helpers';
import { createGracefulShutdown } from './shutdown';

/** Seam-driven (Windows-portable — see the module doc's platform caveats):
 *  the SIGTERM/SIGINT wiring lives in cli.ts; the ORDER is what these prove. */
describe('createGracefulShutdown — drain order', () => {
  test('drain → suspend jobs → flush shippers → close connection → exit 0, in that exact order', async () => {
    const order: string[] = [];
    const shutdown = createGracefulShutdown({
      drain: () => order.push('drain'),
      suspendJobs: async () => {
        order.push('suspend');
      },
      flushShippers: async () => {
        order.push('flush');
      },
      closeConnection: () => order.push('close'),
      exit: (code) => order.push(`exit ${code}`),
      clock: new FakeClock(),
      logger: new CaptureLogger(),
    });
    await shutdown();
    expect(order).toEqual(['drain', 'suspend', 'flush', 'close', 'exit 0']);
  });

  test('idempotent: a second invocation (double ctrl-c) shares the in-flight run', async () => {
    let drains = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const exits: number[] = [];
    const shutdown = createGracefulShutdown({
      drain: () => {
        drains += 1;
      },
      suspendJobs: () => gate,
      flushShippers: async () => {},
      closeConnection: () => {},
      exit: (code) => exits.push(code),
      clock: new FakeClock(),
    });
    const first = shutdown();
    const second = shutdown();
    expect(second).toBe(first);
    release();
    await first;
    expect(drains).toBe(1);
    expect(exits).toEqual([0]);
  });

  test('a hung drain is capped by the timeout — exit 0 anyway (spool is durable)', async () => {
    const clock = new FakeClock();
    const logger = new CaptureLogger();
    const order: string[] = [];
    const shutdown = createGracefulShutdown({
      drain: () => {},
      suspendJobs: () => new Promise<void>(() => {}), // never settles (hung child)
      flushShippers: async () => {
        order.push('flush');
      },
      closeConnection: () => order.push('close'),
      exit: (code) => order.push(`exit ${code}`),
      timeoutMs: 10_000,
      clock,
      logger,
    });
    const done = shutdown();
    await tick();
    expect(order).toEqual([]); // still waiting on the hung suspend
    clock.advance(10_000);
    await done;
    expect(order).toEqual(['close', 'exit 0']); // flush never ran — suspend hung, cap hit
    expect(logger.joined()).toContain('exceeded');
  });
});
