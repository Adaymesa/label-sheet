/**
 * Composition root for the browser app.
 *
 * Everything here is wiring and DOM. The domain logic (Code 128, extraction, barcode
 * geometry) lives in ../ and is covered by unit tests against real label PDFs.
 */
import workerSource from 'virtual:pdf-worker';
import cmaps from 'virtual:cmaps';
import { configurePdf, readPdfText, PdfReadError } from '../pdfText.js';
import { extractLabel } from '../extractLabel.js';
import { barcodeSvg } from '../barcodeSvg.js';
import type { Label } from '../types.js';

const base64ToBytes = (b64: string): Uint8Array => {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
};

// pdf.js insists on a worker; build one from the source inlined into this page so the
// app stays a single file with no network access.
configurePdf({
  workerSrc: URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' })),
  cMaps: {
    async get(name) {
      const b64 = cmaps[name];
      return b64 ? base64ToBytes(b64) : null;
    },
  },
});

interface Failure {
  readonly sourceName: string;
  readonly reason: string;
}

const labels: Label[] = [];
const failures: Failure[] = [];

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const dropzone = $<HTMLDivElement>('dropzone');
const picker = $<HTMLInputElement>('picker');
const sheet = $<HTMLDivElement>('sheet');
const problems = $<HTMLDivElement>('problems');
const empty = $<HTMLParagraphElement>('empty');
const summary = $<HTMLParagraphElement>('summary');
const printButton = $<HTMLButtonElement>('print');
const clearButton = $<HTMLButtonElement>('clear');
const showTracking = $<HTMLInputElement>('showTracking');
const showTrackingLabel = $<HTMLLabelElement>('showTrackingLabel');
const progress = $<HTMLDivElement>('progress');
const progressBar = $<HTMLDivElement>('progressBar');
const progressText = $<HTMLParagraphElement>('progressText');

/**
 * Two columns of roughly 34mm rows on an A4 page with 11mm margins.
 * Only used to tell the user how much paper to expect.
 */
const PARCELS_PER_PAGE = 16;

/** Yield to the browser so the progress bar actually paints between files. */
const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

async function addFiles(files: readonly File[]): Promise<void> {
  const pdfs = files.filter((f) => f.name.toLowerCase().endsWith('.pdf'));
  const rejected = files.filter((f) => !pdfs.includes(f));
  for (const file of rejected) {
    failures.push({ sourceName: file.name, reason: 'Not a PDF file.' });
  }

  // Reading is sequential and can take a few seconds for a big batch, so show progress
  // rather than leaving the page looking frozen.
  const showProgress = pdfs.length > 1;
  if (showProgress) {
    progress.hidden = false;
    progressBar.style.width = '0%';
    progressText.textContent = `Reading ${pdfs.length} labels...`;
    await nextFrame();
  }

  let done = 0;
  for (const file of pdfs) {
    if (showProgress) {
      progressText.textContent = `Reading label ${done + 1} of ${pdfs.length}`;
      progressBar.style.width = `${(done / pdfs.length) * 100}%`;
      await nextFrame();
    }
    done++;

    if (labels.some((l) => l.sourceName === file.name)) continue;
    try {
      const page = await readPdfText(new Uint8Array(await file.arrayBuffer()));
      const result = extractLabel(page, file.name);
      if (result.ok) {
        if (labels.some((l) => l.tracking === result.label.tracking)) {
          failures.push({
            sourceName: file.name,
            reason: `Already on the sheet (${result.label.tracking}).`,
          });
        } else {
          labels.push(result.label);
        }
      } else {
        failures.push({ sourceName: result.sourceName, reason: result.reason });
      }
    } catch (error) {
      const reason =
        error instanceof PdfReadError ? error.message : `Could not read this file: ${String(error)}`;
      failures.push({ sourceName: file.name, reason });
    }
  }

  progress.hidden = true;
  render();
}

function render(): void {
  sheet.replaceChildren();

  for (const label of labels) {
    const row = document.createElement('article');
    row.className = 'parcel';

    const name = document.createElement('h2');
    name.className = 'parcel-name';
    name.textContent = label.recipient;

    const meta = document.createElement('p');
    meta.className = 'parcel-meta';
    meta.textContent = [label.destination, label.weight].filter(Boolean).join('  \u00b7  ');

    const code = document.createElement('div');
    code.className = 'parcel-barcode';
    code.innerHTML = barcodeSvg(label.tracking).svg;

    // Off by default, but a printed tracking number is the only fallback if a scan fails.
    const tracking = document.createElement('p');
    tracking.className = 'parcel-tracking';
    tracking.textContent = label.tracking;
    tracking.hidden = !showTracking.checked;

    const remove = document.createElement('button');
    remove.className = 'parcel-remove';
    remove.type = 'button';
    remove.title = `Remove ${label.recipient}`;
    remove.setAttribute('aria-label', `Remove ${label.recipient}`);
    remove.textContent = '\u00d7';
    remove.addEventListener('click', () => {
      labels.splice(labels.indexOf(label), 1);
      render();
    });

    row.append(name, meta, code, tracking, remove);
    sheet.append(row);
  }

  problems.replaceChildren();
  if (failures.length > 0) {
    const heading = document.createElement('h2');
    heading.textContent =
      failures.length === 1 ? '1 label could not be added' : `${failures.length} labels could not be added`;

    const list = document.createElement('ul');
    for (const failure of failures) {
      const item = document.createElement('li');
      const file = document.createElement('span');
      file.className = 'problem-file';
      file.textContent = failure.sourceName;
      item.append(file, document.createTextNode(` \u2014 ${failure.reason}`));
      list.append(item);
    }

    const note = document.createElement('p');
    note.className = 'problem-note';
    note.textContent = 'Print these ones the way you normally do.';

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'ghost';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => {
      failures.length = 0;
      render();
    });

    problems.append(heading, list, note, dismiss);
  }

  const count = labels.length;
  empty.hidden = count > 0;
  printButton.disabled = count === 0;
  clearButton.hidden = count === 0 && failures.length === 0;
  showTrackingLabel.hidden = count === 0;
  const pages = Math.ceil(count / PARCELS_PER_PAGE);
  summary.textContent =
    count === 0
      ? ''
      : `${count === 1 ? '1 parcel' : `${count} parcels`}  \u00b7  ${pages === 1 ? '1 page' : `${pages} pages`}`;
  document.body.classList.toggle('has-labels', count > 0);
}

dropzone.addEventListener('click', () => picker.click());
dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    picker.click();
  }
});

picker.addEventListener('change', () => {
  void addFiles([...(picker.files ?? [])]);
  picker.value = '';
});

for (const type of ['dragenter', 'dragover'] as const) {
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add('over');
  });
}
for (const type of ['dragleave', 'drop'] as const) {
  dropzone.addEventListener(type, () => dropzone.classList.remove('over'));
}
dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  void addFiles([...(event.dataTransfer?.files ?? [])]);
});

// Dropping anywhere on the page works, but never let a stray drop navigate away.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (event) => {
  event.preventDefault();
  void addFiles([...(event.dataTransfer?.files ?? [])]);
});

showTracking.addEventListener('change', render);
printButton.addEventListener('click', () => window.print());
clearButton.addEventListener('click', () => {
  labels.length = 0;
  failures.length = 0;
  render();
});

render();
