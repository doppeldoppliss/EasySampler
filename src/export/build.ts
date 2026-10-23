// From the settings to the bytes (design.md 5): one WAV, one loopable WAV,
// or a multisample folder — and a batch of those for several cuts, zipped
// with the settings file. Pure apart from the optional progress callback,
// which lets the page yield between renders.

import { encodeWavBytes, type WavInfo } from "../audio/wav";
import type { PreparedSource } from "../engine/engine";
import { exportLengthSec, type Credit, type ExportSettings } from "../instrument/types";
import { applyLoop, LOOP_MIN_HOLD_SEC } from "./loop";
import { dspresetText, planKit, planZones, readmeText, sfzText, type Zone } from "./multisample";
import { exportFileName, fileNoteName, renderNote, safeBaseName, type Rendered } from "./render";
import type { CutSettings } from "./settings";
import { buildWavetable, FRAME_SIZE, type Wavetable } from "./wavetable";
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
    const rendered = renderNote(source, cut.markers, cut.params, cut.note, holdSec, settings.bpm);
    const fileName = exportFileName(base, cut.note, settings, oneShot);
    const data = new Uint8Array(encodeWavBytes(rendered.channels, rendered.sampleRate, info, { unityNote: cut.note }));
    await progress?.(1, 1);
    return { entries: [{ name: fileName, data }], preview: rendered, summary: `${fileName}(${(rendered.channels[0].length / rendered.sampleRate).toFixed(2)} 秒)` };
  }

  if (settings.format === "wavetable") {
    const table = buildWavetable(source, cut.markers);
    if (!table) throw new Error("ウェーブテーブルを作れませんでした: 持続区間に有声の周期がありません");
    const fileName = `${base}_wavetable.wav`;
    const data = new Uint8Array(encodeWavBytes([table.samples], source.sampleRate, { ...info, ICMT: [info.ICMT, `wavetable ${FRAME_SIZE} samples/frame, ${table.frames} frames`].filter(Boolean).join(" / ") }));
    // The preview plays the frames at the note's pitch: a few periods each, in order.
    const preview = previewWavetable(table, cut.note, source.sampleRate);
    await progress?.(1, 1);
    return { entries: [{ name: fileName, data }], preview, summary: `${fileName}(${table.frames} フレーム × ${FRAME_SIZE} サンプル。Vital の Import as Wavetable で読み込みます)` };
  }

  if (settings.format === "loop") {
    const rendered = renderNote(source, cut.markers, cut.params, cut.note, Math.max(holdSec, LOOP_MIN_HOLD_SEC), settings.bpm);
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
    const rendered = renderNote(source, cut.markers, { ...cut.params, root: cut.params.root }, zone.note, Math.max(holdSec, LOOP_MIN_HOLD_SEC), settings.bpm);
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

/** How a wavetable sounds: every frame played as `cyclesPerFrame` periods at the note's pitch, in order (about 2 s). */
function previewWavetable(table: Wavetable, note: number, sampleRate: number): Rendered {
  const period = sampleRate / (440 * 2 ** ((note - 69) / 12));
  const targetSec = 2;
  const cyclesPerFrame = Math.max(1, Math.round((targetSec * sampleRate) / period / table.frames));
  const total = Math.round(table.frames * cyclesPerFrame * period);
  const out = new Float32Array(total);
  let phase = 0;
  for (let n = 0; n < total; n++) {
    const frame = Math.min(table.frames - 1, Math.floor(n / (cyclesPerFrame * period)));
    const at = frame * FRAME_SIZE + Math.floor(phase * FRAME_SIZE);
    out[n] = table.samples[at] * 0.5;
    phase += 1 / period;
    if (phase >= 1) phase -= 1;
  }
  const fade = Math.round(0.01 * sampleRate);
  for (let i = 0; i < fade; i++) {
    out[i] *= i / fade;
    out[total - 1 - i] *= i / fade;
  }
  return { channels: [out], sampleRate, headSec: 0, holdEndSec: total / sampleRate };
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

/** A kit (design.md 5, ワンショット一括): every sample on its own key, as rendered by its own settings, in one zip. */
export async function buildKit(inputs: readonly BuildInput[], kitName: string, firstKey: number, progress?: Progress): Promise<Built> {
  const base = safeBaseName(kitName);
  const samplesDir = "samples";
  const plan = planKit(inputs.length, firstKey);
  const zones: Zone[] = [];
  const entries: ZipEntry[] = [];
  let preview: Rendered | null = null;
  let release = 0;
  const used = new Set<string>();
  for (let i = 0; i < inputs.length; i++) {
    const { source, cut, settings, credit } = inputs[i];
    const oneShot = cut.params.sustainMode === "none";
    const rendered = renderNote(source, cut.markers, cut.params, cut.note, exportLengthSec(settings), settings.bpm);
    let fileName = `${safeBaseName(inputs[i].baseName)}.wav`;
    for (let n = 2; used.has(fileName); n++) fileName = `${safeBaseName(inputs[i].baseName)}_${n}.wav`;
    used.add(fileName);
    entries.push({ name: `${base}/${samplesDir}/${fileName}`, data: new Uint8Array(encodeWavBytes(rendered.channels, rendered.sampleRate, wavInfo(credit), { unityNote: plan[i].note })) });
    zones.push({ ...plan[i], fileName, loop: null, oneShot });
    release = Math.max(release, cut.params.amp.release);
    preview ??= rendered;
    await progress?.(i + 1, inputs.length);
  }
  // A kit is mostly hits: a long enough release that a short tap still plays the hit out in players that cut at note-off.
  const meta = { name: base, samplesDir, releaseSec: Math.max(release, 1.5) };
  const encoder = new TextEncoder();
  entries.push(
    { name: `${base}/${base}.sfz`, data: encoder.encode(sfzText(zones, meta)) },
    { name: `${base}/${base}.dspreset`, data: encoder.encode(dspresetText(zones, meta)) },
    { name: `${base}/README.txt`, data: encoder.encode(readmeText(meta, zones, "kit")) },
  );
  return {
    fileName: `${base}.zip`,
    blob: new Blob([zipStore(entries)], { type: "application/zip" }),
    preview: preview!,
    summary: `${base}/(${zones.length} 個を ${fileNoteName(plan[0].note)} から 1 鍵ずつ。${base}.sfz、${base}.dspreset)`,
  };
}

/** Every cut → one zip, with the settings file alongside when given. */
export async function buildBatch(inputs: readonly BuildInput[], settingsJson: string | null, zipBaseName: string, progress?: Progress): Promise<Built> {
  const entries: ZipEntry[] = [];
  let preview: Rendered | null = null;
  const total = inputs.reduce((n, input) => n + (input.settings.format === "multisample" && input.cut.params.sustainMode !== "none" ? planZones(input.cut.note).length : 1), 0);
  // (a one-shot ignores the format; a wavetable is one file like a single WAV)
  let done = 0;
  for (const input of inputs) {
    const built = await buildEntries(input, async (d, t) => {
      await progress?.(done + d, total);
      if (d === t) done += t;
    });
    entries.push(...built.entries);
    preview ??= built.preview;
  }
  if (settingsJson !== null) entries.push({ name: "settings.json", data: new TextEncoder().encode(settingsJson) });
  const fileName = `${safeBaseName(zipBaseName)}_cuts.zip`;
  return { fileName, blob: new Blob([zipStore(entries)], { type: "application/zip" }), preview: preview!, summary: `${fileName}(${inputs.length} 個${settingsJson !== null ? " + settings.json" : ""})` };
}
