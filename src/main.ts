// MADDAW — Phase 1: a single-note WAV out of the browser (design.md 3, 7).
//
// Load a material (or the demo): it is analysed (pitch curve, pitch marks,
// root pitch to the cent, suggested synthesis markers) and playable at once.
// Cut it with the range handles, pick the note and the length, try it on the
// keyboard, then share / save the WAV for the DAW. One column, phone first.

import { pitchLabel } from "./analysis/pitch";
import { EngineClient } from "./audio/engineClient";
import { encodeWav } from "./audio/wav";
import { Engine, type PreparedSource } from "./engine/engine";
import { mixToMono, prepareSource, rootForMarkers, type MaterialAnalysis } from "./engine/prepare";
import { canShareFiles, downloadFile, shareFile } from "./export/deliver";
import { exportFileName, renderNote, type Rendered } from "./export/render";
import {
  DEFAULT_EXPORT,
  DEFAULT_PARAMS,
  PRESETS,
  destinationRate,
  exportLengthSec,
  type Credit,
  type Destination,
  type ExportSettings,
  type InstrumentParams,
  type Markers,
  type PresetId,
} from "./instrument/types";
import { demoSyllable } from "./testsignals/synthVoice";
import { el } from "./ui/dom";
import { OnScreenKeyboard, PcKeyboard } from "./ui/keyboard";
import { MaterialEditor } from "./ui/materialEditor";

const MAX_MATERIAL_SEC = 60;
const DEMO_RATE = 44100;
const GUIDE_KEY = "maddaw.guide.v2";
const SMALL_SCREEN = window.matchMedia("(max-width: 600px)").matches;

// ---------------------------------------------------------------- state

interface Material {
  name: string;
  channels: Float32Array[];
  sampleRate: number;
  mono: Float32Array;
  analysis: MaterialAnalysis;
  /** For the live engine (at the AudioContext's rate). */
  source: PreparedSource;
  /** For the file, by sample rate (the material's own, or the destination's). */
  exportSources: Map<number, PreparedSource>;
  /** The root as detected for the current markers (for "back to detected"). */
  detectedRoot: number | null;
}

let material: Material | null = null;
let markers: Markers | null = null;
let params: InstrumentParams = structuredClone(DEFAULT_PARAMS);
let presetId: PresetId | "" = "synth";
let exportSettings: ExportSettings = structuredClone(DEFAULT_EXPORT);
const credit: Credit = { title: "", url: "", timecode: "", memo: "" };
/** The last file rendered, keyed by everything it depends on. */
let rendered: { key: string; result: Rendered; fileName: string } | null = null;

const client = new EngineClient();
const editor = new MaterialEditor();
const sink = {
  noteOn: (note: number, velocity: number) => {
    client.unlock();
    client.noteOn(note, velocity);
  },
  noteOff: (note: number) => client.noteOff(note),
};
const piano = new OnScreenKeyboard(sink, 48, SMALL_SCREEN ? 72 : 84);
const pcKeys = new PcKeyboard(sink);

// ---------------------------------------------------------------- audio start

/** Every first gesture (tap, key) may be the one allowed to start the sound. */
function onGesture(): void {
  const wasStarted = client.started;
  client.unlock();
  if (!wasStarted) void matchEngineRate();
}
window.addEventListener("pointerdown", onGesture, { capture: true });
window.addEventListener("keydown", onGesture, { capture: true });
// (iOS "interrupts" the audio when another app takes over; unlock() on the next gesture resumes it.)

/** The material was prepared before the audio started (at a guessed rate): redo it at the real one. */
async function matchEngineRate(): Promise<void> {
  if (!material || client.sourceMatchesRate()) return;
  const { source } = await client.analyze(material.channels, material.sampleRate);
  material.source = source;
  material.exportSources.set(source.sampleRate, source);
  client.setSource(source);
  client.resendInstrument();
}

// ---------------------------------------------------------------- building blocks

const controlsRefreshers: (() => void)[] = [];

function update(change: (p: InstrumentParams) => void, keepPreset = false): void {
  const next = structuredClone(params);
  change(next);
  params = next;
  if (!keepPreset) {
    presetId = "";
    presetSelect.value = "";
  }
  sendInstrument();
}

function updateExport(change: (s: ExportSettings) => void): void {
  const next = structuredClone(exportSettings);
  change(next);
  exportSettings = next;
  refreshExport();
}

function range(label: string, min: number, max: number, step: number, get: () => number, set: (p: InstrumentParams, v: number) => void, format: (v: number) => string): HTMLElement {
  const input = el("input", { type: "range", min: String(min), max: String(max), step: String(step) });
  const value = el("output", { className: "num" });
  const refresh = () => {
    input.value = String(get());
    value.textContent = format(get());
  };
  input.addEventListener("input", () => {
    update((p) => set(p, Number(input.value)));
    value.textContent = format(Number(input.value));
  });
  controlsRefreshers.push(refresh);
  return el("label", { className: "control" }, [el("span", { className: "control-label", textContent: label }), input, value]);
}

function select<T extends string>(label: string, options: [T, string][], get: () => T, set: (p: InstrumentParams, v: T) => void): HTMLElement {
  const input = el("select", {}, options.map(([value, text]) => el("option", { value, textContent: text })));
  controlsRefreshers.push(() => (input.value = get()));
  input.addEventListener("change", () => update((p) => set(p, input.value as T)));
  return el("label", { className: "control" }, [el("span", { className: "control-label", textContent: label }), input]);
}

function check(label: string, get: () => boolean, set: (p: InstrumentParams, v: boolean) => void): HTMLElement {
  const input = el("input", { type: "checkbox" });
  controlsRefreshers.push(() => (input.checked = get()));
  input.addEventListener("change", () => update((p) => set(p, input.checked)));
  return el("label", { className: "control check" }, [input, el("span", { textContent: label })]);
}

function refreshControls(): void {
  for (const refresh of controlsRefreshers) refresh();
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const ms = (v: number) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`);
const semis = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}`;

// ---------------------------------------------------------------- header, empty state

const fileInput = el("input", { type: "file", accept: "audio/*,video/*", className: "visually-hidden", id: "file" });
const openButton = el("label", { className: "button primary", htmlFor: "file", textContent: "素材を開く" });
const demoButton = el("button", { className: "button", textContent: "デモ素材" });
const status = el("p", { className: "status", role: "status" });

const emptyState = el("section", { className: "empty" }, [
  el("p", { className: "empty-title", textContent: "素材を入れたら、DAW に渡せる音源になる。" }),
  el("p", { textContent: "声や効果音のファイルを開くと、音程を判定して平らにし、母音を伸ばした単音の WAV を書き出せます。REAPER・GarageBand・Vital などのサンプラーにそのまま読み込めます。" }),
  el("div", { className: "row" }, [el("label", { className: "button primary", htmlFor: "file", textContent: "素材を開く" }), (() => {
    const b = el("button", { className: "button", textContent: "デモ素材で試す" });
    b.addEventListener("click", () => loadDemo());
    return b;
  })()]),
  el("p", { className: "fine", textContent: "生成AIは使っていません。素材は端末の中だけで処理され、外部には送られません。BGM の入った素材は、先に除去してから開いてください。" }),
]);

// ---------------------------------------------------------------- guide (3 steps)

const guideClose = el("button", { className: "button small", textContent: "閉じる" });
const guide = el("aside", { className: "steps", hidden: safeStorage(GUIDE_KEY) === "seen" }, [
  el("ol", {}, [
    el("li", {}, [el("strong", { textContent: "音名を選ぶ" }), " — 判定された音程に近い音名が入っています"]),
    el("li", {}, [el("strong", { textContent: "長さを決める" }), " — 拍数と BPM、または秒。鍵盤で試し弾きできます"]),
    el("li", {}, [el("strong", { textContent: "共有 / 保存" }), " — できた WAV を DAW のサンプラーに読み込みます"]),
  ]),
  guideClose,
]);
guideClose.addEventListener("click", () => {
  guide.hidden = true;
  safeStorage(GUIDE_KEY, "seen");
});

function safeStorage(key: string, value?: string): string | null {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- panel 1: the material

const rootLabel = el("strong", { className: "root-label num", textContent: "—" });
const rootSource = el("span", { className: "fine" });
const detectedButton = el("button", { className: "button small", textContent: "検出値に戻す" });
detectedButton.addEventListener("click", () => {
  if (material?.detectedRoot == null) return;
  update((p) => {
    p.root = material!.detectedRoot!;
    p.rootMode = "auto";
  }, true);
});

function rootButton(text: string, delta: number): HTMLButtonElement {
  const b = el("button", { className: "button small", textContent: text });
  b.addEventListener("click", () =>
    update((p) => {
      p.root = Math.round((p.root + delta) * 100) / 100;
      p.rootMode = "manual";
    }, true),
  );
  return b;
}

const materialPanel = el("section", { className: "panel" }, [
  el("div", { className: "editor-bar" }, [
    el("div", { className: "root-box" }, [el("span", { className: "fine", textContent: "判定した音程" }), rootLabel, rootSource]),
    el("p", { className: "fine hint", textContent: "両端のハンドルで鳴らす範囲を切り出し、帯の端で頭部(伸ばさない)・持続区間(伸ばす)・語尾を直せます。" }),
  ]),
  editor.element,
  el("p", { className: "legend fine" }, [
    el("span", { className: "swatch original" }), "元のピッチ  ",
    el("span", { className: "swatch edited" }), "整えたあと(選んだ音名で鳴らしたとき)",
  ]),
]);

// ---------------------------------------------------------------- panel 2: tune (note, flatten, length)

const noteSelect = el("select", { ariaLabel: "目標の音名", className: "note-select" }, [...Array(96 - 24 + 1).keys()].map((i) => el("option", { value: String(24 + i), textContent: pitchLabel(24 + i) })));
noteSelect.addEventListener("change", () =>
  updateExport((s) => {
    s.note = Number(noteSelect.value);
    s.noteMode = "manual";
  }),
);
function noteStep(text: string, delta: number): HTMLButtonElement {
  const b = el("button", { className: "button small", textContent: text, ariaLabel: delta > 0 ? "1半音上げる" : "1半音下げる" });
  b.addEventListener("click", () =>
    updateExport((s) => {
      s.note = Math.max(24, Math.min(96, s.note + delta));
      s.noteMode = "manual";
    }),
  );
  return b;
}
const noteAutoButton = el("button", { className: "button small", textContent: "判定に合わせる" });
noteAutoButton.addEventListener("click", () => updateExport((s) => (s.noteMode = "auto")));
const noteShift = el("span", { className: "fine num" });

const presetSelect = el("select", { ariaLabel: "プリセット" }, [
  el("option", { value: "", textContent: "(カスタム)" }),
  ...PRESETS.map((p) => el("option", { value: p.id, textContent: p.label })),
]);
presetSelect.addEventListener("change", () => {
  const preset = PRESETS.find((p) => p.id === presetSelect.value);
  if (!preset) return;
  presetId = preset.id;
  params = preset.apply(structuredClone(params));
  refreshControls();
  sendInstrument();
});

const beatsInput = el("input", { type: "number", min: "0.25", max: "64", step: "0.25", inputMode: "decimal", ariaLabel: "拍数" });
const bpmInput = el("input", { type: "number", min: "20", max: "400", step: "1", inputMode: "numeric", ariaLabel: "BPM" });
const secondsInput = el("input", { type: "number", min: "0.1", max: "60", step: "0.1", inputMode: "decimal", ariaLabel: "秒" });
const lengthBeats = el("input", { type: "radio", name: "length", value: "beats" });
const lengthSeconds = el("input", { type: "radio", name: "length", value: "seconds" });
const lengthResult = el("span", { className: "fine num" });
for (const input of [beatsInput, bpmInput, secondsInput]) {
  input.addEventListener("change", () =>
    updateExport((s) => {
      s.beats = clampNumber(beatsInput.value, 0.25, 64, s.beats);
      s.bpm = clampNumber(bpmInput.value, 20, 400, s.bpm);
      s.seconds = clampNumber(secondsInput.value, 0.1, 60, s.seconds);
    }),
  );
}
lengthBeats.addEventListener("change", () => updateExport((s) => (s.lengthMode = "beats")));
lengthSeconds.addEventListener("change", () => updateExport((s) => (s.lengthMode = "seconds")));

function clampNumber(text: string, min: number, max: number, fallback: number): number {
  const v = Number(text);
  return Number.isFinite(v) && text.trim() !== "" ? Math.max(min, Math.min(max, v)) : fallback;
}

const lengthBlock = el("div", { className: "length" }, [
  el("span", { className: "control-label", textContent: "長さ" }),
  el("label", { className: "length-row" }, [lengthBeats, beatsInput, el("span", { textContent: "拍" }), el("span", { className: "fine", textContent: "BPM" }), bpmInput]),
  el("label", { className: "length-row" }, [lengthSeconds, secondsInput, el("span", { textContent: "秒" })]),
  lengthResult,
]);

const tunePanel = el("section", { className: "panel tune" }, [
  el("div", { className: "note-row" }, [
    el("span", { className: "control-label", textContent: "音名" }),
    noteStep("−", -1),
    noteSelect,
    noteStep("+", 1),
    noteAutoButton,
    noteShift,
  ]),
  range("平坦化(抑揚の残し具合)", 0, 1, 0.01, () => params.flatten, (p, v) => (p.flatten = v), pct),
  el("label", { className: "control preset" }, [el("span", { className: "control-label", textContent: "プリセット" }), presetSelect]),
  lengthBlock,
]);

// ---------------------------------------------------------------- panel 3: keyboard

const voiceCount = el("span", { className: "num", textContent: "0" });
const pcState = el("span", { className: "fine" });
const pcToggle = el("button", { className: "button small", textContent: "PCキーボード演奏: オン (M)", hidden: SMALL_SCREEN });
pcToggle.addEventListener("click", () => pcKeys.toggle());
const imeWarning = el("p", { className: "warn", hidden: true, textContent: "日本語入力がオンになっています。鍵盤として弾くには、半角英数に切り替えてください。" });

const keysPanel = el("section", { className: "panel keys-panel" }, [
  el("div", { className: "row" }, [el("span", { className: "control-label", textContent: "試し弾き" }), pcToggle, pcState, el("span", { className: "fine" }, ["同時発音 ", voiceCount])]),
  imeWarning,
  piano.element,
  el("p", { className: "fine", textContent: "●の付いた鍵が、選んだ音名(書き出す高さ)です。" }),
]);

// ---------------------------------------------------------------- panel 4: export

const DESTINATIONS: { id: Destination; label: string; help: (note: string) => string }[] = [
  { id: "generic", label: "単音 WAV(どのサンプラーでも)", help: (note) => `サンプラー(REAPER の RS5K、Koala、Logic など)に読み込み、基準音(ルート)を ${note} にします。ファイル名にも音名が入ります。` },
  { id: "garageband", label: "GarageBand(iPhone / iPad)", help: (note) => `共有シートで「"ファイル"に保存」。GarageBand の Sampler で「読み込む」からそのファイルを選び、鍵盤の ${note} が元の高さです。44.1kHz / 16bit で出します。` },
  { id: "vital", label: "Vital", help: () => "WAV を OSC にドラッグし、ピッチモードを Pitch Splice にします。LFO やエンベロープで再生位置を動かすと、サンプラーのように使えます。" },
];
const destinationSelect = el("select", { ariaLabel: "渡す先" }, DESTINATIONS.map((d) => el("option", { value: d.id, textContent: d.label })));
destinationSelect.addEventListener("change", () => updateExport((s) => (s.destination = destinationSelect.value as Destination)));
const destinationHelp = el("p", { className: "fine help" });
const fileNameLabel = el("code", { className: "file-name" });
const listenButton = el("button", { className: "button big", textContent: "▶ 聴く" });
const shareButton = el("button", { className: "button big primary", textContent: "共有", hidden: !canShareFiles() });
const saveButton = el("button", { className: `button big ${canShareFiles() ? "" : "primary"}`, textContent: "保存" });
const exportStatus = el("p", { className: "fine", role: "status" });

listenButton.addEventListener("click", () => {
  const file = renderCurrent();
  if (!file) return;
  listenButton.textContent = "■ 停止";
  client.playBuffer(file.result.channels, file.result.sampleRate);
  listenButton.onclick = () => client.stopPreview();
});
client.onPreviewEnd = () => {
  listenButton.textContent = "▶ 聴く";
  listenButton.onclick = null;
};
shareButton.addEventListener("click", async () => {
  const file = renderCurrent();
  if (!file) return;
  try {
    const outcome = await shareFile(wavOf(file.result), file.fileName, file.fileName);
    exportStatus.textContent = outcome === "shared" ? `共有しました: ${file.fileName}` : "";
  } catch (error) {
    exportStatus.textContent = `共有できなかったので保存します: ${error instanceof Error ? error.message : error}`;
    downloadFile(wavOf(file.result), file.fileName);
  }
});
saveButton.addEventListener("click", () => {
  const file = renderCurrent();
  if (!file) return;
  downloadFile(wavOf(file.result), file.fileName);
  exportStatus.textContent = `保存しました: ${file.fileName}`;
});

function wavOf(result: Rendered): Blob {
  return encodeWav(result.channels, result.sampleRate, {
    INAM: credit.title,
    IART: credit.url,
    ICMT: [credit.timecode, credit.memo].filter(Boolean).join(" / "),
    ISFT: "MADDAW",
  });
}

const exportPanel = el("section", { className: "panel export" }, [
  el("label", { className: "control destination" }, [el("span", { className: "control-label", textContent: "渡す先" }), destinationSelect]),
  destinationHelp,
  el("div", { className: "export-actions" }, [listenButton, shareButton, saveButton]),
  el("p", { className: "fine" }, ["ファイル名: ", fileNameLabel]),
  exportStatus,
]);

// ---------------------------------------------------------------- details: the fine settings

const creditFields = (["title", "url", "timecode", "memo"] as const).map((key) => {
  const labels = { title: "作品名", url: "URL", timecode: "時刻", memo: "メモ" };
  const input = el("input", { type: key === "url" ? "url" : "text", value: credit[key] });
  input.addEventListener("input", () => {
    credit[key] = input.value;
    rendered = null; // the credit is written into the file
  });
  return el("label", { className: "control" }, [el("span", { className: "control-label", textContent: labels[key] }), input]);
});

const benchButton = el("button", { className: "button small", textContent: "負荷を測る" });
const benchResult = el("span", { className: "fine" });
benchButton.addEventListener("click", () => benchmark());

const detailsPanel = el("details", { className: "panel params" }, [
  el("summary", { textContent: "細かい設定(基準ピッチ・鳴らし方・揺らぎ・エンベロープ・出典メモ)" }),
  el("div", { className: "params-grid" }, [
    el("fieldset", {}, [
      el("legend", { textContent: "基準ピッチ(素材そのものの高さ)" }),
      el("p", { className: "fine", textContent: "判定が外れているときに直します。素材がこの高さで鳴っているものとして、音名との差だけ移調します。" }),
      el("div", { className: "row tight" }, [rootButton("−1半音", -1), rootButton("−5¢", -0.05), rootButton("+5¢", 0.05), rootButton("+1半音", 1), detectedButton]),
    ]),
    el("fieldset", {}, [
      el("legend", { textContent: "鳴らし方" }),
      select("ピッチの変え方", [["preserve-length", "長さ保持(PSOLA)"], ["resample", "速度連動(昔ながら)"]], () => params.pitchMode, (p, v) => (p.pitchMode = v)),
      select("持続区間の伸ばし方", [["pool", "周期プール(自然)"], ["loop", "ループ"], ["none", "伸ばさない(ワンショット)"]], () => params.sustainMode, (p, v) => (p.sustainMode = v)),
      check("語尾を末尾に付ける", () => params.tail.enabled, (p, v) => (p.tail.enabled = v)),
      range("フォルマント", -6, 6, 0.1, () => params.formantSemitones, (p, v) => (p.formantSemitones = v), semis),
      check("大きな移調で声質を少し追従させる", () => params.formantFollow, (p, v) => (p.formantFollow = v)),
    ]),
    el("fieldset", {}, [
      el("legend", { textContent: "揺らぎ" }),
      range("ビブラートの深さ", 0, 100, 1, () => params.wobble.vibratoCents, (p, v) => (p.wobble.vibratoCents = v), (v) => `${v}¢`),
      range("ビブラートの速さ", 3, 9, 0.1, () => params.wobble.vibratoHz, (p, v) => (p.wobble.vibratoHz = v), (v) => `${v.toFixed(1)} Hz`),
      range("かかり始め", 0, 1, 0.01, () => params.wobble.vibratoDelaySec, (p, v) => (p.wobble.vibratoDelaySec = v), ms),
      range("ゆっくりした揺れ", 0, 30, 1, () => params.wobble.driftCents, (p, v) => (p.wobble.driftCents = v), (v) => `${v}¢`),
      check("細かい揺れ(平坦でも機械的にしない)", () => params.wobble.micro, (p, v) => (p.wobble.micro = v)),
    ]),
    el("fieldset", {}, [
      el("legend", { textContent: "エンベロープ" }),
      range("アタック", 0.001, 0.5, 0.001, () => params.amp.attack, (p, v) => (p.amp.attack = v), ms),
      range("ディケイ", 0.01, 2, 0.01, () => params.amp.decay, (p, v) => (p.amp.decay = v), ms),
      range("サステイン", 0, 1, 0.01, () => params.amp.sustain, (p, v) => (p.amp.sustain = v), pct),
      range("リリース", 0.005, 2, 0.005, () => params.amp.release, (p, v) => (p.amp.release = v), ms),
      range("ベロシティ感度", 0, 1, 0.01, () => params.amp.velocitySens, (p, v) => (p.amp.velocitySens = v), pct),
    ]),
    el("fieldset", { className: "credit" }, [
      el("legend", { textContent: "出典メモ(WAV に書き込まれます。親作品登録・クレジット用)" }),
      ...creditFields,
    ]),
    location.search.includes("bench") ? el("div", { className: "row" }, [benchButton, benchResult]) : el("span"),
  ]),
]);

// ---------------------------------------------------------------- page

const workspace = el("main", { className: "workspace", hidden: true }, [guide, materialPanel, tunePanel, keysPanel, exportPanel, detailsPanel]);

const app = document.getElementById("app")!;
app.append(
  el("header", { className: "top" }, [
    el("h1", { textContent: "MADDAW" }),
    el("div", { className: "row" }, [openButton, demoButton]),
  ]),
  fileInput,
  status,
  emptyState,
  workspace,
);

// ---------------------------------------------------------------- state → screen

function sendInstrument(): void {
  if (!markers) return;
  rendered = null;
  client.setInstrument(markers, params);
  rootLabel.textContent = pitchLabel(params.root);
  rootSource.textContent = params.rootMode === "auto" ? "(自動判定)" : "(手動)";
  refreshExport();
}

/** The export settings → the note row, the length row, the file name, the help, the editor's target line. */
function refreshExport(): void {
  if (exportSettings.noteMode === "auto") exportSettings.note = Math.max(24, Math.min(96, Math.round(params.root)));
  noteSelect.value = String(exportSettings.note);
  noteAutoButton.hidden = exportSettings.noteMode === "auto";
  const shift = exportSettings.note - params.root;
  noteShift.textContent = `判定から ${shift >= 0 ? "+" : "−"}${Math.abs(shift).toFixed(2)} 半音`;
  noteShift.classList.toggle("warn", Math.abs(shift) > 7);

  beatsInput.value = String(exportSettings.beats);
  bpmInput.value = String(exportSettings.bpm);
  secondsInput.value = String(exportSettings.seconds);
  lengthBeats.checked = exportSettings.lengthMode === "beats";
  lengthSeconds.checked = exportSettings.lengthMode === "seconds";
  const oneShot = params.sustainMode === "none";
  lengthBlock.classList.toggle("disabled", oneShot);
  lengthResult.textContent = oneShot ? "ワンショット: 素材の長さのまま" : `= ${exportLengthSec(exportSettings).toFixed(2)} 秒`;

  destinationSelect.value = exportSettings.destination;
  const noteName = pitchLabel(exportSettings.note);
  destinationHelp.textContent = DESTINATIONS.find((d) => d.id === exportSettings.destination)!.help(noteName);
  fileNameLabel.textContent = material ? exportFileName(material.name, exportSettings, oneShot) : "";
  exportStatus.textContent = "";

  if (markers) editor.setState(markers, params.root, params.flatten, exportSettings.note);
  piano.setRoot(exportSettings.note);
}

/** Renders the file for the current settings (cached until something changes). */
function renderCurrent(): { result: Rendered; fileName: string } | null {
  if (!material || !markers) return null;
  const rate = destinationRate(exportSettings.destination) ?? material.sampleRate;
  const key = JSON.stringify([markers, params, exportSettings, rate, credit]);
  if (rendered?.key === key) return rendered;
  let source = material.exportSources.get(rate);
  if (!source) {
    source = prepareSource(material.channels, material.analysis, rate);
    material.exportSources.set(rate, source);
  }
  const result = renderNote(source, markers, params, exportSettings.note, exportLengthSec(exportSettings));
  const fileName = exportFileName(material.name, exportSettings, params.sustainMode === "none");
  rendered = { key, result, fileName };
  return rendered;
}

// ---------------------------------------------------------------- loading

async function decode(file: File): Promise<{ channels: Float32Array[]; sampleRate: number }> {
  const bytes = await file.arrayBuffer();
  // An offline context decodes without needing a user gesture.
  const context = new OfflineAudioContext(1, 1, 44100);
  const buffer = await context.decodeAudioData(bytes);
  const frames = Math.min(buffer.length, Math.round(MAX_MATERIAL_SEC * buffer.sampleRate));
  const channels = [...Array(Math.min(2, buffer.numberOfChannels)).keys()].map((c) => buffer.getChannelData(c).slice(0, frames));
  return { channels, sampleRate: buffer.sampleRate };
}

async function load(name: string, channels: Float32Array[], sampleRate: number): Promise<void> {
  status.textContent = `「${name}」を解析しています…`;
  try {
    const { analysis, source, elapsedMs } = await client.analyze(channels, sampleRate);
    const detectedRoot = analysis.root?.midi ?? null;
    material = { name, channels, sampleRate, mono: mixToMono(channels), analysis, source, exportSources: new Map([[source.sampleRate, source]]), detectedRoot };
    markers = analysis.markers;
    params = structuredClone(params);
    params.root = detectedRoot ?? 60;
    params.rootMode = detectedRoot === null ? "manual" : "auto";
    if (detectedRoot === null) {
      // Nothing pitched (a hit, a noise): a one-shot from C4.
      params = PRESETS.find((p) => p.id === "drum")!.apply(params);
      presetId = "drum";
    } else if (presetId === "drum") {
      params = PRESETS.find((p) => p.id === "synth")!.apply(params);
      presetId = "synth";
    }
    presetSelect.value = presetId;
    exportSettings = { ...exportSettings, noteMode: "auto" };
    editor.setMaterial({ mono: material.mono, sampleRate, track: analysis.track });
    client.setSource(source);
    refreshControls();
    sendInstrument();
    emptyState.hidden = true;
    workspace.hidden = false;
    const seconds = analysis.durationSec.toFixed(2);
    const root = analysis.root;
    status.textContent =
      `「${name}」 ${seconds} 秒 — 解析 ${Math.round(elapsedMs)} ms。` +
      (root
        ? ` 音程 ${pitchLabel(root.midi)}(信頼度 ${Math.round(root.confidence * 100)}%)。${pitchLabel(exportSettings.note)} の単音として書き出せます。`
        : " 音程が見つからなかったので、ワンショット(ドラム・効果音)として扱います。");
    if (channels[0].length >= MAX_MATERIAL_SEC * sampleRate) status.textContent += ` 最初の ${MAX_MATERIAL_SEC} 秒だけを使っています。`;
  } catch (error) {
    status.textContent = `読み込めませんでした: ${error instanceof Error ? error.message : error}`;
  }
}

function loadDemo(): void {
  credit.title = "MADDAW デモ素材(合成音声「さー」)";
  for (const field of creditFields) {
    const input = field.querySelector("input")!;
    const key = (["title", "url", "timecode", "memo"] as const)[creditFields.indexOf(field)];
    input.value = credit[key];
  }
  void load("デモ素材", [demoSyllable(DEMO_RATE)], DEMO_RATE);
}

async function openFile(file: File): Promise<void> {
  try {
    const { channels, sampleRate } = await decode(file);
    await load(file.name, channels, sampleRate);
  } catch (error) {
    status.textContent = `読み込めませんでした(対応していない形式かもしれません): ${error instanceof Error ? error.message : error}`;
  }
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (file) void openFile(file);
});
demoButton.addEventListener("click", () => loadDemo());

document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files[0];
  if (file) void openFile(file);
});

// ---------------------------------------------------------------- editor & keys

editor.onMarkersChange = (next, final) => {
  markers = next;
  if (final && material && params.rootMode === "auto") {
    // The root leans on the sustain, so it follows when the sustain moves.
    const root = rootForMarkers(material.analysis.track, next);
    if (root) {
      material.detectedRoot = root.midi;
      params = { ...params, root: root.midi };
    }
  }
  sendInstrument();
};

client.onStatus = (voices) => (voiceCount.textContent = String(voices));
client.onError = (message) => (status.textContent = `音声を開始できませんでした: ${message}`);

function showPcState(): void {
  const s = pcKeys.state;
  pcToggle.textContent = `PCキーボード演奏: ${s.enabled ? "オン" : "オフ"} (M)`;
  pcState.textContent = s.enabled && !SMALL_SCREEN ? `A = ${pitchLabel(s.baseNote)}(Z/X でオクターブ)・強さ ${Math.round(s.velocity * 100)}%(C/V)` : "";
  if (!s.enabled) imeWarning.hidden = true;
}
pcKeys.onChange = showPcState;
pcKeys.onNote = (note, down) => {
  imeWarning.hidden = true;
  piano.showPressed(note, down);
};
pcKeys.onIme = () => (imeWarning.hidden = false);
showPcState();

// ---------------------------------------------------------------- benchmark (?bench)

/** How much of real time 24 voices take on this device (on this thread, which is a fair stand-in for the audio thread). */
function benchmark(): void {
  if (!material || !markers) return;
  const engine = new Engine(material.source.sampleRate);
  engine.setSource(material.source);
  engine.setInstrument(markers, { ...params, maxVoices: 24 });
  for (let v = 0; v < 24; v++) engine.noteOn(Math.round(params.root) - 12 + v, 0.8);
  const l = new Float32Array(128);
  const r = new Float32Array(128);
  const blocks = Math.round(material.source.sampleRate / 128); // 1 second
  const started = performance.now();
  for (let b = 0; b < blocks; b++) engine.render(l, r);
  const elapsed = performance.now() - started;
  benchResult.textContent = `24 ボイスで実時間の ${((elapsed / 1000) * 100).toFixed(1)}%(1 秒分を ${Math.round(elapsed)} ms で計算)`;
}

// ---------------------------------------------------------------- PWA

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
    // offline use is a convenience, not a requirement
  });
}

refreshControls();
refreshExport();
