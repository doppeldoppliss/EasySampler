// tools/eval/listen.ts — "listening" without ears: renders a note the way
// the app writes it, then writes the WAV, a picture of it and a report of
// what a listener would notice (tools/eval/metrics.ts).
//
//   npm run listen -- --material demo --preset synth --note D4 --hold 1
//   npm run listen -- --material path/to/clip.wav --set sustainMode=stretch --set wobble.vibratoCents=25 --out reports/x
//   npm run listen -- --material demo --against reports/x       (prints the differences from an earlier run)
//
// Settings: --preset <id>, then --set key=value (dotted paths into
// InstrumentParams, e.g. tune.mode=scale, fx.chorus.on=true), --note (name
// or MIDI; default: the detected root), --hold seconds, --bpm, --loop (also
// find loop points and judge the seam), --cut from,to (seconds of the
// material to use), --out <dir> (default reports/<timestamp>).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseNoteName, pitchLabel } from "../../src/analysis/pitch";
import { encodeWavBytes, readWavChunks } from "../../src/audio/wav";
import { analyzeMaterial, prepareSource, rootForMarkers } from "../../src/engine/prepare";
import { applyLoop } from "../../src/export/loop";
import { renderNote } from "../../src/export/render";
import { outputLayout } from "../../src/instrument/layout";
import { suggestMarkersWithin } from "../../src/instrument/markers";
import { DEFAULT_PARAMS, PRESETS, type InstrumentParams, type PresetId } from "../../src/instrument/types";
import { demoSyllable } from "../../src/testsignals/synthVoice";
import { report, type Report } from "./metrics";
import { picture } from "./png";

interface Args {
  material: string;
  preset: PresetId | null;
  sets: [string, string][];
  note: string | null;
  hold: number;
  bpm: number;
  loop: boolean;
  cut: [number, number] | null;
  out: string | null;
  against: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { material: "demo", preset: null, sets: [], note: null, hold: 1, bpm: 120, loop: false, cut: null, out: null, against: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? "";
    if (a === "--material") args.material = next();
    else if (a === "--preset") args.preset = next() as PresetId;
    else if (a === "--set") {
      const [k, v] = next().split("=");
      args.sets.push([k, v ?? ""]);
    } else if (a === "--note") args.note = next();
    else if (a === "--hold") args.hold = Number(next());
    else if (a === "--bpm") args.bpm = Number(next());
    else if (a === "--loop") args.loop = true;
    else if (a === "--cut") {
      const [f, t] = next().split(",").map(Number);
      args.cut = [f, t];
    } else if (a === "--out") args.out = next();
    else if (a === "--against") args.against = next();
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

/** PCM WAV → channels (16 / 24 / 32-bit int, 32-bit float). */
function readWav(bytes: ArrayBuffer): { channels: Float32Array[]; sampleRate: number } {
  const info = readWavChunks(bytes);
  const view = new DataView(bytes);
  // Find "fmt " and "data".
  let p = 12;
  let bits = 16;
  let format = 1;
  let dataAt = -1;
  let dataLen = 0;
  while (p + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(view.getUint8(p), view.getUint8(p + 1), view.getUint8(p + 2), view.getUint8(p + 3));
    const len = view.getUint32(p + 4, true);
    if (id === "fmt ") {
      format = view.getUint16(p + 8, true);
      bits = view.getUint16(p + 22, true);
      if (format === 0xfffe) format = view.getUint16(p + 32, true);
    } else if (id === "data") {
      dataAt = p + 8;
      dataLen = len;
      break;
    }
    p += 8 + len + (len & 1);
  }
  if (dataAt < 0) throw new Error("no data chunk");
  const bytesPer = bits / 8;
  const frames = Math.floor(dataLen / bytesPer / info.channels);
  const channels = Array.from({ length: info.channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < info.channels; c++) {
      const at = dataAt + (i * info.channels + c) * bytesPer;
      let v: number;
      if (format === 3 && bits === 32) v = view.getFloat32(at, true);
      else if (bits === 16) v = view.getInt16(at, true) / 32768;
      else if (bits === 24) v = ((view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16)) << 8) / 2147483648;
      else if (bits === 32) v = view.getInt32(at, true) / 2147483648;
      else v = (view.getUint8(at) - 128) / 128;
      channels[c][i] = v;
    }
  }
  return { channels, sampleRate: info.sampleRate };
}

function setPath(target: Record<string, unknown>, path: string, raw: string): void {
  const keys = path.split(".");
  let node: Record<string, unknown> = target;
  for (const k of keys.slice(0, -1)) {
    if (typeof node[k] !== "object" || node[k] === null) node[k] = {};
    node = node[k] as Record<string, unknown>;
  }
  const last = keys[keys.length - 1];
  const current = node[last];
  let value: unknown = raw;
  if (raw === "true") value = true;
  else if (raw === "false") value = false;
  else if (raw !== "" && !Number.isNaN(Number(raw)) && typeof current !== "string") value = Number(raw);
  node[last] = value;
}

function fmt(v: number, digits = 2): string {
  return Number.isFinite(v) ? v.toFixed(digits) : "—";
}

function markdown(r: Report, meta: Record<string, string>): string {
  const lines = [
    `# 聴取レポート`,
    "",
    ...Object.entries(meta).map(([k, v]) => `- ${k}: ${v}`),
    "",
    r.warnings.length ? `## 気になる点\n\n${r.warnings.map((w) => `- ${w}`).join("\n")}` : "## 気になる点\n\n- なし",
    "",
    "## 音程(持続部)",
    "",
    `| 項目 | 値 |\n|---|---|`,
    `| 有声の割合 | ${(r.pitch.voicedShare * 100).toFixed(0)}% |`,
    `| ずれ(中央値) | ${fmt(r.pitch.medianCents, 0)}¢ |`,
    `| ずれの 90 パーセンタイル(絶対値) | ${fmt(r.pitch.p90AbsCents, 0)}¢ |`,
    `| ゆらぎ(標準偏差) | ±${fmt(r.pitch.spreadCents, 0)}¢ |`,
    `| ビブラート(実測) | ${r.pitch.vibratoHz ? `${fmt(r.pitch.vibratoHz, 1)} Hz・±${fmt(r.pitch.vibratoCents, 0)}¢` : "なし"} |`,
    "",
    "## 音量",
    "",
    `| 項目 | 値 |\n|---|---|`,
    `| ピーク / RMS | ${fmt(r.level.peak, 3)} / ${fmt(r.level.rms, 3)} |`,
    `| 立ち上がり(90% まで) | ${(r.level.attackSec * 1000).toFixed(0)} ms |`,
    `| 持続部のふらつき | ±${(r.level.holdUnevenness * 100).toFixed(0)}% |`,
    `| 終わりのフェード | ${(r.level.fadeOutSec * 1000).toFixed(0)} ms |`,
    `| 鳴っている長さ | ${fmt(r.level.soundingSec)} s(ファイル ${fmt(r.durationSec)} s) |`,
    `| DC オフセット | ${fmt(r.level.dcOffset, 4)} |`,
    "",
    "## 音色",
    "",
    `| 項目 | 値 |\n|---|---|`,
    `| 重心(明るさ) | ${fmt(r.tone.centroidHz, 0)} Hz(頭 ${fmt(r.tone.centroidStartHz, 0)} → 尻 ${fmt(r.tone.centroidEndHz, 0)}) |`,
    `| 2–5 kHz の割合 | ${(r.tone.harshBand * 100).toFixed(0)}% |`,
    `| 8 kHz 以上の割合 | ${(r.tone.hissBand * 100).toFixed(1)}% |`,
    `| ノイズ感(平坦度) | ${fmt(r.tone.flatness, 3)} |`,
    "",
    "## 不快さの指標",
    "",
    `| 項目 | 値 |\n|---|---|`,
    `| クリック | ${r.artefacts.clicks.count} |`,
    `| クリッピング | ${r.artefacts.clippedSamples} サンプル |`,
    `| ざらつき(20–200 Hz の振幅変調) | ${fmt(r.artefacts.amRoughness.hz, 0)} Hz・${(r.artefacts.amRoughness.depth * 100).toFixed(0)}% |`,
    `| ゆっくりした揺れ(2–20 Hz) | ${fmt(r.artefacts.amSlow.hz, 1)} Hz・${(r.artefacts.amSlow.depth * 100).toFixed(0)}% |`,
    `| 途切れ | ${r.artefacts.dropouts.count}(最長 ${r.artefacts.dropouts.longestMs.toFixed(0)} ms) |`,
    ...(r.seam ? [`| ループの継ぎ目 | 波形の段差 ${fmt(r.seam.stepRelative)}・音量の段差 ${fmt(r.seam.levelJumpRelative)} |`] : []),
    "",
  ];
  return lines.join("\n");
}

function diff(a: Report, b: Report): string {
  const rows: [string, number, number][] = [
    ["音程ずれ(中央値 ¢)", a.pitch.medianCents, b.pitch.medianCents],
    ["音程ゆらぎ(±¢)", a.pitch.spreadCents, b.pitch.spreadCents],
    ["ビブラート(¢)", a.pitch.vibratoCents, b.pitch.vibratoCents],
    ["持続部のふらつき", a.level.holdUnevenness, b.level.holdUnevenness],
    ["重心(Hz)", a.tone.centroidHz, b.tone.centroidHz],
    ["2–5 kHz", a.tone.harshBand, b.tone.harshBand],
    ["8 kHz 以上", a.tone.hissBand, b.tone.hissBand],
    ["平坦度", a.tone.flatness, b.tone.flatness],
    ["クリック", a.artefacts.clicks.count, b.artefacts.clicks.count],
    ["ざらつき深さ", a.artefacts.amRoughness.depth, b.artefacts.amRoughness.depth],
    ["途切れ", a.artefacts.dropouts.count, b.artefacts.dropouts.count],
  ];
  return ["| 項目 | 前 | 今 | 差 |", "|---|---|---|---|", ...rows.map(([k, x, y]) => `| ${k} | ${fmt(x, 3)} | ${fmt(y, 3)} | ${fmt(y - x, 3)} |`)].join("\n");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  // The material.
  let channels: Float32Array[];
  let sampleRate: number;
  let name: string;
  if (args.material === "demo") {
    sampleRate = 44100;
    channels = [demoSyllable(sampleRate)];
    name = "デモ素材";
  } else {
    const bytes = readFileSync(resolve(args.material));
    const wav = readWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    channels = wav.channels;
    sampleRate = wav.sampleRate;
    name = basename(args.material);
  }
  const analysis = analyzeMaterial(channels, sampleRate);
  const source = prepareSource(channels, analysis, sampleRate);
  const markers = args.cut ? suggestMarkersWithin(analysis.track, args.cut[0], args.cut[1]) : analysis.markers;
  const root = rootForMarkers(analysis.track, markers) ?? analysis.root;
  // The settings.
  let params: InstrumentParams = structuredClone(DEFAULT_PARAMS);
  params.root = root?.midi ?? 60;
  if (args.preset) {
    const preset = PRESETS.find((p) => p.id === args.preset);
    if (!preset) throw new Error(`unknown preset: ${args.preset} (${PRESETS.map((p) => p.id).join(", ")})`);
    params = preset.apply(params);
  }
  for (const [k, v] of args.sets) setPath(params as unknown as Record<string, unknown>, k, v);
  const note = args.note ? (parseNoteName(args.note) ?? Number(args.note)) : Math.round(params.root);
  if (!Number.isFinite(note)) throw new Error(`bad note: ${args.note}`);
  // Render as the app does.
  const rendered = renderNote(source, markers, params, note, args.hold, args.bpm);
  const loop = args.loop ? applyLoop(rendered, params) : null;
  const layout = outputLayout(markers, params, args.hold);
  const sustainFrom = rendered.headSec;
  const sustainTo = params.sustainMode === "none" ? rendered.headSec + layout.sustainSec : rendered.holdEndSec;
  const r = report(rendered.channels, rendered.sampleRate, {
    targetMidi: note,
    sustainFromSec: sustainFrom + 0.02,
    sustainToSec: sustainTo,
    loop,
    vibratoExpected: params.wobble.vibratoCents > 0 || params.wobble.tremoloDepth > 0,
  });
  // Out.
  const outDir = resolve(args.out ?? join("reports", new Date().toISOString().replace(/[:.]/g, "-")));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "out.wav"), new Uint8Array(encodeWavBytes(rendered.channels, rendered.sampleRate)));
  const marks = [{ sec: rendered.headSec, label: "head" }, { sec: rendered.holdEndSec, label: "hold" }];
  writeFileSync(join(outDir, "spectrogram.png"), picture(rendered.channels.length > 1 ? Float32Array.from(rendered.channels[0], (v, i) => (v + rendered.channels[1][i]) / 2) : rendered.channels[0], rendered.sampleRate, { targetMidi: note, marks }));
  const meta: Record<string, string> = {
    素材: name,
    判定: root ? pitchLabel(root.midi) : "—",
    音名: pitchLabel(note),
    長さ: `${args.hold} s @ ${args.bpm} BPM`,
    プリセット: args.preset ?? "(既定)",
    設定: args.sets.length ? args.sets.map(([k, v]) => `${k}=${v}`).join(", ") : "なし",
    伸ばし方: params.sustainMode,
    出力: outDir,
  };
  const md = markdown(r, meta);
  writeFileSync(join(outDir, "report.md"), md);
  writeFileSync(join(outDir, "metrics.json"), JSON.stringify({ meta, params, note, hold: args.hold, report: r }, null, 2));
  process.stdout.write(md + "\n");
  if (args.against) {
    const previous = JSON.parse(readFileSync(join(resolve(args.against), "metrics.json"), "utf8")) as { report: Report };
    process.stdout.write(`\n## 前回(${args.against})との差\n\n${diff(previous.report, r)}\n`);
  }
}

main();
