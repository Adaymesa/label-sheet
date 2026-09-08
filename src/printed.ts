/**
 * printed.ts -- remembering which labels have already gone through the printer.
 *
 * This is the one thing no other system can observe. A marketplace is told the tracking
 * code before the parcel leaves the house, so "shipped" on Etsy says nothing about
 * whether the label is on paper; only the act of printing knows, and only here.
 *
 * It is deliberately advisory. It marks a row and never filters or blocks one, so if
 * browser storage is cleared the badge disappears and nothing else changes. That is what
 * lets the record live in localStorage without being a liability: the failure costs a
 * hint, never a parcel.
 *
 * Keyed on the tracking code rather than the filename, because Chrome writes a repeat
 * download as "LX555591685ES (1).pdf" and that is the same parcel.
 *
 * Pure and storage-free -- reading and writing happens at the edge in
 * `browser/printedStore.ts`.
 */

/** When each tracking code was last printed, in milliseconds since the epoch. */
export type PrintedRecord = Readonly<Record<string, number>>;

/**
 * Note that these labels have just been printed.
 *
 * Returns a new record; the input is never mutated.
 */
export function markPrinted(
  record: PrintedRecord,
  trackings: readonly string[],
  now: number,
): PrintedRecord {
  if (trackings.length === 0) return record;

  const next: Record<string, number> = { ...record };
  for (const tracking of trackings) next[tracking] = now;
  return next;
}

/**
 * When a label was last printed, or null if it never has been.
 *
 * The record is parsed back out of browser storage, so anything at all could be in it.
 * A value that is not a real timestamp is treated as no answer rather than shown as a
 * nonsense date, and `Object.hasOwn` keeps a tracking code called "toString" from
 * matching something off the prototype.
 */
export function printedAt(record: PrintedRecord, tracking: string): number | null {
  if (!Object.hasOwn(record, tracking)) return null;
  const at = record[tracking];
  return typeof at === 'number' && Number.isFinite(at) ? at : null;
}

/**
 * Forget prints older than `keepDays`, and drop anything unreadable.
 *
 * Nothing else ever removes an entry, so without this the record grows for the life of
 * the browser profile. A parcel posted three months ago is not one the badge has
 * anything useful to say about, and the sheet only ever offers the last week.
 */
export function prunePrinted(
  record: PrintedRecord,
  now: number,
  keepDays: number,
): PrintedRecord {
  const cutoff = now - keepDays * 24 * 60 * 60 * 1000;
  const kept: Record<string, number> = {};
  for (const tracking of Object.keys(record)) {
    const at = printedAt(record, tracking);
    if (at !== null && at >= cutoff) kept[tracking] = at;
  }
  return kept;
}
