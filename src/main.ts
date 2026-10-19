// MADDAW — Phase 1: a material becomes an instrument (素材が楽器になる).
//
// Load a material (or the demo), and it is analysed (pitch curve, pitch
// marks, root pitch to the cent, suggested synthesis markers) and playable
// at once — on the on-screen keyboard or the computer keyboard. The material
// editor shows the curves and markers; the panel below sets how it plays.

import { pitchLabel } from "./analysis/pitch";
import { EngineClient } from "./audio/engineClient";
import { Engine, type PreparedSource } from "./engine/engine";
import { mixToMono, rootForMarkers, type MaterialAnalysis } from "./engine/prepare";
import { DEFAULT_PARAMS, PRESETS, type Credit, type InstrumentParams, type Markers, type PresetId } from "./instrument/types";
import { demoSyllable } from "./testsignals/synthVoice";
import { el } from "./ui/dom";
import { OnScreenKeyboard, PcKeyboard } from "./ui/keyboard";
import { MaterialEditor } from "./ui/materialEditor";

const MAX_MATERIAL_SEC = 60;
const DEMO_RATE = 44100;

// ---------------------------------------------------------------- state

interface Material {
  name: string;
  channels: Float32Array[];
  sampleRate: number;
  mono: Float32Array;
  analysis: MaterialAnalysis;
  source: PreparedSource;
  /** The root as detected for the current markers (for "back to detected"). */
  detectedRoot: number | null;
}

let material: Material | null = null;
let markers: Markers | null = null;
let params: InstrumentParams = structuredClone(DEFAULT_PARAMS);
let presetId: PresetId | "" = "original";
const credit: Credit = { title: "", url: "", timecode: "", memo: "" };

const client = new EngineClient();
const editor = new MaterialEditor();
const sink = {
  noteOn: (note: number, velocity: number) => {
    client.unlock();
    client.noteOn(note, velocity);
  },
  noteOff: (note: number) => client.noteOff(note),
};
const piano = new OnScreenKeyboard(sink);
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
  client.setSource(source);
  client.resendInstrument();
}

// ---------------------------------------------------------------- page

const fileInput = el("input", { type: "file", accept: "audio/*,video/*", className: "visually-hidden", id: "file" });
const openButton = el("label", { className: "button primary", htmlFor: "file", textContent: "素材を開く" });
const demoButton = el("button", { className: "button", textContent: "デモ素材" });
const status = el("p", { className: "status", role: "status" });
const voiceCount = el("span", { className: "num", textContent: "0" });

const emptyState = el("section", { className: "empty" }, [
  el("p", { className: "empty-title", textContent: "素材を入れたら、もう楽器。" }),
  el("p", { textContent: "声や効果音のファイルをここにドロップするか、「素材を開く」から選んでください。すぐに鍵盤で弾けます。" }),
  el("div", { className: "row" }, [el("label", { className: "button primary", htmlFor: "file", textContent: "素材を開く" }), (() => {
    const b = el("button", { className: "button", textContent: "デモ素材で試す" });
    b.addEventListener("click", () => loadDemo());
    return b;
  })()]),
  el("p", { className: "fine", textContent: "生成AIは使っていません。素材は端末の中だけで処理され、外部には送られません。" }),
]);

const rootLabel = el("strong", { className: "root-label num", textContent: "—" });
const rootSource = el("span", { className: "fine" });
const presetSelect = el("select", { ariaLabel: "プリセット" }, [
  el("option", { value: "", textContent: "(カスタム)" }),
  ...PRESETS.map((p) => el("option", { value: p.id, textContent: p.label })),
]);

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

function sendInstrument(): void {
  if (!markers) return;
  client.setInstrument(markers, params);
  editor.setState(markers, params.root, params.flatten);
  piano.setRoot(params.root);
  rootLabel.textContent = pitchLabel(params.root);
  rootSource.textContent = params.rootMode === "auto" ? "(自動判定)" : "(手動)";
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
const detectedButton = el("button", { className: "button small", textContent: "検出値に戻す" });
detectedButton.addEventListener("click", () => {
  if (material?.detectedRoot == null) return;
  update((p) => {
    p.root = material!.detectedRoot!;
    p.rootMode = "auto";
  }, true);
});

presetSelect.addEventListener("change", () => {
  const preset = PRESETS.find((p) => p.id === presetSelect.value);
  if (!preset) return;
  presetId = preset.id;
  params = preset.apply(structuredClone(params));
  refreshControls();
  sendInstrument();
});

const creditFields = (["title", "url", "timecode", "memo"] as const).map((key) => {
  const labels = { title: "作品名", url: "URL", timecode: "時刻", memo: "メモ" };
  const input = el("input", { type: key === "url" ? "url" : "text", value: credit[key] });
  input.addEventListener("input", () => (credit[key] = input.value));
  return el("label", { className: "control" }, [el("span", { className: "control-label", textContent: labels[key] }), input]);
});

const benchButton = el("button", { className: "button small", textContent: "負荷を測る" });
const benchResult = el("span", { className: "fine" });
benchButton.addEventListener("click", () => benchmark());

const pcState = el("span", { className: "fine" });
const pcToggle = el("button", { className: "button small", textContent: "PCキーボード演奏: オン (M)" });
pcToggle.addEventListener("click", () => pcKeys.toggle());
const imeWarning = el("p", { className: "warn", hidden: true, textContent: "日本語入力がオンになっています。鍵盤として弾くには、半角英数に切り替えてください。" });

const workspace = el("main", { className: "workspace", hidden: true }, [
  el("section", { className: "panel" }, [
    el("div", { className: "editor-bar" }, [
      el("div", { className: "root-box" }, [el("span", { className: "fine", textContent: "基準ピッチ" }), rootLabel, rootSource]),
      el("div", { className: "row tight" }, [rootButton("−1半音", -1), rootButton("−5¢", -0.05), rootButton("+5¢", 0.05), rootButton("+1半音", 1), detectedButton]),
      el("label", { className: "control" }, [el("span", { className: "control-label", textContent: "プリセット" }), presetSelect]),
    ]),
    range("平坦化(抑揚の残し具合)", 0, 1, 0.01, () => params.flatten, (p, v) => (p.flatten = v), pct),
    editor.element,
    el("p", { className: "legend fine" }, [
      el("span", { className: "swatch original" }), "元のピッチ  ",
      el("span", { className: "swatch edited" }), "平坦化後(基準ピッチで弾いたとき)  ",
      "帯の端をドラッグして、頭部・持続区間・語尾を調整できます。",
    ]),
  ]),
  el("section", { className: "panel keys-panel" }, [
    el("div", { className: "row" }, [pcToggle, pcState, el("span", { className: "fine" }, ["同時発音 ", voiceCount])]),
    imeWarning,
    piano.element,
  ]),
  el("section", { className: "panel params" }, [
    el("fieldset", {}, [
      el("legend", { textContent: "鳴らし方" }),
      select("ピッチの変え方", [["preserve-length", "長さ保持(PSOLA)"], ["resample", "速度連動(昔ながら)"]], () => params.pitchMode, (p, v) => (p.pitchMode = v)),
      select("持続区間の伸ばし方", [["pool", "周期プール(自然)"], ["loop", "ループ"], ["none", "伸ばさない(ワンショット)"]], () => params.sustainMode, (p, v) => (p.sustainMode = v)),
      check("ノートを離したあとに語尾を鳴らす", () => params.tail.enabled, (p, v) => (p.tail.enabled = v)),
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
    el("details", { className: "credit" }, [
      el("summary", { textContent: "出典メモ(投稿時の親作品登録・クレジット用)" }),
      ...creditFields,
    ]),
    el("div", { className: "row" }, [benchButton, benchResult]),
  ]),
]);

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
    material = { name, channels, sampleRate, mono: mixToMono(channels), analysis, source, detectedRoot };
    markers = analysis.markers;
    params = structuredClone(params);
    params.root = detectedRoot ?? 60;
    params.rootMode = detectedRoot === null ? "manual" : "auto";
    if (detectedRoot === null) {
      // Nothing pitched (a hit, a noise): play it like a sampler, from C4.
      params = PRESETS.find((p) => p.id === "drum")!.apply(params);
      presetId = "drum";
    }
    presetSelect.value = presetId;
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
      (root ? ` 基準ピッチ ${pitchLabel(root.midi)}(信頼度 ${Math.round(root.confidence * 100)}%)。鍵盤を押すと鳴ります。` : " 音程が見つからなかったので、C4 を基準にドラムとして鳴らします。");
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
  void load("デモ素材(合成音声「さー」)", [demoSyllable(DEMO_RATE)], DEMO_RATE);
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (!file) return;
  try {
    const { channels, sampleRate } = await decode(file);
    await load(file.name, channels, sampleRate);
  } catch (error) {
    status.textContent = `読み込めませんでした(対応していない形式かもしれません): ${error instanceof Error ? error.message : error}`;
  }
});
demoButton.addEventListener("click", () => loadDemo());

document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", async (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files[0];
  if (!file) return;
  try {
    const { channels, sampleRate } = await decode(file);
    await load(file.name, channels, sampleRate);
  } catch (error) {
    status.textContent = `読み込めませんでした: ${error instanceof Error ? error.message : error}`;
  }
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
  pcState.textContent = s.enabled ? `A = ${pitchLabel(s.baseNote)}(Z/X でオクターブ)・強さ ${Math.round(s.velocity * 100)}%(C/V)` : "";
  if (!s.enabled) imeWarning.hidden = true;
}
pcKeys.onChange = showPcState;
pcKeys.onNote = (note, down) => {
  imeWarning.hidden = true;
  piano.showPressed(note, down);
};
pcKeys.onIme = () => (imeWarning.hidden = false);
showPcState();

// ---------------------------------------------------------------- benchmark

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

refreshControls();
