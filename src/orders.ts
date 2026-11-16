/**
 * What the orders exported from the Correos order filler say about money.
 *
 * The declared value printed on a label is a customs declaration, not a sale price: US
 * parcels go out as gifts with a fixed nominal value, so adding those up would undercount
 * most of what was actually sold. The real figures live in the extension that read the
 * marketplace order, and arrive here as a file it exports beside the labels. The tracking
 * number is what joins the two.
 *
 * Pure: parses text, adds up numbers, formats them. No IO.
 */

/** The export format this understands. A different one is refused, never guessed at. */
const SUPPORTED_VERSION = 1;

export class OrderExportError extends Error {}

/** Money an order carries, in euro cents. Null means unknown, which is not zero. */
export interface OrderMoney {
  readonly revenueEurCents: number | null;
  readonly shippingEurCents: number | null;
}

export interface MoneyTotals {
  readonly revenueEurCents: number;
  readonly shippingEurCents: number;
  /** Parcels asked about, whether or not a figure was found for them. */
  readonly parcels: number;
  /** How many of those had a figure. Less than `parcels` means the total is partial. */
  readonly revenueKnown: number;
  readonly shippingKnown: number;
}

/**
 * Cents, or null.
 *
 * Anything that is not a whole, non-negative number is unknown rather than zero. A zero
 * is a figure, and it would quietly pull a total down instead of admitting a gap.
 */
function cents(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

export function parseOrderExport(text: string): ReadonlyMap<string, OrderMoney> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OrderExportError('That file is not valid JSON.');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new OrderExportError('That file is not an order export.');
  }

  const record = parsed as Record<string, unknown>;
  const version = record['version'];
  if (version !== SUPPORTED_VERSION) {
    throw new OrderExportError(
      `This reads order exports version ${SUPPORTED_VERSION}, and that file is version ${String(version)}.`,
    );
  }
  if (!Array.isArray(record['orders'])) {
    throw new OrderExportError('That order export lists no orders.');
  }

  const byTracking = new Map<string, OrderMoney>();
  for (const entry of record['orders'] as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const order = entry as Record<string, unknown>;
    const raw = order['tracking'];
    if (typeof raw !== 'string') continue;
    // Written down by hand in places, so match on the same shape the sheet uses.
    const tracking = raw.trim().toUpperCase();
    if (tracking === '') continue;
    byTracking.set(tracking, {
      revenueEurCents: cents(order['revenueEurCents']),
      shippingEurCents: cents(order['shippingEurCents']),
    });
  }
  return byTracking;
}

export function totalsFor(
  trackings: readonly string[],
  orders: ReadonlyMap<string, OrderMoney>,
): MoneyTotals {
  let revenueEurCents = 0;
  let shippingEurCents = 0;
  let revenueKnown = 0;
  let shippingKnown = 0;

  for (const tracking of trackings) {
    const money = orders.get(tracking);
    if (!money) continue;
    if (money.revenueEurCents !== null) {
      revenueEurCents += money.revenueEurCents;
      revenueKnown++;
    }
    if (money.shippingEurCents !== null) {
      shippingEurCents += money.shippingEurCents;
      shippingKnown++;
    }
  }

  return {
    revenueEurCents,
    shippingEurCents,
    parcels: trackings.length,
    revenueKnown,
    shippingKnown,
  };
}

/** Spanish money: a dot every three digits, a comma before the cents. */
export function formatEur(totalCents: number): string {
  const whole = Math.floor(totalCents / 100);
  const fraction = String(totalCents % 100).padStart(2, '0');
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${grouped},${fraction} €`;
}
