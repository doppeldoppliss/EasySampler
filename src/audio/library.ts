// The material library (design.md 19): the materials, with their analysis
// settings and サンプリング済音源, shared by every song in the browser. A song
// (project:<id>) lists the ones it uses; their samples and settings are kept
// once, under audio:<id> / settings:<id>, so an edit made in one song is heard
// in every song that uses the material. What a song owns stays with it: its
// drum kit's recordings and its long recordings (原曲・伴奏).

import { projectKey, projectList, type ProjectEntry } from "./projects";
import { forget, keep, kept } from "./store";

export interface LibraryEntry {
  id: string;
  name: string;
  sampleRate: number;
  frames: number;
  /** The built-in piano: the one every song shares (a new song starts on it). */
  builtin?: "piano";
  addedAt: number;
}

const INDEX = "materialLibrary";

let entries: LibraryEntry[] = [];

export function libraryList(): readonly LibraryEntry[] {
  return [...entries].sort((a, b) => b.addedAt - a.addedAt);
}

export function libraryEntry(id: string): LibraryEntry | undefined {
  return entries.find((e) => e.id === id);
}

export function inLibrary(id: string): boolean {
  return entries.some((e) => e.id === id);
}

/** The built-in piano, if one is in the library. */
export function builtinPiano(): LibraryEntry | undefined {
  return entries.find((e) => e.builtin === "piano");
}

/** A library material that looks like the same recording (name, length, rate). */
export function findSame(name: string, frames: number, sampleRate: number): LibraryEntry | undefined {
  return entries.find((e) => e.name === name && e.frames === frames && e.sampleRate === sampleRate);
}

type StoredAudio = { name: string; sampleRate: number; channels: Float32Array[] };
type StoredSong = { materials?: { id?: unknown; long?: unknown }[] };

/**
 * Reads the library (call once at start, after the projects). The first time, it is made from the materials every
 * song has (each kept as it is, copies made by duplicating a song included: their settings may differ); the
 * piano of the song opened last becomes the shared built-in one.
 */
export async function openLibrary(pianoName: string): Promise<void> {
  const stored = await kept(INDEX);
  if (Array.isArray(stored)) {
    entries = stored.filter((e): e is LibraryEntry => !!e && typeof e === "object" && typeof (e as LibraryEntry).id === "string");
    return;
  }
  entries = [];
  // (Most recent song first: its piano is the one kept as built-in.)
  for (const project of projectList()) {
    const song = (await kept(projectKey(project.id))) as StoredSong | undefined;
    for (const m of song?.materials ?? []) {
      if (typeof m?.id !== "string" || m.long === true || inLibrary(m.id)) continue;
      const audio = (await kept(`audio:${m.id}`)) as StoredAudio | undefined;
      if (!audio?.channels?.length) continue;
      const piano = audio.name === pianoName && !builtinPiano();
      entries.push({ id: m.id, name: audio.name, sampleRate: audio.sampleRate, frames: audio.channels[0].length, addedAt: project.updatedAt, ...(piano ? { builtin: "piano" as const } : {}) });
    }
  }
  await keep(INDEX, entries);
}

export async function addToLibrary(entry: Omit<LibraryEntry, "addedAt">): Promise<void> {
  if (inLibrary(entry.id)) return;
  entries.push({ ...entry, addedAt: Date.now() });
  await keep(INDEX, entries);
}

/** Removes a material from the library, its samples and settings with it (songs that list it drop it when opened). */
export async function removeFromLibrary(id: string): Promise<void> {
  entries = entries.filter((e) => e.id !== id);
  await keep(INDEX, entries);
  await forget(`audio:${id}`);
  await forget(`settings:${id}`);
}

/** The songs that list a material, read from the store (the open song as last saved: pass its live list to use that). */
export async function songsUsing(id: string, open?: { id: string; materials: readonly { id: string }[] }): Promise<ProjectEntry[]> {
  const out: ProjectEntry[] = [];
  for (const project of projectList()) {
    const materials = open && project.id === open.id ? open.materials : (((await kept(projectKey(project.id))) as StoredSong | undefined)?.materials ?? []);
    if (materials.some((m) => m?.id === id)) out.push(project);
  }
  return out;
}

/** A copy of a library material under a new id and name (for one song only, 「この曲用に分ける」). */
export async function copyInLibrary(id: string, newId: string, name: string): Promise<boolean> {
  const audio = (await kept(`audio:${id}`)) as StoredAudio | undefined;
  const from = libraryEntry(id);
  if (!audio || !from) return false;
  await keep(`audio:${newId}`, { ...audio, name });
  const settings = await kept(`settings:${id}`);
  if (settings !== undefined) await keep(`settings:${newId}`, settings);
  await addToLibrary({ id: newId, name, sampleRate: from.sampleRate, frames: from.frames });
  return true;
}
