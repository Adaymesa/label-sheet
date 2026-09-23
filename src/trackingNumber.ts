/**
 * Validates a tracking number typed or pasted by hand.
 *
 * Reading a number off a PDF is safe: whatever the label says is by definition what the
 * parcel carries. Typing one is not. A single wrong digit produces a barcode that scans
 * perfectly well and belongs to somebody else's parcel, and nothing further down the
 * line can tell the difference. So this is the one place that has to be strict.
 *
 * No IO, no DOM.
 */

/** UPU S10: two service letters, eight serial digits, a check digit, two country letters. */
const S10 = /^([A-Z]{2})(\d{8})(\d)([A-Z]{2})$/;

/** Anything people put between the groups when writing a code down. */
const NOISE = /[\s\-._]/g;

/**
 * UPU S10 check digit. Weight the eight serial digits by 8,6,4,2,3,5,9,7 and sum, then
 * take the remainder modulo 11: 0 means the digit is 5, 1 means 0, otherwise 11 minus
 * the remainder. Catches every single-digit error and every transposition.
 */
const WEIGHTS = [8, 6, 4, 2, 3, 5, 9, 7] as const;

function checkDigitFor(serial: string): number {
  const sum = [...serial].reduce((total, digit, i) => total + Number(digit) * WEIGHTS[i]!, 0);
  const remainder = sum % 11;
  if (remainder === 0) return 5;
  if (remainder === 1) return 0;
  return 11 - remainder;
}

export type ParsedTracking =
  | { readonly ok: true; readonly tracking: string }
  | { readonly ok: false; readonly reason: string };

export function parseTrackingNumber(input: string): ParsedTracking {
  const cleaned = input.replace(NOISE, '').toUpperCase();

  if (cleaned === '') return { ok: false, reason: 'Enter a tracking number.' };

  const parts = S10.exec(cleaned);
  if (!parts) {
    if (cleaned.length !== 13) {
      return {
        ok: false,
        reason: `A Correos tracking number is 13 characters, like LX554474175ES. That one is ${cleaned.length}.`,
      };
    }
    if (!/^[A-Z]{2}/.test(cleaned) || !/[A-Z]{2}$/.test(cleaned)) {
      return {
        ok: false,
        reason: 'It should start with two letters and end with two letters, like LX554474175ES.',
      };
    }
    return { ok: false, reason: 'That is not a Correos tracking number, like LX554474175ES.' };
  }

  const [, , serial, given] = parts;
  const expected = checkDigitFor(serial!);
  if (Number(given) !== expected) {
    return {
      ok: false,
      reason: `Check digit does not match, so there is a typo somewhere. Expected ${expected} where it reads ${given}.`,
    };
  }

  return { ok: true, tracking: cleaned };
}
