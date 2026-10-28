// Several projects in the browser (design.md 13): an index of them and which
// one is open. Each project's song is kept under project:<id>; its materials'
// samples and settings under audio:<materialId> / settings:<materialId> (a
// material belongs to one project: a copy of a project copies its materials
// under new ids, so removing one never takes another's sound with it).
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
/** Where the single project of earlier versions was kept. */
const LEGACY = "project";

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

/** Reads the index (call once at start). A first visit, or the single project of an earlier version, becomes the first entry. */
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
    const legacy = await kept(LEGACY);
    if (legacy !== undefined) {
      await keep(projectKey(entry.id), legacy);
      await forget(LEGACY);
    }
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

/** The recordings a stored project owns: its materials, and its drum kit's sounds. */
function materialIds(data: unknown): string[] {
  const d = data as { materials?: unknown; kit?: { slots?: unknown } } | undefined;
  const materials = Array.isArray(d?.materials) ? d.materials.map((m) => (m as { id?: unknown })?.id) : [];
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

/** A copy of a project, its materials copied under new ids. */
export async function duplicateProject(id: string, name: string): Promise<ProjectEntry | null> {
  const data = await kept(projectKey(id));
  if (data === undefined) return null;
  const map = new Map(materialIds(data).map((m) => [m, newMaterialId()]));
  for (const [from, to] of map) {
    const audio = await kept(`audio:${from}`);
    if (audio !== undefined) await keep(`audio:${to}`, audio);
    const settings = await kept(`settings:${from}`);
    if (settings !== undefined) await keep(`settings:${to}`, settings);
  }
  return createProject(name, remapMaterials(data, map));
}

/** Removes a project and its materials. Removing the open one opens the most recent other (or a new one): the caller reloads. */
export async function removeProject(id: string): Promise<void> {
  const data = await kept(projectKey(id));
  for (const m of materialIds(data)) {
    await forget(`audio:${m}`);
    await forget(`settings:${m}`);
  }
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
