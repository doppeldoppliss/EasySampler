// The instrument (楽器): a stretch of a material set up to be played by notes
// (design.md 4), and the export settings (design.md 5): which note the file
// is tuned to and how long it is. Every setting here is a parameter —
// nothing is rendered until the file is written — so any of it can be
// changed at any time. Times are seconds within the material.

/** How the sustain fills the note: a random walk over steady periods, a loop, a wavetable of a few periods,
 * the whole region slowed to fit ("stretch": its natural change kept, VocalShifter-style), or not at all. */
import type { ScaleId } from "./scale";

export type SustainMode = "pool" | "loop" | "wavetable" | "stretch" | "none";
export type TailLimit = "none" | "beat" | "bar" | "unlimited";
export type PitchMode = "preserve-length" | "resample";
export type PresetId = "synth" | "short" | "transpose" | "decay";

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
   * What the pitch is flattened toward: the one root (one note out of the clip),
   * or the nearest note of a scale, frame by frame (a clip with several notes
   * keeps them; with flatten = 1 and no wobble it is VocalShifter's ケロケロ).
   */
  tune: {
    mode: "flatten" | "scale";
    scale: ScaleId;
    key: number;
    /**
     * How fast the pitch is pulled toward its target, as a time constant in seconds
     * (Auto-Tune's Retune Speed): 0 = at once (ケロケロ), ~0.03 = natural, long = only slow drift goes.
     */
    retuneSec: number;
  };
  /**
   * Unvoiced grains (no pitch: consonants, breath, noise) are normally laid down
   * as recorded whatever the note. On, they are read faster / slower with the
   * shift — no pitch (there is none), but their colour follows the note, as in
   * old-style speed-change 音MAD — while the length stays the same.
   */
  unvoicedFollow: boolean;
  /**
   * 録音した高さで鳴らす: every key plays the cut at its own pitch (no shift by the
   * key; a drum or a sound effect played from anywhere on the keyboard). Not a
   * preset's choice: it stays as set when the preset changes.
   */
  fixedPitch: boolean;
  /**
   * How much the sustain's grains are evened out in level (0 = each period as loud as it was
   * recorded, so a decaying vowel makes the random walk wander in level; 1 = every period scaled
   * to the sustain's median loudness, boost capped at ×4). The head and the tail keep their own.
   */
  levelEven: number;
  /** Formant shift in semitones (0 = keep the voice's character). */
  formantSemitones: number;
  /** How much the formants follow the shift beyond ±7 semitones: 0 = keep the voice's character, 1 = chipmunk / giant. */
  formantFollow: number;
  /** The unvoiced part's level (consonants, breath, noise), in dB; −60 = gone (Melodyne's sibilant balance). */
  unvoicedGainDb: number;
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
    /** How long the vibrato takes to reach full depth after its delay. */
    vibratoAttackSec: number;
    /** After the note is let go, the vibrato fades out over this long (0 = it keeps going). */
    vibratoReleaseSec: number;
    /** Where in its cycle the vibrato starts (0–1). */
    vibratoPhase: number;
    /** Amplitude vibrato (tremolo) at the vibrato's rate, 0–1 of the level. */
    tremoloDepth: number;
    /** The material's own pitch wobble is averaged over this long before use (0 = as detected): VocalShifter's 平滑化. */
    smoothSec: number;
    /**
     * How much of the material's own slow wander (drift, below ~5 Hz) and fast movement (vibrato,
     * modulation) is kept, −1 … 1 (negative inverts): Melodyne's Pitch Drift and Pitch Modulation tools.
     * 平坦化 scales what is left of both.
     */
    keepDrift: number;
    keepModulation: number;
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
  tune: { mode: "flatten", scale: "chromatic", key: 0, retuneSec: 0 },
  unvoicedFollow: false,
  fixedPitch: false,
  levelEven: 1,
  formantSemitones: 0,
  formantFollow: 0.5,
  unvoicedGainDb: 0,
  sustainEnabled: true,
  sustainMode: "pool",
  wavetableCycles: 1,
  stretch: { head: 1, sustain: 1, tail: 1 },
  tail: { enabled: true, limit: "unlimited" },
  wobble: { vibratoCents: 0, vibratoHz: 5.5, vibratoDelaySec: 0.25, vibratoAttackSec: 0.15, vibratoReleaseSec: 0, vibratoPhase: 0, tremoloDepth: 0, driftCents: 0, micro: true, smoothSec: 0, keepDrift: 1, keepModulation: 1 },
  amp: { attack: 0.005, decay: 0.1, sustain: 1, release: 0.02, velocitySens: 0.5, fadeOut: 0 },
  maxVoices: 24,
};

/**
 * A hit or a noise as a one-shot (drums live in the drum kit now, design.md
 * 13.2; this is for a material with no pitch, and the material list's
 * ワンショット): played through once, read faster or slower with the key,
 * nothing flattened or wobbled.
 */
export function oneShotParams(p: InstrumentParams): InstrumentParams {
  return { ...p, pitchMode: "resample", flatten: 0, sustainMode: "none", wobble: { ...p.wobble, vibratoCents: 0, driftCents: 0, micro: false }, amp: { ...p.amp, attack: 0.001, sustain: 1, release: 0.03 } };
}

export interface Preset {
  id: PresetId;
  label: string;
  apply: (params: InstrumentParams) => InstrumentParams;
}

/** Starting points (design.md 4.5); the root and markers stay as they are. */
export const PRESETS: Preset[] = [
  { id: "synth", label: "シンセ化(平坦)", apply: (p) => ({ ...p, pitchMode: "preserve-length", flatten: 1, wobble: { ...p.wobble, vibratoCents: 0, driftCents: 0, micro: true } }) },
  // Not synth-ified at all: the whole cut plays through once, as recorded, moved up or down to the key pressed
  // (a pitch shift that keeps the length and the voice's colour; nothing is held or evened out).
  { id: "transpose", label: "移調のみ(シンセ化せず全体を上げ下げ)", apply: (p) => ({ ...p, pitchMode: "preserve-length", flatten: 0, sustainMode: "none", sustainEnabled: true, tail: { ...p.tail, enabled: true, limit: "unlimited" }, unvoicedFollow: false, levelEven: 0, wobble: { ...p.wobble, vibratoCents: 0, driftCents: 0, micro: false }, tune: { ...p.tune, mode: "flatten", retuneSec: 0 } }) },
  // Short material (a shout, a word): played through once at the note, nothing stretched — the 音MAD staple.
  { id: "short", label: "短い素材(長さ保持・そのまま音程だけ)", apply: (p) => ({ ...p, pitchMode: "preserve-length", flatten: 0, sustainMode: "none", sustainEnabled: true, tail: { ...p.tail, enabled: true }, unvoicedFollow: true, wobble: { ...p.wobble, vibratoCents: 0, driftCents: 0, micro: true }, tune: { ...p.tune, retuneSec: 0 } }) },
  // A struck, piano-like sound from any material: synthesized (flat, the vowel drawn out) and dying away while held —
  // the level falls toward nothing (decay ~1.2 s, sustain 0) — and stopped quickly when let go, as a damper does.
  { id: "decay", label: "減衰(伸ばしながら消える・ピアノ風)", apply: (p) => ({ ...p, pitchMode: "preserve-length", flatten: 1, sustainEnabled: true, sustainMode: "pool", tail: { ...p.tail, enabled: false }, unvoicedFollow: false, levelEven: 1, wobble: { ...p.wobble, vibratoCents: 0, driftCents: 0, micro: true }, tune: { ...p.tune, mode: "flatten", retuneSec: 0 }, amp: { ...p.amp, attack: 0.002, decay: 1.2, sustain: 0, release: 0.25, fadeOut: 0 } }) },
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
