// MADDAW — Phase 2: cuts, loops, multisamples, settings (design.md 3, 5, 7).
//
// Load a material (or the demo): it is analysed (pitch curve, pitch marks,
// root pitch to the cent, suggested synthesis markers) and playable at once.
// Cut it with the range handles — several cuts (区間) of one clip if you
// like — pick the note and the length, try it on the keyboard, then share /
// save: a single WAV, a loopable WAV, or a multisample folder; every cut at
// once as a zip. The settings (never the audio) are kept per material and
// can be saved as JSON. One column, phone first.

import { applyCorrections, CORRECTION_LABELS, type CorrectionKind, type PitchCorrection } from "./analysis/corrections";
import { pitchLabel } from "./analysis/pitch";
import { EngineClient } from "./audio/engineClient";
import { Engine, type PreparedSource } from "./engine/engine";
import { mixToMono, prepareSource, rootForMarkers, type MaterialAnalysis } from "./engine/prepare";
import type { PitchTrack } from "./analysis/pyin";
import { buildBatch, buildKit, buildOne, type Built, type BuildInput } from "./export/build";
import { canShareFiles, downloadFile, shareFile } from "./export/deliver";
import { exportFileName, safeBaseName } from "./export/render";
import { parseSettings, serializeSettings, settingsKey, type CutSettings, type SettingsFile } from "./export/settings";
import { hiddenPartsOf, normalizeRemoved, outputLayout } from "./instrument/layout";
import { clampMarkers, suggestMarkersWithin } from "./instrument/markers";
import {
  DEFAULT_EXPORT,
  DEFAULT_FX,
  DEFAULT_PARAMS,
  PRESETS,
  destinationRate,
  exportLengthSec,
  type Credit,
  type Destination,
  type ExportFormat,
  type ExportSettings,
  type FxBeats,
  type FxSettings,
  type InstrumentParams,
  type Markers,
  type PresetId,
} from "./instrument/types";
import { demoSyllable } from "./testsignals/synthVoice";
import { el } from "./ui/dom";
import { OnScreenKeyboard, PcKeyboard } from "./ui/keyboard";
import { MaterialEditor, type TimeSelection } from "./ui/materialEditor";
import { clock, RangePicker } from "./ui/rangePicker";
import { isMidiFile, SongPanel } from "./ui/songPanel";

/** The most material one analysis takes; a longer clip goes through the range picker first. */
const MAX_MATERIAL_SEC = 60;
/** Longer files are cut here when decoded (memory: 10 minutes of stereo 48 kHz is about 230 MB). */
const MAX_DECODE_SEC = 600;
const DEMO_RATE = 44100;
const GUIDE_KEY = "maddaw.guide.v2";
const SMALL_SCREEN = window.matchMedia("(max-width: 600px)").matches;

// ---------------------------------------------------------------- state

interface Material {
  name: string;
  channels: Float32Array[];
  sampleRate: number;
  mono: Float32Array;
  /** The analysis in use: the original with the hand corrections applied (and the marks found again). */
  analysis: MaterialAnalysis;
  /** The analysis as it came out of pYIN, which the corrections are re-applied to. */
  original: MaterialAnalysis;
  corrections: PitchCorrection[];
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
// 曲で試す: the material on a part of a MIDI song (one sound at a time with the previews).
const songPanel = new SongPanel(client, () => note, () => exportSettings.bpm);
songPanel.onPlayingChange = (playing) => {
  if (playing) client.stopPreview();
};

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
  const { source } = await client.analyze(material.channels, material.sampleRate, undefined, material.analysis.track);
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

function range(label: string, min: number, max: number, step: number, get: () => number, set: (p: InstrumentParams, v: number) => void, format: (v: number) => string, keepPreset = false): HTMLElement {
  const input = el("input", { type: "range", min: String(min), max: String(max), step: String(step) });
  const value = el("output", { className: "num" });
  const refresh = () => {
    input.value = String(get());
    value.textContent = format(get());
  };
  input.addEventListener("input", () => {
    update((p) => set(p, Number(input.value)), keepPreset);
    value.textContent = format(Number(input.value));
  });
  controlsRefreshers.push(refresh);
  return el("label", { className: "control" }, [el("span", { className: "control-label", textContent: label }), input, value]);
}

function select<T extends string>(label: string, options: [T, string][], get: () => T, set: (p: InstrumentParams, v: T) => void, keepPreset = false): HTMLElement {
  const input = el("select", {}, options.map(([value, text]) => el("option", { value, textContent: text })));
  controlsRefreshers.push(() => (input.value = get()));
  input.addEventListener("change", () => update((p) => set(p, input.value as T), keepPreset));
  return el("label", { className: "control" }, [el("span", { className: "control-label", textContent: label }), input]);
}

function check(label: string, get: () => boolean, set: (p: InstrumentParams, v: boolean) => void, keepPreset = false): HTMLElement {
  const input = el("input", { type: "checkbox" });
  controlsRefreshers.push(() => (input.checked = get()));
  input.addEventListener("change", () => update((p) => set(p, input.checked), keepPreset));
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

const fileInput = el("input", { type: "file", accept: "audio/*,video/*,.json,application/json,.mid,.midi", multiple: true, className: "visually-hidden", id: "file" });
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

// Hand corrections (design.md 3): drag across the plot to select, then say what's wrong there.
let selection: TimeSelection | null = null;
const selectionLabel = el("span", { className: "fine num" });
function fixButton(kind: CorrectionKind): HTMLButtonElement {
  return button(CORRECTION_LABELS[kind], "small", () => {
    if (!selection) return;
    void addCorrection({ start: selection.from, end: selection.to, kind });
  });
}
const fixButtons = (["octave-up", "octave-down", "unvoiced", "voiced"] as const).map(fixButton);
const clearSelectionButton = button("選択解除", "small", () => {
  selection = null;
  editor.setSelection(null);
  refreshFixBar();
});
// Cutting (VocalShifter's TIME: 選択範囲の削除 / トリミング).
const removeButton = button("この範囲を削除", "small", () => {
  if (!selection || !markers) return;
  const removed = normalizeRemoved([...(markers.removed ?? []), { start: selection.from, end: selection.to }], markers.rangeStart, markers.rangeEnd);
  markers = clampMarkers({ ...markers, removed });
  selection = null;
  editor.setSelection(null);
  afterMarkersEdited();
});
const trimButton = button("選択範囲だけにする", "small", () => {
  if (!selection || !markers) return;
  markers = clampMarkers({ ...markers, rangeStart: selection.from, rangeEnd: selection.to });
  selection = null;
  editor.setSelection(null);
  afterMarkersEdited();
});
const removedLabel = el("span", { className: "fine" });
const undoRemoveButton = button("最後の削除を戻す", "small", () => {
  if (!markers?.removed?.length) return;
  markers = clampMarkers({ ...markers, removed: markers.removed.slice(0, -1) });
  afterMarkersEdited();
});
const clearRemovedButton = button("削除をすべて戻す", "small", () => {
  if (!markers) return;
  markers = clampMarkers({ ...markers, removed: [] });
  afterMarkersEdited();
});

/** The markers changed by a button (not a drag): the root may follow, the engine and the screen update. */
function afterMarkersEdited(): void {
  if (!markers) return;
  if (material && params.rootMode === "auto") {
    const root = rootForMarkers(material.analysis.track, markers);
    if (root) {
      cuts[current].detectedRoot = root.midi;
      params = { ...params, root: root.midi };
    }
  }
  sendInstrument();
  refreshFixBar();
}

const correctionsLabel = el("span", { className: "fine" });
const undoCorrectionButton = button("最後の手直しを取り消す", "small", () => void setCorrections(material?.corrections.slice(0, -1) ?? []));
const clearCorrectionsButton = button("すべて取り消す", "small", () => void setCorrections([]));
const fixBar = el("div", { className: "fix-bar" }, [
  el("div", { className: "row tight" }, [selectionLabel, removeButton, trimButton, ...fixButtons, clearSelectionButton]),
  el("div", { className: "row tight" }, [removedLabel, undoRemoveButton, clearRemovedButton]),
  el("div", { className: "row tight" }, [correctionsLabel, undoCorrectionButton, clearCorrectionsButton]),
]);

function refreshFixBar(): void {
  const count = material?.corrections.length ?? 0;
  const removed = markers?.removed ?? [];
  const hasSelection = selection !== null;
  selectionLabel.textContent = hasSelection
    ? `選択 ${selection!.from.toFixed(2)}–${selection!.to.toFixed(2)} 秒:`
    : "波形の上を横にドラッグして範囲を選ぶと、その範囲を削除したり、判定を直したりできます。";
  for (const b of [removeButton, trimButton, ...fixButtons, clearSelectionButton]) b.hidden = !hasSelection;
  removedLabel.textContent = removed.length ? `削除 ${removed.length} か所(${removed.map((r) => `${r.start.toFixed(2)}–${r.end.toFixed(2)} 秒`).join("、")})` : "";
  undoRemoveButton.hidden = removed.length === 0;
  clearRemovedButton.hidden = removed.length < 2;
  removedLabel.parentElement!.hidden = removed.length === 0;
  correctionsLabel.textContent = count ? `手直し ${count} 件(${material!.corrections.map((c) => CORRECTION_LABELS[c.kind]).join("、")})` : "";
  undoCorrectionButton.hidden = count === 0;
  clearCorrectionsButton.hidden = count < 2;
  correctionsLabel.parentElement!.hidden = count === 0;
}

// Trial playback from the head (with the playhead moving), and the view's zoom.
const playOriginalButton = button("▶ 元の音", "small", () => void playOriginal());
const playResultButton = button("▶ 書き出し後", "small", () => void listen());
const zoomInButton = button("＋", "small", () => editor.zoom(1.6));
const zoomOutButton = button("−", "small", () => editor.zoom(1 / 1.6));
const zoomAllButton = button("全体", "small", () => editor.zoomAll());
const zoomRangeButton = button("選択 / 範囲に合わせる", "small", () => {
  if (selection) editor.zoomToRange(selection.from, selection.to);
  else if (markers) editor.zoomToRange(markers.rangeStart, markers.rangeEnd);
});
const zoomLabel = el("span", { className: "fine num" });
zoomInButton.ariaLabel = "拡大";
zoomOutButton.ariaLabel = "縮小";
editor.onViewChange = (view) => {
  const whole = view.end - view.start >= view.total - 1e-6;
  zoomLabel.textContent = whole ? "" : `${view.start.toFixed(2)}–${view.end.toFixed(2)} 秒を表示中`;
  zoomAllButton.disabled = whole;
};

const materialPanel = el("section", { className: "panel" }, [
  cutBar,
  el("div", { className: "editor-bar" }, [
    el("div", { className: "root-box" }, [el("span", { className: "fine", textContent: "判定した音程" }), rootLabel, rootSource]),
    el("div", { className: "row tight" }, [playOriginalButton, playResultButton, el("span", { className: "spacer" }), zoomOutButton, zoomInButton, zoomRangeButton, zoomAllButton, zoomLabel]),
  ]),
  el("p", { className: "fine hint", textContent: "両端のハンドルで鳴らす範囲を切り出し、帯の端で頭部(伸ばさない)・持続区間(伸ばす)・語尾を直せます。点線(判定)は上下にドラッグで半音ずつ、Alt でセント単位、ダブルクリックで最寄りの半音に。拡大は Ctrl + ホイールかピンチ、横スクロールはホイールか 2 本指。削除した範囲は詰めて表示され、✂ の点線が継ぎ目です。" }),
  editor.element,
  el("p", { className: "legend fine" }, [
    el("span", { className: "swatch original" }), "元のピッチ  ",
    el("span", { className: "swatch edited" }), "整えたあと(選んだ音名で鳴らしたとき)",
  ]),
  fixBar,
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
  songPanel.noteChanged();
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

// Speeds (VocalShifter's TIME, as one factor per part) and the vibrato (VIB), in the open where they are reached for.
const stretchFormat = (v: number) => `×${v.toFixed(2)}`;
const sustainStretchRow = range("持続区間の速度(ワンショットのとき)", 0.25, 8, 0.05, () => params.stretch.sustain, (p, v) => (p.stretch.sustain = v), stretchFormat);
const timePanel = el("details", { className: "sub" }, [
  el("summary", { textContent: "速度(頭部は等速のまま、など)" }),
  el("p", { className: "fine", textContent: "各部分の長さの倍率。1.00 が録音のまま。持続区間は普段「音の長さまで伸ばす」ので、倍率が効くのはワンショット(伸ばさない)のときだけです。" }),
  range("頭部の速度", 0.25, 4, 0.05, () => params.stretch.head, (p, v) => (p.stretch.head = v), stretchFormat),
  sustainStretchRow,
  range("語尾の速度", 0.25, 4, 0.05, () => params.stretch.tail, (p, v) => (p.stretch.tail = v), stretchFormat),
]);
const vibratoPanel = el("details", { className: "sub" }, [
  el("summary", { textContent: "ビブラート" }),
  range("深さ", 0, 100, 1, () => params.wobble.vibratoCents, (p, v) => (p.wobble.vibratoCents = v), (v) => `${v}¢`),
  range("速さ", 3, 9, 0.1, () => params.wobble.vibratoHz, (p, v) => (p.wobble.vibratoHz = v), (v) => `${v.toFixed(1)} Hz`),
  range("かかり始め(音の頭から)", 0, 1, 0.01, () => params.wobble.vibratoDelaySec, (p, v) => (p.wobble.vibratoDelaySec = v), ms),
]);

// Which parts of the material play: switches in the colours of the editor's bands.
// (The head always plays; switching a part keeps the preset.)
function partSwitch(label: string, band: string, get: () => boolean, set: (p: InstrumentParams, on: boolean) => void): HTMLButtonElement {
  const b = el("button", { type: "button", className: "part-switch" });
  b.style.setProperty("--part", `var(${band})`);
  b.setAttribute("role", "switch");
  const refresh = () => {
    const on = get();
    b.setAttribute("aria-checked", String(on));
    b.replaceChildren(el("span", { className: "part-name", textContent: label }), el("span", { className: "part-state", textContent: on ? "ON" : "OFF" }));
  };
  b.addEventListener("click", () => {
    update((p) => set(p, !get()), true);
    refresh();
    refreshPartsHelp();
  });
  controlsRefreshers.push(refresh);
  return b;
}
const partsHelp = el("p", { className: "fine help" });
function refreshPartsHelp(): void {
  const sustain = params.sustainEnabled;
  const tail = params.tail.enabled;
  partsHelp.textContent = sustain
    ? tail
      ? "押している間は持続区間で伸ばし、離すと語尾が鳴ります。書き出す WAV は、指定した長さのあとに語尾が付きます。"
      : "押している間は持続区間で伸ばし、離すと短くフェードして終わります。"
    : tail
      ? "頭部のあと、すぐ語尾が鳴って終わります(押している長さに関係なく)。"
      : "頭部だけ鳴って終わります(押している長さに関係なく)。";
}
controlsRefreshers.push(refreshPartsHelp);
const partsRow = el("div", { className: "parts-row" }, [
  el("span", { className: "control-label", textContent: "鳴らす部分" }),
  el("span", { className: "part-fixed", textContent: "頭部" }),
  partSwitch("持続区間", "--band-sustain", () => params.sustainEnabled, (p, on) => (p.sustainEnabled = on)),
  partSwitch("語尾", "--band-tail", () => params.tail.enabled, (p, on) => (p.tail = { ...p.tail, enabled: on })),
]);

const tunePanel = el("section", { className: "panel tune" }, [
  el("div", { className: "note-row" }, [el("span", { className: "control-label", textContent: "音名" }), noteStep("−", -1), noteSelect, noteStep("+", 1), noteAutoButton, noteShift]),
  partsRow,
  partsHelp,
  range("平坦化(抑揚の残し具合)", 0, 1, 0.01, () => params.flatten, (p, v) => (p.flatten = v), pct),
  el("label", { className: "control preset" }, [el("span", { className: "control-label", textContent: "プリセット" }), presetSelect]),
  lengthBlock,
  vibratoPanel,
  timePanel,
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

// ---------------------------------------------------------------- panel 3b: effects

// Each effect folds into its own group; its summary says whether it is on.
// Changing an effect keeps the preset (presets are about the voice, not the rack).
type FxKey = keyof FxSettings;
const fxSummaries: { key: FxKey; summary: HTMLElement; label: string }[] = [];
const db = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
const hz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} kHz` : `${Math.round(v)} Hz`);
const BEATS: [string, string][] = [
  ["0.25", "1/16 音符"],
  ["0.5", "1/8 音符"],
  ["1", "1 拍"],
  ["2", "2 拍"],
  ["4", "1 小節"],
  ["8", "2 小節"],
];

/** A log-scaled frequency slider (0–1000 on the slider, `lo`–`hi` Hz); with `off`, its end reads as off. */
function fxFreq(label: string, lo: number, hi: number, get: () => number, set: (p: InstrumentParams, v: number) => void, off?: { at: number; text: string }): HTMLElement {
  const toPos = (f: number) => (1000 * Math.log(f / lo)) / Math.log(hi / lo);
  const toHz = (pos: number) => lo * (hi / lo) ** (pos / 1000);
  const isOff = (pos: number) => off !== undefined && Math.abs(toHz(pos) - off.at) / off.at < 0.02;
  return range(
    label,
    0,
    1000,
    1,
    () => toPos(Math.max(lo, Math.min(hi, get() || lo))),
    (p, v) => set(p, isOff(v) ? off!.at : Math.round(toHz(v))),
    (v) => (isOff(v) ? off!.text : hz(toHz(v))),
    true,
  );
}

function fxGroup(key: FxKey, label: string, note: string, controls: HTMLElement[]): HTMLElement {
  const summary = el("summary");
  fxSummaries.push({ key, summary, label });
  const group = el("details", { className: "sub fx" }, [
    summary,
    check("オン", () => params.fx[key].on, (p, v) => (p.fx[key].on = v), true),
    el("p", { className: "fine help", textContent: note }),
    ...controls,
  ]);
  // (The control's own listener has updated the params by the time this bubbles up.)
  group.addEventListener("change", refreshFxSummaries);
  return group;
}

const fxActiveLine = el("p", { className: "fine fx-active" });
function refreshFxSummaries(): void {
  const on: string[] = [];
  for (const { key, summary, label } of fxSummaries) {
    const active = params.fx[key].on;
    summary.textContent = active ? `${label}(オン)` : label;
    summary.classList.toggle("on", active);
    if (active) on.push(label.replace(/\(.*\)$/, ""));
  }
  const fades: string[] = [];
  if (params.amp.attack >= 0.02) fades.push(`入り ${ms(params.amp.attack)}`);
  if (params.amp.fadeOut > 0) fades.push(`終わり ${ms(params.amp.fadeOut)}`);
  fadeSummary.textContent = fades.length ? `フェード(${fades.join("・")})` : "フェード(入り・終わり)";
  fadeSummary.classList.toggle("on", fades.length > 0);
  const all = [...(fades.length ? ["フェード"] : []), ...on];
  fxActiveLine.textContent = all.length ? `オン: ${all.join("、")}` : "すべてオフ(素材の音そのまま)";
}

/** A heading between the groups: the effects come in the order they are applied, in sections. */
function fxHead(text: string): HTMLElement {
  return el("h3", { className: "fx-head", textContent: text });
}

// フェード: the voice's own attack and a fade before the material runs out — not in the rack, but where it reads best.
const fadeSummary = el("summary");
const fadeGroup = el("details", { className: "sub fx" }, [
  fadeSummary,
  el("p", { className: "fine help", textContent: "入りは音の頭から、終わりは素材が尽きる手前(語尾の最後、または頭部だけのとき)と、音を離したあとにかかります。0 でなし。「書き出し後」レーンの水位に出ます。" }),
  range("入りのフェード", 0, 2, 0.005, () => params.amp.attack, (p, v) => (p.amp.attack = Math.max(0.001, v)), ms, true),
  range("終わりのフェード", 0, 3, 0.01, () => params.amp.fadeOut, (p, v) => (p.amp.fadeOut = v), ms, true),
]);
fadeGroup.addEventListener("change", refreshFxSummaries);
controlsRefreshers.push(refreshFxSummaries);

const fxResetButton = button("すべてオフに戻す", "small", () => {
  update((p) => {
    p.fx = structuredClone(DEFAULT_FX);
    p.amp = { ...p.amp, attack: DEFAULT_PARAMS.amp.attack, fadeOut: DEFAULT_PARAMS.amp.fadeOut };
  }, true);
  refreshControls();
});

const fxPanel = el("section", { className: "panel fx-panel" }, [
  el("div", { className: "row" }, [el("span", { className: "control-label", textContent: "エフェクト" }), fxResetButton]),
  fxActiveLine,
  el("p", { className: "fine", textContent: "上から順にかかります。試し弾き・「曲で試す」・書き出す WAV のすべてに入ります(Vital 用ウェーブテーブルを除く)。区間ごとの設定です。" }),
  fxHead("音量と立ち上がり"),
  fadeGroup,
  fxGroup("transient", "トランジェント(立ち上がり)", "音の頭(アタック)と、そのあとの伸び(サステイン)を別々に上げ下げします。", [
    range("アタック", -12, 12, 0.5, () => params.fx.transient.attackDb, (p, v) => (p.fx.transient.attackDb = v), db, true),
    range("サステイン", -12, 12, 0.5, () => params.fx.transient.sustainDb, (p, v) => (p.fx.transient.sustainDb = v), db, true),
  ]),
  fxHead("音色"),
  fxGroup("eq", "EQ", "低域カット・低域・中域(ベル)・高域・高域カット。", [
    fxFreq("低域カット", 20, 2000, () => params.fx.eq.lowCutHz, (p, v) => (p.fx.eq.lowCutHz = v <= 20 ? 0 : v), { at: 20, text: "オフ" }),
    range("低域", -18, 18, 0.5, () => params.fx.eq.lowDb, (p, v) => (p.fx.eq.lowDb = v), db, true),
    fxFreq("低域の周波数", 20, 1000, () => params.fx.eq.lowHz, (p, v) => (p.fx.eq.lowHz = v)),
    range("中域", -18, 18, 0.5, () => params.fx.eq.midDb, (p, v) => (p.fx.eq.midDb = v), db, true),
    fxFreq("中域の周波数", 100, 10000, () => params.fx.eq.midHz, (p, v) => (p.fx.eq.midHz = v)),
    range("中域の幅(Q)", 0.3, 8, 0.1, () => params.fx.eq.midQ, (p, v) => (p.fx.eq.midQ = v), (v) => v.toFixed(1), true),
    range("高域", -18, 18, 0.5, () => params.fx.eq.highDb, (p, v) => (p.fx.eq.highDb = v), db, true),
    fxFreq("高域の周波数", 1000, 18000, () => params.fx.eq.highHz, (p, v) => (p.fx.eq.highHz = v)),
    fxFreq("高域カット", 500, 20000, () => params.fx.eq.highCutHz, (p, v) => (p.fx.eq.highCutHz = v), { at: 20000, text: "オフ" }),
  ]),
  fxGroup("saturation", "サチュレーション(真空管風の歪み)", "音を太く前に出します。かけすぎると歪みが目立ちます。", [
    range("ドライブ", 0, 1, 0.01, () => params.fx.saturation.drive, (p, v) => (p.fx.saturation.drive = v), pct, true),
    range("かかり具合(ミックス)", 0, 1, 0.01, () => params.fx.saturation.mix, (p, v) => (p.fx.saturation.mix = v), pct, true),
  ]),
  fxGroup("air", "エア(高域の抜け)", "高い音を持ち上げ、少し倍音を足して抜けをよくします。上げすぎると耳に痛くなります。", [
    range("量", 0, 1, 0.01, () => params.fx.air.amount, (p, v) => (p.fx.air.amount = v), pct, true),
  ]),
  fxHead("飛び道具"),
  fxGroup("filter", "フィルター(LFO)", "カットオフを拍に合わせて揺らします。揺れの幅を 0 にすれば、ふつうのフィルターです。", [
    select("種類", [["lowpass", "ローパス"], ["highpass", "ハイパス"], ["bandpass", "バンドパス"]], () => params.fx.filter.type, (p, v) => (p.fx.filter.type = v), true),
    fxFreq("カットオフ", 40, 18000, () => params.fx.filter.cutoffHz, (p, v) => (p.fx.filter.cutoffHz = v)),
    range("レゾナンス", 0, 1, 0.01, () => params.fx.filter.resonance, (p, v) => (p.fx.filter.resonance = v), pct, true),
    range("揺れの幅", 0, 6, 0.1, () => params.fx.filter.lfoOctaves, (p, v) => (p.fx.filter.lfoOctaves = v), (v) => `±${v.toFixed(1)} オクターブ`, true),
    select("揺れの周期", BEATS, () => String(params.fx.filter.lfoBeats), (p, v) => (p.fx.filter.lfoBeats = Number(v) as FxBeats), true),
  ]),
  fxGroup("crush", "ビットクラッシャー", "ビット数とサンプリングレートを落として、ゲーム機のようなざらついた音にします。", [
    range("ビット数", 1, 16, 1, () => params.fx.crush.bits, (p, v) => (p.fx.crush.bits = v), (v) => `${v} bit`, true),
    range("間引き", 1, 32, 1, () => params.fx.crush.downsample, (p, v) => (p.fx.crush.downsample = v), (v) => (v === 1 ? "なし" : `1/${v}`), true),
    range("かかり具合(ミックス)", 0, 1, 0.01, () => params.fx.crush.mix, (p, v) => (p.fx.crush.mix = v), pct, true),
  ]),
  fxHead("広がり"),
  fxGroup("chorus", "コーラス", "少しずらした音を左右に重ねて、厚みと広がりを出します。モノラルの素材もステレオになります。", [
    range("速さ", 0.1, 5, 0.05, () => params.fx.chorus.rateHz, (p, v) => (p.fx.chorus.rateHz = v), (v) => `${v.toFixed(2)} Hz`, true),
    range("深さ", 0, 12, 0.1, () => params.fx.chorus.depthMs, (p, v) => (p.fx.chorus.depthMs = v), (v) => `${v.toFixed(1)} ms`, true),
    range("かかり具合(ミックス)", 0, 1, 0.01, () => params.fx.chorus.mix, (p, v) => (p.fx.chorus.mix = v), pct, true),
  ]),
  fxGroup("width", "ステレオ幅(ミッド/サイド)", "左右の広がり(サイド)と中央(ミッド)を別々に調整します。モノラルの素材は広がらないので、コーラスと組み合わせます。", [
    range("広がり(サイド)", 0, 3, 0.01, () => params.fx.width.side, (p, v) => (p.fx.width.side = v), (v) => (v === 0 ? "モノラル" : pct(v)), true),
    range("中央(ミッド)", -12, 6, 0.5, () => params.fx.width.midDb, (p, v) => (p.fx.width.midDb = v), db, true),
  ]),
  fxGroup("pan", "オートパン", "音を拍に合わせて左右に振ります。アルペジオなどに。", [
    range("深さ", 0, 1, 0.01, () => params.fx.pan.depth, (p, v) => (p.fx.pan.depth = v), pct, true),
    select("周期", BEATS, () => String(params.fx.pan.beats), (p, v) => (p.fx.pan.beats = Number(v) as FxBeats), true),
  ]),
  fxHead("仕上げ"),
  fxGroup("limiter", "リミッター", "最後に音量を上げつつ、天井を超えないように抑えます。", [
    range("入力ゲイン", 0, 18, 0.5, () => params.fx.limiter.gainDb, (p, v) => (p.fx.limiter.gainDb = v), db, true),
    range("天井", -12, 0, 0.1, () => params.fx.limiter.ceilingDb, (p, v) => (p.fx.limiter.ceilingDb = v), (v) => `${v.toFixed(1)} dBFS`, true),
    range("リリース", 5, 500, 1, () => params.fx.limiter.releaseMs, (p, v) => (p.fx.limiter.releaseMs = v), (v) => `${Math.round(v)} ms`, true),
  ]),
]);

// ---------------------------------------------------------------- panel 4: export

const FORMATS: { id: ExportFormat; label: string; note: string }[] = [
  { id: "single", label: "単音 WAV", note: "1本の WAV。どのサンプラーでも読み込めます。" },
  { id: "loop", label: "ループ WAV(ループ点入り)", note: "持続区間を長めに作り、ループ範囲を WAV に埋め込みます(smpl)。ループ点を読むサンプラー(Logic、Kontakt、sforzando など)では、いくらでも伸ばせます。" },
  { id: "multisample", label: "マルチサンプル音源(zip: SFZ + Decent Sampler)", note: "±1 オクターブを 3 半音おきに、それぞれの高さで作った WAV と、.sfz / .dspreset の定義を zip にまとめます。高音で途切れず、低音で間延びしません。" },
  { id: "wavetable", label: "Vital 用ウェーブテーブル(WAV)", note: "持続区間の 1 周期ずつを 2048 サンプルに揃えて並べた WAV(最大 256 フレーム)。Vital の OSC に「Import as Wavetable」で読み込むと、素材の声色そのものをウェーブテーブルとして掃引できます。音名と長さは使いません。" },
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
    help: (_n, format) =>
      format === "wavetable"
        ? "OSC の波形表示のメニューから Import as Wavetable を選び、この WAV を読み込みます(1 フレーム = 2048 サンプル)。ウェーブテーブル位置(Frame)を LFO やエンベロープで動かすと、声色が時間方向に変わります。"
        : "WAV を OSC にドラッグし、ピッチモードを Pitch Splice にします。LFO やエンベロープで再生位置を動かすと、サンプラーのように使えます。",
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
    else if (s.destination === "garageband" && (s.format === "multisample" || s.format === "wavetable")) s.format = "single";
    else if (s.destination === "vital" && s.format === "multisample") s.format = "wavetable";
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
  const hadCorrections = material.corrections.length > 0;
  material.corrections = [];
  freshCuts();
  exportSettings = structuredClone(DEFAULT_EXPORT);
  applyCurrentCut();
  if (hadCorrections) void setCorrections([]);
  else refreshFixBar();
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
      select("持続区間の伸ばし方", [["pool", "周期プール(自然)"], ["loop", "ループ"], ["wavetable", "ウェーブテーブル(1〜数周期の繰り返し、無機質)"], ["none", "伸ばさない(ワンショット)"]], () => params.sustainMode, (p, v) => (p.sustainMode = v)),
      range("ウェーブテーブルの周期数", 1, 8, 1, () => params.wavetableCycles, (p, v) => (p.wavetableCycles = v), (v) => `${v} 周期`),
      select(
        "語尾の長さ",
        [
          ["unlimited", "最後まで"],
          ["beat", "1 拍まで"],
          ["bar", "1 小節(4 拍)まで"],
        ],
        () => (params.tail.limit === "none" ? "unlimited" : params.tail.limit),
        (p, v) => (p.tail = { enabled: p.tail.enabled, limit: v }),
      ),
      el("p", { className: "fine help", textContent: "拍は「長さ」の BPM で数えます(「曲で試す」の再生中は曲の BPM)。上限に来た語尾は短くフェードして切れます。" }),
      range("フォルマント", -6, 6, 0.1, () => params.formantSemitones, (p, v) => (p.formantSemitones = v), semis),
      check("大きな移調で声質を少し追従させる", () => params.formantFollow, (p, v) => (p.formantFollow = v)),
    ]),
    el("fieldset", {}, [
      el("legend", { textContent: "揺らぎ(ビブラートは上の「ビブラート」で)" }),
      range("ゆっくりした揺れ", 0, 30, 1, () => params.wobble.driftCents, (p, v) => (p.wobble.driftCents = v), (v) => `${v}¢`),
      check("細かい揺れ(平坦でも機械的にしない)", () => params.wobble.micro, (p, v) => (p.wobble.micro = v)),
    ]),
    el("fieldset", {}, [
      el("legend", { textContent: "エンベロープ" }),
      range("アタック(= 入りのフェード)", 0.001, 0.5, 0.001, () => params.amp.attack, (p, v) => (p.amp.attack = v), ms),
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

// ---------------------------------------------------------------- long clips: pick a stretch first

/** The long file last opened (kept as a File, not as audio, so another stretch can be picked later). */
let longClip: { file: File; truncated: boolean } | null = null;
/** The decoded long clip while the picker is open; dropped once a stretch is taken. */
let pickerClip: { channels: Float32Array[]; sampleRate: number } | null = null;

const picker = new RangePicker();
const pickerTitle = el("p", { className: "picker-title" });
const pickerRange = el("span", { className: "num" });
const pickerListen = button("▶ 選択範囲を聴く", "", () => {
  if (!pickerClip) return;
  const r = picker.value;
  const rate = pickerClip.sampleRate;
  client.playBuffer(pickerClip.channels.map((c) => c.slice(Math.round(r.from * rate), Math.round(r.to * rate))), rate);
});
const pickerUse = button("この範囲を使う", "primary", () => void usePickedRange());
const pickerPanel = el("section", { className: "panel picker-panel", hidden: true }, [
  pickerTitle,
  picker.element,
  el("div", { className: "row" }, [el("span", { className: "fine" }, ["使う範囲: ", pickerRange]), pickerListen, pickerUse]),
  el("p", { className: "fine", textContent: "ハンドルをドラッグして範囲を決めます。帯の中をドラッグすると範囲ごと動き、外をタップするとそこへ移ります。一度に使えるのは 60 秒までですが、あとから「別の範囲を選ぶ」で何度でも選び直せます。" }),
]);
picker.onChange = (r) => (pickerRange.textContent = `${clock(r.from)} – ${clock(r.to)}(${(r.to - r.from).toFixed(1)} 秒)`);
const rePickButton = button("別の範囲を選ぶ", "", () => void rePick());
rePickButton.hidden = true;

function showPicker(name: string, channels: Float32Array[], sampleRate: number): void {
  pickerClip = { channels, sampleRate };
  const total = channels[0].length / sampleRate;
  pickerTitle.replaceChildren(el("strong", { textContent: `「${name}」は ${clock(total)} あります。` }), ` 使う範囲(最大 ${MAX_MATERIAL_SEC} 秒)を選んでください。`);
  picker.setClip(mixToMono(channels), sampleRate, MAX_MATERIAL_SEC);
  picker.onChange(picker.value, true);
  emptyState.hidden = true;
  workspace.hidden = true;
  pickerPanel.hidden = false;
  status.textContent = longClip?.truncated ? `長いので最初の ${MAX_DECODE_SEC / 60} 分だけを読み込みました。` : "";
}

async function usePickedRange(): Promise<void> {
  if (!pickerClip || !longClip) return;
  const r = picker.value;
  const rate = pickerClip.sampleRate;
  const channels = pickerClip.channels.map((c) => c.slice(Math.round(r.from * rate), Math.round(r.to * rate)));
  pickerClip = null; // the whole clip is not needed any more
  pickerPanel.hidden = true;
  const base = longClip.file.name.replace(/\.[^.]+$/, "");
  await load(`${base} (${clock(r.from)}-${clock(r.to)})`, channels, rate);
  rePickButton.hidden = false;
}

/** Decodes the long file again and shows the picker, with the stretch in use selected. */
async function rePick(): Promise<void> {
  if (!longClip) return;
  status.textContent = `「${longClip.file.name}」を読み込んでいます…`;
  try {
    const { channels, sampleRate } = await decode(longClip.file);
    const current = material?.name.match(/\((\d+):(\d+(?:\.\d)?)-(\d+):(\d+(?:\.\d)?)\)$/);
    showPicker(longClip.file.name, channels, sampleRate);
    if (current) picker.setRange({ from: Number(current[1]) * 60 + Number(current[2]), to: Number(current[3]) * 60 + Number(current[4]) });
    picker.onChange(picker.value, true);
  } catch (error) {
    status.textContent = `読み込めませんでした: ${error instanceof Error ? error.message : error}`;
  }
}

// ---------------------------------------------------------------- several files at once: the queue (ワンショット一括)

interface QueueItem {
  file: File;
  /** What is known about it so far (filled in when opened or analysed for a batch). */
  info: string;
}

let queue: QueueItem[] = [];
let queueIndex = -1;

const queueList = el("ol", { className: "queue-list" });
const queueOneShot = el("input", { type: "checkbox", checked: true });
const queueFirstKey = el("select", { ariaLabel: "キットの最初の鍵" }, [24, 36, 48, 60].map((n) => el("option", { value: String(n), textContent: pitchLabel(n), selected: n === 36 })));
const queueWavsButton = button("すべて単音 WAV で保存(zip)", "", () => void deliverQueue("wavs"));
const queueKitButton = button("キット音源にする(zip: SFZ + Decent Sampler)", "primary", () => void deliverQueue("kit"));
const queueStatus = el("p", { className: "fine", role: "status" });
const queuePanel = el("section", { className: "panel queue-panel", hidden: true }, [
  el("div", { className: "row" }, [el("strong", { textContent: "素材リスト" }), el("span", { className: "fine", textContent: "1 つずつ開いて調整できます(設定は素材ごとに残ります)。調整していないものは、そのまま一括で書き出せます。" })]),
  queueList,
  el("div", { className: "row" }, [
    el("label", { className: "control check" }, [queueOneShot, el("span", { textContent: "調整していない素材はワンショット(録音のまま、伸ばさない)として扱う" })]),
  ]),
  el("div", { className: "row" }, [queueWavsButton, queueKitButton, el("label", { className: "row tight" }, [el("span", { className: "fine", textContent: "キットの最初の鍵" }), queueFirstKey])]),
  queueStatus,
]);

function renderQueue(): void {
  queuePanel.hidden = queue.length < 2;
  queueList.replaceChildren(
    ...queue.map((item, i) => {
      const open = button(i === queueIndex ? "開いています" : "開く", "small", () => void openQueueItem(i));
      open.disabled = i === queueIndex;
      const remove = button("外す", "small", () => {
        queue.splice(i, 1);
        if (queueIndex === i) queueIndex = -1;
        else if (queueIndex > i) queueIndex--;
        renderQueue();
      });
      return el("li", { className: i === queueIndex ? "current" : "" }, [el("span", { className: "queue-name", textContent: item.file.name }), el("span", { className: "fine", textContent: item.info }), open, remove]);
    }),
  );
}

async function openQueueItem(i: number): Promise<void> {
  if (!queue[i]) return;
  queueIndex = i;
  renderQueue();
  await openFile(queue[i].file);
  if (material) queue[i].info = `${material.analysis.durationSec.toFixed(2)} 秒 / ${cuts.map((c) => (c.params.sustainMode === "none" ? "ワンショット" : pitchLabel(c.note))).join("・")}`;
  renderQueue();
}

/** Every item as build inputs: the open one from the editor, the others analysed now (with their stored settings when they have any). */
async function queueInputs(): Promise<{ inputs: BuildInput[]; skipped: string[] }> {
  const inputs: BuildInput[] = [];
  const skipped: string[] = [];
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    queueStatus.textContent = `${i + 1} / ${queue.length}: 「${item.file.name}」を解析しています…`;
    await yieldToScreen();
    if (i === queueIndex && material) {
      syncCut();
      const source = exportSource();
      inputs.push(...cuts.map((cut) => inputFor(cut, source)));
      continue;
    }
    try {
      const { channels, sampleRate } = await decode(item.file);
      if (channels[0].length / sampleRate > MAX_MATERIAL_SEC) {
        skipped.push(`${item.file.name}(${MAX_MATERIAL_SEC} 秒を超えるので、開いて範囲を選んでから)`);
        item.info = "長いので、開いて範囲を選んでください";
        continue;
      }
      let { analysis, source } = await client.analyze(channels, sampleRate, sampleRate);
      const stored = safeStorage(settingsKey(item.file.name, channels[0].length, sampleRate));
      let file: SettingsFile | null = null;
      if (stored) {
        try {
          file = parseSettings(stored);
        } catch {
          file = null;
        }
      }
      if (file?.corrections.length) {
        ({ analysis, source } = await client.analyze(channels, sampleRate, sampleRate, applyCorrections(analysis.track, file.corrections)));
      }
      const itemCuts: CutSettings[] = file
        ? file.cuts.map((c) => ({ ...c, markers: clampMarkers({ ...c.markers, rangeEnd: Math.min(c.markers.rangeEnd, analysis.durationSec) }) }))
        : [cutFor(analysis.track, analysis.markers, "区間 1", DEFAULT_PARAMS, "synth", queueOneShot.checked)];
      const itemCredit = file?.credit ?? { title: "", url: "", timecode: "", memo: "" };
      const base = safeBaseName(item.file.name);
      for (const cut of itemCuts) {
        inputs.push({ baseName: itemCuts.length > 1 ? `${base}_${cut.name}` : base, source, cut, settings: { ...exportSettings, format: "single" }, credit: itemCredit });
      }
      item.info = `${analysis.durationSec.toFixed(2)} 秒 / ${itemCuts.map((c) => (c.params.sustainMode === "none" ? "ワンショット" : pitchLabel(c.note))).join("・")}${file ? "(調整済み)" : ""}`;
    } catch (error) {
      skipped.push(`${item.file.name}(${error instanceof Error ? error.message : error})`);
      item.info = "読み込めませんでした";
    }
    renderQueue();
  }
  return { inputs, skipped };
}

async function deliverQueue(kind: "wavs" | "kit"): Promise<void> {
  if (building || queue.length === 0) return;
  building = true;
  try {
    const { inputs, skipped } = await queueInputs();
    if (inputs.length === 0) {
      queueStatus.textContent = `書き出せるものがありません。${skipped.join("、")}`;
      return;
    }
    const progress = async (done: number, total: number) => {
      queueStatus.textContent = `作成中… ${done} / ${total}`;
      await yieldToScreen();
    };
    const kitName = `${safeBaseName(queue[0].file.name)}_kit`;
    const built = kind === "kit" ? await buildKit(inputs, kitName, Number(queueFirstKey.value), progress) : await buildBatch(inputs, null, `${safeBaseName(queue[0].file.name)}_など${queue.length}件`, progress);
    let outcome = "";
    if (canShareFiles()) {
      try {
        outcome = (await shareFile(built.blob, built.fileName, built.fileName)) === "shared" ? "共有しました" : "";
      } catch {
        outcome = "";
      }
    }
    if (!outcome) {
      downloadFile(built.blob, built.fileName);
      outcome = "保存しました";
    }
    queueStatus.textContent = `${outcome}: ${built.summary}${skipped.length ? ` — 飛ばしたもの: ${skipped.join("、")}` : ""}`;
  } catch (error) {
    queueStatus.textContent = `書き出せませんでした: ${error instanceof Error ? error.message : error}`;
  } finally {
    building = false;
  }
}

/** Files dropped or chosen: one opens; several make a queue and open the first. Settings and MIDI files are read on their own. */
function openFiles(files: readonly File[]): void {
  const isSettings = (f: File) => f.name.toLowerCase().endsWith(".json") || f.type === "application/json";
  const settings = files.filter(isSettings);
  const midi = files.filter((f) => !isSettings(f) && isMidiFile(f));
  const audio = files.filter((f) => !isSettings(f) && !isMidiFile(f));
  const lastMidi = midi.at(-1);
  if (lastMidi) {
    void songPanel.open(lastMidi);
    if (!material && audio.length === 0) status.textContent = `${lastMidi.name} を読み込みました。素材を開くと「曲で試す」で鳴らせます。`;
  }
  for (const f of settings) void openFile(f);
  if (audio.length === 0) return;
  if (audio.length === 1 && queue.length === 0) {
    void openFile(audio[0]);
    return;
  }
  // Add to the list (a single file dropped while a list exists joins it).
  const known = new Set(queue.map((q) => `${q.file.name}:${q.file.size}`));
  for (const f of audio) if (!known.has(`${f.name}:${f.size}`)) queue.push({ file: f, info: "" });
  renderQueue();
  if (queueIndex < 0) void openQueueItem(queue.length - audio.length);
}

// ---------------------------------------------------------------- page

const workspace = el("main", { className: "workspace", hidden: true }, [guide, materialPanel, tunePanel, keysPanel, fxPanel, songPanel.element, exportPanel, detailsPanel]);

document.getElementById("app")!.append(
  el("header", { className: "top" }, [el("h1", { textContent: "MADDAW" }), el("div", { className: "row" }, [rePickButton, openButton, demoButton])]),
  fileInput,
  status,
  emptyState,
  queuePanel,
  pickerPanel,
  workspace,
);

// ---------------------------------------------------------------- cuts

function cutFromAnalysis(m: Markers, name: string, base: InstrumentParams): Cut {
  return cutFor(material?.analysis.track ?? null, m, name, base, presetId || "synth", false);
}

/** A cut set up from an analysis: pitched → the preset hint (or "synth"), unpitched or forced → a one-shot from C4 / its own pitch. */
function cutFor(track: PitchTrack | null, m: Markers, name: string, base: InstrumentParams, hint: PresetId | "", forceOneShot: boolean): Cut {
  const root = track ? rootForMarkers(track, m) : null;
  const p = structuredClone(base);
  let preset: PresetId | "" = hint || "synth";
  if (root && !forceOneShot) {
    p.root = root.midi;
    p.rootMode = "auto";
    if (preset === "drum") {
      Object.assign(p, PRESETS.find((x) => x.id === "synth")!.apply(p));
      preset = "synth";
    }
  } else {
    // Nothing pitched (a hit, a noise), or a one-shot by request: plays as recorded, from its own pitch (C4 when there is none).
    p.root = root?.midi ?? 60;
    p.rootMode = root ? "auto" : "manual";
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
  // The tail limit counts in the export BPM (the song's own while one plays).
  if (!songPanel.playing) client.setTempo(exportSettings.bpm);
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
  const held = exportLengthSec(exportSettings);
  const wavetable = exportSettings.format === "wavetable" && !oneShot;
  lengthBlock.classList.toggle("disabled", oneShot || wavetable);
  lengthResult.textContent = oneShot
    ? "ワンショット: 素材の長さのまま"
    : wavetable
      ? "ウェーブテーブル: 長さは使いません(鍵盤では使われます)"
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

  if (markers) {
    editor.setParts({ sustain: params.sustainEnabled, tail: params.tail.enabled && params.tail.limit !== "none" });
    editor.setState(markers, params.root, params.flatten, note);
    editor.setLayout(
      outputLayout(markers, params, held),
      params.wobble.vibratoCents > 0 ? { depthCents: params.wobble.vibratoCents, rateHz: params.wobble.vibratoHz, delaySec: params.wobble.vibratoDelaySec } : null,
      {
        attackSec: params.amp.attack,
        decaySec: params.amp.decay,
        sustain: params.amp.sustain,
        // Without a tail the file ends on the release (never shorter than the fade); with one, the fade runs out with the material.
        fadeOutSec: params.tail.enabled && params.tail.limit !== "none" ? params.amp.fadeOut : Math.max(params.amp.release, params.amp.fadeOut),
      },
    );
  }
  sustainStretchRow.classList.toggle("disabled", !oneShot);
  refreshFixBar();
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
  if (exportSettings.format === "wavetable") return `${base}_wavetable.wav`;
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

/** What is playing right now, for the playhead: the result (output time) or the original (display time, offset by where the range starts). */
let playing: { kind: "result" } | { kind: "original"; displayStart: number } | null = null;
let playheadFrame = 0;

function trackPlayhead(): void {
  cancelAnimationFrame(playheadFrame);
  const step = () => {
    const pos = client.previewPosition();
    if (pos === null || !playing) {
      editor.setPlayhead(null);
      return;
    }
    editor.setPlayhead(playing.kind === "result" ? { kind: "output", sec: pos } : { kind: "display", sec: playing.displayStart + pos });
    playheadFrame = requestAnimationFrame(step);
  };
  playheadFrame = requestAnimationFrame(step);
}

function showPlaying(): void {
  const result = playing?.kind === "result";
  const original = playing?.kind === "original";
  listenButton.textContent = result ? "■ 停止" : "▶ 聴く";
  playResultButton.textContent = result ? "■ 停止" : "▶ 書き出し後";
  playOriginalButton.textContent = original ? "■ 停止" : "▶ 元の音";
}

/** The result from the head: the file as it will be written (a multisample's centre zone, a wavetable's sweep). */
async function listen(): Promise<void> {
  if (playing?.kind === "result") {
    client.stopPreview();
    return;
  }
  songPanel.stop();
  const result = await buildCurrent();
  if (!result) return;
  exportStatus.textContent = exportSettings.format === "multisample" ? `試聴: 中央の音(${pitchLabel(note)})` : "";
  playing = { kind: "result" };
  showPlaying();
  client.playBuffer(result.preview.channels, result.preview.sampleRate);
  trackPlayhead();
}

/** The material from the head, as recorded, within the range and minus the removed stretches (a short crossfade at each seam). */
async function playOriginal(): Promise<void> {
  if (playing?.kind === "original") {
    client.stopPreview();
    return;
  }
  if (!material || !markers) return;
  songPanel.stop();
  const rate = material.sampleRate;
  // Left out: the removed stretches and the parts switched off.
  const removed = normalizeRemoved([...(markers.removed ?? []), ...hiddenPartsOf(markers, params)], markers.rangeStart, markers.rangeEnd);
  const pieces: [number, number][] = [];
  let at = markers.rangeStart;
  for (const r of removed) {
    if (r.start > at) pieces.push([at, r.start]);
    at = Math.max(at, r.end);
  }
  if (markers.rangeEnd > at) pieces.push([at, markers.rangeEnd]);
  const fade = Math.round(0.005 * rate);
  const total = pieces.reduce((n, [a, b]) => n + Math.round((b - a) * rate), 0);
  const out = material.channels.map(() => new Float32Array(total));
  let cursor = 0;
  for (const [a, b] of pieces) {
    const from = Math.round(a * rate);
    const length = Math.round((b - a) * rate);
    for (let c = 0; c < out.length; c++) {
      const src = material.channels[c];
      for (let i = 0; i < length; i++) {
        let v = src[from + i] ?? 0;
        if (i < fade) v *= i / fade;
        if (length - 1 - i < fade) v *= (length - 1 - i) / fade;
        out[c][cursor + i] += v;
      }
    }
    cursor += length;
  }
  playing = { kind: "original", displayStart: editor.disp(markers.rangeStart) };
  showPlaying();
  client.playBuffer(out, rate);
  trackPlayhead();
}

client.onPreviewEnd = () => {
  playing = null;
  showPlaying();
  cancelAnimationFrame(playheadFrame);
  editor.setPlayhead(null);
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
    corrections: material!.corrections,
  };
}

// ---------------------------------------------------------------- hand corrections → a new analysis

async function addCorrection(c: PitchCorrection): Promise<void> {
  if (!material) return;
  selection = null;
  editor.setSelection(null);
  await setCorrections([...material.corrections, c]);
}

/**
 * Re-applies the corrections to the original analysis, finds the pitch marks
 * again from the corrected track (in the Worker), and swaps the sources the
 * engine and the export use. Cuts whose root is automatic follow.
 */
async function setCorrections(corrections: PitchCorrection[]): Promise<void> {
  if (!material) return;
  const target = material;
  target.corrections = corrections;
  status.textContent = corrections.length ? "手直しを反映しています…" : "判定を元に戻しています…";
  try {
    const track = applyCorrections(target.original.track, corrections);
    const { analysis, source } = await client.analyze(target.channels, target.sampleRate, undefined, track);
    if (material !== target) return; // another material was opened meanwhile
    // Keep the original's root/markers fields where they mean "fresh suggestion"; the track and marks are the corrected ones.
    target.analysis = analysis;
    target.source = source;
    target.exportSources = new Map([[source.sampleRate, source]]);
    client.setSource(source);
    editor.setMaterial({ mono: target.mono, sampleRate: target.sampleRate, track: analysis.track });
    for (const cut of cuts) {
      const root = rootForMarkers(analysis.track, cut.markers);
      cut.detectedRoot = root?.midi ?? null;
      if (cut.params.rootMode === "auto" && root) cut.params = { ...cut.params, root: root.midi };
    }
    applyCurrentCut();
    refreshFixBar();
    status.textContent = corrections.length ? `手直し ${corrections.length} 件を反映しました。判定 ${pitchLabel(params.root)}。` : "判定を元に戻しました。";
  } catch (error) {
    status.textContent = `手直しを反映できませんでした: ${error instanceof Error ? error.message : error}`;
  }
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
  if (file.corrections.length || material.corrections.length) void setCorrections(file.corrections);
  else refreshFixBar();
}

// ---------------------------------------------------------------- loading

async function decode(file: File): Promise<{ channels: Float32Array[]; sampleRate: number; truncated: boolean }> {
  const bytes = await file.arrayBuffer();
  // An offline context decodes without needing a user gesture.
  const context = new OfflineAudioContext(1, 1, 44100);
  const buffer = await context.decodeAudioData(bytes);
  const frames = Math.min(buffer.length, Math.round(MAX_DECODE_SEC * buffer.sampleRate));
  const channels = [...Array(Math.min(2, buffer.numberOfChannels)).keys()].map((c) => buffer.getChannelData(c).slice(0, frames));
  return { channels, sampleRate: buffer.sampleRate, truncated: frames < buffer.length };
}

async function load(name: string, channels: Float32Array[], sampleRate: number): Promise<void> {
  status.textContent = `「${name}」を解析しています…`;
  try {
    const { analysis, source, elapsedMs } = await client.analyze(channels, sampleRate);
    material = { name, channels, sampleRate, mono: mixToMono(channels), analysis, original: analysis, corrections: [], source, exportSources: new Map([[source.sampleRate, source]]) };
    selection = null;
    editor.setMaterial({ mono: material.mono, sampleRate, track: analysis.track });
    refreshFixBar();
    client.setSource(source);
    emptyState.hidden = true;
    workspace.hidden = false;

    const seconds = analysis.durationSec.toFixed(2);
    const root = analysis.root;
    let text =
      `「${name}」 ${seconds} 秒 — 解析 ${Math.round(elapsedMs)} ms。` +
      (root ? ` 音程 ${pitchLabel(root.midi)}(信頼度 ${Math.round(root.confidence * 100)}%)。` : " 音程が見つからなかったので、ワンショット(ドラム・効果音)として扱います。");
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
  longClip = null;
  pickerClip = null;
  rePickButton.hidden = true;
  pickerPanel.hidden = true;
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
    status.textContent = `「${file.name}」を読み込んでいます…`;
    const { channels, sampleRate, truncated } = await decode(file);
    if (channels[0].length / sampleRate > MAX_MATERIAL_SEC) {
      longClip = { file, truncated };
      showPicker(file.name, channels, sampleRate);
      return;
    }
    longClip = null;
    rePickButton.hidden = true;
    pickerPanel.hidden = true;
    await load(file.name, channels, sampleRate);
  } catch (error) {
    status.textContent = `読み込めませんでした(対応していない形式かもしれません): ${error instanceof Error ? error.message : error}`;
  }
}

fileInput.addEventListener("change", () => {
  const files = [...(fileInput.files ?? [])];
  fileInput.value = "";
  openFiles(files);
});

document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", (event) => {
  event.preventDefault();
  openFiles([...(event.dataTransfer?.files ?? [])]);
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

editor.onRootChange = (root, final) => {
  // Dragging the dotted line: the root is set by hand from here on.
  params = { ...params, root, rootMode: "manual" };
  if (final) sendInstrument();
  else {
    rootLabel.textContent = pitchLabel(root);
    rootSource.textContent = "(手動)";
  }
};

editor.onSelect = (next) => {
  selection = next;
  refreshFixBar();
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
