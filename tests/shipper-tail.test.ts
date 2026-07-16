/**
 * Journal tail tests: byte-accurate line delivery, partial-line buffering,
 * multibyte safety, CRLF tolerance, cursor-offset resume, rotation reset.
 */

import { describe, expect, test } from 'bun:test';
import { JournalTail } from '../src/shipper/tail';
import { MemShipperFs } from './_shipper-helpers';

const JOURNAL = 'C:/proj/.claude/pipeline/.runtime/events.jsonl';

describe('JournalTail', () => {
  test('delivers complete lines once and never re-reads them', () => {
    const fs = new MemShipperFs();
    const tail = new JournalTail(fs, JOURNAL);
    expect(tail.poll().lines).toEqual([]); // file absent — waits

    fs.appendText(JOURNAL, '{"a":1}\n{"b":2}\n');
    expect(tail.poll().lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(tail.poll().lines).toEqual([]); // nothing new

    fs.appendText(JOURNAL, '{"c":3}\n');
    expect(tail.poll().lines).toEqual(['{"c":3}']);
  });

  test('buffers a half-written trailing line until its newline arrives', () => {
    const fs = new MemShipperFs();
    const tail = new JournalTail(fs, JOURNAL);
    fs.appendText(JOURNAL, '{"a":1}\n{"par');
    const first = tail.poll();
    expect(first.lines).toEqual(['{"a":1}']);
    expect(first.parseOffset).toBe(8); // through the newline only

    fs.appendText(JOURNAL, 'tial":true}\n');
    const second = tail.poll();
    expect(second.lines).toEqual(['{"partial":true}']);
    expect(second.parseOffset).toBe(8 + 17);
  });

  test('a multibyte character split across appends decodes intact', () => {
    const fs = new MemShipperFs();
    const tail = new JournalTail(fs, JOURNAL);
    const bytes = new TextEncoder().encode('{"emoji":"✅"}\n');
    fs.appendBytes(JOURNAL, bytes.slice(0, 11)); // cuts the ✅ mid-sequence
    expect(tail.poll().lines).toEqual([]);
    fs.appendBytes(JOURNAL, bytes.slice(11));
    expect(tail.poll().lines).toEqual(['{"emoji":"✅"}']);
  });

  test('tolerates CRLF journals', () => {
    const fs = new MemShipperFs();
    const tail = new JournalTail(fs, JOURNAL);
    fs.appendText(JOURNAL, '{"a":1}\r\n{"b":2}\r\n');
    expect(tail.poll().lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  test('resuming from a persisted parseOffset neither re-reads nor skips', () => {
    const fs = new MemShipperFs();
    const tail = new JournalTail(fs, JOURNAL);
    fs.appendText(JOURNAL, '{"a":1}\n{"b":2}\n');
    const poll = tail.poll();
    expect(poll.lines.length).toBe(2);

    // Restart: a NEW tail resumes from the persisted offset.
    fs.appendText(JOURNAL, '{"c":3}\n');
    const resumed = new JournalTail(fs, JOURNAL, poll.parseOffset);
    expect(resumed.poll().lines).toEqual(['{"c":3}']); // no re-read, no skip
  });

  test('a shrunk file is treated as rotation: reset to 0, new content read', () => {
    const fs = new MemShipperFs();
    const tail = new JournalTail(fs, JOURNAL);
    fs.appendText(JOURNAL, '{"old":1}\n{"old":2}\n');
    expect(tail.poll().lines.length).toBe(2);

    fs.setText(JOURNAL, '{"new":1}\n'); // rotation: shorter file
    const poll = tail.poll();
    expect(poll.rotated).toBe(true);
    expect(poll.lines).toEqual(['{"new":1}']);
    expect(poll.parseOffset).toBe(10);
  });
});
