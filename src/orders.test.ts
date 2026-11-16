import { describe, it, expect } from 'vitest';
import { parseOrderExport, totalsFor, formatEur, OrderExportError } from './orders.js';

const exported = (orders: unknown[]): string =>
  JSON.stringify({ version: 1, exportedAt: '2026-11-16T10:00:00.000Z', orders });

describe('parseOrderExport', () => {
  it('indexes orders by tracking number', () => {
    const map = parseOrderExport(
      exported([
        { tracking: 'LX554474175ES', revenueEurCents: 3491, shippingEurCents: 1245 },
        { tracking: 'LX554473886ES', revenueEurCents: 500, shippingEurCents: null },
      ]),
    );
    expect(map.get('LX554474175ES')).toEqual({ revenueEurCents: 3491, shippingEurCents: 1245 });
    expect(map.get('LX554473886ES')).toEqual({ revenueEurCents: 500, shippingEurCents: null });
  });

  it('matches however the tracking number was written', () => {
    const map = parseOrderExport(exported([{ tracking: ' lx554474175es ', revenueEurCents: 1 }]));
    expect(map.has('LX554474175ES')).toBe(true);
  });

  it('ignores an order with no tracking number, which cannot be matched to a parcel', () => {
    const map = parseOrderExport(
      exported([{ revenueEurCents: 999 }, { tracking: 'LX554474175ES', revenueEurCents: 1 }]),
    );
    expect(map.size).toBe(1);
  });

  /**
   * Money that cannot be trusted has to be absent rather than zero: a zero is a figure,
   * and it would quietly drag a total down instead of saying it is incomplete.
   */
  it.each([
    ['a string', '12.45'],
    ['a negative', -5],
    ['a fraction of a cent', 10.5],
    ['not a number', NaN],
  ])('treats %s as unknown rather than as a figure', (_why, value) => {
    const map = parseOrderExport(exported([{ tracking: 'LX554474175ES', revenueEurCents: value }]));
    expect(map.get('LX554474175ES')?.revenueEurCents).toBeNull();
  });

  it.each([
    ['not JSON at all', 'hello'],
    ['JSON that is not an export', '[1,2,3]'],
    ['an export with no orders', '{"version":1}'],
  ])('refuses %s loudly', (_why, text) => {
    expect(() => parseOrderExport(text)).toThrow(OrderExportError);
  });

  it('refuses a version it was not written for, rather than guessing', () => {
    expect(() => parseOrderExport('{"version":2,"orders":[]}')).toThrow(/version 2/);
  });
});

describe('totalsFor', () => {
  const orders = parseOrderExport(
    exported([
      { tracking: 'AA000000001AA', revenueEurCents: 3491, shippingEurCents: 1245 },
      { tracking: 'AA000000002AA', revenueEurCents: 1200, shippingEurCents: 1100 },
      { tracking: 'AA000000003AA', revenueEurCents: 800, shippingEurCents: null },
    ]),
  );

  it('adds up only the parcels asked about', () => {
    const t = totalsFor(['AA000000001AA', 'AA000000002AA'], orders);
    expect(t.revenueEurCents).toBe(4691);
    expect(t.shippingEurCents).toBe(2345);
    expect(t.parcels).toBe(2);
  });

  /** The number that stops a partial total being read as a complete one. */
  it('counts how many parcels it actually had a figure for', () => {
    const t = totalsFor(['AA000000001AA', 'AA000000003AA', 'AA000000009AA'], orders);
    expect(t.parcels).toBe(3);
    expect(t.revenueKnown).toBe(2);
    expect(t.shippingKnown).toBe(1);
    expect(t.revenueEurCents).toBe(4291);
    expect(t.shippingEurCents).toBe(1245);
  });

  it('is all zeroes and knows nothing when none of them match', () => {
    const t = totalsFor(['ZZ999999999ZZ'], orders);
    expect(t).toEqual({
      revenueEurCents: 0,
      shippingEurCents: 0,
      parcels: 1,
      revenueKnown: 0,
      shippingKnown: 0,
    });
  });
});

describe('formatEur', () => {
  it.each([
    [0, '0,00 €'],
    [5, '0,05 €'],
    [1245, '12,45 €'],
    [371763, '3.717,63 €'],
    [100000000, '1.000.000,00 €'],
  ])('writes %i cents the way Spain does', (cents, expected) => {
    expect(formatEur(cents)).toBe(expected);
  });
});
