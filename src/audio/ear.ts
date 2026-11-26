// A simple model of the ear (design.md 50), for what a listener hears rather than what a meter reads: how much of
// each track is left once the others are playing too (a track can be loud alone and still be covered in the mix).
//
// Excitation in one-ERB bands from 30 Hz to 16 kHz after the outer and middle ear (PEAQ's weighting), spread along
// the cochlea (14 dB per ERB upward, 25 downward); Zwicker's specific loudness on it; a track's partial loudness as
// the loudness of it with the rest less the loudness of the rest alone. Each ear on its own (a track panned away
// from what covers it is heard by the ear it leans to). Rough by design: read one track against another, not alone.

export const EAR_FFT = 4096;
export const EAR_HOP = 2048;

const erbNum = (f: number) => 21.4 * Math.log10(1 + 0.00437 * f);
const erbInv = (e: number) => (10 ** (e / 21.4) - 1) / 0.00437;
const bark = (f: number) => 13 * Math.atan(0.00076 * f) + 3.5 * Math.atan((f / 7500) ** 2);

/** The bands: centre, edges (Hz), width in Bark, the outer/middle ear's weighting (linear) and the threshold in quiet inside the ear. */
export const EAR_BANDS = (() => {
  const b = { hz: [] as number[], lo: [] as number[], hi: [] as number[], dz: [] as number[], weight: [] as number[], thq: [] as number[] };
  for (let e = erbNum(30); e <= erbNum(16000) + 1e-9; e += 1) {
    const lo = erbInv(e), hi = erbInv(e + 1), hz = erbInv(e + 0.5), k = hz / 1000;
    const w = -0.6 * 3.64 * k ** -0.8 + 6.5 * Math.exp(-0.6 * (k - 3.3) ** 2) - 1e-3 * k ** 3.6;
    const tq = 3.64 * k ** -0.8 - 6.5 * Math.exp(-0.6 * (k - 3.3) ** 2) + 1e-3 * k ** 4;
    b.lo.push(lo); b.hi.push(hi); b.hz.push(hz);
    b.dz.push(bark(hi) - bark(lo));
    b.weight.push(10 ** (w / 10));
    b.thq.push(10 ** (Math.max(0, tq + w) / 10));
  }
  return b;
})();
const NB = EAR_BANDS.hz.length;

/** One sound's excitation, both ears: frames × bands, a full-scale sine's power at 0 dB (scaled for a listening level later). */
export interface EarPattern {
  left: Float32Array;
  right: Float32Array;
  frames: number;
  sampleRate: number;
}

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
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

function excitation(x: Float32Array, sr: number): Float32Array {
  const frames = Math.max(1, Math.floor((x.length - EAR_FFT) / EAR_HOP) + 1);
  const out = new Float32Array(frames * NB);
  const win = new Float64Array(EAR_FFT);
  let w2 = 0;
  for (let i = 0; i < EAR_FFT; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / EAR_FFT);
    w2 += win[i] ** 2;
  }
  // (×2 on the mean square: a full-scale sine at 0 dB.)
  const norm = 4 / (EAR_FFT * w2);
  const binLo = EAR_BANDS.lo.map((f) => Math.max(1, Math.round((f * EAR_FFT) / sr)));
  const binHi = EAR_BANDS.hi.map((f, b) => Math.max(binLo[b] + 1, Math.min(EAR_FFT / 2, Math.round((f * EAR_FFT) / sr))));
  const up = 10 ** (-14 / 10), down = 10 ** (-25 / 10);
  const re = new Float64Array(EAR_FFT), im = new Float64Array(EAR_FFT);
  const I = new Float64Array(NB);
  for (let f = 0; f < frames; f++) {
    const at = f * EAR_HOP;
    for (let i = 0; i < EAR_FFT; i++) {
      re[i] = (at + i < x.length ? x[at + i] : 0) * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < NB; b++) {
      let p = 0;
      for (let k = binLo[b]; k < binHi[b]; k++) p += re[k] * re[k] + im[k] * im[k];
      I[b] = p * norm * EAR_BANDS.weight[b];
    }
    // Spread: what each band excites above it (falling slowly) and below it (falling fast).
    const o = f * NB;
    let carry = 0;
    for (let b = 0; b < NB; b++) {
      carry = carry * up + I[b];
      out[o + b] = carry;
    }
    carry = 0;
    for (let b = NB - 1; b >= 0; b--) {
      out[o + b] += carry * down;
      carry = carry * down + I[b];
    }
  }
  return out;
}

/** A rendered sound's excitation in both ears. */
export function earPattern(left: Float32Array, right: Float32Array, sampleRate: number): EarPattern {
  const l = excitation(left, sampleRate);
  return { left: l, right: excitation(right, sampleRate), frames: l.length / NB, sampleRate };
}

/** Zwicker's specific loudness of one band (sone, × its width in Bark). */
function specific(e: number, b: number): number {
  if (e <= 0) return 0;
  const t = EAR_BANDS.thq[b];
  const n = 0.08 * t ** 0.23 * ((0.5 + (0.5 * e) / t) ** 0.23 - 1);
  return n > 0 ? n * EAR_BANDS.dz[b] : 0;
}

export interface Audibility {
  /** The share of the time it plays (it counts where it is at least a tenth of its own loud parts). */
  playing: number;
  /** While it plays: its loudness in the mix against the whole mix's loudness (0–1). */
  share: number;
  /** While it plays: its loudness in the mix against its loudness alone (0–1; low = covered). */
  heard: number;
  /** Where it loses most to the rest (Hz), and which other sound has the most there while it plays (index, or null). */
  worstHz: number;
  coveredBy: number | null;
  /** The 8 s it is heard least in (song seconds), while it plays through most of them; null if it never does. */
  leastFrom: number | null;
}

/**
 * How much of each sound is heard among the others: `patterns` are the tracks alone (null = not measured), the rest
 * of the mix for one of them is all the others added (as powers — near enough for sounds that are not the same
 * notes on the same sound). `mixLufs` is the whole's loudness, played at `listenDb` dB SPL.
 */
export function audibility(patterns: readonly (EarPattern | null)[], mixLufs: number, listenDb = 75): (Audibility | null)[] {
  const live = patterns.flatMap((p, i) => (p ? [i] : []));
  if (!live.length || !Number.isFinite(mixLufs)) return patterns.map(() => null);
  const frames = Math.max(...live.map((i) => patterns[i]!.frames));
  const sr = patterns[live[0]]!.sampleRate;
  const g = 10 ** ((listenDb - mixLufs) / 10);
  const at = (p: EarPattern, ear: 0 | 1, f: number, b: number) => (f < p.frames ? (ear ? p.right : p.left)[f * NB + b] * g : 0);
  // The whole, and its loudness frame by frame.
  const sum = [new Float32Array(frames * NB), new Float32Array(frames * NB)];
  for (const i of live)
    for (const ear of [0, 1] as const) {
      const p = patterns[i]!, src = ear ? p.right : p.left, dst = sum[ear];
      for (let k = 0; k < p.frames * NB; k++) dst[k] += src[k] * g;
    }
  const mixN = new Float32Array(frames);
  for (let f = 0; f < frames; f++) for (const ear of [0, 1]) for (let b = 0; b < NB; b++) mixN[f] += specific(sum[ear][f * NB + b], b);
  const window = Math.max(1, Math.round((8 * sr) / EAR_HOP));
  return patterns.map((p) => {
    if (!p) return null;
    const alone = new Float32Array(frames), part = new Float32Array(frames);
    const loss = new Float64Array(NB);
    for (let f = 0; f < Math.min(frames, p.frames); f++)
      for (const ear of [0, 1] as const)
        for (let b = 0; b < NB; b++) {
          const e = at(p, ear, f, b);
          if (e <= 0) continue;
          const all = sum[ear][f * NB + b];
          const rest = Math.max(0, all - e);
          const a = specific(e, b), q = Math.max(0, specific(all, b) - specific(rest, b));
          alone[f] += a;
          part[f] += q;
          loss[b] += a - q;
        }
    let top = 0;
    for (let f = 0; f < frames; f++) top = Math.max(top, alone[f]);
    const sorted = Array.from(alone).sort((x, y) => x - y);
    const floor = Math.max(0.3, sorted[Math.floor(sorted.length * 0.95)] * 0.1);
    let A = 0, P = 0, M = 0, on = 0;
    const playing = new Uint8Array(frames);
    for (let f = 0; f < frames; f++)
      if (alone[f] > floor) {
        playing[f] = 1;
        A += alone[f]; P += part[f]; M += mixN[f]; on++;
      }
    if (!on) return { playing: 0, share: 0, heard: 0, worstHz: 0, coveredBy: null, leastFrom: null };
    // The worst three bands together, and who has the most there while this plays.
    let wb = 1, best = -1;
    for (let b = 1; b < NB - 1; b++) {
      const x = loss[b - 1] + loss[b] + loss[b + 1];
      if (x > best) { best = x; wb = b; }
    }
    let coveredBy: number | null = null, most = 0;
    for (const j of live) {
      if (patterns[j] === p) continue;
      const o = patterns[j]!;
      let e = 0;
      for (let f = 0; f < Math.min(frames, o.frames); f++) if (playing[f]) for (let b = wb - 1; b <= wb + 1; b++) e += o.left[f * NB + b] + o.right[f * NB + b];
      if (e > most) { most = e; coveredBy = j; }
    }
    let leastFrom: number | null = null, least = Infinity;
    for (let w0 = 0; w0 + window <= frames; w0 += window) {
      let a = 0, q = 0, k = 0;
      for (let f = w0; f < w0 + window; f++) if (playing[f]) { a += alone[f]; q += part[f]; k++; }
      if (k > window * 0.6 && q / a < least) { least = q / a; leastFrom = (w0 * EAR_HOP) / sr; }
    }
    return { playing: on / frames, share: P / Math.max(1e-9, M), heard: P / Math.max(1e-9, A), worstHz: EAR_BANDS.hz[wb], coveredBy, leastFrom };
  });
}
