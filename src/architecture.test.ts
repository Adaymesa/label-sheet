import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Rules the design depends on, held as tests rather than as habits.
 *
 * Everything here is true by inspection today. It is written down because the cost of each
 * one quietly stopping being true is paid much later, by someone reading correct-looking
 * code and getting a wrong answer.
 */

const src = join(import.meta.dirname, '.');
const read = (file: string): string => readFileSync(join(src, file), 'utf8');

/**
 * The one adapter that lives among the domain modules rather than in `browser/`.
 *
 * `pdfText.ts` is the only file that knows pdf.js exists, which is what lets `extractLabel`
 * be tested against captures of real labels with no PDF library in sight. The README's file
 * table names it an adapter; it is listed here so the rules below stay strict for everything
 * else instead of being loosened to accommodate it.
 */
const ADAPTERS_IN_SRC = new Set(['pdfText.ts']);

const domainFiles = (): string[] =>
  readdirSync(src).filter(
    (f) => f.endsWith('.ts') && !f.includes('.test.') && !ADAPTERS_IN_SRC.has(f),
  );

/**
 * A file with its prose removed.
 *
 * These modules explain themselves at length, and the words they use are the words these
 * rules search for -- "the window rule", "a label PDF". Scanning the comments finds the
 * documentation rather than the code, and a rule that fires on prose gets loosened until
 * it finds nothing at all. Only block comments and whole-line `//` are stripped, so a
 * regex literal containing a slash survives intact.
 */
function codeOf(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** Module specifiers a file imports from. */
function importsOf(file: string): string[] {
  return [...read(file).matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]!);
}

describe('the print record cannot decide what prints', () => {
  it('queue.ts and printed.ts do not know about each other', () => {
    // This is what makes losing browser storage harmless. If grouping could see the print
    // record, a cleared localStorage could change which parcels come out of the printer,
    // and the failure would be invisible -- the sheet would simply be wrong.
    expect(importsOf('queue.ts')).not.toContain('./printed.js');
    expect(importsOf('printed.ts')).not.toContain('./queue.js');
  });

  it('the record is only ever read to decorate, never to filter', () => {
    // Both functions belong in the composition root, where the answer is a badge. Neither
    // may appear in a domain module, which is where a filter would have to live to matter.
    for (const file of domainFiles()) {
      if (file === 'printed.ts') continue;
      expect(codeOf(file), `${file} must not read the print record`).not.toMatch(
        /printedAt|markPrinted/,
      );
    }
  });
});

describe('the domain stays free of the browser', () => {
  it('no module in src/ reaches for IO', () => {
    const forbidden = /\b(document|window|localStorage|indexedDB|navigator|fetch)\b/;
    for (const file of domainFiles()) {
      expect(codeOf(file), `${file} is domain logic and must not touch the browser`).not.toMatch(
        forbidden,
      );
    }
  });

  it('no module in src/ imports an adapter from src/browser/', () => {
    for (const file of domainFiles()) {
      for (const specifier of importsOf(file)) {
        expect(specifier, `${file} must not depend on an adapter`).not.toMatch(/browser\//);
      }
    }
  });
});

describe('one definition of a shared rule', () => {
  it('only queue.ts decides what falls inside the window', () => {
    // folderLoad.ts filters a folder listing and groupByDay filters the labels read from
    // it. Two definitions of "the last week" would drift, and the symptom would be a file
    // that is read and then never shown.
    expect(importsOf('folderLoad.ts')).toContain('./queue.js');
    expect(codeOf('folderLoad.ts')).not.toMatch(/setDate|startOfDay|24 \* 60 \* 60/);
  });

  it('nothing tests for a PDF by hand instead of calling isPdf', () => {
    // Narrowly the predicate, not the extension: `extractLabel` strips ".pdf" to get a
    // stem, which is a different job and not a second definition of anything.
    for (const file of domainFiles().filter((f) => f !== 'folderLoad.ts')) {
      expect(codeOf(file), `${file} should call isPdf`).not.toMatch(/endsWith\(\s*['"]\.pdf/i);
    }
  });
});
