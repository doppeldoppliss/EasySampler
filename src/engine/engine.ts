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
//             pool of steady periods (no fixed loop to hear), or a loop
//   tail    – after the note is released, when enabled: the material's own end
// "Resample" mode uses the same grains with their time and pitch scaled
// together, which is exactly playback at a different speed.
//
// Nothing here allocates while rendering.

import { normalizeRemoved } from "../instrument/layout";
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
  previousPoolIndex = -1;
  reverseNext = false;

  env: Env = Env.Off;
  level = 0;
  /** Extra fade (stolen voice / end of material): per-sample decrement of fadeGain. */
  fadeGain = 1;
  fadeStep = 0;

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
  private pool = new Int32Array(0);
  private voices: Voice[] = [];
  private order = 0;
  private seed = 0x2545f491;

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
    }
    this.rebuildPool();
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
    this.params = params;
    this.ensureVoices(params.maxVoices);
    this.rebuildPool();
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
    const s = this.params!.stretch;
    const factor = position < this.sustainStart ? s.head : position < this.sustainEnd ? s.sustain : s.tail;
    return 1 / Math.max(0.05, factor);
  }

  noteOn(note: number, velocity = 0.8): void {
    if (!this.source || !this.params) return;
    const params = this.params;
    // Over the polyphony limit: the oldest sounding voice fades out quickly.
    const sounding = this.voices.filter((v) => v.active && v.fadeStep === 0);
    if (sounding.length >= params.maxVoices) {
      const oldest = sounding.reduce((a, b) => (b.startOrder < a.startOrder ? b : a));
      this.fadeOut(oldest, STEAL_FADE_SEC);
    }
    const voice = this.voices.find((v) => !v.active) ?? this.voices.reduce((a, b) => (b.startOrder < a.startOrder ? b : a));
    this.start(voice, note, velocity);
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
  }

  private start(v: Voice, note: number, velocity: number): void {
    const params = this.params!;
    v.active = true;
    v.note = note;
    v.velocityGain = 1 - params.amp.velocitySens + params.amp.velocitySens * Math.max(0, Math.min(1, velocity));
    v.released = false;
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
    const params = this.params!;
    if (params.tail.enabled && params.sustainMode !== "none") {
      // The tail plays the material's own end at full level; the envelope holds.
      if (v.phase === Phase.Sustain) this.jumpToTail(v);
    } else if (!params.tail.enabled) {
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
  }

  /** Moves the voice from head to sustain / run once its read position gets there. */
  private enterPhaseIfDue(v: Voice): void {
    if (v.phase !== Phase.Head || v.srcTime < this.sustainStart) return;
    const params = this.params!;
    if (params.sustainMode === "none") {
      v.phase = Phase.Run;
    } else if (v.released && params.tail.enabled) {
      this.jumpToTail(v);
    } else {
      v.phase = Phase.Sustain;
      if (params.sustainMode === "loop" || this.pool.length < MIN_POOL) v.srcTime = Math.max(v.srcTime, this.sustainStart);
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

  /** The next period from the sustain pool: a step of 1–3 to either side, never straight back. */
  private nextPoolMark(v: Voice): number {
    const n = this.pool.length;
    let next = v.poolIndex;
    for (let tries = 0; tries < 6; tries++) {
      const stepSize = 1 + Math.floor(this.random() * 3);
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
  private fromPool(): boolean {
    const mode = this.params!.sustainMode;
    return (mode === "pool" || mode === "wavetable") && this.pool.length >= MIN_POOL;
  }

  /** Wobble (semitones) at a voice time: vibrato fading in after its delay, plus the slow drift. */
  private wobbleAt(v: Voice, seconds: number): number {
    const w = this.params!.wobble;
    let cents = 0;
    if (w.vibratoCents > 0) {
      const fadeIn = Math.max(0, Math.min(1, (seconds - w.vibratoDelaySec) / 0.15));
      cents += w.vibratoCents * fadeIn * Math.sin(2 * Math.PI * w.vibratoHz * seconds);
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

  /** Places the voice's next grain; false when the material has run out. */
  private scheduleGrain(v: Voice): boolean {
    const source = this.source!;
    const params = this.params!;
    const resample = params.pitchMode === "resample";
    this.enterPhaseIfDue(v);

    let k: number;
    if (v.phase === Phase.Sustain && this.fromPool()) {
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
    const shift = v.note - params.root;
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
      const f0 = source.f0[k];
      const flattened = Number.isFinite(f0) ? params.flatten * (f0 - params.root) : 0;
      const offset = shift + wobble - flattened;
      spacing = period * 2 ** (-offset / 12);
      alpha = this.formantAlpha(shift);
      gain = Math.sqrt((spacing * alpha) / period);
      if (params.wobble.micro) {
        spacing *= 1 + (this.random() * 2 - 1) * JITTER;
        gain *= 1 + (this.random() * 2 - 1) * SHIMMER;
      }
    } else {
      spacing = period;
      alpha = 1;
      // Repeated noise grains sound metallic (and read as a pitch); alternating their direction hides it.
      // That happens in the sustain, and wherever a slowed-down part reuses its grains.
      if (v.phase === Phase.Sustain || this.speedAt(v.srcTime) < 1) {
        reverse = v.reverseNext;
        v.reverseNext = !v.reverseNext;
      }
    }

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
    v.lastLeft = grain.left;
    v.driftCountdown -= step / this.sampleRate;
    // The read position moves with real time (or faster/slower when resampling), at the part's own speed, past anything cut out.
    if (!(v.phase === Phase.Sustain && this.fromPool())) {
      v.srcTime = this.skipRemoved(v.srcTime + step * (resample ? alpha : 1) * this.speedAt(v.srcTime));
    }
    return true;
  }

  private formantAlpha(shift: number): number {
    const params = this.params!;
    let semitones = params.formantSemitones;
    if (params.formantFollow && Math.abs(shift) > FORMANT_FOLLOW_FROM) {
      semitones += Math.sign(shift) * (Math.abs(shift) - FORMANT_FOLLOW_FROM) * FORMANT_FOLLOW_POWER;
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
    const releaseStep = 1 / Math.max(1, amp.release * sr);
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
      const gain = v.level * v.fadeGain * v.velocityGain;
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
