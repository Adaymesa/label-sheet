import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractLabel } from './extractLabel.js';
import type { PdfPageText } from './types.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures');

/** Positioned text captured from the real label PDFs — see scripts/makeFixtures.ts. */
const page = (name: string): PdfPageText =>
  JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), 'utf8')) as PdfPageText;

const extract = (name: string, file = `${name}.pdf`) => extractLabel(page(name), file);

describe('extractLabel', () => {
  describe('Correos Exprés layout', () => {
    it('reads the recipient, destination and weight', () => {
      const result = extract('LX554474175ES');
      expect(result).toEqual({
        ok: true,
        label: {
          tracking: 'LX554474175ES',
          recipient: 'Lorenzo Marchetti',
          destination: 'USA',
          weight: '70 g',
          category: null,
          sourceName: 'LX554474175ES.pdf',
        },
      });
    });

    it('does not mistake the sender for the recipient', () => {
      const result = extract('LX554474175ES');
      expect(result.ok && result.label.recipient).not.toBe('Mariana Ortega');
    });
  });

  describe('CN22 customs layout', () => {
    it('reads past the customs table to the recipient block', () => {
      const result = extract('LX554473886ES');
      expect(result).toEqual({
        ok: true,
        label: {
          tracking: 'LX554473886ES',
          recipient: 'Katherine Bell',
          destination: 'USA',
          weight: '177 g',
          category: 'gift',
          sourceName: 'LX554473886ES.pdf',
        },
      });
    });

    it('takes the parcel weight, not the customs line-item weight column', () => {
      const result = extract('LX554473886ES');
      expect(result.ok && result.label.weight).toBe('177 g');
    });
  });

  describe('Sendcloud layout', () => {
    it('reads a label whose file name carries no tracking number', () => {
      const result = extract('sendcloud-EJ520253722ES', 'labels (52).pdf');
      expect(result).toEqual({
        ok: true,
        label: {
          tracking: 'EJ520253722ES',
          recipient: 'Min-Seo Han',
          destination: 'CAN',
          weight: '4300 g',
          category: null,
          sourceName: 'labels (52).pdf',
        },
      });
    });

    it('ignores the phone number printed above the recipient name', () => {
      const result = extract('sendcloud-EJ520253722ES', 'labels (52).pdf');
      expect(result.ok && result.label.recipient).toBe('Min-Seo Han');
    });

    // Sendcloud flattens some weights to one decimal, so a light parcel prints "0,0 Kg"
    // on the label itself. Repeating that on the sheet reads as missing data rather than
    // as a light parcel, and the real value is nowhere in the PDF to recover.
    describe('a weight the label rounded away to zero', () => {
      const withWeight = (text: string): PdfPageText => {
        const p = page('sendcloud-EJ520253722ES');
        const item = p.items.find((i) => /Kg/i.test(i.text));
        if (!item) throw new Error('fixture no longer has a weight item');
        return { ...p, items: p.items.map((i) => (i === item ? { ...i, text } : i)) };
      };

      it('reports the bound instead of a bare zero', () => {
        const result = extractLabel(withWeight('0,0 Kg'), 'labels (53).pdf');
        expect(result.ok && result.label.weight).toBe('under 100 g');
      });

      it('takes the bound from the decimals the label itself shows', () => {
        const result = extractLabel(withWeight('0,00 Kg'), 'labels (53).pdf');
        expect(result.ok && result.label.weight).toBe('under 10 g');
      });

      it('leaves a weight that is merely small alone', () => {
        const result = extractLabel(withWeight('0,06 Kg'), 'labels (53).pdf');
        expect(result.ok && result.label.weight).toBe('60 g');
      });
    });

    // This layout is drawn sideways on a portrait page with /Rotate 0, so pdf.js reports
    // it with the axes swapped. Before pdfText normalised the reading frame, the "column
    // to the right of TO" rule picked up the FROM marker and printed "FROM" as the name.
    it('reads a label whose content is drawn rotated on the page', () => {
      const result = extract('sendcloud-rotated-LX541828625ES', 'labels (14).pdf');
      expect(result).toEqual({
        ok: true,
        label: {
          tracking: 'LX541828625ES',
          recipient: 'PRIYA RAGHAVAN',
          destination: 'UNITED KINGDOM (GB)',
          weight: '500 g',
          category: 'merchandise',
          sourceName: 'labels (14).pdf',
        },
      });
    });

    // The name is set in a CID font using a predefined CMap with no /ToUnicode. Without
    // the CMap tables the glyphs decode to nothing and the street line becomes the name.
    it('reads a Japanese recipient name rather than the street line', () => {
      const result = extract('sendcloud-cjk-LX551890097ES', 'labels (35).pdf');
      expect(result.ok && result.label.recipient).toBe('和菓子店さくら');
      expect(result.ok && result.label.destination).toBe('JPN');
    });

    it('never returns a structural marker as the recipient name', () => {
      for (const f of ['sendcloud-rotated-LX541828625ES', 'sendcloud-EJ520253722ES']) {
        const result = extract(f);
        expect(result.ok && result.label.recipient).not.toMatch(/^(FROM|TO)$/);
      }
    });

    it('reaches the country line below the delivery boilerplate', () => {
      const result = extract('sendcloud-EJ520253722ES', 'labels (52).pdf');
      expect(result.ok && result.label.destination).toBe('CAN');
    });
  });

  describe('CN22 customs category', () => {
    describe('the English tick-box row', () => {
      // "Gift", "Comm.sample" and "Merch." sit in a row, each with its box about 10pt
      // to its left, and the tick is a literal "X" text item.
      const ticked = (x: number): PdfPageText => {
        const p = page('cn22-checkbox-LX555366937ES');
        const tick = p.items.find((i) => i.text.trim() === 'X');
        if (!tick) throw new Error('fixture no longer has a tick');
        return { ...p, items: p.items.map((i) => (i === tick ? { ...i, x } : i)) };
      };

      it('reads the ticked box', () => {
        const result = extract('cn22-checkbox-LX555366937ES', 'LX555366937ES.pdf');
        expect(result.ok && result.label.category).toBe('merchandise');
      });

      // Same fixture, tick moved to the Gift box. The file name has to keep matching the
      // barcode, or the tracking-mismatch guard refuses the label before we get here.
      it('reads a tick against a different box in the same row', () => {
        const result = extractLabel(ticked(4), 'LX555366937ES.pdf');
        expect(result.ok && result.label.category).toBe('gift');
      });

      it('reads the second row of boxes too', () => {
        const p = page('cn22-checkbox-LX555366937ES');
        const docs = p.items.find((i) => i.text.trim() === 'Docs');
        if (!docs) throw new Error('fixture no longer has a Docs box');
        const tick = p.items.find((i) => i.text.trim() === 'X');
        const moved = {
          ...p,
          items: p.items.map((i) =>
            i === tick ? { ...i, x: docs.x - 9, y: docs.y + 1.1 } : i,
          ),
        };
        expect(extractLabel(moved, 'x.pdf').ok && (extractLabel(moved, 'x.pdf') as { label: { category: string } }).label.category).toBe('documents');
      });

      it('ignores a tick that belongs to no category box', () => {
        const result = extractLabel(ticked(300), 'x.pdf');
        expect(result.ok && result.label.category).toBeNull();
      });
    });

    describe('the Spanish word variant', () => {
      // This layout has no tick row. It prints "Category of item:" with the value below,
      // and its own "X" belongs to the Return-to-sender option further down the page.
      const withCategory = (text: string): PdfPageText => {
        const p = page('LX554473886ES');
        const value = p.items.find((i) => i.text === 'Regalos');
        if (!value) throw new Error('fixture no longer states a category');
        return { ...p, items: p.items.map((i) => (i === value ? { ...i, text } : i)) };
      };

      it('reads the category printed as a word', () => {
        const result = extract('LX554473886ES');
        expect(result.ok && result.label.category).toBe('gift');
      });

      it('is not fooled by the Return-to-sender tick elsewhere on the page', () => {
        const result = extract('LX554473886ES');
        expect(result.ok && result.label.category).not.toBe('merchandise');
      });

      it.each([
        ['REGALOS', 'gift'],
        ['Mercancías', 'merchandise'],
        ['VENTA DE MERCANCÍA', 'merchandise'],
      ])('reads %s as %s', (word, expected) => {
        const result = extractLabel(withCategory(word), 'x.pdf');
        expect(result.ok && result.label.category).toBe(expected);
      });

      it('refuses a word it does not recognise rather than guessing', () => {
        const result = extractLabel(withCategory('Algo Raro'), 'x.pdf');
        expect(result.ok && result.label.category).toBeNull();
      });
    });

    it('is null on a label with no customs declaration', () => {
      const result = extract('sendcloud-EJ520253722ES', 'labels (52).pdf');
      expect(result.ok && result.label.category).toBeNull();
    });
  });

  describe('Paq Estándar layout', () => {
    // Correos premium. No S10 code at all: the barcode encodes the "Código de Bulto",
    // verified by decoding the printed bars. The shorter EXPEDICIÓN code on the same
    // label is a different number and must not be used.
    it('uses the parcel code the barcode actually carries', () => {
      const result = extract('paq-estandar-PQ6AA49800574520108410T', 'labels (43).pdf');
      expect(result.ok && result.label.tracking).toBe('PQ6AA49800574520108410T');
    });

    it('does not mistake the EXPEDICIÓN number for the barcode', () => {
      const result = extract('paq-estandar-PQ6AA49800574520108410T', 'labels (43).pdf');
      expect(result.ok && result.label.tracking).not.toBe('PQ6AA4980057452H');
    });

    it('reads the recipient beside the Destinatario marker', () => {
      const result = extract('paq-estandar-PQ6AA49800574520108410T', 'labels (43).pdf');
      expect(result.ok && result.label.recipient).toBe('Nora Brandt');
      expect(result.ok && result.label.destination).toBe('BARCELONA');
    });

    it('reads the weight printed under its heading', () => {
      const result = extract('paq-estandar-PQ6AA49800574520108410T', 'labels (43).pdf');
      expect(result.ok && result.label.weight).toBe('180 g');
    });

    // An older Paq variant: "Código Bulto:" without the "de", the code as a separate item,
    // the weight in grams, and dotted rules fencing the blocks apart.
    describe('older variant', () => {
      const older = () => extract('paq-older-PK6AA40711097670108008H', 'labels (18).pdf');

      it('finds the code even though it is a separate item from its caption', () => {
        expect(older().ok && (older() as { label: { tracking: string } }).label.tracking).toBe(
          'PK6AA40711097670108008H',
        );
      });

      it('uses the dotted rules to find the recipient, not the street below it', () => {
        const result = older();
        expect(result.ok && result.label.recipient).toBe('CAROLINE HAYES');
        expect(result.ok && result.label.destination).toBe('BARCELONA');
      });

      it('converts a weight given in grams', () => {
        expect(older().ok && (older() as { label: { weight: string } }).label.weight).toBe('1226 g');
      });
    });
  });

  describe('labels we refuse to guess at', () => {
    it('reports a label with no barcode instead of inventing one', () => {
      const result = extract('unsupported-noBarcode', 'labels (45).pdf');
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toMatch(/No barcode found/);
      expect(!result.ok && result.sourceName).toBe('labels (45).pdf');
    });

    it('reports a file name that disagrees with the printed tracking number', () => {
      const result = extractLabel(page('LX554474175ES'), 'LX999999999ES.pdf');
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toMatch(/mismatch/i);
    });

    it('reports a page with no recipient block rather than returning a blank row', () => {
      const result = extractLabel(
        { width: 411, height: 283, items: [{ text: 'LX554474175ES', x: 10, y: 10, width: 60, height: 9 }] },
        'LX554474175ES.pdf',
      );
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toMatch(/recipient address block/i);
    });
  });

  describe('tracking number sourcing', () => {
    it('trusts the printed tracking number, which is what the barcode encodes', () => {
      const result = extract('LX554473974ES');
      expect(result.ok && result.label.tracking).toBe('LX554473974ES');
    });
  });
});
