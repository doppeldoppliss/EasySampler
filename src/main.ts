// MADDAW Phase 0 — 検証ページ.
//
// Load a material (or the synthesized demo voice), let pYIN find its pitch
// curve and "average pitch", then fit it to a test phrase with each pitch
// shifting method and compare: by ear (play / download), and by numbers
// (how long each took, against how much audio it made). The numbers can be
// copied out as text, for collecting results from an iPad.

import { pickCenter, type CenterMethod, type CenterPitch } from "./analysis/centerPitch";
import { parseNoteName, pitchLabel } from "./analysis/pitch";
import type { PitchTrack } from "./analysis/pyin";
import { encodeWav } from "./audio/wav";
import type { ShiftMethod } from "./dsp/shift";
import { signalsmithShift } from "./dsp/signalsmith";
import { PATTERNS, patternNotes, renderNotes, type LengthMode, type Material, type PatternId, type RenderResult } from "./proto/melody";
import type { WorkerRequest, WorkerResponse } from "./proto/worker";
import { demoPhrasePitch, synthVoice } from "./testsignals/synthVoice";

const DEMO_RATE = 44100;
const MAX_SELECTION_SEC = 10;

const METHOD_LABELS: Record<ShiftMethod, string> = {
  resample: "再生速度(基準)",
  psola: "TD-PSOLA",
  signalsmith: "Signalsmith Stretch",
};

// ---------------------------------------------------------------- state

interface Loaded {
  name: string;
  samples: Float32Array; // mono, whole file
  sampleRate: number;
}

interface Analysis {
  samples: Float32Array; // the selection
  track: PitchTrack;
  center: CenterPitch | null;
  elapsedMs: number;
}

let loaded: Loaded | null = null;
let analysis: Analysis | null = null;
let results: RenderResult[] = [];
let lastRenderInfo: Record<string, unknown> = {};
let signalsmithLagMs: number | null = null;

// ---------------------------------------------------------------- worker

const worker = new Worker(new URL("./proto/worker.ts", import.meta.url), { type: "module" });
let nextId = 1;
const pending = new Map<number, { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void }>();
worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
  const waiter = pending.get(event.data.id);
  if (!waiter) return;
  pending.delete(event.data.id);
  if (event.data.type === "error") waiter.reject(new Error(event.data.message));
  else waiter.resolve(event.data);
};

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

function ask(request: DistributiveOmit<WorkerRequest, "id">): Promise<WorkerResponse> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...request, id });
  });
}

// ---------------------------------------------------------------- audio

let audioContext: AudioContext | null = null;
let playing: AudioBufferSourceNode | null = null;

function context(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext();
    // iPad / iPhone: sound even with the silent switch on.
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    try {
      if (session) session.type = "playback";
    } catch {
      // not settable
    }
  }
  return audioContext;
}

function play(samples: Float32Array, sampleRate: number): void {
  stop();
  const ctx = context();
  void ctx.resume();
  const buffer = ctx.createBuffer(1, samples.length, sampleRate);
  buffer.copyToChannel(new Float32Array(samples), 0);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start();
  playing = source;
}

function stop(): void {
  playing?.stop();
  playing = null;
}

async function decodeFile(file: File): Promise<Loaded> {
  const bytes = await file.arrayBuffer();
  const decoded = await context().decodeAudioData(bytes);
  const mono = new Float32Array(decoded.length);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const channel = decoded.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / decoded.numberOfChannels;
  }
  return { name: file.name, samples: mono, sampleRate: decoded.sampleRate };
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------------------------------------------------------------- page

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, children: (Node | string)[] = []): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function swatch(colorVar: string): HTMLElement {
  const node = el("i", { className: "swatch" });
  node.style.background = `var(${colorVar})`;
  return node;
}

const app = document.getElementById("app")!;

// 1. 素材
const fileInput = el("input", { type: "file", accept: "audio/*,video/*" });
const demoButton = el("button", { textContent: "デモ音声(合成)を使う" });
const startInput = el("input", { type: "number", step: "0.01", min: "0", value: "0" });
const endInput = el("input", { type: "number", step: "0.01", min: "0", value: "0" });
const playSelectionButton = el("button", { textContent: "▶ 選択範囲を再生", disabled: true });
const analyzeButton = el("button", { textContent: "解析する", className: "primary", disabled: true });
const sourceInfo = el("div", { className: "status" });

// 2. 解析
const canvas = el("canvas");
const analysisStatus = el("div", { className: "status" });
const centerTable = el("tbody");
const manualInput = el("input", { type: "text", placeholder: "例: D4 / 62.3", size: 10 });
let rootChoice: CenterMethod | "manual" = "median";

// 3. 変換
const patternSelect = el(
  "select",
  {},
  PATTERNS.map((p) => el("option", { value: p.id, textContent: p.label })),
);
const singleInput = el("input", { type: "text", value: "C4", size: 6 });
const bpmInput = el("input", { type: "number", value: "120", min: "40", max: "300" });
const contourInput = el("input", { type: "range", min: "0", max: "1.5", step: "0.05", value: "1" });
const contourValue = el("span", { className: "num", textContent: "1.00" });
const lengthSelect = el("select", {}, [
  el("option", { value: "oneshot", textContent: "ワンショット(ノートの長さで切る)" }),
  el("option", { value: "stretch", textContent: "伸縮(ノートの長さに合わせる)" }),
]);
const formantCheck = el("input", { type: "checkbox", checked: true });
const renderButton = el("button", { textContent: "3方式で変換する", className: "primary", disabled: true });
const renderStatus = el("div", { className: "status" });
const resultBody = el("tbody");

// 4. 環境
const envPre = el("pre");
const copyButton = el("button", { textContent: "結果をコピー" });
const lagButton = el("button", { textContent: "Signalsmith の時間ずれを測る", disabled: true });

app.append(
  el("h1", { textContent: "MADDAW — Phase 0 検証" }),
  el("p", {
    className: "lead",
    textContent: "素材の平均ピッチを自動判定し、テストフレーズの高さに合わせて3つの方式で変換します。音質(耳で)と処理速度(数値で)を比べるためのページです。",
  }),
  el("section", {}, [
    el("h2", { textContent: "1. 素材" }),
    el("div", { className: "row" }, [fileInput, demoButton]),
    el("div", { className: "row" }, [
      el("label", {}, ["開始(秒)", startInput]),
      el("label", {}, ["終了(秒)", endInput]),
      playSelectionButton,
      analyzeButton,
    ]),
    sourceInfo,
  ]),
  el("section", {}, [
    el("h2", { textContent: "2. 解析(ピッチカーブと平均ピッチ)" }),
    canvas,
    el("div", { className: "row legend" }, [
      el("span", {}, [swatch("--pitch"), "ピッチカーブ"]),
      el("span", {}, [swatch("--median"), "重み付き中央値"]),
      el("span", {}, [swatch("--mean"), "重み付き平均"]),
      el("span", {}, [swatch("--mode"), "最頻値"]),
    ]),
    analysisStatus,
    el("div", { className: "table-wrap" }, [
      el("table", {}, [el("thead", {}, [el("tr", {}, ["基準ピッチに使う", "方法", "結果", "MIDI"].map((t) => el("th", { textContent: t })))]), centerTable]),
    ]),
  ]),
  el("section", {}, [
    el("h2", { textContent: "3. 変換して比べる" }),
    el("div", { className: "row" }, [el("label", {}, ["テストフレーズ", patternSelect]), el("label", {}, ["単音の高さ", singleInput]), el("label", {}, ["BPM", bpmInput])]),
    el("div", { className: "row" }, [
      el("label", {}, ["抑揚の幅(contour)", contourInput, contourValue]),
      el("label", {}, ["長さ", lengthSelect]),
      el("label", {}, [formantCheck, "Signalsmith のフォルマント補正"]),
    ]),
    el("div", { className: "row" }, [renderButton]),
    renderStatus,
    el("div", { className: "table-wrap" }, [
      el("table", {}, [
        el("thead", {}, [el("tr", {}, ["方式", "処理時間", "出力1秒あたり", "", ""].map((t) => el("th", { textContent: t })))]),
        resultBody,
      ]),
    ]),
  ]),
  el("section", {}, [
    el("h2", { textContent: "4. 環境と計測結果" }),
    el("div", { className: "row" }, [copyButton, lagButton]),
    envPre,
  ]),
);

// ---------------------------------------------------------------- 1. 素材

function setLoaded(next: Loaded): void {
  loaded = next;
  analysis = null;
  results = [];
  const duration = next.samples.length / next.sampleRate;
  startInput.value = "0";
  endInput.value = Math.min(duration, MAX_SELECTION_SEC).toFixed(2);
  startInput.max = endInput.max = duration.toFixed(2);
  sourceInfo.textContent = `${next.name} — ${duration.toFixed(2)} 秒 / ${next.sampleRate} Hz${duration > MAX_SELECTION_SEC ? `(解析は最大 ${MAX_SELECTION_SEC} 秒まで)` : ""}`;
  playSelectionButton.disabled = false;
  analyzeButton.disabled = false;
  renderButton.disabled = true;
  lagButton.disabled = true;
  resultBody.replaceChildren();
  draw();
  void analyze();
}

function selection(): Float32Array | null {
  if (!loaded) return null;
  const sr = loaded.sampleRate;
  let start = Math.max(0, Number(startInput.value) || 0);
  let end = Math.min(loaded.samples.length / sr, Number(endInput.value) || 0);
  if (end - start > MAX_SELECTION_SEC) end = start + MAX_SELECTION_SEC;
  if (end <= start) {
    start = 0;
    end = Math.min(loaded.samples.length / sr, MAX_SELECTION_SEC);
  }
  return loaded.samples.slice(Math.round(start * sr), Math.round(end * sr));
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  sourceInfo.textContent = "読み込み中…";
  try {
    setLoaded(await decodeFile(file));
  } catch (error) {
    sourceInfo.textContent = `読み込めませんでした: ${error instanceof Error ? error.message : error}`;
  }
});

demoButton.addEventListener("click", () => {
  context(); // unlock audio on this tap (Safari)
  const duration = 1.2;
  const samples = synthVoice({ sampleRate: DEMO_RATE, durationSec: duration, pitch: demoPhrasePitch(62, duration) });
  setLoaded({ name: "デモ音声(合成 /a/, D4付近, しゃくり・ビブラート・語尾下がり)", samples, sampleRate: DEMO_RATE });
});

playSelectionButton.addEventListener("click", () => {
  const samples = selection();
  if (samples && loaded) play(samples, loaded.sampleRate);
});

analyzeButton.addEventListener("click", () => void analyze());

// ---------------------------------------------------------------- 2. 解析

async function analyze(): Promise<void> {
  const samples = selection();
  if (!samples || !loaded) return;
  analyzeButton.disabled = true;
  analysisStatus.textContent = "解析中…";
  try {
    const response = await ask({ type: "analyze", samples, sampleRate: loaded.sampleRate });
    if (response.type !== "analyze") return;
    analysis = { samples, track: response.track, center: response.center, elapsedMs: response.elapsedMs };
    const seconds = samples.length / loaded.sampleRate;
    const c = response.center;
    analysisStatus.innerHTML = "";
    analysisStatus.append(
      `解析 ${response.elapsedMs.toFixed(0)} ms(素材1秒あたり ${(response.elapsedMs / seconds).toFixed(0)} ms)`,
      c ? ` / 有声 ${c.voicedSec.toFixed(2)} 秒 / ばらつき ±${c.spread.toFixed(2)} 半音 / 信頼度 ${(c.confidence * 100).toFixed(0)}%` : "",
    );
    if (!c) analysisStatus.append(el("span", { className: "warn", textContent: " — 音程が検出できませんでした。手入力で基準ピッチを指定してください。" }));
    else if (c.confidence < 0.5) analysisStatus.append(el("span", { className: "warn", textContent: " — 信頼度が低めです。" }));
    if (!c && rootChoice !== "manual") rootChoice = "manual";
    renderCenterTable();
    renderButton.disabled = false;
    lagButton.disabled = false;
  } catch (error) {
    analysisStatus.textContent = `解析に失敗しました: ${error instanceof Error ? error.message : error}`;
  } finally {
    analyzeButton.disabled = false;
    draw();
    updateEnv();
  }
}

function renderCenterTable(): void {
  const c = analysis?.center;
  const rows: [CenterMethod | "manual", string, number | null][] = [
    ["median", "重み付き中央値(既定案)", c ? c.median : null],
    ["mean", "重み付き平均", c ? c.mean : null],
    ["mode", "最頻値(一番長く鳴っている高さ)", c ? c.mode : null],
    ["manual", "手入力", manualPitch()],
  ];
  centerTable.replaceChildren(
    ...rows.map(([id, label, value]) => {
      const radio = el("input", { type: "radio", name: "root", checked: rootChoice === id, disabled: value === null && id !== "manual" });
      radio.addEventListener("change", () => {
        rootChoice = id;
        draw();
        updateEnv();
      });
      return el("tr", {}, [
        el("td", {}, [radio]),
        el("td", { textContent: label }),
        el("td", {}, id === "manual" ? [manualInput] : [value === null ? "—" : pitchLabel(value)]),
        el("td", { className: "num", textContent: value === null ? "—" : value.toFixed(2) }),
      ]);
    }),
  );
}

function manualPitch(): number | null {
  const text = manualInput.value.trim();
  if (!text) return null;
  const named = parseNoteName(text);
  if (named !== null) return named;
  const number = Number(text);
  return Number.isFinite(number) && number > 0 && number < 128 ? number : null;
}

manualInput.addEventListener("input", () => {
  rootChoice = "manual";
  for (const radio of centerTable.querySelectorAll<HTMLInputElement>("input[type=radio]")) radio.checked = radio === centerTable.querySelector("tr:last-child input[type=radio]");
  const row = centerTable.querySelector("tr:last-child td.num");
  const value = manualPitch();
  if (row) row.textContent = value === null ? "—" : value.toFixed(2);
  draw();
  updateEnv();
});

function rootPitch(): number | null {
  if (rootChoice === "manual") return manualPitch();
  return analysis?.center ? pickCenter(analysis.center, rootChoice) : null;
}

function draw(): void {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d")!;
  const style = getComputedStyle(document.documentElement);
  const color = (name: string) => style.getPropertyValue(name).trim();
  g.clearRect(0, 0, width, height);

  const samples = analysis?.samples ?? selection();
  if (!samples || samples.length === 0) return;

  // Waveform (min/max per column).
  g.fillStyle = color("--wave");
  const perColumn = samples.length / width;
  for (let x = 0; x < width; x++) {
    let lo = 0;
    let hi = 0;
    const from = Math.floor(x * perColumn);
    const to = Math.min(samples.length, Math.floor((x + 1) * perColumn) + 1);
    for (let i = from; i < to; i++) {
      lo = Math.min(lo, samples[i]);
      hi = Math.max(hi, samples[i]);
    }
    g.fillRect(x, height / 2 - hi * height * 0.45, 1, Math.max(1, (hi - lo) * height * 0.45));
  }
  if (!analysis) return;

  const { track, center } = analysis;
  const voiced = [...track.f0].filter((v) => Number.isFinite(v));
  const root = rootPitch();
  const marks = [center?.median, center?.mean, center?.mode, root].filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));
  const all = [...voiced, ...marks];
  if (all.length === 0) return;
  const lo = Math.floor(Math.min(...all)) - 2;
  const hi = Math.ceil(Math.max(...all)) + 2;
  const y = (midi: number) => height - ((midi - lo) / (hi - lo)) * height;
  const seconds = samples.length / (loaded?.sampleRate ?? DEMO_RATE);
  const x = (t: number) => (t / seconds) * width;

  // Semitone grid, C labelled.
  g.font = `${11 * dpr}px system-ui, sans-serif`;
  for (let m = lo; m <= hi; m++) {
    g.fillStyle = m % 12 === 0 ? color("--line") : color("--grid");
    g.fillRect(0, Math.round(y(m)), width, 1);
    if (m % 12 === 0 || hi - lo <= 14) {
      g.fillStyle = color("--muted");
      g.fillText(pitchLabel(m), 4 * dpr, y(m) - 2 * dpr);
    }
  }

  const line = (midi: number | undefined, name: string, dash: number[], lineWidth = 1.5) => {
    if (midi === undefined || !Number.isFinite(midi)) return;
    g.strokeStyle = color(name);
    g.lineWidth = lineWidth * dpr;
    g.setLineDash(dash.map((d) => d * dpr));
    g.beginPath();
    g.moveTo(0, y(midi));
    g.lineTo(width, y(midi));
    g.stroke();
    g.setLineDash([]);
  };
  line(center?.mean, "--mean", [6, 4]);
  line(center?.mode, "--mode", [2, 3]);
  line(center?.median, "--median", []);
  if (root !== null && rootChoice === "manual") line(root, "--text", [10, 4], 1);

  // Pitch curve (thicker where more surely voiced).
  g.strokeStyle = color("--pitch");
  g.lineWidth = 2 * dpr;
  g.beginPath();
  let drawing = false;
  for (let i = 0; i < track.f0.length; i++) {
    const v = track.f0[i];
    if (!Number.isFinite(v)) {
      drawing = false;
      continue;
    }
    const px = x(i * track.hopSec);
    if (drawing) g.lineTo(px, y(v));
    else g.moveTo(px, y(v));
    drawing = true;
  }
  g.stroke();
}

window.addEventListener("resize", draw);

// ---------------------------------------------------------------- 3. 変換

contourInput.addEventListener("input", () => {
  contourValue.textContent = Number(contourInput.value).toFixed(2);
});

renderButton.addEventListener("click", () => void renderAll());

async function renderAll(): Promise<void> {
  const root = rootPitch();
  if (!analysis || !loaded || root === null) {
    renderStatus.textContent = "基準ピッチが決まっていません。";
    return;
  }
  const single = parseNoteName(singleInput.value) ?? Number(singleInput.value);
  const beatSec = 60 / Math.max(40, Math.min(300, Number(bpmInput.value) || 120));
  const notes = patternNotes(patternSelect.value as PatternId, root, Number.isFinite(single) ? single : 60, beatSec);
  const settings = { contour: Number(contourInput.value), lengthMode: lengthSelect.value as LengthMode };
  const material: Material = { samples: analysis.samples, sampleRate: loaded.sampleRate, track: analysis.track, rootPitch: root };
  const shifts = notes.map((n) => n.pitch - root);
  lastRenderInfo = {
    pattern: patternSelect.value,
    notes: notes.length,
    rootPitch: Number(root.toFixed(2)),
    shiftRange: [Number(Math.min(...shifts).toFixed(2)), Number(Math.max(...shifts).toFixed(2))],
    ...settings,
    signalsmithFormantCompensation: formantCheck.checked,
  };

  renderButton.disabled = true;
  results = [];
  resultBody.replaceChildren();
  try {
    for (const method of ["resample", "psola", "signalsmith"] as const) {
      renderStatus.textContent = `${METHOD_LABELS[method]} で変換中…`;
      let result: RenderResult;
      if (method === "signalsmith") {
        const shifter = (request: Parameters<typeof signalsmithShift>[0]) => signalsmithShift(request, { formantCompensation: formantCheck.checked });
        result = await renderNotes(method, shifter, material, notes, settings);
      } else {
        const response = await ask({ type: "render", method, material, notes, settings });
        if (response.type !== "render") continue;
        result = response.result;
      }
      results.push(result);
      addResultRow(result);
    }
    renderStatus.textContent = `${notes.length} ノートを変換しました(移調量 ${shifts.length ? `${Math.min(...shifts).toFixed(1)}〜${Math.max(...shifts).toFixed(1)}` : "—"} 半音)。`;
  } catch (error) {
    renderStatus.textContent = `変換に失敗しました: ${error instanceof Error ? error.message : error}`;
  } finally {
    renderButton.disabled = false;
    updateEnv();
  }
}

function addResultRow(result: RenderResult): void {
  const sampleRate = loaded?.sampleRate ?? DEMO_RATE;
  const playButton = el("button", { textContent: "▶ 再生" });
  playButton.addEventListener("click", () => play(result.audio, sampleRate));
  const saveButton = el("button", { textContent: "WAV" });
  saveButton.addEventListener("click", () => download(encodeWav([result.audio], sampleRate), `maddaw-phase0-${result.method}.wav`));
  const perSec = result.producedSec > 0 ? result.elapsedMs / result.producedSec : 0;
  resultBody.append(
    el("tr", {}, [
      el("td", { textContent: METHOD_LABELS[result.method] }),
      el("td", { className: "num", textContent: `${result.elapsedMs.toFixed(0)} ms` }),
      el("td", { className: "num", textContent: `${perSec.toFixed(0)} ms` }),
      el("td", {}, [playButton]),
      el("td", {}, [saveButton]),
    ]),
  );
}

// ---------------------------------------------------------------- 4. 環境

/** How far (ms) Signalsmith's output sits from the input, found by cross-correlation; 0 = aligned. */
async function measureSignalsmithLag(): Promise<void> {
  if (!analysis || !loaded) return;
  lagButton.disabled = true;
  try {
    const sr = loaded.sampleRate;
    const x = analysis.samples;
    const y = await signalsmithShift({ input: x, sampleRate: sr, track: analysis.track, rootPitch: 60, shift: 0, contour: 1, stretch: 1 });
    const maxLag = Math.round(0.03 * sr);
    // The loudest 0.2 s of the input.
    const window = Math.min(x.length - 2 * maxLag, Math.round(0.2 * sr));
    let from = maxLag;
    let best = -1;
    for (let i = maxLag; i + window < x.length - maxLag; i += Math.round(0.01 * sr)) {
      let energy = 0;
      for (let j = 0; j < window; j += 8) energy += x[i + j] * x[i + j];
      if (energy > best) {
        best = energy;
        from = i;
      }
    }
    let bestLag = 0;
    let bestScore = -Infinity;
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      let score = 0;
      for (let j = 0; j < window; j += 2) score += x[from + j] * (y[from + j + lag] ?? 0);
      if (score > bestScore) {
        bestScore = score;
        bestLag = lag;
      }
    }
    signalsmithLagMs = (bestLag / sr) * 1000;
  } finally {
    lagButton.disabled = false;
    updateEnv();
  }
}

lagButton.addEventListener("click", () => void measureSignalsmithLag());

function summary(): Record<string, unknown> {
  const c = analysis?.center;
  const seconds = analysis && loaded ? analysis.samples.length / loaded.sampleRate : 0;
  return {
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    crossOriginIsolated: window.crossOriginIsolated,
    audioWorklet: typeof AudioWorkletNode !== "undefined",
    material: loaded ? { name: loaded.name, sampleRate: loaded.sampleRate, selectionSec: Number(seconds.toFixed(2)) } : null,
    analysis: analysis
      ? {
          ms: Math.round(analysis.elapsedMs),
          msPerSec: Math.round(analysis.elapsedMs / Math.max(seconds, 1e-6)),
          median: c ? Number(c.median.toFixed(2)) : null,
          mean: c ? Number(c.mean.toFixed(2)) : null,
          mode: c ? Number(c.mode.toFixed(2)) : null,
          spread: c ? Number(c.spread.toFixed(2)) : null,
          confidence: c ? Number(c.confidence.toFixed(2)) : null,
          rootChoice,
        }
      : null,
    render: results.length ? { ...lastRenderInfo, results: results.map((r) => ({ method: r.method, ms: Math.round(r.elapsedMs), msPerOutputSec: Math.round(r.elapsedMs / Math.max(r.producedSec, 1e-6)) })) } : null,
    signalsmithLagMs: signalsmithLagMs === null ? null : Number(signalsmithLagMs.toFixed(2)),
  };
}

function updateEnv(): void {
  envPre.textContent = JSON.stringify(summary(), null, 2);
}

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(JSON.stringify(summary(), null, 2));
    copyButton.textContent = "コピーしました";
  } catch {
    copyButton.textContent = "コピーできませんでした(下の欄から選択してください)";
  }
  setTimeout(() => (copyButton.textContent = "結果をコピー"), 2000);
});

renderCenterTable();
updateEnv();
