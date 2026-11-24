// Loudness after ITU-R BS.1770 / EBU R 128 (what YouTube, Spotify and ニコニコ動画
// level songs by): K-weighting (a high shelf, then a high pass), the mean
// square over 400 ms blocks, gated at -70 LUFS and then 10 LU under the
// first average. True peak by 4× oversampling. And what the song export
// needs to bring a mix to a target: a gain, then a look-ahead limiter under a
// true-peak ceiling. ShortTermMeter is the live version (the master meter).

/** A biquad's coefficients (a0 = 1). */
interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** The two K-weighting stages for a sample rate (the BS.1770 filters, derived for any rate as libebur128 does). */
export function kWeighting(sampleRate: number): [Biquad, Biquad] {
  // Stage 1: the head's high shelf (+4 dB above ~1.7 kHz).
  const f0 = 1681.974450955533;
  const g = 3.999843853973347;
  const q = 0.7071752369554196;
  const k1 = Math.tan((Math.PI * f0) / sampleRate);
  const vh = 10 ** (g / 20);
  const vb = vh ** 0.4996667741545416;
  const a0 = 1 + k1 / q + k1 * k1;
  const shelf: Biquad = {
    b0: (vh + (vb * k1) / q + k1 * k1) / a0,
    b1: (2 * (k1 * k1 - vh)) / a0,
    b2: (vh - (vb * k1) / q + k1 * k1) / a0,
    a1: (2 * (k1 * k1 - 1)) / a0,
    a2: (1 - k1 / q + k1 * k1) / a0,
  };
  // Stage 2: the RLB high pass (~38 Hz).
  const f1 = 38.13547087602444;
  const q1 = 0.5003270373238773;
  const k2 = Math.tan((Math.PI * f1) / sampleRate);
  const d = 1 + k2 / q1 + k2 * k2;
  const highPass: Biquad = { b0: 1, b1: -2, b2: 1, a1: (2 * (k2 * k2 - 1)) / d, a2: (1 - k2 / q1 + k2 * k2) / d };
  return [shelf, highPass];
}

/** A running K-weighting filter for one channel. */
class KFilter {
  private readonly s: [Biquad, Biquad];
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  private z1 = 0;
  private z2 = 0;

  constructor(sampleRate: number) {
    this.s = kWeighting(sampleRate);
  }

  /** The K-weighted sample. */
  step(x: number): number {
    const [a, b] = this.s;
    const y = a.b0 * x + a.b1 * this.x1 + a.b2 * this.x2 - a.a1 * this.y1 - a.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    const z = b.b0 * y + b.b1 * this.y1 + b.b2 * this.y2 - b.a1 * this.z1 - b.a2 * this.z2;
    this.y2 = this.y1;
    this.y1 = y;
    this.z2 = this.z1;
    this.z1 = z;
    return z;
  }
}

/** LUFS from a mean square (summed over the channels). */
const lufs = (meanSquare: number) => (meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : -Infinity);

/** Integrated loudness (LUFS) of a stereo signal; -Infinity for silence. */
export function integratedLoudness(left: Float32Array, right: Float32Array, sampleRate: number): number {
  const fl = new KFilter(sampleRate);
  const fr = new KFilter(sampleRate);
  // Sums over 100 ms steps; a block is four of them (400 ms, 75% overlap).
  const step = Math.round(sampleRate / 10);
  const sums: number[] = [];
  let sum = 0;
  let n = 0;
  for (let i = 0; i < left.length; i++) {
    const a = fl.step(left[i]);
    const b = fr.step(right[i]);
    sum += a * a + b * b;
    if (++n === step) {
      sums.push(sum);
      sum = 0;
      n = 0;
    }
  }
  const blocks: number[] = [];
  for (let i = 0; i + 4 <= sums.length; i++) blocks.push((sums[i] + sums[i + 1] + sums[i + 2] + sums[i + 3]) / (4 * step));
  // A song shorter than one block: the whole of it.
  if (!blocks.length) return lufs((sums.reduce((x, y) => x + y, 0) + sum) / Math.max(1, left.length));
  const loud = blocks.filter((ms) => lufs(ms) > -70);
  if (!loud.length) return -Infinity;
  const relative = lufs(loud.reduce((x, y) => x + y, 0) / loud.length) - 10;
  const kept = loud.filter((ms) => lufs(ms) > relative);
  return lufs(kept.reduce((x, y) => x + y, 0) / kept.length);
}

/** 4× oversampling taps: a windowed sinc, 12 taps per phase. */
const OVERSAMPLE = 4;
const TAPS = 12;
const PHASES: Float32Array[] = (() => {
  const out: Float32Array[] = [];
  for (let p = 0; p < OVERSAMPLE; p++) {
    const taps = new Float32Array(TAPS);
    for (let k = 0; k < TAPS; k++) {
      const t = k - TAPS / 2 + 1 - p / OVERSAMPLE;
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const w = 0.5 + 0.5 * Math.cos((Math.PI * t) / (TAPS / 2));
      taps[k] = sinc * w;
    }
    out.push(taps);
  }
  return out;
})();

/** The true peak around each sample (the largest of it and the points interpolated up to the next), one channel. */
function truePeaks(x: Float32Array): Float32Array {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let peak = Math.abs(x[i]);
    for (let p = 1; p < OVERSAMPLE; p++) {
      const taps = PHASES[p];
      let v = 0;
      for (let k = 0; k < TAPS; k++) {
        const j = i + k - TAPS / 2 + 1;
        if (j >= 0 && j < x.length) v += x[j] * taps[k];
      }
      peak = Math.max(peak, Math.abs(v));
    }
    out[i] = peak;
  }
  return out;
}

/** The true peak (linear) of a stereo signal. */
export function truePeak(left: Float32Array, right: Float32Array): number {
  let peak = 0;
  for (const ch of [left, right]) {
    const tp = truePeaks(ch);
    for (let i = 0; i < tp.length; i++) if (tp[i] > peak) peak = tp[i];
  }
  return peak;
}

/** How long the limiter keeps a reduction before letting it go. */
const LIMIT_HOLD_SEC = 0.01;

/**
 * A look-ahead limiter, offline: the gain comes down over `lookaheadSec` before each sample whose true peak would
 * pass `ceiling` (linear), stays for 10 ms, and recovers with the time constant `releaseSec`. In place.
 */
export function limit(left: Float32Array, right: Float32Array, sampleRate: number, ceiling: number, lookaheadSec = 0.005, releaseSec = 0.08): void {
  const n = left.length;
  const tl = truePeaks(left);
  const tr = truePeaks(right);
  const gain = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const peak = Math.max(tl[i], tr[i]);
    gain[i] = peak > ceiling ? ceiling / peak : 1;
  }
  // (Times, not slopes: a ramp of a fixed slope reached a 1 dB reduction in half a millisecond and let it go in 9,
  // so the gain followed a bass note's own wave — as much distortion as clipping it.)
  // (The look-ahead in two halves: the two averages below, one after the other, add up to it.)
  const half = Math.max(1, Math.round((lookaheadSec * sampleRate) / 2));
  const ahead = 2 * half;
  // Held: the lowest gain asked for from 10 ms back (half a period of 50 Hz: a bass note's next half wave finds the
  // gain still down) to the look-ahead on, by a sliding minimum.
  const hold = Math.round(LIMIT_HOLD_SEC * sampleRate);
  const held = new Float32Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  let next = 0;
  for (let i = 0; i < n; i++) {
    for (const to = Math.min(n - 1, i + ahead); next <= to; next++) {
      while (tail > head && gain[queue[tail - 1]] >= gain[next]) tail--;
      queue[tail++] = next;
    }
    while (queue[head] < i - hold) head++;
    held[i] = gain[queue[head]];
  }
  // Let go: back toward 1 with the release's time constant.
  const release = Math.exp(-1 / Math.max(1, releaseSec * sampleRate));
  for (let i = 1; i < n; i++) held[i] = Math.min(held[i], 1 - (1 - held[i - 1]) * release);
  // Smoothed over the look-ahead behind each sample (twice, over half of it: an S-shaped way down). Every value
  // averaged is a minimum over a window that reaches this sample, so the gain never ends over what it needs.
  for (let pass = 0; pass < 2; pass++) {
    const from = pass === 0 ? held : gain;
    const to = pass === 0 ? gain : held;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += from[i];
      if (i > half) sum -= from[i - half - 1];
      to[i] = sum / Math.min(i + 1, half + 1);
    }
  }
  gain.set(held);
  for (let i = 0; i < n; i++) {
    left[i] *= gain[i];
    right[i] *= gain[i];
  }
}

/**
 * Brings a mix to `targetLufs` (a gain), then under `ceilingDb` true peak (the limiter, run again while the ceiling
 * is still passed). In place; returns the loudness and true peak before and after, and the gain (dB).
 */
export function matchLoudness(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  targetLufs: number,
  ceilingDb = -1,
): { beforeLufs: number; afterLufs: number; gainDb: number; truePeakDb: number } {
  const beforeLufs = integratedLoudness(left, right, sampleRate);
  if (!Number.isFinite(beforeLufs)) return { beforeLufs, afterLufs: beforeLufs, gainDb: 0, truePeakDb: -Infinity };
  let gainDb = targetLufs - beforeLufs;
  const ceiling = 10 ** (ceilingDb / 20);
  // (Kept only when the limiter has work to do: what it takes off is then made up by going in louder.)
  let dryL: Float32Array | null = null;
  let dryR: Float32Array | null = null;
  let afterLufs = beforeLufs;
  for (let attempt = 0; ; attempt++) {
    const g = 10 ** (gainDb / 20);
    for (let i = 0; i < left.length; i++) {
      left[i] = (dryL ? dryL[i] : left[i]) * g;
      right[i] = (dryR ? dryR[i] : right[i]) * g;
    }
    const over = truePeak(left, right) > ceiling * 1.0005;
    if (over && !dryL && attempt === 0) {
      const back = 1 / g;
      dryL = left.map((x) => x * back);
      dryR = right.map((x) => x * back);
    }
    for (let pass = 0; pass < 3 && truePeak(left, right) > ceiling * 1.0005; pass++) limit(left, right, sampleRate, ceiling * 0.999);
    afterLufs = over ? integratedLoudness(left, right, sampleRate) : targetLufs;
    // Short of the target by what the limiter took: once more from the dry mix, that much louder (within 0.1 LU,
    // four tries, and never more than MAX_PUSH_DB into the limiter over the plain gain — past that it only crushes).
    const short = targetLufs - afterLufs;
    const pushed = gainDb - (targetLufs - beforeLufs);
    if (!dryL || short <= 0.1 || attempt >= 3 || pushed >= MAX_PUSH_DB) break;
    gainDb += Math.min(short * 1.2, MAX_PUSH_DB - pushed);
  }
  return { beforeLufs, afterLufs, gainDb, truePeakDb: 20 * Math.log10(Math.max(1e-9, truePeak(left, right))) };
}

/** The most the loudness matching goes into the limiter over the plain gain to make up what the limiter takes off (dB). */
const MAX_PUSH_DB = 4;

/** The live loudness: momentary (400 ms) and short-term (3 s), from blocks pushed as they play. */
export class ShortTermMeter {
  private readonly fl: KFilter;
  private readonly fr: KFilter;
  private readonly step: number;
  /** The last 30 sums over 100 ms (a ring). */
  private readonly sums = new Float64Array(30);
  private at = 0;
  private filled = 0;
  private sum = 0;
  private n = 0;

  constructor(sampleRate: number) {
    this.fl = new KFilter(sampleRate);
    this.fr = new KFilter(sampleRate);
    this.step = Math.round(sampleRate / 10);
  }

  push(left: Float32Array, right: Float32Array, frames: number): void {
    for (let i = 0; i < frames; i++) {
      const a = this.fl.step(left[i]);
      const b = this.fr.step(right[i]);
      this.sum += a * a + b * b;
      if (++this.n === this.step) {
        this.sums[this.at] = this.sum;
        this.at = (this.at + 1) % this.sums.length;
        this.filled = Math.min(this.sums.length, this.filled + 1);
        this.sum = 0;
        this.n = 0;
      }
    }
  }

  private over(steps: number): number {
    const k = Math.min(steps, this.filled);
    if (!k) return -Infinity;
    let total = 0;
    for (let j = 1; j <= k; j++) total += this.sums[(this.at - j + this.sums.length) % this.sums.length];
    return lufs(total / (steps * this.step));
  }

  get momentary(): number {
    return this.over(4);
  }

  get shortTerm(): number {
    return this.over(30);
  }

  reset(): void {
    this.sums.fill(0);
    this.filled = 0;
    this.sum = 0;
    this.n = 0;
  }
}

/**
 * How wide a stereo mix is: the correlation of left and right (1 = the same on both, mono; 0 = unrelated; below 0 =
 * out of phase) and the side (L−R) against the mid (L+R) in dB — a finished mix sits around 0.7–0.9 and −12 to −8 dB.
 */
export function stereoImage(left: Float32Array, right: Float32Array): { correlation: number; sideDb: number } {
  let lr = 0;
  let ll = 0;
  let rr = 0;
  let mid = 0;
  let side = 0;
  for (let i = 0; i < left.length; i++) {
    const l = left[i];
    const r = right[i];
    lr += l * r;
    ll += l * l;
    rr += r * r;
    mid += (l + r) * (l + r);
    side += (l - r) * (l - r);
  }
  return { correlation: ll > 0 && rr > 0 ? lr / Math.sqrt(ll * rr) : 1, sideDb: mid > 0 ? 10 * Math.log10(Math.max(side, 1e-20) / mid) : -Infinity };
}
