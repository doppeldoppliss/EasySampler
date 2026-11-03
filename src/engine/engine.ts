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
//             ("stretch") the whole region slowed so it fills the note's
//             length (a song's note; the keyboard's hold length otherwise) —
//             its natural change kept, as a VocalShifter time-stretch would —
//             and the pool from its end on
//   after the sustain – played by a one-shot (no sustain held) on to the
//             material's end, at the sustain's speed
// With the sustain switched off, the note ends with the head, however long
// the key is held.
// "Resample" mode uses the same grains with their time and pitch scaled
// together, which is exactly playback at a different speed.
//
// Nothing here allocates while rendering.

import { normalizeRemoved, playedParts } from "../instrument/layout";
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
/** Voices beyond the polyphony limit, so a stolen voice can fade instead of clicking. */
const SPARE_VOICES = 4;
const STEAL_FADE_SEC = 0.006;
const END_FADE_SEC = 0.01;
/** Micro irregularity: period jitter (share) and level shimmer (share). */
const JITTER = 0.004;
const SHIMMER = 0.03;
/** Formants follow this power of the pitch ratio, beyond ±7 semitones. */
const FORMANT_FOLLOW_FROM = 7;
const FORMANT_FOLLOW_POWER = 0.4;

/** A gap in the pitch this short (seconds) between two voiced stretches, and at least this loud against the voice, is bridged. */
const GAP_MAX_SEC = 0.15;
const GAP_LEVEL = 0.3;

/** How long the sustain's pitch shaping takes to come in as the head ends (持続部だけシンセ化, 伸ばす(移調)'s drift fix), so the head runs on into it smoothly. */
const SHAPE_IN_SEC = 0.15;

const Phase = {
  Head: 0,
  Sustain: 1,
  Run: 2, // a one-shot playing straight on to the end
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
  previousPoolIndex = -1;
  reverseNext = false;

  env: Env = Env.Off;
  level = 0;
  /** Extra fade (stolen voice / end of material): per-sample decrement of fadeGain. */
  fadeGain = 1;
  fadeStep = 0;
  /** "stretch": the slowed pass through the sustain reached its end; the pool carries on. */
  stretchDone = false;
  /** "stretch": the read speed through the sustain for this note's length (1 / the stretch factor). */
  stretchSpeed = 1;
  /** Voice seconds at which the note was let go (for the vibrato's release). */
  releasedAt = Infinity;
  /** The pitch correction as it has glided in so far (semitones), for tune.retuneSec. */
  retuneCorr = 0;
  /** How far the sustain's pitch shaping has come in (0 in the head, up to 1 over SHAPE_IN_SEC after it). */
  shapeIn = 0;
  /** The last grain's spacing (samples): the time step the glide advances by. */
  lastStep = 0;
  /** Portamento: semitones still to slide (added to the note, moving to 0), and how much it moves per output sample. */
  bend = 0;
  bendPerSample = 0;
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
  private removedStart = new Float64Array(0);
  private removedEnd = new Float64Array(0);
  private left = new Float32Array(0);
  private right = new Float32Array(0);
  private period = new Float32Array(0);
  /** The material's pitch per mark as the engine uses it: as detected, or averaged over smoothSec (平滑化). */
  private f0: Float32Array = new Float32Array(0);
  /**
   * A pitch for the marks the analysis found none for inside a short gap between voiced stretches, loud like a
   * vowel (a fast slide, a voice breaking between two pitches): drawn between the pitches either side. NaN elsewhere
   * (silence, a consonant, a long breath). These are moved to the note like their neighbours instead of slipping
   * through at the recorded pitch.
   */
  private gapPitch: Float32Array = new Float32Array(0);
  /** The slow part of the pitch per mark (a 0.2 s mean): the drift; what is left is the modulation. */
  private f0slow: Float32Array = new Float32Array(0);
  private pool = new Int32Array(0);
  /** RMS of the material around each mark (one grain's worth), and the sustain's median of it. */
  private markRms = new Float32Array(0);
  private sustainLevel = 0;
  private voices: Voice[] = [];
  private order = 0;
  private seed = 0x2545f491;
  /** The note length (seconds) a "stretch" sustain fills when the note's own is not known (the keyboard). */
  private hold = 1;
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
    this.gapPitch = this.findGapPitch();
  }

  /** The pitches across short voiced-sounding gaps (gapPitch). */
  private findGapPitch(): Float32Array {
    const source = this.source!;
    const n = source.marks.length;
    const out = new Float32Array(n).fill(Number.NaN);
    const hasPitch = (k: number) => source.voiced[k] === 1 && Number.isFinite(this.f0[k]);
    // How loud the voice is: the median level over the marks with a pitch.
    const levels: number[] = [];
    for (let k = 0; k < n; k++) if (hasPitch(k) && this.markRms[k] > 0) levels.push(this.markRms[k]);
    if (!levels.length) return out;
    levels.sort((a, b) => a - b);
    const loud = GAP_LEVEL * levels[levels.length >> 1];
    const longest = GAP_MAX_SEC * source.sampleRate;
    let k = 0;
    while (k < n) {
      if (hasPitch(k)) {
        k++;
        continue;
      }
      const from = k - 1;
      let to = k;
      while (to < n && !hasPitch(to)) to++;
      if (from >= 0 && to < n && source.marks[to] - source.marks[from] <= longest) {
        const a = this.f0[from];
        const b = this.f0[to];
        const span = source.marks[to] - source.marks[from];
        for (let j = k; j < to; j++) if (this.markRms[j] >= loud) out[j] = a + ((b - a) * (source.marks[j] - source.marks[from])) / span;
      }
      k = to;
    }
    return out;
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
    const removed = normalizeRemoved(markers.removed, markers.rangeStart, markers.rangeEnd);
    this.removedStart = Float64Array.from(removed, (r) => r.start * sr);
    this.removedEnd = Float64Array.from(removed, (r) => r.end * sr);
    const smoothChanged = this.params?.wobble.smoothSec !== params.wobble.smoothSec;
    this.params = params;
    this.ensureVoices(params.maxVoices);
    this.rebuildPool();
    if (smoothChanged) this.rebuildF0();
  }

  /** The note length a "stretch" sustain fills when a note comes without one (the keyboard; seconds of output). */
  setHold(sec: number): void {
    if (Number.isFinite(sec) && sec > 0) this.hold = sec;
  }

  /** The stretch mode's read speed for a note this long: the sustain's material over what the note leaves after the head. */
  private stretchSpeedFor(lengthSec: number): number {
    const params = this.params!;
    const sr = this.sampleRate;
    const sustainSrc = this.playedBetween(this.sustainStart, this.sustainEnd) / sr;
    const headSec = (this.playedBetween(this.rangeStart, this.sustainStart) / sr) * Math.max(0.05, params.stretch.head);
    const fill = Math.max(0.05, lengthSec - headSec);
    const factor = sustainSrc > 0 ? Math.max(0.25, Math.min(64, fill / sustainSrc)) : 1;
    return 1 / factor;
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

  /** Semitones a voice is moved from the recording: its key (and slide) from the root. */
  private shiftOf(note: number, bend = 0): number {
    const params = this.params!;
    return note + bend - params.root;
  }

  /**
   * How fast the read position moves through the material here: the head at 1 ÷ its stretch factor, the rest at
   * the recording's pace (a "stretch" sustain at the note's). 録音の終わりまで plays the whole range at its own pace.
   */
  private speedAt(v: Voice, position: number): number {
    const params = this.params!;
    if (params.sustainMode === "stretch" && position >= this.sustainStart && position < this.sustainEnd) return v.stretchSpeed;
    if (position >= this.sustainStart || playedParts(params).tail) return 1;
    return 1 / Math.max(0.05, params.stretch.head);
  }

  /**
   * A note on. `lengthSec` (a song's note) is how long the note is written:
   * a "stretch" sustain is paced to fill it. Without it (the keyboard, a
   * preview) the hold length stands in.
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
          return;
        }
        this.fadeOut(held, STEAL_FADE_SEC);
        const voice = this.voices.find((v) => !v.active) ?? this.voices.reduce((a, b) => (b.startOrder < a.startOrder ? b : a));
        this.start(voice, note, velocity);
        this.glide(voice, from - note);
        voice.stretchSpeed = this.stretchSpeedFor(lengthSec ?? this.hold);
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
    voice.stretchSpeed = this.stretchSpeedFor(lengthSec !== undefined && lengthSec > 0 ? lengthSec : this.hold);
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
      this.renderVoice(v, frames);
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
    v.shapeIn = 0;
    v.lastStep = 0;
    v.bend = 0;
    v.bendPerSample = 0;
    v.startOrder = this.order++;
    v.phase = Phase.Head;
    v.cycleIndex = 0;
    v.srcTime = this.skipRemoved(this.rangeStart);
    v.clock = 0;
    v.poolIndex = Math.floor(this.pool.length / 2);
    v.previousPoolIndex = -1;
    v.reverseNext = false;
    v.env = Env.Attack;
    v.level = 0;
    v.fadeGain = 1;
    v.fadeStep = 0;
    v.stretchDone = false;
    v.stretchSpeed = 1;
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
    // Sustain off: the head plays out whatever the key does. A one-shot (伸ばさない) plays through the same way.
    // With 離したら止める, it ends where the key is let go instead (over the release).
    if (!params.sustainEnabled || params.sustainMode === "none") {
      if (params.stopOnRelease) v.env = Env.Release;
      return;
    }
    v.env = Env.Release;
  }

  private fadeOut(v: Voice, seconds: number): void {
    const step = 1 / Math.max(1, seconds * this.sampleRate);
    v.fadeStep = Math.max(v.fadeStep, step);
  }

  /** Moves the voice from head to sustain / run once its read position gets there. */
  private enterPhaseIfDue(v: Voice): void {
    if (v.phase !== Phase.Head || v.srcTime < this.sustainStart) return;
    const params = this.params!;
    if (!params.sustainEnabled) {
      v.phase = Phase.Done;
    } else if (params.sustainMode === "none") {
      v.phase = Phase.Run;
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
    // The head ended with nothing after it (the sustain off: 頭部だけ).
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
    const shift = this.shiftOf(v.note, v.bend);
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
      let tau = params.tune.retuneSec;
      const headKept = params.keepHeadContour && params.sustainEnabled && params.sustainMode !== "none";
      // (移調: the contour is left as recorded; only the shift moves it. 伸ばす(移調): past the head, the slow drift
      // is brought onto the root, the vibrato and the fast movement kept. It fades in once, as the head ends, and then
      // follows the read position at once: a loop or the pool jumping back finds its correction there.)
      if (Number.isFinite(f0) && params.transposeOnly) {
        tau = 0;
        const slow = this.f0slow[k];
        if (params.driftFix && params.sustainMode !== "none" && v.phase !== Phase.Head && Number.isFinite(slow)) {
          v.shapeIn = Math.min(1, v.shapeIn + v.lastStep / this.sampleRate / SHAPE_IN_SEC);
          correction = v.shapeIn * (params.root - slow);
        }
      } else if (Number.isFinite(f0)) {
        // The target in the material's own pitch space: the root (the one detected note).
        const target = params.root;
        // What is kept of the material's movement: the slow drift and the fast modulation, each by its own amount; 平坦化 scales both.
        const slow = Number.isFinite(this.f0slow[k]) ? this.f0slow[k] : f0;
        const kept = params.wobble.keepDrift * (slow - target) + params.wobble.keepModulation * (f0 - slow);
        correction = target + (1 - params.flatten) * kept - f0;
        // 持続部だけシンセ化 (伸ばす): the head keeps its contour, the shaping fades in once it ends.
        if (headKept) {
          if (v.phase === Phase.Head) correction = 0;
          else v.shapeIn = Math.min(1, v.shapeIn + v.lastStep / this.sampleRate / SHAPE_IN_SEC);
          correction *= v.shapeIn;
        }
      }
      // The correction glides in over the retune time (Auto-Tune's Retune Speed); 0 = at once.
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
      if (params.wobble.micro && !params.transposeOnly && !(headKept && v.phase === Phase.Head)) {
        spacing *= 1 + (this.random() * 2 - 1) * JITTER;
        gain *= 1 + (this.random() * 2 - 1) * SHIMMER;
      }
    } else {
      const bridged = this.gapPitch[k];
      if (Number.isFinite(bridged)) {
        // A voiced sound the analysis lost the pitch of, between two that have one: moved like them — by the key,
        // and (not 移調, not the head kept as recorded) onto the note — read faster or slower, as the noise is.
        const headKept = params.keepHeadContour && params.sustainEnabled && params.sustainMode !== "none" && v.phase === Phase.Head;
        const correction = params.transposeOnly || headKept ? 0 : (params.root - bridged) * params.flatten;
        alpha = 2 ** ((shift + wobble + correction) / 12);
        spacing = period / alpha;
      } else {
        // No pitch here. Optionally the grains are read at the shift's rate (and laid down as densely),
        // so the noise's colour follows the note while the length stays: a 音MAD-style "s" that goes up.
        alpha = params.unvoicedFollow ? 2 ** (shift / 12) : 1;
        spacing = period / alpha;
        gain = params.unvoicedGainDb <= -60 ? 0 : 10 ** (params.unvoicedGainDb / 20);
      }
      // Repeated noise grains sound metallic (and read as a pitch); alternating their direction hides it.
      // That happens in the sustain, and wherever a slowed-down part reuses its grains.
      if (v.phase === Phase.Sustain || this.speedAt(v, v.srcTime) < 1) {
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
      v.srcTime = this.skipRemoved(v.srcTime + step * (resample ? alpha : 1) * this.speedAt(v, v.srcTime));
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
    // 録音の終わりまで plays the whole range at the recording's pace; 頭部だけ, the head at its own.
    const after = (from: number) => this.playedBetween(Math.max(from, this.sustainStart), this.rangeEnd);
    let out: number;
    if (v.phase === Phase.Head) {
      const head = this.playedBetween(v.srcTime, this.sustainStart) * (playedParts(params).tail ? 1 : Math.max(0.05, params.stretch.head));
      if (!params.sustainEnabled) out = head;
      else if (params.sustainMode === "none") out = head + after(this.sustainStart);
      else return Infinity;
    } else if (v.phase === Phase.Run) {
      out = after(v.srcTime);
    } else if (v.phase === Phase.Done) {
      out = 0;
    } else {
      return Infinity;
    }
    if (params.pitchMode === "resample") out /= 2 ** (this.shiftOf(v.note, v.bend) / 12);
    return out;
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
    // Letting go fades over the release, or the 終わりのフェード when that is longer.
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
          // Decaying to nothing (sustain 0: a struck, piano-like note): once it is below -80 dB the note is over.
          if (amp.sustain <= 1e-4 && v.level < 1e-4) {
            v.level = 0;
            v.env = Env.Off;
          } else if (Math.abs(v.level - amp.sustain) < 1e-4) v.env = Env.Sustain;
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
