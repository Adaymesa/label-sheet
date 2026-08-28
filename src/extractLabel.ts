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
import type {
  CustomsCategory,
  ExtractionResult,
  Label,
  PdfPageText,
  PositionedText,
} from './types.js';

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

/** A weight the label itself printed as all zeros: "0,0" means light, not empty. */
const ROUNDED_TO_ZERO = /^0[.,](0+)$/;

/**
 * Everything is reported in grams.
 *
 * The labels disagree about units and decimals: Correos Exprés prints "0,07 Kg", CN22
 * prints "0.177 Kg", an older Paq prints "1226" beside a separate "g". A sheet mixing
 * those is hard to read down a column, and grams makes every row a whole number in one
 * unit -- which is also how these parcels get weighed in the first place.
 *
 * A parcel never weighs nothing, so an all-zero value means the label's own precision
 * could not hold it: Sendcloud flattens some weights to one decimal, and a 40g parcel
 * comes out as "0,0 Kg". The real figure is nowhere in the PDF to recover, and printing
 * the zero verbatim reads as a failed extraction, so state the bound instead. It is
 * taken from the decimals the label shows, which holds whether the generator rounded or
 * truncated.
 */
function describeWeight(value: string, unit: 'kg' | 'g'): string {
  const perUnit = unit === 'kg' ? 1000 : 1;
  const zeros = ROUNDED_TO_ZERO.exec(value);
  if (zeros) return `under ${perUnit / 10 ** zeros[1]!.length} g`;
  return `${Math.round(Number(value.replace(',', '.')) * perUnit)} g`;
}

/** The Spanish variant heads the field with this; some print it without the colon. */
const CATEGORY_HEADING = /^Category of item:?$/i;

/** How far right of a tick its caption sits. Measured at 9-10pt; the next box is 27 away. */
const TICK_REACH_PT = 14;

/** How far below its heading the spelled-out value sits. Measured at about 12pt. */
const CATEGORY_VALUE_REACH_PT = 20;

/** Captions of the CN22 tick-box row, in the CN22 vocabulary. */
const TICK_BOXES: ReadonlyArray<readonly [string, CustomsCategory]> = [
  ['Gift', 'gift'],
  ['Comm.sample', 'commercial-sample'],
  ['Merch.', 'merchandise'],
  ['Docs', 'documents'],
  ['Returned Goods', 'returned-goods'],
  ['Others', 'other'],
];

/**
 * Words the Spanish variant prints, and only those seen on real labels.
 *
 * Translating the rest of the CN22 vocabulary on spec would be guessing at wording we
 * have never observed, and a wrong badge is worse than no badge.
 */
const CATEGORY_WORDS: ReadonlyArray<readonly [RegExp, CustomsCategory]> = [
  [/^regalos?$/i, 'gift'],
  [/^(venta de\s+)?mercanc[i\u00ed]as?$/i, 'merchandise'],
];

/**
 * Reads what the customs declaration says the parcel is.
 *
 * Two layouts, and they must not be confused. The English one prints a row of captions
 * with a literal "X" text item about 10pt to the left of whichever is ticked. The
 * Spanish one has no tick row at all: it heads the field "Category of item" and prints
 * the value below it -- and it has its own unrelated "X" further down the page, against
 * "Devolver al remitente". Matching ticks globally would read that one as a category, so
 * the tick rule only runs on labels that actually carry the caption row, and anchors on
 * the caption rather than on any fixed coordinate.
 */
function findCustomsCategory(items: readonly PositionedText[]): CustomsCategory | null {
  const boxes = items.flatMap((item) => {
    const hit = TICK_BOXES.find(([caption]) => caption === item.text.trim());
    return hit ? [{ item, category: hit[1] }] : [];
  });

  if (boxes.length > 0) {
    for (const tick of items.filter((i) => /^[Xx]$/.test(i.text.trim()))) {
      const owner = boxes
        .filter(
          ({ item }) =>
            Math.abs(item.y - tick.y) <= 3 &&
            item.x > tick.x &&
            item.x - tick.x <= TICK_REACH_PT,
        )
        .sort((a, b) => a.item.x - b.item.x)[0];
      if (owner) return owner.category;
    }
    return null;
  }

  const heading = items.find((i) => CATEGORY_HEADING.test(i.text.trim()));
  if (!heading) return null;

  const value = items
    .filter((i) => i.y > heading.y && i.y - heading.y < CATEGORY_VALUE_REACH_PT && i.x < 120)
    .sort((a, b) => a.y - b.y)[0];
  if (!value) return null;

  return CATEGORY_WORDS.find(([word]) => word.test(value.text.trim()))?.[1] ?? null;
}

function findWeight(items: readonly PositionedText[]): string | null {
  for (const item of items) {
    const m = WEIGHT.exec(item.text);
    if (m) return describeWeight(m[1]!, 'kg');
  }

  // Paq Estándar prints the heading and the value as separate items, stacked. Older
  // labels give the value in grams, with the unit as yet another item beside it.
  const heading = items.find((i) => WEIGHT_HEADING.test(i.text));
  if (heading) {
    const value = items
      .filter((i) => BARE_NUMBER.test(i.text) && i.y > heading.y && Math.abs(i.x - heading.x) <= 6)
      .sort((a, b) => a.y - b.y)[0];
    if (value) {
      const inGrams = items.some((i) => /^g(r|rs)?$/i.test(i.text) && Math.abs(i.y - value.y) <= 4);
      return describeWeight(value.text, inGrams ? 'g' : 'kg');
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
    category: findCustomsCategory(page.items),
    sourceName,
  };
  return { ok: true, label };
}
