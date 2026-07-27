/**
 * Regenerates tests/fixtures/*.json from tests/fixtures/*.pdf.
 *
 * The extractor is a pure function over positioned text, so its tests run against these
 * captured JSON snapshots rather than against pdf.js. Run this when adding a new label
 * PDF to the fixtures, then eyeball the diff.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
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

const pdfs = (await readdir(fixturesDir)).filter((f) => f.toLowerCase().endsWith('.pdf')).sort();

for (const name of pdfs) {
  const bytes = new Uint8Array(await readFile(join(fixturesDir, name)));
  const page = await readPdfText(bytes);
  const out = join(fixturesDir, `${name.replace(/\.pdf$/i, '')}.json`);
  await writeFile(out, `${JSON.stringify(page, null, 2)}\n`, 'utf8');
  console.log(`${name} -> ${page.items.length} text items (${page.width}x${page.height})`);
}
