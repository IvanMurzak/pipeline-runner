import { describe, expect, test } from 'bun:test';
import { Dispatcher, RESERVED_UNHANDLED_TYPES } from '../src/core/dispatcher';
import type { WireFrame } from '../src/core/wire';
import { CaptureLogger } from './_helpers';

describe('Dispatcher', () => {
  test('routes a frame to its registered handler', () => {
    const dispatcher = new Dispatcher();
    const seen: WireFrame[] = [];
    dispatcher.on('heartbeat_ack', (frame) => seen.push(frame));
    const handled = dispatcher.dispatch({ type: 'heartbeat_ack', id: 'h1' });
    expect(handled).toBe(true);
    expect(seen).toEqual([{ type: 'heartbeat_ack', id: 'h1' }]);
  });

  test('multiple handlers on one type all run', () => {
    const dispatcher = new Dispatcher();
    let calls = 0;
    dispatcher.on('lease', () => calls++);
    dispatcher.on('lease', () => calls++);
    dispatcher.dispatch({ type: 'lease' });
    expect(calls).toBe(2);
  });

  test('unsubscribe stops routing', () => {
    const dispatcher = new Dispatcher();
    let calls = 0;
    const off = dispatcher.on('cancel', () => calls++);
    dispatcher.dispatch({ type: 'cancel' });
    off();
    dispatcher.dispatch({ type: 'cancel' });
    expect(calls).toBe(1);
  });

  test('reserved-but-unhandled protocol types are logged and ignored, not thrown', () => {
    const logger = new CaptureLogger();
    const dispatcher = new Dispatcher(logger);
    for (const type of RESERVED_UNHANDLED_TYPES) {
      expect(dispatcher.dispatch({ type })).toBe(false);
    }
    expect(logger.joined()).toContain("frame 'lease' not handled yet (ignored)");
    expect(logger.joined()).toContain("frame 'upload_ack' not handled yet (ignored)");
  });

  test('unknown (future additive) types are ignored gracefully', () => {
    const logger = new CaptureLogger();
    const dispatcher = new Dispatcher(logger);
    expect(dispatcher.dispatch({ type: 'telemetry_probe', id: 'z' })).toBe(false);
    expect(logger.joined()).toContain("unknown frame type 'telemetry_probe' (ignored)");
  });

  test('a later task can attach a handler for a reserved type (the T1-12/T1-13 hook)', () => {
    const dispatcher = new Dispatcher();
    const leases: WireFrame[] = [];
    dispatcher.dispatch({ type: 'lease', job_id: 'j0' }); // pre-attach: ignored
    dispatcher.on('lease', (frame) => leases.push(frame));
    dispatcher.dispatch({ type: 'lease', job_id: 'j1' });
    expect(leases).toHaveLength(1);
    expect(leases[0]!.job_id).toBe('j1');
  });

  test('a throwing handler is contained and does not block others', () => {
    const logger = new CaptureLogger();
    const dispatcher = new Dispatcher(logger);
    let ran = false;
    dispatcher.on('answer', () => {
      throw new Error('boom');
    });
    dispatcher.on('answer', () => {
      ran = true;
    });
    expect(dispatcher.dispatch({ type: 'answer' })).toBe(true);
    expect(ran).toBe(true);
    expect(logger.joined()).toContain("handler for 'answer' threw: boom");
  });
});
