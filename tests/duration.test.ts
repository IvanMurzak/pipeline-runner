import { describe, expect, test } from 'bun:test';
import { parseDurationSeconds } from '../src/core/duration';

describe('parseDurationSeconds', () => {
  test('parses the suffixed forms', () => {
    expect(parseDurationSeconds('7d')).toBe(604_800);
    expect(parseDurationSeconds('2h')).toBe(7_200);
    expect(parseDurationSeconds('45m')).toBe(2_700);
    expect(parseDurationSeconds('30s')).toBe(30);
  });

  test('parses a plain integer string as seconds', () => {
    expect(parseDurationSeconds('600')).toBe(600);
    expect(parseDurationSeconds('0')).toBe(0);
  });

  test('edge case: "0d" is a valid, zero-length duration', () => {
    expect(parseDurationSeconds('0d')).toBe(0);
  });

  test('trims surrounding whitespace', () => {
    expect(parseDurationSeconds('  7d  ')).toBe(604_800);
  });

  test('rejects negative amounts', () => {
    expect(parseDurationSeconds('-5d')).toBeNull();
    expect(parseDurationSeconds('-600')).toBeNull();
  });

  test('rejects decimals', () => {
    expect(parseDurationSeconds('1.5d')).toBeNull();
    expect(parseDurationSeconds('0.5')).toBeNull();
  });

  test('rejects an unknown/unsupported unit suffix', () => {
    expect(parseDurationSeconds('7w')).toBeNull(); // weeks not supported
    expect(parseDurationSeconds('7y')).toBeNull();
  });

  test('rejects internal whitespace, mixed units, and other garbage', () => {
    expect(parseDurationSeconds('7 d')).toBeNull();
    expect(parseDurationSeconds('1d2h')).toBeNull();
    expect(parseDurationSeconds('d7')).toBeNull();
    expect(parseDurationSeconds('seven days')).toBeNull();
    expect(parseDurationSeconds('7dd')).toBeNull();
    expect(parseDurationSeconds('Infinity')).toBeNull();
  });

  test('rejects empty and blank strings', () => {
    expect(parseDurationSeconds('')).toBeNull();
    expect(parseDurationSeconds('   ')).toBeNull();
  });

  test('rejects null/undefined without throwing', () => {
    expect(parseDurationSeconds(null)).toBeNull();
    expect(parseDurationSeconds(undefined)).toBeNull();
  });
});
