/**
 * Writes the printed sheet as a PDF.
 *
 * The barcodes are *drawn*, not rasterised: each bar is a filled rectangle in PDF user
 * space, so the symbol is exact at any zoom and on any printer. Screenshotting the page
 * into an image would have been far less code and would have put the one thing this
 * project exists to get right -- a scannable barcode -- at the mercy of a resolution
 * guess.
 *
 * Text uses the three fonts every PDF reader already has, so nothing has to be embedded
 * and the file stays a few kilobytes. That buys a limit: the standard encoding covers
 * Latin-1 and little else, so a name it cannot spell is passed in already drawn, as a
 * one-bit image. See `canEncode`.
 *
 * Pure: builds bytes, touches no DOM and no files.
 */
import { barcodeGeometry } from './barcodeSvg.js';

const MM = 72 / 25.4;

const PAGE_W_MM = 210;
const PAGE_H_MM = 297;
const MARGIN_MM = 11;
const COLUMN_GAP_MM = 10;
const COLUMN_W_MM = (PAGE_W_MM - 2 * MARGIN_MM - COLUMN_GAP_MM) / 2;

/** Matches the on-screen sheet: eight rows a column, two columns, sixteen to a page. */
const ROW_H_MM = 34;
const ROWS_PER_COLUMN = Math.floor((PAGE_H_MM - 2 * MARGIN_MM) / ROW_H_MM);
export const ROWS_PER_PAGE = ROWS_PER_COLUMN * 2;

/** Offsets within a row, in mm from its top edge. */
const NAME_BASELINE_MM = 4.2;
const META_BASELINE_MM = 8.8;
const BARCODE_TOP_MM = 11.5;
const BARCODE_H_MM = 16;
const TRACKING_BASELINE_MM = 31;
const RULE_MM = 32.8;

const NAME_PT = 11;
const TAG_PT = 6.5;
const META_PT = 8.5;
const TRACKING_PT = 8.5;

/** Courier is monospaced at 600/1000 em, which is what lets the number be centred exactly. */
const COURIER_ADVANCE = 0.6;

const DEFAULT_MODULE_MM = 0.5;

/**
 * WinAnsi code points that are not simply Latin-1. Written as escapes on purpose: the
 * app ships as one HTML file with no charset declaration, and the build refuses any
 * non-ASCII byte for exactly that reason.
 */
const WIN_ANSI_SPECIALS = new Map<number, number>([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85],
  [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a],
  [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92],
  [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c],
  [0x017e, 0x9e], [0x0178, 0x9f],
]);

/** The bytes for `text` in WinAnsi, or null if a standard font cannot spell it. */
export function toWinAnsi(text: string): number[] | null {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const special = WIN_ANSI_SPECIALS.get(cp);
    if (special !== undefined) {
      out.push(special);
    } else if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) {
      out.push(cp);
    } else {
      return null;
    }
  }
  return out;
}

/** Whether a standard PDF font can spell this. Callers draw anything else themselves. */
export const canEncode = (text: string): boolean => toWinAnsi(text) !== null;

const widthTable = (spec: string): number[] =>
  spec.trim().split(/\s+/).map(Number);

/**
 * Adobe's advance widths, per 1000 em, for code points 32 to 126.
 *
 * Only ever used to decide what fits, so a stale value costs a slightly early ellipsis,
 * never a wrong number on the page.
 */
const HELVETICA_BOLD = widthTable(`
  278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278
  556 556 556 556 556 556 556 556 556 556 333 333 584 584 584 611
  975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778
  667 778 722 667 611 722 667 944 667 667 611 333 278 333 584 556
  333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611
  611 611 389 556 333 611 556 778 556 556 500 389 280 389 584
`);

const HELVETICA = widthTable(`
  278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278
  556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556
  1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778
  667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556
  333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556
  556 556 333 500 278 556 500 722 500 500 500 334 260 334 584
`);

/** Accented letters are close enough to their base letter for a fitting decision. */
const FALLBACK_WIDTH = 556;

function advance(bytes: readonly number[], table: readonly number[], sizePt: number): number {
  let total = 0;
  for (const b of bytes) {
    total += (b >= 32 && b <= 126 ? table[b - 32]! : FALLBACK_WIDTH) / 1000;
  }
  return total * sizePt;
}

/** Shorten until it fits, with an ellipsis to say so. Returns the bytes to draw. */
function fit(bytes: readonly number[], table: readonly number[], sizePt: number, maxPt: number): number[] {
  if (advance(bytes, table, sizePt) <= maxPt) return [...bytes];
  const dots = [0x2e, 0x2e, 0x2e];
  let kept = [...bytes];
  while (kept.length > 0 && advance([...kept, ...dots], table, sizePt) > maxPt) kept.pop();
  return [...kept, ...dots];
}

/** A name a standard font cannot spell, handed over already drawn. One bit per pixel. */
export interface InkImage {
  readonly widthPx: number;
  readonly heightPx: number;
  /** Rows padded to whole bytes, most significant bit first, 1 meaning ink. */
  readonly bits: Uint8Array;
  /** How tall to draw it, in mm. The width follows from the aspect ratio. */
  readonly heightMm: number;
}

export interface SheetRow {
  readonly name: string | InkImage;
  /** Already-joined destination and weight, exactly as the screen shows it. */
  readonly meta: string;
  readonly tracking: string;
  /** Short wording for the customs tag, and whether it is the filled one. */
  readonly tag: { readonly text: string; readonly filled: boolean } | null;
}

const isImage = (name: string | InkImage): name is InkImage => typeof name !== 'string';

/** A PDF literal string: escape what must be escaped, keep the rest readable. */
function literal(bytes: readonly number[]): string {
  let out = '(';
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += '\\' + String.fromCharCode(b);
    else if (b < 0x20 || b > 0x7e) out += '\\' + b.toString(8).padStart(3, '0');
    else out += String.fromCharCode(b);
  }
  return out + ')';
}

const ascii = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

/** Three decimals is well under a printer's resolution and keeps the file small. */
const n = (v: number): string => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
};

interface Placed {
  readonly text: string;
  readonly images: readonly { readonly ref: string; readonly image: InkImage }[];
}

/** Draws one row, with the page origin at the bottom left as PDF has it. */
function drawRow(row: SheetRow, xMm: number, topMm: number, imageIndex: number): Placed {
  const out: string[] = [];
  const images: { ref: string; image: InkImage }[] = [];
  const x = xMm * MM;
  const yOf = (offsetMm: number): number => (PAGE_H_MM - topMm - offsetMm) * MM;

  const tagBytes = row.tag ? toWinAnsi(row.tag.text) ?? [] : [];
  const tagTextW = advance(tagBytes, HELVETICA_BOLD, TAG_PT);
  const tagPadPt = 1.4 * MM;
  const tagW = row.tag ? tagTextW + tagPadPt * 2 : 0;
  const tagGapPt = row.tag ? 2 * MM : 0;

  const nameRoom = COLUMN_W_MM * MM - tagW - tagGapPt;
  let nameW = 0;

  if (isImage(row.name)) {
    // Drawn by the caller because no standard font can spell it.
    const ref = `Im${imageIndex}`;
    const hPt = row.name.heightMm * MM;
    const wPt = Math.min(hPt * (row.name.widthPx / row.name.heightPx), nameRoom);
    const baseline = yOf(NAME_BASELINE_MM);
    out.push(
      '0 g',
      'q',
      `${n(wPt)} 0 0 ${n(hPt)} ${n(x)} ${n(baseline - hPt * 0.22)} cm`,
      `/${ref} Do`,
      'Q',
    );
    images.push({ ref, image: row.name });
    nameW = wPt;
  } else if (row.name !== '') {
    const bytes = fit(toWinAnsi(row.name) ?? [], HELVETICA_BOLD, NAME_PT, nameRoom);
    out.push('0 g', 'BT', `/F1 ${NAME_PT} Tf`, `${n(x)} ${n(yOf(NAME_BASELINE_MM))} Td`,
      `${literal(bytes)} Tj`, 'ET');
    nameW = advance(bytes, HELVETICA_BOLD, NAME_PT);
  }

  if (row.tag) {
    const tagX = x + (nameW > 0 ? nameW + tagGapPt : 0);
    const boxY = yOf(NAME_BASELINE_MM) - 0.6 * MM;
    const boxH = 3.3 * MM;
    if (row.tag.filled) {
      out.push('0 g', `${n(tagX)} ${n(boxY)} ${n(tagW)} ${n(boxH)} re f`, '1 g');
    } else {
      out.push('0 G', '0.6 w', `${n(tagX)} ${n(boxY)} ${n(tagW)} ${n(boxH)} re S`, '0 g');
    }
    out.push('BT', `/F1 ${TAG_PT} Tf`,
      `${n(tagX + tagPadPt)} ${n(boxY + 1.05 * MM)} Td`, `${literal(tagBytes)} Tj`, 'ET', '0 g');
  }

  if (row.meta !== '') {
    const bytes = fit(toWinAnsi(row.meta) ?? [], HELVETICA, META_PT, COLUMN_W_MM * MM);
    out.push('0.35 g', 'BT', `/F2 ${META_PT} Tf`,
      `${n(x)} ${n(yOf(META_BASELINE_MM))} Td`, `${literal(bytes)} Tj`, 'ET', '0 g');
  }

  const { bars, totalModules } = barcodeGeometry(row.tracking);
  const moduleMm = Math.min(DEFAULT_MODULE_MM, COLUMN_W_MM / totalModules);
  const barTop = yOf(BARCODE_TOP_MM + BARCODE_H_MM);
  out.push('0 g');
  for (const [left, width] of bars) {
    out.push(
      `${n(x + left * moduleMm * MM)} ${n(barTop)} ` +
        `${n(width * moduleMm * MM)} ${n(BARCODE_H_MM * MM)} re`,
    );
  }
  out.push('f');

  const codeBytes = toWinAnsi(row.tracking) ?? [];
  const codeW = codeBytes.length * COURIER_ADVANCE * TRACKING_PT;
  const symbolW = totalModules * moduleMm * MM;
  out.push('0.3 g', 'BT', `/F3 ${TRACKING_PT} Tf`,
    `${n(x + (symbolW - codeW) / 2)} ${n(yOf(TRACKING_BASELINE_MM))} Td`,
    `${literal(codeBytes)} Tj`, 'ET');

  out.push('0.85 g',
    `${n(x)} ${n(yOf(RULE_MM))} ${n(COLUMN_W_MM * MM)} ${n(0.2 * MM)} re f`, '0 g');

  return { text: out.join('\n'), images };
}

export function buildSheetPdf(rows: readonly SheetRow[]): Uint8Array<ArrayBuffer> {
  const pageCount = Math.max(1, Math.ceil(rows.length / ROWS_PER_PAGE));
  const pages: { content: string; images: { ref: string; image: InkImage }[] }[] = [];

  for (let p = 0; p < pageCount; p++) {
    const slice = rows.slice(p * ROWS_PER_PAGE, (p + 1) * ROWS_PER_PAGE);
    const parts: string[] = [];
    const images: { ref: string; image: InkImage }[] = [];
    slice.forEach((row, i) => {
      // Left to right, then down -- the same order the two-column grid uses on screen,
      // so the sheet she looks at and the sheet that prints read in the same order.
      const column = i % 2;
      const placed = drawRow(
        row,
        MARGIN_MM + column * (COLUMN_W_MM + COLUMN_GAP_MM),
        MARGIN_MM + Math.floor(i / 2) * ROW_H_MM,
        images.length,
      );
      parts.push(placed.text);
      images.push(...placed.images);
    });
    pages.push({ content: parts.join('\n'), images });
  }

  // Objects are numbered as they are written so the cross-reference table can be built
  // from real byte offsets; a PDF reader trusts those absolutely.
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let size = 0;
  const push = (bytes: Uint8Array): void => {
    chunks.push(bytes);
    size += bytes.length;
  };
  const pushAscii = (s: string): void => push(ascii(s));
  const startObject = (): number => {
    offsets.push(size);
    return offsets.length;
  };

  pushAscii('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');

  const catalog = 1;
  const pagesObject = 2;
  const firstFont = 3;
  const fontCount = 3;
  let next = firstFont + fontCount;

  const pageObjects: number[] = [];
  const contentObjects: number[] = [];
  const imageObjects: { ref: string; object: number }[][] = [];
  for (let p = 0; p < pageCount; p++) {
    pageObjects.push(next++);
    contentObjects.push(next++);
    imageObjects.push(pages[p]!.images.map(({ ref }) => ({ ref, object: next++ })));
  }

  startObject();
  pushAscii(`1 0 obj\n<< /Type /Catalog /Pages ${pagesObject} 0 R >>\nendobj\n`);

  startObject();
  pushAscii(
    `2 0 obj\n<< /Type /Pages /Count ${pageCount} ` +
      `/Kids [${pageObjects.map((o) => `${o} 0 R`).join(' ')}] >>\nendobj\n`,
  );

  const fonts = ['Helvetica-Bold', 'Helvetica', 'Courier-Bold'];
  fonts.forEach((base) => {
    const id = startObject();
    pushAscii(
      `${id} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /${base} ` +
        `/Encoding /WinAnsiEncoding >>\nendobj\n`,
    );
  });

  for (let p = 0; p < pageCount; p++) {
    const xobjects = imageObjects[p]!;
    const resources =
      `<< /Font << /F1 ${firstFont} 0 R /F2 ${firstFont + 1} 0 R /F3 ${firstFont + 2} 0 R >>` +
      (xobjects.length > 0
        ? ` /XObject << ${xobjects.map((x) => `/${x.ref} ${x.object} 0 R`).join(' ')} >>`
        : '') +
      ' >>';

    startObject();
    pushAscii(
      `${pageObjects[p]!} 0 obj\n<< /Type /Page /Parent ${pagesObject} 0 R ` +
        `/MediaBox [0 0 ${n(PAGE_W_MM * MM)} ${n(PAGE_H_MM * MM)}] ` +
        `/Resources ${resources} /Contents ${contentObjects[p]!} 0 R >>\nendobj\n`,
    );

    const body = ascii(pages[p]!.content);
    startObject();
    pushAscii(`${contentObjects[p]!} 0 obj\n<< /Length ${body.length} >>\nstream\n`);
    push(body);
    pushAscii('\nendstream\nendobj\n');

    pages[p]!.images.forEach((entry, i) => {
      const object = xobjects[i]!.object;
      startObject();
      pushAscii(
        `${object} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${entry.image.widthPx} ` +
          `/Height ${entry.image.heightPx} /ImageMask true /BitsPerComponent 1 ` +
          `/Decode [1 0] /Length ${entry.image.bits.length} >>\nstream\n`,
      );
      push(entry.image.bits);
      pushAscii('\nendstream\nendobj\n');
    });
  }

  const xrefAt = size;
  const total = offsets.length + 1;
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pushAscii(xref);
  pushAscii(
    `trailer\n<< /Size ${total} /Root ${catalog} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`,
  );

  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
