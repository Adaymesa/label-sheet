import { describe, it, expect } from 'vitest';
import {
  ALL_DAYS,
  dayKey,
  formatDay,
  groupByDay,
  selectedLabels,
  windowCutoff,
  withinWindow,
  WINDOW_DAYS,
} from './queue.js';
import type { DatedLabel } from './queue.js';

/**
 * Timestamps are built with the local Date constructor and read back as local calendar
 * days, so these tests hold in any timezone the suite happens to run in.
 */
const at = (y: number, month: number, day: number, hour = 12): number =>
  new Date(y, month - 1, day, hour).getTime();

const parcel = (tracking: string, madeAt: number): DatedLabel => ({
  madeAt,
  label: {
    tracking,
    recipient: 'A Buyer',
    destination: 'Somewhere',
    weight: null,
    category: null,
    sourceName: `${tracking}.pdf`,
  },
});

const trackingsOf = (labels: readonly DatedLabel[]): string[] =>
  labels.map((l) => l.label.tracking);

describe('dayKey', () => {
  it('names the local calendar day the label was made on', () => {
    expect(dayKey(at(2026, 9, 7))).toBe('2026-09-07');
  });

  it('pads month and day so keys sort as dates', () => {
    expect(dayKey(at(2026, 1, 3))).toBe('2026-01-03');
    expect(dayKey(at(2026, 1, 3)) < dayKey(at(2026, 1, 10))).toBe(true);
  });

  it('keeps late and early hours of the same day together', () => {
    expect(dayKey(at(2026, 9, 7, 0))).toBe(dayKey(at(2026, 9, 7, 23)));
  });
});

describe('windowCutoff', () => {
  const now = at(2026, 9, 7);

  it('reaches back to midnight on the oldest day in the window', () => {
    expect(windowCutoff(now, WINDOW_DAYS)).toEqual(new Date(2026, 8, 1));
  });

  it('is today alone for a one day window', () => {
    expect(windowCutoff(now, 1)).toEqual(new Date(2026, 8, 7));
  });

  it('has no far edge when the window is unlimited', () => {
    expect(windowCutoff(now, ALL_DAYS)).toBeNull();
  });

  it('clamps a window shorter than a day to today rather than emptying the page', () => {
    expect(windowCutoff(now, 0)).toEqual(new Date(2026, 8, 7));
    expect(windowCutoff(now, -5)).toEqual(new Date(2026, 8, 7));
  });

  it('ignores a fractional window rather than producing an invalid date', () => {
    expect(windowCutoff(now, 7.9)).toEqual(new Date(2026, 8, 1));
  });

  it('has no far edge for a NaN window rather than excluding everything', () => {
    expect(windowCutoff(now, Number.NaN)).toBeNull();
  });
});

describe('withinWindow', () => {
  const now = at(2026, 9, 7);

  it('accepts a timestamp on the oldest day in the window', () => {
    expect(withinWindow(at(2026, 9, 1, 0), now, WINDOW_DAYS)).toBe(true);
    expect(withinWindow(at(2026, 9, 1, 23), now, WINDOW_DAYS)).toBe(true);
  });

  it('rejects the day before the window', () => {
    expect(withinWindow(at(2026, 8, 31, 23), now, WINDOW_DAYS)).toBe(false);
  });

  it('accepts anything at all when the window is unlimited', () => {
    expect(withinWindow(at(2019, 1, 1), now, ALL_DAYS)).toBe(true);
  });

  it('accepts a future timestamp, which is a wrong clock rather than a stale label', () => {
    expect(withinWindow(at(2026, 12, 25), now, WINDOW_DAYS)).toBe(true);
  });
});

describe('groupByDay', () => {
  const now = at(2026, 9, 7);

  it('keeps every day when the window is unlimited', () => {
    const groups = groupByDay(
      [parcel('recent', at(2026, 9, 7)), parcel('ancient', at(2019, 3, 2))],
      now,
      ALL_DAYS,
    );

    expect(groups.map((g) => g.day)).toEqual(['2026-09-07', '2019-03-02']);
  });

  it('returns nothing when there are no labels', () => {
    expect(groupByDay([], now, WINDOW_DAYS)).toEqual([]);
  });

  it('puts labels made on the same day into one group', () => {
    const groups = groupByDay(
      [parcel('A', at(2026, 9, 7, 9)), parcel('B', at(2026, 9, 7, 17))],
      now,
      WINDOW_DAYS,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]!.day).toBe('2026-09-07');
    expect(groups[0]!.labels).toHaveLength(2);
  });

  it('orders days newest first', () => {
    const groups = groupByDay(
      [parcel('older', at(2026, 9, 4)), parcel('newer', at(2026, 9, 6))],
      now,
      WINDOW_DAYS,
    );

    expect(groups.map((g) => g.day)).toEqual(['2026-09-06', '2026-09-04']);
  });

  it('orders labels within a day newest first', () => {
    const groups = groupByDay(
      [parcel('morning', at(2026, 9, 7, 9)), parcel('evening', at(2026, 9, 7, 20))],
      now,
      WINDOW_DAYS,
    );

    expect(trackingsOf(groups[0]!.labels)).toEqual(['evening', 'morning']);
  });

  it('offers only the days that actually have labels', () => {
    const groups = groupByDay(
      [parcel('A', at(2026, 9, 7)), parcel('B', at(2026, 9, 3))],
      now,
      WINDOW_DAYS,
    );

    // Nothing was made on the 4th, 5th or 6th, so those days are not on offer.
    expect(groups.map((g) => g.day)).toEqual(['2026-09-07', '2026-09-03']);
  });

  it('includes the oldest day still inside the window', () => {
    // A seven day window is today and the six days before it.
    const groups = groupByDay([parcel('edge', at(2026, 9, 1))], now, WINDOW_DAYS);

    expect(groups.map((g) => g.day)).toEqual(['2026-09-01']);
  });

  it('excludes a label older than the window', () => {
    expect(groupByDay([parcel('stale', at(2026, 8, 31))], now, WINDOW_DAYS)).toEqual([]);
  });

  it('keeps a label dated in the future rather than dropping it', () => {
    // A clock that is wrong should cost a moment of confusion, never a lost parcel.
    const groups = groupByDay([parcel('ahead', at(2026, 9, 8))], now, WINDOW_DAYS);

    expect(groups.map((g) => g.day)).toEqual(['2026-09-08']);
  });

  it('keeps only today when the window is one day', () => {
    const groups = groupByDay(
      [parcel('today', at(2026, 9, 7)), parcel('yesterday', at(2026, 9, 6))],
      now,
      1,
    );

    expect(groups.map((g) => g.day)).toEqual(['2026-09-07']);
  });

  it('keeps every in-window label and drops every older one', () => {
    // What is left out is worth counting, so the page can say so rather than swallow it.
    const groups = groupByDay(
      [
        parcel('today', at(2026, 9, 7)),
        parcel('edge', at(2026, 9, 1)),
        parcel('old', at(2026, 8, 31)),
        parcel('ancient', at(2026, 3, 2)),
      ],
      now,
      WINDOW_DAYS,
    );

    const kept = groups.reduce((n, g) => n + g.labels.length, 0);
    expect(kept).toBe(2);
    expect(groups.flatMap((g) => trackingsOf(g.labels)).sort()).toEqual(['edge', 'today']);
  });

  it('walks the window back across a month boundary', () => {
    const october = at(2026, 10, 2);
    const groups = groupByDay([parcel('september', at(2026, 9, 28))], october, WINDOW_DAYS);

    expect(groups.map((g) => g.day)).toEqual(['2026-09-28']);
  });
});

describe('selectedLabels', () => {
  const now = at(2026, 9, 7);
  const groups = groupByDay(
    [
      parcel('today-1', at(2026, 9, 7, 9)),
      parcel('today-2', at(2026, 9, 7, 18)),
      parcel('friday-1', at(2026, 9, 4)),
    ],
    now,
    WINDOW_DAYS,
  );

  it('takes every label in a selected day', () => {
    const chosen = selectedLabels(groups, new Set(['2026-09-07']), new Set());

    expect(trackingsOf(chosen)).toEqual(['today-2', 'today-1']);
  });

  it('ignores days that are not selected', () => {
    const chosen = selectedLabels(groups, new Set(['2026-09-04']), new Set());

    expect(trackingsOf(chosen)).toEqual(['friday-1']);
  });

  it('drops a label that has been unticked', () => {
    const chosen = selectedLabels(groups, new Set(['2026-09-07']), new Set(['today-1']));

    expect(trackingsOf(chosen)).toEqual(['today-2']);
  });

  it('keeps sheet order across several selected days', () => {
    const chosen = selectedLabels(groups, new Set(['2026-09-07', '2026-09-04']), new Set());

    expect(trackingsOf(chosen)).toEqual(['today-2', 'today-1', 'friday-1']);
  });

  it('returns nothing when no day is selected', () => {
    expect(selectedLabels(groups, new Set(), new Set())).toEqual([]);
  });

  it('ignores an exclusion for a label that is not there', () => {
    const chosen = selectedLabels(groups, new Set(['2026-09-04']), new Set(['gone']));

    expect(trackingsOf(chosen)).toEqual(['friday-1']);
  });
});

describe('formatDay', () => {
  const today = '2026-09-07';

  it('names today', () => {
    expect(formatDay('2026-09-07', today)).toBe('Today');
  });

  it('names yesterday', () => {
    expect(formatDay('2026-09-06', today)).toBe('Yesterday');
  });

  it('gives an older day its weekday and date', () => {
    expect(formatDay('2026-09-04', today)).toBe('Friday 4 Sep');
  });

  it('names a day in the future by its date rather than calling it today', () => {
    expect(formatDay('2026-09-08', today)).toBe('Tuesday 8 Sep');
  });

  it('adds the year for a day in another one, which an unlimited window reaches', () => {
    // Two March 2nds a year apart would otherwise be the same heading.
    expect(formatDay('2025-03-02', today)).toBe('Sunday 2 Mar 2025');
    expect(formatDay('2026-03-02', today)).toBe('Monday 2 Mar');
  });
});
