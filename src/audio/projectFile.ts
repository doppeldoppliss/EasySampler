// A project as one file (.easysampler): to keep a copy, or to move it between
// a PC and a phone. A stored zip: easysampler.json (the song, and each
// material's name, rate and settings) and every material's samples as raw
// little-endian 32-bit floats, one entry per channel — exactly what the page
// holds, nothing lost to a re-encode.

import { listZip, zipStore, type ZipEntry } from "../export/zip";

export const PROJECT_FILE_EXTENSION = ".easysampler";

export interface ProjectFileMaterial {
  id: string;
  name: string;
  sampleRate: number;
  channels: Float32Array[];
  /** The material's settings as kept (JSON), or null when it has none yet. */
  settings: string | null;
}

export interface ProjectFileData {
  name: string;
  /** The song as kept (tracks, notes, tempo, the materials' list…). */
  project: unknown;
  materials: ProjectFileMaterial[];
}

interface Manifest {
  app: "EasySampler";
  kind: "project";
  version: 1;
  name: string;
  savedAt: string;
  project: unknown;
  materials: { id: string; name: string; sampleRate: number; channels: number; frames: number; settings: string | null }[];
}

const MANIFEST = "easysampler.json";
const audioPath = (id: string, channel: number) => `audio/${id}-${channel}.f32`;

function floatBytes(x: Float32Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(x.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < x.length; i++) view.setFloat32(i * 4, x[i], true);
  return out;
}

function bytesFloat(bytes: Uint8Array, frames: number): Float32Array {
  const out = new Float32Array(frames);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = Math.min(frames, Math.floor(bytes.byteLength / 4));
  for (let i = 0; i < n; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

export function buildProjectFile(data: ProjectFileData): Uint8Array<ArrayBuffer> {
  const manifest: Manifest = {
    app: "EasySampler",
    kind: "project",
    version: 1,
    name: data.name,
    savedAt: new Date().toISOString(),
    project: data.project,
    materials: data.materials.map((m) => ({ id: m.id, name: m.name, sampleRate: m.sampleRate, channels: m.channels.length, frames: m.channels[0]?.length ?? 0, settings: m.settings })),
  };
  const entries: ZipEntry[] = [{ name: MANIFEST, data: new TextEncoder().encode(JSON.stringify(manifest)) }];
  for (const m of data.materials) m.channels.forEach((ch, i) => entries.push({ name: audioPath(m.id, i), data: floatBytes(ch) }));
  return zipStore(entries);
}

/** Reads a project file; throws an Error (in words for the page) when it is not one or something is missing. */
export function parseProjectFile(bytes: Uint8Array): ProjectFileData {
  let files: Map<string, Uint8Array>;
  try {
    files = new Map(listZip(bytes).map((e) => [e.name, e.data]));
  } catch {
    throw new Error("EasySampler のプロジェクトファイルではありません。");
  }
  const raw = files.get(MANIFEST);
  if (!raw) throw new Error("EasySampler のプロジェクトファイルではありません(easysampler.json がありません)。");
  let manifest: Manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(raw)) as Manifest;
  } catch {
    throw new Error("プロジェクトファイルの中身が壊れています。");
  }
  if (manifest.app !== "EasySampler" || manifest.kind !== "project" || !Array.isArray(manifest.materials)) throw new Error("EasySampler のプロジェクトファイルではありません。");
  const materials = manifest.materials.map((m) => {
    const channels: Float32Array[] = [];
    for (let i = 0; i < Math.max(1, m.channels); i++) {
      const data = files.get(audioPath(m.id, i));
      if (!data) throw new Error(`素材「${m.name}」の音声がファイルにありません。`);
      channels.push(bytesFloat(data, m.frames));
    }
    return { id: m.id, name: m.name, sampleRate: m.sampleRate, channels, settings: typeof m.settings === "string" ? m.settings : null };
  });
  return { name: typeof manifest.name === "string" && manifest.name ? manifest.name : "プロジェクト", project: manifest.project, materials };
}
