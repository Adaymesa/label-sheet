/**
 * Code 128 encoder.
 *
 * Correos shipping labels encode the bare S10 tracking number (e.g. "LX554474175ES")
 * as Code 128, using Start B with a Code C run over the numeric middle. This module
 * reproduces that encoding exactly — see code128.test.ts, which asserts the output
 * against bar widths decoded from a real label PDF.
 *
 * Pure: no IO, no dependencies.
 */

/** Element-width patterns for symbol values 0..106, as bar/space/bar/space/bar/space. */
const PATTERNS: readonly string[] = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312',
  '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
  '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131',
  '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321',
  '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
  '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321',
  '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
  '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114',
  '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112',
  '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
  '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412',
  '211214', '211232', '2331112',
];

const CODE_C = 99;
const CODE_B = 100;
const START_B = 104;
const START_C = 105;
const STOP = 106;

/** Minimum digit run worth switching to Code C for. Below this, Code C costs more than it saves. */
const MIN_CODE_C_RUN = 4;

export class Code128Error extends Error {}

/** A symbol value sequence, without the trailing checksum and stop. */
function toSymbolValues(data: string): number[] {
  const digitRunAt = (from: number): number => {
    let n = from;
    while (n < data.length && data[n]! >= '0' && data[n]! <= '9') n++;
    return n - from;
  };

  const values: number[] = [];
  let mode: 'B' | 'C';
  let i = 0;

  // An even-length leading digit run of 4+ is cheaper started directly in Code C.
  const leadRun = digitRunAt(0);
  if (leadRun >= MIN_CODE_C_RUN) {
    values.push(START_C);
    mode = 'C';
  } else {
    values.push(START_B);
    mode = 'B';
  }

  while (i < data.length) {
    const run = digitRunAt(i);

    if (mode === 'B' && run >= MIN_CODE_C_RUN) {
      values.push(CODE_C);
      mode = 'C';
      continue;
    }

    if (mode === 'C') {
      // Code C consumes digits in pairs; an odd tail digit falls back to Code B.
      if (run < 2) {
        values.push(CODE_B);
        mode = 'B';
        continue;
      }
      const pairs = Math.floor(run / 2);
      for (let p = 0; p < pairs; p++) {
        values.push(Number(data.slice(i, i + 2)));
        i += 2;
      }
      continue;
    }

    const ch = data.charCodeAt(i);
    if (ch < 32 || ch > 126) {
      throw new Code128Error(
        `Cannot encode character ${JSON.stringify(data[i])} at index ${i}: Code 128 set B covers ASCII 32..126 only`,
      );
    }
    values.push(ch - 32);
    i++;
  }

  return values;
}

function checksum(values: readonly number[]): number {
  const start = values[0]!;
  let sum = start;
  for (let i = 1; i < values.length; i++) sum += i * values[i]!;
  return sum % 103;
}

/**
 * Encode `data` as Code 128 element widths, in modules.
 *
 * The returned array alternates bar, space, bar, ... starting and ending with a bar.
 * Quiet zones are NOT included — the caller must leave >= 10 modules clear on each side.
 */
export function encode(data: string): number[] {
  if (data.length === 0) throw new Code128Error('Cannot encode empty data');

  const values = toSymbolValues(data);
  values.push(checksum(values));
  values.push(STOP);

  const widths: number[] = [];
  for (const v of values) {
    const pattern = PATTERNS[v];
    if (pattern === undefined) throw new Code128Error(`No pattern for symbol value ${v}`);
    for (const c of pattern) widths.push(Number(c));
  }
  return widths;
}

/** Total width of an encoded symbol in modules, excluding quiet zones. */
export function moduleCount(data: string): number {
  return encode(data).reduce((a, b) => a + b, 0);
}

/**
 * Decode Code 128 element widths back to a string.
 *
 * Exists so tests can round-trip the encoder and verify against bars lifted from real
 * label PDFs. Not used by the application itself.
 */
export function decode(widths: readonly number[]): string {
  const values: number[] = [];
  let i = 0;
  while (i + 6 <= widths.length) {
    const pattern = widths.slice(i, i + 6).join('');
    if (pattern === '233111') {
      values.push(STOP);
      break;
    }
    const v = PATTERNS.indexOf(pattern);
    if (v < 0) throw new Code128Error(`Unknown element pattern "${pattern}" at index ${i}`);
    values.push(v);
    i += 6;
  }

  const start = values[0];
  if (start !== START_B && start !== START_C) {
    throw new Code128Error(`Expected a Start B or Start C symbol, got ${start}`);
  }

  const body = values.slice(1, -2);
  const expected = checksum([start, ...body]);
  const actual = values[values.length - 2];
  if (actual !== expected) {
    throw new Code128Error(`Checksum mismatch: symbol says ${actual}, computed ${expected}`);
  }

  let mode: 'B' | 'C' = start === START_C ? 'C' : 'B';
  let out = '';
  for (const v of body) {
    if (mode === 'C') {
      // Inside Code C only 100/101 are shifts; 0..99 are digit pairs, including 99
      // itself — which is the Code C *switch* in the other code sets, not here.
      if (v === CODE_B) { mode = 'B'; continue; }
      if (v === 101) throw new Code128Error('Code A is not supported');
      out += String(v).padStart(2, '0');
      continue;
    }
    if (v === CODE_C) { mode = 'C'; continue; }
    if (v === 101) throw new Code128Error('Code A is not supported');
    out += String.fromCharCode(32 + v);
  }
  return out;
}
