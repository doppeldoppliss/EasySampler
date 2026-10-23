// From the settings to the bytes (design.md 5): one WAV, one loopable WAV,
// or a multisample folder — and a batch of those for several cuts, zipped
// with the settings file. Pure apart from the optional progress callback,
// which lets the page yield between renders.

import { encodeWavBytes, type WavInfo } from "../audio/wav";
import type { PreparedSource } from "../engine/engine";
import { exportLengthSec, type Credit, type ExportSettings } from "../instrument/types";
import { applyLoop, LOOP_MIN_HOLD_SEC } from "./loop";
import { dspresetText, planZones, readmeText, sfzText, type Zone } from "./multisample";
import { exportFileName, fileNoteName, renderNote, safeBaseName, type Rendered } from "./render";
import type { CutSettings } from "./settings";
import { zipStore, type ZipEntry } from "./zip";

export interface BuildInput {
  /** Base for the file names: the material's name, or "material_cut" when there are several cuts. */
  baseName: string;
  source: PreparedSource;
  cut: CutSettings;
  settings: ExportSettings;
  credit: Credit;
}

export interface Built {
  /** What to hand over: a WAV, or a zip when there are several files. */
  fileName: string;
  blob: Blob;
  /** The sound to play as a preview (the file, or the centre zone of a multisample). */
  preview: Rendered;
  /** One line for the status: what was written. */
  summary: string;
}

export type Progress = (done: number, total: number) => Promise<void> | void;

export function wavInfo(credit: Credit): WavInfo {
  return {
    INAM: credit.title,
    IART: credit.url,
    ICMT: [credit.timecode, credit.memo].filter(Boolean).join(" / "),
    ISFT: "MADDAW",
  };
}

function creditLine(credit: Credit): string {
  return [credit.title, credit.url, credit.timecode, credit.memo].filter((s) => s && s.trim()).join(" / ");
}

/** The pieces of one cut in its chosen format: the files (relative paths) and a preview. */
export async function buildEntries(input: BuildInput, progress?: Progress): Promise<{ entries: ZipEntry[]; preview: Rendered; summary: string }> {
  const { source, cut, settings, credit } = input;
  const base = safeBaseName(input.baseName);
  const oneShot = cut.params.sustainMode === "none";
  const holdSec = exportLengthSec(settings);
  const info = wavInfo(credit);

  if (settings.format === "single" || oneShot) {
    const rendered = renderNote(source, cut.markers, cut.params, cut.note, holdSec);
    const fileName = exportFileName(base, cut.note, settings, oneShot);
    const data = new Uint8Array(encodeWavBytes(rendered.channels, rendered.sampleRate, info, { unityNote: cut.note }));
    await progress?.(1, 1);
    return { entries: [{ name: fileName, data }], preview: rendered, summary: `${fileName}(${(rendered.channels[0].length / rendered.sampleRate).toFixed(2)} 秒)` };
  }

  if (settings.format === "loop") {
    const rendered = renderNote(source, cut.markers, cut.params, cut.note, Math.max(holdSec, LOOP_MIN_HOLD_SEC));
    const loop = applyLoop(rendered, cut.params);
    const fileName = `${base}_${fileNoteName(cut.note)}_loop.wav`;
    const data = new Uint8Array(encodeWavBytes(rendered.channels, rendered.sampleRate, info, { unityNote: cut.note, loop: loop ?? undefined }));
    await progress?.(1, 1);
    const loopText = loop ? `ループ ${(loop.start / rendered.sampleRate).toFixed(2)}–${(loop.end / rendered.sampleRate).toFixed(2)} 秒` : "ループ範囲が取れなかったのでループなし";
    return { entries: [{ name: fileName, data }], preview: rendered, summary: `${fileName}(${loopText})` };
  }

  // Multisample: a folder with one WAV per zone, the SFZ, the dspreset and a note.
  const plan = planZones(cut.note);
  const zones: Zone[] = [];
  const entries: ZipEntry[] = [];
  const samplesDir = "samples";
  let preview: Rendered | null = null;
  for (let i = 0; i < plan.length; i++) {
    const zone = plan[i];
    const rendered = renderNote(source, cut.markers, { ...cut.params, root: cut.params.root }, zone.note, Math.max(holdSec, LOOP_MIN_HOLD_SEC));
    const loop = applyLoop(rendered, cut.params);
    const fileName = `${base}_${fileNoteName(zone.note)}.wav`;
    entries.push({ name: `${base}/${samplesDir}/${fileName}`, data: new Uint8Array(encodeWavBytes(rendered.channels, rendered.sampleRate, info, { unityNote: zone.note, loop: loop ?? undefined })) });
    zones.push({ ...zone, fileName, loop });
    if (zone.note === cut.note) preview = rendered;
    await progress?.(i + 1, plan.length);
  }
  const meta = { name: base, samplesDir, releaseSec: cut.params.amp.release, credit: creditLine(credit) || undefined };
  const encoder = new TextEncoder();
  entries.push(
    { name: `${base}/${base}.sfz`, data: encoder.encode(sfzText(zones, meta)) },
    { name: `${base}/${base}.dspreset`, data: encoder.encode(dspresetText(zones, meta)) },
    { name: `${base}/README.txt`, data: encoder.encode(readmeText(meta, zones)) },
  );
  return { entries, preview: preview!, summary: `${base}/(WAV ${zones.length} 個、${base}.sfz、${base}.dspreset)` };
}

/** One cut → one file (a WAV, or a zip for a multisample). */
export async function buildOne(input: BuildInput, progress?: Progress): Promise<Built> {
  const { entries, preview, summary } = await buildEntries(input, progress);
  if (entries.length === 1) {
    return { fileName: entries[0].name, blob: new Blob([entries[0].data], { type: "audio/wav" }), preview, summary };
  }
  const base = safeBaseName(input.baseName);
  return { fileName: `${base}.zip`, blob: new Blob([zipStore(entries)], { type: "application/zip" }), preview, summary };
}

/** Every cut → one zip, with the settings file alongside. */
export async function buildBatch(inputs: readonly BuildInput[], settingsJson: string, zipBaseName: string, progress?: Progress): Promise<Built> {
  const entries: ZipEntry[] = [];
  let preview: Rendered | null = null;
  const total = inputs.reduce((n, input) => n + (input.settings.format === "multisample" && input.cut.params.sustainMode !== "none" ? planZones(input.cut.note).length : 1), 0);
  let done = 0;
  for (const input of inputs) {
    const built = await buildEntries(input, async (d, t) => {
      await progress?.(done + d, total);
      if (d === t) done += t;
    });
    entries.push(...built.entries);
    preview ??= built.preview;
  }
  entries.push({ name: "settings.json", data: new TextEncoder().encode(settingsJson) });
  const fileName = `${safeBaseName(zipBaseName)}_cuts.zip`;
  return { fileName, blob: new Blob([zipStore(entries)], { type: "application/zip" }), preview: preview!, summary: `${fileName}(区間 ${inputs.length} 個 + settings.json)` };
}
