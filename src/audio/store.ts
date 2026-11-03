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

/** Where saving stands: nothing waiting, writes under way, or the last write failed (a full disk, a private window). */
export type SaveState = "saved" | "saving" | "failed";
let pending = 0;
let failed = false;
const listeners = new Set<(state: SaveState) => void>();
const idle: (() => void)[] = [];

function saveState(): SaveState {
  return pending > 0 ? "saving" : failed ? "failed" : "saved";
}

function notify(): void {
  const state = saveState();
  for (const listener of listeners) listener(state);
  if (pending === 0) for (const resolve of idle.splice(0)) resolve();
}

/** Called with the save state now and whenever it changes. */
export function onSaveState(listener: (state: SaveState) => void): void {
  listeners.add(listener);
  listener(saveState());
}

/** Resolves once every write under way has finished. */
export function whenSaved(): Promise<void> {
  return pending === 0 ? Promise.resolve() : new Promise((resolve) => idle.push(resolve));
}

// ------------------------------------------------------------ other tabs (design.md 37)

/** This tab, among the others on the same store. */
const TAB = Math.random().toString(36).slice(2);
const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("easysampler-store");
/** Another tab wrote what this one holds: this one writes no more (its copy is old), until it is loaded again. */
let frozen = false;
let onFrozen: ((key: string) => void) | null = null;
let mine: (key: string) => boolean = () => false;
/**
 * Whether this tab's writes are told to the others: not before the person has touched it — a page coming up writes
 * back what it just read (its project, its material), and a second tab merely opened must not stop the first.
 */
let announcing = false;

/** From now on this tab's writes are told to the other tabs. */
export function startAnnouncing(): void {
  announcing = true;
}

/**
 * Watches the other tabs on the store: when one of them writes a key `holds` says this tab has open (its project,
 * a shared material), this tab stops writing and `frozen` is told (once) — so an old copy never overwrites a newer one.
 */
export function watchOtherTabs(holds: (key: string) => boolean, frozenNow: (key: string) => void): void {
  mine = holds;
  onFrozen = frozenNow;
}

channel?.addEventListener("message", (event: MessageEvent<{ tab: string; key: string }>) => {
  const { tab, key } = event.data ?? {};
  if (!key || tab === TAB || frozen || !mine(key)) return;
  frozen = true;
  onFrozen?.(key);
});

/** Whether another tab's write has stopped this one's. */
export function isFrozen(): boolean {
  return frozen;
}

/** Keeps a value under its key (structured clone: typed arrays as they are). Whether it was kept (not when another tab's newer write froze this one). */
export async function keep(key: string, value: unknown): Promise<boolean> {
  if (frozen) return false;
  pending++;
  notify();
  try {
    await run("readwrite", (store) => store.put(value, key));
    failed = false;
    if (announcing) channel?.postMessage({ tab: TAB, key });
    return true;
  } catch {
    failed = true;
    return false;
  } finally {
    pending--;
    notify();
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
  if (frozen) return;
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

/** How much the browser holds for this site, and how much it allows (bytes), where it says. */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    return e && typeof e.usage === "number" && typeof e.quota === "number" ? { usage: e.usage, quota: e.quota } : null;
  } catch {
    return null;
  }
}
