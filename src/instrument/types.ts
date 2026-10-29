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
export type PresetId = "synth" | "short" | "transpose" | "decay" | "once";
/**
 * 作り方: the first choice for a cut, deciding which settings mean anything (and are shown).
 * hold = drawn out while held (シンセ化); transpose = the recording once, its whole pitch moved up or down
 * as it is (no flattening); oneshot = the recording once, its pitch shaped (平坦化 and the rest).
 * (How the pitch is changed, 長さ保持 or 速度連動, is a 細かい設定 of each.)
 */
export type MakeMode = "hold" | "transpose" | "oneshot";

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
   * 離したら止める: when nothing is held (伸ばさない, or the sustain switched off), letting the key go
   * still ends the note there, over the リリース — instead of the recording playing out. Not a preset's
   * choice either.
   */
  stopOnRelease: boolean;
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
  /**
   * Whether the sustain plays at all; off: the head goes straight on to the tail (or the note ends).
   * Only off when nothing is held (sustainMode "none"): a one-shot's 鳴らす範囲 = 頭部だけ.
   */
  sustainEnabled: boolean;
  sustainMode: SustainMode;
  /** The 伸ばし方 of 伸ばす, kept while the cut is a one-shot so that going back finds it. */
  heldSustainMode: Exclude<SustainMode, "none">;
  /**
   * 移調 (a one-shot only): the pitch is moved as a whole, its contour untouched — the pitch shaping
   * (平坦化, 音程の整え方, リチューン, the kept wobble, 細かい揺れ) is not applied, whatever it is set to.
   */
  transposeOnly: boolean;
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

/** Delay times, in beats (½ = an eighth note, 0.75 = a dotted eighth). */
export type DelayBeats = 0.25 | 0.5 | 0.75 | 1 | 1.5 | 2;

/** The effects, always in this order: shape → dynamics → tone → colour → movement → echoes and room → space → level. */
export interface FxSettings {
  /** Transient shaper: dB on the attack and on what follows it. */
  transient: { on: boolean; attackDb: number; sustainDb: number };
  /** Compressor: above the threshold the level rises by 1/ratio; attack / release (ms); make-up gain. */
  compressor: { on: boolean; thresholdDb: number; ratio: number; attackMs: number; releaseMs: number; makeupDb: number };
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
  /** Delay: time in beats, feedback 0–0.9, the repeats darkened above highCutHz, ping-pong between the sides, dry/wet. */
  delay: { on: boolean; beats: DelayBeats; feedback: number; highCutHz: number; pingPong: boolean; mix: number };
  /** Reverb (a room): size 0–1, damping 0–1 (darker tail), pre-delay (ms), dry/wet. */
  reverb: { on: boolean; size: number; damping: number; preDelayMs: number; mix: number };
  /** Limiter: input gain, ceiling (dBFS), release. */
  limiter: { on: boolean; gainDb: number; ceilingDb: number; releaseMs: number };
}

export const DEFAULT_FX: FxSettings = {
  transient: { on: false, attackDb: 0, sustainDb: 0 },
  compressor: { on: false, thresholdDb: -18, ratio: 4, attackMs: 10, releaseMs: 120, makeupDb: 4 },
  eq: { on: false, lowCutHz: 0, lowDb: 0, lowHz: 150, midDb: 0, midHz: 1500, midQ: 1, highDb: 0, highHz: 6000, highCutHz: 20000 },
  saturation: { on: false, drive: 0.3, mix: 1 },
  air: { on: false, amount: 0.3 },
  filter: { on: false, type: "lowpass", cutoffHz: 2000, resonance: 0.3, lfoOctaves: 2, lfoBeats: 1 },
  crush: { on: false, bits: 8, downsample: 4, mix: 1 },
  chorus: { on: false, rateHz: 0.8, depthMs: 4, mix: 0.4 },
  width: { on: false, side: 1.4, midDb: 0 },
  pan: { on: false, depth: 0.6, beats: 1 },
  delay: { on: false, beats: 0.5, feedback: 0.35, highCutHz: 6000, pingPong: true, mix: 0.25 },
  reverb: { on: false, size: 0.6, damping: 0.5, preDelayMs: 20, mix: 0.25 },
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
  stopOnRelease: false,
  levelEven: 1,
  formantSemitones: 0,
  formantFollow: 0.5,
  unvoicedGainDb: 0,
  sustainEnabled: true,
  sustainMode: "pool",
  heldSustainMode: "pool",
  transposeOnly: false,
  wavetableCycles: 1,
  stretch: { head: 1, sustain: 1, tail: 1 },
  // 語尾 is no more (2026-10-28): a held note ends with the release; a one-shot plays its recording out.
  tail: { enabled: false, limit: "unlimited" },
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

/** The 作り方 a cut's settings amount to. */
export function makeModeOf(p: InstrumentParams): MakeMode {
  if (p.sustainMode !== "none" && p.sustainEnabled) return "hold";
  return p.transposeOnly ? "transpose" : "oneshot";
}

/**
 * Another 作り方, everything else kept: leaving 伸ばす remembers its 伸ばし方, coming back puts it back
 * (between the two one-shots, 鳴らす範囲 goes along).
 */
export function withMakeMode(p: InstrumentParams, mode: MakeMode): InstrumentParams {
  const from = makeModeOf(p);
  if (from === mode) return p;
  if (mode === "hold") return { ...p, sustainEnabled: true, sustainMode: p.heldSustainMode, transposeOnly: false };
  return {
    ...p,
    sustainEnabled: from === "hold" ? true : p.sustainEnabled,
    sustainMode: "none",
    heldSustainMode: p.sustainMode === "none" ? p.heldSustainMode : p.sustainMode,
    transposeOnly: mode === "transpose",
  };
}

export interface Preset {
  id: PresetId;
  /** The 作り方 it belongs to (the first of each is that 作り方's 初期値). */
  mode: MakeMode;
  label: string;
  apply: (params: InstrumentParams) => InstrumentParams;
}

/**
 * What every preset starts from: the sound settings put back to the defaults,
 * so a preset never inherits another's leftovers (伸ばし方, 音量の形…). Kept
 * as the user set them: the note and root, the fade-in and fade-out (入り /
 * 終わりのフェード), velocity sensitivity, the formant, 録音した高さで鳴らす.
 */
function presetBase(p: InstrumentParams): InstrumentParams {
  const d = DEFAULT_PARAMS;
  return {
    ...p,
    pitchMode: "preserve-length",
    flatten: 1,
    tune: { ...p.tune, mode: "flatten", retuneSec: 0 },
    unvoicedFollow: d.unvoicedFollow,
    levelEven: d.levelEven,
    unvoicedGainDb: d.unvoicedGainDb,
    sustainEnabled: true,
    sustainMode: "pool",
    heldSustainMode: "pool",
    transposeOnly: false,
    stretch: { ...d.stretch },
    wobble: { ...d.wobble },
    amp: { ...d.amp, attack: p.amp.attack, fadeOut: p.amp.fadeOut, velocitySens: p.amp.velocitySens },
  };
}

/**
 * Starting points (design.md 4.5), no longer chosen on screen (2026-10-29): the first of each 作り方 is its
 * 初期値に戻す; the others start a new cut (decay: the built-in piano, short: a short material).
 * The root and markers stay as they are.
 */
export const PRESETS: Preset[] = [
  // Synthesis: flat on the note, the vowel drawn out while held.
  { id: "synth", mode: "hold", label: "シンセ化(平坦)", apply: (p) => presetBase(p) },
  // Not synth-ified at all: the whole cut plays through once, as recorded, moved up or down to the key pressed
  // (a pitch shift that keeps the length and the voice's colour; nothing is held or evened out).
  { id: "transpose", mode: "transpose", label: "移調のみ(全体をそのまま上げ下げ)", apply: (p) => ({ ...presetBase(p), flatten: 0, sustainMode: "none", transposeOnly: true, levelEven: 0, wobble: { ...DEFAULT_PARAMS.wobble, micro: false } }) },
  // Short material (a shout, a word): played through once at the note, nothing stretched — the 音MAD staple.
  { id: "short", mode: "transpose", label: "短い素材(子音・息も音程に合わせる)", apply: (p) => ({ ...presetBase(p), flatten: 0, sustainMode: "none", transposeOnly: true, unvoicedFollow: true }) },
  // Flattened on the note like シンセ化, but not drawn out: the recording once.
  { id: "once", mode: "oneshot", label: "平坦にして 1 回(伸ばさない)", apply: (p) => ({ ...presetBase(p), sustainMode: "none" }) },
  // A struck, piano-like sound from any material: synthesized (flat, the vowel drawn out) and dying away while held —
  // the level falls toward nothing (decay ~1.2 s, sustain 0) — and stopped quickly when let go, as a damper does.
  { id: "decay", mode: "hold", label: "減衰(伸ばしながら消える・ピアノ風)", apply: (p) => { const b = presetBase(p); return { ...b, amp: { ...b.amp, decay: 1.2, sustain: 0, release: 0.25 } }; } },
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
