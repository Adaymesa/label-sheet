/**
 * folderStore.ts -- remembering which folder the labels are in.
 *
 * IndexedDB rather than localStorage, and not by choice: a directory handle is a live
 * object the browser structured-clones, and localStorage holds strings. This is the only
 * file that knows that.
 *
 * Everything here answers failure with "no folder remembered". The folder is a
 * convenience over dragging files in, so a private window, a blocked-storage profile or a
 * corrupted database should cost the shortcut and nothing else.
 */
import { isDirectoryHandle } from './folderAccess.js';

const DB_NAME = 'label-sheet';
const DB_VERSION = 1;
const STORE = 'handles';
const KEY = 'labels-folder';

/** Never rejects: a database that will not open is the same as having no folder saved. */
function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null); // Storage blocked outright, as in some private modes.
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    // A version change held open by another tab would otherwise hang this forever.
    request.onblocked = () => resolve(null);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest,
  fallback: T,
): Promise<T> {
  const db = await openDb();
  if (!db) return fallback;

  try {
    return await new Promise<T>((resolve) => {
      const tx = db.transaction(STORE, mode);
      const request = work(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => resolve(fallback);
      tx.onabort = () => resolve(fallback);
      tx.onerror = () => resolve(fallback);
    });
  } catch {
    return fallback;
  } finally {
    db.close();
  }
}

/** The folder chosen last time, or null. Holding it does not mean it may be read. */
export async function loadFolder(): Promise<FileSystemDirectoryHandle | null> {
  const stored = await withStore<unknown>('readonly', (store) => store.get(KEY), null);
  // Anything could be under this key -- an older version of the app, a half-written value.
  // What a handle looks like is the folder adapter's knowledge, not this one's.
  return isDirectoryHandle(stored) ? stored : null;
}

/** Remember this folder, or carry on without remembering it. */
export async function saveFolder(handle: FileSystemDirectoryHandle): Promise<void> {
  await withStore('readwrite', (store) => store.put(handle, KEY), undefined);
}

/** Forget the folder -- it has moved, or a different one was chosen. */
export async function clearFolder(): Promise<void> {
  await withStore('readwrite', (store) => store.delete(KEY), undefined);
}
