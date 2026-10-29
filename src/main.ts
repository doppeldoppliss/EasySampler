// EasySampler (formerly MADDAW) — Phase 2: cuts, loops, multisamples, settings (design.md 3, 5, 7).
//
// Load a material (or the demo): it is analysed (pitch curve, pitch marks,
// root pitch to the cent, suggested synthesis markers) and playable at once.
// Cut it with the range handles — several cuts (区間) of one clip if you
// like — pick the note and the length, try it on the keyboard, then share /
// save: a single WAV, a loopable WAV, or a multisample folder; every cut at
// once as a zip. The settings (never the audio) are kept per material and
// can be saved as JSON. One column, phone first.

import { applyCorrections, CORRECTION_LABELS, correctionLabel, type CorrectionKind, type PitchCorrection } from "./analysis/corrections";
import { midiToHz, pitchLabel } from "./analysis/pitch";
import { EngineClient } from "./audio/engineClient";
import { askToPersist, forget, keep, kept, onSaveState, storageEstimate, whenSaved, type SaveState } from "./audio/store";
import { chooseProject, createProject, currentProject, duplicateProject, newMaterialId, openProjects, projectKey, projectList, remapMaterials, removeProject, renameProject, touchProject } from "./audio/projects";
import { buildProjectFile, parseProjectFile, PROJECT_FILE_EXTENSION } from "./audio/projectFile";
import { Engine, type PreparedSource } from "./engine/engine";
import { mixToMono, prepareSource, resample, rootForMarkers, type MaterialAnalysis } from "./engine/prepare";
import type { PitchTrack } from "./analysis/pyin";
import { buildBatch, buildKit, buildOne, type Built, type BuildInput } from "./export/build";
import { canShareFiles, downloadFile, shareFile } from "./export/deliver";
import { exportFileName, safeBaseName, stripExtension } from "./export/render";
import { newCutId, parseSettings, serializeSettings, settingsKey, type CutSettings, type SettingsFile } from "./export/settings";
import { hiddenPartsOf, normalizeRemoved, outputLayout } from "./instrument/layout";
import { clampMarkers, suggestMarkersWithin } from "./instrument/markers";
import {
  DEFAULT_EXPORT,
  DEFAULT_FX,
  DEFAULT_PARAMS,
  PRESETS,
  oneShotParams,
  makeModeOf,
  withMakeMode,
  type MakeMode,
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
import { PIANO_NAME, PIANO_SECONDS, synthPiano } from "./testsignals/piano";
import { cssVar, el, isTypingTarget } from "./ui/dom";
import { OnScreenKeyboard, PcKeyboard } from "./ui/keyboard";
import { MaterialEditor, type TimeSelection } from "./ui/materialEditor";
import { clock, RangePicker } from "./ui/rangePicker";
import { KEY_NAMES, quantizeToScale, SCALE_LABELS, type ScaleId } from "./instrument/scale";
import { isMidiFile } from "./song/midi";
import { RollPanel, type InstrumentOption } from "./ui/rollPanel";
import { renderSong, type RenderTrack } from "./daw/songRender";
import { writeMidi } from "./daw/midiWrite";
import { COMMON_KEYS, detectOnset, guessKey, newSlot, renderSlot, slotFor, type KitSlot } from "./daw/kit";
import { drumName } from "./song/parts";
import { MicRecorder } from "./audio/micRecorder";
import { MidiInput } from "./audio/midiInput";
import { autoToSec, BACKING, beatsToSec, clipsToSeq, tempoMapSec, toSeqNotes, type Tempo } from "./daw/model";
import { autoValue, type AutoPoint } from "./song/player";
import { zipStore, type ZipEntry } from "./export/zip";
import { encodeWavBytes } from "./audio/wav";

/** The most material one analysis takes; a longer clip goes through the range picker first. */
const MAX_MATERIAL_SEC = 60;
/** Longer files are cut here when decoded (memory: 10 minutes of stereo 48 kHz is about 230 MB). */
const MAX_DECODE_SEC = 600;
const DEMO_RATE = 44100;
/** The synthesized voice demo (「さー」) that earlier versions opened with: no longer offered, and taken out of saved projects. */
const OLD_VOICE_DEMO_NAME = "デモ素材";
const GUIDE_KEY = "maddaw.guide.v2";
const SMALL_SCREEN = window.matchMedia("(max-width: 600px)").matches || (window.matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) <= 600);
/** iPhone / iPad (an iPad calls itself a Mac, with touch). */
const IOS = /iP(hone|ad|od)/.test(navigator.platform) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
/** Opened from the home screen: no browser bars, and on an iPhone no download sheet either. */
const STANDALONE = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
/** A file is decoded whole, in memory, so a very long one is refused up front (an iPhone would run out and reload the page). */
const DECODE_REFUSE_SEC = IOS ? 300 : 1800;
/** iPhone / iPad: the samples of every material are held at once, so a project keeps to this much in all (seconds). */
const PROJECT_AUDIO_LIMIT_SEC = IOS ? 240 : Infinity;
/** iPhone / iPad: voices one track may sound at once (every track has its own engine). */
const TRACK_VOICES_IOS = 8;

// ---------------------------------------------------------------- state

interface Material {
  /** Its id in the project (its samples and settings are kept under audio:id and settings:id). */
  id: string;
  name: string;
  channels: Float32Array[];
  sampleRate: number;
  mono: Float32Array;
  /** The analysis in use: the original with the hand corrections applied (and the marks found again). */
  analysis: MaterialAnalysis;
  /** The analysis as it came out of pYIN, which the corrections are re-applied to. */
  original: MaterialAnalysis;
  corrections: PitchCorrection[];
  /** The pitch search range the analysis ran with (探索範囲), when narrowed. */
  pitchRange: { low: number; high: number } | null;
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
/**
 * Every material of the project (design.md 13.1): the one in the editor is
 * `material` (its cuts live in `cuts`); the others wait here with their
 * settings as last saved, their sources already with the engine.
 */
const library = new Map<string, { material: Material; settings: SettingsFile | null }>();
/** A cut as the engine and the tracks name it. */
const instrumentId = (materialId: string, cutId: string) => `${materialId}/${cutId}`;
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
if (IOS) client.voiceCap = TRACK_VOICES_IOS;
const editor = new MaterialEditor();
const sink = {
  noteOn: (n: number, velocity: number) => {
    client.unlock();
    // ステップ入力: the key also goes into the song as a note; it sounds as any key does (in the 曲 view: the track, with its effects).
    rollPanel.stepNote(n, true);
    rollPanel.recordNote(n, true, velocity);
    client.noteOn(n, velocity);
  },
  noteOff: (n: number) => {
    rollPanel.stepNote(n, false);
    rollPanel.recordNote(n, false);
    client.noteOff(n);
  },
};
const piano = new OnScreenKeyboard(sink, 48, SMALL_SCREEN ? 72 : 84);
const pcKeys = new PcKeyboard(sink);
// 打ち込み: the song (written on the piano roll, or opened from a MIDI file), played by the materials.
const rollPanel = new RollPanel(client, () => exportSettings.bpm);
// (Development only: a handle for checking playback where the page's animation frames do not run.)
if (import.meta.env.DEV) Object.assign(window, { __easysampler: { client, rollPanel } });
rollPanel.onTrackChange = () => {
  showFxTarget();
  routeKeyboard();
};
function showFxTarget(): void {
  fxTrackLabel.textContent = fxTarget === "master" ? "(マスター)" : `「${rollPanel.trackName}」`;
  fxTrackButton.textContent = `トラック「${rollPanel.trackName}」`;
  fxTrackButton.classList.toggle("on", fxTarget === "track");
  fxMasterButton.classList.toggle("on", fxTarget === "master");
  refreshControls();
}
const fxTrackButton = button("トラック", "small toggle", () => {
  fxTarget = "track";
  showFxTarget();
});
const fxMasterButton = button("マスター(曲全体)", "small toggle", () => {
  fxTarget = "master";
  showFxTarget();
});
rollPanel.onPlayingChange = (playing) => {
  if (!playing) return;
  client.stopPreview();
};

// A control that was just changed gives the focus back, so Space / Ctrl+Z keep working after a dropdown.
document.addEventListener("change", (event) => {
  const t = event.target;
  if (t instanceof HTMLSelectElement || (t instanceof HTMLInputElement && ["range", "checkbox", "radio"].includes(t.type))) t.blur();
});

// ---------------------------------------------------------------- audio start

/** Every first gesture (tap, key) may be the one allowed to start the sound. */
function onGesture(): void {
  const wasStarted = client.started;
  client.unlock();
  if (!wasStarted) void matchEngineRate();
}
// (iPhone: a touch's "down" has not always counted as the gesture that may start sound; its "up" and the click do.)
for (const type of ["pointerdown", "pointerup", "touchend", "click", "keydown"]) window.addEventListener(type, onGesture, { capture: true, passive: true });
// (iOS "interrupts" the audio when another app takes over; unlock() on the next gesture resumes it.)

/** The material was prepared before the audio started (at a guessed rate): redo it at the real one. */
/** A material just analysed: if the audio already runs at another rate than the one guessed, prepare it again. */
function checkEngineRate(id: string): void {
  if (client.started && !client.sourceMatchesRate(id)) void matchEngineRate();
}

let matchingRate: Promise<void> | null = null;
async function matchEngineRate(): Promise<void> {
  // (One pass at a time; a call during one waits for it, then checks again.)
  while (matchingRate) await matchingRate;
  matchingRate = matchEngineRateOnce();
  try {
    await matchingRate;
  } finally {
    matchingRate = null;
  }
}

async function matchEngineRateOnce(): Promise<void> {
  for (const { material: m } of library.values()) {
    if (client.sourceMatchesRate(m.id)) continue;
    const { source } = await client.analyze(m.channels, m.sampleRate, undefined, m.analysis.track);
    m.source = source;
    m.exportSources.set(source.sampleRate, source);
    client.setSource(source, m.id);
  }
  client.resendInstrument();
  rebuildKit(true);
}

// ---------------------------------------------------------------- building blocks

const controlsRefreshers: (() => void)[] = [];

function update(change: (p: InstrumentParams) => void, keepPreset = false): void {
  const next = structuredClone(params);
  change(next);
  params = next;
  if (!keepPreset) {
    presetId = "";
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

const fileInput = el("input", { type: "file", accept: "audio/*,video/*,.json,application/json,.mid,.midi,.easysampler", multiple: true, className: "visually-hidden", id: "file" });
const openButton = el("label", { className: "button primary", htmlFor: "file", textContent: "素材を開く" });
const pianoButton = button("＋ 内蔵ピアノ", "", () => void addPiano());
// A material recorded from the microphone (opened like a file when it stops).
const mic = new MicRecorder();
let micTimer = 0;
const micButton = button("● マイクで録音", "", () => void toggleMic());
micButton.title = "マイクで録った声や音を、新しい素材にします(もう一度押すと止めて開きます)";
micButton.hidden = !MicRecorder.supported;

async function toggleMic(): Promise<void> {
  if (mic.recording) {
    clearInterval(micTimer);
    micButton.textContent = "● マイクで録音";
    micButton.classList.remove("recording");
    const d = new Date();
    const p = (x: number) => String(x).padStart(2, "0");
    try {
      const file = await mic.stop(`録音_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`);
      await openFile(file);
    } catch (error) {
      status.textContent = `録音を開けませんでした: ${error instanceof Error ? error.message : error}`;
    }
    return;
  }
  try {
    await mic.start();
  } catch (error) {
    const denied = error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError");
    status.textContent = denied ? "マイクを使えませんでした。ブラウザのマイクの許可を確かめてください。" : `マイクを使えませんでした: ${error instanceof Error ? error.message : error}`;
    return;
  }
  micButton.classList.add("recording");
  const show = () => {
    const s = Math.floor(mic.elapsed);
    micButton.textContent = `■ 録音を止める ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    // (Past the longest a material may be: it stops by itself.)
    if (mic.elapsed > MAX_MATERIAL_SEC) void toggleMic();
  };
  show();
  micTimer = window.setInterval(show, 250);
  status.textContent = "マイクで録音しています。止めると素材として開きます。";
}
const status = el("p", { className: "status", role: "status" });

// The listening volume (this browser only; the files are written as they are), kept for the next visit.
const VOLUME_KEY = "easysampler.volume";
const volumeSlider = el("input", { type: "range", min: "0", max: "100", step: "1", ariaLabel: "全体の音量(聴くときだけ)", className: "volume-slider" });
const volumeValue = el("span", { className: "fine num volume-value" });
function applyVolume(percent: number, keepIt: boolean): void {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  volumeSlider.value = String(p);
  volumeValue.textContent = p === 0 ? "消音" : String(p);
  // A square law: the slider moves evenly to the ear, not to the meter.
  client.setVolume((p / 100) ** 2);
  if (keepIt) safeStorage(VOLUME_KEY, String(p));
}
volumeSlider.addEventListener("input", () => applyVolume(Number(volumeSlider.value), true));
volumeSlider.addEventListener("dblclick", () => applyVolume(100, true));
{
  const saved = Number(safeStorage(VOLUME_KEY) ?? "100");
  applyVolume(Number.isFinite(saved) ? saved : 100, false);
}
const volumeControl = el("label", { className: "inline volume", title: "ブラウザで聴くときの全体の音量です。書き出すファイルの音量は変わりません(ダブルクリックで 100)" }, ["🔊 ", volumeSlider, volumeValue]);

// (Shown only once every material has been taken out: a new project starts on the built-in piano.)
const emptyState = el("section", { className: "empty", hidden: true }, [
  el("p", { className: "empty-title", textContent: "声や効果音から楽器を作り、曲まで仕上げる。" }),
  el("p", { textContent: "声や効果音のファイルを開くと、音程を判定して平らにし、母音を伸ばした単音の WAV を書き出せます。REAPER・GarageBand・Vital などのサンプラーにそのまま読み込めます。音域ぶんを揃えたマルチサンプル音源(SFZ / Decent Sampler)も作れます。" }),
  el("div", { className: "row" }, [el("label", { className: "button primary", htmlFor: "file", textContent: "素材を開く" }), button("ピアノで始める", "", () => void loadPiano())]),
  el("p", { className: "fine", textContent: "生成AIは使っていません。素材は端末の中だけで処理され、外部には送られません。BGM の入った素材は、先に除去してから開いてください。" }),
]);

// ---------------------------------------------------------------- guide (3 steps)

const guide = el("aside", { className: "steps", hidden: safeStorage(GUIDE_KEY) === "seen" }, [
  el("ol", {}, [
    el("li", {}, [el("strong", { textContent: "聴いて確かめる" }), " — ▶ で鳴らし、判定した高さと帯(頭部・持続区間)がずれていれば直します"]),
    el("li", {}, [el("strong", { textContent: "音名と長さを決める" }), " — 鍵盤は DAW で弾いたときの音の確認。●が書き出す音名です"]),
    el("li", {}, [el("strong", { textContent: "曲にする" }), " — 「曲(打ち込み)」でこの音を鳴らして打ち込むか、1 音の WAV を保存して DAW のサンプラーで使います"]),
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
  refreshInstruments();
});
const addCutButton = button("＋ 区間を追加", "small", () => addCut("next"));
const dupCutButton = button("複製", "small", () => addCut("copy"));
const removeCutButton = button("この区間を削除", "small", () => removeCut());
const materialSelect = el("select", { ariaLabel: "編集する素材", className: "material-select" });
materialSelect.addEventListener("change", () => switchMaterial(materialSelect.value));
const removeMaterialButton = button("この素材を外す", "small", () => material && removeMaterial(material.id));
/** Another file into the project (the one shown now stays in it). */
const openMoreButton = el("label", { className: "button small", htmlFor: "file", textContent: "＋ 素材を追加" });
const addPianoButton = button("＋ 内蔵ピアノ", "small", () => void addPiano());
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
const detectedButton = button("自動判定の値に戻す", "small", () => {
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
/** Shift the detected pitch over the selection by `cents` (a fifth or a harmonic lock, not only an octave). */
function shiftButton(text: string, cents: number): HTMLButtonElement {
  return button(text, "small", () => {
    if (!selection) return;
    void addCorrection({ start: selection.from, end: selection.to, kind: "shift", cents });
  });
}
const shiftButtons = [shiftButton("−1半音", -100), shiftButton("−10¢", -10), shiftButton("+10¢", 10), shiftButton("+1半音", 100)];
/** Set the detected pitch over the selection to the cut's note (the label follows the note). */
const setNoteButton = button("音名に", "small", () => {
  if (!selection) return;
  void addCorrection({ start: selection.from, end: selection.to, kind: "set", midi: note });
});
// A hit cut from the material (an 音MAD source) into the drum kit, on the chosen key.
const toKitKey = el("select", { ariaLabel: "送る鍵" }, COMMON_KEYS.map((k) => el("option", { value: String(k), textContent: drumName(k) })));
const toKitButton = button("ドラムキットへ", "small", () => {
  if (!selection || !material) return;
  const sr = material.sampleRate;
  const a = Math.max(0, Math.round(selection.from * sr));
  const b = Math.min(material.channels[0].length, Math.round(selection.to * sr));
  if (b - a < 16) return;
  const key = Number(toKitKey.value);
  const name = `${stripExtension(material.name)} ${selection.from.toFixed(2)}秒`;
  void addKitSound(key, name, material.channels.map((c) => c.slice(a, b)), sr).then(() => {
    fixStatus.textContent = `選んだ部分をドラムキットの「${drumName(key)}」に入れました(「ドラムキット」の画面で確かめられます)。`;
  });
});
const clearSelectionButton = button("選択解除", "small", () => {
  selection = null;
  editor.setSelection(null);
  refreshFixBar();
});
// Cutting (VocalShifter's TIME: 選択範囲の削除 / トリミング).
const removeButton = button("選択した部分を削除", "small", () => {
  if (!selection || !markers) return;
  const removed = normalizeRemoved([...(markers.removed ?? []), { start: selection.from, end: selection.to }], markers.rangeStart, markers.rangeEnd);
  markers = clampMarkers({ ...markers, removed });
  selection = null;
  editor.setSelection(null);
  afterMarkersEdited();
});
const trimButton = button("選択した部分だけ残す", "small", () => {
  if (!selection || !markers) return;
  markers = clampMarkers({ ...markers, rangeStart: selection.from, rangeEnd: selection.to });
  selection = null;
  editor.setSelection(null);
  afterMarkersEdited();
});
const removedLabel = el("span", { className: "fine" });
const undoRemoveButton = button("削除を 1 つ戻す", "small", () => {
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
/** What the fix bar's buttons just did (so the answer is next to the finger, not at the top of the page). */
const fixStatus = el("span", { className: "fine fix-status", role: "status" });
const undoCorrectionButton = button("手直しを 1 つ戻す", "small", () => void setCorrections(material?.corrections.slice(0, -1) ?? []));
const clearCorrectionsButton = button("手直しをすべて戻す", "small", () => void setCorrections([]));
const fixBar = el("div", { className: "fix-bar" }, [
  el("div", { className: "row tight" }, [selectionLabel, removeButton, trimButton, toKitKey, toKitButton, clearSelectionButton, fixStatus]),
  el("div", { className: "row tight fix-pitch" }, [el("span", { className: "fine", textContent: "判定の手直し:" }), ...fixButtons, ...shiftButtons, setNoteButton]),
  el("div", { className: "row tight" }, [removedLabel, undoRemoveButton, clearRemovedButton]),
  el("div", { className: "row tight" }, [correctionsLabel, undoCorrectionButton, clearCorrectionsButton]),
]);

function refreshFixBar(): void {
  const count = material?.corrections.length ?? 0;
  const removed = markers?.removed ?? [];
  const hasSelection = selection !== null;
  selectionLabel.textContent = hasSelection
    ? `選択 ${selection!.from.toFixed(2)}–${selection!.to.toFixed(2)} 秒:`
    : "波形の上を横にドラッグして選ぶと、その部分を削除したり、判定を直したりできます。";
  for (const b of [removeButton, trimButton, toKitKey, toKitButton, ...fixButtons, ...shiftButtons, setNoteButton, clearSelectionButton]) b.hidden = !hasSelection;
  setNoteButton.textContent = `${pitchLabel(note)} に`;
  setNoteButton.parentElement!.hidden = !hasSelection;
  removedLabel.textContent = removed.length ? `削除 ${removed.length} か所(${removed.map((r) => `${r.start.toFixed(2)}–${r.end.toFixed(2)} 秒`).join("、")})` : "";
  undoRemoveButton.hidden = removed.length === 0;
  clearRemovedButton.hidden = removed.length < 2;
  removedLabel.parentElement!.hidden = removed.length === 0;
  correctionsLabel.textContent = count ? `手直し ${count} 件(${material!.corrections.map((c) => correctionLabel(c, pitchLabel)).join("、")})` : "";
  undoCorrectionButton.hidden = count === 0;
  clearCorrectionsButton.hidden = count < 2;
  correctionsLabel.parentElement!.hidden = count === 0;
}

// One transport: what to play (元の音 / 書き出し後, a visible mode), one ▶ / ■, the position. The ruler on
// the editor is the seek bar (tap = set, double-tap = play from there, drag = scrub); Space = this ▶ / ■.
let cue = 0;
/** Where the last playback started: ■ returns there (REAPER / Audacity), so the same spot can be heard again. */
let playStartCue = 0;
let previewMode: "result" | "original" = "result";
const modeOriginal = el("button", { type: "button", className: "mode-button", textContent: "元の音" });
const modeResult = el("button", { type: "button", className: "mode-button", textContent: "書き出し後" });
const modeToggle = el("div", { className: "mode-toggle", role: "group", ariaLabel: "何を鳴らすか" }, [modeOriginal, modeResult]);
const playButton = button("▶", "small play-button", () => void togglePreview());
playButton.ariaLabel = "再生 / 停止(スペース)";
const seekClock = el("span", { className: "fine num seek-clock" });
// Undo / redo (the history itself lives further down, with the settings).
const undoButton = button("元に戻す", "small", () => undo());
const redoButton = button("やり直す", "small", () => redo());
undoButton.title = "Ctrl + Z — つまみ・マーカー・削除・手直し・区間など、すべての変更を 1 つ戻します";
redoButton.title = "Ctrl + Y";
let seekLength = 0;
function showSeek(sec: number): void {
  seekClock.textContent = `${clock(Math.min(seekLength, sec))} / ${clock(seekLength)}`;
}
function setSeekLength(sec: number): void {
  seekLength = Math.max(0.01, sec);
  if (cue > seekLength) cue = 0;
  showSeek(cue);
}
function setPreviewMode(mode: "result" | "original"): void {
  previewMode = mode;
  modeOriginal.setAttribute("aria-pressed", String(mode === "original"));
  modeResult.setAttribute("aria-pressed", String(mode === "result"));
  if (!playing) {
    // The clock shows the length of what would play now.
    setSeekLength(mode === "original" ? originalPieces().reduce((n, p) => n + (p.to - p.from), 0) : markers ? outputLayout(markers, params, exportLengthSec(exportSettings)).totalSec : 0);
  }
}
modeOriginal.addEventListener("click", () => {
  if (playing) client.stopPreview();
  setPreviewMode("original");
});
modeResult.addEventListener("click", () => {
  if (playing) client.stopPreview();
  setPreviewMode("result");
});
/** ▶ plays the mode from the cue; ■ stops and returns to where it started. */
async function togglePreview(): Promise<void> {
  if (playing) {
    client.stopPreview();
    return;
  }
  if (previewMode === "original") await playOriginal();
  else await listen();
}
const zoomInButton = button("＋", "small zoom-fine", () => editor.zoom(1.6));
const zoomOutButton = button("−", "small zoom-fine", () => editor.zoom(1 / 1.6));
const zoomAllButton = button("全体", "small", () => editor.zoomAll());
const zoomRangeButton = button("選択 / 範囲を拡大", "small", () => {
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
  el("div", { className: "cut-bar material-bar" }, [el("span", { className: "control-label", textContent: "素材" }), materialSelect, openMoreButton, addPianoButton, removeMaterialButton]),
  cutBar,
  el("div", { className: "editor-bar" }, [
    el("div", { className: "root-box" }, [
      el("span", { className: "fine", textContent: "判定した高さ" }),
      rootLabel,
      rootSource,
      el("span", { className: "fine root-help", textContent: "素材はこの高さで鳴っているとみなし、音名との差だけ移調します(自動のときは持続区間に追従)。" }),
      el("span", { className: "row tight root-nudge" }, [rootButton("基準 −1半音", -1), rootButton("基準 −5¢", -0.05), rootButton("基準 +5¢", 0.05), rootButton("基準 +1半音", 1), detectedButton]),
    ]),
    el("div", { className: "row tight transport" }, [playButton, modeToggle, seekClock, el("span", { className: "spacer" }), undoButton, redoButton, zoomOutButton, zoomInButton, zoomRangeButton, zoomAllButton, zoomLabel]),
  ]),
  el("details", { className: "fine hint" }, [
    el("summary", { textContent: "使い方: 両端のハンドルで範囲、帯の端でマーカー、波形を横にドラッグで選択。波形や目盛りを押すと再生位置、2 回押すと再生。" }),
    el("p", { textContent: "波形か目盛り: 1 回押すと再生位置を置き、2 回押すとそこから元の音が鳴ります。引くと位置をなぞれます(再生中は飛びます)。下の「書き出し後」レーンも同じで、こちらは書き出し後が鳴ります。▶ / ■(スペースキー)で再生と停止、■ は再生を始めた位置に戻ります。Shift + スペースは元の音。" }),
    el("p", { textContent: "判定の点線は「判定 …」の札をつかんで上下にドラッグ(半音ずつ。Alt でセント単位、ダブルクリックで最寄りの半音。動かすと手動になり、「自動判定の値に戻す」で戻ります)。削除した範囲は詰めて表示され、✂ の点線が継ぎ目です。" }),
    el("p", { textContent: "ショートカット: スペース = 再生 / 停止、Shift + スペース = 元の音、Ctrl + Z / Y = 元に戻す / やり直す、M = PC 鍵盤、Z / X = オクターブ、C / V = 強さ、Ctrl + ホイール = 拡大、Shift + ホイール = 横移動。" }),
  ]),
  editor.element,
  el("p", { className: "legend fine" }, [
    el("span", { className: "swatch original" }), "元のピッチ  ",
    el("span", { className: "swatch edited" }), "整えたあと(選んだ音名で鳴らしたとき)",
  ]),
  el("p", { className: "fine band-legend" }, [
    el("span", { className: "band-dot head" }), "頭部 = 1 回だけ鳴る出だし　",
    el("span", { className: "band-dot sustain" }), "持続区間 = 押している間伸ばす部分",
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
const noteAutoButton = button("音名を判定と同じに", "small", () => setNote(note, "auto"));
const noteShift = el("span", { className: "fine num" });

function setNote(n: number, mode: "auto" | "manual"): void {
  note = n;
  noteMode = mode;
  refreshExport();
}

// この作り方の初期値に戻す: the sound settings back to the 作り方's starting point (the first of its PRESETS),
// keeping what is the user's (presetBase).
const resetModeButton = button("この作り方の初期値に戻す", "small", () => {
  const start = PRESETS.find((p) => p.mode === makeModeOf(params))!;
  presetId = start.id;
  params = start.apply(structuredClone(params));
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

// The song's tempo (曲 view) for the length in beats: one sound made to fit the song it is for.
const songBpmButton = button("曲の BPM に合わせる", "small", () => {
  const bpm = Math.max(20, Math.min(400, Math.round(rollPanel.bpm * 10) / 10));
  updateExport((s) => {
    s.bpm = bpm;
    s.lengthMode = "beats";
  });
  songBpmButton.title = `長さの BPM を曲と同じ ${bpm} にしました(拍同期のエフェクトも変わります)`;
});
songBpmButton.title = "打ち込み(曲の画面)の BPM を、拍で数える長さの BPM にします";

const lengthBlock = el("div", { className: "length" }, [
  el("span", { className: "control-label", textContent: "長さ" }),
  el("div", { className: "length-row" }, [el("label", { className: "inline" }, [lengthBeats, beatsInput, el("span", { textContent: "拍" }), el("span", { className: "fine", textContent: "BPM" }), bpmInput]), songBpmButton]),
  el("label", { className: "length-row" }, [lengthSeconds, secondsInput, el("span", { textContent: "秒" })]),
  lengthResult,
]);

// Speeds (VocalShifter's TIME, as one factor per part) and the vibrato (VIB), in the open where they are reached for.
const stretchFormat = (v: number) => `×${v.toFixed(2)}`;
const sustainStretchRow = range("持続区間から後の長さ ×(×2 = 2 倍ゆっくり)", 0.25, 8, 0.05, () => params.stretch.sustain, (p, v) => (p.stretch.sustain = v), stretchFormat);
const timePanel = el("details", { className: "sub" }, [
  el("summary", { textContent: "頭部の長さ(倍率。×2 = 2 倍ゆっくり)" }),
  el("p", { className: "fine", textContent: "1.00 が録音のまま。伸ばす作り方では、持続区間の長さは押している長さ(音符の長さ)で決まります。" }),
  range("頭部 ×", 0.25, 4, 0.05, () => params.stretch.head, (p, v) => (p.stretch.head = v), stretchFormat),
]);
// 音階: the key and the scale (shown in "scale" mode).
const tuneScaleRow = el("div", { className: "row tight" }, [
  select("キー", KEY_NAMES.map((n, i) => [String(i), n] as [string, string]), () => String(params.tune.key), (p, v) => (p.tune.key = Number(v))),
  select("音階", (Object.keys(SCALE_LABELS) as ScaleId[]).map((id) => [id, SCALE_LABELS[id]] as [ScaleId, string]), () => params.tune.scale, (p, v) => (p.tune.scale = v)),
]);

const vibratoPanel = el("details", { className: "sub" }, [
  el("summary", { textContent: "ビブラート" }),
  range("深さ", 0, 100, 1, () => params.wobble.vibratoCents, (p, v) => (p.wobble.vibratoCents = v), (v) => `${v}¢`),
  range("速さ", 3, 9, 0.1, () => params.wobble.vibratoHz, (p, v) => (p.wobble.vibratoHz = v), (v) => `${v.toFixed(1)} Hz`),
  range("かかり始め(音の頭から)", 0, 1, 0.01, () => params.wobble.vibratoDelaySec, (p, v) => (p.wobble.vibratoDelaySec = v), ms),
  range("立ち上がり(深さが出切るまで)", 0, 2, 0.01, () => params.wobble.vibratoAttackSec, (p, v) => (p.wobble.vibratoAttackSec = v), ms),
  range("ビブラートの消え方(離したあと、0 で続く)", 0, 2, 0.01, () => params.wobble.vibratoReleaseSec, (p, v) => (p.wobble.vibratoReleaseSec = v), (v) => (v === 0 ? "続く" : ms(v))),
  range("位相(始まる位置)", 0, 1, 0.05, () => params.wobble.vibratoPhase, (p, v) => (p.wobble.vibratoPhase = v), (v) => `${Math.round(v * 360)}°`),
  range("音量の揺れ(トレモロ)", 0, 1, 0.01, () => params.wobble.tremoloDepth, (p, v) => (p.wobble.tremoloDepth = v), pct),
  range("素材自身の揺れをならす(平滑化)", 0, 0.3, 0.005, () => params.wobble.smoothSec, (p, v) => (p.wobble.smoothSec = v), (v) => (v === 0 ? "なし" : ms(v))),
]);

// 作り方: the first choice, deciding which settings below are shown (design.md 4.5).
const makeSelect = el("select", { ariaLabel: "作り方" }, [
  el("option", { value: "hold", textContent: "伸ばす(シンセ化。押している間伸びる)" }),
  el("option", { value: "transpose", textContent: "移調(録音を 1 回、全体の音程を上げ下げ。平坦化しない)" }),
  el("option", { value: "oneshot", textContent: "1 回鳴らす(伸ばさない。平坦化などで音程を整える)" }),
]);
makeSelect.addEventListener("change", () => {
  update((p) => Object.assign(p, withMakeMode(p, makeSelect.value as MakeMode)));
  refreshControls();
});
controlsRefreshers.push(() => (makeSelect.value = makeModeOf(params)));
const makeHelp = el("p", { className: "fine help" });
// A one-shot: the whole recording, or the head only (the sustain switched off).
const playRangeRow = select(
  "鳴らす範囲",
  [
    ["full", "録音の終わりまで"],
    ["head", "頭部だけ(持続区間の手前で終わる)"],
  ],
  () => (params.sustainEnabled ? "full" : "head"),
  (p, v) => (p.sustainEnabled = v === "full"),
  true,
);

/** What the chosen 伸ばし方 does. */
const sustainHelp = el("p", { className: "fine help" });
// 離したら止める: only where letting go would otherwise do nothing (伸ばさない, or the sustain off).
const stopOnReleaseRow = el("div", {}, [
  check("鍵を離したらそこで止める(頭部や録音の途中でも)", () => params.stopOnRelease, (p, v) => (p.stopOnRelease = v), true),
  el("p", { className: "fine help", textContent: "打ち込みでは音符の長さで切れます。書き出す単音の WAV は最後まで入ります。" }),
]);
// Shown for 伸ばす only / for the one-shots only (marked where they are placed).
const holdOnly: HTMLElement[] = [];
const oneShotOnly: HTMLElement[] = [];
const held = (e: HTMLElement) => (holdOnly.push(e), e);
const oneShot = (e: HTMLElement) => (oneShotOnly.push(e), e);
// The pitch shaping (平坦化 and the rest): not for 移調.
const shapingOnly: HTMLElement[] = [];
const shaping = (e: HTMLElement) => (shapingOnly.push(e), e);
let wavetableRow: HTMLElement;
let releaseRow: HTMLElement;
let decayRow: HTMLElement;
// 減衰 (the former preset): held notes die away while held, like a struck string, and stop quickly when let go (a damper).
// On: ディケイ 1.2 s to サステイン 0, リリース 0.25 s; off: the level holds (サステイン 100%). Both are in 細かい設定 too.
const decayCheck = check(
  "押している間に消えていく(ピアノ風の減衰)",
  () => params.amp.sustain < 1,
  (p, on) => (p.amp = on ? { ...p.amp, decay: 1.2, sustain: 0, release: 0.25 } : { ...p.amp, decay: DEFAULT_PARAMS.amp.decay, sustain: 1, release: DEFAULT_PARAMS.amp.release }),
  true,
);
// (The release and the decay length follow it.)
decayCheck.querySelector("input")!.addEventListener("change", () => refreshControls());
/** The 作り方 → which settings are shown, and what the chosen ones do. */
function refreshMakeMode(): void {
  const mode = makeModeOf(params);
  const hold = mode === "hold";
  for (const e of holdOnly) e.hidden = !hold;
  for (const e of oneShotOnly) e.hidden = hold;
  wavetableRow.hidden = !hold || params.sustainMode !== "wavetable";
  decayRow.hidden = !hold || params.amp.sustain >= 1;
  // (A one-shot only fades where it is let go with 離したら止める.)
  releaseRow.hidden = !hold && !params.stopOnRelease;
  sustainStretchRow.hidden = hold || !params.sustainEnabled;
  const texts: Record<string, string> = {
    pool: "持続区間の安定した周期をつなぎ合わせて、押している間いくらでも伸ばします(自然)。",
    stretch: "持続区間全体を「長さ」に収まるようゆっくり鳴らします(VocalShifter の TIME のように、声の変化が残る)。長さを超えて押すと持続区間の終わりから「自然」で続きます。",
    loop: "持続区間をそのまま繰り返します。",
    wavetable: "持続区間の 1〜数周期だけを繰り返します(無機質)。",
  };
  sustainHelp.textContent = texts[params.sustainMode] ?? "";
  const end = params.stopOnRelease ? "離した所から「リリース」の長さで消えます。" : "押している長さに関係なく最後まで鳴ります。";
  makeHelp.textContent = hold
    ? "押している間は持続区間で伸ばし、離すと「リリース」の長さで消えます。"
    : mode === "transpose"
      ? "録音を 1 回、抑揚はそのままに全体を音名の高さへ上げ下げします。" + end
      : "伸ばさずに録音を 1 回鳴らし、音程は平坦化などで整えます。" + end;
  // 移調: the pitch shaping is not applied, so it is not shown.
  for (const e of shapingOnly) e.hidden = mode === "transpose";
  // 速度連動 (細かい設定): the pitch is the speed, so the pitch shaping is dimmed, with a note.
  const resample = params.pitchMode === "resample";
  pitchModeNote.hidden = !resample;
  for (const group of pitchGroups) {
    group.classList.toggle("unused", resample);
    group.inert = resample;
  }
}

// Played by resampling (無加工, ドラム・効果音…), a cut's pitch only follows the key, sped up or slowed down:
// the pitch shaping and the voiceless-sound handling are not used, and are shown so (dimmed, out of reach).
const pitchModeNote = el("p", { className: "fine help pitch-mode-note", hidden: true, textContent: "「ピッチの変え方」が速度連動(録音を早回し・遅回しして高さを変える)なので、音程の調整(平坦化・整え方・リチューン・揺れの残し方)・フォルマント・子音・息の扱いは使われません。使うときは、細かい設定の「ピッチの変え方」を「長さ保持」にしてください。" });
const pitchGroups: HTMLElement[] = [];
function pitchGroup(children: HTMLElement[]): HTMLElement {
  const group = el("div", { className: "pitch-group" }, children);
  pitchGroups.push(group);
  return group;
}
// 録音した高さで鳴らす: what it means for the keys and the files, while it is on.
const fixedPitchNote = el("p", { className: "fine help", hidden: true, textContent: "どの鍵・どの音符でも録音したままの高さで鳴ります(書き出す単音も音名にかかわらず録音した高さ)。打ち込みでは、音符の高さは鳴らす位置の目印だけになります。" });
controlsRefreshers.push(() => (fixedPitchNote.hidden = !params.fixedPitch));
const fixedPitchCheck = check("鍵に関係なく、録音した高さで鳴らす(効果音向け)", () => params.fixedPitch, (p, v) => (p.fixedPitch = v), true);
// (Its note and the editor's output line change with it.)
fixedPitchCheck.querySelector("input")!.addEventListener("change", () => {
  refreshControls();
  refreshExport();
});
const tunePanel = el("section", { className: "panel tune" }, [
  el("div", { className: "note-row" }, [el("span", { className: "control-label", textContent: "音名" }), noteStep("−", -1), noteSelect, noteStep("+", 1), noteAutoButton, noteShift]),
  fixedPitchCheck,
  fixedPitchNote,
  el("label", { className: "control preset" }, [el("span", { className: "control-label", textContent: "作り方" }), makeSelect]),
  makeHelp,
  el("div", { className: "row tight" }, [resetModeButton]),
  el("p", { className: "fine help", textContent: "作り方を切り替えても、ほかの設定はそのまま残ります。「初期値に戻す」は音の設定をこの作り方の初期値にします(音名・入りと終わりのフェード・ベロシティ感度・フォルマント・「録音した高さで鳴らす」「鍵を離したらそこで止める」はそのまま)。" }),
  held(
    select(
      "持続区間の伸ばし方",
      [
        ["pool", "自然(周期をつなぎ合わせて伸ばす)"],
        ["stretch", "引き延ばし(ゆっくり通して鳴らす)"],
        ["loop", "ループ"],
        ["wavetable", "ウェーブテーブル(1〜数周期の繰り返し、無機質)"],
      ],
      () => (params.sustainMode === "none" ? params.heldSustainMode : params.sustainMode),
      (p, v) => (p.sustainMode = v),
    ),
  ),
  held(sustainHelp),
  (wavetableRow = range("ウェーブテーブルの周期数", 1, 8, 1, () => params.wavetableCycles, (p, v) => (p.wavetableCycles = v), (v) => `${v} 周期`)),
  oneShot(playRangeRow),
  sustainStretchRow,
  oneShot(stopOnReleaseRow),
  // How a held note ends (語尾 was taken out: this is it).
  held(decayCheck),
  (decayRow = range("消えるまでの長さ(ディケイ)", 0.05, 10, 0.05, () => params.amp.decay, (p, v) => (p.amp.decay = v), ms)),
  (releaseRow = range("離したあとの消え方(リリース)", 0.005, 2, 0.005, () => params.amp.release, (p, v) => (p.amp.release = v), ms)),
  pitchModeNote,
  shaping(pitchGroup([
    range("平坦化(100% で完全に平ら、0% で元の抑揚)", 0, 1, 0.01, () => params.flatten, (p, v) => (p.flatten = v), pct),
    select("音程の整え方", [["flatten", "判定した 1 音に寄せる"], ["scale", "音階の最寄りの音に、場所ごとに寄せる(複数の音を残す)"]], () => params.tune.mode, (p, v) => (p.tune.mode = v)),
    tuneScaleRow,
    range("音程を寄せる速さ(リチューン)", 0, 0.3, 0.005, () => params.tune.retuneSec, (p, v) => (p.tune.retuneSec = v), (v) => (v === 0 ? "即座(ケロケロ向き)" : ms(v))),
    el("p", { className: "fine help", textContent: "判定した高さから音名へ寄せるときの速さ(Auto-Tune の Retune Speed)。即座だと貼り付いたように、30 ms 前後だと自然に、長いとゆっくりした狂いだけが直ります。" }),
    el("p", { className: "fine help", textContent: "「音階」にすると、素材の中で高さが変わる所はそれぞれ最寄りの音に貼り付きます(VocalShifter のクオンタイズ / 自動補正)。平坦化 100%・揺らぎなし・リチューン即座でケロケロになります。" }),
  ])),
  held(range("持続部の音量を揃える", 0, 1, 0.05, () => params.levelEven, (p, v) => (p.levelEven = v), pct, true)),
  held(el("p", { className: "fine help", textContent: "素材の持続区間が減衰していても、伸ばした音の音量が一定になります。0% で録音どおりの強弱(頭部は常にそのまま)。" })),
  pitchGroup([
    range("子音・息(音程なし)の音量", -60, 12, 1, () => params.unvoicedGainDb, (p, v) => (p.unvoicedGainDb = v), (v) => (v <= -60 ? "消す" : `${v > 0 ? "+" : ""}${v} dB`), true),
    check("子音や息(音程なし)も移調に合わせて変える", () => params.unvoicedFollow, (p, v) => (p.unvoicedFollow = v), true),
    el("p", { className: "fine help", textContent: "子音・息・ノイズなど音程のない部分は、ふつうは移調しても元のまま鳴ります。オンにすると、その部分も音名に応じて細く / 太くなります(長さは変わりません)。音程そのものを付けたいときは、選択して「有声に」。" }),
  ]),
  lengthBlock,
  vibratoPanel,
  timePanel,
]);

// ---------------------------------------------------------------- panel 3: keyboard

const voiceCount = el("span", { className: "num", textContent: "0" });
const pcState = el("span", { className: "fine" });
const pcToggle = button("PC キーボード演奏: オン(M)", "small", () => pcKeys.toggle());
pcToggle.hidden = SMALL_SCREEN;
const imeWarning = el("p", { className: "warn", hidden: true, textContent: "日本語入力がオンになっています。鍵盤として弾くには、半角英数に切り替えてください。" });

// On phones the keyboard shows two octaves: these move them (Z / X on a PC keyboard).
const octaveDown = button("◀ オクターブ", "small", () => shiftPiano(-12));
const octaveUp = button("オクターブ ▶", "small", () => shiftPiano(12));
octaveDown.hidden = octaveUp.hidden = !SMALL_SCREEN;
function shiftPiano(delta: number): void {
  const span = piano.high - piano.low;
  const low = Math.max(24, Math.min(96 - span, piano.low + delta));
  piano.setRange(low, low + span);
}
// Pinned: the keyboard stays at the bottom of the screen while the controls below it are scrolled, so a
// tweak can be heard without scrolling back. On by default on wide screens, off on phones (room).
const PIN_KEY = "maddaw.keys.pinned";
let keysPinned = (safeStorage(PIN_KEY) ?? (SMALL_SCREEN ? "off" : "on")) === "on";
const pinToggle = button("", "small", () => {
  keysPinned = !keysPinned;
  safeStorage(PIN_KEY, keysPinned ? "on" : "off");
  showPinned();
});
function showPinned(): void {
  pinToggle.textContent = `画面下に固定: ${keysPinned ? "オン" : "オフ"}`;
  keysPanel.classList.toggle("pinned", keysPinned);
  document.body.classList.toggle("keys-pinned", keysPinned);
}
/** The keyboard's title and note: what the keys play in the view on screen. */
const keysTitle = el("span", { className: "control-label", textContent: "試し弾き" });
const keysNote = el("p", { className: "fine", textContent: "●の付いた鍵が、選んだ音名(書き出す高さ)です。" });
// A MIDI keyboard: its keys go where the on-screen ones do.
const midi = new MidiInput(sink);
const midiState = el("span", { className: "fine" });
const midiButton = button("MIDI キーボード", "small", () => void connectMidi());
midiButton.title = "つないだ MIDI キーボードで弾けるようにします(録音・ステップ入力にも入ります)";
midiButton.hidden = !MidiInput.supported;
const showMidi = (names: string[]) => {
  midiState.textContent = names.length ? `MIDI: ${names.join("、")}` : "MIDI: つながっている機器がありません";
  midiButton.classList.toggle("on", names.length > 0);
};
midi.onChange = showMidi;
async function connectMidi(): Promise<void> {
  try {
    showMidi(await midi.connect());
  } catch {
    midiState.textContent = "MIDI を使えませんでした(ブラウザの許可を確かめてください)";
  }
}

const keysPanel = el("section", { className: "panel keys-panel" }, [
  el("div", { className: "row" }, [keysTitle, octaveDown, octaveUp, pinToggle, pcToggle, pcState, midiButton, midiState, el("span", { className: "fine" }, ["同時発音 ", voiceCount])]),
  imeWarning,
  piano.element,
  keysNote,
]);
// The room left at the end of the page follows the panel's real height (its control row wraps on a phone).
new ResizeObserver(() => document.body.style.setProperty("--keys-height", `${keysPanel.offsetHeight}px`)).observe(keysPanel);
// While something is being typed, a phone's own keyboard takes the bottom of the screen: the pinned piano steps aside.
document.addEventListener("focusin", (event) => document.body.classList.toggle("typing", isTypingTarget(event.target)));
document.addEventListener("focusout", () => document.body.classList.remove("typing"));
showPinned();

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

/** The track's effect rack (design.md 13.1: effects are the song side's). */
/** Which rack the effects panel edits: the selected track's, or the master's (the whole mix). */
let fxTarget: "track" | "master" = "track";
function fxNow(): FxSettings {
  return fxTarget === "master" ? rollPanel.masterFx() : rollPanel.trackFx();
}
function updateFx(change: (f: FxSettings) => void): void {
  if (fxTarget === "master") rollPanel.updateMasterFx(change);
  else rollPanel.updateTrackFx(change);
}

function fxRange(label: string, min: number, max: number, step: number, get: () => number, set: (f: FxSettings, v: number) => void, format: (v: number) => string, _keep?: boolean): HTMLElement {
  const input = el("input", { type: "range", min: String(min), max: String(max), step: String(step) });
  const value = el("output", { className: "num" });
  const refresh = () => {
    input.value = String(get());
    value.textContent = format(get());
  };
  input.addEventListener("input", () => {
    updateFx((f) => set(f, Number(input.value)));
    value.textContent = format(Number(input.value));
  });
  controlsRefreshers.push(refresh);
  return el("label", { className: "control" }, [el("span", { className: "control-label", textContent: label }), input, value]);
}

function fxSelect<T extends string>(label: string, options: [T, string][], get: () => T, set: (f: FxSettings, v: T) => void, _keep?: boolean): HTMLElement {
  const input = el("select", {}, options.map(([value, text]) => el("option", { value, textContent: text })));
  controlsRefreshers.push(() => (input.value = get()));
  input.addEventListener("change", () => updateFx((f) => set(f, input.value as T)));
  return el("label", { className: "control" }, [el("span", { className: "control-label", textContent: label }), input]);
}

function fxCheck(label: string, get: () => boolean, set: (f: FxSettings, v: boolean) => void): HTMLElement {
  const input = el("input", { type: "checkbox" });
  controlsRefreshers.push(() => (input.checked = get()));
  input.addEventListener("change", () => updateFx((f) => set(f, input.checked)));
  return el("label", { className: "control check" }, [input, el("span", { textContent: label })]);
}

/** A log-scaled frequency slider (0–1000 on the slider, `lo`–`hi` Hz); with `off`, its end reads as off. */
function fxFreq(label: string, lo: number, hi: number, get: () => number, set: (f: FxSettings, v: number) => void, off?: { at: number; text: string }): HTMLElement {
  const toPos = (f: number) => (1000 * Math.log(f / lo)) / Math.log(hi / lo);
  const toHz = (pos: number) => lo * (hi / lo) ** (pos / 1000);
  const isOff = (pos: number) => off !== undefined && Math.abs(toHz(pos) - off.at) / off.at < 0.02;
  return fxRange(
    label,
    0,
    1000,
    1,
    () => toPos(Math.max(lo, Math.min(hi, get() || lo))),
    (f, v) => set(f, isOff(v) ? off!.at : Math.round(toHz(v))),
    (v) => (isOff(v) ? off!.text : hz(toHz(v))),
    true,
  );
}

function fxGroup(key: FxKey, label: string, note: string, controls: HTMLElement[]): HTMLElement {
  const summary = el("summary");
  fxSummaries.push({ key, summary, label });
  const group = el("details", { className: "sub fx" }, [
    summary,
    fxCheck("オン", () => fxNow()[key].on, (f, v) => (f[key].on = v)),
    el("p", { className: "fine help", textContent: note }),
    ...controls,
  ]);
  // (The control's own listener has updated the params by the time this bubbles up.)
  group.addEventListener("change", refreshFxSummaries);
  return group;
}

const fxActiveLine = el("span", { className: "fine fx-active" });
/** Which track the effects panel is showing. */
const fxTrackLabel = el("span", { className: "fine" });
function refreshFxSummaries(): void {
  const on: string[] = [];
  for (const { key, summary, label } of fxSummaries) {
    const active = fxNow()[key].on;
    summary.textContent = active ? `${label}(オン)` : label;
    summary.classList.toggle("on", active);
    if (active) on.push(label.replace(/\(.*\)$/, ""));
  }
  fxActiveLine.textContent = on.length ? `オン: ${on.join("、")}` : "すべてオフ";
  if (on.length) fxPanel.open = true;
}

/** A heading between the groups: the effects come in the order they are applied, in sections. */
function fxHead(text: string): HTMLElement {
  return el("h3", { className: "fx-head", textContent: text });
}

const fxResetButton = button("エフェクトをすべてオフに", "small", () => {
  if (!confirm(`${fxTarget === "master" ? "マスター" : `トラック「${rollPanel.trackName}」`}のエフェクトをすべてオフにして、値も初期値に戻しますか?`)) return;
  updateFx((f) => Object.assign(f, structuredClone(DEFAULT_FX)));
  refreshControls();
});

const fxPanel = el("details", { className: "panel fx-panel" }, [
  el("summary", { className: "row" }, [el("span", { className: "control-label", textContent: "エフェクト" }), fxTrackLabel, fxActiveLine]),
  el("div", { className: "row" }, [el("span", { className: "fine", textContent: "かける先:" }), fxTrackButton, fxMasterButton, fxResetButton]),
  el("p", { className: "fine", textContent: "打ち込みで選んでいるトラック、またはマスター(曲全体)にかかります(上から順に)。曲の再生・書き出しと、曲の画面の鍵盤にかかります。素材・ドラムキットの画面の鍵盤と、書き出す単音の WAV には入りません。" }),
  fxHead("立ち上がり"),
  fxGroup("transient", "トランジェント(立ち上がり)", "音の頭(アタック)と、そのあとの伸び(サステイン)を別々に上げ下げします。", [
    fxRange("アタック", -12, 12, 0.5, () => fxNow().transient.attackDb, (f, v) => (f.transient.attackDb = v), db, true),
    fxRange("サステイン", -12, 12, 0.5, () => fxNow().transient.sustainDb, (f, v) => (f.transient.sustainDb = v), db, true),
  ]),
  fxGroup("compressor", "コンプレッサー", "大きいところを抑えて音量をそろえ、そのぶん全体を持ち上げます。声ネタを曲になじませる基本の道具です。", [
    fxRange("スレッショルド", -60, 0, 1, () => fxNow().compressor.thresholdDb, (f, v) => (f.compressor.thresholdDb = v), db, true),
    fxRange("レシオ", 1, 20, 0.5, () => fxNow().compressor.ratio, (f, v) => (f.compressor.ratio = v), (v) => `${v.toFixed(1)} : 1`, true),
    fxRange("アタック", 0.1, 100, 0.1, () => fxNow().compressor.attackMs, (f, v) => (f.compressor.attackMs = v), (v) => `${v.toFixed(1)} ms`, true),
    fxRange("リリース", 10, 1000, 5, () => fxNow().compressor.releaseMs, (f, v) => (f.compressor.releaseMs = v), (v) => `${Math.round(v)} ms`, true),
    fxRange("メイクアップ", 0, 24, 0.5, () => fxNow().compressor.makeupDb, (f, v) => (f.compressor.makeupDb = v), db, true),
  ]),
  fxHead("音色"),
  fxGroup("eq", "EQ", "低域カット・低域・中域(ベル)・高域・高域カット。", [
    fxFreq("低域カット", 20, 2000, () => fxNow().eq.lowCutHz, (f, v) => (f.eq.lowCutHz = v <= 20 ? 0 : v), { at: 20, text: "オフ" }),
    fxRange("低域", -18, 18, 0.5, () => fxNow().eq.lowDb, (f, v) => (f.eq.lowDb = v), db, true),
    fxFreq("低域の周波数", 20, 1000, () => fxNow().eq.lowHz, (f, v) => (f.eq.lowHz = v)),
    fxRange("中域", -18, 18, 0.5, () => fxNow().eq.midDb, (f, v) => (f.eq.midDb = v), db, true),
    fxFreq("中域の周波数", 100, 10000, () => fxNow().eq.midHz, (f, v) => (f.eq.midHz = v)),
    fxRange("中域の幅(Q)", 0.3, 8, 0.1, () => fxNow().eq.midQ, (f, v) => (f.eq.midQ = v), (v) => v.toFixed(1), true),
    fxRange("高域", -18, 18, 0.5, () => fxNow().eq.highDb, (f, v) => (f.eq.highDb = v), db, true),
    fxFreq("高域の周波数", 1000, 18000, () => fxNow().eq.highHz, (f, v) => (f.eq.highHz = v)),
    fxFreq("高域カット", 500, 20000, () => fxNow().eq.highCutHz, (f, v) => (f.eq.highCutHz = v), { at: 20000, text: "オフ" }),
  ]),
  fxGroup("saturation", "サチュレーション(真空管風の歪み)", "音を太く前に出します。かけすぎると歪みが目立ちます。", [
    fxRange("ドライブ", 0, 1, 0.01, () => fxNow().saturation.drive, (f, v) => (f.saturation.drive = v), pct, true),
    fxRange("かかり具合(ミックス)", 0, 1, 0.01, () => fxNow().saturation.mix, (f, v) => (f.saturation.mix = v), pct, true),
  ]),
  fxGroup("air", "エア(高域の抜け)", "高い音を持ち上げ、少し倍音を足して抜けをよくします。上げすぎると耳に痛くなります。", [
    fxRange("量", 0, 1, 0.01, () => fxNow().air.amount, (f, v) => (f.air.amount = v), pct, true),
  ]),
  fxHead("飛び道具"),
  fxGroup("filter", "フィルター(LFO)", "カットオフを拍に合わせて揺らします。揺れの幅を 0 にすれば、ふつうのフィルターです。", [
    fxSelect("種類", [["lowpass", "ローパス"], ["highpass", "ハイパス"], ["bandpass", "バンドパス"]], () => fxNow().filter.type, (f, v) => (f.filter.type = v), true),
    fxFreq("カットオフ", 40, 18000, () => fxNow().filter.cutoffHz, (f, v) => (f.filter.cutoffHz = v)),
    fxRange("レゾナンス", 0, 1, 0.01, () => fxNow().filter.resonance, (f, v) => (f.filter.resonance = v), pct, true),
    fxRange("揺れの幅", 0, 6, 0.1, () => fxNow().filter.lfoOctaves, (f, v) => (f.filter.lfoOctaves = v), (v) => `±${v.toFixed(1)} オクターブ`, true),
    fxSelect("揺れの周期", BEATS, () => String(fxNow().filter.lfoBeats), (f, v) => (f.filter.lfoBeats = Number(v) as FxBeats), true),
  ]),
  fxGroup("crush", "ビットクラッシャー", "ビット数とサンプリングレートを落として、ゲーム機のようなざらついた音にします。", [
    fxRange("ビット数", 1, 16, 1, () => fxNow().crush.bits, (f, v) => (f.crush.bits = v), (v) => `${v} bit`, true),
    fxRange("間引き", 1, 32, 1, () => fxNow().crush.downsample, (f, v) => (f.crush.downsample = v), (v) => (v === 1 ? "なし" : `1/${v}`), true),
    fxRange("かかり具合(ミックス)", 0, 1, 0.01, () => fxNow().crush.mix, (f, v) => (f.crush.mix = v), pct, true),
  ]),
  fxHead("広がり"),
  fxGroup("chorus", "コーラス", "少しずらした音を左右に重ねて、厚みと広がりを出します。モノラルの素材もステレオになります。", [
    fxRange("速さ", 0.1, 5, 0.05, () => fxNow().chorus.rateHz, (f, v) => (f.chorus.rateHz = v), (v) => `${v.toFixed(2)} Hz`, true),
    fxRange("深さ", 0, 12, 0.1, () => fxNow().chorus.depthMs, (f, v) => (f.chorus.depthMs = v), (v) => `${v.toFixed(1)} ms`, true),
    fxRange("かかり具合(ミックス)", 0, 1, 0.01, () => fxNow().chorus.mix, (f, v) => (f.chorus.mix = v), pct, true),
  ]),
  fxHead("やまびこと響き"),
  fxGroup("delay", "ディレイ(やまびこ)", "拍に合わせて音を繰り返します。ピンポンにすると左右に跳ね返ります。", [
    fxSelect("間隔", [["0.25", "1/16 音符"], ["0.5", "1/8 音符"], ["0.75", "付点 1/8 音符"], ["1", "1 拍"], ["1.5", "付点 1/4 音符"], ["2", "2 拍"]], () => String(fxNow().delay.beats) as "0.5", (f, v) => (f.delay.beats = Number(v) as FxSettings["delay"]["beats"]), true),
    fxRange("繰り返し(フィードバック)", 0, 0.9, 0.01, () => fxNow().delay.feedback, (f, v) => (f.delay.feedback = v), pct, true),
    fxFreq("繰り返しの高域カット", 500, 20000, () => fxNow().delay.highCutHz, (f, v) => (f.delay.highCutHz = v)),
    fxCheck("ピンポン(左右に跳ね返る)", () => fxNow().delay.pingPong, (f, v) => (f.delay.pingPong = v)),
    fxRange("混ぜる量", 0, 1, 0.01, () => fxNow().delay.mix, (f, v) => (f.delay.mix = v), pct, true),
  ]),
  fxGroup("reverb", "リバーブ(響き)", "部屋やホールの響きを足して、音を奥に置いたり曲になじませたりします。モノラルの素材もステレオになります。", [
    fxRange("広さ", 0, 1, 0.01, () => fxNow().reverb.size, (f, v) => (f.reverb.size = v), pct, true),
    fxRange("こもり(高域の減衰)", 0, 1, 0.01, () => fxNow().reverb.damping, (f, v) => (f.reverb.damping = v), pct, true),
    fxRange("プリディレイ", 0, 200, 1, () => fxNow().reverb.preDelayMs, (f, v) => (f.reverb.preDelayMs = v), (v) => `${Math.round(v)} ms`, true),
    fxRange("混ぜる量", 0, 1, 0.01, () => fxNow().reverb.mix, (f, v) => (f.reverb.mix = v), pct, true),
  ]),
  fxGroup("width", "ステレオ幅(ミッド/サイド)", "左右の広がり(サイド)と中央(ミッド)を別々に調整します。モノラルの素材は広がらないので、コーラスと組み合わせます。", [
    fxRange("広がり(サイド)", 0, 3, 0.01, () => fxNow().width.side, (f, v) => (f.width.side = v), (v) => (v === 0 ? "モノラル" : pct(v)), true),
    fxRange("中央(ミッド)", -12, 6, 0.5, () => fxNow().width.midDb, (f, v) => (f.width.midDb = v), db, true),
  ]),
  fxGroup("pan", "オートパン", "音を拍に合わせて左右に振ります。アルペジオなどに。", [
    fxRange("深さ", 0, 1, 0.01, () => fxNow().pan.depth, (f, v) => (f.pan.depth = v), pct, true),
    fxSelect("周期", BEATS, () => String(fxNow().pan.beats), (f, v) => (f.pan.beats = Number(v) as FxBeats), true),
  ]),
  fxHead("仕上げ"),
  fxGroup("limiter", "リミッター", "最後に音量を上げつつ、天井を超えないように抑えます。", [
    fxRange("入力ゲイン", 0, 18, 0.5, () => fxNow().limiter.gainDb, (f, v) => (f.limiter.gainDb = v), db, true),
    fxRange("天井", -12, 0, 0.1, () => fxNow().limiter.ceilingDb, (f, v) => (f.limiter.ceilingDb = v), (v) => `${v.toFixed(1)} dBFS`, true),
    fxRange("リリース", 5, 500, 1, () => fxNow().limiter.releaseMs, (f, v) => (f.limiter.releaseMs = v), (v) => `${Math.round(v)} ms`, true),
  ]),
]);

// フェード: the voice's own attack and a fade before the material runs out — not in the rack, but where it reads best.
const fadeSummary = el("summary");
const fadeGroup = el("details", { className: "sub fx" }, [
  fadeSummary,
  el("p", { className: "fine help", textContent: "入り = 音の頭(アタック)。終わり = 素材が尽きる手前と、音を離したあと。0 でなし。このグループを開いている間は「書き出し後」レーンの塗りの端につまみが出て、引いても変えられます。" }),
  range("入りのフェード", 0, 2, 0.005, () => params.amp.attack, (p, v) => (p.amp.attack = Math.max(0.001, v)), ms, true),
  range("終わりのフェード", 0, 3, 0.01, () => params.amp.fadeOut, (p, v) => (p.amp.fadeOut = v), ms, true),
]);
function refreshFadeSummary(): void {
  const fades: string[] = [];
  if (params.amp.attack >= 0.02) fades.push(`入り ${ms(params.amp.attack)}`);
  if (params.amp.fadeOut > 0) fades.push(`終わり ${ms(params.amp.fadeOut)}`);
  fadeSummary.textContent = fades.length ? `フェード(${fades.join("・")})` : "フェード(入り・終わり)";
  fadeSummary.classList.toggle("on", fades.length > 0);
}
fadeGroup.addEventListener("change", refreshFadeSummary);
controlsRefreshers.push(refreshFadeSummary);
fadeGroup.addEventListener("toggle", () => refreshFadeGrips());
// (The fades shape the cut's own sound, so they sit with its settings, after the length.)
lengthBlock.after(fadeGroup);
function refreshFadeGrips(): void {
  editor.setFadeGrips(fadeGroup.open || params.amp.attack >= 0.02 || params.amp.fadeOut > 0);
}
controlsRefreshers.push(refreshFxSummaries);

// ---------------------------------------------------------------- panel 4: export

const FORMATS: { id: ExportFormat; label: string; note: string }[] = [
  { id: "single", label: "単音 WAV", note: "1本の WAV。どのサンプラーでも読み込めます。" },
  { id: "loop", label: "ループ WAV(ループ点入り)", note: "持続区間を長めに作り、ループ範囲を WAV に埋め込みます(smpl)。ループ点を読むサンプラー(Logic、Kontakt、sforzando など)では、いくらでも伸ばせます。" },
  { id: "multisample", label: "マルチサンプル音源(zip: SFZ + Decent Sampler)", note: "±1 オクターブを 3 半音おきに、それぞれの高さで作った WAV と、.sfz / .dspreset の定義を zip にまとめます。高音で途切れず、低音で間延びしません。" },
  { id: "wavetable", label: "Vital 用ウェーブテーブル(WAV)", note: "持続区間の 1 周期ずつを 2048 サンプルに揃えて並べた WAV(最大 256 フレーム)。Vital の OSC にドラッグ(または Import Wavetable)で読み込むと、素材の声色そのものをウェーブテーブルとして掃引できます。音名と長さは使いません。" },
];
const DESTINATIONS: { id: Destination; label: string; help: (n: string, format: ExportFormat) => string }[] = [
  {
    id: "generic",
    label: "汎用(REAPER・Koala・Logic など)",
    help: (n, format) =>
      format === "multisample"
        ? "zip を展開し、.sfz を sforzando などの SFZ 対応サンプラーに、.dspreset を Decent Sampler に読み込みます。REAPER では RS5K の代わりに sforzando(無料)を使います。"
        : `サンプラー(REAPER の RS5K、Logic など)に読み込み、基準音(ルート)を ${n} にします。ファイル名と WAV の中にも音名が入っています。Koala には基準音がないので、鳴らす高さは手で合わせます。`,
  },
  {
    id: "garageband",
    label: "GarageBand(iPhone / iPad)",
    help: (n) => `「保存」で「ファイル」アプリのダウンロードに入ります(「共有」から GarageBand へ直接渡すこともできます)。GarageBand の Sampler で「読み込む」からそのファイルを選びます。元の高さの鍵は GarageBand が決めます(Tune 画面で合わせます。選んだ音名 ${n} はファイル名に入っています)。44.1kHz / 16bit で出します。`,
  },
  {
    id: "decent",
    label: "Decent Sampler(iPhone / iPad・PC、無料)",
    help: () => "できる .dslibrary(中身は zip)を、iPhone / iPad では「ファイル」App からタップして Decent Sampler に取り込みます。PC では File → Install DecentSampler Library で選びます。",
  },
  {
    id: "vital",
    label: "Vital",
    help: (_n, format) =>
      format === "wavetable"
        ? "この WAV を Vital の OSC にドラッグするか、ウェーブテーブル編集画面(波形をクリック)の Import Wavetable で読み込みます(1 フレーム = 2048 サンプル。フレームの切れ目は WAV に書いてあります)。ウェーブテーブル位置(Frame)を LFO やエンベロープで動かすと、声色が時間方向に変わります。"
        : "WAV を OSC にドラッグし、ピッチモードを Pitch Splice にします。LFO やエンベロープで再生位置を動かすと、サンプラーのように使えます。",
  },
];
const formatSelect = el("select", { ariaLabel: "形式" }, FORMATS.map((f) => el("option", { value: f.id, textContent: f.label })));
formatSelect.addEventListener("change", () => {
  formatNotice = "";
  updateExport((s) => (s.format = formatSelect.value as ExportFormat));
});
const formatNote = el("p", { className: "fine help" });
const destinationSelect = el("select", { ariaLabel: "渡す先" }, DESTINATIONS.map((d) => el("option", { value: d.id, textContent: d.label })));
/** Set when choosing a destination switched the format, shown once in the destination's help. */
let formatNotice = "";
destinationSelect.addEventListener("change", () =>
  updateExport((s) => {
    const before = s.format;
    s.destination = destinationSelect.value as Destination;
    // The destination says what it can take.
    if (s.destination === "decent") s.format = "multisample";
    else if (s.destination === "garageband" && (s.format === "multisample" || s.format === "wavetable")) s.format = "single";
    else if (s.destination === "vital" && s.format === "multisample") s.format = "wavetable";
    formatNotice = s.format === before ? "" : `形式を「${FORMATS.find((f) => f.id === s.format)!.label}」に切り替えました。`;
  }),
);
const destinationHelp = el("p", { className: "fine help" });
const fileNameLabel = el("code", { className: "file-name" });
const listenButton = button("▶ 書き出し後を聴く", "big", () => {
  if (playing?.kind === "result") client.stopPreview();
  else {
    if (playing) client.stopPreview();
    void listen();
  }
});
/**
 * Files go to the browser's downloads (the Downloads folder, unless the browser is set to ask) by default;
 * 共有 (the share sheet) is the second way where there is one. Only a home-screen app on an iPhone has no
 * downloads at all: there the share sheet is the way.
 */
const SHARE_ONLY = IOS && STANDALONE;
const exportHow = (): "share" | "download" => (SHARE_ONLY ? "share" : "download");
const saveButton = button("保存(ダウンロード)", "big primary", () => void deliver("download", false));
saveButton.hidden = SHARE_ONLY;
const shareButton = button("共有", SHARE_ONLY ? "big primary" : "big", () => void deliver("share", false));
shareButton.hidden = !canShareFiles();
const batchButton = button("すべての区間をまとめて保存(zip)", "", () => void deliver(exportHow(), true));
const exportStatus = el("p", { className: "fine", role: "status" });

const exportPanel = el("section", { className: "panel export" }, [
  el("div", { className: "row" }, [el("span", { className: "control-label", textContent: "書き出し" })]),
  el("label", { className: "control destination" }, [el("span", { className: "control-label", textContent: "読み込む先(DAW / サンプラー)" }), destinationSelect]),
  destinationHelp,
  el("label", { className: "control destination" }, [el("span", { className: "control-label", textContent: "ファイルの形式" }), formatSelect]),
  formatNote,
  el("div", { className: "export-actions" }, [listenButton, saveButton, shareButton]),
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
  const blob = new Blob([json], { type: "application/json" });
  const name = `${safeBaseName(stripExtension(material.name))}.easysampler.json`;
  if (SHARE_ONLY && canShareFiles()) shareFile(blob, name, name).catch(() => downloadFile(blob, name));
  else downloadFile(blob, name);
});
const loadSettingsButton = el("label", { className: "button small", htmlFor: "file", textContent: "設定を読み込む(JSON)" });
const settingsStatus = el("span", { className: "fine fix-status", role: "status" });
// The analysis's pitch search range (探索範囲): pYIN's default is about G1–B5.
const RANGE_DEFAULT = { low: 31, high: 83 };
function rangeNoteSelect(ariaLabel: string): HTMLSelectElement {
  const options: HTMLOptionElement[] = [];
  for (let midi = 24; midi <= 107; midi++) options.push(el("option", { value: String(midi), textContent: pitchLabel(midi) }));
  return el("select", { ariaLabel }, options);
}
const rangeLowSelect = rangeNoteSelect("探索範囲の下限");
const rangeHighSelect = rangeNoteSelect("探索範囲の上限");
const rangeStatus = el("span", { className: "fine fix-status", role: "status" });
function showPitchRange(): void {
  const r = material?.pitchRange ?? RANGE_DEFAULT;
  rangeLowSelect.value = String(r.low);
  rangeHighSelect.value = String(r.high);
}
for (const s of [rangeLowSelect, rangeHighSelect]) {
  s.addEventListener("change", () => {
    const low = Number(rangeLowSelect.value);
    const high = Number(rangeHighSelect.value);
    if (high <= low) {
      showPitchRange();
      return;
    }
    void setPitchRange({ low, high });
  });
}
/** Runs the analysis again within `range` (or the default when null), then re-applies the hand corrections. */
async function setPitchRange(range: { low: number; high: number } | null): Promise<void> {
  if (!material) return;
  const target = material;
  target.pitchRange = range;
  showPitchRange();
  rangeStatus.textContent = "判定し直しています…";
  try {
    const r = range ?? RANGE_DEFAULT;
    const { analysis } = await client.analyze(target.channels, target.sampleRate, undefined, undefined, { fminHz: midiToHz(r.low), fmaxHz: midiToHz(r.high) });
    if (material !== target) return;
    target.original = analysis;
    await setCorrections(target.corrections);
    rangeStatus.textContent = `${pitchLabel(r.low)}〜${pitchLabel(r.high)} で判定し直しました。`;
  } catch (error) {
    rangeStatus.textContent = `判定し直せませんでした: ${error instanceof Error ? error.message : error}`;
  }
}
const resetSettingsButton = button("設定を捨てて最初から", "small", () => {
  if (!material) return;
  if (!confirm("区間・マーカー・手直し・書き出し設定をすべて捨てて、解析結果から作り直します(探索範囲と出典メモは残ります)。よろしいですか?(元に戻すで戻せます)")) return;
  const hadCorrections = material.corrections.length > 0;
  material.corrections = [];
  freshCuts();
  exportSettings = structuredClone(DEFAULT_EXPORT);
  applyCurrentCut();
  if (hadCorrections) void setCorrections([]);
  else refreshFixBar();
  settingsStatus.textContent = "解析結果から設定を作り直しました。";
});

const benchButton = button("負荷を測る", "small", () => benchmark());
const benchResult = el("span", { className: "fine" });

exportPanel.append(
  el("details", { className: "sub credit" }, [el("summary", { textContent: "出典メモ(WAV に書き込まれます。親作品登録・クレジット用)" }), ...creditFields]),
  el("details", { className: "sub" }, [
    el("summary", { textContent: "設定ファイル(保存・読み込み・最初から)" }),
    el("p", { className: "fine", textContent: "区間・マーカー・つまみ・音名などの設定だけを保存します(音声は含みません)。同じ素材を開き直すと、この端末では自動で前回の設定に戻ります。" }),
    el("div", { className: "row tight" }, [saveSettingsButton, loadSettingsButton, resetSettingsButton, settingsStatus]),
  ]),
);

const detailsPanel = el("details", { className: "panel params" }, [
  el("summary", { textContent: "細かい設定(基準ピッチ・鳴らし方・揺らぎ・エンベロープ)" }),
  el("div", { className: "params-grid" }, [
    el("fieldset", {}, [
      el("legend", { textContent: "基準ピッチ(素材そのものの高さ)" }),
      el("div", { className: "row tight" }, [el("span", { className: "control-label", textContent: "判定の探索範囲" }), rangeLowSelect, el("span", { className: "fine", textContent: "〜" }), rangeHighSelect, rangeStatus]),
      el("p", { className: "fine help", textContent: "判定がオクターブや 5 度で外れるときは、素材の実際の高さだけに絞って判定し直すと直ることがあります(初期値 G1〜B5)。" }),
      el("p", { className: "fine", textContent: "判定が外れているときは、編集画面の「判定した高さ」の横のボタンか、点線の「判定 …」の札のドラッグで直します。" }),
    ]),
    el("fieldset", {}, [
      el("legend", { textContent: "鳴らし方" }),
      select("ピッチの変え方", [["preserve-length", "長さ保持(PSOLA)"], ["resample", "速度連動(昔ながら)"]], () => params.pitchMode, (p, v) => (p.pitchMode = v)),
      pitchGroup([
        range("フォルマント", -6, 6, 0.1, () => params.formantSemitones, (p, v) => (p.formantSemitones = v), semis),
        range("±7 半音を超える移調で声質を追従させる", 0, 1, 0.05, () => params.formantFollow, (p, v) => (p.formantFollow = v), pct),
        el("p", { className: "fine help", textContent: "0% で声の性格を保ち(Melodyne のフォルマント補正 100%)、100% で早回し / 遅回しのように変わります。" }),
      ]),
    ]),
    el("fieldset", {}, [
      el("legend", { textContent: "揺らぎ(ビブラートは上の「ビブラート」で)" }),
      shaping(pitchGroup([
        range("素材のゆっくりした揺れ(ドリフト)を残す", -1, 1, 0.05, () => params.wobble.keepDrift, (p, v) => (p.wobble.keepDrift = v), (v) => (v < 0 ? `反転 ${Math.round(-v * 100)}%` : pct(v))),
        range("素材の速い揺れ(ビブラート)を残す", -1, 1, 0.05, () => params.wobble.keepModulation, (p, v) => (p.wobble.keepModulation = v), (v) => (v < 0 ? `反転 ${Math.round(-v * 100)}%` : pct(v))),
        el("p", { className: "fine help", textContent: "Melodyne のピッチドリフト / ピッチモジュレーションにあたります。平坦化が 100% だとどちらも消えるので、平坦化を下げてから効かせます。マイナスで揺れが逆向きになります。" }),
      ])),
      range("足すゆっくりした揺れ", 0, 30, 1, () => params.wobble.driftCents, (p, v) => (p.wobble.driftCents = v), (v) => `${v}¢`),
      shaping(pitchGroup([check("細かい揺れ(平坦でも機械的にしない)", () => params.wobble.micro, (p, v) => (p.wobble.micro = v))])),
    ]),
    el("fieldset", {}, [
      el("legend", { textContent: "エンベロープ" }),
      range("ディケイ", 0.01, 10, 0.01, () => params.amp.decay, (p, v) => (p.amp.decay = v), ms),
      range("サステイン", 0, 1, 0.01, () => params.amp.sustain, (p, v) => (p.amp.sustain = v), pct),
      range("ベロシティ感度", 0, 1, 0.01, () => params.amp.velocitySens, (p, v) => (p.amp.velocitySens = v), pct),
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
// Listening to the selection: from the cue, with a seek bar and a playhead over the overview.
let pickerPlaying = false;
let pickerCue = 0;
let pickerFrame = 0;
const pickerSeek = el("input", { type: "range", min: "0", max: "1", step: "0.01", value: "0", className: "seek-bar", ariaLabel: "再生位置" });
const pickerClock = el("span", { className: "fine num seek-clock" });
function showPickerSeek(sec: number): void {
  const r = picker.value;
  const length = Math.max(0.01, r.to - r.from);
  pickerSeek.max = String(length);
  pickerSeek.value = String(Math.min(length, sec));
  pickerClock.textContent = `${clock(r.from + Math.min(length, sec))} / ${clock(r.to)}`;
}
pickerSeek.addEventListener("input", () => {
  pickerCue = Number(pickerSeek.value);
  showPickerSeek(pickerCue);
  if (pickerPlaying) client.seekPreview(pickerCue);
  else picker.setPlayhead(picker.value.from + pickerCue);
});
function stopPickerPlayback(): void {
  cancelAnimationFrame(pickerFrame);
  if (!pickerPlaying) return;
  pickerPlaying = false;
  pickerListen.textContent = "▶ 選択範囲を聴く";
  picker.setPlayhead(null);
}
const pickerListen = button("▶ 選択範囲を聴く", "", () => {
  if (!pickerClip) return;
  if (pickerPlaying) {
    client.stopPreview();
    return;
  }
  const r = picker.value;
  const rate = pickerClip.sampleRate;
  const length = r.to - r.from;
  if (pickerCue >= length - 0.02) pickerCue = 0;
  pickerPlaying = true;
  pickerListen.textContent = "■ 停止";
  client.playBuffer(pickerClip.channels.map((c) => c.slice(Math.round(r.from * rate), Math.round(r.to * rate))), rate, pickerCue);
  const step = () => {
    const pos = client.previewPosition();
    if (pos === null || !pickerPlaying) return;
    pickerCue = pos;
    showPickerSeek(pos);
    picker.setPlayhead(picker.value.from + pos);
    pickerFrame = requestAnimationFrame(step);
  };
  pickerFrame = requestAnimationFrame(step);
});
const pickerUse = button("この範囲を使う", "primary", () => void usePickedRange());
const pickerPanel = el("section", { className: "panel picker-panel", hidden: true }, [
  pickerTitle,
  picker.element,
  el("div", { className: "row" }, [el("span", { className: "fine" }, ["使う範囲: ", pickerRange]), pickerListen, pickerUse]),
  el("div", { className: "row tight seek-row" }, [pickerSeek, pickerClock]),
  el("p", { className: "fine", textContent: "ハンドルをドラッグして範囲を決めます。帯の中をドラッグすると範囲ごと動き、外を押すとそこへ移ります。波形を 1 回押すと再生位置、2 回押すとそこから再生。一度に使えるのは 60 秒までですが、あとから「別の範囲を選ぶ」で何度でも選び直せます。" }),
]);
// A tap on the picker's waveform: the play position (within the selection); a second tap plays from there.
picker.onSeek = (sec, how) => {
  const r = picker.value;
  pickerCue = Math.max(0, Math.min(r.to - r.from, sec - r.from));
  showPickerSeek(pickerCue);
  if (pickerPlaying) client.seekPreview(pickerCue);
  else picker.setPlayhead(r.from + pickerCue);
  if (how === "play" && !pickerPlaying) pickerListen.click();
};
picker.onChange = (r) => {
  pickerRange.textContent = `${clock(r.from)} – ${clock(r.to)}(${(r.to - r.from).toFixed(1)} 秒)`;
  // A new selection: playback (of the old one) stops, and the cue goes back to its start.
  if (pickerPlaying) client.stopPreview();
  pickerCue = 0;
  showPickerSeek(0);
};
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
const queueFirstKey = el("select", { ariaLabel: "最初の鍵" }, [24, 36, 48, 60].map((n) => el("option", { value: String(n), textContent: pitchLabel(n), selected: n === 36 })));
const queueWavsButton = button("すべて単音 WAV で保存(zip)", "", () => void deliverQueue("wavs"));
const queueKitButton = button("鍵に並べたワンショット音源にする(zip: SFZ + Decent Sampler)", "primary", () => void deliverQueue("kit"));
const queueStatus = el("p", { className: "fine", role: "status" });
const queuePanel = el("section", { className: "panel queue-panel", hidden: true }, [
  el("div", { className: "row" }, [el("strong", { textContent: "素材リスト" }), el("span", { className: "fine", textContent: "1 つずつ開いて調整できます(設定は素材ごとに残ります)。調整していないものは、そのまま一括で書き出せます。" })]),
  queueList,
  el("div", { className: "row" }, [
    el("label", { className: "control check" }, [queueOneShot, el("span", { textContent: "調整していない素材はワンショット(録音のまま、伸ばさない)として扱う" })]),
  ]),
  el("div", { className: "row" }, [queueWavsButton, queueKitButton, el("label", { className: "row tight" }, [el("span", { className: "fine", textContent: "最初の鍵" }), queueFirstKey])]),
  queueStatus,
]);

function renderQueue(): void {
  queuePanel.hidden = queue.length < 2;
  queueList.replaceChildren(
    ...queue.map((item, i) => {
      const open = button(i === queueIndex ? "開いています" : "開く", "small", () => void openQueueItem(i));
      open.disabled = i === queueIndex;
      const remove = button("リストから外す", "small", () => {
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
      const base = safeBaseName(stripExtension(item.file.name));
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

let builtQueue: { key: string; result: Built; skipped: string[] } | null = null;

async function deliverQueue(kind: "wavs" | "kit"): Promise<void> {
  if (building || queue.length === 0) return;
  building = true;
  try {
    // The zip is kept once made: on an iPhone the share sheet only opens on a fresh tap, which a long build uses up.
    const key = JSON.stringify([kind, queue.map((q) => [q.file.name, q.file.size, q.file.lastModified]), queueFirstKey.value, exportSettings, credit]);
    let built: Built;
    let skipped: string[];
    if (builtQueue?.key === key) ({ result: built, skipped } = builtQueue);
    else {
      const inputs = await queueInputs();
      skipped = inputs.skipped;
      if (inputs.inputs.length === 0) {
        queueStatus.textContent = `書き出せるものがありません。${skipped.join("、")}`;
        return;
      }
      const progress = async (done: number, total: number) => {
        queueStatus.textContent = `作成中… ${done} / ${total}`;
        await yieldToScreen();
      };
      const first = safeBaseName(stripExtension(queue[0].file.name));
      built = kind === "kit" ? await buildKit(inputs.inputs, `${first}_kit`, Number(queueFirstKey.value), progress) : await buildBatch(inputs.inputs, null, `${first}_など${queue.length}件`, progress);
      if (kind === "kit") built = forDestination(built);
      builtQueue = { key, result: built, skipped };
    }
    const note = skipped.length ? ` — 飛ばしたもの: ${skipped.join("、")}` : "";
    if (SHARE_ONLY && canShareFiles()) {
      try {
        const outcome = await shareFile(built.blob, built.fileName, built.fileName);
        queueStatus.textContent = outcome === "shared" ? `共有しました: ${built.summary}${note}` : "";
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "NotAllowedError") {
          queueStatus.textContent = "できました。もう一度押すと共有シートが開きます。";
          return;
        }
      }
    }
    downloadFile(built.blob, built.fileName);
    queueStatus.textContent = `保存しました: ${built.summary}${note}`;
  } catch (error) {
    queueStatus.textContent = `書き出せませんでした: ${error instanceof Error ? error.message : error}`;
  } finally {
    building = false;
  }
}

/** Files dropped or chosen: one opens; several make a queue and open the first. Settings and MIDI files are read on their own. */
function openFiles(files: readonly File[]): void {
  const project = files.find((f) => f.name.toLowerCase().endsWith(PROJECT_FILE_EXTENSION));
  if (project) {
    void openProjectFile(project);
    return;
  }
  const isSettings = (f: File) => f.name.toLowerCase().endsWith(".json") || f.type === "application/json";
  const settings = files.filter(isSettings);
  const midi = files.filter((f) => !isSettings(f) && isMidiFile(f));
  const audio = files.filter((f) => !isSettings(f) && !isMidiFile(f));
  const lastMidi = midi.at(-1);
  if (lastMidi) {
    setView("song");
    void rollPanel.openMidi(lastMidi);
  }
  for (const f of settings) void openFile(f);
  if (audio.length === 0) return;
  if (view === "kit") {
    void addKitFiles(audio);
    return;
  }
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

// ---------------------------------------------------------------- projects (several in the browser; one as a file)

const projectButton = button("プロジェクト", "", () => void openProjectPanel());
projectButton.classList.add("project-button");
const saveState = el("span", { className: "fine save-state", role: "status" });
let lastSaveState: SaveState = "saved";
onSaveState((state) => {
  lastSaveState = state;
  saveState.textContent = state === "saving" ? "保存中…" : state === "failed" ? "⚠ 保存できませんでした" : "保存済み";
  saveState.classList.toggle("warn", state === "failed");
  saveState.title = state === "failed" ? "ブラウザに保存できませんでした。空き容量が足りないか、プライベートウィンドウかもしれません。「プロジェクト」からファイルに保存しておくと安心です。" : "編集はこのブラウザに自動で保存されます";
});
function refreshProjectButton(): void {
  projectButton.textContent = `📁 ${currentProject()?.name ?? "プロジェクト"}`;
}

/** Everything waiting to be saved goes out, and is done. */
async function flushAll(): Promise<void> {
  flushSave();
  await rollPanel.flush();
  await whenSaved();
}

/** Opens another project: the open one is saved first, then the page starts again on the chosen one. */
async function switchProject(id: string): Promise<void> {
  await flushAll();
  await chooseProject(id);
  location.reload();
}

/** The open project as one file (.easysampler): every material's samples and settings, and the song. */
/** A project file made but not yet shared (iPhone home-screen app: the share sheet needs a fresh tap). */
let projectFileReady: { blob: Blob; fileName: string; at: number } | null = null;

async function saveProjectFile(): Promise<void> {
  if (SHARE_ONLY && projectFileReady && Date.now() - projectFileReady.at < 60_000) {
    const ready = projectFileReady;
    projectFileReady = null;
    try {
      await shareFile(ready.blob, ready.fileName, ready.fileName);
      status.textContent = `「${ready.fileName}」を共有しました。`;
    } catch (error) {
      status.textContent = `共有できませんでした: ${error instanceof Error ? error.message : error}`;
    }
    return;
  }
  await flushAll();
  const name = currentProject()?.name ?? "プロジェクト";
  const materials = [...library.values()].map(({ material: m, settings }) => ({
    id: m.id,
    name: m.name,
    sampleRate: m.sampleRate,
    channels: m.channels,
    settings: material && m.id === material.id ? serializeSettings(settingsBody()) : settings ? serializeSettings(settings) : null,
  }));
  // The kit's recordings travel as materials without settings (the song's kit lists them; they never join the material list).
  for (const slot of rollPanel.kit.slots) {
    const audio = slot.sample ? kitAudio.get(slot.sample) : undefined;
    if (slot.sample && audio && !materials.some((m) => m.id === slot.sample)) materials.push({ id: slot.sample, name: audio.name, sampleRate: audio.sampleRate, channels: audio.channels, settings: null });
  }
  const bytes = buildProjectFile({ name, project: rollPanel.snapshot(), materials });
  const fileName = `${safeBaseName(name)}${PROJECT_FILE_EXTENSION}`;
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const size = `素材 ${materials.length} 個、${(bytes.byteLength / 1048576).toFixed(1)} MB`;
  if (SHARE_ONLY && canShareFiles()) {
    try {
      await shareFile(blob, fileName, fileName);
      status.textContent = `「${fileName}」を共有しました(${size})。`;
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        projectFileReady = { blob, fileName, at: Date.now() };
        status.textContent = `できました(${size})。もう一度「ファイルに保存」を押すと共有シートが開きます。`;
      } else status.textContent = `共有できませんでした: ${error instanceof Error ? error.message : error}`;
    }
    return;
  }
  downloadFile(blob, fileName);
  status.textContent = `「${fileName}」に保存しました(${size})。`;
}

/** A project file becomes a new project in the browser (its materials under new ids), and opens. */
async function openProjectFile(file: File): Promise<void> {
  let data;
  try {
    data = parseProjectFile(new Uint8Array(await file.arrayBuffer()));
  } catch (error) {
    status.textContent = `開けませんでした: ${error instanceof Error ? error.message : error}`;
    return;
  }
  status.textContent = `「${data.name}」を読み込んでいます…`;
  const map = new Map(data.materials.map((m) => [m.id, newMaterialId()]));
  for (const m of data.materials) {
    const id = map.get(m.id)!;
    await keep(`audio:${id}`, { name: m.name, sampleRate: m.sampleRate, channels: m.channels });
    if (m.settings) await keep(`settings:${id}`, m.settings);
  }
  const names = new Set(projectList().map((p) => p.name));
  let name = data.name;
  for (let k = 2; names.has(name); k++) name = `${data.name} (${k})`;
  const entry = await createProject(name, remapMaterials(data.project, map));
  await switchProject(entry.id);
}

const projectFileInput = el("input", { type: "file", accept: `${PROJECT_FILE_EXTENSION},application/octet-stream,application/zip`, className: "visually-hidden" });
projectFileInput.addEventListener("change", () => {
  const file = projectFileInput.files?.[0];
  projectFileInput.value = "";
  if (file) void openProjectFile(file);
});

const projectDialog = el("dialog", { className: "project-dialog" });
const megabytes = (n: number) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : `${Math.max(0.1, n / 1048576).toFixed(1)} MB`);

/** The projects: the open one (name, file), the others (open, copy, remove), and how much room the browser gives. */
async function openProjectPanel(): Promise<void> {
  const current = currentProject();
  const nameInput = el("input", { type: "text", value: current.name, maxLength: 60, ariaLabel: "プロジェクトの名前" });
  nameInput.addEventListener("change", () => {
    void renameProject(current.id, nameInput.value).then(refreshProjectButton);
  });
  const when = (t: number) => new Date(t).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const rows = projectList().map((p) => {
    const isOpen = p.id === current.id;
    const open = button(isOpen ? "開いています" : "開く", `small${isOpen ? "" : " primary"}`, () => void switchProject(p.id));
    open.disabled = isOpen;
    const copy = button("複製", "small", async () => {
      await flushAll();
      const made = await duplicateProject(p.id, `${p.name} のコピー`);
      if (made) void openProjectPanel();
    });
    const remove = button("削除", "small", async () => {
      if (!confirm(`「${p.name}」を削除しますか?素材の音声と打ち込みも消え、元に戻せません。${isOpen ? "(開いているプロジェクトです。削除後はほかのプロジェクトを開きます)" : ""}`)) return;
      if (isOpen) {
        await flushAll();
        await removeProject(p.id);
        location.reload();
        return;
      }
      await removeProject(p.id);
      void openProjectPanel();
    });
    return el("div", { className: `project-row${isOpen ? " open" : ""}` }, [
      el("span", { className: "project-name", textContent: p.name }),
      el("span", { className: "fine num", textContent: when(p.updatedAt) }),
      el("span", { className: "row tight" }, [open, copy, remove]),
    ]);
  });
  const room = el("p", { className: "fine" });
  void storageEstimate().then((e) => {
    if (!e) return;
    const share = e.quota > 0 ? e.usage / e.quota : 0;
    room.textContent = `このブラウザの保存領域: ${megabytes(e.usage)} 使用 / 上限 約 ${megabytes(e.quota)}${share > 0.8 ? "。残りが少なくなっています。使っていないプロジェクトを削除するか、ファイルに保存してから削除してください。" : ""}`;
    room.classList.toggle("warn", share > 0.8);
  });
  projectDialog.replaceChildren(
    el("div", { className: "row" }, [el("span", { className: "control-label", textContent: "プロジェクト" }), el("span", { className: "spacer" }), button("閉じる", "small", () => projectDialog.close())]),
    el("label", { className: "control" }, [el("span", { className: "control-label", textContent: "開いているプロジェクトの名前" }), nameInput]),
    el("div", { className: "row" }, [
      button("ファイルに保存(.easysampler)", "small primary", () => void saveProjectFile()),
      button("ファイルから開く", "small", () => projectFileInput.click()),
      button("新しいプロジェクト", "small", async () => {
        await flushAll();
        const entry = await createProject(`プロジェクト ${projectList().length + 1}`);
        await switchProject(entry.id);
      }),
    ]),
    el("p", { className: "fine", textContent: "編集はこのブラウザに自動で保存されます。ファイルに保存すると、素材の音声・区間の設定・打ち込みが 1 つにまとまり、別の端末やブラウザで「ファイルから開く」で続きができます(ファイルはページにドロップしても開けます)。" }),
    el("div", { className: "project-list" }, rows),
    room,
    projectFileInput,
  );
  if (!projectDialog.open) projectDialog.showModal();
}
projectDialog.addEventListener("click", (e) => {
  // A click on the backdrop closes it.
  if (e.target === projectDialog) projectDialog.close();
});
window.addEventListener("beforeunload", (e) => {
  if (lastSaveState === "saving") e.preventDefault();
});

// ---------------------------------------------------------------- the drum kit (design.md 13.2)

/** The kit's recordings by sample id (kept as audio:<id>), and what the engine plays per key (cut, faded, at its rate). */
const kitAudio = new Map<string, { name: string; sampleRate: number; channels: Float32Array[] }>();
const kitBuilt = new Map<number, string>();
const kitBuffers = new Map<number, Float32Array[]>();

/** The kit's sounds to the engine: a key whose sound changed is cut again; one that lost its sound goes. */
function rebuildKit(force = false): void {
  if (force) kitBuilt.clear();
  const rate = client.sampleRate;
  const live = new Set<number>();
  for (const slot of rollPanel.kit.slots) {
    const audio = slot.sample ? kitAudio.get(slot.sample) : undefined;
    if (!audio) continue;
    live.add(slot.key);
    const sig = JSON.stringify([slot.sample, slot.start, slot.end, slot.gain, slot.fade, rate]);
    if (kitBuilt.get(slot.key) === sig) continue;
    const buffers = renderSlot(slot, audio.channels, audio.sampleRate, rate, resample);
    kitBuffers.set(slot.key, buffers);
    kitBuilt.set(slot.key, sig);
    client.setSample(`kit:${slot.key}`, buffers);
  }
  for (const key of [...kitBuffers.keys()]) {
    if (live.has(key)) continue;
    kitBuffers.delete(key);
    kitBuilt.delete(key);
    client.setSample(`kit:${key}`, null);
  }
}

/**
 * Where the keyboard goes: in the 素材 view the cut being edited, dry; in the
 * kit view the kit, dry; in the 曲 view the selected track — its cut (the
 * cut being edited when it has none of its own) or the kit for a drum track —
 * through the track's effects and the master, as it sounds in the song.
 */
function routeKeyboard(): void {
  keysTitle.textContent = view === "song" ? `鍵盤(「${rollPanel.trackName}」をエフェクト込みで)` : view === "kit" ? "鍵盤(ドラムキット)" : "試し弾き";
  keysNote.hidden = view !== "material";
  const editing = material && cuts[current] ? instrumentId(material.id, cuts[current].id) : null;
  const spec = rollPanel.kitSpec();
  if (view === "song") {
    const target = rollPanel.liveTarget();
    client.setLive(target.instrument ?? editing, target.fx, true);
    client.setLiveKit(target.drum, spec.samples, spec.keys);
    return;
  }
  client.setLive(editing, null, false);
  client.setLiveKit(view === "kit", spec.samples, spec.keys);
}
/** (The kit's sounds changed: the keyboard's kit too.) */
function sendLiveKit(): void {
  routeKeyboard();
}
rollPanel.onLiveChange = routeKeyboard;

/** The kit's recordings back from the store (at start). */
async function loadKitAudio(): Promise<void> {
  for (const slot of rollPanel.kit.slots) {
    if (!slot.sample || kitAudio.has(slot.sample)) continue;
    const audio = (await kept(`audio:${slot.sample}`)) as { name: string; sampleRate: number; channels: Float32Array[] } | undefined;
    if (audio?.channels?.length) kitAudio.set(slot.sample, audio);
  }
}

/** A sound onto a key (replacing what it had): kept with the project, heard at once. */
async function addKitSound(key: number, name: string, channels: Float32Array[], sampleRate: number): Promise<void> {
  const id = newMaterialId();
  kitAudio.set(id, { name, sampleRate, channels });
  await keep(`audio:${id}`, { name, sampleRate, channels });
  const old = slotFor(rollPanel.kit, key)?.sample ?? null;
  // It starts where the hit does (leading silence skipped; the waveform's handle moves it).
  const fresh = { ...newSlot(key, id, name), start: detectOnset(channels, sampleRate) };
  rollPanel.updateKit((kit) => {
    const slot = slotFor(kit, key);
    if (slot) Object.assign(slot, fresh);
    else kit.slots.push(fresh);
  });
  forgetKitAudioIfUnused(old);
}

function forgetKitAudioIfUnused(id: string | null): void {
  if (!id || rollPanel.kit.slots.some((s) => s.sample === id)) return;
  kitAudio.delete(id);
  // The song that no longer lists it is saved first, so a page ended in between never points at missing audio.
  void rollPanel.flush().then(() => whenSaved()).then(() => forget(`audio:${id}`));
}
rollPanel.kitSoundReady = (key) => kitBuffers.has(key);
rollPanel.materialSeconds = (id) => {
  const m = library.get(id)?.material;
  return m ? m.channels[0].length / m.sampleRate : null;
};

/** The longest a drum sound is kept (seconds): a hit, not a song. */
const KIT_MAX_SEC = 20;

/** Sound files into the kit: each to the key its name suggests (kick, snare, hihat…), or to the given key. */
async function addKitFiles(files: readonly File[], forcedKey: number | null = null): Promise<void> {
  const taken = new Set(rollPanel.kit.slots.filter((s) => s.sample).map((s) => s.key));
  const done: string[] = [];
  const failed: string[] = [];
  for (const file of files) {
    try {
      const { channels, sampleRate } = await decode(file);
      const name = stripExtension(file.name);
      const key = forcedKey ?? guessKey(name, taken);
      taken.add(key);
      await addKitSound(key, name, channels.map((c) => c.slice(0, Math.min(c.length, Math.round(KIT_MAX_SEC * sampleRate)))), sampleRate);
      done.push(`${drumName(key)} ← ${file.name}`);
    } catch (error) {
      failed.push(`${file.name}(${error instanceof Error ? error.message : error})`);
    }
  }
  kitStatus.textContent = (done.length ? `割り当てました: ${done.join("、")}。` : "") + (failed.length ? ` 読み込めなかったもの: ${failed.join("、")}` : "");
}

const kitFileInput = el("input", { type: "file", accept: "audio/*,video/*", multiple: true, className: "visually-hidden" });
kitFileInput.addEventListener("change", () => {
  const files = [...(kitFileInput.files ?? [])];
  kitFileInput.value = "";
  if (files.length) void addKitFiles(files);
});
/** One file for one key (the row's 「ファイル」). */
let kitFileKey: number | null = null;
const kitOneInput = el("input", { type: "file", accept: "audio/*,video/*", className: "visually-hidden" });
kitOneInput.addEventListener("change", () => {
  const file = kitOneInput.files?.[0];
  kitOneInput.value = "";
  if (file && kitFileKey !== null) void addKitFiles([file], kitFileKey);
});
const kitStatus = el("p", { className: "fine", role: "status" });
const kitList = el("div", { className: "kit-list" });
const kitAddKey = el("select", { ariaLabel: "鍵を追加" });
const GM_RANGE = Array.from({ length: 47 }, (_, i) => 35 + i);

/**
 * A kit sound's waveform with where it starts and ends: drag to move the start
 * (or the end, when grabbed near it); let go and the hit sounds as it now is.
 */
function kitWave(key: number, slot: KitSlot, audio: { sampleRate: number; channels: Float32Array[] }): HTMLElement {
  const canvas = el("canvas", { className: "kit-wave", ariaLabel: "波形(ドラッグで始まりと終わり)" });
  const total = audio.channels[0].length / audio.sampleRate;
  let start = slot.start;
  let end = slot.end > slot.start ? slot.end : total;
  const draw = () => {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 240;
    const h = canvas.clientHeight || 40;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const g = canvas.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = cssVar("--outside");
    g.fillRect(0, 0, w, h);
    const x = audio.channels[0];
    const per = x.length / w;
    g.fillStyle = cssVar("--accent");
    for (let px = 0; px < w; px++) {
      let peak = 0;
      const a = Math.floor(px * per);
      const b = Math.min(x.length, Math.floor((px + 1) * per) + 1);
      for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(x[i]));
      const bar = Math.max(1, peak * h);
      g.fillRect(px, (h - bar) / 2, 1, bar);
    }
    // What is not played, dimmed; the start and the end as lines.
    const xs = (start / total) * w;
    const xe = (end / total) * w;
    g.fillStyle = cssVar("--bg");
    g.globalAlpha = 0.65;
    g.fillRect(0, 0, xs, h);
    g.fillRect(xe, 0, w - xe, h);
    g.globalAlpha = 1;
    g.fillStyle = cssVar("--warn");
    g.fillRect(Math.round(xs) - 1, 0, 2, h);
    g.fillStyle = cssVar("--muted");
    g.fillRect(Math.round(xe) - 1, 0, 2, h);
  };
  let grab: "start" | "end" | null = null;
  const secAt = (e: PointerEvent) => {
    const box = canvas.getBoundingClientRect();
    return Math.max(0, Math.min(total, ((e.clientX - box.left) / Math.max(1, box.width)) * total));
  };
  canvas.addEventListener("pointerdown", (e) => {
    const sec = secAt(e);
    const box = canvas.getBoundingClientRect();
    const px = (sec / total) * box.width;
    const ePx = (end / total) * box.width;
    grab = Math.abs(px - ePx) < 10 && Math.abs(px - ePx) < Math.abs(px - (start / total) * box.width) ? "end" : "start";
    canvas.setPointerCapture(e.pointerId);
    if (grab === "start") start = Math.min(sec, end - 0.005);
    else end = Math.max(sec, start + 0.005);
    draw();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!grab) return;
    const sec = secAt(e);
    if (grab === "start") start = Math.min(sec, end - 0.005);
    else end = Math.max(sec, start + 0.005);
    draw();
  });
  const done = () => {
    if (!grab) return;
    grab = null;
    rollPanel.updateKit((k) => {
      const target = slotFor(k, key);
      if (!target) return;
      target.start = start;
      target.end = end >= total - 1e-6 ? 0 : end;
    });
    client.kitHit(key);
  };
  canvas.addEventListener("pointerup", done);
  canvas.addEventListener("pointercancel", done);
  requestAnimationFrame(draw);
  new ResizeObserver(draw).observe(canvas);
  return canvas;
}

function renderKitPanel(): void {
  // (The list is drawn again after each change: the field being typed in gets the focus back.)
  const focused = document.activeElement instanceof HTMLElement && kitList.contains(document.activeElement) ? document.activeElement.dataset.kitField ?? null : null;
  queueMicrotask(() => {
    if (!focused) return;
    kitList.querySelector<HTMLElement>(`[data-kit-field="${focused}"]`)?.focus();
  });
  const kit = rollPanel.kit;
  const keys = [...new Set([...COMMON_KEYS, ...kit.slots.map((s) => s.key)])].sort((a, b) => a - b);
  const ms = (v: number) => String(Math.round(v * 1000));
  const rows = keys.map((key) => {
    const slot = slotFor(kit, key);
    const audio = slot?.sample ? kitAudio.get(slot.sample) : undefined;
    const lengthSec = audio ? audio.channels[0].length / audio.sampleRate : 0;
    const edit = (change: (s: NonNullable<typeof slot>) => void) => rollPanel.updateKit((k) => {
      const target = slotFor(k, key);
      if (target) change(target);
    });
    const number = (label: string, value: number, set: (s: NonNullable<typeof slot>, sec: number) => void, title: string) => {
      const input = el("input", { type: "number", min: "0", step: "1", inputMode: "numeric", value: ms(value), ariaLabel: label, title, className: "kit-ms" });
      input.dataset.kitField = `${key}:${label}`;
      input.addEventListener("change", () => edit((s) => set(s, Math.max(0, Number(input.value) || 0) / 1000)));
      return el("label", { className: "inline fine" }, [`${label} `, input]);
    };
    const play = button("▶", "small", () => client.kitHit(key));
    play.title = "この鍵の音を聴く(鍵盤でも鳴らせます)";
    const choose = button(slot?.sample ? "差し替え" : "ファイル", "small", () => {
      kitFileKey = key;
      kitOneInput.click();
    });
    const parts: HTMLElement[] = [
      el("span", { className: "kit-key num", textContent: `${pitchLabel(key)}` }),
      el("strong", { className: "kit-drum", textContent: drumName(key) }),
      el("span", { className: "fine kit-name", textContent: slot?.sample ? `${slot.name}(${lengthSec.toFixed(2)} 秒)` : "簡易ドラム" }),
      play,
      choose,
    ];
    if (slot?.sample && audio) {
      const gain = el("input", { type: "range", min: "0", max: "2", step: "0.05", value: String(slot.gain), ariaLabel: "音量" });
      gain.addEventListener("change", () => edit((s) => (s.gain = Number(gain.value))));
      gain.addEventListener("dblclick", () => edit((s) => (s.gain = 1)));
      parts.push(
        kitWave(key, slot, audio!),
        button("頭を合わせる", "small", () => {
          edit((s) => (s.start = detectOnset(audio!.channels, audio!.sampleRate)));
          client.kitHit(key);
        }),
        number("始まり ms", slot.start, (s, v) => (s.start = Math.min(v, lengthSec)), "録音のどこから鳴らすか"),
        number("終わり ms", slot.end, (s, v) => (s.end = v), "どこまで鳴らすか(0 = 最後まで)"),
        number("フェード ms", slot.fade, (s, v) => (s.fade = v), "終わりを何ミリ秒かけて消すか"),
        el("label", { className: "inline fine" }, ["音量 ", gain]),
        button("×", "small", () => {
          if (!confirm(`${drumName(key)}の音「${slot.name}」を外しますか?(簡易ドラムに戻ります。元に戻せません)`)) return;
          const old = slot.sample;
          rollPanel.updateKit((k) => {
            k.slots = k.slots.filter((x) => x.key !== key);
          });
          forgetKitAudioIfUnused(old);
        }),
      );
    } else if (slot) {
      parts.push(button("×", "small", () => rollPanel.updateKit((k) => (k.slots = k.slots.filter((x) => x.key !== key)))));
    }
    const row = el("div", { className: `kit-row${slot?.sample ? " own" : ""}` }, parts);
    // A file dropped on a row goes to that key.
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      row.classList.add("drop");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drop"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      row.classList.remove("drop");
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files[0]) void addKitFiles([files[0]], key);
    });
    return row;
  });
  kitList.replaceChildren(...rows);
  kitAddKey.replaceChildren(el("option", { value: "", textContent: "(鍵を選ぶ)" }), ...GM_RANGE.filter((k) => !keys.includes(k)).map((k) => el("option", { value: String(k), textContent: `${pitchLabel(k)} ${drumName(k)}` })));
  kitTabInfo.textContent = `自分の音 ${kit.slots.filter((x) => x.sample).length}`;
}
kitAddKey.addEventListener("change", () => {
  const key = Number(kitAddKey.value);
  if (!kitAddKey.value || slotFor(rollPanel.kit, key)) return;
  rollPanel.updateKit((k) => k.slots.push({ ...newSlot(key, null, drumName(key)) }));
});

const kitPanel = el("section", { className: "panel kit-panel" }, [
  el("div", { className: "row" }, [el("span", { className: "control-label", textContent: "ドラムキット" }), button("ドラムの音を追加(複数可)", "small primary", () => kitFileInput.click()), kitFileInput, kitOneInput]),
  el("p", {
    className: "fine help",
    textContent: "鍵(GM ドラムの配置)ごとに 1 つの音を、録音どおりに 1 回鳴らします。ファイル名(kick・snare・hihat・clap・crash など)から鍵を自動で決めます。行にファイルをドロップするとその鍵に入ります。素材の画面で波形を選んで「ドラムキットへ」でも送れます。音のない鍵は簡易ドラムで鳴ります。この画面では鍵盤がキットを鳴らします。",
  }),
  kitList,
  el("div", { className: "row" }, [el("label", { className: "inline fine" }, ["鍵を追加 ", kitAddKey])]),
  kitStatus,
]);
const kitTabInfo = el("span", { className: "fine view-tab-info" });
rollPanel.onKitChange = () => {
  rebuildKit();
  sendLiveKit();
  renderKitPanel();
};
rollPanel.onKitHit = (key) => client.kitHit(key);
rollPanel.onOpenKit = () => setView("kit");
rollPanel.onOpenFx = () => {
  fxTarget = "track";
  showFxTarget();
  fxPanel.open = true;
  fxPanel.scrollIntoView({ behavior: "smooth", block: "start" });
};

// ---------------------------------------------------------------- the two views: 素材 (the sound) and 曲 (the song)

/**
 * The page has two sides (design.md 13.1): the material and its cuts — the
 * sound — and the song — tracks, notes, effects. Each is a view of its own;
 * the keyboard is in both (trying a sound, step input). Space and Ctrl+Z
 * belong to the view on screen.
 */
type View = "material" | "kit" | "song";
const VIEW_KEY = "easysampler.view";
const storedView = safeStorage(VIEW_KEY);
let view: View = storedView === "song" || storedView === "kit" ? storedView : "material";
for (const panel of [guide, materialPanel, tunePanel, exportPanel, detailsPanel]) panel.classList.add("axis-material");
for (const panel of [rollPanel.element, fxPanel]) panel.classList.add("axis-song");
kitPanel.classList.add("axis-kit");
const materialTab = el("button", { type: "button", className: "view-tab", role: "tab" }, [el("span", { className: "view-tab-title", textContent: "素材(音を作る)" }), materialTabInfo()]);
const kitTab = el("button", { type: "button", className: "view-tab", role: "tab" }, [el("span", { className: "view-tab-title", textContent: "ドラムキット" }), kitTabInfo]);
const songTab = el("button", { type: "button", className: "view-tab", role: "tab" }, [el("span", { className: "view-tab-title", textContent: "曲(打ち込み)" }), rollPanel.summaryInfo]);
kitTab.addEventListener("click", () => setView("kit"));
materialTab.addEventListener("click", () => setView("material"));
songTab.addEventListener("click", () => setView("song"));
const viewTabs = el("nav", { className: "view-tabs", role: "tablist", ariaLabel: "表示" }, [materialTab, kitTab, songTab]);

/** The 素材 tab's line: the material being edited and how many there are. */
function materialTabInfo(): HTMLElement {
  return el("span", { className: "fine view-tab-info", id: "material-tab-info" });
}
function refreshMaterialTab(): void {
  const info = materialTab.querySelector(".view-tab-info");
  if (info) info.textContent = material ? `${material.name}${library.size > 1 ? `(ほか ${library.size - 1})` : ""}` : "";
}

let pianoBeforeKit: { low: number; high: number; pc: number } | null = null;

function setView(next: View): void {
  view = next;
  safeStorage(VIEW_KEY, next);
  workspace.dataset.view = next;
  for (const [tab, name] of [[materialTab, "material"], [kitTab, "kit"], [songTab, "song"]] as const) {
    tab.classList.toggle("on", next === name);
    tab.setAttribute("aria-selected", String(next === name));
  }
  // In the kit view the keyboard plays the kit, its keys on the GM drums (and back where they were after).
  sendLiveKit();
  if (next === "kit") {
    if (!pianoBeforeKit) pianoBeforeKit = { low: piano.low, high: piano.high, pc: pcKeys.state.baseNote };
    piano.setRange(36, 36 + (piano.high - piano.low));
    pcKeys.state.baseNote = 36;
    renderKitPanel();
  } else if (pianoBeforeKit) {
    piano.setRange(pianoBeforeKit.low, pianoBeforeKit.high);
    pcKeys.state.baseNote = pianoBeforeKit.pc;
    pianoBeforeKit = null;
  }
  rollPanel.setVisible(next === "song");
  if (next !== "song") rollPanel.pause();
  // (A material preview does not follow into the other views.)
  if (next !== "material") client.stopPreview();
  else {
    client.stopPreview();
    editor.draw();
  }
  if (next === "material") editor.draw();
  window.scrollTo({ top: 0 });
}

const workspace = el("main", { className: "workspace", hidden: true }, [viewTabs, guide, materialPanel, tunePanel, kitPanel, keysPanel, rollPanel.element, fxPanel, exportPanel, detailsPanel]);
setView(view);

document.getElementById("app")!.append(
  el("header", { className: "top" }, [el("h1", { textContent: "EasySampler" }), el("div", { className: "row" }, [volumeControl, projectButton, saveState, rePickButton, openButton, micButton, pianoButton])]),
  fileInput,
  projectDialog,
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
    // Short material with hardly anything steady to sustain: play it through as it is, at the note.
    if (preset === "synth" && isShortMaterial(m)) {
      Object.assign(p, PRESETS.find((x) => x.id === "short")!.apply(p));
      preset = "short";
    }
  } else {
    // Nothing pitched (a hit, a noise), or a one-shot by request: plays as recorded, from its own pitch (C4 when there is none).
    p.root = root?.midi ?? 60;
    p.rootMode = root ? "auto" : "manual";
    Object.assign(p, oneShotParams(p));
    preset = "";
  }
  return { id: newCutId(), name, markers: m, params: p, note: Math.max(24, Math.min(96, Math.round(p.root))), noteMode: "auto", presetId: preset, detectedRoot: root?.midi ?? null };
}

/** A clip with less than this much steady sustain is "short": a shout or a word, not a note to stretch. */
const SHORT_SUSTAIN_SEC = 0.2;
function isShortMaterial(m: Markers): boolean {
  return m.sustainEnd - m.sustainStart < SHORT_SUSTAIN_SEC || m.rangeEnd - m.rangeStart < 0.5;
}

/** One cut from the analysis, as on a fresh load. */
/** The preset the next new material's first cut starts from (the built-in piano asks for "decay"). */
let nextPresetHint: PresetId | "" = "";

function freshCuts(): void {
  if (!material) return;
  presetId = nextPresetHint || "synth";
  nextPresetHint = "";
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
  rebuildCutSelect();
  cutName.value = cut.name;
  removeCutButton.disabled = cuts.length < 2;
  refreshControls();
  sendInstrument();
}

function rebuildCutSelect(): void {
  cutSelect.replaceChildren(...cuts.map((c, i) => el("option", { value: String(i), textContent: `${i + 1}. ${c.name}` })));
  cutSelect.value = String(current);
  // One cut: nothing to choose or name yet — only "＋ 区間を追加".
  const single = cuts.length < 2;
  for (const node of [cutSelect, cutName, dupCutButton, removeCutButton]) node.hidden = single;
  batchButton.hidden = single;
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
    cut = { ...structuredClone(cuts[current]), id: newCutId(), name: `${cuts[current].name} のコピー` };
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
  defineMaterialCuts();
}

function removeCut(): void {
  if (cuts.length < 2) return;
  const gone = cuts[current];
  const users = material && gone ? rollPanel.tracksUsing(instrumentId(material.id, gone.id)) : [];
  if (!confirm(`区間「${gone.name}」を削除しますか?${users.length ? `\nこの区間を鳴らしているトラック(${users.join("、")})は鳴らなくなります。` : ""}`)) return;
  cuts.splice(current, 1);
  current = Math.min(current, cuts.length - 1);
  applyCurrentCut();
  if (material && gone) client.dropInstrument(instrumentId(material.id, gone.id));
  defineMaterialCuts();
}

// ---------------------------------------------------------------- state → screen

function sendInstrument(): void {
  if (!markers) return;
  built = null;
  if (material && cuts[current]) {
    const id = instrumentId(material.id, cuts[current].id);
    client.defineInstrument(id, material.id, markers, params, exportLengthSec(exportSettings));
    client.setHold(exportLengthSec(exportSettings));
    routeKeyboard();
    refreshInstruments();
  }
  rootLabel.textContent = pitchLabel(params.root);
  rootSource.textContent = params.rootMode === "auto" ? "(自動判定)" : "(手動)";
  refreshExport();
  if (!playing) setPreviewMode(previewMode);
}

/** The note and export settings → the note row, the length row, the file name, the help, the editor's target line. */
function refreshExport(): void {
  // The tail limit counts in the export BPM (the song's own while one plays); a "stretch" sustain fills the export length.
  if (!rollPanel.playing) client.setTempo(exportSettings.bpm);
  client.setHold(exportLengthSec(exportSettings));
  refreshInstruments();
  tuneScaleRow.hidden = params.tune.mode !== "scale";
  refreshMakeMode();
  if (noteMode === "auto") note = Math.max(24, Math.min(96, Math.round(params.root)));
  noteSelect.value = String(note);
  noteAutoButton.hidden = noteMode === "auto";
  // On a phone the two octaves shown follow the note, so its ● is never off the edge.
  if (SMALL_SCREEN && (note < piano.low || note > piano.high)) {
    const span = piano.high - piano.low;
    const low = Math.max(24, Math.min(96 - span, Math.floor(note / 12) * 12 - 12));
    piano.setRange(low, low + span);
  }
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
  // (A one-shot plays its own length: the held length is not there.)
  lengthBlock.hidden = oneShot;
  lengthBlock.classList.toggle("disabled", wavetable);
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
  destinationHelp.textContent = (formatNotice ? `${formatNotice} ` : "") + DESTINATIONS.find((d) => d.id === exportSettings.destination)!.help(pitchLabel(note), exportSettings.format);
  fileNameLabel.textContent = material ? currentFileName() : "";
  exportStatus.textContent = "";
  built = null;

  if (markers) {
    const flatten = params.transposeOnly ? 0 : params.flatten;
    editor.setParts({ sustain: params.sustainEnabled, tail: params.tail.enabled && params.tail.limit !== "none" });
    const shaper =
      params.tune.mode === "scale" && !params.transposeOnly
        ? (p: number) => {
            const transposed = p + (note - params.root);
            return transposed - params.flatten * (transposed - quantizeToScale(transposed, params.tune.scale, params.tune.key));
          }
        : null;
    // (録音した高さで鳴らす: the output stays at the recording's own pitch, whatever the note.)
    editor.setState(markers, params.root, flatten, params.fixedPitch ? params.root : note, params.fixedPitch ? null : shaper);
    refreshFadeGrips();
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
  refreshFixBar();
  piano.setRoot(note);
  syncCut();
  scheduleSave();
}

function baseNameFor(cut: Cut): string {
  if (!material) return "material";
  const base = safeBaseName(stripExtension(material.name));
  return cuts.length > 1 ? `${base}_${cut.name}` : base;
}

function currentFileName(): string {
  const cut = cuts[current];
  if (!material || !cut) return "";
  const base = safeBaseName(baseNameFor(cut));
  // (The working state, not the cut's copy, which is only synced on save.)
  if (params.sustainMode === "none" || exportSettings.format === "single") return exportFileName(base, note, exportSettings, params.sustainMode === "none");
  if (exportSettings.format === "loop") return `${base}_${pitchLabel(note).replace("#", "s")}_loop.wav`;
  if (exportSettings.format === "wavetable") return `${base}_wavetable.wav`;
  return `${base}${exportSettings.destination === "decent" ? ".dslibrary" : ".zip"}`;
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

/** What the current cut's file depends on; null without a material. */
function currentKey(): string | null {
  if (!material || !cuts[current]) return null;
  syncCut();
  return JSON.stringify([cuts[current], exportSettings, exportSource().sampleRate, credit]);
}

/** Builds the current cut's file (cached until something changes). */
async function buildCurrent(quiet = false): Promise<Built | null> {
  if (!material || !cuts[current] || building) return built?.result ?? null;
  const key = currentKey()!;
  if (built?.key === key) return built.result;
  const source = exportSource();
  building = true;
  try {
    const result = await buildOne(inputFor(cuts[current], source), async (done, total) => {
      if (total > 1 && !quiet) {
        exportStatus.textContent = `作成中… ${done} / ${total}`;
        await yieldToScreen();
      }
    });
    built = { key, result: forDestination(result) };
    return built.result;
  } finally {
    building = false;
  }
}

/** Decent Sampler takes the instrument folder as a zip called .dslibrary (on an iPhone that is the only way in). */
function forDestination(result: Built): Built {
  if (exportSettings.destination === "decent" && result.fileName.endsWith(".zip")) return { ...result, fileName: result.fileName.replace(/\.zip$/, ".dslibrary") };
  return result;
}

let prebuildTimer = 0;
/** Where the share sheet is the way out, the current file is made ahead, in a quiet moment: then a tap on 共有 opens the sheet at once. */
function schedulePrebuild(): void {
  if (!SHARE_ONLY || !canShareFiles()) return;
  clearTimeout(prebuildTimer);
  prebuildTimer = window.setTimeout(() => {
    if (material && !building && !playing && !rollPanel.playing) void buildCurrent(true).catch(() => {});
  }, 1500);
}

let builtAll: { key: string; result: Built } | null = null;
function allKey(): string {
  syncCut();
  return JSON.stringify(["all", material!.name, cuts, exportSettings, exportSource().sampleRate, credit]);
}

async function buildAll(): Promise<Built | null> {
  if (!material || building) return null;
  const key = allKey();
  if (builtAll?.key === key) return builtAll.result;
  const source = exportSource();
  building = true;
  try {
    const result = await buildBatch(
      cuts.map((cut) => inputFor(cut, source)),
      serializeSettings(settingsBody()),
      material.name,
      async (done, total) => {
        exportStatus.textContent = `作成中… ${done} / ${total}`;
        await yieldToScreen();
      },
    );
    builtAll = { key, result };
    return result;
  } finally {
    building = false;
  }
}

/** What is playing right now, for the playhead: the result (output time) or the original (display time, offset by where the range starts). */
let playing: { kind: "result" } | { kind: "original" } | null = null;
let playheadFrame = 0;

function trackPlayhead(): void {
  cancelAnimationFrame(playheadFrame);
  const step = () => {
    const pos = client.previewPosition();
    if (pos === null || !playing) {
      editor.setPlayhead(null);
      return;
    }
    editor.setPlayhead(playing.kind === "result" ? { kind: "output", sec: pos } : { kind: "display", sec: bufferToDisplay(pos) });
    cue = pos;
    showSeek(pos);
    playheadFrame = requestAnimationFrame(step);
  };
  playheadFrame = requestAnimationFrame(step);
}

function showPlaying(): void {
  const result = playing?.kind === "result";
  listenButton.textContent = result ? "■ 停止" : "▶ 書き出し後を聴く";
  playButton.textContent = playing ? "■" : "▶";
  playButton.classList.toggle("playing", playing !== null);
}

/** The result from the head: the file as it will be written (a multisample's centre zone, a wavetable's sweep). */
async function listen(): Promise<void> {
  if (playing?.kind === "result") {
    client.stopPreview();
    return;
  }
  rollPanel.stop();
  const result = await buildCurrent();
  if (!result) return;
  exportStatus.textContent = exportSettings.format === "multisample" ? `試聴: 中央の音(${pitchLabel(note)})` : "";
  setPreviewMode("result");
  setSeekLength(result.preview.channels[0].length / result.preview.sampleRate);
  playStartCue = cue;
  playing = { kind: "result" };
  showPlaying();
  client.playBuffer(result.preview.channels, result.preview.sampleRate, cue);
  trackPlayhead();
}

/** The stretches of the material the original preview plays, in order: the range minus the removed stretches and the parts switched off. */
function originalPieces(): { from: number; to: number }[] {
  if (!markers) return [];
  const removed = normalizeRemoved([...(markers.removed ?? []), ...hiddenPartsOf(markers, params)], markers.rangeStart, markers.rangeEnd);
  const pieces: { from: number; to: number }[] = [];
  let at = markers.rangeStart;
  for (const r of removed) {
    if (r.start > at) pieces.push({ from: at, to: r.start });
    at = Math.max(at, r.end);
  }
  if (markers.rangeEnd > at) pieces.push({ from: at, to: markers.rangeEnd });
  return pieces;
}

/** Seconds into the original preview's buffer → display time on the editor. */
function bufferToDisplay(sec: number): number {
  let buf = 0;
  const pieces = originalPieces();
  for (const p of pieces) {
    const len = p.to - p.from;
    if (sec < buf + len) return editor.disp(p.from + (sec - buf));
    buf += len;
  }
  const last = pieces.at(-1);
  return last ? editor.disp(last.to) : 0;
}

/** Display time on the editor → seconds into the original preview's buffer (a gap lands on what follows it). */
function displayToBuffer(displaySec: number): number {
  const t = editor.src(displaySec);
  let buf = 0;
  for (const p of originalPieces()) {
    if (t < p.from) return buf;
    if (t < p.to) return buf + (t - p.from);
    buf += p.to - p.from;
  }
  return buf;
}

/** The material from the head, as recorded, within the range and minus the removed stretches and the parts switched off (a short crossfade at each seam). */
async function playOriginal(): Promise<void> {
  if (playing?.kind === "original") {
    client.stopPreview();
    return;
  }
  if (!material || !markers) return;
  rollPanel.stop();
  const rate = material.sampleRate;
  const pieces = originalPieces();
  const fade = Math.round(0.005 * rate);
  const total = pieces.reduce((n, p) => n + Math.round((p.to - p.from) * rate), 0);
  const out = material.channels.map(() => new Float32Array(total));
  let cursor = 0;
  for (const p of pieces) {
    const from = Math.round(p.from * rate);
    const length = Math.round((p.to - p.from) * rate);
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
  setPreviewMode("original");
  setSeekLength(total / rate);
  playStartCue = cue;
  playing = { kind: "original" };
  showPlaying();
  client.playBuffer(out, rate, cue);
  trackPlayhead();
}

client.onPreviewEnd = () => {
  if (pickerPlaying) {
    stopPickerPlayback();
    if (pickerCue >= Number(pickerSeek.max) - 0.02) pickerCue = 0;
    showPickerSeek(pickerCue);
    return;
  }
  const was = playing;
  playing = null;
  showPlaying();
  cancelAnimationFrame(playheadFrame);
  cue = playStartCue;
  showSeek(cue);
  // Where the next ▶ starts, as a still playhead.
  if (was && cue > 0) editor.setPlayhead(was.kind === "result" ? { kind: "output", sec: cue } : { kind: "display", sec: bufferToDisplay(cue) });
  else editor.setPlayhead(null);
};

// Space plays / stops the last preview (書き出し後 to begin with); Shift + Space the original. A song playing stops.
window.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || isTypingTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
  // Picking a stretch of a long clip (whatever else is loaded): Space plays / stops the selection.
  if (!pickerPanel.hidden && pickerClip) {
    event.preventDefault();
    pickerListen.click();
    return;
  }
  if (!material) return;
  event.preventDefault();
  if (view === "kit") return;
  if (view === "song" || rollPanel.playing) {
    rollPanel.toggle();
    return;
  }
  if (playing) {
    client.stopPreview();
    return;
  }
  if (event.shiftKey) setPreviewMode("original");
  void togglePreview();
});

async function deliver(how: "share" | "download", all: boolean): Promise<void> {
  try {
    // The share sheet opens only on the tap itself: a file already made goes to it without any wait in between.
    const ready = all ? (material && builtAll?.key === allKey() ? builtAll.result : null) : built && built.key === currentKey() ? built.result : null;
    const result = ready ?? (all ? await buildAll() : await buildCurrent());
    if (!result) return;
    if (how === "share") {
      try {
        const outcome = await shareFile(result.blob, result.fileName, result.fileName);
        exportStatus.textContent = outcome === "shared" ? `共有しました: ${result.summary}` : "";
        return;
      } catch (error) {
        // A long build used the tap up (iPhone); the file is kept, so the next tap shares it at once.
        if (error instanceof DOMException && error.name === "NotAllowedError") {
          exportStatus.textContent = "できました。もう一度「共有」を押すと共有シートが開きます。";
          return;
        }
        if (IOS && STANDALONE) {
          exportStatus.textContent = `共有できませんでした(${error instanceof Error ? error.message : error})`;
          return;
        }
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
    cuts: cuts.map(({ id, name, markers: m, params: p, note: n, noteMode: mode, presetId: preset }) => ({ id, name, markers: m, params: p, note: n, noteMode: mode, presetId: preset })),
    currentCut: current,
    corrections: material!.corrections,
    pitchRange: material!.pitchRange ?? undefined,
  };
}

// ---------------------------------------------------------------- hand corrections → a new analysis

/** Adds a correction over the selection; the selection stays, so another button can follow on the same stretch. */
async function addCorrection(c: PitchCorrection): Promise<void> {
  if (!material) return;
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
  fixStatus.textContent = corrections.length ? "手直しを反映しています…" : "判定を元に戻しています…";
  try {
    const track = applyCorrections(target.original.track, corrections);
    const { analysis, source } = await client.analyze(target.channels, target.sampleRate, undefined, track);
    if (material !== target) return; // another material was opened meanwhile
    // Keep the original's root/markers fields where they mean "fresh suggestion"; the track and marks are the corrected ones.
    target.analysis = analysis;
    target.source = source;
    target.exportSources = new Map([[source.sampleRate, source]]);
    client.setSource(source, target.id);
    checkEngineRate(target.id);
    editor.setMaterial({ mono: target.mono, sampleRate: target.sampleRate, track: analysis.track });
    editor.setSelection(selection);
    for (const cut of cuts) {
      const root = rootForMarkers(analysis.track, cut.markers);
      cut.detectedRoot = root?.midi ?? null;
      if (cut.params.rootMode === "auto" && root) cut.params = { ...cut.params, root: root.midi };
    }
    applyCurrentCut();
    refreshFixBar();
    fixStatus.textContent = corrections.length ? `手直し ${corrections.length} 件を反映しました。判定 ${pitchLabel(params.root)}。` : "判定を元に戻しました。";
  } catch (error) {
    fixStatus.textContent = `手直しを反映できませんでした: ${error instanceof Error ? error.message : error}`;
  }
}

// ---------------------------------------------------------------- undo / redo
//
// The settings (cuts, markers, params, export settings, corrections) are a
// small JSON snapshot already; every settled change — a drag let go, a
// slider at rest, a button — is one step. Restoring goes through
// applySettings, the same path a loaded file takes.

const HISTORY_MAX = 100;
let history: string[] = [];
let historyIndex = -1;
let restoring = false;
function refreshHistoryButtons(): void {
  undoButton.disabled = historyIndex <= 0;
  redoButton.disabled = historyIndex >= history.length - 1;
}
function recordHistory(json: string): void {
  if (restoring) return;
  if (history[historyIndex] === json) return;
  history = history.slice(0, historyIndex + 1);
  history.push(json);
  if (history.length > HISTORY_MAX) history.shift();
  historyIndex = history.length - 1;
  refreshHistoryButtons();
}
function resetHistory(): void {
  history = [];
  historyIndex = -1;
  refreshHistoryButtons();
}
function restoreHistory(index: number): void {
  const json = history[index];
  if (!material || json === undefined) return;
  const file = parseSettings(json);
  if (!file) return;
  historyIndex = index;
  restoring = true;
  try {
    applySettings(file);
  } finally {
    restoring = false;
  }
  refreshHistoryButtons();
}
function undo(): void {
  if (historyIndex > 0) restoreHistory(historyIndex - 1);
}
function redo(): void {
  if (historyIndex < history.length - 1) restoreHistory(historyIndex + 1);
}
window.addEventListener("keydown", (event) => {
  if (isTypingTarget(event.target) || !(event.ctrlKey || event.metaKey) || event.altKey) return;
  if (view === "kit") return;
  const key = event.key.toLowerCase();
  if (key === "z" && !event.shiftKey) {
    event.preventDefault();
    if (view === "song") rollPanel.roll.undo();
    else undo();
  } else if (key === "y" || (key === "z" && event.shiftKey)) {
    event.preventDefault();
    if (view === "song") rollPanel.roll.redo();
    else redo();
  }
});

let saveTimer = 0;
function saveNow(): void {
  if (!material) return;
  const json = serializeSettings(settingsBody());
  safeStorage(settingsKey(material.name, material.channels[0].length, material.sampleRate), json);
  void keep(`settings:${material.id}`, json);
  recordHistory(json);
}
function scheduleSave(): void {
  if (!material) return;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = 0;
    saveNow();
  }, 400);
  schedulePrebuild();
}
/** Leaving, or going to the background (which on a phone may be the end of the page): a pending save goes out now. */
function flushSave(): void {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = 0;
  saveNow();
}
window.addEventListener("pagehide", () => {
  flushSave();
  void rollPanel.flush();
});
document.addEventListener("visibilitychange", () => {
  // (A phone may end a page in the background without pagehide: what waits to be saved goes now.)
  if (document.visibilityState === "hidden") {
    flushSave();
    void rollPanel.flush();
  }
});

/** Puts a settings file into effect for the loaded material. */
function applySettings(file: SettingsFile, analysed = false): void {
  if (!material) return;
  const duration = material.analysis.durationSec;
  cuts = file.cuts.map((c) => {
    const m = clampMarkers({ ...c.markers, rangeEnd: Math.min(c.markers.rangeEnd, duration) });
    const detected = rootForMarkers(material!.analysis.track, m);
    // The preset as saved; an older file without one gets the first preset its settings still match.
    const saved = c.presetId === "" || PRESETS.some((p) => p.id === c.presetId) ? (c.presetId as PresetId | "") : undefined;
    const preset = saved ?? PRESETS.find((p) => JSON.stringify(p.apply(structuredClone(c.params))) === JSON.stringify(c.params))?.id ?? "";
    return { ...c, markers: m, params: { ...c.params, maxVoices: DEFAULT_PARAMS.maxVoices, transposeOnly: c.params.transposeOnly || ((preset === "transpose" || preset === "short") && c.params.sustainMode === "none") }, presetId: preset, detectedRoot: detected?.midi ?? null };
  });
  current = file.currentCut;
  exportSettings = file.export;
  Object.assign(credit, file.credit);
  setCreditInputs();
  applyCurrentCut();
  if (analysed) {
    refreshFixBar();
    return;
  }
  const range = file.pitchRange ?? null;
  const currentRange = material.pitchRange;
  if ((range?.low ?? 0) !== (currentRange?.low ?? 0) || (range?.high ?? 0) !== (currentRange?.high ?? 0)) {
    material.corrections = file.corrections;
    void setPitchRange(range);
  } else if (file.corrections.length || material.corrections.length) void setCorrections(file.corrections);
  else refreshFixBar();
}

// ---------------------------------------------------------------- loading

/** The media's length from its header alone (nothing decoded); null where the browser cannot tell. */
async function mediaDuration(file: File): Promise<number | null> {
  const url = URL.createObjectURL(file);
  const media = document.createElement(file.type.startsWith("video/") ? "video" : "audio");
  media.preload = "metadata";
  try {
    return await new Promise<number | null>((resolve) => {
      media.addEventListener("loadedmetadata", () => resolve(Number.isFinite(media.duration) ? media.duration : null), { once: true });
      media.addEventListener("error", () => resolve(null), { once: true });
      setTimeout(() => resolve(null), 3000);
      media.src = url;
    });
  } finally {
    media.removeAttribute("src");
    media.load();
    URL.revokeObjectURL(url);
  }
}

class TooLongError extends Error {}

let decodeContext: OfflineAudioContext | null = null;

async function decode(file: File): Promise<{ channels: Float32Array[]; sampleRate: number; truncated: boolean }> {
  const duration = await mediaDuration(file);
  if (duration !== null && duration > DECODE_REFUSE_SEC) {
    throw new TooLongError(`「${file.name}」は ${clock(duration)} あります。${IOS ? "iPhone / iPad では 5 分" : "30 分"}までのファイルを読み込めます。使う部分を先に切り出してください。`);
  }
  const bytes = await file.arrayBuffer();
  // An offline context decodes without needing a user gesture (one is enough for all the files).
  decodeContext ??= new OfflineAudioContext(1, 1, 44100);
  const buffer = await decodeContext.decodeAudioData(bytes);
  const frames = Math.min(buffer.length, Math.round(MAX_DECODE_SEC * buffer.sampleRate));
  const truncated = frames < buffer.length;
  // (No copy unless it is cut: a long file's samples are large.)
  const channels = [...Array(Math.min(2, buffer.numberOfChannels)).keys()].map((c) => (truncated ? buffer.getChannelData(c).slice(0, frames) : buffer.getChannelData(c)));
  return { channels, sampleRate: buffer.sampleRate, truncated };
}

/** What to say when a file would not decode: the formats this device can read. */
function formatHint(file: File): string {
  const ext = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (IOS && ["ogg", "oga", "opus", "webm", "mkv", "wma"].includes(ext)) return `iPhone / iPad は ${ext} を読み込めません。mp3 / m4a / wav / mp4 / mov に変換してください`;
  return "対応していない形式かもしれません。mp3 / wav / m4a / mp4 などで試してください";
}

/** The editor's material goes back to the library, its settings as they are now. */
function stashMaterial(): void {
  if (!material) return;
  flushSave();
  const entry = library.get(material.id);
  if (entry) entry.settings = parseSettings(serializeSettings(settingsBody()));
}

/** Every cut of the editor's material, as instruments the tracks can play. */
function defineMaterialCuts(): void {
  if (!material) return;
  syncCut();
  for (const cut of cuts) client.defineInstrument(instrumentId(material.id, cut.id), material.id, cut.markers, cut.params, exportLengthSec(exportSettings));
  refreshInstruments();
}

/** A cut by its instrument id: its material, its settings as they are now, and its material's export settings. */
function findCut(id: string): { material: Material; cut: CutSettings; exportOf: ExportSettings } | null {
  const [materialId, cutId] = id.split("/");
  const entry = library.get(materialId);
  if (!entry) return null;
  const editing = material?.id === materialId;
  if (editing) syncCut();
  const cut = (editing ? cuts : (entry.settings?.cuts ?? [])).find((c) => c.id === cutId);
  if (!cut) return null;
  return { material: entry.material, cut, exportOf: editing ? exportSettings : (entry.settings?.export ?? DEFAULT_EXPORT) };
}

// ---------------------------------------------------------------- the song as a file (design.md 13, phase 3)

/** The song's tracks as the offline render takes them (only one track, for a stem). */
/** The loop range's notes (seconds from its start), given twice in a row: the second pass is the seamless loop. */
function loopNotes(notes: ReturnType<typeof toSeqNotes>, startSec: number, lengthSec: number): ReturnType<typeof toSeqNotes> {
  const inside = notes
    .filter((n) => n.start >= startSec - 1e-9 && n.start < startSec + lengthSec - 1e-9)
    .map((n) => ({ ...n, start: n.start - startSec, end: Math.min(n.end, startSec + lengthSec) - startSec }));
  return [...inside, ...inside.map((n) => ({ ...n, start: n.start + lengthSec, end: n.end + lengthSec }))];
}

/** A line over the loop range, as `loopNotes` gives the notes: from the range's start, twice in a row. */
function loopLine(points: AutoPoint[], startSec: number, lengthSec: number): AutoPoint[] {
  if (!points.length) return points;
  const inside = points.filter((q) => q.sec > startSec && q.sec < startSec + lengthSec).map((q) => ({ sec: q.sec - startSec, value: q.value }));
  const once = [{ sec: 0, value: autoValue(points, startSec, 1) }, ...inside, { sec: lengthSec - 1e-6, value: autoValue(points, startSec + lengthSec, 1) }];
  return [...once, ...once.map((q) => ({ sec: q.sec + lengthSec, value: q.value }))];
}

/** A line as the render takes it (seconds; over the loop range, if one is given). */
function renderLine(points: ReturnType<typeof rollPanel.snapshot>["masterAuto"], tempo: Tempo, range: { startSec: number; lengthSec: number } | null): AutoPoint[] {
  const sec = autoToSec(points, tempo);
  return range ? loopLine(sec, range.startSec, range.lengthSec) : sec;
}

function songTracks(project: ReturnType<typeof rollPanel.snapshot>, only: string | null, range: { startSec: number; lengthSec: number } | null = null): RenderTrack[] {
  rebuildKit();
  const kit = rollPanel.kitSpec();
  const out: RenderTrack[] = [];
  for (const t of project.tracks) {
    if (only !== null && t.id !== only) continue;
    const mix = {
      fx: t.fx,
      gain: t.gain,
      pan: t.pan,
      mute: only === null ? t.mute : false,
      solo: only === null ? t.solo : false,
      volumeAuto: renderLine(t.volumeAuto, project, range),
      panAuto: renderLine(t.panAuto, project, range),
    };
    if (t.kind === "audio") {
      // Clips: their recordings (as the page has them). A loop range starting inside a clip starts it part-way.
      const seq = clipsToSeq(t.notes, project);
      const clips = seq.clips.map((c) => ({ channels: library.get(c.material)?.material.source.channels ?? null, offsetSec: c.offsetSec }));
      let notes = seq.notes;
      if (range) {
        notes = notes.map((n) => {
          if (!(n.start < range.startSec && n.end > range.startSec)) return n;
          clips[n.note] = { ...clips[n.note], offsetSec: clips[n.note].offsetSec + range.startSec - n.start };
          return { ...n, start: range.startSec };
        });
        notes = loopNotes(notes, range.startSec, range.lengthSec);
      }
      out.push({ id: t.id, instrument: null, clips, notes, ...mix });
      continue;
    }
    const all = toSeqNotes(t.notes, project, t.kind !== "drum" && t.glide > 0);
    const notes = range ? loopNotes(all, range.startSec, range.lengthSec) : all;
    if (t.kind === "drum") {
      // The kit: each key its sound (as the engine has it), or the plain drum sound.
      out.push({ id: t.id, instrument: null, samples: kit.samples.map((_, key) => kitBuffers.get(key) ?? null), drumKeys: kit.keys, notes, ...mix });
      continue;
    }
    // A part on the plain backing synth (簡易シンセ), as it plays on the page.
    if (t.instrument === BACKING) {
      out.push({ id: t.id, instrument: null, backing: true, notes, ...mix });
      continue;
    }
    const found = t.instrument ? findCut(t.instrument) : null;
    if (!found) continue;
    out.push({
      id: t.id,
      instrument: { source: found.material.source, markers: found.cut.markers, params: { ...found.cut.params, maxVoices: DEFAULT_PARAMS.maxVoices }, hold: exportLengthSec(found.exportOf) },
      notes,
      glide: t.glide,
      ...mix,
    });
  }
  return out;
}

/** A song file's name: the project's name and the time (e.g. 「新曲_20261028-1530」). */
function songFileStamp(): string {
  const d = new Date();
  const p = (x: number) => String(x).padStart(2, "0");
  return `${safeBaseName(currentProject()?.name ?? "曲")}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** The last file made, kept so a second tap can share it at once (iPhone: the share sheet needs a fresh tap). */
let songBuilt: { key: string; blob: Blob; fileName: string; summary: string } | null = null;
let songBuilding = false;

async function exportSong(kind: "wav" | "stems" | "mid"): Promise<void> {
  if (songBuilding) return;
  const say = (text: string) => (rollPanel.exportStatus.textContent = text);
  const project = rollPanel.snapshot();
  if (!project.tracks.some((t) => t.notes.length)) {
    say("書き出す音符がありません。");
    return;
  }
  const loopRange = kind === "mid" ? null : rollPanel.exportRange;
  const range = loopRange ? { startSec: beatsToSec(loopRange.start, project), lengthSec: beatsToSec(loopRange.end, project) - beatsToSec(loopRange.start, project) } : null;
  // The tempo map the synced effects follow (a loop range: from its start, twice over).
  const tempoMap = range
    ? (() => {
        const map = tempoMapSec(project);
        const at = (sec: number) => map.filter((q) => q.sec <= sec + 1e-9).pop()!.bpm;
        const inside = map.filter((q) => q.sec > range.startSec && q.sec < range.startSec + range.lengthSec).map((q) => ({ sec: q.sec - range.startSec, bpm: q.bpm }));
        const once = [{ sec: 0, bpm: at(range.startSec) }, ...inside];
        return [...once, ...once.map((q) => ({ sec: q.sec + range.lengthSec, bpm: q.bpm }))];
      })()
    : tempoMapSec(project);
  const stamp = songFileStamp() + (range ? "_loop" : "");
  const window = range ? { fromSec: range.lengthSec, lengthSec: range.lengthSec } : undefined;
  const key = JSON.stringify([kind, range, project, [...library.values()].map((e) => (e.material === material ? settingsBody() : e.settings))]);
  let built = songBuilt?.key === key ? songBuilt : null;
  if (!built) {
    songBuilding = true;
    rollPanel.stop();
    try {
      const rate = client.sampleRate;
      const progress = async (share: number) => {
        say(`作成中… ${Math.round(share * 100)}%`);
        await yieldToScreen();
      };
      if (kind === "mid") {
        const bytes = writeMidi(project);
        built = { key, blob: new Blob([bytes], { type: "audio/midi" }), fileName: `${stamp}.mid`, summary: `トラック ${project.tracks.length} 本、${project.bpm} BPM${project.tempos.length ? `(テンポ変更 ${project.tempos.length} か所)` : ""}` };
      } else if (kind === "wav") {
        say("作成中…");
        await yieldToScreen();
        const song = await renderSong({ sampleRate: rate, bpm: project.bpm, tracks: songTracks(project, null, range), masterFx: project.masterFx, masterAuto: renderLine(project.masterAuto, project, range), tempoMap, window }, progress);
        const fileName = `${stamp}.wav`;
        const lowered = song.gain < 1 ? `。音割れしないよう全体を ${(20 * Math.log10(song.gain)).toFixed(1)} dB 下げました` : "";
        built = { key, blob: new Blob([encodeWavBytes(song.channels, song.sampleRate, { ISFT: "EasySampler" })], { type: "audio/wav" }), fileName, summary: `${(song.channels[0].length / song.sampleRate).toFixed(1)} 秒、${song.sampleRate / 1000} kHz${lowered}` };
      } else {
        const entries: ZipEntry[] = [];
        const used = new Set<string>();
        const withNotes = project.tracks.filter((t) => t.notes.length);
        for (let i = 0; i < withNotes.length; i++) {
          const t = withNotes[i];
          const tracks = songTracks(project, t.id, range);
          if (!tracks.length) continue;
          say(`作成中… ${i + 1} / ${withNotes.length}(${t.name})`);
          await yieldToScreen();
          const song = await renderSong({ sampleRate: rate, bpm: project.bpm, tracks, masterFx: null, tempoMap, window });
          let name = `${String(i + 1).padStart(2, "0")}_${safeBaseName(t.name)}.wav`;
          for (let k = 2; used.has(name); k++) name = `${String(i + 1).padStart(2, "0")}_${safeBaseName(t.name)}_${k}.wav`;
          used.add(name);
          entries.push({ name: `${stamp}/${name}`, data: new Uint8Array(encodeWavBytes(song.channels, song.sampleRate, { ISFT: "EasySampler" })) });
        }
        built = { key, blob: new Blob([zipStore(entries)], { type: "application/zip" }), fileName: `${stamp}_トラック別.zip`, summary: `WAV ${entries.length} 本(各トラックのエフェクト込み、マスターなし)` };
      }
      songBuilt = built;
    } catch (error) {
      say(`書き出せませんでした: ${error instanceof Error ? error.message : error}`);
      return;
    } finally {
      songBuilding = false;
    }
  }
  if (SHARE_ONLY && canShareFiles()) {
    try {
      const outcome = await shareFile(built.blob, built.fileName, built.fileName);
      say(outcome === "shared" ? `共有しました: ${built.fileName}(${built.summary})` : "");
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        say(`できました(${built.summary})。もう一度押すと共有シートが開きます。`);
        return;
      }
    }
  }
  downloadFile(built.blob, built.fileName);
  say(`保存しました: ${built.fileName}(${built.summary})`);
}
rollPanel.onExport = (kind) => void exportSong(kind);

/** The cuts of every material, for the tracks' lists. */
function refreshInstruments(): void {
  const options: InstrumentOption[] = [];
  const multi = library.size > 1;
  for (const { material: m, settings } of library.values()) {
    const list = material && m.id === material.id ? cuts : (settings?.cuts ?? []);
    for (const cut of list) options.push({ id: instrumentId(m.id, cut.id), label: multi || list.length > 1 ? `${m.name} / ${cut.name}` : m.name, note: cut.note });
  }
  rollPanel.setInstruments(options, material && cuts[current] ? instrumentId(material.id, cuts[current].id) : null);
}

/** A material of the project comes back without being shown: its source and cuts go to the engine. */
async function loadInBackground(id: string, name: string, channels: Float32Array[], sampleRate: number, settings: SettingsFile | null): Promise<void> {
  const { analysis: plain, source: plainSource } = await client.analyze(channels, sampleRate);
  let analysis = plain;
  let source = plainSource;
  // Its hand corrections and search range, as the editor would apply them.
  if (settings && (settings.corrections.length || settings.pitchRange)) {
    const pyin = settings.pitchRange ? { fminHz: midiToHz(settings.pitchRange.low), fmaxHz: midiToHz(settings.pitchRange.high) } : undefined;
    const base = settings.pitchRange ? (await client.analyze(channels, sampleRate, undefined, undefined, pyin)).analysis : plain;
    const corrected = applyCorrections(base.track, settings.corrections);
    const again = await client.analyze(channels, sampleRate, undefined, corrected);
    analysis = again.analysis;
    source = again.source;
  }
  const m: Material = { id, name, channels, sampleRate, mono: mixToMono(channels), analysis, original: plain, corrections: settings?.corrections ?? [], pitchRange: settings?.pitchRange ?? null, source, exportSources: new Map([[source.sampleRate, source]]) };
  library.set(id, { material: m, settings });
  client.setSource(source, id);
  checkEngineRate(id);
  for (const cut of settings?.cuts ?? []) client.defineInstrument(instrumentId(id, cut.id), id, cut.markers, { ...cut.params, maxVoices: DEFAULT_PARAMS.maxVoices }, exportLengthSec(settings?.export ?? DEFAULT_EXPORT));
}

/** Shows another material of the project in the editor. */
function switchMaterial(id: string): void {
  const entry = library.get(id);
  if (!entry || entry.material === material) return;
  stashMaterial();
  resetHistory();
  material = entry.material;
  showPitchRange();
  selection = null;
  editor.setMaterial({ mono: material.mono, sampleRate: material.sampleRate, track: material.analysis.track });
  rollPanel.setEditing(id);
  if (entry.settings) applySettings(entry.settings, true);
  else {
    freshCuts();
    applyCurrentCut();
  }
  defineMaterialCuts();
  refreshMaterialSelect();
  status.textContent = `「${material.name}」を編集しています。`;
  saveNow();
}

/** Takes a material out of the project (its samples and settings are forgotten). */
function removeMaterial(id: string): void {
  const entry = library.get(id);
  if (!entry) return;
  const used = rollPanel.usesMaterial(id);
  if (!confirm(`「${entry.material.name}」をプロジェクトから外しますか?${used ? "この素材を鳴らしているトラックは無音になります。" : ""}`)) return;
  const settings = material?.id === id ? settingsBody() : entry.settings;
  for (const cut of settings?.cuts ?? []) client.dropInstrument(instrumentId(id, cut.id));
  client.setSource(null, id);
  library.delete(id);
  rollPanel.removeMaterial(id);
  void forget(`audio:${id}`);
  void forget(`settings:${id}`);
  if (material?.id === id) {
    material = null;
    const next = [...library.keys()].at(-1);
    if (next) switchMaterialFrom(next);
    else {
      // (Not reached from the button, which needs another material to remain: a project always has one.)
      void loadPiano();
    }
  }
  refreshInstruments();
  refreshMaterialSelect();
}

/** switchMaterial without stashing (the editor's material is already gone). */
function switchMaterialFrom(id: string): void {
  const entry = library.get(id)!;
  resetHistory();
  material = entry.material;
  showPitchRange();
  selection = null;
  editor.setMaterial({ mono: material.mono, sampleRate: material.sampleRate, track: material.analysis.track });
  rollPanel.setEditing(id);
  if (entry.settings) applySettings(entry.settings, true);
  else {
    freshCuts();
    applyCurrentCut();
  }
  defineMaterialCuts();
  status.textContent = `「${material.name}」を編集しています。`;
}

function refreshMaterialSelect(): void {
  refreshMaterialTab();
  materialSelect.replaceChildren(...[...library.values()].map(({ material: m }) => el("option", { value: m.id, textContent: m.name })));
  if (material) materialSelect.value = material.id;
  // The last material stays: the page always has something to play (add another first, then take this one out).
  removeMaterialButton.disabled = library.size < 2;
  removeMaterialButton.title = library.size < 2 ? "素材が 1 つだけのときは外せません。別の素材(＋ 素材を追加・＋ 内蔵ピアノ)を加えてから外してください" : "";
}

/**
 * Opens a material in the editor: a new one (it joins the project, its samples
 * are kept) or, with `kept`, one coming back from the store with its settings.
 */
async function load(name: string, channels: Float32Array[], sampleRate: number, kept?: { id: string; settings: SettingsFile | null }): Promise<void> {
  if (!kept) {
    let total = channels[0].length / sampleRate;
    for (const { material: m } of library.values()) total += m.channels[0].length / m.sampleRate;
    if (total > PROJECT_AUDIO_LIMIT_SEC) {
      status.textContent = `「${name}」を追加すると素材の合計が ${Math.round(total)} 秒になり、iPhone / iPad で扱える ${PROJECT_AUDIO_LIMIT_SEC} 秒を超えます。使っていない素材を「この素材を外す」で外してください。`;
      return;
    }
  }
  status.textContent = `「${name}」を解析しています…`;
  stashMaterial();
  resetHistory();
  rangeStatus.textContent = "";
  try {
    const { analysis, source, elapsedMs } = await client.analyze(channels, sampleRate);
    const id = kept?.id ?? newCutId();
    material = { id, name, channels, sampleRate, mono: mixToMono(channels), analysis, original: analysis, corrections: [], pitchRange: null, source, exportSources: new Map([[source.sampleRate, source]]) };
    library.set(id, { material, settings: null });
    if (!kept) {
      void keep(`audio:${id}`, { name, sampleRate, channels });
      askToPersist();
    }
    rollPanel.addMaterial({ id, name });
    showPitchRange();
    selection = null;
    editor.setMaterial({ mono: material.mono, sampleRate, track: analysis.track });
    refreshFixBar();
    client.setSource(source, id);
    checkEngineRate(id);
    emptyState.hidden = true;
    workspace.hidden = false;
    // A material opened or added by hand: its view comes up.
    if (!kept) setView("material");

    const seconds = analysis.durationSec.toFixed(2);
    const root = analysis.root;
    let text =
      `「${name}」 ${seconds} 秒 — 解析 ${Math.round(elapsedMs)} ms。` +
      (root ? ` 音程 ${pitchLabel(root.midi)}(信頼度 ${Math.round(root.confidence * 100)}%)。` : " 音程が見つからなかったので、1 回鳴らしきる音として扱います。ドラムに使うなら、波形で範囲を選んで「ドラムキットへ」送ってください。");
    // Its settings: as kept in the project, or (a file opened again) as last saved for that file.
    const stored = kept ? (kept.settings ? serializeSettings(kept.settings) : null) : safeStorage(settingsKey(name, channels[0].length, sampleRate));
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
    const shortNote = !restored && presetId === "short" ? " 伸ばせる部分が短いので、作り方を「移調」(子音・息も音程に合わせる)にしました。伸ばして使うなら作り方を「伸ばす」に。" : "";
    status.replaceChildren(text + (restored ? " 前回の設定を復元しました。" : "") + shortNote);
    if (restored && !kept) status.append(" ", button("最初から", "small", () => resetSettingsButton.click()));
    defineMaterialCuts();
    refreshMaterialSelect();
    saveNow();
  } catch (error) {
    status.textContent = `読み込めませんでした: ${error instanceof Error ? error.message : error}`;
  }
}

/** The sound a new project starts with: a synthesized piano note (C4), played as a decaying instrument. */
async function loadPiano(): Promise<void> {
  Object.assign(credit, { title: "EasySampler 内蔵ピアノ(合成音)", url: "", timecode: "", memo: "" });
  setCreditInputs();
  longClip = null;
  pickerClip = null;
  rePickButton.hidden = true;
  pickerPanel.hidden = true;
  nextPresetHint = "decay";
  await load(PIANO_NAME, [synthPiano({ sampleRate: DEMO_RATE })], DEMO_RATE);
  nextPresetHint = "";
}

/** The built-in piano into the project: shown if it is already there, added (next to the other materials) if not. */
async function addPiano(): Promise<void> {
  const there = [...library.values()].find((e) => e.material.name === PIANO_NAME);
  if (there) {
    if (there.material !== material) switchMaterial(there.material.id);
    refreshMaterialSelect();
    status.textContent = `「${PIANO_NAME}」に切り替えました。トラックで鳴らすには、トラック一覧の区間の欄で選んでください。`;
    return;
  }
  await loadPiano();
  refreshInstruments();
  if (material?.name === PIANO_NAME) status.textContent = `「${PIANO_NAME}」を素材に加えました。トラックで鳴らすには、トラック一覧の区間の欄で選ぶか、「＋ トラックを追加」で新しいトラックを作ってください。`;
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
    if (error instanceof TooLongError) status.textContent = `読み込めませんでした: ${error.message}`;
    else status.textContent = `読み込めませんでした(${formatHint(file)}): ${error instanceof Error ? error.message : error}`;
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

// A fade grip dragged in the lane: the attack and the fade-out follow (the sliders too, once it's let go).
editor.onLevelChange = (level, final) => {
  if (!final) return;
  update((p) => {
    p.amp.attack = level.attackSec;
    // Below the release the fade-out does nothing (the release is at least as long): that is "off".
    p.amp.fadeOut = level.fadeOutSec <= p.amp.release + 1e-6 ? 0 : level.fadeOutSec;
  }, true);
  refreshControls();
};

// Seeking on the editor: the top strip for the original (display time), the lane for the result (output time).
// Playing the same thing: it jumps there. Playing the other: that stops and this starts from there. Stopped: the cue is set.
editor.onSeek = (kind, sec, how) => {
  if (!material || !markers) return;
  const bufferSec = kind === "original" ? displayToBuffer(sec) : sec;
  if (playing && playing.kind === kind) {
    // Playing this already: jump there (and a double tap restarts there too).
    cue = bufferSec;
    playStartCue = cue;
    showSeek(cue);
    client.seekPreview(cue);
    return;
  }
  if (playing) client.stopPreview();
  setPreviewMode(kind);
  cue = bufferSec;
  showSeek(cue);
  editor.setPlayhead(kind === "result" ? { kind: "output", sec } : { kind: "display", sec });
  if (how === "play") void (kind === "original" ? playOriginal() : listen());
};

editor.onSelect = (next) => {
  selection = next;
  refreshFixBar();
};

client.onStatus = (voices) => (voiceCount.textContent = String(voices));
client.onError = (message) => (status.textContent = `音声を開始できませんでした: ${message}`);

function showPcState(): void {
  const s = pcKeys.state;
  pcToggle.textContent = `PC キーボード演奏: ${s.enabled ? "オン" : "オフ"}(M)`;
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

// The project comes back: its tracks, then its materials (the one being edited last, so it is the one shown).
void (async () => {
  const opened = await openProjects();
  rollPanel.useStore(projectKey(opened.id));
  rollPanel.onSaved = touchProject;
  refreshProjectButton();
  const project = await rollPanel.restore();
  // The old voice demo is gone from the app: a saved project drops it (its tracks then play nothing until another cut is chosen).
  for (const m of [...project.materials]) {
    if (m.name !== OLD_VOICE_DEMO_NAME) continue;
    rollPanel.removeMaterial(m.id);
    void forget(`audio:${m.id}`);
    void forget(`settings:${m.id}`);
  }
  const order = [...project.materials].sort((a, b) => Number(a.id === project.editing) - Number(b.id === project.editing));
  for (const m of order) {
    let audio = (await kept(`audio:${m.id}`)) as { name: string; sampleRate: number; channels: Float32Array[] } | undefined;
    if (!audio?.channels?.length) {
      rollPanel.removeMaterial(m.id);
      continue;
    }
    const stored = await kept(`settings:${m.id}`);
    let settings: SettingsFile | null = null;
    try {
      settings = typeof stored === "string" ? parseSettings(stored) : null;
    } catch {
      settings = null;
    }
    // The built-in piano as an earlier version made it (3 s, cut off while still ringing): made again, its cuts' ranges
    // follow the new length (the cuts keep their ids, so the tracks keep playing them).
    if (audio.name === PIANO_NAME && audio.channels[0].length !== Math.round(PIANO_SECONDS * audio.sampleRate)) {
      audio = { ...audio, channels: [synthPiano({ sampleRate: audio.sampleRate })] };
      void keep(`audio:${m.id}`, audio);
      if (settings) {
        const { analysis } = await client.analyze(audio.channels, audio.sampleRate);
        const decay = PRESETS.find((p) => p.id === "decay")!;
        settings = { ...settings, cuts: settings.cuts.map((c) => ({ ...c, markers: analysis.markers, params: c.presetId === "decay" ? decay.apply(c.params) : c.params })) };
        void keep(`settings:${m.id}`, serializeSettings(settings));
      }
    }
    if (m.id === project.editing || m === order.at(-1)) await load(audio.name, audio.channels, audio.sampleRate, { id: m.id, settings });
    else await loadInBackground(m.id, audio.name, audio.channels, audio.sampleRate, settings);
  }
  // The material to show had no audio left (a save cut short): show another one of the project.
  if (!material && library.size > 0) {
    switchMaterialFrom([...library.keys()].at(-1)!);
    refreshMaterialSelect();
    emptyState.hidden = true;
    workspace.hidden = false;
  }
  // A new project (or one whose materials are all gone): it starts on the built-in piano, ready to play.
  if (library.size === 0) {
    await loadPiano();
    if (material) status.textContent = "内蔵のピアノ音で始めています。鍵盤で弾いたり、打ち込みで曲を作ったりできます。自分の声や効果音は「素材を開く」から追加できます。";
    else emptyState.hidden = false;
  }
  refreshInstruments();
  refreshMaterialSelect();
  await loadKitAudio();
  // The kit's sounds are in: the tracks are given them (they played the plain drums until now), the keyboard too.
  rollPanel.updateKit(() => {});
})();
