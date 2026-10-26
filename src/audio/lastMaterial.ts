// The material last opened, kept in IndexedDB so that closing the browser and
// coming back reopens it. Its edits come back with it: they are already kept per
// material in localStorage (export/settings.ts), keyed by name, length and rate.
// Only the samples actually in use are kept (a long file's picked range, not the file).

export type LastMaterial = { kind: "demo" } | { kind: "clip"; name: string; sampleRate: number; channels: Float32Array[] };

const DB = "easysampler";
const STORE = "last";
const KEY = "material";

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

/** Keeps the material (best effort: a private window or a full disk just means nothing is kept). */
export async function saveLastMaterial(material: LastMaterial): Promise<void> {
  try {
    await run("readwrite", (store) => store.put(material, KEY));
    // Ask the browser not to clear it under storage pressure (granted or not, nothing else changes).
    void navigator.storage?.persist?.().catch(() => false);
  } catch {
    // not kept this time
  }
}

/** The material kept last time, or null. */
export async function loadLastMaterial(): Promise<LastMaterial | null> {
  try {
    const value = (await run("readonly", (store) => store.get(KEY))) as LastMaterial | undefined;
    if (!value) return null;
    if (value.kind === "demo") return value;
    if (value.kind === "clip" && value.channels?.length && value.channels[0] instanceof Float32Array && value.sampleRate > 0) return value;
    return null;
  } catch {
    return null;
  }
}

/** Keeps any other value under its own key in the same store (the song being written, design.md 13). */
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
