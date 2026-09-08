/**
 * folderAccess.ts -- the folder, as the browser will let us have it.
 *
 * The File System Access API fails in half a dozen distinguishable ways and reports them
 * all as thrown DOM exceptions. This is the only file that knows that. Everything above it
 * gets a named outcome, so no part of the app has to guess what an `AbortError` meant.
 *
 * One limitation is worth knowing before reading further: Chrome refuses to hand a page
 * the Downloads folder itself. It sits on the blocklist in
 * `chrome_file_system_access_permission_context.cc` next to the home directory, Desktop and
 * Documents -- all with `kDontBlockChildren`, so a folder *inside* Downloads is allowed and
 * Downloads itself is not. The refusal is shown by the browser as its own dialog and
 * reaches us as a cancellation, which is why `cancelled` carries no blame: it may have been
 * a change of mind, and it may have been Chrome saying no.
 */
import { isPdf, type FolderEntry } from '../folderLoad.js';

/** What came of asking for a folder. Every branch here is a thing that really happens. */
export type FolderOutcome =
  /** The browser has no File System Access API -- Safari, Firefox, or a file:// page. */
  | { readonly kind: 'unsupported' }
  /** The picker was dismissed, or the browser refused the folder in its own dialog. */
  | { readonly kind: 'cancelled' }
  /** The browser named the folder as one a page may never have. */
  | { readonly kind: 'blocked' }
  /** Permission to read was asked for and not given. */
  | { readonly kind: 'denied' }
  /** A folder we had before, which has since been moved, renamed or deleted. */
  | { readonly kind: 'gone' }
  | { readonly kind: 'failed'; readonly reason: string };

export type PickResult = { readonly kind: 'ok'; readonly handle: FileSystemDirectoryHandle } | FolderOutcome;

export type ListResult =
  | {
      readonly kind: 'ok';
      readonly entries: readonly FolderEntry[];
      /** Files that could not be read at all. Counted so a load never blames the folder. */
      readonly skipped: number;
    }
  | FolderOutcome;

/**
 * Whether a value restored from storage is a directory handle.
 *
 * Lives here rather than in the storage adapter: what a handle looks like is knowledge
 * about the File System Access API, and this is the file that is allowed to have it.
 */
export function isDirectoryHandle(value: unknown): value is FileSystemDirectoryHandle {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { kind?: unknown; name?: unknown };
  return candidate.kind === 'directory' && typeof candidate.name === 'string';
}

interface PermissionCapable {
  queryPermission?(descriptor: { mode: 'read' }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: 'read' }): Promise<PermissionState>;
}

type DirectoryPicker = (options?: {
  id?: string;
  mode?: 'read';
  startIn?: string;
}) => Promise<FileSystemDirectoryHandle>;

const picker = (): DirectoryPicker | null => {
  const fn = (window as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
  return typeof fn === 'function' ? fn.bind(window) : null;
};

/** Whether this browser can offer a folder at all. Drag-and-drop works regardless. */
export function folderPickingSupported(): boolean {
  return picker() !== null;
}

const nameOf = (error: unknown): string =>
  error instanceof DOMException ? error.name : error instanceof Error ? error.name : '';

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Turn a thrown DOM exception into an outcome.
 *
 * `AbortError` is the picker being dismissed. `SecurityError` is the browser refusing --
 * either the folder is blocklisted, or the call did not come from a real user gesture.
 * `NotAllowedError` is permission withheld. `NotFoundError` is a folder that has moved.
 */
function outcomeFor(error: unknown): FolderOutcome {
  switch (nameOf(error)) {
    case 'AbortError':
      return { kind: 'cancelled' };
    case 'SecurityError':
      return { kind: 'blocked' };
    case 'NotAllowedError':
      return { kind: 'denied' };
    case 'NotFoundError':
      return { kind: 'gone' };
    default:
      return { kind: 'failed', reason: messageOf(error) };
  }
}

/** Ask for a folder. Must be called from a user gesture or the browser refuses. */
export async function pickFolder(): Promise<PickResult> {
  const show = picker();
  if (!show) return { kind: 'unsupported' };

  try {
    // `id` makes the browser reopen where this app was last pointed, rather than at some
    // unrelated folder another part of the browser visited.
    return { kind: 'ok', handle: await show({ id: 'label-sheet-labels', mode: 'read' }) };
  } catch (error) {
    return outcomeFor(error);
  }
}

/**
 * Make sure a folder we already hold may still be read.
 *
 * A handle restored from storage usually comes back needing permission again. Asking for
 * it has to happen inside a user gesture, which is why this is called from the button and
 * not on page load.
 */
export async function ensureReadable(handle: FileSystemDirectoryHandle): Promise<PickResult> {
  const permissions = handle as unknown as PermissionCapable;
  try {
    // Absent in browsers that have the API but not the permissions half of it; assume
    // readable and let the read itself be the thing that fails.
    const current = (await permissions.queryPermission?.({ mode: 'read' })) ?? 'granted';
    if (current === 'granted') return { kind: 'ok', handle };

    const asked = (await permissions.requestPermission?.({ mode: 'read' })) ?? 'granted';
    return asked === 'granted' ? { kind: 'ok', handle } : { kind: 'denied' };
  } catch (error) {
    return outcomeFor(error);
  }
}

/**
 * List the PDFs in a folder, with the dates the scope filter needs.
 *
 * `getFile()` reads metadata, not contents, so this stays cheap; the bytes are only read
 * later for the files actually chosen. Sub-folders are not descended into: a labels folder
 * is flat, and quietly walking a tree is how a click turns into thousands of reads.
 *
 * A file that disappears or cannot be opened between listing and reading is skipped rather
 * than failing the whole load -- one unreadable file must not cost the other forty.
 */
export async function listFolder(handle: FileSystemDirectoryHandle): Promise<ListResult> {
  const entries: FolderEntry[] = [];
  let skipped = 0;

  try {
    // `values()`, not the handle itself: a directory's default async iterator is
    // `entries()`, which yields [name, handle] pairs. Iterating the handle directly gives
    // arrays whose `.kind` is undefined, so every file is silently skipped and a full
    // folder reports itself empty.
    const iterable = (
      handle as unknown as { values(): AsyncIterableIterator<FileSystemHandle> }
    ).values();
    for await (const child of iterable) {
      if (child.kind !== 'file') continue;
      if (!isPdf(child.name)) continue;

      try {
        const file = await (child as FileSystemFileHandle).getFile();
        entries.push({ name: file.name, lastModified: file.lastModified });
      } catch {
        // Gone, locked, or still being written. Not a reason to abandon the folder --
        // but counted, so a folder whose files all fail is never reported as an empty one.
        skipped++;
      }
    }
  } catch (error) {
    return outcomeFor(error);
  }

  return { kind: 'ok', entries, skipped };
}

/**
 * Open one named file from the folder.
 *
 * Returns null rather than throwing when it has gone: between listing a folder and reading
 * it, a download can be moved or cleaned up, and that is the caller's cue to skip it.
 */
export async function readFile(
  handle: FileSystemDirectoryHandle,
  name: string,
): Promise<File | null> {
  try {
    return await (await handle.getFileHandle(name)).getFile();
  } catch {
    return null;
  }
}
