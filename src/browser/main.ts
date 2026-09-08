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
import {
  ALL_DAYS,
  dayKey,
  formatDay,
  groupByDay,
  selectedLabels,
  WINDOW_DAYS,
  type DatedLabel,
  type DayGroup,
} from '../queue.js';
import { isPdf, labelFilesToRead, type LoadScope } from '../folderLoad.js';
import { markPrinted, printedAt, type PrintedRecord } from '../printed.js';
import { loadPrinted, savePrinted } from './printedStore.js';
import {
  ensureReadable,
  folderPickingSupported,
  listFolder,
  pickFolder,
  readFile,
  type FolderOutcome,
} from './folderAccess.js';
import { clearFolder, loadFolder, saveFolder } from './folderStore.js';
import type { CustomsCategory } from '../types.js';

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

const labels: DatedLabel[] = [];
const failures: Failure[] = [];

/** Days whose labels are on the sheet. Selecting a day takes all of it. */
const selectedDays = new Set<string>();

/** Tracking codes unticked by hand. Held apart from the day so re-selecting a day is whole. */
const excluded = new Set<string>();

/**
 * What has been printed before, as far as this browser knows. Advisory: it marks a row
 * and never decides one, so an empty record only ever costs a badge.
 */
let printedRecord: PrintedRecord = loadPrinted(Date.now());

/**
 * How far back the days on offer reach. A week by default; everything once she has asked
 * for everything, so a folder loaded in full is not then hidden by the week's window.
 */
let windowDays: number = WINDOW_DAYS;

/** The folder the labels are in, once she has pointed at one. */
let labelsFolder: FileSystemDirectoryHandle | null = null;

/**
 * One load at a time, whichever way it was started.
 *
 * Reading is a sequence of awaits over shared state and one progress bar, so two runs
 * interleaving leaves the bar owned by whichever finishes first while the other is still
 * going. Guarding only the folder buttons was not enough: a drop lands on the same loop.
 */
let loading = false;

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const dropzone = $<HTMLDivElement>('dropzone');
const days = $<HTMLDivElement>('days');
const folder = $<HTMLDivElement>('folder');
const folderPick = $<HTMLButtonElement>('folderPick');
const folderKnown = $<HTMLDivElement>('folderKnown');
const folderName = $<HTMLElement>('folderName');
const folderWeek = $<HTMLButtonElement>('folderWeek');
const folderAll = $<HTMLButtonElement>('folderAll');
const folderChange = $<HTMLButtonElement>('folderChange');
const folderNote = $<HTMLParagraphElement>('folderNote');
const picker = $<HTMLInputElement>('picker');
const sheet = $<HTMLDivElement>('sheet');
const problems = $<HTMLDivElement>('problems');
const empty = $<HTMLParagraphElement>('empty');
const summary = $<HTMLParagraphElement>('summary');
const printButton = $<HTMLButtonElement>('print');
const clearButton = $<HTMLButtonElement>('clear');
const showTracking = $<HTMLInputElement>('showTracking');
const showTrackingLabel = $<HTMLLabelElement>('showTrackingLabel');
const printHint = $<HTMLParagraphElement>('printHint');
const progress = $<HTMLDivElement>('progress');
const progressBar = $<HTMLDivElement>('progressBar');
const progressText = $<HTMLParagraphElement>('progressText');

/**
 * Two columns of roughly 34mm rows on an A4 page with 11mm margins.
 * Only used to tell the user how much paper to expect.
 */
const PARCELS_PER_PAGE = 16;

/**
 * Yield so the progress bar paints between files.
 *
 * requestAnimationFrame alone is not enough: browsers stop firing it in a background or
 * occluded tab, which would stall the whole run the moment she switches tabs. Race it
 * against a timer so work always continues.
 */
const yieldToBrowser = (): Promise<void> =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    requestAnimationFrame(finish);
    setTimeout(finish, 50);
  });

/**
 * Run one loading operation, and only one.
 *
 * Every way of getting labels onto the page goes through here -- a drop, the file picker,
 * a folder read -- so there is a single owner of `loading` rather than a flag each caller
 * remembers to set. A second attempt while one is running is dropped rather than queued:
 * the work is idempotent, and the honest answer to a double click is to ignore it.
 */
async function runExclusive(work: () => Promise<void>): Promise<void> {
  if (loading) return;
  loading = true;
  renderFolder();
  try {
    await work();
  } finally {
    loading = false;
    renderFolder();
  }
}

async function addFiles(files: readonly File[]): Promise<void> {
  const pdfs = files.filter((f) => isPdf(f.name));
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
    await yieldToBrowser();
  }

  let done = 0;
  for (const file of pdfs) {
    if (showProgress) {
      progressText.textContent = `Reading label ${done + 1} of ${pdfs.length}`;
      progressBar.style.width = `${(done / pdfs.length) * 100}%`;
      await yieldToBrowser();
    }
    done++;

    if (labels.some((l) => l.label.sourceName === file.name)) continue;
    try {
      const page = await readPdfText(new Uint8Array(await file.arrayBuffer()));
      const result = extractLabel(page, file.name);
      if (result.ok) {
        if (labels.some((l) => l.label.tracking === result.label.tracking)) {
          failures.push({
            sourceName: file.name,
            reason: `Already on the sheet (${result.label.tracking}).`,
          });
        } else {
          // The download time, which is when the label was made. It comes free with the
          // file, so the pile sorts itself into days without opening anything.
          labels.push({ label: result.label, madeAt: file.lastModified });
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
  selectADayIfNoneChosen();
  render();
}

/**
 * Open on today's batch, which is the run being prepared nine times out of ten.
 *
 * Only ever fills an empty selection, so it cannot undo a choice already made -- adding
 * more files to a sheet leaves the days she picked alone. When nothing arrived today
 * the newest day stands in, because an empty sheet after a drop reads as a failure.
 */
function selectADayIfNoneChosen(): void {
  if (selectedDays.size > 0) return;
  const now = Date.now();
  const groups = groupByDay(labels, now, windowDays);
  const today = dayKey(now);
  const opening = groups.find((g) => g.day === today) ?? groups[0];
  if (opening) selectedDays.add(opening.day);
}

/**
 * Wording for the customs badge. Short on purpose: it shares a line with the recipient
 * name in a half-width column, and these mirror the captions printed on the CN22 form.
 */
const CATEGORY_TEXT: Readonly<Record<CustomsCategory, string>> = {
  gift: 'Gift',
  'commercial-sample': 'Sample',
  merchandise: 'Merch.',
  documents: 'Docs',
  'returned-goods': 'Returned',
  other: 'Other',
};

/**
 * The day chips, built from the labels rather than a fixed 1/2/3/7 -- a day with nothing
 * in it is never offered, and every day offered has something behind it.
 */
function renderDays(groups: readonly DayGroup[], today: string): void {
  days.replaceChildren();

  const kept = groups.reduce((n, group) => n + group.labels.length, 0);
  const older = labels.length - kept;

  // Still shown when every day is empty: dropping a folder of nothing but old labels is
  // the one case where the note is the only thing that explains the blank page.
  days.hidden = groups.length === 0 && older === 0;

  for (const group of groups) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'day';
    const on = selectedDays.has(group.day);
    chip.setAttribute('aria-pressed', String(on));

    const name = document.createElement('span');
    name.textContent = formatDay(group.day, today);

    const count = document.createElement('span');
    count.className = 'day-count';
    count.textContent = String(group.labels.length);

    chip.append(name, count);
    chip.addEventListener('click', () => {
      if (selectedDays.has(group.day)) selectedDays.delete(group.day);
      else {
        selectedDays.add(group.day);
        // Taking a day means taking all of it. Anything unticked in it last time starts
        // ticked again, so re-selecting a day never hides a parcel behind old state.
        for (const dated of group.labels) excluded.delete(dated.label.tracking);
      }
      render();
    });

    days.append(chip);
  }

  // Dropping the whole Downloads folder is the intended gesture, so most of what arrives
  // is older than the week on offer. Say how many were left out: a label that vanishes
  // with nothing said reads as the app having lost it.
  if (older > 0) {
    const note = document.createElement('p');
    note.className = 'days-note';
    note.textContent =
      older === 1
        ? '1 label older than a week, not shown'
        : `${older} labels older than a week, not shown`;
    days.append(note);
  }
}

function render(): void {
  const now = Date.now();
  const today = dayKey(now);
  const groups = groupByDay(labels, now, windowDays);

  renderDays(groups, today);

  // Everything in a chosen day is on the sheet; the unticked ones stay visible, dimmed,
  // so a change of mind costs one click. `chosen` is what actually reaches paper.
  const shown = selectedLabels(groups, selectedDays, new Set());
  const chosen = selectedLabels(groups, selectedDays, excluded);

  sheet.replaceChildren();

  for (const dated of shown) {
    const label = dated.label;
    const isExcluded = excluded.has(label.tracking);

    // The parcel is the control. One idea, one gesture, a target the size of the card --
    // rather than a checkbox to tick and a cross to press that both meant "not this one".
    const row = document.createElement('article');
    row.className = isExcluded ? 'parcel excluded' : 'parcel';
    row.tabIndex = 0;
    row.setAttribute('role', 'checkbox');
    row.setAttribute('aria-checked', String(!isExcluded));
    row.setAttribute('aria-label', `Print ${label.recipient}, ${label.destination}`);

    const name = document.createElement('h2');
    name.className = 'parcel-name';
    const who = document.createElement('span');
    who.className = 'parcel-who';
    who.textContent = label.recipient;
    name.append(who);

    // Only when the label actually carries a customs declaration. No badge is the right
    // answer for a domestic parcel, and for a category we could not read.
    if (label.category) {
      const tag = document.createElement('span');
      tag.className = 'parcel-tag';
      tag.dataset['category'] = label.category;
      tag.textContent = CATEGORY_TEXT[label.category];
      name.append(tag);
    }

    const meta = document.createElement('p');
    meta.className = 'parcel-meta';
    meta.textContent = [label.destination, label.weight].filter(Boolean).join('  \u00b7  ');

    // Says so, does nothing about it. Printing a label twice is sometimes exactly what
    // she wants -- a torn sticker, a jam -- so this warns and never decides.
    const printedTime = printedAt(printedRecord, label.tracking);
    if (printedTime !== null) {
      const badge = document.createElement('span');
      badge.className = 'parcel-printed';
      badge.textContent = `Printed ${formatDay(dayKey(printedTime), today)}`;
      meta.append(badge);
    }

    const code = document.createElement('div');
    code.className = 'parcel-barcode';
    code.innerHTML = barcodeSvg(label.tracking).svg;

    // Off by default, but a printed tracking number is the only fallback if a scan fails.
    const tracking = document.createElement('p');
    tracking.className = 'parcel-tracking';
    tracking.textContent = label.tracking;
    tracking.hidden = !showTracking.checked;

    // Shows the state; it is not a second thing to aim at. Dimming alone would leave
    // "is this one on?" to be judged from a shade of grey.
    const state = document.createElement('span');
    state.className = 'parcel-state';
    state.setAttribute('aria-hidden', 'true');
    state.textContent = isExcluded ? '' : '\u2713';

    const toggle = (): void => {
      if (isExcluded) excluded.delete(label.tracking);
      else excluded.add(label.tracking);
      render();
    };

    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (event) => {
      if (event.key !== ' ' && event.key !== 'Enter') return;
      event.preventDefault(); // Space scrolls the page otherwise.
      toggle();
    });

    row.append(name, meta, code, tracking, state);
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

  const loaded = labels.length;
  const count = chosen.length;

  empty.hidden = loaded > 0;
  clearButton.hidden = loaded === 0 && failures.length === 0;
  showTrackingLabel.hidden = loaded === 0;
  document.body.classList.toggle('has-labels', loaded > 0);

  // The button carries the number, because it is the last thing read before paper is
  // committed. The summary says how many of what is on screen that is.
  printButton.disabled = count === 0;
  printButton.textContent = count === 1 ? 'Print 1 label' : `Print ${count} labels`;

  const pages = Math.ceil(count / PARCELS_PER_PAGE);
  const parcels =
    count === shown.length
      ? `${count === 1 ? '1 parcel' : `${count} parcels`}`
      : `${count} of ${shown.length} parcels`;
  summary.textContent =
    count === 0
      ? shown.length === 0
        ? ''
        : `Nothing ticked  \u00b7  ${shown.length} on screen`
      : `${parcels}  \u00b7  ${pages === 1 ? '1 page' : `${pages} pages`}`;
}

dropzone.addEventListener('click', () => picker.click());
dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    picker.click();
  }
});

picker.addEventListener('change', () => {
  void runExclusive(() => addFiles([...(picker.files ?? [])]));
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
  void runExclusive(() => addFiles([...(event.dataTransfer?.files ?? [])]));
});

// Dropping anywhere on the page works, but never let a stray drop navigate away.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (event) => {
  event.preventDefault();
  void runExclusive(() => addFiles([...(event.dataTransfer?.files ?? [])]));
});

showTracking.addEventListener('change', render);

/**
 * Embedded in an iframe (a preview pane, say) the browser blocks window.print(), and the
 * button would just look broken. Say so instead, and offer the keyboard shortcut.
 */
const isEmbedded = (): boolean => {
  try {
    return window.self !== window.top;
  } catch {
    return true; // cross-origin parent — definitely embedded
  }
};

const isMac = /mac/i.test(navigator.platform || navigator.userAgent);
$<HTMLElement>('printKey').textContent = isMac ? 'Cmd' : 'Ctrl';

printButton.addEventListener('click', () => {
  if (isEmbedded()) {
    printHint.hidden = false;
    return;
  }

  const now = Date.now();
  const chosen = selectedLabels(groupByDay(labels, now, windowDays), selectedDays, excluded);

  try {
    window.print();
  } catch {
    printHint.hidden = false;
    return;
  }

  // Recorded on the way to the printer, not on the way back: `afterprint` fires whether
  // the dialog was accepted or cancelled, so it can tell us nothing this does not. A jam
  // is answered by printing the day again, which is the same gesture as printing it.
  printedRecord = markPrinted(
    printedRecord,
    chosen.map((dated) => dated.label.tracking),
    now,
  );
  savePrinted(printedRecord);
  render();
});
clearButton.addEventListener('click', () => {
  labels.length = 0;
  failures.length = 0;
  selectedDays.clear();
  excluded.clear();
  windowDays = WINDOW_DAYS;
  render();
});

// --- the labels folder ------------------------------------------------------------
//
// Pointing at the folder once and then asking for a week or the lot, rather than picking
// files out of Downloads by hand every time. The folder is remembered; permission to read
// it is not, which is why every path back into it starts from a button she pressed.

/** Every way this can fail, said plainly. Nothing here is a stack trace. */
function noteFor(outcome: FolderOutcome): string {
  switch (outcome.kind) {
    case 'unsupported':
      return 'This browser cannot open a folder. Drag the labels on instead -- everything else works the same.';
    case 'cancelled':
      // Chrome refuses Downloads itself and says so in its own dialog, which reaches us
      // as a cancellation. Worth saying, because the obvious folder is the blocked one.
      return 'No folder chosen. Note that Chrome will not hand over the Downloads folder itself -- point this at a folder inside it, such as Downloads/labels.';
    case 'blocked':
      return 'The browser will not give a page that folder. Downloads, Desktop, Documents and your home folder are all refused; a folder inside one of them is fine.';
    case 'denied':
      return 'Permission to read that folder was not given. Press the button again to be asked once more.';
    case 'gone':
      return 'That folder has moved or been deleted. Choose it again.';
    case 'failed':
      return `Could not read that folder: ${outcome.reason}`;
  }
}

function showNote(text: string): void {
  folderNote.textContent = text;
  folderNote.hidden = false;
}

function renderFolder(): void {
  folder.hidden = !folderPickingSupported();
  folderPick.hidden = labelsFolder !== null;
  folderKnown.hidden = labelsFolder === null;
  if (labelsFolder) folderName.textContent = labelsFolder.name;

  for (const button of [folderPick, folderWeek, folderAll, folderChange]) {
    button.disabled = loading;
  }
}

/**
 * Read a scope out of the remembered folder.
 *
 * Permission is asked for first and from inside the click, because a handle restored from
 * storage comes back needing it again and the browser only grants that during a gesture.
 * A folder that has since moved forgets itself rather than failing the same way forever.
 */
async function loadFromFolder(scope: LoadScope): Promise<void> {
  if (!labelsFolder) return;

  const readable = await ensureReadable(labelsFolder);
  if (readable.kind !== 'ok') {
    if (readable.kind === 'gone') {
      labelsFolder = null;
      await clearFolder();
    }
    showNote(noteFor(readable));
    return;
  }

  const listed = await listFolder(readable.handle);
  if (listed.kind !== 'ok') {
    if (listed.kind === 'gone') {
      labelsFolder = null;
      await clearFolder();
    }
    showNote(noteFor(listed));
    return;
  }

  const unreadable = listed.skipped > 0 ? ` (${listed.skipped} could not be read)` : '';
  const wanted = labelFilesToRead(listed.entries, scope, Date.now(), WINDOW_DAYS);
  if (wanted.length === 0) {
    // Said before the window is widened: nothing was added, so nothing should move.
    showNote(
      listed.entries.length === 0
        ? `No PDFs in ${readable.handle.name}${unreadable}.`
        : `Nothing from the last week in ${readable.handle.name}${unreadable}. Try Everything.`,
    );
    return;
  }

  // Asking for everything widens the days on offer to match, or the folder would be read
  // in full and then mostly hidden behind the week's window. Narrowing back drops the days
  // that have left it, so they are not still selected if it widens again later.
  windowDays = scope === 'all' ? ALL_DAYS : WINDOW_DAYS;
  if (scope !== 'all') {
    const offered = new Set(groupByDay(labels, Date.now(), windowDays).map((g) => g.day));
    for (const day of [...selectedDays]) if (!offered.has(day)) selectedDays.delete(day);
  }

  // A file can be moved or cleaned up between listing the folder and opening it; those
  // come back null and are dropped rather than failing the whole load.
  const opened = await Promise.all(wanted.map((entry) => readFile(readable.handle, entry.name)));
  const files = opened.filter((file): file is File => file !== null);
  const vanished = opened.length - files.length;

  showNote(
    `Read ${files.length} label${files.length === 1 ? '' : 's'} from ${readable.handle.name}` +
      (vanished > 0 ? ` (${vanished} could not be opened)` : '') +
      unreadable +
      '.',
  );

  await addFiles(files);
}

async function chooseFolder(): Promise<void> {
  const picked = await pickFolder();
  if (picked.kind !== 'ok') {
    showNote(noteFor(picked));
    return;
  }

  labelsFolder = picked.handle;
  await saveFolder(picked.handle);
  folderNote.hidden = true;
  renderFolder();
}

folderPick.addEventListener('click', () => void runExclusive(chooseFolder));
folderChange.addEventListener('click', () => void runExclusive(chooseFolder));
folderWeek.addEventListener('click', () => void runExclusive(() => loadFromFolder('week')));
folderAll.addEventListener('click', () => void runExclusive(() => loadFromFolder('all')));

/**
 * Bring back the folder from last time, without asking for permission.
 *
 * Permission has to be requested from a gesture, so all this does is put the buttons back;
 * pressing one is what asks. Failing to restore is silent -- she is simply offered the
 * picker, which is what someone with no folder saved sees anyway.
 */
async function restoreFolder(): Promise<void> {
  if (!folderPickingSupported()) return;
  labelsFolder = await loadFolder();
  renderFolder();
}

render();
renderFolder();
void restoreFolder();
