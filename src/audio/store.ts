// The browser-side store (IndexedDB): the project, each material's samples and
// each material's settings, under their own keys. Best effort: a private window
// or a full disk just means nothing is kept.

const DB = "easysampler";
const STORE = "last";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no IndexedDB"));
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = body(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Keeps a value under its key (structured clone: typed arrays as they are). */
export async function keep(key: string, value: unknown): Promise<void> {
  try {
    await run("readwrite", (store) => store.put(value, key));
  } catch {
    // not kept this time
  }
}

/** A value kept with keep(), or undefined. */
export async function kept(key: string): Promise<unknown> {
  try {
    return await run("readonly", (store) => store.get(key));
  } catch {
    return undefined;
  }
}

/** Forgets a key. */
export async function forget(key: string): Promise<void> {
  try {
    await run("readwrite", (store) => store.delete(key));
  } catch {
    // nothing to forget
  }
}

/** Asks the browser not to clear the store under storage pressure (granted or not, nothing else changes). */
export function askToPersist(): void {
  void navigator.storage?.persist?.().catch(() => false);
}
