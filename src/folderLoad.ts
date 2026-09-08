/**
 * folderLoad.ts -- choosing which files in a folder are worth opening.
 *
 * Reading a PDF costs far more than reading its name and date, and the folder this points
 * at is the Downloads folder or something like it: months of labels, of which one post
 * office run wants a handful. So the filtering happens on the listing, before a single
 * file is opened. Asking for a week out of two hundred labels opens ten.
 *
 * The window rule is not restated here -- it is `withinWindow` from `queue.ts`, the same
 * one that decides which days get offered. Two definitions of "the last week" would drift,
 * and a file that is read but then never shown is a confusing way to find that out.
 *
 * Pure: it is handed a listing, not a directory. Whether that listing came from a folder
 * handle, a drop, or a test is not its business.
 */
import { withinWindow } from './queue.js';

/** A file in the folder, as far as deciding whether to open it goes. */
export interface FolderEntry {
  readonly name: string;
  /** The file's modification time, which for a download is when it landed. */
  readonly lastModified: number;
}

/** How much of the folder is wanted. */
export type LoadScope = 'week' | 'all';

/**
 * A real extension, so a file merely named "notapdf" is not mistaken for one.
 *
 * Exported because a PDF is recognised in three places -- the folder adapter filters by
 * name before asking for each file's date, this filters the listing, and the drop handler
 * filters what was dropped. One definition, so a file the folder path skips and one the
 * drop path accepts can never be the same file.
 */
export const isPdf = (name: string): boolean => /\.pdf$/i.test(name);

/**
 * The files worth opening, newest first.
 *
 * Newest first because a big folder is read in order and the parcels that matter are the
 * recent ones; if a long read is interrupted, what arrived is the useful end of it.
 *
 * @param entries the folder listing
 * @param scope `week` for the current window, `all` for everything in the folder
 * @param now the clock, injected so this stays testable
 * @param windowDays the width of the window `week` means
 */
export function labelFilesToRead(
  entries: readonly FolderEntry[],
  scope: LoadScope,
  now: number,
  windowDays: number,
): readonly FolderEntry[] {
  return entries
    .filter((entry) => isPdf(entry.name))
    .filter((entry) => scope === 'all' || withinWindow(entry.lastModified, now, windowDays))
    .slice()
    .sort((a, b) => b.lastModified - a.lastModified);
}
