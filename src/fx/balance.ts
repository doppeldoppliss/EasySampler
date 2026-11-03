// The master EQ brought toward a target tonal balance (design.md 35): the
// song's long-term spectrum in third-octave bands, compared with the usual
// shape of finished mixes — falling gently from the lows to the highs — in one
// of three styles, and the master EQ's five parts set to take the song about
// halfway there (no part over ±6 dB). A starting point to finish by ear: a
// 3-band EQ only moves the broad tilt, not one track masking another.

import type { FxSettings } from "../instrument/types";
import { eqResponseDb } from "./chain";

export type BalanceStyle = "standard" | "electronic" | "acoustic";

export const BALANCE_STYLES: Record<BalanceStyle, string> = {
  standard: "標準",
  electronic: "電子音・ボカロ系",
  acoustic: "生楽器系",
};

/** Third-octave band centres, 25 Hz – 16 kHz. */
export const BAND_HZ: number[] = (() => {
  const out: number[] = [];
  for (let k = -16; k <= 12; k++) out.push(1000 * 2 ** (k / 3));
  return out;
})();

/**
 * The target shapes: each band's power (dB) against 1 kHz, as finished mixes average out — a peak around
 * 60–100 Hz, then down about 2.5 dB an octave (in third-octave bands; a little steeper than pink noise), faster
 * past 10 kHz. Electronic: more sub and more air; acoustic: less sub, a fuller middle, softer top.
 */
const TARGET_POINTS: Record<BalanceStyle, [number, number][]> = {
  standard: [[25, 1], [40, 6], [63, 8], [100, 7.5], [250, 4.5], [500, 2], [1000, 0], [2000, -2.5], [4000, -5], [8000, -8], [12500, -11], [16000, -15]],
  electronic: [[25, 4], [40, 9], [63, 10.5], [100, 9.5], [250, 5], [500, 2], [1000, 0], [2000, -2], [4000, -4], [8000, -6.5], [12500, -9], [16000, -12.5]],
  acoustic: [[25, -4], [40, 1], [63, 4], [100, 5.5], [250, 4.5], [500, 2.5], [1000, 0], [2000, -2.5], [4000, -5.5], [8000, -9], [12500, -13], [16000, -18]],
};

/** A style's target for each band (BAND_HZ), interpolated along log frequency. */
export function targetDb(style: BalanceStyle): number[] {
  const pts = TARGET_POINTS[style];
  return BAND_HZ.map((hz) => {
    if (hz <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      const [h1, d1] = pts[i];
      if (hz <= h1) {
        const [h0, d0] = pts[i - 1];
        const t = Math.log(hz / h0) / Math.log(h1 / h0);
        return d0 + (d1 - d0) * t;
      }
    }
    return pts[pts.length - 1][1];
  });
}

/** An in-place radix-2 FFT (re, im of a power-of-two length). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

const FFT_SIZE = 8192;

/**
 * The long-term spectrum of a recording (its channels averaged), in third-octave bands (BAND_HZ), dB: Hann-windowed
 * frames half overlapping, the near-silent ones (under −60 dBFS) left out so the gaps do not count. Null when
 * nothing sounds.
 */
export function bandSpectrum(channels: readonly Float32Array[], sampleRate: number): number[] | null {
  const length = channels[0]?.length ?? 0;
  const power = new Float64Array(FFT_SIZE / 2);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const win = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE);
  let frames = 0;
  for (let at = 0; at + FFT_SIZE <= length; at += FFT_SIZE / 2) {
    let sq = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      let x = 0;
      for (const c of channels) x += c[at + i];
      x /= channels.length;
      sq += x * x;
      re[i] = x * win[i];
      im[i] = 0;
    }
    if (sq / FFT_SIZE < 1e-6) continue;
    fft(re, im);
    for (let b = 0; b < FFT_SIZE / 2; b++) power[b] += re[b] * re[b] + im[b] * im[b];
    frames++;
  }
  if (!frames) return null;
  const binHz = sampleRate / FFT_SIZE;
  return BAND_HZ.map((hz) => {
    const lo = Math.max(1, Math.round(hz / 2 ** (1 / 6) / binHz));
    const hi = Math.max(lo + 1, Math.round((hz * 2 ** (1 / 6)) / binHz));
    let p = 0;
    for (let b = lo; b < hi && b < power.length; b++) p += power[b];
    return 10 * Math.log10(p / frames + 1e-20);
  });
}

/** How much a band counts in the fit: the ends (where little is heard, or the EQ's cuts work) less. */
const weightOf = (hz: number) => (hz < 30 ? 0 : hz < 50 || hz > 12000 ? 0.5 : 1);

/** Each band's distance from the target (dB), the overall level taken out (the mean over 100 Hz – 8 kHz). */
function deviation(measured: readonly number[], target: readonly number[]): number[] {
  const d = measured.map((m, j) => m - target[j]);
  let sum = 0;
  let n = 0;
  BAND_HZ.forEach((hz, j) => {
    if (hz >= 100 && hz <= 8000) {
      sum += d[j];
      n++;
    }
  });
  const mean = sum / n;
  return d.map((x) => x - mean);
}

export interface BalanceResult {
  eq: FxSettings["eq"];
  /** Each band's distance from the target before and after (dB, the overall level taken out). */
  before: number[];
  after: number[];
  target: number[];
}

/** The EQ's parts tried (gains in 0.5 dB steps). */
const GAINS = Array.from({ length: 25 }, (_, i) => -6 + i * 0.5);
const LOW_HZ = [80, 120, 180, 250];
const HIGH_HZ = [3000, 5000, 8000, 10000];
const MID_HZ = BAND_HZ.filter((hz) => hz >= 160 && hz <= 6300);
const MID_Q = [0.7, 1, 1.4];
/** How far it goes: about halfway to the target (the rest is for the ear). */
const STRENGTH = 0.5;
/** Every dB asked for costs a little: of two near fits, the gentler wins. */
const GAIN_COST = 0.03;

/**
 * The master EQ for `measured` (bandSpectrum of the mix before the master) toward `style`: low cut at 30 Hz (or
 * higher where it was), a low shelf, one bell and a high shelf, found by trying each part's settings in turn.
 */
export function fitBalance(measured: readonly number[], style: BalanceStyle, sampleRate: number, current: FxSettings["eq"]): BalanceResult {
  const target = targetDb(style);
  const before = deviation(measured, target);
  const want = before.map((d) => -STRENGTH * d);
  const weights = BAND_HZ.map(weightOf);
  const lowCutHz = Math.max(30, current.lowCutHz);
  const highCutHz = 20000;
  const plain: FxSettings["eq"] = { on: true, lowCutHz: 0, lowDb: 0, lowHz: 150, midDb: 0, midHz: 1000, midQ: 1, highDb: 0, highHz: 6000, highCutHz: 20000 };
  const curve = (part: Partial<FxSettings["eq"]>) => BAND_HZ.map((hz) => eqResponseDb({ ...plain, ...part }, sampleRate, hz));
  // The low cut is fixed; its own curve, then every choice of each part, worked out once.
  const cut = curve({ lowCutHz });
  const lows = LOW_HZ.flatMap((lowHz) => GAINS.map((lowDb) => ({ set: { lowHz, lowDb }, db: lowDb, curve: curve({ lowHz, lowDb }) })));
  const highs = HIGH_HZ.flatMap((highHz) => GAINS.map((highDb) => ({ set: { highHz, highDb }, db: highDb, curve: curve({ highHz, highDb }) })));
  const mids = MID_HZ.flatMap((midHz) => MID_Q.flatMap((midQ) => GAINS.map((midDb) => ({ set: { midHz, midQ, midDb }, db: midDb, curve: curve({ midHz, midQ, midDb }) }))));
  interface Choice {
    db: number;
    curve: number[];
  }
  const pick = { low: lows.find((c) => c.db === 0)!, high: highs.find((c) => c.db === 0)!, mid: mids.find((c) => c.db === 0)! };
  const cost = (low: Choice, mid: Choice, high: Choice) => {
    let e = 0;
    for (let j = 0; j < BAND_HZ.length; j++) {
      const miss = low.curve[j] + mid.curve[j] + high.curve[j] + cut[j] - want[j];
      // (Under the low cut, falling short is what the cut is for: the shelf is not to lift it back.)
      if (cut[j] < -1 && miss < 0) continue;
      e += weights[j] * miss * miss;
    }
    return e + GAIN_COST * (low.db * low.db + mid.db * mid.db + high.db * high.db);
  };
  for (let round = 0; round < 4; round++) {
    pick.low = lows.reduce((a, b) => (cost(b, pick.mid, pick.high) < cost(a, pick.mid, pick.high) ? b : a));
    pick.high = highs.reduce((a, b) => (cost(pick.low, pick.mid, b) < cost(pick.low, pick.mid, a) ? b : a));
    pick.mid = mids.reduce((a, b) => (cost(pick.low, b, pick.high) < cost(pick.low, a, pick.high) ? b : a));
  }
  const eq: FxSettings["eq"] = { ...plain, lowCutHz, highCutHz, ...pick.low.set, ...pick.mid.set, ...pick.high.set };
  const applied = BAND_HZ.map((hz) => eqResponseDb(eq, sampleRate, hz));
  const after = deviation(
    measured.map((m, j) => m + applied[j]),
    target,
  );
  return { eq, before, after, target };
}
