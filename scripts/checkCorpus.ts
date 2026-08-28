/**
 * Runs the real extraction pipeline over a folder of label PDFs and reports what it got.
 *
 * Not a unit test — a smoke check against the messy real world, for spotting layouts we
 * mis-read before they reach a printed sheet.
 *
 *   npx tsx scripts/checkCorpus.ts ~/Downloads
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPdfText, configurePdf } from '../src/pdfText.js';
import { extractLabel } from '../src/extractLabel.js';

const here = dirname(fileURLToPath(import.meta.url));
const pdfjsDir = join(here, '..', 'node_modules', 'pdfjs-dist');
configurePdf({
  workerSrc: join(pdfjsDir, 'legacy', 'build', 'pdf.worker.mjs'),
  cMapUrl: join(pdfjsDir, 'cmaps') + '/',
});

const dir = process.argv[2];
if (!dir) throw new Error('usage: checkCorpus.ts <directory>');

const S10_NAME = /^[A-Z]{2}\d{9}[A-Z]{2}\.pdf$/;
const isLabel = (n: string) =>
  !/(_case|_reembolso|_factura)/.test(n) && (S10_NAME.test(n) || n.startsWith('labels'));

const files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.pdf') && isLabel(f)).sort();

/** Things that look like an extraction slip rather than a real name. */
const SUSPICIOUS = [
  // CJK names are legitimately short -- two characters is a full name.
  { test: (s: string) => s.length < 3 && !/[　-鿿가-힯]/.test(s), why: 'name too short' },
  { test: (s: string) => s.length > 45, why: 'name suspiciously long' },
  { test: (s: string) => /^\+?[\d\s()\-.]+$/.test(s), why: 'name looks like a phone number' },
  { test: (s: string) => /^\d/.test(s), why: 'name starts with a digit (street line?)' },
  { test: (s: string) => /(remitente|sender|customs|declaration|correos|kg)/i.test(s), why: 'name looks like boilerplate' },
];

let ok = 0;
const failed: string[] = [];
const suspicious: string[] = [];
const rows: string[] = [];

for (const name of files) {
  try {
    const page = await readPdfText(new Uint8Array(await readFile(join(dir, name))));
    const result = extractLabel(page, name);
    if (!result.ok) {
      failed.push(`${name}: ${result.reason}`);
      continue;
    }
    const { tracking, recipient, destination, weight, category } = result.label;
    ok++;
    rows.push(
      `${name.padEnd(24)} ${tracking.padEnd(15)} ${recipient.padEnd(26)} ${(destination || '-').padEnd(6)} ${(weight ?? '-').padEnd(12)} ${category ?? '-'}`,
    );
    for (const rule of SUSPICIOUS) {
      if (rule.test(recipient)) {
        suspicious.push(`${name}: ${rule.why} -> ${JSON.stringify(recipient)}`);
        break;
      }
    }
    if (!destination) suspicious.push(`${name}: no destination`);
    if (!weight) suspicious.push(`${name}: no weight`);
  } catch (error) {
    failed.push(`${name}: threw ${(error as Error).message}`);
  }
}

console.log(rows.join('\n'));
console.log('\n' + '='.repeat(90));
console.log(`extracted cleanly : ${ok}/${files.length}`);
console.log(`could not extract : ${failed.length}`);
for (const f of failed) console.log(`  !! ${f}`);
console.log(`needs a look      : ${suspicious.length}`);
for (const s of suspicious) console.log(`  ?? ${s}`);
