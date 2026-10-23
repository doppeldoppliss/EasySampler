// The instrument (楽器): a stretch of a material set up to be played by notes
// (design.md 4), and the export settings (design.md 5): which note the file
// is tuned to and how long it is. Every setting here is a parameter —
// nothing is rendered until the file is written — so any of it can be
// changed at any time. Times are seconds within the material.

export type SustainMode = "pool" | "loop" | "wavetable" | "none";
export type TailLimit = "none" | "beat" | "bar" | "unlimited";
export type PitchMode = "preserve-length" | "resample";
export type PresetId = "synth" | "synth-lead" | "wavetable" | "bass" | "jinriki" | "original" | "drum";

/** Seconds within the material, [start, end). */
export interface TimeRange {
  start: number;
  end: number;
}

export interface Markers {
  /** Where the material starts and stops being used (the cut, 切り出し). */
  rangeStart: number;
  rangeEnd: number;
  /** Stretches cut out of the material (VocalShifter's 選択範囲の削除): skipped on playback, in order, non-overlapping. */
  removed?: TimeRange[];
  /** End of the head (頭部) = where the sound "lands": the head plays once, unstretched. */
  attack: number;
  /** The sustain region (持続区間): drawn out while the note is held. */
  sustainStart: number;
  sustainEnd: number;
  /** Start of the tail (語尾), played after the note is released when enabled. */
  tailStart: number;
}

export interface InstrumentParams {
  /** Root pitch, MIDI with cents (61.63 = D4 −37¢). */
  root: number;
  rootMode: "auto" | "manual";
  pitchMode: PitchMode;
  /** 0 = the material's own inflection, 1 = flat on the note (★3). */
  flatten: number;
  /**
   * Unvoiced grains (no pitch: consonants, breath, noise) are normally laid down
   * as recorded whatever the note. On, they are read faster / slower with the
   * shift — no pitch (there is none), but their colour follows the note, as in
   * old-style speed-change 音MAD — while the length stays the same.
   */
  unvoicedFollow: boolean;
  /** Formant shift in semitones (0 = keep the voice's character). */
  formantSemitones: number;
  /** Let the formants follow a little on shifts beyond ±7 semitones. */
  formantFollow: boolean;
  /** Whether the sustain plays at all; off: the head goes straight on to the tail (or the note ends). */
  sustainEnabled: boolean;
  sustainMode: SustainMode;
  /** Wavetable sustain: how many consecutive periods are cycled (1 = one period over and over). */
  wavetableCycles: number;
  /**
   * Speed of each part, as a stretch factor (1 = as recorded, 2 = twice as long; VocalShifter's TIME).
   * The sustain's factor only matters when it isn't elastic (sustain mode "none"); otherwise the note's length decides.
   */
  stretch: { head: number; sustain: number; tail: number };
  tail: { enabled: boolean; limit: TailLimit };
  wobble: {
    vibratoCents: number;
    vibratoHz: number;
    vibratoDelaySec: number;
    /** Slow wander (cents). */
    driftCents: number;
    /** Tiny period/level irregularity, kept even when fully flattened. */
    micro: boolean;
  };
  /**
   * Release: the fade after the note is let go when the tail is off (default 20 ms).
   * fadeOut (終わりのフェード): the last seconds before the material runs out fade to silence,
   * and a release is never shorter than it. The attack is the 入りのフェード.
   */
  amp: { attack: number; decay: number; sustain: number; release: number; velocitySens: number; fadeOut: number };
  maxVoices: number;
  /** The effect rack (エフェクト), after the voices: what the keyboard, 曲で試す and the file all get. */
  fx: FxSettings;
}

/** LFO speeds, in beats per cycle (counted in the export BPM, or the song's while 曲で試す plays). */
export type FxBeats = 0.25 | 0.5 | 1 | 2 | 4 | 8;

/** The effects, always in this order: shape → tone → colour → movement → space → level. */
export interface FxSettings {
  /** Transient shaper: dB on the attack and on what follows it. */
  transient: { on: boolean; attackDb: number; sustainDb: number };
  /** EQ: low cut, low shelf, one bell, high shelf, high cut (a cut at 0 / ≥ 20 kHz is off). */
  eq: { on: boolean; lowCutHz: number; lowDb: number; lowHz: number; midDb: number; midHz: number; midQ: number; highDb: number; highHz: number; highCutHz: number };
  /** Saturation (tube-like, asymmetric): drive 0–1, dry/wet. */
  saturation: { on: boolean; drive: number; mix: number };
  /** Air: high-shelf lift plus a little generated top end, 0–1. */
  air: { on: boolean; amount: number };
  /** Filter with an LFO on the cutoff (octaves of sweep). */
  filter: { on: boolean; type: "lowpass" | "highpass" | "bandpass"; cutoffHz: number; resonance: number; lfoOctaves: number; lfoBeats: FxBeats };
  /** Bit crusher: bit depth, sample-rate division, dry/wet. */
  crush: { on: boolean; bits: number; downsample: number; mix: number };
  /** Chorus: speed (Hz), depth (ms), dry/wet. */
  chorus: { on: boolean; rateHz: number; depthMs: number; mix: number };
  /** Mid/side: side level (1 = as is, 0 = mono, 2 = twice as wide) and mid level. */
  width: { on: boolean; side: number; midDb: number };
  /** Auto-pan: depth 0–1. */
  pan: { on: boolean; depth: number; beats: FxBeats };
  /** Limiter: input gain, ceiling (dBFS), release. */
  limiter: { on: boolean; gainDb: number; ceilingDb: number; releaseMs: number };
}

export const DEFAULT_FX: FxSettings = {
  transient: { on: false, attackDb: 0, sustainDb: 0 },
  eq: { on: false, lowCutHz: 0, lowDb: 0, lowHz: 150, midDb: 0, midHz: 1500, midQ: 1, highDb: 0, highHz: 6000, highCutHz: 20000 },
  saturation: { on: false, drive: 0.3, mix: 1 },
  air: { on: false, amount: 0.3 },
  filter: { on: false, type: "lowpass", cutoffHz: 2000, resonance: 0.3, lfoOctaves: 2, lfoBeats: 1 },
  crush: { on: false, bits: 8, downsample: 4, mix: 1 },
  chorus: { on: false, rateHz: 0.8, depthMs: 4, mix: 0.4 },
  width: { on: false, side: 1.4, midDb: 0 },
  pan: { on: false, depth: 0.6, beats: 1 },
  limiter: { on: false, gainDb: 3, ceilingDb: -1, releaseMs: 80 },
};

export interface Credit {
  title: string;
  url: string;
  timecode: string;
  memo: string;
}

/** Synth-ification (シンセ化) is the default: flat on the note, the vowel drawn out, a little life left in it. */
export const DEFAULT_PARAMS: InstrumentParams = {
  root: 60,
  rootMode: "auto",
  pitchMode: "preserve-length",
  flatten: 1,
  unvoicedFollow: false,
  formantSemitones: 0,
  formantFollow: true,
  sustainEnabled: true,
  sustainMode: "pool",
  wavetableCycles: 1,
  stretch: { head: 1, sustain: 1, tail: 1 },
  tail: { enabled: true, limit: "unlimited" },
  wobble: { vibratoCents: 0, vibratoHz: 5.5, vibratoDelaySec: 0.25, driftCents: 0, micro: true },
  amp: { attack: 0.005, decay: 0.1, sustain: 1, release: 0.02, velocitySens: 0.5, fadeOut: 0 },
  maxVoices: 24,
  fx: DEFAULT_FX,
};

export interface Preset {
  id: PresetId;
  label: string;
  apply: (params: InstrumentParams) => InstrumentParams;
}

/** Starting points (design.md 4.5); the root and markers stay as they are. */
export const PRESETS: Preset[] = [
  { id: "synth", label: "シンセ化(平坦)", apply: (p) => ({ ...p, pitchMode: "preserve-length", flatten: 1, sustainMode: "pool", wobble: { ...p.wobble, vibratoCents: 0, driftCents: 0, micro: true } }) },
  { id: "synth-lead", label: "シンセ化リード(ビブラート)", apply: (p) => ({ ...p, pitchMode: "preserve-length", flatten: 1, sustainMode: "pool", wobble: { ...p.wobble, vibratoCents: 25, vibratoHz: 5.8, vibratoDelaySec: 0.2, driftCents: 0, micro: true } }) },
  { id: "wavetable", label: "ウェーブテーブル(無機質)", apply: (p) => ({ ...p, pitchMode: "preserve-length", flatten: 1, sustainMode: "wavetable", wavetableCycles: 1, wobble: { ...p.wobble, vibratoCents: 0, driftCents: 0, micro: false } }) },
  { id: "bass", label: "ベース", apply: (p) => ({ ...p, pitchMode: "preserve-length", flatten: 1, sustainMode: "pool", wobble: { ...p.wobble, vibratoCents: 0, driftCents: 0, micro: true }, amp: { ...p.amp, attack: 0.003, release: 0.04 } }) },
  { id: "jinriki", label: "人力(抑揚を少し整える)", apply: (p) => ({ ...p, pitchMode: "preserve-length", flatten: 0.3, sustainMode: "pool", wobble: { ...p.wobble, vibratoCents: 15, vibratoHz: 5.5, vibratoDelaySec: 0.3, driftCents: 4, micro: true } }) },
  { id: "original", label: "原型(抑揚そのまま)", apply: (p) => ({ ...p, pitchMode: "preserve-length", flatten: 0, sustainMode: "pool", wobble: { ...p.wobble, vibratoCents: 0, driftCents: 0, micro: true } }) },
  { id: "drum", label: "ドラム・効果音(ワンショット)", apply: (p) => ({ ...p, pitchMode: "resample", flatten: 0, sustainMode: "none", wobble: { ...p.wobble, vibratoCents: 0, driftCents: 0, micro: false }, amp: { ...p.amp, attack: 0.001, sustain: 1, release: 0.03 } }) },
];

// ---------------------------------------------------------------- export

export type LengthMode = "beats" | "seconds";

/** Where the file is going; picks the sample rate and the help text (design.md 5–7). */
export type Destination = "generic" | "garageband" | "vital" | "decent";

/** What is written: one WAV, one loopable WAV, a multisample folder (zip), or a wavetable for Vital. */
export type ExportFormat = "single" | "loop" | "multisample" | "wavetable";

/** Shared by every cut of the material; the note itself belongs to the cut. */
export interface ExportSettings {
  format: ExportFormat;
  lengthMode: LengthMode;
  beats: number;
  bpm: number;
  seconds: number;
  destination: Destination;
}

export const DEFAULT_EXPORT: ExportSettings = {
  format: "single",
  lengthMode: "beats",
  beats: 2,
  bpm: 120,
  seconds: 1,
  destination: "generic",
};

/** How long the note is held (seconds). */
export function exportLengthSec(settings: ExportSettings): number {
  const seconds = settings.lengthMode === "beats" ? (settings.beats * 60) / Math.max(1, settings.bpm) : settings.seconds;
  return Math.max(0.05, Math.min(60, seconds));
}

/** The sample rate the destination wants; null = keep the material's own. */
export function destinationRate(destination: Destination): number | null {
  return destination === "garageband" ? 44100 : null;
}
