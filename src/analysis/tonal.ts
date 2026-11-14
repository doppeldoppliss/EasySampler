// The pitch of a mixed sound (design.md 43): a stretch of music, a chord over a
// bass, a voice over an accompaniment. The period analysis (pyin) wants one
// voice and finds none here, or a rumble under it. This looks at the spectrum
// instead: which note's harmonics hold the most of what sounds above the bass —
// per frame, and from that the stretches where one note stands clear and stays
// put ("曲が素材": where a piece of music can be cut to play as an instrument).

/** Below this the bass and the rumble are (Hz): not looked at. */
const LOW_HZ = 150;
const HIGH_HZ = 4500;
/** The rate the analysis runs at (the sound is brought down to about this). */
const WORK_RATE = 11025;
const FFT = 4096;
const WINDOW_SEC = 0.08;
const HOP_SEC = 0.02;
/** The notes tried: from about D2 to E6, a fifth of a semitone apart. */
const F0_LOW_HZ = 72;
const F0_HIGH_HZ = 1330;
const HARMONICS = 8;
const HARMONIC_FALL = 0.8;
/** A frame is "clear" from this share of its power on the note's harmonics. */
const CLEAR = 0.45;
/** …and a stretch that has begun goes on down to this. */
const CLEAR_ON = 0.3;
/** A stretch holds its note within this (semitones), and is at least this long. */
const HOLD_SEMITONES = 0.4;
const MIN_STRETCH_SEC = 0.08;
/** Frames this far under the loudest (dB) are not counted. */
const QUIET_DB = 22;

export interface TonalFrame {
  /** The frame's middle (seconds). */
  time: number;
  /** The note (MIDI, with cents), NaN where nothing sounds. */
  midi: number;
  /** 0–1: how much of the power above the bass lies on that note's harmonics. */
  clarity: number;
  levelDb: number;
}

export interface TonalStretch {
  start: number;
  end: number;
  midi: number;
  clarity: number;
}

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len >> 1; k++) {
        const p = i + k;
        const q = p + (len >> 1);
        const xr = re[q] * cr - im[q] * ci;
        const xi = re[q] * ci + im[q] * cr;
        re[q] = re[p] - xr;
        im[q] = im[p] - xi;
        re[p] += xr;
        im[p] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/** The sound at about WORK_RATE: averaged over the step, then every step-th sample (what folds back lies over 5 kHz, and is weak). */
function broughtDown(x: Float32Array, sampleRate: number): { y: Float32Array; rate: number } {
  const step = Math.max(1, Math.floor(sampleRate / WORK_RATE));
  if (step === 1) return { y: x, rate: sampleRate };
  const y = new Float32Array(Math.floor(x.length / step));
  for (let i = 0; i < y.length; i++) {
    let sum = 0;
    for (let k = 0; k < step; k++) sum += x[i * step + k];
    y[i] = sum / step;
  }
  return { y, rate: sampleRate / step };
}

/** Frame by frame over [from, to) seconds: the note whose harmonics hold the most, and how clearly. */
export function tonalFrames(x: Float32Array, sampleRate: number, from = 0, to = Infinity): TonalFrame[] {
  const { y, rate } = broughtDown(x, sampleRate);
  const window = Math.min(FFT, Math.round(WINDOW_SEC * rate));
  const hop = Math.round(HOP_SEC * rate);
  const binHz = rate / FFT;
  const lo = Math.ceil(LOW_HZ / binHz);
  const hi = Math.min((FFT >> 1) - 3, Math.floor(HIGH_HZ / binHz));
  const hann = Float64Array.from({ length: window }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / window));
  const re = new Float64Array(FFT);
  const im = new Float64Array(FFT);
  const power = new Float64Array(FFT >> 1);
  const mag = new Float64Array(FFT >> 1);
  // (A tone through this window is a hump about 4 / window wide: what counts as "on the harmonic".)
  const reach = Math.max(2, Math.round(1.5 / (window / rate) / binHz));
  const frames: TonalFrame[] = [];
  const first = Math.max(0, Math.round(from * rate));
  const last = Math.min(y.length, Math.round(Math.min(to, y.length / rate) * rate)) - window;
  for (let at = first; at <= last; at += hop) {
    re.fill(0);
    im.fill(0);
    let energy = 0;
    for (let i = 0; i < window; i++) {
      re[i] = y[at + i] * hann[i];
      energy += y[at + i] * y[at + i];
    }
    const levelDb = 10 * Math.log10(energy / window + 1e-12);
    const time = (at + window / 2) / rate;
    fft(re, im);
    let total = 0;
    for (let b = lo - 2; b <= hi + 2; b++) {
      power[b] = re[b] * re[b] + im[b] * im[b];
      mag[b] = Math.sqrt(power[b]);
      if (b >= lo && b <= hi) total += power[b];
    }
    if (total <= 1e-14) {
      frames.push({ time, midi: NaN, clarity: 0, levelDb });
      continue;
    }
    // The note whose harmonics (above the bass) weigh the most, the lower ones counting more: an octave under
    // finds the same peaks at twice the harmonic numbers, and so less.
    let best = 0;
    let bestHz = 0;
    for (let f0 = F0_LOW_HZ; f0 <= F0_HIGH_HZ; f0 *= 2 ** (0.2 / 12)) {
      let sum = 0;
      let weight = 1;
      for (let h = 1; h <= HARMONICS; h++, weight *= HARMONIC_FALL) {
        const b = Math.round((h * f0) / binHz);
        if (b < lo) continue;
        if (b > hi) break;
        sum += weight * Math.max(mag[b - 1], mag[b], mag[b + 1]);
      }
      if (sum > best) {
        best = sum;
        bestHz = f0;
      }
    }
    // Finer: each harmonic's own peak (its top between three bins), divided by its number; the strong ones count more.
    let fine = 0;
    let fineWeight = 0;
    let on = 0;
    for (let h = 1; h <= HARMONICS; h++) {
      let b = Math.round((h * bestHz) / binHz);
      if (b < lo) continue;
      if (b > hi) break;
      if (mag[b - 1] > mag[b]) b--;
      else if (mag[b + 1] > mag[b]) b++;
      for (let k = Math.max(lo, b - reach); k <= Math.min(hi, b + reach); k++) on += power[k];
      const a = power[b - 1];
      const c = power[b + 1];
      const peak = power[b];
      if (peak > a && peak >= c && a > 0 && c > 0) {
        const shift = (0.5 * (Math.log(a) - Math.log(c))) / (Math.log(a) - 2 * Math.log(peak) + Math.log(c));
        fine += (mag[b] * (b + shift) * binHz) / h;
        fineWeight += mag[b];
      }
    }
    const hz = fineWeight > 0 ? fine / fineWeight : bestHz;
    frames.push({ time, midi: 69 + 12 * Math.log2(hz / 440), clarity: Math.min(1, on / total), levelDb });
  }
  return frames;
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1];

/** The note over [from, to): the middle one of the frames that are clear and loud enough. null when nothing stands clear. */
export function tonalPitch(x: Float32Array, sampleRate: number, from: number, to: number): { midi: number; clarity: number } | null {
  const frames = tonalFrames(x, sampleRate, from, to).filter((f) => Number.isFinite(f.midi));
  if (!frames.length) return null;
  const loud = Math.max(...frames.map((f) => f.levelDb));
  const clear = frames.filter((f) => f.clarity >= CLEAR && f.levelDb >= loud - QUIET_DB);
  if (clear.length < Math.max(1, frames.length * 0.25)) return null;
  const midi = median(clear.map((f) => f.midi));
  const near = clear.filter((f) => Math.abs(f.midi - midi) <= 1);
  return { midi: median(near.map((f) => f.midi)), clarity: near.reduce((a, f) => a + f.clarity, 0) / frames.length };
}

/** The same note an octave apart counts as the same (the estimate hops between them as the harmonics' balance moves). */
const foldedApart = (a: number, b: number) => Math.abs(((a - b + 6 + 1200) % 12) - 6);

/** The stretches where one note stands clear and holds, the clearest and longest first (at most `limit`). */
export function tonalStretches(x: Float32Array, sampleRate: number, limit = 12): TonalStretch[] {
  const frames = tonalFrames(x, sampleRate);
  if (!frames.length) return [];
  const loud = Math.max(...frames.map((f) => f.levelDb));
  const heard = (f: TonalFrame) => Number.isFinite(f.midi) && f.levelDb >= loud - QUIET_DB;
  const found: (TonalStretch & { score: number })[] = [];
  let i = 0;
  while (i < frames.length) {
    // A stretch starts on a clear frame and goes on while the note holds (in any octave) and stays fairly clear.
    if (!heard(frames[i]) || frames[i].clarity < CLEAR) {
      i++;
      continue;
    }
    let j = i + 1;
    const first = frames[i].midi;
    while (j < frames.length && heard(frames[j]) && frames[j].clarity >= CLEAR_ON && foldedApart(frames[j].midi, first) <= HOLD_SEMITONES) j++;
    // (Its end: the last clear frame.)
    while (j > i + 1 && frames[j - 1].clarity < CLEAR) j--;
    const start = frames[i].time - HOP_SEC / 2;
    const end = frames[j - 1].time + HOP_SEC / 2;
    if (end - start >= MIN_STRETCH_SEC) {
      const run = frames.slice(i, j);
      // The octave most of its frames are in.
      const octaves = new Map<number, number>();
      for (const f of run) octaves.set(Math.round((f.midi - first) / 12), (octaves.get(Math.round((f.midi - first) / 12)) ?? 0) + f.clarity);
      const octave = [...octaves].sort((a, b) => b[1] - a[1])[0][0];
      const midi = median(run.filter((f) => Math.round((f.midi - first) / 12) === octave).map((f) => f.midi));
      const clarity = run.reduce((a, f) => a + f.clarity, 0) / run.length;
      found.push({ start, end, midi, clarity, score: clarity * Math.min(1, (end - start) / 0.3) });
    }
    i = j;
  }
  return found
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ start, end, midi, clarity }) => ({ start, end, midi, clarity }));
}
