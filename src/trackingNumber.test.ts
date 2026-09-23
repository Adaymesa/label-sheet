import { describe, it, expect } from 'vitest';
import { parseTrackingNumber } from './trackingNumber.js';

const ok = (input: string): string => {
  const r = parseTrackingNumber(input);
  if (!r.ok) throw new Error(`expected ${input} to parse, got: ${r.reason}`);
  return r.tracking;
};
const why = (input: string): string => {
  const r = parseTrackingNumber(input);
  if (r.ok) throw new Error(`expected ${input} to be refused`);
  return r.reason;
};

describe('parseTrackingNumber', () => {
  it('accepts a well-formed S10 code', () => {
    expect(ok('LX556138794ES')).toBe('LX556138794ES');
  });

  // Typed by hand or pasted out of an email, so be forgiving about shape.
  it.each(['lx556138794es', '  LX556138794ES  ', 'LX 556 138 794 ES', 'LX-556138794-ES'])(
    'normalises %s',
    (input) => {
      expect(ok(input)).toBe('LX556138794ES');
    },
  );

  /**
   * The point of the exercise. A single wrong digit still produces a scannable barcode,
   * just for somebody else's parcel, so the check digit has to be enforced here even
   * though nothing downstream can tell the difference.
   */
  it('refuses a code whose check digit does not match', () => {
    expect(why('LX556138795ES')).toMatch(/check digit/i);
  });

  it('refuses a transposition that keeps the same digits', () => {
    expect(why('LX556138749ES')).toMatch(/check digit/i);
  });

  it.each([
    ['', /enter a tracking number/i],
    ['LX55613879ES', /13 characters/i],
    ['1X556138794ES', /two letters/i],
    ['LX556138794E5', /two letters/i],
    ['PQ6AA49800574520108410T', /Correos tracking number/i],
  ])('refuses %s with a reason that says why', (input, expected) => {
    expect(why(input)).toMatch(expected);
  });

  it('accepts real codes taken off printed labels', () => {
    for (const code of ['LX554474175ES', 'LX554473886ES', 'EJ520269489ES', 'LX541828625ES']) {
      expect(ok(code)).toBe(code);
    }
  });
});
