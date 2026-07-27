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

/** UPU S10 tracking number, e.g. LX554474175ES — international Correos services. */
const S10 = /\b([A-Z]{2}\d{9}[A-Z]{2})\b/;

/**
 * Paq Estándar (Correos premium) labels carry no S10 code. Their barcode encodes the
 * "Código de Bulto", which is printed in full beneath it — confirmed by decoding the bars.
 * The shorter "EXPEDICION" code on the same label is NOT what the barcode contains.
 *
 * Non-ASCII is written as \u escapes on purpose: the bundle is served as one HTML file
 * with no charset declaration, so a raw UTF-8 byte in a regex literal gets mis-decoded
 * and the pattern silently stops matching.
 */
const CODIGO_DE_BULTO = /C[o\u00f3]digo\s+(?:de\s+)?Bulto:\s*([A-Z0-9]{12,30})\b/i;

/** Older Paq labels print the caption and the code as two separate items on one line. */
const CODIGO_DE_BULTO_HEADING = /^C[o\u00f3]digo\s+(?:de\s+)?Bulto:$/i;
const PARCEL_CODE = /^[A-Z0-9]{12,30}$/;

/** Dotted rules that some Paq layouts use to fence off sender / recipient / notes. */
const SEPARATOR = /^[.\u00b7\-_\s]{10,}$/;

/** Markers that sit beside the recipient block, across the layouts Correos prints. */
const RECIPIENT_MARKERS = new Set(['TO', 'Destinatario', 'DESTINATARIO']);

/** The matching markers for the sender block, used to push its lines away. */
const SENDER_MARKERS = new Set(['FROM', 'Remitente', 'REMITENTE']);

/**
 * A line is treated as the sender's when it sits much nearer the sender marker than the
 * recipient one. "Much" matters: on the Paq layout the two blocks are far apart and the
 * recipient's name lands near the midpoint, so a plain nearest-marker test would steal it.
 */
const SENDER_PROXIMITY_RATIO = 0.6;

/** Items within this many points of the same left edge belong to the same column. */
const COLUMN_TOLERANCE_PT = 4;

/**
 * How far above/below the "TO" marker the recipient block may extend.
 *
 * Measured from the real layouts: the block runs from -29pt (Sendcloud name) to +36pt
 * (Sendcloud country) relative to the marker's top edge. 40pt keeps that with headroom
 * while still excluding the sender block above and the delivery boilerplate below.
 */
const RECIPIENT_BAND_PT = 45;

const PHONE = /^\+?[\d\s()\-.]{7,}$/;
const WEIGHT = /(\d+(?:[.,]\d+)?)\s*kg\b/i;

/** "Peso (Kg):" / "Peso:" print the value as a separate item underneath, not on the line. */
const WEIGHT_HEADING = /^Peso\s*(?:\(Kg\))?:?$/i;
const BARE_NUMBER = /^\d+(?:[.,]\d+)?$/;

/** "Observaciones:" but also "Código de Bulto: PQ…" — a caption, never a recipient line. */
const isFieldLabel = (t: string): boolean => t.endsWith(':') || /^[^:]{2,30}:\s\S/.test(t);
const isPhone = (t: string): boolean => PHONE.test(t);

function findTrackingInText(items: readonly PositionedText[]): string | null {
  for (const item of items) {
    const m = S10.exec(item.text);
    if (m) return m[1]!;
  }
  // No S10: fall back to the Paq Estándar parcel code, which is what its barcode encodes.
  for (const item of items) {
    const m = CODIGO_DE_BULTO.exec(item.text);
    if (m) return m[1]!.toUpperCase();
  }

  // Older Paq labels split the caption and the code into separate items on the same line.
  const heading = items.find((i) => CODIGO_DE_BULTO_HEADING.test(i.text));
  if (heading) {
    const value = items
      .filter((i) => PARCEL_CODE.test(i.text) && i.x > heading.x && Math.abs(i.y - heading.y) <= 4)
      .sort((a, b) => a.x - b.x)[0];
    if (value) return value.text.toUpperCase();
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
  const marker = page.items.find((i) => RECIPIENT_MARKERS.has(i.text));
  if (!marker) return null;

  const sender = page.items.find((i) => SENDER_MARKERS.has(i.text));

  // Where the layout draws dotted rules, they fence the recipient block far more reliably
  // than any distance from the marker can. Use them when they are there.
  const rules = page.items.filter((i) => SEPARATOR.test(i.text)).map((i) => i.y);
  const above = Math.max(-Infinity, ...rules.filter((y) => y < marker.y));
  const below = Math.min(Infinity, ...rules.filter((y) => y > marker.y));
  const fenced = rules.length > 0 && above > -Infinity;

  // Compare against the marker's LEFT edge, not its right: these markers are printed
  // sideways, so their reported width runs down the label rather than across it.
  const candidates = page.items.filter((i) => {
    if (i === marker || i.x <= marker.x + 2) return false;
    if (SEPARATOR.test(i.text)) return false;
    if (fenced) {
      if (i.y <= above || i.y >= below) return false;
    } else if (Math.abs(i.y - marker.y) > RECIPIENT_BAND_PT) {
      return false;
    }
    if (isFieldLabel(i.text) || isPhone(i.text)) return false;
    if (!fenced && sender) {
      const toSender = Math.abs(i.y - sender.y);
      const toRecipient = Math.abs(i.y - marker.y);
      if (toSender < toRecipient * SENDER_PROXIMITY_RATIO) return false;
    }
    return true;
  });
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

  // Paq Estándar prints the heading and the value as separate items, stacked. Older
  // labels give the value in grams, with the unit as yet another item beside it.
  const heading = items.find((i) => WEIGHT_HEADING.test(i.text));
  if (heading) {
    const value = items
      .filter((i) => BARE_NUMBER.test(i.text) && i.y > heading.y && Math.abs(i.x - heading.x) <= 6)
      .sort((a, b) => a.y - b.y)[0];
    if (value) {
      const grams = items.some((i) => /^g(r|rs)?$/i.test(i.text) && Math.abs(i.y - value.y) <= 4);
      if (grams) {
        const kg = Number(value.text.replace(',', '.')) / 1000;
        return `${kg.toFixed(3).replace(/0+$/, '').replace(/\.$/, '').replace('.', ',')} kg`;
      }
      return `${value.text.replace('.', ',')} kg`;
    }
  }
  return null;
}

export function extractLabel(page: PdfPageText, sourceName: string): ExtractionResult {
  const fail = (reason: string): ExtractionResult => ({ ok: false, sourceName, reason });

  const fromName = trackingFromFileName(sourceName);
  const fromText = findTrackingInText(page.items);

  if (!fromName && !fromText) {
    return fail(
      'No barcode found. Correos tracking numbers (LX554474175ES) and Paq parcel codes are supported.',
    );
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
