import { describe, it, expect } from 'vitest';
import { markPrinted, printedAt, prunePrinted, type PrintedRecord } from './printed.js';

const MONDAY = new Date(2026, 8, 7, 10).getTime();
const FRIDAY = new Date(2026, 8, 4, 10).getTime();

describe('markPrinted', () => {
  it('records when each tracking code was printed', () => {
    const record = markPrinted({}, ['LX1ES', 'LX2ES'], MONDAY);

    expect(record).toEqual({ LX1ES: MONDAY, LX2ES: MONDAY });
  });

  it('replaces an earlier print with the most recent one', () => {
    const record = markPrinted({ LX1ES: FRIDAY }, ['LX1ES'], MONDAY);

    expect(record['LX1ES']).toBe(MONDAY);
  });

  it('leaves entries it was not asked about alone', () => {
    const record = markPrinted({ LX1ES: FRIDAY }, ['LX2ES'], MONDAY);

    expect(record).toEqual({ LX1ES: FRIDAY, LX2ES: MONDAY });
  });

  it('does not mutate the record it was given', () => {
    const before: PrintedRecord = { LX1ES: FRIDAY };
    markPrinted(before, ['LX2ES'], MONDAY);

    expect(before).toEqual({ LX1ES: FRIDAY });
  });

  it('returns the record unchanged when nothing was printed', () => {
    expect(markPrinted({ LX1ES: FRIDAY }, [], MONDAY)).toEqual({ LX1ES: FRIDAY });
  });
});

describe('printedAt', () => {
  it('gives the time a label was last printed', () => {
    expect(printedAt({ LX1ES: FRIDAY }, 'LX1ES')).toBe(FRIDAY);
  });

  it('gives null for a label that has never been printed', () => {
    expect(printedAt({ LX1ES: FRIDAY }, 'LX2ES')).toBeNull();
  });

  it('gives null rather than trusting a corrupted entry', () => {
    // The record comes back from browser storage, which anything could have written.
    const record = JSON.parse('{"LX1ES":"friday"}') as PrintedRecord;

    expect(printedAt(record, 'LX1ES')).toBeNull();
  });

  it('is not fooled by inherited object properties', () => {
    expect(printedAt({}, 'toString')).toBeNull();
  });
});

describe('prunePrinted', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('keeps a print inside the retention window', () => {
    expect(prunePrinted({ LX1ES: MONDAY - 10 * DAY }, MONDAY, 90)).toEqual({
      LX1ES: MONDAY - 10 * DAY,
    });
  });

  it('forgets a print older than the retention window', () => {
    expect(prunePrinted({ LX1ES: MONDAY - 91 * DAY }, MONDAY, 90)).toEqual({});
  });

  it('drops entries that are not readable timestamps', () => {
    const record = JSON.parse('{"LX1ES":"friday","LX2ES":null}') as PrintedRecord;

    expect(prunePrinted(record, MONDAY, 90)).toEqual({});
  });

  it('does not mutate the record it was given', () => {
    const before: PrintedRecord = { LX1ES: MONDAY - 91 * DAY };
    prunePrinted(before, MONDAY, 90);

    expect(before).toEqual({ LX1ES: MONDAY - 91 * DAY });
  });
});
