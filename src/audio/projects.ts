// Several projects (songs) in the browser (design.md 13): an index of them and
// which one is open. Each project's song is kept under project:<id>. The
// materials it plays are in the shared library (library.ts, design.md 19) and
// stay there when a song is copied or removed; what a song owns — its drum
// kit's recordings and its long recordings (原曲・伴奏), under audio:<id> — is
// copied with it under new ids and removed with it.
// Switching projects is done by saving, choosing, and reloading the page.

import { forget, keep, kept } from "./store";

export interface ProjectEntry {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

const INDEX = "projects";
const CURRENT = "currentProject";

export const projectKey = (id: string) => `project:${id}`;

const newId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

let entries: ProjectEntry[] = [];
let currentId = "";

export function projectList(): readonly ProjectEntry[] {
  return [...entries].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function currentProject(): ProjectEntry {
  return entries.find((e) => e.id === currentId)!;
}

async function saveIndex(): Promise<void> {
  await keep(INDEX, entries);
  await keep(CURRENT, currentId);
}

/** Reads the index (call once at start). A first visit makes the first entry. */
export async function openProjects(): Promise<ProjectEntry> {
  const stored = await kept(INDEX);
  entries = Array.isArray(stored)
    ? stored.filter((e): e is ProjectEntry => !!e && typeof e === "object" && typeof (e as ProjectEntry).id === "string").map((e) => ({ ...e, name: e.name || "プロジェクト" }))
    : [];
  const current = await kept(CURRENT);
  currentId = typeof current === "string" && entries.some((e) => e.id === current) ? current : (projectList()[0]?.id ?? "");
  if (!currentId) {
    const now = Date.now();
    const entry = { id: newId(), name: "プロジェクト 1", createdAt: now, updatedAt: now };
    entries.push(entry);
    currentId = entry.id;
  }
  await saveIndex();
  return currentProject();
}

/** The open project was saved just now. */
export function touchProject(): void {
  const entry = entries.find((e) => e.id === currentId);
  if (!entry) return;
  entry.updatedAt = Date.now();
  void keep(INDEX, entries);
}

export async function renameProject(id: string, name: string): Promise<void> {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return;
  entry.name = name.trim() || entry.name;
  await saveIndex();
}

/** A new, empty project (opened by the page's reload). */
export async function createProject(name: string, data?: unknown): Promise<ProjectEntry> {
  const now = Date.now();
  const entry = { id: newId(), name: name.trim() || "プロジェクト", createdAt: now, updatedAt: now };
  entries.push(entry);
  if (data !== undefined) await keep(projectKey(entry.id), data);
  await saveIndex();
  return entry;
}

/** Which project the page opens next (the caller reloads). */
export async function chooseProject(id: string): Promise<void> {
  if (!entries.some((e) => e.id === id)) return;
  currentId = id;
  await saveIndex();
}

/** The recordings a stored project owns: its long recordings (原曲・伴奏), and its drum kit's sounds (not the library's materials). */
function ownedIds(data: unknown): string[] {
  const d = data as { materials?: unknown; kit?: { slots?: unknown } } | undefined;
  const materials = Array.isArray(d?.materials) ? d.materials.filter((m) => (m as { long?: unknown })?.long === true).map((m) => (m as { id?: unknown })?.id) : [];
  const kit = Array.isArray(d?.kit?.slots) ? d.kit.slots.map((s) => (s as { sample?: unknown })?.sample) : [];
  return [...new Set([...materials, ...kit].filter((id): id is string => typeof id === "string"))];
}

/**
 * A stored project with its materials under new ids: the list, the one being
 * edited, and every track / drum row that plays one of their cuts.
 */
export function remapMaterials(data: unknown, map: ReadonlyMap<string, string>): unknown {
  const copy = structuredClone(data) as Record<string, unknown>;
  const moved = (instrument: unknown) => {
    if (typeof instrument !== "string" || !instrument.includes("/")) return instrument;
    const [material, cut] = instrument.split("/");
    return map.has(material) ? `${map.get(material)}/${cut}` : instrument;
  };
  if (Array.isArray(copy.materials)) for (const m of copy.materials as Record<string, unknown>[]) if (typeof m.id === "string" && map.has(m.id)) m.id = map.get(m.id);
  if (typeof copy.editing === "string" && map.has(copy.editing)) copy.editing = map.get(copy.editing);
  const kit = copy.kit as { slots?: Record<string, unknown>[] } | undefined;
  if (Array.isArray(kit?.slots)) for (const s of kit.slots) if (typeof s.sample === "string" && map.has(s.sample)) s.sample = map.get(s.sample);
  if (Array.isArray(copy.tracks)) {
    for (const t of copy.tracks as Record<string, unknown>[]) {
      t.instrument = moved(t.instrument);
      if (Array.isArray(t.pads)) for (const p of t.pads as Record<string, unknown>[]) p.instrument = moved(p.instrument);
    }
  }
  return copy;
}

export const newMaterialId = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** A copy of a project: what it owns copied under new ids, the library's materials shared. */
export async function duplicateProject(id: string, name: string): Promise<ProjectEntry | null> {
  const data = await kept(projectKey(id));
  if (data === undefined) return null;
  const map = new Map(ownedIds(data).map((m) => [m, newMaterialId()]));
  for (const [from, to] of map) {
    const audio = await kept(`audio:${from}`);
    if (audio !== undefined) await keep(`audio:${to}`, audio);
  }
  return createProject(name, remapMaterials(data, map));
}

/** Removes a project and what it owns (the library's materials stay). Removing the open one opens the most recent other (or a new one): the caller reloads. */
export async function removeProject(id: string): Promise<void> {
  const data = await kept(projectKey(id));
  for (const m of ownedIds(data)) await forget(`audio:${m}`);
  await forget(projectKey(id));
  entries = entries.filter((e) => e.id !== id);
  if (currentId === id) {
    currentId = projectList()[0]?.id ?? "";
    if (!currentId) {
      const now = Date.now();
      const entry = { id: newId(), name: "プロジェクト 1", createdAt: now, updatedAt: now };
      entries.push(entry);
      currentId = entry.id;
    }
  }
  await saveIndex();
}
