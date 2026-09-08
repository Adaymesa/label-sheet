import { describe, it, expect } from 'vitest';
import { labelFilesToRead, type FolderEntry } from './folderLoad.js';
import { ALL_DAYS, WINDOW_DAYS } from './queue.js';

const at = (y: number, month: number, day: number, hour = 12): number =>
  new Date(y, month - 1, day, hour).getTime();

const file = (name: string, lastModified: number): FolderEntry => ({ name, lastModified });

const namesOf = (entries: readonly FolderEntry[]): string[] => entries.map((e) => e.name);

const NOW = at(2026, 9, 7);

describe('labelFilesToRead', () => {
  it('reads nothing from an empty folder', () => {
    expect(labelFilesToRead([], 'all', NOW, WINDOW_DAYS)).toEqual([]);
  });

  it('takes every PDF when everything is asked for', () => {
    const entries = [file('a.pdf', at(2026, 9, 7)), file('b.pdf', at(2019, 1, 1))];

    expect(namesOf(labelFilesToRead(entries, 'all', NOW, WINDOW_DAYS))).toEqual(['a.pdf', 'b.pdf']);
  });

  it('takes only this week when the week is asked for', () => {
    const entries = [
      file('today.pdf', at(2026, 9, 7)),
      file('edge.pdf', at(2026, 9, 1)),
      file('stale.pdf', at(2026, 8, 31)),
    ];

    expect(namesOf(labelFilesToRead(entries, 'week', NOW, WINDOW_DAYS))).toEqual([
      'today.pdf',
      'edge.pdf',
    ]);
  });

  it('leaves anything that is not a PDF alone', () => {
    const entries = [
      file('label.pdf', NOW),
      file('receipt.png', NOW),
      file('notes.txt', NOW),
      file('.DS_Store', NOW),
      file('archive.pdf.zip', NOW),
    ];

    expect(namesOf(labelFilesToRead(entries, 'all', NOW, WINDOW_DAYS))).toEqual(['label.pdf']);
  });

  it('recognises a PDF whatever the case of its extension', () => {
    const entries = [file('A.PDF', NOW), file('b.Pdf', NOW)];

    expect(namesOf(labelFilesToRead(entries, 'all', NOW, WINDOW_DAYS))).toEqual(['A.PDF', 'b.Pdf']);
  });

  it('does not mistake a name ending in "pdf" for a PDF', () => {
    // The dot is the extension, not the letters.
    expect(labelFilesToRead([file('notapdf', NOW)], 'all', NOW, WINDOW_DAYS)).toEqual([]);
  });

  it('gives the newest file first, so a big folder shows recent parcels first', () => {
    const entries = [
      file('old.pdf', at(2026, 9, 4)),
      file('new.pdf', at(2026, 9, 7)),
      file('middle.pdf', at(2026, 9, 5)),
    ];

    expect(namesOf(labelFilesToRead(entries, 'all', NOW, WINDOW_DAYS))).toEqual([
      'new.pdf',
      'middle.pdf',
      'old.pdf',
    ]);
  });

  it('keeps a file dated in the future in the week, matching what the days will show', () => {
    const entries = [file('ahead.pdf', at(2026, 9, 9))];

    expect(namesOf(labelFilesToRead(entries, 'week', NOW, WINDOW_DAYS))).toEqual(['ahead.pdf']);
  });

  it('treats an unlimited window as taking everything even in week mode', () => {
    const entries = [file('ancient.pdf', at(2019, 1, 1))];

    expect(namesOf(labelFilesToRead(entries, 'week', NOW, ALL_DAYS))).toEqual(['ancient.pdf']);
  });

  it('does not mutate the folder listing it was given', () => {
    const entries = [file('b.pdf', at(2026, 9, 4)), file('a.pdf', at(2026, 9, 7))];
    labelFilesToRead(entries, 'all', NOW, WINDOW_DAYS);

    expect(namesOf(entries)).toEqual(['b.pdf', 'a.pdf']);
  });

  it('keeps both copies of a repeat download, so neither is silently the one that lost', () => {
    // Chrome writes the second download as "name (1).pdf". Which of the two is really
    // wanted is decided later, on the tracking code read out of the PDF itself.
    const entries = [file('LX1ES.pdf', at(2026, 9, 7, 9)), file('LX1ES (1).pdf', at(2026, 9, 7, 10))];

    expect(namesOf(labelFilesToRead(entries, 'all', NOW, WINDOW_DAYS))).toEqual([
      'LX1ES (1).pdf',
      'LX1ES.pdf',
    ]);
  });
});
