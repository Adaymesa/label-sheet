/**
 * printedStore.ts -- the print record, on this browser.
 *
 * An adapter, and the only file that knows the record is stored at all. The rules it
 * lives by come from what the record is for: it decorates a row and never decides one,
 * so every failure here is answered with "nothing printed yet" rather than an error.
 *
 * localStorage can throw rather than return empty -- Safari's private mode, a profile
 * with site data blocked, and a page opened from a file:// path all do -- so every call
 * is guarded. Losing the record costs a badge, so there is nothing here worth
 * interrupting a print run for.
 */
import { prunePrinted, type PrintedRecord } from '../printed.js';

const KEY = 'label-sheet.printed.v1';

/** Long enough to cover any parcel still worth asking about, short enough to stay small. */
const KEEP_DAYS = 90;

/**
 * Read the record, pruned of anything stale or unreadable.
 *
 * Anything at all could be under this key -- another version of the app, a hand-edited
 * profile, a half-written value -- so the parsed result is only trusted as far as
 * `prunePrinted` can verify it, entry by entry.
 */
export function loadPrinted(now: number): PrintedRecord {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    return {};
  }
  if (!raw) return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return prunePrinted(parsed as PrintedRecord, now, KEEP_DAYS);
  } catch {
    return {};
  }
}

/** Write the record back, or carry on without it. */
export function savePrinted(record: PrintedRecord): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(record));
  } catch {
    // Full, blocked, or unavailable. The sheet still prints; only the badge is lost.
  }
}
