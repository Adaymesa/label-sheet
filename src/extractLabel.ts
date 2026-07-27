/**
 * Pure extraction of a `Label` from a page's positioned text.
 *
 * Correos and Sendcloud print at least three different label layouts. Rather than
 * hard-coding coordinates per layout, this keys off structure that holds in all of them:
 *
 *   - a "TO" marker sits to the left of the recipient block, vertically beside it
 *   - the recipient block is a left-aligned column: name first, country last
 *   - phone numbers and "en caso de no entrega" boilerplate sit in *other* columns,
 *     so clustering on the left edge separates them out
 *
 * Anything we cannot read confidently is reported, never guessed at — a wrong name on the
 * sheet is worse than a missing one, and a wrong barcode is worse still.
 */
import type { ExtractionResult, Label, PdfPageText, PositionedText } from './types.js';

/** UPU S10 tracking number, e.g. LX554474175ES. The only format we emit a barcode for. */
const S10 = /\b([A-Z]{2}\d{9}[A-Z]{2})\b/;

/** Items within this many points of the same left edge belong to the same column. */
const COLUMN_TOLERANCE_PT = 4;

/**
 * How far above/below the "TO" marker the recipient block may extend.
 *
 * Measured from the real layouts: the block runs from -29pt (Sendcloud name) to +36pt
 * (Sendcloud country) relative to the marker's top edge. 40pt keeps that with headroom
 * while still excluding the sender block above and the delivery boilerplate below.
 */
const RECIPIENT_BAND_PT = 40;

const PHONE = /^\+?[\d\s()\-.]{7,}$/;
const WEIGHT = /(\d+(?:[.,]\d+)?)\s*kg\b/i;

const isFieldLabel = (t: string): boolean => t.endsWith(':');
const isPhone = (t: string): boolean => PHONE.test(t);

function findTrackingInText(items: readonly PositionedText[]): string | null {
  for (const item of items) {
    const m = S10.exec(item.text);
    if (m) return m[1]!;
  }
  return null;
}

/** Sendcloud names files `labels (3).pdf`; Correos names them by tracking number. */
function trackingFromFileName(sourceName: string): string | null {
  const stem = sourceName.replace(/\.pdf$/i, '');
  return S10.test(stem) && /^[A-Z]{2}\d{9}[A-Z]{2}$/.test(stem) ? stem : null;
}

/** Group items by left edge, so each group is one visual column. */
function toColumns(items: readonly PositionedText[]): PositionedText[][] {
  const columns: PositionedText[][] = [];
  for (const item of [...items].sort((a, b) => a.x - b.x)) {
    const last = columns[columns.length - 1];
    if (last && Math.abs(item.x - last[0]!.x) <= COLUMN_TOLERANCE_PT) last.push(item);
    else columns.push([item]);
  }
  return columns;
}

function findRecipientBlock(page: PdfPageText): PositionedText[] | null {
  const marker = page.items.find((i) => i.text === 'TO');
  if (!marker) return null;

  const markerRight = marker.x + marker.width;
  const candidates = page.items.filter(
    (i) =>
      i.x > markerRight - COLUMN_TOLERANCE_PT &&
      Math.abs(i.y - marker.y) <= RECIPIENT_BAND_PT &&
      !isFieldLabel(i.text) &&
      !isPhone(i.text),
  );
  if (candidates.length === 0) return null;

  // The address column is the one the "TO" marker points at: the one containing the item
  // closest to it vertically. Phone and boilerplate columns sit much further away.
  const columns = toColumns(candidates);
  let best: PositionedText[] | null = null;
  let bestDistance = Infinity;
  for (const column of columns) {
    const distance = Math.min(...column.map((i) => Math.abs(i.y - marker.y)));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = column;
    }
  }
  if (!best) return null;

  return [...best].sort((a, b) => a.y - b.y);
}

/**
 * Correos prints "0,07 Kg" and the CN22 layout prints "0.177 Kg". Normalise to the
 * comma form so a sheet mixing both formats reads consistently.
 */
function findWeight(items: readonly PositionedText[]): string | null {
  for (const item of items) {
    const m = WEIGHT.exec(item.text);
    if (m) return `${m[1]!.replace('.', ',')} kg`;
  }
  return null;
}

export function extractLabel(page: PdfPageText, sourceName: string): ExtractionResult {
  const fail = (reason: string): ExtractionResult => ({ ok: false, sourceName, reason });

  const fromName = trackingFromFileName(sourceName);
  const fromText = findTrackingInText(page.items);

  if (!fromName && !fromText) {
    return fail('No tracking number found. Only Correos-style codes (e.g. LX554474175ES) are supported.');
  }
  if (fromName && fromText && fromName !== fromText) {
    return fail(`Tracking number mismatch: file is named ${fromName} but the label reads ${fromText}.`);
  }
  const tracking = fromText ?? fromName!;

  const block = findRecipientBlock(page);
  if (!block || block.length === 0) {
    return fail('Could not locate the recipient address block on this label.');
  }

  const recipient = block[0]!.text;
  const destination = block[block.length - 1]!.text;

  const label: Label = {
    tracking,
    recipient,
    destination: destination === recipient ? '' : destination,
    weight: findWeight(page.items),
    sourceName,
  };
  return { ok: true, label };
}
