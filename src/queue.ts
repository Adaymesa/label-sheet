/**
 * queue.ts -- organising dropped labels into the days they were made on.
 *
 * The app is used one way: drop everything in the Downloads folder, print the batch
 * that has not gone to the post office yet. That makes the day a label was made the
 * one thing worth grouping by, and it is free -- a dropped File carries the time it
 * landed, so no PDF has to be opened to sort the pile.
 *
 * The days on offer come from the labels themselves rather than a fixed 1/2/3/7, so
 * an empty day is never a choice and a choice is never empty. Anything older than the
 * window is dropped: labels accumulate in Downloads for months, and a list going back
 * to March is not a list anyone reads.
 *
 * Pure and DOM-free. Nothing here knows what has been printed -- that record is
 * advisory and lives in `printed.ts`, so losing it cannot change what comes out.
 */
import type { Label } from './types.js';

/** A label paired with the one thing the PDF does not say: when its file was made. */
export interface DatedLabel {
  readonly label: Label;
  /** When the label file landed, in milliseconds since the epoch. */
  readonly madeAt: number;
}

/** One calendar day's labels, newest first. */
export interface DayGroup {
  /** The local calendar day as YYYY-MM-DD, and the key a day is selected by. */
  readonly day: string;
  readonly labels: readonly DatedLabel[];
}

/** A week, counting today. Older labels are still in Downloads; they are not on offer. */
export const WINDOW_DAYS = 7;

/** A window with no far edge, for when every label in the folder is wanted. */
export const ALL_DAYS = Number.POSITIVE_INFINITY;

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const pad = (n: number): string => String(n).padStart(2, '0');

/** Midnight local time on the day a timestamp falls in. */
const startOfDay = (ms: number): Date => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};

/**
 * The local calendar day a timestamp falls in, as YYYY-MM-DD.
 *
 * Local rather than UTC because a label made at 23:30 belongs to the evening she made
 * it, not to tomorrow. Zero-padded so the keys sort as dates without parsing.
 */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The oldest day a window reaches back to, or null when it reaches back forever.
 *
 * Calendar days, not multiples of 24 hours: an hour lost to daylight saving must not
 * quietly drop the oldest day out of the window, and `setDate` rolls months over.
 *
 * A window shorter than a day would put the cutoff in the future and exclude everything,
 * including today, so it is clamped to today rather than emptying the page.
 */
export function windowCutoff(now: number, windowDays: number): Date | null {
  if (!Number.isFinite(windowDays)) return null;

  const cutoff = startOfDay(now);
  cutoff.setDate(cutoff.getDate() - (Math.max(1, Math.floor(windowDays)) - 1));
  return cutoff;
}

/**
 * Whether a timestamp falls inside the window.
 *
 * One definition of "the last week", shared by the folder loader that decides which files
 * to open and the grouping that decides which days to offer. Two would drift, and a file
 * read but never shown is the confusing kind of bug.
 */
export function withinWindow(ms: number, now: number, windowDays: number): boolean {
  const cutoff = windowCutoff(now, windowDays);
  return cutoff === null || startOfDay(ms) >= cutoff;
}

/**
 * Group labels by the day they were made, newest day first, newest label first.
 *
 * @param labels every label currently on the page
 * @param now the clock, injected so this stays testable
 * @param windowDays how many calendar days back to offer, counting today; `ALL_DAYS` for
 *   no limit
 */
export function groupByDay(
  labels: readonly DatedLabel[],
  now: number,
  windowDays: number,
): readonly DayGroup[] {
  const byDay = new Map<string, DatedLabel[]>();
  for (const dated of labels) {
    // A label dated in the future means a wrong clock somewhere. Keep it and let it
    // sort to the top: showing one parcel too many is recoverable, hiding one is not.
    if (!withinWindow(dated.madeAt, now, windowDays)) continue;
    const key = dayKey(dated.madeAt);
    const day = byDay.get(key);
    if (day) day.push(dated);
    else byDay.set(key, [dated]);
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([day, group]) => ({
      day,
      labels: group.slice().sort((a, b) => b.madeAt - a.madeAt),
    }));
}

/**
 * The labels that will actually be printed, in the order they appear on the sheet.
 *
 * Selecting a day takes all of it; a label is then dropped one at a time. Holding the
 * two apart is what lets a whole day be re-selected without remembering which of its
 * labels were unticked last time.
 */
export function selectedLabels(
  groups: readonly DayGroup[],
  selectedDays: ReadonlySet<string>,
  excludedTrackings: ReadonlySet<string>,
): readonly DatedLabel[] {
  const chosen: DatedLabel[] = [];
  for (const group of groups) {
    if (!selectedDays.has(group.day)) continue;
    for (const dated of group.labels) {
      if (excludedTrackings.has(dated.label.tracking)) continue;
      chosen.push(dated);
    }
  }
  return chosen;
}

/**
 * A day heading a person reads without decoding it.
 *
 * "Today" and "Yesterday" are how the last two days get talked about; anything older
 * gets the weekday, because "did I do Friday's?" is the actual question.
 */
export function formatDay(day: string, today: string): string {
  if (day === today) return 'Today';

  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const when = new Date(year, month - 1, date);

  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  const yesterday = new Date(ty, tm - 1, td);
  yesterday.setDate(yesterday.getDate() - 1);
  if (when.getTime() === yesterday.getTime()) return 'Yesterday';

  const named = `${WEEKDAYS[when.getDay()]} ${when.getDate()} ${MONTHS[when.getMonth()]}`;
  // The year only when it is not this one. Within the week's window it never differs, but
  // an unlimited window reaches back years, and two March 2nds would read identically.
  return year === ty ? named : `${named} ${year}`;
}
