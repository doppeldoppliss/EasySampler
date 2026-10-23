// A multisample instrument (design.md 5, マルチサンプル音源): one WAV per zone
// across the range, each rendered by PSOLA at its own pitch (so nothing is
// cut short up high or smeared down low), with loop points, and two
// definition files that map them to the keyboard — SFZ (REAPER, sforzando,
// most desktop samplers) and Decent Sampler's .dspreset (free, also on
// iPhone / iPad). Everything goes into one zip folder.

import type { Loop } from "./loop";

export interface Zone {
  /** The note this sample was rendered at, and plays at its own pitch. */
  note: number;
  /** Keys that use this sample. */
  lowKey: number;
  highKey: number;
  fileName: string;
  loop: Loop | null;
}

/** Zones every `step` semitones from `center − below` to `center + above`, with the keys split between neighbours. */
export function planZones(center: number, below = 12, above = 12, step = 3): { note: number; lowKey: number; highKey: number }[] {
  const notes: number[] = [];
  for (let n = center - below; n <= center + above; n += step) notes.push(n);
  if (!notes.includes(center)) notes.push(center);
  notes.sort((a, b) => a - b);
  return notes.map((note, i) => ({
    note,
    lowKey: i === 0 ? 0 : Math.floor((notes[i - 1] + note) / 2) + 1,
    highKey: i === notes.length - 1 ? 127 : Math.floor((note + notes[i + 1]) / 2),
  }));
}

export interface MultisampleMeta {
  /** Instrument name (also the folder and file base). */
  name: string;
  /** Sample folder inside the instrument folder. */
  samplesDir: string;
  releaseSec: number;
  credit?: string;
}

/** The SFZ text. Paths are relative to the .sfz file. */
export function sfzText(zones: readonly Zone[], meta: MultisampleMeta): string {
  const lines = [
    `// ${meta.name} — made with MADDAW (a material synth-ified in the browser)`,
    meta.credit ? `// source: ${meta.credit.replace(/\r?\n/g, " ")}` : "",
    "",
    "<control>",
    `default_path=${meta.samplesDir}/`,
    "",
    "<global>",
    `ampeg_release=${meta.releaseSec.toFixed(3)}`,
    "",
    "<group>",
  ].filter((line) => line !== null);
  for (const zone of zones) {
    const loop = zone.loop ? ` loop_mode=loop_continuous loop_start=${zone.loop.start} loop_end=${zone.loop.end - 1}` : " loop_mode=no_loop";
    lines.push(`<region> sample=${zone.fileName} pitch_keycenter=${zone.note} lokey=${zone.lowKey} hikey=${zone.highKey}${loop}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The Decent Sampler preset (XML). Paths are relative to the .dspreset file. */
export function dspresetText(zones: readonly Zone[], meta: MultisampleMeta): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const samples = zones
    .map((zone) => {
      const loop = zone.loop
        ? ` loopEnabled="true" loopStart="${zone.loop.start}" loopEnd="${zone.loop.end - 1}" loopCrossfade="${zone.loop.crossfade}"`
        : ` loopEnabled="false"`;
      return `      <sample path="${esc(`${meta.samplesDir}/${zone.fileName}`)}" rootNote="${zone.note}" loNote="${zone.lowKey}" hiNote="${zone.highKey}"${loop} />`;
    })
    .join("\n");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!-- ${esc(meta.name)} — made with MADDAW${meta.credit ? ` / source: ${esc(meta.credit.replace(/\r?\n/g, " ").replace(/--/g, "-"))}` : ""} -->`,
    `<DecentSampler minVersion="1.0.0">`,
    `  <ui width="812" height="375" bgColor="FF1D1B26">`,
    `    <tab name="main">`,
    `      <label x="20" y="20" width="772" height="40" text="${esc(meta.name)}" textSize="24" textColor="FFEBE8F4" />`,
    `      <label x="20" y="60" width="772" height="24" text="MADDAW" textSize="14" textColor="FF9A96AE" />`,
    `    </tab>`,
    `  </ui>`,
    `  <groups attack="0.005" release="${meta.releaseSec.toFixed(3)}">`,
    `    <group>`,
    samples,
    `    </group>`,
    `  </groups>`,
    `</DecentSampler>`,
    "",
  ].join("\n");
}

/** A short note for whoever opens the zip. */
export function readmeText(meta: MultisampleMeta, zones: readonly Zone[]): string {
  return [
    `${meta.name} — MADDAW で作ったマルチサンプル音源`,
    "",
    `${meta.samplesDir}/ に ${zones.length} 個の WAV(${zones.map((z) => z.fileName).join(", ")})、`,
    `${meta.name}.sfz(REAPER の ReaSamplOmatic5000 の代わりに sforzando など SFZ 対応サンプラーで)、`,
    `${meta.name}.dspreset(Decent Sampler。Windows / Mac / iPhone / iPad、無料)が入っています。`,
    "",
    "iPhone / iPad: この zip を「ファイル」App で展開し、.dspreset をタップすると Decent Sampler で開きます。",
    "PC: Decent Sampler の File → Load Preset、または sforzando に .sfz をドラッグします。",
    "",
    meta.credit ? `出典: ${meta.credit}` : "",
    "",
  ].join("\n");
}
