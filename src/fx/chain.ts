// The effect rack (エフェクト): the kinds of plug-ins 音MAD makers reach
// for — transient shaper, EQ, saturation, air, LFO filter, bit crusher,
// chorus, mid/side width, auto-pan, limiter — written for this app. One
// chain, fixed order, stereo in place; the same code runs in the AudioWorklet
// (after the voices) and in the file render, so what is heard is what is
// written. Every effect that is off costs nothing.

import type { FxBeats, FxSettings } from "../instrument/types";

const TAU = 2 * Math.PI;
const dbToGain = (db: number) => 10 ** (db / 20);

// ------------------------------------------------------------ biquad (RBJ cookbook)

type BiquadKind = "lowpass" | "highpass" | "lowshelf" | "highshelf" | "peaking";

class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  // Direct form I state, per channel.
  private x1 = [0, 0];
  private x2 = [0, 0];
  private y1 = [0, 0];
  private y2 = [0, 0];

  set(kind: BiquadKind, freq: number, q: number, gainDb: number, sampleRate: number): void {
    const f = Math.min(freq, sampleRate * 0.45);
    const w = (TAU * f) / sampleRate;
    const cos = Math.cos(w);
    const sin = Math.sin(w);
    const A = 10 ** (gainDb / 40);
    const alpha = sin / (2 * q);
    let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
    switch (kind) {
      case "lowpass":
        b0 = (1 - cos) / 2;
        b1 = 1 - cos;
        b2 = b0;
        a0 = 1 + alpha;
        a1 = -2 * cos;
        a2 = 1 - alpha;
        break;
      case "highpass":
        b0 = (1 + cos) / 2;
        b1 = -(1 + cos);
        b2 = b0;
        a0 = 1 + alpha;
        a1 = -2 * cos;
        a2 = 1 - alpha;
        break;
      case "peaking":
        b0 = 1 + alpha * A;
        b1 = -2 * cos;
        b2 = 1 - alpha * A;
        a0 = 1 + alpha / A;
        a1 = -2 * cos;
        a2 = 1 - alpha / A;
        break;
      case "lowshelf": {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 - (A - 1) * cos + s);
        b1 = 2 * A * (A - 1 - (A + 1) * cos);
        b2 = A * (A + 1 - (A - 1) * cos - s);
        a0 = A + 1 + (A - 1) * cos + s;
        a1 = -2 * (A - 1 + (A + 1) * cos);
        a2 = A + 1 + (A - 1) * cos - s;
        break;
      }
      case "highshelf": {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 + (A - 1) * cos + s);
        b1 = -2 * A * (A - 1 + (A + 1) * cos);
        b2 = A * (A + 1 + (A - 1) * cos - s);
        a0 = A + 1 - (A - 1) * cos + s;
        a1 = 2 * (A - 1 - (A + 1) * cos);
        a2 = A + 1 - (A - 1) * cos - s;
        break;
      }
    }
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }

  reset(): void {
    this.x1.fill(0);
    this.x2.fill(0);
    this.y1.fill(0);
    this.y2.fill(0);
  }

  tick(x: number, ch: number): number {
    const y = this.b0 * x + this.b1 * this.x1[ch] + this.b2 * this.x2[ch] - this.a1 * this.y1[ch] - this.a2 * this.y2[ch];
    this.x2[ch] = this.x1[ch];
    this.x1[ch] = x;
    this.y2[ch] = this.y1[ch];
    this.y1[ch] = y;
    return y;
  }
}

// ------------------------------------------------------------ the chain

/** Output samples per LFO coefficient update for the filter. */
const FILTER_UPDATE = 16;
const LIMITER_LOOKAHEAD_SEC = 0.002;
const CHORUS_BASE_MS = 12;
const CHORUS_MAX_MS = 40;

export class FxChain {
  private readonly sampleRate: number;
  private fx: FxSettings | null = null;
  private bpm = 120;

  // transient shaper
  /** Peak-hold level (instant attack): the waveform's envelope, smooth enough to compare. */
  private envFast = 0;
  /** The same level followed slowly: it lags behind on an attack, and that lag is the transient. */
  private envSlow = 0;
  private readonly tFastRel: number;
  private readonly tSlowAtk: number;
  private readonly tSlowRel: number;

  // EQ
  private readonly eqLowCut = new Biquad();
  private readonly eqLow = new Biquad();
  private readonly eqMid = new Biquad();
  private readonly eqHigh = new Biquad();
  private readonly eqHighCut = new Biquad();

  // saturation: DC blocker after the asymmetric curve
  private dcX = [0, 0];
  private dcY = [0, 0];
  private readonly dcR: number;

  // air
  private readonly airShelf = new Biquad();
  private readonly airBand = new Biquad();

  // filter (TPT state-variable filter)
  private svfIc1 = [0, 0];
  private svfIc2 = [0, 0];
  private filterPhase = 0;
  private filterCountdown = 0;
  private svfG = 0;
  private svfK = 1;

  // crusher
  private crushHold = [0, 0];
  private crushCount = 0;

  // chorus
  private readonly chorusBuf: [Float32Array, Float32Array];
  private chorusWrite = 0;
  private chorusPhase = 0;

  // auto-pan
  private panPhase = 0;

  // limiter
  private readonly limDelay: [Float32Array, Float32Array];
  private readonly limLookahead: number;
  private limWrite = 0;
  private limGain = 1;
  /** Required gain per delayed sample, and a monotonic deque of its window minimum. */
  private readonly limReq: Float32Array;
  private readonly dequeIdx: Int32Array;
  private dqHead = 0;
  private dqTail = 0;
  private limCount = 0;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    const coef = (sec: number) => Math.exp(-1 / Math.max(1, sec * sampleRate));
    this.tFastRel = coef(0.02);
    this.tSlowAtk = coef(0.025);
    this.tSlowRel = coef(0.06);
    this.dcR = coef(1 / (TAU * 10)); // ≈ 10 Hz high-pass
    const chorusLength = Math.ceil((CHORUS_MAX_MS / 1000) * sampleRate) + 4;
    this.chorusBuf = [new Float32Array(chorusLength), new Float32Array(chorusLength)];
    this.limLookahead = Math.max(1, Math.round(LIMITER_LOOKAHEAD_SEC * sampleRate));
    this.limDelay = [new Float32Array(this.limLookahead + 1), new Float32Array(this.limLookahead + 1)];
    this.limReq = new Float32Array(this.limLookahead + 1).fill(1);
    this.dequeIdx = new Int32Array(this.limLookahead + 2);
  }

  /** Samples of delay the chain adds (the limiter's look-ahead), so a render can line itself up. */
  get latency(): number {
    return this.fx?.limiter.on ? this.limLookahead : 0;
  }

  /** Whether anything is on (nothing to do otherwise). */
  get active(): boolean {
    const fx = this.fx;
    if (!fx) return false;
    return fx.transient.on || fx.eq.on || fx.saturation.on || fx.air.on || fx.filter.on || fx.crush.on || fx.chorus.on || fx.width.on || fx.pan.on || fx.limiter.on;
  }

  /** Whether the chain turns mono into stereo (a mono material then needs two channels). */
  static makesStereo(fx: FxSettings): boolean {
    return (fx.chorus.on && fx.chorus.mix > 0) || (fx.pan.on && fx.pan.depth > 0);
  }

  setTempo(bpm: number): void {
    if (Number.isFinite(bpm) && bpm > 0) this.bpm = bpm;
  }

  set(fx: FxSettings): void {
    const was = this.fx;
    this.fx = fx;
    const sr = this.sampleRate;
    const e = fx.eq;
    this.eqLowCut.set("highpass", Math.max(10, e.lowCutHz), 0.707, 0, sr);
    this.eqLow.set("lowshelf", e.lowHz, 0.707, e.lowDb, sr);
    this.eqMid.set("peaking", e.midHz, e.midQ, e.midDb, sr);
    this.eqHigh.set("highshelf", e.highHz, 0.707, e.highDb, sr);
    this.eqHighCut.set("lowpass", Math.min(e.highCutHz, sr * 0.45), 0.707, 0, sr);
    this.airShelf.set("highshelf", 9000, 0.707, fx.air.amount * 8, sr);
    this.airBand.set("highpass", 5000, 0.707, 0, sr);
    // Effects switched on start clean.
    if (!was || (!was.filter.on && fx.filter.on)) {
      this.svfIc1.fill(0);
      this.svfIc2.fill(0);
    }
    if (!was || (!was.chorus.on && fx.chorus.on)) for (const b of this.chorusBuf) b.fill(0);
    if (!was || (!was.limiter.on && fx.limiter.on)) this.resetLimiter();
    this.filterCountdown = 0;
  }

  /** Back to silence (a new note in a render, a song starting). The LFOs restart at their beginning. */
  reset(): void {
    this.envFast = this.envSlow = 0;
    for (const b of [this.eqLowCut, this.eqLow, this.eqMid, this.eqHigh, this.eqHighCut, this.airShelf, this.airBand]) b.reset();
    this.dcX.fill(0);
    this.dcY.fill(0);
    this.svfIc1.fill(0);
    this.svfIc2.fill(0);
    this.filterPhase = 0;
    this.filterCountdown = 0;
    this.crushHold.fill(0);
    this.crushCount = 0;
    for (const b of this.chorusBuf) b.fill(0);
    this.chorusWrite = 0;
    this.chorusPhase = 0;
    this.panPhase = 0;
    this.resetLimiter();
  }

  private resetLimiter(): void {
    for (const b of this.limDelay) b.fill(0);
    this.limReq.fill(1);
    this.limWrite = 0;
    this.limGain = 1;
    this.dqHead = this.dqTail = 0;
    this.limCount = 0;
  }

  /** Processes `frames` samples in place. `right` may be the same array as `left` (mono: the stereo effects then fold back to mono). */
  process(left: Float32Array, right: Float32Array, frames: number): void {
    const fx = this.fx;
    if (!fx || !this.active) return;
    const mono = left === right;
    const sr = this.sampleRate;
    const beatHz = (beats: FxBeats) => this.bpm / 60 / beats;

    // Per-block constants.
    const tAtk = dbToGain(fx.transient.attackDb);
    const tSus = dbToGain(fx.transient.sustainDb);
    const drive = 1 + fx.saturation.drive * 14;
    const bias = 0.2 * fx.saturation.drive;
    const satNorm = 1 / Math.tanh(drive);
    const tanhBias = Math.tanh(bias);
    const airExcite = fx.air.amount * 0.25;
    const crushLevels = 2 ** (fx.crush.bits - 1);
    const chorusDepth = (fx.chorus.depthMs / 1000) * sr;
    const chorusBase = (CHORUS_BASE_MS / 1000) * sr;
    const chorusStep = fx.chorus.rateHz / sr;
    const chorusLen = this.chorusBuf[0].length;
    const sideGain = fx.width.side;
    const midGain = dbToGain(fx.width.midDb);
    const panStep = beatHz(fx.pan.beats) / sr;
    const filterStep = beatHz(fx.filter.lfoBeats) / sr;
    const limIn = dbToGain(fx.limiter.gainDb);
    const ceiling = dbToGain(fx.limiter.ceilingDb);
    const limRelease = Math.exp(-1 / Math.max(1, (fx.limiter.releaseMs / 1000) * sr));
    const limAttack = Math.exp(-1 / Math.max(1, this.limLookahead / 3));

    for (let i = 0; i < frames; i++) {
      let l = left[i];
      let r = mono ? l : right[i];

      if (fx.transient.on) {
        const level = Math.max(Math.abs(l), Math.abs(r));
        this.envFast = Math.max(level, this.tFastRel * this.envFast);
        const e = this.envFast;
        this.envSlow = e > this.envSlow ? this.tSlowAtk * this.envSlow + (1 - this.tSlowAtk) * e : this.tSlowRel * this.envSlow + (1 - this.tSlowRel) * e;
        // How much of the level right now is attack (the fast follower running ahead of the slow one).
        const t = this.envFast > 1e-6 ? Math.max(0, Math.min(1, (this.envFast - this.envSlow) / this.envFast)) : 0;
        const g = tAtk ** t * tSus ** (1 - t);
        l *= g;
        r *= g;
      }

      if (fx.eq.on) {
        const e = fx.eq;
        for (let ch = 0; ch < (mono ? 1 : 2); ch++) {
          let x = ch === 0 ? l : r;
          if (e.lowCutHz > 0) x = this.eqLowCut.tick(x, ch);
          if (e.lowDb !== 0) x = this.eqLow.tick(x, ch);
          if (e.midDb !== 0) x = this.eqMid.tick(x, ch);
          if (e.highDb !== 0) x = this.eqHigh.tick(x, ch);
          if (e.highCutHz < 20000) x = this.eqHighCut.tick(x, ch);
          if (ch === 0) l = x;
          else r = x;
        }
        if (mono) r = l;
      }

      if (fx.saturation.on) {
        for (let ch = 0; ch < (mono ? 1 : 2); ch++) {
          const x = ch === 0 ? l : r;
          // Asymmetric soft curve (even harmonics, like a triode), then the DC it leaves is taken out.
          const wet = (Math.tanh(drive * x + bias) - tanhBias) * satNorm;
          const y = wet - this.dcX[ch] + this.dcR * this.dcY[ch];
          this.dcX[ch] = wet;
          this.dcY[ch] = y;
          const out = x + (y - x) * fx.saturation.mix;
          if (ch === 0) l = out;
          else r = out;
        }
        if (mono) r = l;
      }

      if (fx.air.on) {
        for (let ch = 0; ch < (mono ? 1 : 2); ch++) {
          const x = ch === 0 ? l : r;
          const top = this.airBand.tick(x, ch);
          const out = this.airShelf.tick(x, ch) + Math.tanh(top * 3) * airExcite;
          if (ch === 0) l = out;
          else r = out;
        }
        if (mono) r = l;
      }

      if (fx.filter.on) {
        const f = fx.filter;
        if (this.filterCountdown-- <= 0) {
          this.filterCountdown = FILTER_UPDATE - 1;
          const lfo = f.lfoOctaves > 0 ? Math.sin(TAU * this.filterPhase) : 0;
          const cutoff = Math.min(sr * 0.45, Math.max(20, f.cutoffHz * 2 ** (f.lfoOctaves * lfo)));
          this.svfG = Math.tan((Math.PI * cutoff) / sr);
          this.svfK = 2 - 1.9 * f.resonance; // 1/Q: 2 (none) … 0.1 (ringing)
        }
        this.filterPhase += filterStep;
        if (this.filterPhase >= 1) this.filterPhase -= 1;
        const g = this.svfG;
        const k = this.svfK;
        const a1 = 1 / (1 + g * (g + k));
        const a2 = g * a1;
        const a3 = g * a2;
        for (let ch = 0; ch < (mono ? 1 : 2); ch++) {
          const x = ch === 0 ? l : r;
          const v3 = x - this.svfIc2[ch];
          const v1 = a1 * this.svfIc1[ch] + a2 * v3;
          const v2 = this.svfIc2[ch] + a2 * this.svfIc1[ch] + a3 * v3;
          this.svfIc1[ch] = 2 * v1 - this.svfIc1[ch];
          this.svfIc2[ch] = 2 * v2 - this.svfIc2[ch];
          const out = f.type === "lowpass" ? v2 : f.type === "bandpass" ? v1 * k : x - k * v1 - v2;
          if (ch === 0) l = out;
          else r = out;
        }
        if (mono) r = l;
      }

      if (fx.crush.on) {
        if (this.crushCount-- <= 0) {
          this.crushCount = fx.crush.downsample - 1;
          this.crushHold[0] = Math.round(l * crushLevels) / crushLevels;
          this.crushHold[1] = Math.round(r * crushLevels) / crushLevels;
        }
        l += (this.crushHold[0] - l) * fx.crush.mix;
        r += (this.crushHold[1] - r) * fx.crush.mix;
      }

      if (fx.chorus.on) {
        const w = this.chorusWrite;
        this.chorusBuf[0][w] = l;
        this.chorusBuf[1][w] = mono ? l : r;
        this.chorusWrite = (w + 1) % chorusLen;
        // Two voices per side, LFOs a quarter cycle apart; the right side runs opposite to the left.
        let wetL = 0;
        let wetR = 0;
        for (let v = 0; v < 2; v++) {
          const phase = this.chorusPhase + v * 0.25;
          const dl = chorusBase * (1 + 0.3 * v) + chorusDepth * (0.5 + 0.5 * Math.sin(TAU * phase));
          const dr = chorusBase * (1 + 0.3 * v) + chorusDepth * (0.5 + 0.5 * Math.sin(TAU * (phase + 0.5)));
          wetL += readDelay(this.chorusBuf[0], w, dl, chorusLen);
          wetR += readDelay(this.chorusBuf[1], w, dr, chorusLen);
        }
        this.chorusPhase += chorusStep;
        if (this.chorusPhase >= 1) this.chorusPhase -= 1;
        const m = fx.chorus.mix;
        l = l * (1 - m * 0.5) + wetL * 0.5 * m;
        r = r * (1 - m * 0.5) + wetR * 0.5 * m;
      }

      if (fx.width.on) {
        const mid = ((l + r) / 2) * midGain;
        const side = ((l - r) / 2) * sideGain;
        l = mid + side;
        r = mid - side;
      }

      if (fx.pan.on) {
        // Equal-power pan swinging with the LFO.
        const pos = fx.pan.depth * Math.sin(TAU * this.panPhase); // −1 … 1
        const angle = ((pos + 1) * Math.PI) / 4;
        const gl = Math.cos(angle) * Math.SQRT2;
        const gr = Math.sin(angle) * Math.SQRT2;
        l *= gl;
        r *= gr;
        this.panPhase += panStep;
        if (this.panPhase >= 1) this.panPhase -= 1;
      }

      if (fx.limiter.on) {
        l *= limIn;
        r *= limIn;
        const n = this.limLookahead + 1;
        const w = this.limWrite;
        const peak = Math.max(Math.abs(l), Math.abs(r));
        // The gain this sample will need when it comes out, and the smallest needed over the look-ahead window.
        const count = this.limCount++;
        this.limReq[w] = peak > ceiling ? ceiling / peak : 1;
        while (this.dqTail > this.dqHead && this.limReq[this.dequeIdx[(this.dqTail - 1) % this.dequeIdx.length] % n] >= this.limReq[w]) this.dqTail--;
        this.dequeIdx[this.dqTail % this.dequeIdx.length] = count;
        this.dqTail++;
        while (this.dequeIdx[this.dqHead % this.dequeIdx.length] <= count - n) this.dqHead++;
        const target = this.limReq[this.dequeIdx[this.dqHead % this.dequeIdx.length] % n];
        this.limGain = target < this.limGain ? limAttack * this.limGain + (1 - limAttack) * target : limRelease * this.limGain + (1 - limRelease) * target;
        // Out comes the sample from the start of the window.
        const rd = (w + 1) % n;
        const dl = this.limDelay[0][rd];
        const dr = this.limDelay[1][rd];
        this.limDelay[0][w] = l;
        this.limDelay[1][w] = r;
        this.limWrite = rd;
        const g = Math.min(this.limGain, target);
        // A last safety: nothing past the ceiling.
        l = Math.max(-ceiling, Math.min(ceiling, dl * g));
        r = Math.max(-ceiling, Math.min(ceiling, dr * g));
      }

      left[i] = mono ? (l + r) / 2 : l;
      if (!mono) right[i] = r;
    }
  }
}

/** A fractional delay read (linear interpolation) `delay` samples behind write position `w`. */
function readDelay(buf: Float32Array, w: number, delay: number, length: number): number {
  let pos = w - delay;
  while (pos < 0) pos += length;
  const i = Math.floor(pos);
  const frac = pos - i;
  const a = buf[i % length];
  const b = buf[(i + 1) % length];
  return a + (b - a) * frac;
}
