// The settings file (design.md 5): everything the user decided about a
// material — the cuts with their markers and parameters, the export
// settings, the credit — and nothing of the audio. Small enough to keep in
// localStorage per material (so reopening the same file restores it) and
// to save / load as JSON by hand.

import type { PitchCorrection } from "../analysis/corrections";
import { normalizeRemoved } from "../instrument/layout";
import { clampMarkers } from "../instrument/markers";
import { DEFAULT_EXPORT, DEFAULT_FX, DEFAULT_PARAMS, type Credit, type ExportSettings, type FxBeats, type FxSettings, type InstrumentParams, type Markers } from "../instrument/types";

export interface CutSettings {
  name: string;
  markers: Markers;
  params: InstrumentParams;
  note: number;
  noteMode: "auto" | "manual";
  /** The preset last chosen ("" = changed since, カスタム). Absent in older files. */
  presetId?: string;
}

export interface SettingsFile {
  app: "EasySampler" | "MADDAW";
  version: 1;
  savedAt: string;
  material: { name: string; durationSec: number; sampleRate: number; channels: number };
  export: ExportSettings;
  credit: Credit;
  cuts: CutSettings[];
  currentCut: number;
  /** Hand corrections to the pitch analysis (applied to the original analysis, in order). */
  corrections: PitchCorrection[];
  /** The pitch search range the analysis was run with (探索範囲), when narrowed. */
  pitchRange?: { low: number; high: number };
}

export function serializeSettings(file: Omit<SettingsFile, "app" | "version" | "savedAt">): string {
  const full: SettingsFile = { app: "EasySampler", version: 1, savedAt: new Date().toISOString(), ...file };
  return JSON.stringify(full, null, 2);
}

/** Parses and sanitises a settings file; throws when it isn't one. Unknown fields are dropped, missing ones filled from the defaults. */
export function parseSettings(text: string): SettingsFile {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw) || (raw.app !== "EasySampler" && raw.app !== "MADDAW") || raw.version !== 1) throw new Error("EasySampler の設定ファイルではありません");
  const material = isRecord(raw.material) ? raw.material : {};
  const cutsRaw = Array.isArray(raw.cuts) ? raw.cuts : [];
  const cuts = cutsRaw.map((c, i) => sanitizeCut(c, i)).filter((c): c is CutSettings => c !== null);
  if (cuts.length === 0) throw new Error("区間がありません");
  const exp = sanitizeExport(raw.export);
  return {
    app: "EasySampler",
    version: 1,
    savedAt: typeof raw.savedAt === "string" ? raw.savedAt : "",
    material: {
      name: typeof material.name === "string" ? material.name : "",
      durationSec: num(material.durationSec, 0),
      sampleRate: num(material.sampleRate, 0),
      channels: num(material.channels, 1),
    },
    export: exp,
    credit: sanitizeCredit(raw.credit),
    cuts,
    currentCut: Math.max(0, Math.min(cuts.length - 1, Math.round(num(raw.currentCut, 0)))),
    corrections: sanitizeCorrections(raw.corrections),
    pitchRange: sanitizeRange(raw.pitchRange),
  };
}

function sanitizeCorrections(raw: unknown): PitchCorrection[] {
  if (!Array.isArray(raw)) return [];
  const kinds = ["octave-up", "octave-down", "shift", "set", "unvoiced", "voiced"] as const;
  const out: PitchCorrection[] = [];
  for (const c of raw) {
    if (!isRecord(c) || !kinds.includes(c.kind as never)) continue;
    const start = num(c.start, Number.NaN);
    const end = num(c.end, Number.NaN);
    if (!(start >= 0) || !(end > start)) continue;
    const kind = c.kind as PitchCorrection["kind"];
    const correction: PitchCorrection = { start, end, kind };
    if (kind === "shift") correction.cents = clamp(num(c.cents, 0), -2400, 2400);
    if (kind === "set") correction.midi = clamp(num(c.midi, 60), 0, 127);
    out.push(correction);
  }
  return out;
}

/** The analysis's pitch search range (MIDI notes), when the user narrowed it. */
function sanitizeRange(raw: unknown): { low: number; high: number } | undefined {
  if (!isRecord(raw)) return undefined;
  const low = clamp(Math.round(num(raw.low, 24)), 12, 120);
  const high = clamp(Math.round(num(raw.high, 107)), 12, 120);
  return high > low ? { low, high } : undefined;
}

/** The storage key for a material: its name and length (the same file opened again finds its settings). */
export function settingsKey(name: string, frames: number, sampleRate: number): string {
  return `maddaw.settings.v1:${name}:${frames}:${sampleRate}`;
}

function sanitizeCut(raw: unknown, index: number): CutSettings | null {
  if (!isRecord(raw) || !isRecord(raw.markers)) return null;
  const m = raw.markers;
  const markers = clampMarkers({
    rangeStart: num(m.rangeStart, 0),
    rangeEnd: num(m.rangeEnd, 1),
    attack: num(m.attack, 0),
    sustainStart: num(m.sustainStart, 0),
    sustainEnd: num(m.sustainEnd, 1),
    tailStart: num(m.tailStart, 1),
    removed: Array.isArray(m.removed)
      ? m.removed.filter((r): r is Record<string, unknown> => isRecord(r)).map((r) => ({ start: num(r.start, 0), end: num(r.end, 0) }))
      : undefined,
  });
  const removed = normalizeRemoved(markers.removed, markers.rangeStart, markers.rangeEnd);
  if (removed.length) markers.removed = removed;
  else delete markers.removed;
  return {
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name : `区間 ${index + 1}`,
    markers,
    params: sanitizeParams(raw.params),
    note: Math.max(0, Math.min(127, Math.round(num(raw.note, 60)))),
    noteMode: raw.noteMode === "manual" ? "manual" : "auto",
    ...(typeof raw.presetId === "string" ? { presetId: raw.presetId } : {}),
  };
}

function sanitizeParams(raw: unknown): InstrumentParams {
  const d = DEFAULT_PARAMS;
  if (!isRecord(raw)) return structuredClone(d);
  const tail = isRecord(raw.tail) ? raw.tail : {};
  const wobble = isRecord(raw.wobble) ? raw.wobble : {};
  const amp = isRecord(raw.amp) ? raw.amp : {};
  return {
    root: num(raw.root, d.root),
    rootMode: raw.rootMode === "manual" ? "manual" : "auto",
    pitchMode: raw.pitchMode === "resample" ? "resample" : "preserve-length",
    flatten: clamp(num(raw.flatten, d.flatten), 0, 1),
    tune: sanitizeTune(raw.tune, d.tune),
    unvoicedFollow: typeof raw.unvoicedFollow === "boolean" ? raw.unvoicedFollow : d.unvoicedFollow,
    levelEven: clamp(num(raw.levelEven, d.levelEven), 0, 1),
    formantSemitones: clamp(num(raw.formantSemitones, d.formantSemitones), -12, 12),
    // (Older files stored on / off.)
    formantFollow: typeof raw.formantFollow === "boolean" ? (raw.formantFollow ? 0.5 : 0) : clamp(num(raw.formantFollow, d.formantFollow), 0, 1),
    unvoicedGainDb: clamp(num(raw.unvoicedGainDb, d.unvoicedGainDb), -60, 12),
    sustainEnabled: typeof raw.sustainEnabled === "boolean" ? raw.sustainEnabled : d.sustainEnabled,
    sustainMode: raw.sustainMode === "loop" || raw.sustainMode === "none" || raw.sustainMode === "wavetable" || raw.sustainMode === "stretch" ? raw.sustainMode : "pool",
    wavetableCycles: clamp(Math.round(num(raw.wavetableCycles, d.wavetableCycles)), 1, 16),
    stretch: {
      head: clamp(num(isRecord(raw.stretch) ? raw.stretch.head : undefined, d.stretch.head), 0.25, 4),
      sustain: clamp(num(isRecord(raw.stretch) ? raw.stretch.sustain : undefined, d.stretch.sustain), 0.25, 8),
      tail: clamp(num(isRecord(raw.stretch) ? raw.stretch.tail : undefined, d.stretch.tail), 0.25, 4),
    },
    tail: {
      enabled: typeof tail.enabled === "boolean" ? tail.enabled : d.tail.enabled,
      limit: tail.limit === "none" || tail.limit === "beat" || tail.limit === "bar" ? tail.limit : "unlimited",
    },
    wobble: {
      vibratoCents: clamp(num(wobble.vibratoCents, d.wobble.vibratoCents), 0, 200),
      vibratoHz: clamp(num(wobble.vibratoHz, d.wobble.vibratoHz), 1, 12),
      vibratoDelaySec: clamp(num(wobble.vibratoDelaySec, d.wobble.vibratoDelaySec), 0, 5),
      vibratoAttackSec: clamp(num(wobble.vibratoAttackSec, d.wobble.vibratoAttackSec), 0, 5),
      vibratoReleaseSec: clamp(num(wobble.vibratoReleaseSec, d.wobble.vibratoReleaseSec), 0, 5),
      vibratoPhase: clamp(num(wobble.vibratoPhase, d.wobble.vibratoPhase), 0, 1),
      tremoloDepth: clamp(num(wobble.tremoloDepth, d.wobble.tremoloDepth), 0, 1),
      smoothSec: clamp(num(wobble.smoothSec, d.wobble.smoothSec), 0, 1),
      keepDrift: clamp(num(wobble.keepDrift, d.wobble.keepDrift), -1, 1),
      keepModulation: clamp(num(wobble.keepModulation, d.wobble.keepModulation), -1, 1),
      driftCents: clamp(num(wobble.driftCents, d.wobble.driftCents), 0, 100),
      micro: typeof wobble.micro === "boolean" ? wobble.micro : d.wobble.micro,
    },
    amp: {
      attack: clamp(num(amp.attack, d.amp.attack), 0, 5),
      decay: clamp(num(amp.decay, d.amp.decay), 0, 10),
      sustain: clamp(num(amp.sustain, d.amp.sustain), 0, 1),
      release: clamp(num(amp.release, d.amp.release), 0, 10),
      velocitySens: clamp(num(amp.velocitySens, d.amp.velocitySens), 0, 1),
      fadeOut: clamp(num(amp.fadeOut, d.amp.fadeOut), 0, 10),
    },
    maxVoices: d.maxVoices,
    fx: sanitizeFx(raw.fx),
  };
}

const FX_BEATS: FxBeats[] = [0.25, 0.5, 1, 2, 4, 8];

/** The effect rack; anything missing or out of range falls back to the default (off). */
function sanitizeFx(raw: unknown): FxSettings {
  const d = DEFAULT_FX;
  const r = isRecord(raw) ? raw : {};
  const part = (key: keyof FxSettings) => (isRecord(r[key]) ? (r[key] as Record<string, unknown>) : {});
  const on = (p: Record<string, unknown>) => p.on === true;
  const beats = (v: unknown, fallback: FxBeats) => (FX_BEATS.includes(v as FxBeats) ? (v as FxBeats) : fallback);
  const t = part("transient");
  const e = part("eq");
  const sa = part("saturation");
  const a = part("air");
  const fi = part("filter");
  const c = part("crush");
  const ch = part("chorus");
  const w = part("width");
  const p = part("pan");
  const l = part("limiter");
  return {
    transient: { on: on(t), attackDb: clamp(num(t.attackDb, d.transient.attackDb), -24, 24), sustainDb: clamp(num(t.sustainDb, d.transient.sustainDb), -24, 24) },
    eq: {
      on: on(e),
      lowCutHz: clamp(num(e.lowCutHz, d.eq.lowCutHz), 0, 2000),
      lowDb: clamp(num(e.lowDb, d.eq.lowDb), -24, 24),
      lowHz: clamp(num(e.lowHz, d.eq.lowHz), 20, 1000),
      midDb: clamp(num(e.midDb, d.eq.midDb), -24, 24),
      midHz: clamp(num(e.midHz, d.eq.midHz), 100, 10000),
      midQ: clamp(num(e.midQ, d.eq.midQ), 0.2, 10),
      highDb: clamp(num(e.highDb, d.eq.highDb), -24, 24),
      highHz: clamp(num(e.highHz, d.eq.highHz), 1000, 18000),
      highCutHz: clamp(num(e.highCutHz, d.eq.highCutHz), 500, 20000),
    },
    saturation: { on: on(sa), drive: clamp(num(sa.drive, d.saturation.drive), 0, 1), mix: clamp(num(sa.mix, d.saturation.mix), 0, 1) },
    air: { on: on(a), amount: clamp(num(a.amount, d.air.amount), 0, 1) },
    filter: {
      on: on(fi),
      type: fi.type === "highpass" || fi.type === "bandpass" ? fi.type : "lowpass",
      cutoffHz: clamp(num(fi.cutoffHz, d.filter.cutoffHz), 40, 18000),
      resonance: clamp(num(fi.resonance, d.filter.resonance), 0, 1),
      lfoOctaves: clamp(num(fi.lfoOctaves, d.filter.lfoOctaves), 0, 6),
      lfoBeats: beats(fi.lfoBeats, d.filter.lfoBeats),
    },
    crush: { on: on(c), bits: clamp(Math.round(num(c.bits, d.crush.bits)), 1, 16), downsample: clamp(Math.round(num(c.downsample, d.crush.downsample)), 1, 64), mix: clamp(num(c.mix, d.crush.mix), 0, 1) },
    chorus: { on: on(ch), rateHz: clamp(num(ch.rateHz, d.chorus.rateHz), 0.05, 8), depthMs: clamp(num(ch.depthMs, d.chorus.depthMs), 0, 15), mix: clamp(num(ch.mix, d.chorus.mix), 0, 1) },
    width: { on: on(w), side: clamp(num(w.side, d.width.side), 0, 3), midDb: clamp(num(w.midDb, d.width.midDb), -24, 12) },
    pan: { on: on(p), depth: clamp(num(p.depth, d.pan.depth), 0, 1), beats: beats(p.beats, d.pan.beats) },
    limiter: { on: on(l), gainDb: clamp(num(l.gainDb, d.limiter.gainDb), 0, 24), ceilingDb: clamp(num(l.ceilingDb, d.limiter.ceilingDb), -24, 0), releaseMs: clamp(num(l.releaseMs, d.limiter.releaseMs), 5, 1000) },
  };
}

function sanitizeTune(raw: unknown, d: InstrumentParams["tune"]): InstrumentParams["tune"] {
  const r = isRecord(raw) ? raw : {};
  const scales = ["chromatic", "major", "minor", "pentatonic"] as const;
  return {
    mode: r.mode === "scale" ? "scale" : "flatten",
    scale: scales.includes(r.scale as never) ? (r.scale as InstrumentParams["tune"]["scale"]) : d.scale,
    key: clamp(Math.round(num(r.key, d.key)), 0, 11),
    retuneSec: clamp(num(r.retuneSec, d.retuneSec), 0, 1),
  };
}

function sanitizeExport(raw: unknown): ExportSettings {
  const d = DEFAULT_EXPORT;
  if (!isRecord(raw)) return structuredClone(d);
  const destinations = ["generic", "garageband", "vital", "decent"] as const;
  const formats = ["single", "loop", "multisample", "wavetable"] as const;
  return {
    lengthMode: raw.lengthMode === "seconds" ? "seconds" : "beats",
    beats: clamp(num(raw.beats, d.beats), 0.25, 64),
    bpm: clamp(num(raw.bpm, d.bpm), 20, 400),
    seconds: clamp(num(raw.seconds, d.seconds), 0.1, 60),
    destination: destinations.includes(raw.destination as never) ? (raw.destination as ExportSettings["destination"]) : d.destination,
    format: formats.includes(raw.format as never) ? (raw.format as ExportSettings["format"]) : d.format,
  };
}

function sanitizeCredit(raw: unknown): Credit {
  const r = isRecord(raw) ? raw : {};
  const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 2000) : "");
  return { title: str(r.title), url: str(r.url), timecode: str(r.timecode), memo: str(r.memo) };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
