// What a rendered note sounds like, as numbers (tools/eval): the things a
// listener would notice, measured — pitch accuracy and wobble, the vibrato
// as it came out, the level's attack / hold / fade, the tone's brightness
// and noisiness, and the unpleasant things: clicks, clipping, buzzing
// amplitude modulation (roughness), hiss, DC, a bad loop seam. Pure
// functions over a mono Float32Array, so they can be tested and reused.

import { analyzePitch, type PitchTrack } from "../../src/analysis/pyin";

export interface PitchMetrics {
  /** Frames with a pitch, as a share of the frames in the window. */
  voicedShare: number;
  /** Median and 90th-percentile error from the target, in cents (NaN when nothing is voiced). */
  medianCents: number;
  p90AbsCents: number;
  /** Standard deviation of the pitch around its own median, in cents (wobble, vibrato included). */
  spreadCents: number;
  /** The strongest periodic wobble between 2 and 12 Hz: its rate and half the peak-to-peak depth, in cents. */
  vibratoHz: number;
  vibratoCents: number;
}

export interface LevelMetrics {
  peak: number;
  rms: number;
  /** Seconds until the envelope first reaches 90 % of its level in the first 250 ms (how fast the note arrives). */
  attackSec: number;
  /** Relative deviation (std ÷ mean) of the envelope over the sustain window (or the middle half of the sound when none is given). */
  holdUnevenness: number;
  /** Seconds from the last time the envelope was above 70 % of its maximum to the end of sound (how the note leaves). */
  fadeOutSec: number;
  /** Seconds of near-silence at the end of the buffer. */
  trailingSilenceSec: number;
  dcOffset: number;
  /** Seconds the sound lasts (to the last sample above the silence floor). */
  soundingSec: number;
}

export interface ToneMetrics {
  /** Spectral centroid (Hz): median, over the first and the last fifth of the sounding part. */
  centroidHz: number;
  centroidStartHz: number;
  centroidEndHz: number;
  /** Share of the energy in 2–5 kHz (where harshness lives) and above 8 kHz (hiss). */
  harshBand: number;
  hissBand: number;
  /** Spectral flatness, median over frames: 0 = pure tone … 1 = white noise. */
  flatness: number;
}

export interface ArtefactMetrics {
  /** Sample-to-sample jumps far above the local level, outside the first / last 5 ms. */
  clicks: { count: number; firstSec: number[] };
  clippedSamples: number;
  /**
   * Amplitude modulation of the envelope in the roughness range (20–200 Hz): the
   * strongest modulation's rate and depth (0–1). Grains repeating at a fixed rate,
   * or a bad pool, show up here as a buzz.
   */
  amRoughness: { hz: number; depth: number };
  /** Slower modulation (2–20 Hz): tremolo or a loop pumping. */
  amSlow: { hz: number; depth: number };
  /** Gaps: stretches inside the sounding part that fall below 5 % of the median level, longer than 15 ms. */
  dropouts: { count: number; longestMs: number };
}

export interface SeamMetrics {
  /** The waveform step across the loop seam, relative to the local RMS (0 = seamless). */
  stepRelative: number;
  /** The envelope jump across the seam, relative (0 = none). */
  levelJumpRelative: number;
}

export interface Report {
  sampleRate: number;
  durationSec: number;
  pitch: PitchMetrics;
  level: LevelMetrics;
  tone: ToneMetrics;
  artefacts: ArtefactMetrics;
  seam: SeamMetrics | null;
  /** Human-readable findings, worst first. */
  warnings: string[];
}

const SILENCE = 1e-4;

export function mixMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const c of channels) for (let i = 0; i < out.length; i++) out[i] += c[i] / channels.length;
  return out;
}

/** RMS per hop, with a window of `winSec`. */
export function envelope(x: Float32Array, sampleRate: number, winSec = 0.01, hopSec = 0.005): { values: Float32Array; hopSec: number } {
  const win = Math.max(1, Math.round(winSec * sampleRate));
  const hop = Math.max(1, Math.round(hopSec * sampleRate));
  const n = Math.max(1, Math.floor((x.length - win) / hop) + 1);
  const values = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const from = i * hop;
    for (let j = from; j < from + win; j++) s += x[j] * x[j];
    values[i] = Math.sqrt(s / win);
  }
  return { values, hopSec: hop / sampleRate };
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
}

/** The strongest sinusoidal component of a series between loHz and hiHz, by a plain DFT: its rate and amplitude. */
function dominantModulation(series: Float32Array, rate: number, loHz: number, hiHz: number): { hz: number; amplitude: number } {
  const n = series.length;
  if (n < 8) return { hz: 0, amplitude: 0 };
  let mean = 0;
  for (const v of series) mean += v;
  mean /= n;
  let bestHz = 0;
  let best = 0;
  const steps = 160;
  for (let s = 0; s <= steps; s++) {
    const hz = loHz * (hiHz / loHz) ** (s / steps);
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const ph = (2 * Math.PI * hz * i) / rate;
      const v = series[i] - mean;
      re += v * Math.cos(ph);
      im -= v * Math.sin(ph);
    }
    const amplitude = (2 * Math.sqrt(re * re + im * im)) / n;
    if (amplitude > best) {
      best = amplitude;
      bestHz = hz;
    }
  }
  return { hz: bestHz, amplitude: best };
}

export function pitchMetrics(x: Float32Array, sampleRate: number, targetMidi: number, fromSec: number, toSec: number): PitchMetrics {
  const a = Math.max(0, Math.round(fromSec * sampleRate));
  const b = Math.min(x.length, Math.round(toSec * sampleRate));
  const empty: PitchMetrics = { voicedShare: 0, medianCents: Number.NaN, p90AbsCents: Number.NaN, spreadCents: Number.NaN, vibratoHz: 0, vibratoCents: 0 };
  if (b - a < sampleRate * 0.05) return empty;
  const track: PitchTrack = analyzePitch(x.slice(a, b), sampleRate);
  const cents: number[] = [];
  const series = new Float32Array(track.f0.length);
  for (let i = 0; i < track.f0.length; i++) {
    const f = track.f0[i];
    if (Number.isFinite(f) && track.voicedProb[i] > 0.5) {
      cents.push((f - targetMidi) * 100);
      series[i] = (f - targetMidi) * 100;
    } else series[i] = Number.NaN;
  }
  if (cents.length === 0) return empty;
  const med = median(cents);
  const spread = Math.sqrt(cents.reduce((s, c) => s + (c - med) * (c - med), 0) / cents.length);
  // The vibrato: the deviation series with gaps filled by the median, searched between 2 and 12 Hz.
  const filled = Float32Array.from(series, (v) => (Number.isFinite(v) ? v : med));
  const mod = dominantModulation(filled, 1 / track.hopSec, 2, 12);
  return {
    voicedShare: cents.length / track.f0.length,
    medianCents: med,
    p90AbsCents: percentile(cents.map((c) => Math.abs(c - 0)), 0.9),
    spreadCents: spread,
    vibratoHz: mod.amplitude > 3 ? mod.hz : 0,
    vibratoCents: mod.amplitude > 3 ? mod.amplitude : 0,
  };
}

export function levelMetrics(x: Float32Array, sampleRate: number, sustain?: { fromSec: number; toSec: number }): LevelMetrics {
  const env = envelope(x, sampleRate);
  const v = env.values;
  let peak = 0;
  let sum = 0;
  let dc = 0;
  for (const s of x) {
    const a = Math.abs(s);
    if (a > peak) peak = a;
    sum += s * s;
    dc += s;
  }
  const rms = Math.sqrt(sum / Math.max(1, x.length));
  let last = x.length - 1;
  while (last > 0 && Math.abs(x[last]) < SILENCE) last--;
  const soundingSec = (last + 1) / sampleRate;
  const max = Math.max(...v);
  const earlyHops = Math.max(1, Math.round(0.25 / env.hopSec));
  const early = Math.max(...v.subarray(0, Math.min(v.length, earlyHops)));
  let attack = v.findIndex((e) => e >= 0.9 * early);
  if (attack < 0) attack = 0;
  const soundingHops = Math.min(v.length, Math.ceil(soundingSec / env.hopSec));
  let lastLoud = 0;
  for (let i = 0; i < soundingHops; i++) if (v[i] >= 0.7 * max) lastLoud = i;
  const midFrom = sustain ? Math.min(soundingHops - 1, Math.floor(sustain.fromSec / env.hopSec)) : Math.floor(soundingHops * 0.25);
  const midTo = Math.max(midFrom + 1, sustain ? Math.min(soundingHops, Math.floor(sustain.toSec / env.hopSec)) : Math.floor(soundingHops * 0.75));
  const mid = Array.from(v.subarray(midFrom, midTo));
  const mean = mid.reduce((s, e) => s + e, 0) / mid.length;
  const std = Math.sqrt(mid.reduce((s, e) => s + (e - mean) * (e - mean), 0) / mid.length);
  return {
    peak,
    rms,
    attackSec: attack * env.hopSec,
    holdUnevenness: mean > 0 ? std / mean : 0,
    fadeOutSec: Math.max(0, soundingSec - lastLoud * env.hopSec),
    trailingSilenceSec: x.length / sampleRate - soundingSec,
    dcOffset: dc / Math.max(1, x.length),
    soundingSec,
  };
}

/** Magnitude spectrum of one frame (Hann), bins 0..n/2. */
function spectrum(x: Float32Array, from: number, n: number): Float32Array {
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let i = 0; i < n; i++) re[i] = (x[from + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  fft(re, im);
  const mag = new Float32Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
  return mag;
}

/** In-place radix-2 FFT (n a power of two). */
export function fft(re: Float32Array, im: Float32Array): void {
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
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j];
        const ui = im[i + j];
        const vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ur + vr;
        im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr;
        im[i + j + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

export function toneMetrics(x: Float32Array, sampleRate: number, soundingSec: number): ToneMetrics {
  const n = 2048;
  const hop = 512;
  const frames = Math.max(1, Math.floor((Math.min(x.length, Math.round(soundingSec * sampleRate)) - n) / hop) + 1);
  const centroids: number[] = [];
  const flat: number[] = [];
  let harsh = 0;
  let hiss = 0;
  let total = 0;
  const hzOf = (k: number) => (k * sampleRate) / n;
  for (let f = 0; f < frames; f++) {
    const mag = spectrum(x, f * hop, n);
    let num = 0;
    let den = 0;
    let logSum = 0;
    let linSum = 0;
    for (let k = 1; k < mag.length; k++) {
      const p = mag[k] * mag[k];
      const hz = hzOf(k);
      num += hz * p;
      den += p;
      total += p;
      if (hz >= 2000 && hz < 5000) harsh += p;
      if (hz >= 8000) hiss += p;
      logSum += Math.log(mag[k] + 1e-12);
      linSum += mag[k];
    }
    if (den > 1e-9) {
      centroids.push(num / den);
      flat.push(Math.exp(logSum / (mag.length - 1)) / (linSum / (mag.length - 1) + 1e-12));
    }
  }
  const fifth = Math.max(1, Math.floor(centroids.length / 5));
  return {
    centroidHz: median(centroids),
    centroidStartHz: median(centroids.slice(0, fifth)),
    centroidEndHz: median(centroids.slice(-fifth)),
    harshBand: total > 0 ? harsh / total : 0,
    hissBand: total > 0 ? hiss / total : 0,
    flatness: median(flat),
  };
}

export function artefactMetrics(x: Float32Array, sampleRate: number, soundingSec: number): ArtefactMetrics {
  const env = envelope(x, sampleRate, 0.004, 0.002);
  const guard = Math.round(0.005 * sampleRate);
  const end = Math.min(x.length, Math.round(soundingSec * sampleRate));
  // Clicks: a jump between neighbours far above the jumps the signal makes around there
  // (the first difference's own RMS, so a tone's slope and a noise's grit set their own bar).
  const diff = new Float32Array(x.length);
  for (let i = 1; i < x.length; i++) diff[i] = x[i] - x[i - 1];
  // The reference spans several periods (20 ms), so a waveform's own steep edge, which repeats every period, is "typical".
  const diffEnv = envelope(diff, sampleRate, 0.02, 0.002);
  const firstSec: number[] = [];
  let count = 0;
  for (let i = guard + 1; i < end - guard; i++) {
    const jump = Math.abs(diff[i]);
    const typical = diffEnv.values[Math.min(diffEnv.values.length - 1, Math.floor(i / sampleRate / diffEnv.hopSec))];
    if (jump > Math.max(0.01, 8 * typical)) {
      count++;
      if (firstSec.length < 5) firstSec.push(i / sampleRate);
      i += guard; // one click, not its every sample
    }
  }
  let clipped = 0;
  for (let i = 0; i < end; i++) if (Math.abs(x[i]) >= 0.999) clipped++;
  // Amplitude modulation of the envelope, in the roughness range and below it.
  const soundingHops = Math.min(env.values.length, Math.floor(soundingSec / env.hopSec));
  const from = Math.floor(soundingHops * 0.2);
  const to = Math.floor(soundingHops * 0.9);
  const part = env.values.subarray(from, Math.max(from + 8, to));
  let mean = 0;
  for (const v of part) mean += v;
  mean /= Math.max(1, part.length);
  const rough = dominantModulation(part, 1 / env.hopSec, 20, 200);
  const slow = dominantModulation(part, 1 / env.hopSec, 2, 20);
  // Dropouts: stretches far below the median level.
  const med = median(Array.from(part));
  let dropouts = 0;
  let longest = 0;
  let run = 0;
  for (let i = from; i < to; i++) {
    if (env.values[i] < 0.05 * med) run++;
    else {
      if (run * env.hopSec > 0.015) {
        dropouts++;
        longest = Math.max(longest, run * env.hopSec);
      }
      run = 0;
    }
  }
  return {
    clicks: { count, firstSec },
    clippedSamples: clipped,
    amRoughness: { hz: rough.hz, depth: mean > 0 ? Math.min(1, rough.amplitude / mean) : 0 },
    amSlow: { hz: slow.hz, depth: mean > 0 ? Math.min(1, slow.amplitude / mean) : 0 },
    dropouts: { count: dropouts, longestMs: longest * 1000 },
  };
}

export function seamMetrics(x: Float32Array, sampleRate: number, loopStart: number, loopEnd: number): SeamMetrics {
  const env = envelope(x, sampleRate, 0.01, 0.005);
  const at = (i: number) => env.values[Math.min(env.values.length - 1, Math.floor(i / sampleRate / env.hopSec))];
  const local = Math.max(1e-6, (at(loopStart) + at(loopEnd - 1)) / 2);
  // Wrapping: the sample after the loop's end is followed by the loop's first sample.
  const step = Math.abs((x[loopEnd] ?? x[loopEnd - 1]) - x[loopStart]) / local;
  const jump = Math.abs(at(loopEnd - 1) - at(loopStart)) / local;
  return { stepRelative: step, levelJumpRelative: jump };
}

export interface ReportOptions {
  targetMidi: number;
  /** Where the sustain is, in output seconds (the pitch is measured there). */
  sustainFromSec: number;
  sustainToSec: number;
  loop?: { start: number; end: number } | null;
  /** Whether a vibrato / tremolo was asked for (so wobble isn't a warning). */
  vibratoExpected?: boolean;
}

export function report(channels: readonly Float32Array[], sampleRate: number, options: ReportOptions): Report {
  const x = mixMono(channels);
  const level = levelMetrics(x, sampleRate, { fromSec: options.sustainFromSec, toSec: options.sustainToSec });
  const pitch = pitchMetrics(x, sampleRate, options.targetMidi, options.sustainFromSec, Math.min(options.sustainToSec, level.soundingSec));
  const tone = toneMetrics(x, sampleRate, level.soundingSec);
  const artefacts = artefactMetrics(x, sampleRate, level.soundingSec);
  const seam = options.loop ? seamMetrics(x, sampleRate, options.loop.start, options.loop.end) : null;
  const warnings: string[] = [];
  if (artefacts.clippedSamples > 0) warnings.push(`クリッピング: ${artefacts.clippedSamples} サンプル`);
  if (artefacts.clicks.count > 0) warnings.push(`クリック(段差): ${artefacts.clicks.count} 個(最初は ${artefacts.clicks.firstSec.map((s) => s.toFixed(3) + " s").join(", ")})`);
  if (artefacts.amRoughness.depth > 0.15) warnings.push(`ざらつき: 振幅が ${artefacts.amRoughness.hz.toFixed(0)} Hz で ${(artefacts.amRoughness.depth * 100).toFixed(0)}% 変調(ブザー感)`);
  if (artefacts.dropouts.count > 0) warnings.push(`途切れ: ${artefacts.dropouts.count} 回(最長 ${artefacts.dropouts.longestMs.toFixed(0)} ms)`);
  if (Number.isFinite(pitch.medianCents) && Math.abs(pitch.medianCents) > 20) warnings.push(`音程のずれ: 中央値 ${pitch.medianCents.toFixed(0)}¢`);
  if (!options.vibratoExpected && Number.isFinite(pitch.spreadCents) && pitch.spreadCents > 30) warnings.push(`音程のゆらぎ: ±${pitch.spreadCents.toFixed(0)}¢`);
  if (pitch.voicedShare < 0.6 && options.sustainToSec - options.sustainFromSec > 0.2) warnings.push(`持続部の音程が取れない区間が多い(${(pitch.voicedShare * 100).toFixed(0)}% だけ有声)`);
  if (tone.hissBand > 0.1) warnings.push(`高域のシャー音: 8 kHz 以上が ${(tone.hissBand * 100).toFixed(0)}%`);
  if (tone.harshBand > 0.5) warnings.push(`耳に痛い帯域(2–5 kHz)が ${(tone.harshBand * 100).toFixed(0)}%`);
  if (Math.abs(level.dcOffset) > 0.01) warnings.push(`DC オフセット ${level.dcOffset.toFixed(3)}`);
  if (level.holdUnevenness > 0.25 && !options.vibratoExpected) warnings.push(`音量がふらつく: 持続部で ±${(level.holdUnevenness * 100).toFixed(0)}%`);
  if (seam && (seam.stepRelative > 0.5 || seam.levelJumpRelative > 0.3)) warnings.push(`ループの継ぎ目に段差(波形 ${seam.stepRelative.toFixed(2)}、音量 ${seam.levelJumpRelative.toFixed(2)})`);
  return { sampleRate, durationSec: x.length / sampleRate, pitch, level, tone, artefacts, seam, warnings };
}
