// MADDAW — Phase 2: cuts, loops, multisamples, settings (design.md 3, 5, 7).
//
// Load a material (or the demo): it is analysed (pitch curve, pitch marks,
// root pitch to the cent, suggested synthesis markers) and playable at once.
// Cut it with the range handles — several cuts (区間) of one clip if you
// like — pick the note and the length, try it on the keyboard, then share /
// save: a single WAV, a loopable WAV, or a multisample folder; every cut at
// once as a zip. The settings (never the audio) are kept per material and
// can be saved as JSON. One column, phone first.

import { pitchLabel } from "./analysis/pitch";
import { EngineClient } from "./audio/engineClient";
import { Engine, type PreparedSource } from "./engine/engine";
import { mixToMono, prepareSource, rootForMarkers, type MaterialAnalysis } from "./engine/prepare";
import { buildBatch, buildOne, type Built, type BuildInput } from "./export/build";
import { canShareFiles, downloadFile, shareFile } from "./export/deliver";
import { exportFileName, safeBaseName } from "./export/render";
import { parseSettings, serializeSettings, settingsKey, type CutSettings, type SettingsFile } from "./export/settings";
import { clampMarkers, suggestMarkersWithin } from "./instrument/markers";
import {
  DEFAULT_EXPORT,
  DEFAULT_PARAMS,
  PRESETS,
  destinationRate,
  exportLengthSec,
  type Credit,
  type Destination,
  type ExportFormat,
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
}

/** One cut (区間) of the material: its own markers, parameters and note. */
interface Cut extends CutSettings {
  presetId: PresetId | "";
  /** The root as detected for the cut's markers (for "back to detected"). */
  detectedRoot: number | null;
}

let material: Material | null = null;
let cuts: Cut[] = [];
let current = 0;
// The current cut, unpacked (kept in sync by syncCut()).
let markers: Markers | null = null;
let params: InstrumentParams = structuredClone(DEFAULT_PARAMS);
let presetId: PresetId | "" = "synth";
let note = 60;
let noteMode: "auto" | "manual" = "auto";
let exportSettings: ExportSettings = structuredClone(DEFAULT_EXPORT);
const credit: Credit = { title: "", url: "", timecode: "", memo: "" };
/** The last file built, keyed by everything it depends on. */
let built: { key: string; result: Built } | null = null;
let building = false;

const client = new EngineClient();
const editor = new MaterialEditor();
const sink = {
  noteOn: (n: number, velocity: number) => {
    client.unlock();
    client.noteOn(n, velocity);
  },
  noteOff: (n: number) => client.noteOff(n),
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

function button(text: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", { className: `button ${className}`, textContent: text });
  b.addEventListener("click", onClick);
  return b;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const ms = (v: number) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`);
const semis = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}`;

function safeStorage(key: string, value?: string | null): string | null {
  try {
    if (value === null) localStorage.removeItem(key);
    else if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- header, empty state

const fileInput = el("input", { type: "file", accept: "audio/*,video/*,.json,application/json", className: "visually-hidden", id: "file" });
const openButton = el("label", { className: "button primary", htmlFor: "file", textContent: "素材を開く" });
const demoButton = button("デモ素材", "", () => loadDemo());
const status = el("p", { className: "status", role: "status" });

const emptyState = el("section", { className: "empty" }, [
  el("p", { className: "empty-title", textContent: "素材を入れたら、DAW に渡せる音源になる。" }),
  el("p", { textContent: "声や効果音のファイルを開くと、音程を判定して平らにし、母音を伸ばした単音の WAV を書き出せます。REAPER・GarageBand・Vital などのサンプラーにそのまま読み込めます。音域ぶんを揃えたマルチサンプル音源(SFZ / Decent Sampler)も作れます。" }),
  el("div", { className: "row" }, [el("label", { className: "button primary", htmlFor: "file", textContent: "素材を開く" }), button("デモ素材で試す", "", () => loadDemo())]),
  el("p", { className: "fine", textContent: "生成AIは使っていません。素材は端末の中だけで処理され、外部には送られません。BGM の入った素材は、先に除去してから開いてください。" }),
]);

// ---------------------------------------------------------------- guide (3 steps)

const guide = el("aside", { className: "steps", hidden: safeStorage(GUIDE_KEY) === "seen" }, [
  el("ol", {}, [
    el("li", {}, [el("strong", { textContent: "音名を選ぶ" }), " — 判定された音程に近い音名が入っています"]),
    el("li", {}, [el("strong", { textContent: "長さを決める" }), " — 拍数と BPM、または秒。鍵盤で試し弾きできます"]),
    el("li", {}, [el("strong", { textContent: "共有 / 保存" }), " — できた WAV を DAW のサンプラーに読み込みます"]),
  ]),
  button("閉じる", "small", () => {
    guide.hidden = true;
    safeStorage(GUIDE_KEY, "seen");
  }),
]);

// ---------------------------------------------------------------- panel 1: the material and its cuts

const cutSelect = el("select", { ariaLabel: "区間", className: "cut-select" });
cutSelect.addEventListener("change", () => selectCut(Number(cutSelect.value)));
const cutName = el("input", { type: "text", className: "cut-name", ariaLabel: "区間の名前", maxLength: 40 });
cutName.addEventListener("input", () => {
  cuts[current].name = cutName.value;
  rebuildCutSelect();
  refreshExport();
});
const addCutButton = button("＋ 区間を追加", "small", () => addCut("next"));
const dupCutButton = button("複製", "small", () => addCut("copy"));
const removeCutButton = button("削除", "small", () => removeCut());
const cutBar = el("div", { className: "cut-bar" }, [
  el("span", { className: "control-label", textContent: "区間" }),
  cutSelect,
  cutName,
  addCutButton,
  dupCutButton,
  removeCutButton,
]);

const rootLabel = el("strong", { className: "root-label num", textContent: "—" });
const rootSource = el("span", { className: "fine" });
const detectedButton = button("検出値に戻す", "small", () => {
  const detected = cuts[current]?.detectedRoot;
  if (detected == null) return;
  update((p) => {
    p.root = detected;
    p.rootMode = "auto";
  }, true);
});

function rootButton(text: string, delta: number): HTMLButtonElement {
  return button(text, "small", () =>
    update((p) => {
      p.root = Math.round((p.root + delta) * 100) / 100;
      p.rootMode = "manual";
    }, true),
  );
}

const materialPanel = el("section", { className: "panel" }, [
  cutBar,
  el("div", { className: "editor-bar" }, [
    el("div", { className: "root-box" }, [el("span", { className: "fine", textContent: "判定した音程" }), rootLabel, rootSource]),
    el("p", { className: "fine hint", textContent: "両端のハンドルで鳴らす範囲を切り出し、帯の端で頭部(伸ばさない)・持続区間(伸ばす)・語尾を直せます。長い素材は「区間を追加」で何か所でも切り出せます。" }),
  ]),
  editor.element,
  el("p", { className: "legend fine" }, [
    el("span", { className: "swatch original" }), "元のピッチ  ",
    el("span", { className: "swatch edited" }), "整えたあと(選んだ音名で鳴らしたとき)",
  ]),
]);

// ---------------------------------------------------------------- panel 2: tune (note, flatten, length)

const noteSelect = el("select", { ariaLabel: "目標の音名", className: "note-select" }, [...Array(96 - 24 + 1).keys()].map((i) => el("option", { value: String(24 + i), textContent: pitchLabel(24 + i) })));
noteSelect.addEventListener("change", () => setNote(Number(noteSelect.value), "manual"));
function noteStep(text: string, delta: number): HTMLButtonElement {
  const b = button(text, "small", () => setNote(Math.max(24, Math.min(96, note + delta)), "manual"));
  b.ariaLabel = delta > 0 ? "1半音上げる" : "1半音下げる";
  return b;
}
const noteAutoButton = button("判定に合わせる", "small", () => setNote(note, "auto"));
const noteShift = el("span", { className: "fine num" });

function setNote(n: number, mode: "auto" | "manual"): void {
  note = n;
  noteMode = mode;
  refreshExport();
}

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
  el("div", { className: "note-row" }, [el("span", { className: "control-label", textContent: "音名" }), noteStep("−", -1), noteSelect, noteStep("+", 1), noteAutoButton, noteShift]),
  range("平坦化(抑揚の残し具合)", 0, 1, 0.01, () => params.flatten, (p, v) => (p.flatten = v), pct),
  el("label", { className: "control preset" }, [el("span", { className: "control-label", textContent: "プリセット" }), presetSelect]),
  lengthBlock,
]);

// ---------------------------------------------------------------- panel 3: keyboard

const voiceCount = el("span", { className: "num", textContent: "0" });
const pcState = el("span", { className: "fine" });
const pcToggle = button("PCキーボード演奏: オン (M)", "small", () => pcKeys.toggle());
pcToggle.hidden = SMALL_SCREEN;
const imeWarning = el("p", { className: "warn", hidden: true, textContent: "日本語入力がオンになっています。鍵盤として弾くには、半角英数に切り替えてください。" });

const keysPanel = el("section", { className: "panel keys-panel" }, [
  el("div", { className: "row" }, [el("span", { className: "control-label", textContent: "試し弾き" }), pcToggle, pcState, el("span", { className: "fine" }, ["同時発音 ", voiceCount])]),
  imeWarning,
  piano.element,
  el("p", { className: "fine", textContent: "●の付いた鍵が、選んだ音名(書き出す高さ)です。" }),
]);

// ---------------------------------------------------------------- panel 4: export

const FORMATS: { id: ExportFormat; label: string; note: string }[] = [
  { id: "single", label: "単音 WAV", note: "1本の WAV。どのサンプラーでも読み込めます。" },
  { id: "loop", label: "ループ WAV(ループ点入り)", note: "持続区間を長めに作り、ループ範囲を WAV に埋め込みます(smpl)。ループ点を読むサンプラー(Logic、Kontakt、sforzando など)では、いくらでも伸ばせます。" },
  { id: "multisample", label: "マルチサンプル音源(zip: SFZ + Decent Sampler)", note: "±1 オクターブを 3 半音おきに、それぞれの高さで作った WAV と、.sfz / .dspreset の定義を zip にまとめます。高音で途切れず、低音で間延びしません。" },
];
const DESTINATIONS: { id: Destination; label: string; help: (n: string, format: ExportFormat) => string }[] = [
  {
    id: "generic",
    label: "汎用(REAPER・Koala・Logic など)",
    help: (n, format) =>
      format === "multisample"
        ? "zip を展開し、.sfz を sforzando などの SFZ 対応サンプラーに、.dspreset を Decent Sampler に読み込みます。REAPER では RS5K の代わりに sforzando(無料)を使います。"
        : `サンプラー(REAPER の RS5K、Koala、Logic など)に読み込み、基準音(ルート)を ${n} にします。ファイル名と WAV の中にも音名が入っています。`,
  },
  {
    id: "garageband",
    label: "GarageBand(iPhone / iPad)",
    help: (n) => `共有シートで「"ファイル"に保存」。GarageBand の Sampler で「読み込む」からそのファイルを選びます。鍵盤の ${n} が元の高さです。44.1kHz / 16bit で出します。`,
  },
  {
    id: "decent",
    label: "Decent Sampler(iPhone / iPad・PC、無料)",
    help: () => "iPhone / iPad: zip を「ファイル」App で展開し、.dspreset をタップすると Decent Sampler で開きます。PC: File → Load Preset で .dspreset を選びます。",
  },
  {
    id: "vital",
    label: "Vital",
    help: () => "WAV を OSC にドラッグし、ピッチモードを Pitch Splice にします。LFO やエンベロープで再生位置を動かすと、サンプラーのように使えます。",
  },
];
const formatSelect = el("select", { ariaLabel: "形式" }, FORMATS.map((f) => el("option", { value: f.id, textContent: f.label })));
formatSelect.addEventListener("change", () => updateExport((s) => (s.format = formatSelect.value as ExportFormat)));
const formatNote = el("p", { className: "fine help" });
const destinationSelect = el("select", { ariaLabel: "渡す先" }, DESTINATIONS.map((d) => el("option", { value: d.id, textContent: d.label })));
destinationSelect.addEventListener("change", () =>
  updateExport((s) => {
    s.destination = destinationSelect.value as Destination;
    // The destination says what it can take.
    if (s.destination === "decent") s.format = "multisample";
    else if ((s.destination === "garageband" || s.destination === "vital") && s.format === "multisample") s.format = "single";
  }),
);
const destinationHelp = el("p", { className: "fine help" });
const fileNameLabel = el("code", { className: "file-name" });
const listenButton = button("▶ 聴く", "big", () => void listen());
const shareButton = button("共有", "big primary", () => void deliver("share", false));
shareButton.hidden = !canShareFiles();
const saveButton = button("保存", `big ${canShareFiles() ? "" : "primary"}`, () => void deliver("download", false));
const batchButton = button("すべての区間をまとめて保存(zip)", "", () => void deliver(canShareFiles() ? "share" : "download", true));
const exportStatus = el("p", { className: "fine", role: "status" });

const exportPanel = el("section", { className: "panel export" }, [
  el("label", { className: "control destination" }, [el("span", { className: "control-label", textContent: "形式" }), formatSelect]),
  formatNote,
  el("label", { className: "control destination" }, [el("span", { className: "control-label", textContent: "渡す先" }), destinationSelect]),
  destinationHelp,
  el("div", { className: "export-actions" }, [listenButton, shareButton, saveButton]),
  el("p", { className: "fine" }, ["ファイル名: ", fileNameLabel]),
  el("div", { className: "row" }, [batchButton]),
  exportStatus,
]);

// ---------------------------------------------------------------- details: the fine settings

const creditFields = (["title", "url", "timecode", "memo"] as const).map((key) => {
  const labels = { title: "作品名", url: "URL", timecode: "時刻", memo: "メモ" };
  const input = el("input", { type: key === "url" ? "url" : "text", value: credit[key] });
  input.addEventListener("input", () => {
    credit[key] = input.value;
    built = null; // the credit is written into the file
    scheduleSave();
  });
  return el("label", { className: "control" }, [el("span", { className: "control-label", textContent: labels[key] }), input]);
});
function setCreditInputs(): void {
  (["title", "url", "timecode", "memo"] as const).forEach((key, i) => (creditFields[i].querySelector("input")!.value = credit[key]));
}

const saveSettingsButton = button("設定を保存(JSON)", "small", () => {
  if (!material) return;
  const json = serializeSettings(settingsBody());
  downloadFile(new Blob([json], { type: "application/json" }), `${safeBaseName(material.name)}.maddaw.json`);
});
const loadSettingsButton = el("label", { className: "button small", htmlFor: "file", textContent: "設定を読み込む(JSON)" });
const resetSettingsButton = button("判定し直す(設定を捨てる)", "small", () => {
  if (!material) return;
  freshCuts();
  exportSettings = structuredClone(DEFAULT_EXPORT);
  applyCurrentCut();
  status.textContent = "解析結果から設定を作り直しました。";
});

const benchButton = button("負荷を測る", "small", () => benchmark());
const benchResult = el("span", { className: "fine" });

const detailsPanel = el("details", { className: "panel params" }, [
  el("summary", { textContent: "細かい設定(基準ピッチ・鳴らし方・揺らぎ・エンベロープ・出典メモ・設定ファイル)" }),
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
    el("fieldset", {}, [
      el("legend", { textContent: "設定ファイル" }),
      el("p", { className: "fine", textContent: "区間・マーカー・つまみ・音名などの設定だけを保存します(音声は含みません)。同じ素材を開き直すと、この端末では自動で前回の設定に戻ります。" }),
      el("div", { className: "row tight" }, [saveSettingsButton, loadSettingsButton, resetSettingsButton]),
    ]),
    location.search.includes("bench") ? el("div", { className: "row" }, [benchButton, benchResult]) : el("span"),
  ]),
]);

// ---------------------------------------------------------------- page

const workspace = el("main", { className: "workspace", hidden: true }, [guide, materialPanel, tunePanel, keysPanel, exportPanel, detailsPanel]);

document.getElementById("app")!.append(
  el("header", { className: "top" }, [el("h1", { textContent: "MADDAW" }), el("div", { className: "row" }, [openButton, demoButton])]),
  fileInput,
  status,
  emptyState,
  workspace,
);

// ---------------------------------------------------------------- cuts

function cutFromAnalysis(m: Markers, name: string, base: InstrumentParams): Cut {
  const root = material ? rootForMarkers(material.analysis.track, m) : null;
  const p = structuredClone(base);
  let preset: PresetId | "" = presetId || "synth";
  if (root) {
    p.root = root.midi;
    p.rootMode = "auto";
    if (preset === "drum") {
      Object.assign(p, PRESETS.find((x) => x.id === "synth")!.apply(p));
      preset = "synth";
    }
  } else {
    // Nothing pitched (a hit, a noise): a one-shot from C4.
    p.root = 60;
    p.rootMode = "manual";
    Object.assign(p, PRESETS.find((x) => x.id === "drum")!.apply(p));
    preset = "drum";
  }
  return { name, markers: m, params: p, note: Math.max(24, Math.min(96, Math.round(p.root))), noteMode: "auto", presetId: preset, detectedRoot: root?.midi ?? null };
}

/** One cut from the analysis, as on a fresh load. */
function freshCuts(): void {
  if (!material) return;
  presetId = "synth";
  cuts = [cutFromAnalysis(material.analysis.markers, "区間 1", DEFAULT_PARAMS)];
  current = 0;
}

/** Copies the current cut's unpacked state back into cuts[current]. */
function syncCut(): void {
  const cut = cuts[current];
  if (!cut || !markers) return;
  cut.markers = markers;
  cut.params = params;
  cut.presetId = presetId;
  cut.note = note;
  cut.noteMode = noteMode;
}

/** Unpacks cuts[current] into the working state and the screen. */
function applyCurrentCut(): void {
  const cut = cuts[current];
  if (!cut) return;
  markers = cut.markers;
  params = cut.params;
  presetId = cut.presetId;
  note = cut.note;
  noteMode = cut.noteMode;
  presetSelect.value = presetId;
  rebuildCutSelect();
  cutName.value = cut.name;
  removeCutButton.disabled = cuts.length < 2;
  refreshControls();
  sendInstrument();
}

function rebuildCutSelect(): void {
  cutSelect.replaceChildren(...cuts.map((c, i) => el("option", { value: String(i), textContent: `${i + 1}. ${c.name}` })));
  cutSelect.value = String(current);
  batchButton.hidden = cuts.length < 2;
}

function selectCut(index: number): void {
  if (index === current || !cuts[index]) return;
  syncCut();
  current = index;
  applyCurrentCut();
}

/** A new cut: a copy of this one, or the next stretch of the material (same length, markers suggested afresh). */
function addCut(how: "copy" | "next"): void {
  if (!material || !markers) return;
  syncCut();
  const duration = material.analysis.durationSec;
  let cut: Cut;
  if (how === "copy") {
    cut = { ...structuredClone(cuts[current]), name: `${cuts[current].name} のコピー` };
  } else {
    const length = Math.max(0.05, markers.rangeEnd - markers.rangeStart);
    let from = markers.rangeEnd;
    if (duration - from < 0.05) from = Math.max(0, duration - length); // at the end already: overlap instead
    const to = Math.min(duration, from + length);
    cut = cutFromAnalysis(suggestMarkersWithin(material.analysis.track, from, to), `区間 ${cuts.length + 1}`, params);
  }
  cuts.splice(current + 1, 0, cut);
  current++;
  applyCurrentCut();
}

function removeCut(): void {
  if (cuts.length < 2) return;
  cuts.splice(current, 1);
  current = Math.min(current, cuts.length - 1);
  applyCurrentCut();
}

// ---------------------------------------------------------------- state → screen

function sendInstrument(): void {
  if (!markers) return;
  built = null;
  client.setInstrument(markers, params);
  rootLabel.textContent = pitchLabel(params.root);
  rootSource.textContent = params.rootMode === "auto" ? "(自動判定)" : "(手動)";
  refreshExport();
}

/** The note and export settings → the note row, the length row, the file name, the help, the editor's target line. */
function refreshExport(): void {
  if (noteMode === "auto") note = Math.max(24, Math.min(96, Math.round(params.root)));
  noteSelect.value = String(note);
  noteAutoButton.hidden = noteMode === "auto";
  const shift = note - params.root;
  noteShift.textContent = `判定から ${shift >= 0 ? "+" : "−"}${Math.abs(shift).toFixed(2)} 半音`;
  noteShift.classList.toggle("warn", Math.abs(shift) > 7);

  beatsInput.value = String(exportSettings.beats);
  bpmInput.value = String(exportSettings.bpm);
  secondsInput.value = String(exportSettings.seconds);
  lengthBeats.checked = exportSettings.lengthMode === "beats";
  lengthSeconds.checked = exportSettings.lengthMode === "seconds";
  const oneShot = params.sustainMode === "none";
  lengthBlock.classList.toggle("disabled", oneShot);
  const held = exportLengthSec(exportSettings);
  lengthResult.textContent = oneShot
    ? "ワンショット: 素材の長さのまま"
    : exportSettings.format === "single"
      ? `= ${held.toFixed(2)} 秒`
      : `= ${held.toFixed(2)} 秒(ループ用に最低 2 秒は作ります)`;

  formatSelect.value = exportSettings.format;
  formatNote.textContent = FORMATS.find((f) => f.id === exportSettings.format)!.note;
  destinationSelect.value = exportSettings.destination;
  destinationHelp.textContent = DESTINATIONS.find((d) => d.id === exportSettings.destination)!.help(pitchLabel(note), exportSettings.format);
  fileNameLabel.textContent = material ? currentFileName() : "";
  exportStatus.textContent = "";
  built = null;

  if (markers) editor.setState(markers, params.root, params.flatten, note);
  piano.setRoot(note);
  syncCut();
  scheduleSave();
}

function baseNameFor(cut: Cut): string {
  if (!material) return "material";
  return cuts.length > 1 ? `${safeBaseName(material.name)}_${cut.name}` : safeBaseName(material.name);
}

function currentFileName(): string {
  const cut = cuts[current];
  if (!material || !cut) return "";
  const base = safeBaseName(baseNameFor(cut));
  if (cut.params.sustainMode === "none" || exportSettings.format === "single") return exportFileName(base, cut.note, exportSettings, cut.params.sustainMode === "none");
  if (exportSettings.format === "loop") return `${base}_${pitchLabel(cut.note).replace("#", "s")}_loop.wav`;
  return `${base}.zip`;
}

// ---------------------------------------------------------------- building & delivering

function exportSource(): PreparedSource {
  const rate = destinationRate(exportSettings.destination) ?? material!.sampleRate;
  let source = material!.exportSources.get(rate);
  if (!source) {
    source = prepareSource(material!.channels, material!.analysis, rate);
    material!.exportSources.set(rate, source);
  }
  return source;
}

function inputFor(cut: Cut, source: PreparedSource): BuildInput {
  return { baseName: baseNameFor(cut), source, cut, settings: exportSettings, credit };
}

const yieldToScreen = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Builds the current cut's file (cached until something changes). */
async function buildCurrent(): Promise<Built | null> {
  if (!material || !cuts[current] || building) return built?.result ?? null;
  syncCut();
  const source = exportSource();
  const key = JSON.stringify([cuts[current], exportSettings, source.sampleRate, credit]);
  if (built?.key === key) return built.result;
  building = true;
  try {
    const result = await buildOne(inputFor(cuts[current], source), async (done, total) => {
      if (total > 1) {
        exportStatus.textContent = `作成中… ${done} / ${total}`;
        await yieldToScreen();
      }
    });
    built = { key, result };
    return result;
  } finally {
    building = false;
  }
}

async function buildAll(): Promise<Built | null> {
  if (!material || building) return null;
  syncCut();
  const source = exportSource();
  building = true;
  try {
    return await buildBatch(
      cuts.map((cut) => inputFor(cut, source)),
      serializeSettings(settingsBody()),
      material.name,
      async (done, total) => {
        exportStatus.textContent = `作成中… ${done} / ${total}`;
        await yieldToScreen();
      },
    );
  } finally {
    building = false;
  }
}

async function listen(): Promise<void> {
  if (listenButton.dataset.playing) {
    client.stopPreview();
    return;
  }
  const result = await buildCurrent();
  if (!result) return;
  exportStatus.textContent = exportSettings.format === "multisample" ? `試聴: 中央の音(${pitchLabel(note)})` : "";
  listenButton.textContent = "■ 停止";
  listenButton.dataset.playing = "1";
  client.playBuffer(result.preview.channels, result.preview.sampleRate);
}
client.onPreviewEnd = () => {
  listenButton.textContent = "▶ 聴く";
  delete listenButton.dataset.playing;
};

async function deliver(how: "share" | "download", all: boolean): Promise<void> {
  try {
    const result = all ? await buildAll() : await buildCurrent();
    if (!result) return;
    if (how === "share") {
      try {
        const outcome = await shareFile(result.blob, result.fileName, result.fileName);
        exportStatus.textContent = outcome === "shared" ? `共有しました: ${result.summary}` : "";
        return;
      } catch (error) {
        exportStatus.textContent = `共有できなかったので保存します(${error instanceof Error ? error.message : error})`;
      }
    }
    downloadFile(result.blob, result.fileName);
    exportStatus.textContent = `保存しました: ${result.summary}`;
  } catch (error) {
    exportStatus.textContent = `書き出せませんでした: ${error instanceof Error ? error.message : error}`;
  }
}

// ---------------------------------------------------------------- settings (per material, and as JSON)

function settingsBody(): Omit<SettingsFile, "app" | "version" | "savedAt"> {
  syncCut();
  return {
    material: { name: material!.name, durationSec: material!.analysis.durationSec, sampleRate: material!.sampleRate, channels: material!.channels.length },
    export: exportSettings,
    credit: { ...credit },
    cuts: cuts.map(({ name, markers: m, params: p, note: n, noteMode: mode }) => ({ name, markers: m, params: p, note: n, noteMode: mode })),
    currentCut: current,
  };
}

let saveTimer = 0;
function scheduleSave(): void {
  if (!material) return;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    if (material) safeStorage(settingsKey(material.name, material.channels[0].length, material.sampleRate), serializeSettings(settingsBody()));
  }, 400);
}

/** Puts a settings file into effect for the loaded material. */
function applySettings(file: SettingsFile): void {
  if (!material) return;
  const duration = material.analysis.durationSec;
  cuts = file.cuts.map((c) => {
    const m = clampMarkers({ ...c.markers, rangeEnd: Math.min(c.markers.rangeEnd, duration) });
    const detected = rootForMarkers(material!.analysis.track, m);
    const preset = PRESETS.find((p) => JSON.stringify(p.apply(structuredClone(c.params))) === JSON.stringify(c.params))?.id ?? "";
    return { ...c, markers: m, params: { ...c.params, maxVoices: DEFAULT_PARAMS.maxVoices }, presetId: preset, detectedRoot: detected?.midi ?? null };
  });
  current = file.currentCut;
  exportSettings = file.export;
  Object.assign(credit, file.credit);
  setCreditInputs();
  applyCurrentCut();
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
    material = { name, channels, sampleRate, mono: mixToMono(channels), analysis, source, exportSources: new Map([[source.sampleRate, source]]) };
    editor.setMaterial({ mono: material.mono, sampleRate, track: analysis.track });
    client.setSource(source);
    emptyState.hidden = true;
    workspace.hidden = false;

    const seconds = analysis.durationSec.toFixed(2);
    const root = analysis.root;
    let text =
      `「${name}」 ${seconds} 秒 — 解析 ${Math.round(elapsedMs)} ms。` +
      (root ? ` 音程 ${pitchLabel(root.midi)}(信頼度 ${Math.round(root.confidence * 100)}%)。` : " 音程が見つからなかったので、ワンショット(ドラム・効果音)として扱います。");
    if (channels[0].length >= MAX_MATERIAL_SEC * sampleRate) text += ` 最初の ${MAX_MATERIAL_SEC} 秒だけを使っています。`;

    const stored = safeStorage(settingsKey(name, channels[0].length, sampleRate));
    let restored = false;
    if (stored) {
      try {
        applySettings(parseSettings(stored));
        restored = true;
      } catch {
        // a stale or broken entry: start fresh
      }
    }
    if (!restored) {
      freshCuts();
      applyCurrentCut();
    }
    status.replaceChildren(text + (restored ? " 前回の設定を復元しました。" : ""));
    if (restored) status.append(" ", button("判定し直す", "small", () => resetSettingsButton.click()));
  } catch (error) {
    status.textContent = `読み込めませんでした: ${error instanceof Error ? error.message : error}`;
  }
}

function loadDemo(): void {
  Object.assign(credit, { title: "MADDAW デモ素材(合成音声「さー」)", url: "", timecode: "", memo: "" });
  setCreditInputs();
  void load("デモ素材", [demoSyllable(DEMO_RATE)], DEMO_RATE);
}

async function openFile(file: File): Promise<void> {
  if (file.name.toLowerCase().endsWith(".json") || file.type === "application/json") {
    try {
      const settings = parseSettings(await file.text());
      if (!material) {
        status.textContent = `設定ファイル「${file.name}」は、素材(${settings.material.name || "名前なし"})を開いてから読み込んでください。`;
        return;
      }
      applySettings(settings);
      status.textContent = `設定ファイル「${file.name}」を読み込みました(区間 ${settings.cuts.length} 個)。`;
    } catch (error) {
      status.textContent = `設定を読み込めませんでした: ${error instanceof Error ? error.message : error}`;
    }
    return;
  }
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
      cuts[current].detectedRoot = root.midi;
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
pcKeys.onNote = (n, down) => {
  imeWarning.hidden = true;
  piano.showPressed(n, down);
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
