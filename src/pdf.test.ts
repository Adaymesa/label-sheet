import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { buildSheetPdf, canEncode, toWinAnsi, ROWS_PER_PAGE, type SheetRow } from './pdf.js';
import { decode } from './code128.js';
import { readPdfText, configurePdf } from './pdfText.js';

const pdfjsDir = join(import.meta.dirname, '..', 'node_modules', 'pdfjs-dist');
configurePdf({
  workerSrc: join(pdfjsDir, 'legacy', 'build', 'pdf.worker.mjs'),
  cMapUrl: join(pdfjsDir, 'cmaps') + '/',
});

const row = (over: Partial<SheetRow> = {}): SheetRow => ({
  name: 'Harriet Vance',
  meta: 'AUS  ·  40 g',
  tracking: 'LX554474175ES',
  tag: null,
  ...over,
});

const latin1 = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
};

/** The drawn bars, pulled back out of the page's own content stream. */
function barsFrom(pdf: Uint8Array): { x: number; w: number; h: number }[] {
  const text = latin1(pdf);
  return [...text.matchAll(/([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) re\b/g)]
    .map((m) => ({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) }))
    .filter((r) => Math.abs(r.h - (16 * 72) / 25.4) < 0.01);
}

describe('buildSheetPdf', () => {
  it('writes something a reader will accept', () => {
    const pdf = latin1(buildSheetPdf([row()]));
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(pdf).toContain('/Type /Catalog');
  });

  it('offsets in the cross-reference table point at their objects', () => {
    const pdf = buildSheetPdf([row(), row({ tracking: 'LX554473886ES' })]);
    const text = latin1(pdf);
    // Not lastIndexOf('xref'): that finds the "startxref" in the trailer, which sits
    // after the table and leaves nothing to match.
    const table = text.slice(text.lastIndexOf('\nxref\n'));
    const offsets = [...table.matchAll(/^(\d{10}) 00000 n/gm)].map((m) => Number(m[1]));
    expect(offsets.length).toBeGreaterThan(5);
    offsets.forEach((offset, i) => {
      expect(text.slice(offset, offset + 12)).toMatch(new RegExp(`^${i + 1} 0 obj`));
    });
  });

  it('starts a new page once a page is full', () => {
    const many = Array.from({ length: ROWS_PER_PAGE + 1 }, (_, i) =>
      row({ tracking: `LX55447417${i % 10}ES` }),
    );
    expect(latin1(buildSheetPdf(many))).toContain('/Count 2');
    expect(latin1(buildSheetPdf([row()]))).toContain('/Count 1');
  });

  /**
   * The one that matters. A barcode drawn at the wrong width still looks like a barcode,
   * so read the rectangles back out of the page and decode them as a scanner would.
   */
  it('draws bars that decode back to the tracking number', () => {
    for (const tracking of ['LX554474175ES', 'EJ520269489ES', 'LX553699185ES']) {
      const bars = barsFrom(buildSheetPdf([row({ tracking })])).sort((a, b) => a.x - b.x);
      expect(bars.length).toBeGreaterThan(20);

      // Rebuild the bar/gap sequence a scanner sees, in module units.
      const unit = Math.min(...bars.map((b) => b.w));
      const widths: number[] = [];
      bars.forEach((bar, i) => {
        widths.push(Math.round(bar.w / unit));
        const nextBar = bars[i + 1];
        if (nextBar) widths.push(Math.round((nextBar.x - (bar.x + bar.w)) / unit));
      });
      expect(decode(widths)).toBe(tracking);
    }
  });

  it('scales a long code down rather than letting it run off the column', () => {
    const wide = barsFrom(buildSheetPdf([row({ tracking: 'PQ6AA49800574520108410T' })]));
    const right = Math.max(...wide.map((b) => b.x + b.w));
    expect(right).toBeLessThanOrEqual((11 + 89) * (72 / 25.4) + 0.5);
  });

  it('reads back as the text that went in', async () => {
    const pdf = buildSheetPdf([
      row({ name: 'Harriet Vance', meta: 'AUS  ·  40 g', tag: { text: 'Merch.', filled: true } }),
    ]);
    const page = await readPdfText(pdf);
    const texts = page.items.map((i) => i.text.trim()).filter(Boolean).join(' | ');
    expect(texts).toContain('Harriet Vance');
    expect(texts).toContain('LX554474175ES');
    expect(texts).toContain('Merch.');
    expect(texts).toContain('40 g');
  });

  it('keeps an accented name intact through the standard encoding', async () => {
    const page = await readPdfText(buildSheetPdf([row({ name: 'LUCIJA GADŽA' })]));
    expect(page.items.map((i) => i.text).join(' ')).toContain('GADŽA');
  });
});

describe('canEncode', () => {
  it.each(['Harriet Vance', 'Tara O’Reilly', 'LUCIJA GADŽA', 'José Niño'])(
    'accepts %s',
    (name) => {
      expect(canEncode(name)).toBe(true);
    },
  );

  it.each(['日本料理小ぐら', '浩司'])(
    'refuses %s, which has to be drawn instead',
    (name) => {
      expect(canEncode(name)).toBe(false);
      expect(toWinAnsi(name)).toBeNull();
    },
  );
});
