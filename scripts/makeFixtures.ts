/**
 * Regenerates tests/fixtures/*.json from tests/fixtures/*.pdf.
 *
 * The extractor is a pure function over positioned text, so its tests run against these
 * captured JSON snapshots rather than against pdf.js. Run this when adding a new label
 * PDF to the fixtures, then eyeball the diff.
 *
 * The committed JSON is ANONYMISED, and the PDFs beside it are not: they are real
 * shipments, kept out of git. Regenerating over an existing capture therefore silently
 * replaces invented names with real customer ones, in a public repository. So an existing
 * file is left alone unless you say otherwise, and re-anonymising is on you when you do.
 *
 *   npx tsx scripts/makeFixtures.ts            # only captures PDFs with no JSON yet
 *   npx tsx scripts/makeFixtures.ts --force    # re-captures everything, real names and all
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPdfText, configurePdf } from '../src/pdfText.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, '..', 'tests', 'fixtures');

const pdfjsDir = join(here, '..', 'node_modules', 'pdfjs-dist');
configurePdf({
  workerSrc: join(pdfjsDir, 'legacy', 'build', 'pdf.worker.mjs'),
  cMapUrl: join(pdfjsDir, 'cmaps') + '/',
});

const force = process.argv.includes('--force');
const pdfs = (await readdir(fixturesDir)).filter((f) => f.toLowerCase().endsWith('.pdf')).sort();

for (const name of pdfs) {
  const target = join(fixturesDir, `${name.replace(/\.pdf$/i, '')}.json`);
  if (!force && existsSync(target)) {
    console.log(`${name} -> skipped, ${name.replace(/\.pdf$/i, '')}.json already exists`);
    continue;
  }
  const bytes = new Uint8Array(await readFile(join(fixturesDir, name)));
  const page = await readPdfText(bytes);
  await writeFile(target, `${JSON.stringify(page, null, 2)}\n`, 'utf8');
  console.log(`${name} -> ${page.items.length} text items (${page.width}x${page.height})`);
}
