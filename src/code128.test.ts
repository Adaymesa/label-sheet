import { describe, it, expect } from 'vitest';
import { encode, decode, moduleCount, Code128Error } from './code128.js';

/**
 * Ground truth lifted from a real Correos label: the filled rectangles of the barcode
 * Form XObject in tests/fixtures/LX554474175ES.pdf, normalised to modules (module = 4 units).
 *
 * If this test fails, the generated barcode no longer matches what Correos prints.
 */
const REAL_LABEL_WIDTHS = [
  2, 1, 1, 2, 1, 4, 1, 3, 2, 1, 3, 1, 3, 3, 1, 1, 2, 1, 1, 1, 3, 1, 4, 1, 3, 1, 1, 3,
  2, 1, 1, 3, 2, 1, 3, 1, 1, 4, 2, 2, 1, 1, 1, 2, 3, 2, 2, 1, 1, 1, 4, 1, 3, 1, 2, 1,
  3, 2, 1, 2, 1, 3, 2, 1, 1, 3, 2, 1, 3, 1, 1, 3, 1, 2, 1, 1, 4, 2, 2, 3, 3, 1, 1, 1, 2,
];

describe('code128', () => {
  describe('encoding a real Correos tracking number', () => {
    it('reproduces the bar pattern printed on the label, bar for bar', () => {
      expect(encode('LX554474175ES')).toEqual(REAL_LABEL_WIDTHS);
    });

    it('produces a symbol the decoder reads back as the tracking number', () => {
      expect(decode(REAL_LABEL_WIDTHS)).toBe('LX554474175ES');
    });

    it('is 156 modules wide, so every S10 code lays out identically', () => {
      expect(moduleCount('LX554474175ES')).toBe(156);
      expect(moduleCount('EJ520253722ES')).toBe(156);
      expect(moduleCount('CP520865000ES')).toBe(156);
    });
  });

  describe('round-tripping', () => {
    const cases = [
      'LX554474175ES',
      'EJ520253722ES',
      'LX553609344ES',
      'CP520775834ES',
      'A',
      'ABC',
      '1234',
      '12345',
      '0000000000',
      'AB123456789CD',
      'Mixed 42 Text',
      // Symbol value 99 is the Code C switch in sets A/B, but the literal pair "99"
      // inside Code C. Real tracking numbers hit this, so keep it covered.
      'LX553699185ES',
      'LX553699146ES',
      '9999',
      '99',
      'AB9999CD',
      '1099995',
    ];

    for (const value of cases) {
      it(`survives encode -> decode for ${JSON.stringify(value)}`, () => {
        expect(decode(encode(value))).toBe(value);
      });
    }
  });

  describe('structure', () => {
    it('starts and ends on a bar', () => {
      const widths = encode('LX554474175ES');
      expect(widths.length % 2).toBe(1);
    });

    it('uses Start C when the data opens with a long digit run', () => {
      // Start C encodes two digits per symbol, so an all-digit payload is shorter.
      expect(moduleCount('12345678')).toBeLessThan(moduleCount('ABCDEFGH'));
    });

    it('only ever emits element widths of 1..4 modules', () => {
      for (const w of encode('LX554474175ES')) {
        expect(w).toBeGreaterThanOrEqual(1);
        expect(w).toBeLessThanOrEqual(4);
      }
    });
  });

  describe('failure modes', () => {
    it('rejects empty data rather than emitting a scannable-looking stub', () => {
      expect(() => encode('')).toThrow(Code128Error);
    });

    it('rejects characters outside Code 128 set B', () => {
      expect(() => encode('CAFÉ')).toThrow(/Cannot encode character/);
    });

    it('rejects a corrupted symbol instead of returning partial data', () => {
      const corrupted = [...REAL_LABEL_WIDTHS];
      corrupted[6] = 4;
      expect(() => decode(corrupted)).toThrow(Code128Error);
    });
  });
});
