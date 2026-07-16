import { describe, expect, test } from 'bun:test';
import {
  isCompatible,
  isHeartbeatAck,
  isRegisterAck,
  isRegisterReject,
  parseWireFrame,
  PROTOCOL_VERSION,
} from '../src/core/wire';

describe('parseWireFrame', () => {
  test('accepts a minimal frame', () => {
    expect(parseWireFrame({ type: 'ping' })).toEqual({ type: 'ping' });
  });

  test('accepts a frame with a correlation id', () => {
    expect(parseWireFrame({ type: 'ping', id: 'x1' })).toEqual({ type: 'ping', id: 'x1' });
  });

  test('preserves unknown extra fields (passthrough / additive-forward)', () => {
    const frame = parseWireFrame({ type: 'lease', id: 'a', job_id: 'j1', future_field: { nested: true } });
    expect(frame).not.toBeNull();
    expect(frame!.future_field).toEqual({ nested: true });
    expect(frame!.job_id).toBe('j1');
  });

  test('rejects non-objects and malformed envelopes', () => {
    expect(parseWireFrame(null)).toBeNull();
    expect(parseWireFrame(undefined)).toBeNull();
    expect(parseWireFrame(42)).toBeNull();
    expect(parseWireFrame('register')).toBeNull();
    expect(parseWireFrame([{ type: 'x' }])).toBeNull();
    expect(parseWireFrame({})).toBeNull();
    expect(parseWireFrame({ type: '' })).toBeNull();
    expect(parseWireFrame({ type: 42 })).toBeNull();
    expect(parseWireFrame({ type: 'ok', id: '' })).toBeNull();
    expect(parseWireFrame({ type: 'ok', id: 7 })).toBeNull();
  });
});

describe('isCompatible', () => {
  test('same major is compatible', () => {
    expect(isCompatible(PROTOCOL_VERSION)).toBe(true);
  });

  test('different major / non-integers are not', () => {
    expect(isCompatible(PROTOCOL_VERSION + 1)).toBe(false);
    expect(isCompatible(0)).toBe(false);
    expect(isCompatible(1.5)).toBe(false);
    expect(isCompatible(NaN)).toBe(false);
  });
});

describe('inbound frame guards', () => {
  test('isRegisterAck accepts a well-formed ack (with and without cadence)', () => {
    expect(isRegisterAck({ type: 'register_ack', protocol_version: 1, runner_id: 'r-1' })).toBe(true);
    expect(
      isRegisterAck({ type: 'register_ack', protocol_version: 1, runner_id: 'r-1', heartbeat_interval_s: 30 })
    ).toBe(true);
  });

  test('isRegisterAck rejects malformed acks', () => {
    expect(isRegisterAck({ type: 'register_ack', protocol_version: 1 })).toBe(false); // no runner_id
    expect(isRegisterAck({ type: 'register_ack', protocol_version: 1, runner_id: '' })).toBe(false);
    expect(isRegisterAck({ type: 'register_ack', protocol_version: 0, runner_id: 'r' })).toBe(false);
    expect(isRegisterAck({ type: 'register_ack', protocol_version: 1, runner_id: 'r', heartbeat_interval_s: -5 })).toBe(false);
    expect(isRegisterAck({ type: 'other', protocol_version: 1, runner_id: 'r' })).toBe(false);
  });

  test('isRegisterReject accepts every defined reason', () => {
    for (const reason of ['upgrade_required', 'invalid_token', 'revoked', 'capacity']) {
      expect(isRegisterReject({ type: 'register_reject', reason })).toBe(true);
    }
    expect(isRegisterReject({ type: 'register_reject', reason: 'upgrade_required', min_protocol_version: 2 })).toBe(true);
  });

  test('isRegisterReject rejects unknown reasons and bad fields (mirrors the strict zod enum)', () => {
    expect(isRegisterReject({ type: 'register_reject', reason: 'bogus' })).toBe(false);
    expect(isRegisterReject({ type: 'register_reject' })).toBe(false);
    expect(isRegisterReject({ type: 'register_reject', reason: 'capacity', min_protocol_version: 0 })).toBe(false);
  });

  test('isHeartbeatAck accepts absent, null, and every defined directive', () => {
    expect(isHeartbeatAck({ type: 'heartbeat_ack' })).toBe(true);
    expect(isHeartbeatAck({ type: 'heartbeat_ack', id: 'h1', directive: null })).toBe(true);
    for (const directive of ['none', 'reregister', 'drain']) {
      expect(isHeartbeatAck({ type: 'heartbeat_ack', directive })).toBe(true);
    }
  });

  test('isHeartbeatAck rejects unknown directives', () => {
    expect(isHeartbeatAck({ type: 'heartbeat_ack', directive: 'explode' })).toBe(false);
    expect(isHeartbeatAck({ type: 'heartbeat', directive: 'none' })).toBe(false);
  });
});
