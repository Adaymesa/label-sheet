/**
 * Adapter: PDF bytes -> positioned text.
 *
 * The only module that knows pdf.js exists. Everything downstream works on the plain
 * `PdfPageText` shape, which is why the extractor can be tested from JSON fixtures.
 *
 * Coordinates are normalised to a y-down page space (origin top-left, points), with any
 * page /Rotate already applied — so a label reads the way a human sees it.
 */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PdfPageText, PositionedText } from './types.js';

export class PdfReadError extends Error {}

/**
 * Supplies pdf.js its CMap tables.
 *
 * Without these, CID fonts that use a predefined CMap and carry no /ToUnicode -- which is
 * how Correos prints CJK recipient names (KozGoProVI-Medium + UniJIS-UTF16-H) -- decode to
 * nothing, and the extractor silently falls through to the street line. So this is not
 * optional polish: it is the difference between a real name and a fragment of the street line.
 */
export interface CMapSource {
  /** Returns the packed .bcmap bytes for a CMap name, e.g. "UniJIS-UTF16-H". */
  get(name: string): Promise<Uint8Array | null>;
}

interface PdfConfig {
  readonly workerSrc: string;
  /** Filesystem/URL path to the cmaps directory (Node). */
  readonly cMapUrl?: string;
  /** In-memory CMaps (browser bundle, where there is no directory to fetch from). */
  readonly cMaps?: CMapSource;
}

let config: PdfConfig | undefined;

/** Must be called once before `readPdfText`. */
export function configurePdf(next: PdfConfig): void {
  config = next;
  pdfjs.GlobalWorkerOptions.workerSrc = next.workerSrc;
}

/** Adapts a `CMapSource` to the reader interface pdf.js expects. */
function cMapReaderFactoryFor(source: CMapSource) {
  return class {
    async fetch({ name }: { name: string }): Promise<{ cMapData: Uint8Array; isCompressed: boolean }> {
      const cMapData = await source.get(name);
      if (!cMapData) throw new Error(`CMap "${name}" is not bundled`);
      return { cMapData, isCompressed: true };
    }
  };
}

/**
 * Some producers (notably Sendcloud) draw a landscape label sideways on a portrait page,
 * leaving /Rotate at 0 and baking the rotation into each text matrix. pdf.js reports that
 * faithfully, which leaves the page's axes swapped relative to how a human reads it.
 *
 * Normalising here keeps the extractor free of orientation concerns.
 */
type Quadrant = 0 | 90 | 180 | 270;

function quadrantOf(a: number, b: number): Quadrant {
  const deg = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return ((Math.round(deg / 90) * 90) % 360) as Quadrant;
}

/** Rotate a viewport point into the reading frame for the given page rotation. */
function toReadingFrame(x: number, y: number, w: number, h: number, q: Quadrant): [number, number] {
  switch (q) {
    case 90: return [y, w - x];
    case 180: return [w - x, h - y];
    case 270: return [h - y, x];
    default: return [x, y];
  }
}

/** Read the first page of a PDF as positioned text. Label PDFs are always a single page. */
export async function readPdfText(bytes: Uint8Array): Promise<PdfPageText> {
  if (!config) throw new PdfReadError('configurePdf() must be called before reading a PDF');

  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: bytes,
      isEvalSupported: false,
      useSystemFonts: false,
      cMapPacked: true,
      ...(config.cMapUrl ? { cMapUrl: config.cMapUrl } : {}),
      ...(config.cMaps ? { CMapReaderFactory: cMapReaderFactoryFor(config.cMaps) } : {}),
    }).promise;
  } catch (cause) {
    throw new PdfReadError(`Not a readable PDF: ${(cause as Error).message}`, { cause });
  }

  try {
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();

    // Combine each text matrix with the viewport so positions AND angles are in one space.
    const placed = content.items.flatMap((item) => {
      if (!('str' in item)) return [];
      const text = item.str.trim();
      if (text === '') return [];
      const m = pdfjs.Util.transform(viewport.transform, item.transform) as number[];
      return [{
        text,
        vx: m[4] as number,
        vy: m[5] as number,
        quadrant: quadrantOf(m[0] as number, m[1] as number),
        width: Math.abs(item.width),
        height: Math.abs(item.height) || 0,
      }];
    });

    // Rotated labels also carry a few upright glyphs (and vice versa), so take the
    // orientation of the bulk of the text rather than of any single run.
    const weight = new Map<Quadrant, number>();
    for (const p of placed) weight.set(p.quadrant, (weight.get(p.quadrant) ?? 0) + p.text.length);
    let pageQuadrant: Quadrant = 0;
    let best = -1;
    for (const [q, w] of weight) if (w > best) { best = w; pageQuadrant = q; }

    const vw = viewport.width;
    const vh = viewport.height;
    const rotated = pageQuadrant === 90 || pageQuadrant === 270;

    const items: PositionedText[] = placed.map((p) => {
      const [rx, ry] = toReadingFrame(p.vx, p.vy, vw, vh, pageQuadrant);
      return {
        text: p.text,
        x: round(rx),
        y: round(ry - p.height), // the matrix origin is the baseline; shift to the top edge
        width: round(p.width),
        height: round(p.height),
      };
    });

    return {
      width: round(rotated ? vh : vw),
      height: round(rotated ? vw : vh),
      items,
    };
  } finally {
    await doc.destroy();
  }
}

const round = (n: number): number => Math.round(n * 100) / 100;
