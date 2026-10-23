// The instrument (楽器): a stretch of a material set up to be played by notes
// (design.md 4), and the export settings (design.md 5): which note the file
// is tuned to and how long it is. Every setting here is a parameter —
// nothing is rendered until the file is written — so any of it can be
// changed at any time. Times are seconds within the material.

export type SustainMode = "pool" | "loop" | "none";
export type TailLimit = "none" | "beat" | "bar" | "unlimited";
export type PitchMode = "preserve-length" | "resample";
export type PresetId = "synth" | "synth-lead" | "bass" | "jinriki" | "original" | "drum";

export interface Markers {
  /** Where the material starts and stops being used (the cut, 切り出し). */
  rangeStart: number;
  rangeEnd: number;
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
  /** Formant shift in semitones (0 = keep the voice's character). */
  formantSemitones: number;
  /** Let the formants follow a little on shifts beyond ±7 semitones. */
  formantFollow: boolean;
  sustainMode: SustainMode;
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
  /** Release: the fade after the note is let go when the tail is off (default 20 ms). */
  amp: { attack: number; decay: number; sustain: number; release: number; velocitySens: number };
  maxVoices: number;
}

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
  formantSemitones: 0,
  formantFollow: true,
  sustainMode: "pool",
  tail: { enabled: false, limit: "unlimited" },
  wobble: { vibratoCents: 0, vibratoHz: 5.5, vibratoDelaySec: 0.25, driftCents: 0, micro: true },
  amp: { attack: 0.005, decay: 0.1, sustain: 1, release: 0.02, velocitySens: 0.5 },
  maxVoices: 24,
};

export interface Preset {
  id: PresetId;
  label: string;
  apply: (params: InstrumentParams) => InstrumentParams;
}

/** Starting points (design.md 4.5); the root and markers stay as they are. */
export const PRESETS: Preset[] = [
  { id: "synth", label: "シンセ化(平坦)", apply: (p) => ({ ...p, pitchMode: "preserve-length", flatten: 1, sustainMode: "pool", tail: { ...p.tail, enabled: false }, wobble: { ...p.wobble, vibratoCents: 0, driftCents: 0, micro: true } }) },
  { id: "synth-lead", label: "シンセ化リード(ビブラート)", apply: (p) => ({ ...p, pitchMode: "preserve-length", flatten: 1, sustainMode: "pool", tail: { ...p.tail, enabled: false }, wobble: { ...p.wobble, vibratoCents: 25, vibratoHz: 5.8, vibratoDelaySec: 0.2, driftCents: 0, micro: true } }) },
  { id: "bass", label: "ベース", apply: (p) => ({ ...p, pitchMode: "preserve-length", flatten: 1, sustainMode: "pool", tail: { ...p.tail, enabled: false }, wobble: { ...p.wobble, vibratoCents: 0, driftCents: 0, micro: true }, amp: { ...p.amp, attack: 0.003, release: 0.04 } }) },
  { id: "jinriki", label: "人力(抑揚を少し整える)", apply: (p) => ({ ...p, pitchMode: "preserve-length", flatten: 0.3, sustainMode: "pool", tail: { ...p.tail, enabled: true }, wobble: { ...p.wobble, vibratoCents: 15, vibratoHz: 5.5, vibratoDelaySec: 0.3, driftCents: 4, micro: true } }) },
  { id: "original", label: "原型(抑揚そのまま)", apply: (p) => ({ ...p, pitchMode: "preserve-length", flatten: 0, sustainMode: "pool", tail: { ...p.tail, enabled: false }, wobble: { ...p.wobble, vibratoCents: 0, driftCents: 0, micro: true } }) },
  { id: "drum", label: "ドラム・効果音(ワンショット)", apply: (p) => ({ ...p, pitchMode: "resample", flatten: 0, sustainMode: "none", tail: { ...p.tail, enabled: true }, wobble: { ...p.wobble, vibratoCents: 0, driftCents: 0, micro: false }, amp: { ...p.amp, attack: 0.001, sustain: 1, release: 0.03 } }) },
];

// ---------------------------------------------------------------- export

export type LengthMode = "beats" | "seconds";

/** Where the file is going; picks the sample rate and the help text (design.md 5–7). */
export type Destination = "generic" | "garageband" | "vital" | "decent";

/** What is written: one WAV, one loopable WAV, or a multisample folder (zip). */
export type ExportFormat = "single" | "loop" | "multisample";

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
