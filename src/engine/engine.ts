// The sound engine: a polyphonic "material synth" (素材シンセ, design.md 4–5).
// Plain TypeScript with no DOM or Web Audio, so the same code runs in the
// AudioWorklet, in a Worker for benchmarks and exports, and in the tests.
//
// Each voice plays the material by TD-PSOLA: grains of one or two glottal
// periods, cut around the pitch marks found when the material was loaded,
// are laid down at the spacing of the target pitch. The material's own
// waveform — its formants, its voice — rides along in every grain; only the
// pulse rate changes. Per grain the target is
//
//   offset = (note − root) + wobble − flatten × (f0 − root)   [semitones]
//   spacing = P × 2^(−offset/12)
//
// with P the material's own local period, so the natural period-to-period
// irregularity survives every setting (flatten = 1 lands each grain on the
// note, but no two periods come out identical).
//
// The material plays in three parts (synthesis markers):
//   head    – from the range start to the sustain, once, at its own speed
//   sustain – held as long as the note is: by default a random walk over a
//             pool of steady periods (no fixed loop to hear), or a loop, or
//             ("stretch") the whole region slowed so it fills the note length
//             the page says the note has — its natural change kept, as a
//             VocalShifter time-stretch would — and the pool from its end on
//   tail    – after the note is released, when enabled: the material's own end
// With the sustain switched off, the head goes straight on to the tail (or
// the note ends there), however long the key is held.
// "Resample" mode uses the same grains with their time and pitch scaled
// together, which is exactly playback at a different speed.
//
// Nothing here allocates while rendering.

import { normalizeRemoved } from "../instrument/layout";
import { quantizeToScale } from "../instrument/scale";
import type { InstrumentParams, Markers } from "../instrument/types";

export interface PreparedSource {
  /** The engine's sample rate (the material was resampled to it). */
  sampleRate: number;
  /** One or two channels. */
  channels: Float32Array[];
  /** Pitch marks (sample positions) and per mark: voiced? and the material's pitch there (MIDI, NaN if unvoiced). */
  marks: Float64Array;
  voiced: Uint8Array;
  f0: Float32Array;
}

const MAX_GRAINS = 16;
const BLOCK = 128;
/** Longest half-grain (seconds): bridges gaps without smearing across them. */
const MAX_HALF_GRAIN_SEC = 0.025;
/** Pool of steady periods for the sustain. */
const MAX_POOL = 48;
const MIN_POOL = 3;
/** Semitones a pitch must be nearer another scale note than the one on before scale mode moves. */
const SCALE_HYSTERESIS = 0.3;
/** Voices beyond the polyphony limit, so a stolen voice can fade instead of clicking. */
const SPARE_VOICES = 4;
const STEAL_FADE_SEC = 0.006;
const END_FADE_SEC = 0.01;
/** A tail cut at its length limit fades out over this long. */
const TAIL_CUT_FADE_SEC = 0.03;
/** 語尾を収める: a tail too long for the time after the head is played up to this much faster (keeping its shape) before any of it is cut. */
const FIT_MAX_TAIL_SPEED = 2;
/** …and what still does not fit fades out over this share of the time it has (between the two bounds). */
const FIT_FADE_SHARE = 0.4;
const FIT_FADE_MIN_SEC = 0.04;
const FIT_FADE_MAX_SEC = 0.25;
/** The tail starts at the level the note had (within these bounds), then follows its own recorded decay. */
const TAIL_MATCH_MIN = 0.25;
const TAIL_MATCH_MAX = 4;
/** How much of the tail's start is averaged for its level (seconds). */
const TAIL_LEVEL_SEC = 0.04;
/** Micro irregularity: period jitter (share) and level shimmer (share). */
const JITTER = 0.004;
const SHIMMER = 0.03;
/** Formants follow this power of the pitch ratio, beyond ±7 semitones. */
const FORMANT_FOLLOW_FROM = 7;
const FORMANT_FOLLOW_POWER = 0.4;

const Phase = {
  Head: 0,
  Sustain: 1,
  Run: 2, // playing straight on to the end (tail, or no sustain)
  Done: 3,
} as const;
type Phase = (typeof Phase)[keyof typeof Phase];

const Env = { Attack: 0, Decay: 1, Sustain: 2, Release: 3, Off: 4 } as const;
type Env = (typeof Env)[keyof typeof Env];

interface Grain {
  active: boolean;
  /** Source position of the grain's centre (samples). */
  mark: number;
  /** Output position of the centre (samples, voice clock). */
  center: number;
  left: number; // half-widths in output samples
  right: number;
  /** Source samples per output sample (formant / resample scaling). */
  alpha: number;
  reverse: boolean;
  gain: number;
}

class Voice {
  active = false;
  note = 60;
  velocityGain = 1;
  released = false;
  startOrder = 0;

  phase: Phase = Phase.Head;
  /** Read position in the source (samples) for head / loop / run. */
  srcTime = 0;
  /** Output clock of this voice (samples since note on). */
  clock = 0;
  nextCenter = 0;
  /** Wavetable sustain: which of the cycled periods comes next. */
  cycleIndex = 0;
  /** Left half-width of the last grain placed: how early the next one may start. */
  lastLeft = 0;
  poolIndex = 0;
  /** Scale mode: the scale note this voice is on (NaN before the first voiced period). */
  scaleNote = Number.NaN;
  previousPoolIndex = -1;
  reverseNext = false;

  env: Env = Env.Off;
  level = 0;
  /** Extra fade (stolen voice / end of material): per-sample decrement of fadeGain. */
  fadeGain = 1;
  fadeStep = 0;
  /** Output samples the tail may still run (its length limit); Infinity when unlimited or not in the tail. */
  tailRemaining = Infinity;
  /** "stretch": the slowed pass through the sustain reached its end; the pool carries on. */
  stretchDone = false;
  /** Voice seconds at which the note was let go (for the vibrato's release). */
  releasedAt = Infinity;
  /** The pitch correction as it has glided in so far (semitones), for tune.retuneSec. */
  retuneCorr = 0;
  /** The last grain's spacing (samples): the time step the glide advances by. */
  lastStep = 0;
  /** Portamento: semitones still to slide (added to the note, moving to 0), and how much it moves per output sample. */
  bend = 0;
  bendPerSample = 0;
  /** 語尾を収める: the voice clock (samples) at which the note lets go by itself so its tail ends with it, and where it must be over. */
  fitReleaseAt = Infinity;
  fitEndAt = Infinity;
  /** 語尾を収める, a note the head alone fills: where it starts fading so it is silent at the note's end. */
  fitFadeAt = Infinity;
  /** 語尾を収める: how much faster this voice reads its tail (1 = as recorded), and the fade at a tail's cut (seconds). */
  tailSpeed = 1;
  cutFadeSec = TAIL_CUT_FADE_SEC;
  /** The level the note has been playing at (a running average over its last periods, before the tail). */
  levelEma = 0;
  /** The tail's gain: what brings its start to that level (1 until the tail is entered). */
  tailGain = 1;

  driftValue = 0;
  driftTarget = 0;
  driftCountdown = 0;

  readonly grains: Grain[] = Array.from({ length: MAX_GRAINS }, () => ({ active: false, mark: 0, center: 0, left: 1, right: 1, alpha: 1, reverse: false, gain: 0 }));
  readonly bufL = new Float32Array(BLOCK);
  readonly bufR = new Float32Array(BLOCK);
}

export class Engine {
  readonly sampleRate: number;
  private source: PreparedSource | null = null;
  private params: InstrumentParams | null = null;
  // Markers and derived tables, in samples.
  private rangeStart = 0;
  private rangeEnd = 0;
  private sustainStart = 0;
  private sustainEnd = 0;
  private tailStart = 0;
  private removedStart = new Float64Array(0);
  private removedEnd = new Float64Array(0);
  private left = new Float32Array(0);
  private right = new Float32Array(0);
  private period = new Float32Array(0);
  /** The material's pitch per mark as the engine uses it: as detected, or averaged over smoothSec (平滑化). */
  private f0: Float32Array = new Float32Array(0);
  /** The slow part of the pitch per mark (a 0.2 s mean): the drift; what is left is the modulation. */
  private f0slow: Float32Array = new Float32Array(0);
  private pool = new Int32Array(0);
  /** RMS of the material around each mark (one grain's worth), and the sustain's median of it. */
  private markRms = new Float32Array(0);
  private sustainLevel = 0;
  private voices: Voice[] = [];
  private order = 0;
  private seed = 0x2545f491;
  /** For the tail's length limit (1 beat / 1 bar). */
  private bpm = 120;
  /** The note length (seconds) the "stretch" sustain fills; the export length. */
  private hold = 1;
  /** Read speed through the sustain in "stretch" mode (1 / the stretch factor). */
  private stretchSpeed = 1;
  /** Portamento (a song track's setting, seconds; 0 = off): a note that starts while another is held slides from it. */
  private glideSec = 0;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.ensureVoices(24);
  }

  setSource(source: PreparedSource | null): void {
    this.allOff(true);
    this.source = source;
    const count = source?.marks.length ?? 0;
    this.left = new Float32Array(count);
    this.right = new Float32Array(count);
    this.period = new Float32Array(count);
    if (source) {
      const cap = MAX_HALF_GRAIN_SEC * source.sampleRate;
      const m = source.marks;
      for (let k = 0; k < count; k++) {
        const toPrevious = k > 0 ? m[k] - m[k - 1] : k + 1 < count ? m[k + 1] - m[k] : cap;
        const toNext = k + 1 < count ? m[k + 1] - m[k] : toPrevious;
        this.left[k] = Math.min(cap, toPrevious);
        this.right[k] = Math.min(cap, toNext);
        this.period[k] = (this.left[k] + this.right[k]) / 2;
      }
      // The level at each mark, for evening out the sustain.
      this.markRms = new Float32Array(count);
      const x = source.channels[0];
      for (let k = 0; k < count; k++) {
        const from = Math.max(0, Math.floor(m[k] - this.left[k]));
        const to = Math.min(x.length, Math.ceil(m[k] + this.right[k]));
        let s = 0;
        for (let i = from; i < to; i++) s += x[i] * x[i];
        this.markRms[k] = to > from ? Math.sqrt(s / (to - from)) : 0;
      }
    } else this.markRms = new Float32Array(0);
    this.rebuildPool();
    this.rebuildF0();
  }

  /** The per-mark pitch, smoothed over wobble.smoothSec when asked (a mean over the voiced marks around each). */
  private rebuildF0(): void {
    const source = this.source;
    if (!source) {
      this.f0 = new Float32Array(0);
      return;
    }
    const n = source.marks.length;
    const raw = Float32Array.from({ length: n }, (_, k) => source.f0[k]);
    this.f0 = raw;
    const window = this.params?.wobble.smoothSec ?? 0;
    if (window > 0) this.f0 = this.meanOverWindow(raw, window);
    this.f0slow = this.meanOverWindow(this.f0, 0.2);
  }

  /** Each voiced mark's pitch replaced by the mean over the voiced marks within ±window/2 around it. */
  private meanOverWindow(raw: Float32Array, window: number): Float32Array {
    const source = this.source!;
    const n = raw.length;
    const half = (window / 2) * source.sampleRate;
    const out = new Float32Array(n);
    let lo = 0;
    for (let k = 0; k < n; k++) {
      out[k] = raw[k];
      if (!source.voiced[k] || !Number.isFinite(raw[k])) continue;
      const at = source.marks[k];
      while (lo < n && source.marks[lo] < at - half) lo++;
      let sum = 0;
      let count = 0;
      for (let j = lo; j < n && source.marks[j] <= at + half; j++) {
        if (source.voiced[j] && Number.isFinite(raw[j])) {
          sum += raw[j];
          count++;
        }
      }
      if (count > 0) out[k] = sum / count;
    }
    return out;
  }

  setInstrument(markers: Markers, params: InstrumentParams): void {
    const sr = this.sampleRate;
    this.rangeStart = markers.rangeStart * sr;
    this.rangeEnd = markers.rangeEnd * sr;
    this.sustainStart = markers.sustainStart * sr;
    this.sustainEnd = markers.sustainEnd * sr;
    this.tailStart = markers.tailStart * sr;
    const removed = normalizeRemoved(markers.removed, markers.rangeStart, markers.rangeEnd);
    this.removedStart = Float64Array.from(removed, (r) => r.start * sr);
    this.removedEnd = Float64Array.from(removed, (r) => r.end * sr);
    const smoothChanged = this.params?.wobble.smoothSec !== params.wobble.smoothSec;
    this.params = params;
    this.ensureVoices(params.maxVoices);
    this.rebuildPool();
    this.refreshStretch();
    if (smoothChanged) this.rebuildF0();
  }

  /** The note length a "stretch" sustain fills (seconds of output). */
  setHold(sec: number): void {
    if (Number.isFinite(sec) && sec > 0) this.hold = sec;
    this.refreshStretch();
  }

  /** The stretch mode's read speed: the sustain's material over what the note leaves after the head. */
  private refreshStretch(): void {
    const params = this.params;
    if (!params) return;
    const sr = this.sampleRate;
    const sustainSrc = this.playedBetween(this.sustainStart, this.sustainEnd) / sr;
    const headSec = (this.playedBetween(this.rangeStart, this.sustainStart) / sr) * Math.max(0.05, params.stretch.head);
    const fill = Math.max(0.05, this.hold - headSec);
    const factor = sustainSrc > 0 ? Math.max(0.25, Math.min(64, fill / sustainSrc)) : 1;
    this.stretchSpeed = 1 / factor;
  }

  /**
   * Portamento: with a time set, the engine plays one note at a time, and a note
   * that starts while the last one is still held slides to its pitch over this
   * long. A cut that holds (a sustain) carries the same voice on, without a new
   * attack (legato); one that plays through once starts again from its top,
   * sliding from where the last note was.
   */
  setGlide(sec: number): void {
    this.glideSec = Number.isFinite(sec) && sec > 0 ? Math.min(2, sec) : 0;
  }

  /** The tempo the tail's length limit is counted in. */
  setTempo(bpm: number): void {
    if (Number.isFinite(bpm) && bpm > 0) this.bpm = bpm;
  }

  /** Whether released notes play the tail ("none" is an old way of saying off). */
  private tailOn(): boolean {
    const tail = this.params!.tail;
    return tail.enabled && tail.limit !== "none";
  }

  /** How long the tail may run, in output samples. */
  private tailLimitSamples(): number {
    const limit = this.params!.tail.limit;
    const beats = limit === "beat" ? 1 : limit === "bar" ? 4 : Infinity;
    return (beats * 60 * this.sampleRate) / this.bpm;
  }

  /** The read position moved past any removed stretch it has landed in. */
  private skipRemoved(position: number): number {
    for (let i = 0; i < this.removedStart.length; i++) {
      if (position >= this.removedStart[i] && position < this.removedEnd[i]) position = this.removedEnd[i];
    }
    return position;
  }

  private isRemoved(position: number): boolean {
    for (let i = 0; i < this.removedStart.length; i++) {
      if (position >= this.removedStart[i] && position < this.removedEnd[i]) return true;
    }
    return false;
  }

  /** How fast the read position moves through the material here: 1 ÷ the part's stretch factor. */
  private speedAt(position: number): number {
    const params = this.params!;
    if (params.sustainMode === "stretch" && position >= this.sustainStart && position < this.sustainEnd) return this.stretchSpeed;
    const s = params.stretch;
    const factor = position < this.sustainStart ? s.head : position < this.sustainEnd ? s.sustain : s.tail;
    return 1 / Math.max(0.05, factor);
  }

  /**
   * A note on. `lengthSec` (a song's note, when its track fits the tail in)
   * is how long the note is written: the voice then lets go early by the
   * tail's length, so the tail ends where the note does. Without it (the
   * keyboard, a preview) the tail starts when the key is let go.
   */
  noteOn(note: number, velocity = 0.8, lengthSec?: number): void {
    if (!this.source || !this.params) return;
    const params = this.params;
    if (this.glideSec > 0) {
      // The note still held, if any: the new one slides from its pitch (as it is just now, mid-slide or not).
      let held: Voice | null = null;
      for (const v of this.voices) if (v.active && !v.released && v.fadeStep === 0 && v.phase !== Phase.Done && (!held || v.startOrder > held.startOrder)) held = v;
      if (held) {
        const from = held.note + held.bend;
        const holds = params.sustainEnabled && params.sustainMode !== "none" && (held.phase === Phase.Head || held.phase === Phase.Sustain);
        if (holds) {
          held.note = note;
          this.glide(held, from - note);
          this.fitTail(held, lengthSec);
          return;
        }
        this.fadeOut(held, STEAL_FADE_SEC);
        const voice = this.voices.find((v) => !v.active) ?? this.voices.reduce((a, b) => (b.startOrder < a.startOrder ? b : a));
        this.start(voice, note, velocity);
        this.glide(voice, from - note);
        this.fitTail(voice, lengthSec);
        return;
      }
    }
    // Over the polyphony limit: the oldest sounding voice fades out quickly.
    const sounding = this.voices.filter((v) => v.active && v.fadeStep === 0);
    if (sounding.length >= params.maxVoices) {
      const oldest = sounding.reduce((a, b) => (b.startOrder < a.startOrder ? b : a));
      this.fadeOut(oldest, STEAL_FADE_SEC);
    }
    const voice = this.voices.find((v) => !v.active) ?? this.voices.reduce((a, b) => (b.startOrder < a.startOrder ? b : a));
    this.start(voice, note, velocity);
    this.fitTail(voice, lengthSec);
  }

  /**
   * 語尾を収める: when the note's length is known, the tail is brought
   * forward so it ends with the note. The head is never cut short to make
   * room (a jump from the middle of the head into the tail is what sounds
   * forced): the tail starts once the head is over, its own length before the
   * note's end. If the time left after the head is too short, the tail is
   * read faster (up to FIT_MAX_TAIL_SPEED, keeping the shape of its decay) and
   * whatever still does not fit fades out gently. A note the head alone fills
   * plays no tail: the head fades out to silence at the note's end.
   */
  private fitTail(v: Voice, lengthSec: number | undefined): void {
    v.fitReleaseAt = Infinity;
    v.fitEndAt = Infinity;
    v.fitFadeAt = Infinity;
    v.tailSpeed = 1;
    v.cutFadeSec = TAIL_CUT_FADE_SEC;
    const params = this.params!;
    if (lengthSec === undefined || !(lengthSec > 0) || !params.sustainEnabled || params.sustainMode === "none" || !this.tailOn()) return;
    const sr = this.sampleRate;
    const length = lengthSec * sr;
    const tail = this.tailOutputSamples(v.note);
    const headLeft = v.phase === Phase.Head ? this.headOutputSamples(v) : 0;
    const gentle = (room: number) => Math.max(FIT_FADE_MIN_SEC, Math.min(FIT_FADE_MAX_SEC, (FIT_FADE_SHARE * room) / sr));
    v.fitEndAt = v.clock + length;
    const room = length - headLeft;
    if (room >= tail) {
      // It fits as recorded: the tail starts its own length before the note's end.
      v.fitReleaseAt = v.clock + length - tail;
      return;
    }
    if (room < FIT_FADE_MIN_SEC * sr * 2) {
      // The head fills the note: no tail, the head fades out by the note's end.
      v.cutFadeSec = gentle(length);
      v.fitFadeAt = v.clock + Math.max(0, length - v.cutFadeSec * sr);
      return;
    }
    // Right after the head, read faster; only what still does not fit fades out.
    v.fitReleaseAt = v.clock + headLeft;
    v.tailSpeed = Math.min(FIT_MAX_TAIL_SPEED, tail / room);
    if (tail / v.tailSpeed > room + 1) v.cutFadeSec = gentle(room);
  }

  /** Output samples the head still plays from where the voice is. */
  private headOutputSamples(v: Voice): number {
    const params = this.params!;
    let out = this.playedBetween(v.srcTime, this.sustainStart) * Math.max(0.05, params.stretch.head);
    if (params.pitchMode === "resample") out /= 2 ** ((v.note - params.root) / 12);
    return out;
  }

  /** How long the tail plays (output samples) for a note: its material at the tail's speed, within its length limit. */
  private tailOutputSamples(note: number): number {
    const params = this.params!;
    let out = this.playedBetween(Math.max(this.tailStart, this.sustainStart), this.rangeEnd) * Math.max(0.05, params.stretch.tail);
    if (params.pitchMode === "resample") out /= 2 ** ((note - params.root) / 12);
    return Math.min(out, this.tailLimitSamples());
  }

  private glide(v: Voice, semitones: number): void {
    v.bend = semitones;
    v.bendPerSample = Math.abs(semitones) / Math.max(1, this.glideSec * this.sampleRate);
  }

  noteOff(note: number): void {
    for (const v of this.voices) {
      if (v.active && !v.released && v.note === note) this.release(v);
    }
  }

  allOff(immediately = false): void {
    for (const v of this.voices) {
      if (!v.active) continue;
      if (immediately) v.active = false;
      else this.fadeOut(v, STEAL_FADE_SEC);
    }
  }

  activeVoices(): number {
    let n = 0;
    for (const v of this.voices) if (v.active) n++;
    return n;
  }

  /** Renders `frames` (≤ 128) samples, overwriting the outputs. */
  render(outL: Float32Array, outR: Float32Array, frames = outL.length): void {
    outL.fill(0, 0, frames);
    outR.fill(0, 0, frames);
    if (!this.source || !this.params) return;
    for (const v of this.voices) {
      if (!v.active) continue;
      // 語尾を収める: the note lets go by itself, straight into the tail, which must be over by the note's end.
      if (!v.released && v.clock + frames > v.fitReleaseAt) {
        this.release(v);
        if (v.phase === Phase.Head || v.phase === Phase.Sustain) this.jumpToTail(v);
        v.tailRemaining = Math.min(v.tailRemaining, Math.max(1, v.fitEndAt - v.clock - v.cutFadeSec * this.sampleRate));
      }
      if (v.fadeStep === 0 && v.clock + frames > v.fitFadeAt) this.fadeOut(v, v.cutFadeSec);
      this.renderVoice(v, frames);
      if (v.tailRemaining !== Infinity) {
        v.tailRemaining -= frames;
        if (v.tailRemaining <= 0 && v.fadeStep === 0) this.fadeOut(v, v.cutFadeSec);
      }
      for (let i = 0; i < frames; i++) {
        outL[i] += v.bufL[i];
        outR[i] += v.bufR[i];
      }
    }
  }

  // ------------------------------------------------------------- voices

  private ensureVoices(maxVoices: number): void {
    while (this.voices.length < maxVoices + SPARE_VOICES) this.voices.push(new Voice());
  }

  private random(): number {
    // xorshift32 → [0, 1)
    let x = this.seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x >>> 0;
    return this.seed / 4294967296;
  }

  /** The steady voiced periods of the sustain region, centred if there are too many. */
  private rebuildPool(): void {
    const source = this.source;
    if (!source) {
      this.pool = new Int32Array(0);
      return;
    }
    const inside: number[] = [];
    for (let k = 0; k < source.marks.length; k++) {
      const at = source.marks[k];
      if (at >= this.sustainStart && at < this.sustainEnd && source.voiced[k] && !this.isRemoved(at)) inside.push(k);
    }
    const skip = Math.max(0, Math.floor((inside.length - MAX_POOL) / 2));
    this.pool = Int32Array.from(inside.slice(skip, skip + MAX_POOL));
    // The sustain's typical loudness: the median over its voiced marks.
    const levels = inside.map((k) => this.markRms[k]).filter((v) => v > 0).sort((a, b) => a - b);
    this.sustainLevel = levels.length ? levels[levels.length >> 1] : 0;
  }

  private start(v: Voice, note: number, velocity: number): void {
    const params = this.params!;
    v.active = true;
    v.note = note;
    v.velocityGain = 1 - params.amp.velocitySens + params.amp.velocitySens * Math.max(0, Math.min(1, velocity));
    v.released = false;
    v.releasedAt = Infinity;
    v.retuneCorr = 0;
    v.lastStep = 0;
    v.bend = 0;
    v.bendPerSample = 0;
    v.fitReleaseAt = Infinity;
    v.fitEndAt = Infinity;
    v.fitFadeAt = Infinity;
    v.tailSpeed = 1;
    v.cutFadeSec = TAIL_CUT_FADE_SEC;
    v.startOrder = this.order++;
    v.levelEma = 0;
    v.tailGain = 1;
    v.phase = Phase.Head;
    v.cycleIndex = 0;
    v.srcTime = this.skipRemoved(this.rangeStart);
    v.clock = 0;
    v.poolIndex = Math.floor(this.pool.length / 2);
    v.previousPoolIndex = -1;
    v.scaleNote = Number.NaN;
    v.reverseNext = false;
    v.env = Env.Attack;
    v.level = 0;
    v.fadeGain = 1;
    v.fadeStep = 0;
    v.tailRemaining = Infinity;
    v.stretchDone = false;
    v.driftValue = 0;
    v.driftTarget = 0;
    v.driftCountdown = 0;
    for (const g of v.grains) g.active = false;
    v.nextCenter = 0;
    this.enterPhaseIfDue(v);
    // The first grain starts at the very beginning of the output.
    const k = this.nearestMark(v.srcTime);
    v.nextCenter = this.left[k] ?? 0;
    v.lastLeft = v.nextCenter;
  }

  private release(v: Voice): void {
    v.released = true;
    v.releasedAt = v.clock / this.sampleRate;
    const params = this.params!;
    // Sustain off: the head (and the tail) play out whatever the key does.
    if (!params.sustainEnabled) return;
    if (this.tailOn() && params.sustainMode !== "none") {
      // The tail plays the material's own end at full level; the envelope holds.
      if (v.phase === Phase.Sustain) this.jumpToTail(v);
    } else if (!this.tailOn()) {
      v.env = Env.Release;
    }
  }

  private fadeOut(v: Voice, seconds: number): void {
    const step = 1 / Math.max(1, seconds * this.sampleRate);
    v.fadeStep = Math.max(v.fadeStep, step);
  }

  private jumpToTail(v: Voice): void {
    v.phase = Phase.Run;
    v.srcTime = this.skipRemoved(Math.max(this.tailStart, this.sustainStart));
    v.tailRemaining = this.tailLimitSamples();
    // The tail goes on from the level the note was at (a held, evened-out sustain is often louder or quieter
    // than where the recording's tail begins): no step at the join, and the recorded decay from there.
    const at = this.tailLevelAt(v.srcTime);
    v.tailGain = v.levelEma > 1e-5 && at > 1e-5 ? Math.max(TAIL_MATCH_MIN, Math.min(TAIL_MATCH_MAX, v.levelEma / at)) : 1;
  }

  /** The material's level over the first moments from a position (the mean RMS of its marks there). */
  private tailLevelAt(position: number): number {
    const source = this.source!;
    const end = position + TAIL_LEVEL_SEC * source.sampleRate;
    let sum = 0;
    let n = 0;
    for (let k = this.nearestMark(position); k < source.marks.length && source.marks[k] < end; k++) {
      if (source.marks[k] < position) continue;
      sum += this.markRms[k];
      n++;
    }
    return n ? sum / n : 0;
  }

  /** Moves the voice from head to sustain / run once its read position gets there. */
  private enterPhaseIfDue(v: Voice): void {
    if (v.phase !== Phase.Head || v.srcTime < this.sustainStart) return;
    const params = this.params!;
    if (!params.sustainEnabled) {
      if (this.tailOn()) this.jumpToTail(v);
      else v.phase = Phase.Done;
    } else if (params.sustainMode === "none") {
      v.phase = Phase.Run;
    } else if (v.released && this.tailOn()) {
      this.jumpToTail(v);
    } else {
      v.phase = Phase.Sustain;
      if (params.sustainMode === "loop" || params.sustainMode === "stretch" || this.pool.length < MIN_POOL) v.srcTime = Math.max(v.srcTime, this.sustainStart);
    }
  }

  private nearestMark(position: number): number {
    const marks = this.source!.marks;
    let lo = 0;
    let hi = marks.length - 1;
    if (hi < 0) return 0;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (marks[mid] < position) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && position - marks[lo - 1] < marks[lo] - position) lo--;
    return lo;
  }

  /** The next period from the sustain pool: a step to either side, mostly one period (a jump over
   *  several periods of a moving voice reads as jitter), never straight back. */
  private nextPoolMark(v: Voice): number {
    const n = this.pool.length;
    let next = v.poolIndex;
    for (let tries = 0; tries < 6; tries++) {
      const stepSize = this.random() < 0.75 ? 1 : 2;
      const candidate = v.poolIndex + (this.random() < 0.5 ? -stepSize : stepSize);
      if (candidate < 0 || candidate >= n || candidate === v.previousPoolIndex) continue;
      next = candidate;
      break;
    }
    if (next === v.poolIndex) next = Math.min(n - 1, Math.max(0, v.poolIndex + (v.poolIndex + 1 < n ? 1 : -1)));
    v.previousPoolIndex = v.poolIndex;
    v.poolIndex = next;
    return this.pool[next];
  }

  /** Wavetable sustain: the same one (or few consecutive) steady periods from the middle of the pool, over and over. */
  private nextCycleMark(v: Voice): number {
    const n = this.pool.length;
    const cycles = Math.max(1, Math.min(n, Math.round(this.params!.wavetableCycles)));
    const first = Math.max(0, Math.min(n - cycles, Math.floor(n / 2) - Math.floor(cycles / 2)));
    const k = this.pool[first + (v.cycleIndex % cycles)];
    v.cycleIndex++;
    return k;
  }

  /** Whether the sustain is drawn from the pool of periods (rather than read through). */
  /** Whether this voice's sustain comes from the pool (the random walk / wavetable), rather than a read through the region. */
  private fromPool(v: Voice): boolean {
    const mode = this.params!.sustainMode;
    return (mode === "pool" || mode === "wavetable" || (mode === "stretch" && v.stretchDone)) && this.pool.length >= MIN_POOL;
  }

  /** Wobble (semitones) at a voice time: vibrato fading in after its delay, plus the slow drift. */
  private wobbleAt(v: Voice, seconds: number): number {
    const w = this.params!.wobble;
    let cents = 0;
    if (w.vibratoCents > 0) {
      cents += w.vibratoCents * this.vibratoEnvelope(v, seconds) * Math.sin(2 * Math.PI * (w.vibratoHz * seconds + w.vibratoPhase));
    }
    if (w.driftCents > 0) {
      if (v.driftCountdown <= 0) {
        v.driftTarget = (this.random() * 2 - 1) * w.driftCents;
        v.driftCountdown = 0.4 + this.random() * 0.8; // a new aim every 0.4–1.2 s
      }
      v.driftValue += (v.driftTarget - v.driftValue) * 0.02;
    }
    return (cents + v.driftValue) / 100;
  }

  /** 0–1: the vibrato (and tremolo) coming in after its delay over its attack, and going out after the release. */
  private vibratoEnvelope(v: Voice, seconds: number): number {
    const w = this.params!.wobble;
    let env = Math.max(0, Math.min(1, (seconds - w.vibratoDelaySec) / Math.max(0.001, w.vibratoAttackSec)));
    if (w.vibratoReleaseSec > 0 && seconds > v.releasedAt) env *= Math.max(0, 1 - (seconds - v.releasedAt) / w.vibratoReleaseSec);
    return env;
  }

  /** Places the voice's next grain; false when the material has run out. */
  private scheduleGrain(v: Voice): boolean {
    const source = this.source!;
    const params = this.params!;
    const resample = params.pitchMode === "resample";
    this.enterPhaseIfDue(v);
    // The head ended with nothing after it (sustain off, tail off).
    if (v.phase === Phase.Done) return false;

    // "stretch": the slowed pass reached the end of the region with the note still held — the pool takes over from there.
    if (v.phase === Phase.Sustain && params.sustainMode === "stretch" && !v.stretchDone && v.srcTime >= this.sustainEnd && this.pool.length >= MIN_POOL) {
      v.stretchDone = true;
      v.poolIndex = this.pool.length - 1;
      v.previousPoolIndex = -1;
    }
    let k: number;
    if (v.phase === Phase.Sustain && this.fromPool(v)) {
      k = params.sustainMode === "wavetable" ? this.nextCycleMark(v) : this.nextPoolMark(v);
    } else {
      if (v.phase === Phase.Sustain && v.srcTime >= this.sustainEnd) {
        v.srcTime = this.skipRemoved(v.srcTime - Math.max(1, this.sustainEnd - this.sustainStart)); // loop
      }
      if ((v.phase === Phase.Run || v.phase === Phase.Head) && v.srcTime >= this.rangeEnd) {
        v.phase = Phase.Done;
        return false;
      }
      k = this.nearestMark(v.srcTime);
      // A nearest mark just inside a removed stretch would play a sliver of what was cut: take the next one.
      if (this.removedStart.length && this.isRemoved(source.marks[k]) && k + 1 < source.marks.length) k++;
    }

    const seconds = v.nextCenter / this.sampleRate;
    const shift = v.note + v.bend - params.root;
    const wobble = this.wobbleAt(v, seconds);
    const period = this.period[k];
    const voiced = source.voiced[k] === 1;
    let spacing: number;
    let alpha: number;
    let gain = 1;
    let reverse = false;

    if (resample) {
      alpha = 2 ** ((shift + wobble) / 12);
      spacing = period / alpha;
    } else if (voiced) {
      const f0 = this.f0[k];
      let correction = 0;
      if (Number.isFinite(f0)) {
        // The target in the material's own pitch space: the root, or the nearest scale note of the pitch as played.
        let target = params.root;
        if (params.tune.mode === "scale") {
          const played = f0 + shift;
          let note = quantizeToScale(played, params.tune.scale, params.tune.key);
          // The note already on stays until the pitch is clearly nearer another: no flicker halfway between two.
          if (Number.isFinite(v.scaleNote) && note !== v.scaleNote && Math.abs(played - v.scaleNote) < Math.abs(played - note) + SCALE_HYSTERESIS) note = v.scaleNote;
          v.scaleNote = note;
          target = note - shift;
        }
        // What is kept of the material's movement: the slow drift and the fast modulation, each by its own amount; 平坦化 scales both.
        const slow = Number.isFinite(this.f0slow[k]) ? this.f0slow[k] : f0;
        const kept = params.wobble.keepDrift * (slow - target) + params.wobble.keepModulation * (f0 - slow);
        correction = target + (1 - params.flatten) * kept - f0;
      }
      // The correction glides in over the retune time (Auto-Tune's Retune Speed); 0 = at once.
      const tau = params.tune.retuneSec;
      if (tau > 0) {
        const a = 1 - Math.exp(-(v.lastStep / this.sampleRate) / tau);
        v.retuneCorr += (correction - v.retuneCorr) * a;
        correction = v.retuneCorr;
      } else v.retuneCorr = correction;
      const offset = shift + wobble + correction;
      // The output period comes from the pitch itself where it is known, not from the mark spacing:
      // the two disagree by some cents per period on a real voice, and the pool's jumps between
      // periods would turn that into jitter. Without a pitch, the mark spacing stands in for it.
      spacing = Number.isFinite(f0) ? this.sampleRate / (440 * 2 ** ((f0 + offset - 69) / 12)) : period * 2 ** (-offset / 12);
      alpha = this.formantAlpha(shift);
      gain = Math.sqrt((spacing * alpha) / period);
      if (params.wobble.micro) {
        spacing *= 1 + (this.random() * 2 - 1) * JITTER;
        gain *= 1 + (this.random() * 2 - 1) * SHIMMER;
      }
    } else {
      // No pitch here. Optionally the grains are read at the shift's rate (and laid down as densely),
      // so the noise's colour follows the note while the length stays: a 音MAD-style "s" that goes up.
      alpha = params.unvoicedFollow ? 2 ** (shift / 12) : 1;
      spacing = period / alpha;
      gain = params.unvoicedGainDb <= -60 ? 0 : 10 ** (params.unvoicedGainDb / 20);
      // Repeated noise grains sound metallic (and read as a pitch); alternating their direction hides it.
      // That happens in the sustain, and wherever a slowed-down part reuses its grains.
      if (v.phase === Phase.Sustain || this.speedAt(v.srcTime) < 1) {
        reverse = v.reverseNext;
        v.reverseNext = !v.reverseNext;
      }
    }

    // Evening out the sustain: a quiet period is brought up toward the sustain's median (capped), a loud one down.
    let even = 1;
    if (v.phase === Phase.Sustain && params.levelEven > 0 && this.sustainLevel > 0) {
      const local = this.markRms[k];
      if (local > 1e-5) even = Math.min(4, this.sustainLevel / local) ** params.levelEven;
    }
    gain *= even;
    // The level the note is at, for the tail to go on from; in the tail, its matching gain.
    if (v.phase === Phase.Head || v.phase === Phase.Sustain) {
      const level = this.markRms[k] * even;
      v.levelEma = v.levelEma > 0 ? 0.8 * v.levelEma + 0.2 * level : level;
    } else if (v.released && v.srcTime >= this.tailStart) gain *= v.tailGain;

    const grain = freeGrain(v.grains);
    grain.active = true;
    grain.mark = source.marks[k];
    grain.center = v.nextCenter;
    grain.left = this.left[k] / alpha;
    grain.right = this.right[k] / alpha;
    grain.alpha = alpha;
    grain.reverse = reverse;
    grain.gain = gain;

    const step = Math.max(1, spacing);
    v.nextCenter += step;
    v.lastStep = step;
    if (v.bend !== 0) {
      const left = Math.abs(v.bend) - step * v.bendPerSample;
      v.bend = left > 0 ? Math.sign(v.bend) * left : 0;
    }
    v.lastLeft = grain.left;
    v.driftCountdown -= step / this.sampleRate;
    // The read position moves with real time (or faster/slower when resampling), at the part's own speed, past anything cut out.
    if (!(v.phase === Phase.Sustain && this.fromPool(v))) {
      // (語尾を収める: a voice that lets go early may read its tail faster.)
      const tailSpeed = v.phase === Phase.Run && v.released && v.srcTime >= this.tailStart ? v.tailSpeed : 1;
      v.srcTime = this.skipRemoved(v.srcTime + step * (resample ? alpha : 1) * this.speedAt(v.srcTime) * tailSpeed);
    }
    return true;
  }

  /** Source samples in [from, to) that play (the removed stretches taken out). */
  private playedBetween(from: number, to: number): number {
    if (to <= from) return 0;
    let n = to - from;
    for (let i = 0; i < this.removedStart.length; i++) {
      const a = Math.max(from, this.removedStart[i]);
      const b = Math.min(to, this.removedEnd[i]);
      if (b > a) n -= b - a;
    }
    return n;
  }

  /**
   * Output samples left until the voice runs out of material, or Infinity
   * while it may go on (an elastic sustain still held). What is left is
   * walked part by part at each part's own speed; in resample mode the
   * pitch shift speeds it all up or slows it down.
   */
  private playoutRemaining(v: Voice): number {
    const params = this.params!;
    const s = params.stretch;
    const tailFrom = Math.max(this.tailStart, this.sustainStart);
    const tail = () => this.playedBetween(Math.max(v.srcTime, tailFrom), this.rangeEnd) * Math.max(0.05, s.tail);
    let out: number;
    if (v.phase === Phase.Head) {
      const head = this.playedBetween(v.srcTime, this.sustainStart) * Math.max(0.05, s.head);
      if (!params.sustainEnabled) out = head + (this.tailOn() ? tail() : 0);
      else if (params.sustainMode === "none") out = head + this.playedBetween(this.sustainStart, this.sustainEnd) * Math.max(0.05, s.sustain) + tail();
      else if (v.released && this.tailOn()) out = head + tail();
      else return Infinity;
    } else if (v.phase === Phase.Run) {
      out = this.playedBetween(v.srcTime, this.sustainEnd) * Math.max(0.05, s.sustain) + tail();
    } else if (v.phase === Phase.Done) {
      out = 0;
    } else {
      return Infinity;
    }
    if (params.pitchMode === "resample") out /= 2 ** ((v.note + v.bend - params.root) / 12);
    // The tail's length limit ends it sooner.
    return Math.min(out, v.tailRemaining);
  }

  private formantAlpha(shift: number): number {
    const params = this.params!;
    let semitones = params.formantSemitones;
    if (params.formantFollow > 0 && Math.abs(shift) > FORMANT_FOLLOW_FROM) {
      semitones += Math.sign(shift) * (Math.abs(shift) - FORMANT_FOLLOW_FROM) * FORMANT_FOLLOW_POWER * 2 * params.formantFollow;
    }
    return 2 ** (semitones / 12);
  }

  private renderVoice(v: Voice, frames: number): void {
    const source = this.source!;
    const params = this.params!;
    const bufL = v.bufL;
    const bufR = v.bufR;
    bufL.fill(0, 0, frames);
    bufR.fill(0, 0, frames);
    const blockStart = v.clock;
    const blockEnd = v.clock + frames;

    // Schedule every grain that starts before the end of this block (the next
    // grain's width is not known yet: the last one's, doubled, is a safe guess).
    while (v.phase !== Phase.Done && v.nextCenter - 2 * v.lastLeft < blockEnd) {
      if (!this.scheduleGrain(v)) break;
    }

    const left = source.channels[0];
    const right = source.channels[1] ?? left;
    let anyGrain = false;
    for (const g of v.grains) {
      if (!g.active) continue;
      const from = Math.max(blockStart, Math.ceil(g.center - g.left));
      const to = Math.min(blockEnd, Math.floor(g.center + g.right) + 1);
      for (let t = from; t < to; t++) {
        const d = t - g.center;
        const w = d < 0 ? 0.5 + 0.5 * Math.cos((Math.PI * d) / g.left) : 0.5 + 0.5 * Math.cos((Math.PI * d) / g.right);
        const position = g.mark + (g.reverse ? -d : d) * g.alpha;
        const i = t - blockStart;
        const amount = w * g.gain;
        bufL[i] += amount * cubic(left, position);
        if (right !== left) bufR[i] += amount * cubic(right, position);
      }
      if (g.center + g.right < blockEnd) g.active = false;
      else anyGrain = true;
    }
    if (right === left) bufR.set(bufL.subarray(0, frames));

    // Envelope, velocity, fades.
    const sr = this.sampleRate;
    const amp = params.amp;
    const attackStep = 1 / Math.max(1, amp.attack * sr);
    const decayCoef = Math.exp(-1 / Math.max(1, amp.decay * sr));
    // Letting go without a tail fades over the release, or the 終わりのフェード when that is longer.
    const releaseStep = 1 / Math.max(1, Math.max(amp.release, amp.fadeOut) * sr);
    // 終わりのフェード: over the last `fadeOut` seconds before the material runs out (when that is known).
    const fadeOutSamples = amp.fadeOut * sr;
    const remaining = fadeOutSamples > 0 ? this.playoutRemaining(v) : Infinity;
    const w = params.wobble;
    const tremolo = w.tremoloDepth;
    for (let i = 0; i < frames; i++) {
      switch (v.env) {
        case Env.Attack:
          v.level += attackStep;
          if (v.level >= 1) {
            v.level = 1;
            v.env = Env.Decay;
          }
          break;
        case Env.Decay:
          v.level = amp.sustain + (v.level - amp.sustain) * decayCoef;
          if (Math.abs(v.level - amp.sustain) < 1e-4) v.env = Env.Sustain;
          break;
        case Env.Release:
          v.level -= releaseStep;
          if (v.level <= 0) {
            v.level = 0;
            v.env = Env.Off;
          }
          break;
        default:
          break;
      }
      if (v.fadeStep > 0) v.fadeGain = Math.max(0, v.fadeGain - v.fadeStep);
      let gain = v.level * v.fadeGain * v.velocityGain;
      if (remaining !== Infinity) gain *= Math.max(0, Math.min(1, (remaining - i) / fadeOutSamples));
      if (tremolo > 0) {
        // Amplitude vibrato at the vibrato's rate and envelope (VocalShifter's DYN ビブラート).
        const t = (blockStart + i) / sr;
        gain *= 1 - tremolo * this.vibratoEnvelope(v, t) * 0.5 * (1 - Math.sin(2 * Math.PI * (w.vibratoHz * t + w.vibratoPhase)));
      }
      bufL[i] *= gain;
      bufR[i] *= gain;
    }

    v.clock = blockEnd;
    // Out of material: fade the last grains briefly (they've all been placed).
    if (v.phase === Phase.Done && v.fadeStep === 0) this.fadeOut(v, END_FADE_SEC);
    if (v.env === Env.Off || v.fadeGain <= 0 || (v.phase === Phase.Done && !anyGrain)) v.active = false;
  }
}

/** A grain slot that is free, or else the one that started earliest. */
function freeGrain(grains: Grain[]): Grain {
  let earliest = grains[0];
  for (const g of grains) {
    if (!g.active) return g;
    if (g.center < earliest.center) earliest = g;
  }
  return earliest;
}

/** x at a fractional position, cubic Hermite; zero outside. */
function cubic(x: Float32Array, position: number): number {
  const i = Math.floor(position);
  const f = position - i;
  const at = (k: number) => (k >= 0 && k < x.length ? x[k] : 0);
  const y0 = at(i - 1);
  const y1 = at(i);
  const y2 = at(i + 1);
  const y3 = at(i + 2);
  const c1 = 0.5 * (y2 - y0);
  const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
  const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
  return ((c3 * f + c2) * f + c1) * f + y1;
}
