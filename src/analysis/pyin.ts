// pYIN pitch tracking (Mauch & Dixon, 2014): the frame-by-frame f0 of a
// monophonic sound — a voice — and how likely each frame is to be voiced.
//
// Per frame, YIN's cumulative mean normalised difference is computed, and
// rather than taking the first dip under one fixed threshold, every
// threshold from 0.01 to 1 (weighted by a Beta(2, 18) prior) votes for the
// dip it would pick. That gives each frame a handful of pitch candidates with
// probabilities; a hidden Markov model over (pitch bin × voiced/unvoiced)
// then picks the smoothest likely path through them, which is what keeps
// octave jumps and stray voicing out.

import { hzToMidi } from "./pitch";

export interface PitchTrack {
  /** Frame i is centred on i × hopSec seconds. */
  hopSec: number;
  /** Pitch per frame as a MIDI number; NaN where unvoiced. */
  f0: Float32Array;
  /** The probability mass the thresholds gave to any pitch at all (0–1). */
  voicedProb: Float32Array;
  /** Root-mean-square level per frame (linear, of the input as given). */
  rms: Float32Array;
}

export interface PyinOptions {
  fminHz?: number;
  fmaxHz?: number;
  hopSec?: number;
}

const THRESHOLDS = 100; // 0.01, 0.02 … 1.00
const BETA_A = 2;
const BETA_B = 18;
/** Share of a threshold's vote that goes to the lowest dip when no dip is under it. */
const ABSOLUTE_MIN_WEIGHT = 0.01;
/** Pitch bins of the HMM, per semitone (20 cents each). */
const BINS_PER_SEMITONE = 5;
/** How far the pitch may move between two frames, in semitones per 5 ms. */
const MAX_JUMP_SEMITONES_PER_5MS = 2.5;
const STAY_VOICING = 0.99;
/** The analysis runs at no more than about this rate: plenty for a voice's f0, and far cheaper. */
const ANALYSIS_RATE = 16000;

const cumulativePrior = buildCumulativePrior();

/** cumulativePrior[i] = prior mass of the thresholds 0.01 … (i)/100, i = 0…100. */
function buildCumulativePrior(): Float64Array {
  const pdf = new Float64Array(THRESHOLDS);
  let total = 0;
  for (let i = 0; i < THRESHOLDS; i++) {
    const s = (i + 1) / THRESHOLDS;
    pdf[i] = s ** (BETA_A - 1) * (1 - s) ** (BETA_B - 1);
    total += pdf[i];
  }
  const cumulative = new Float64Array(THRESHOLDS + 1);
  for (let i = 0; i < THRESHOLDS; i++) cumulative[i + 1] = cumulative[i] + pdf[i] / total;
  return cumulative;
}

/** Prior mass of the thresholds s with lower < s ≤ upper. */
function priorBetween(lower: number, upper: number): number {
  const index = (s: number) => Math.min(THRESHOLDS, Math.max(0, Math.floor(s * THRESHOLDS + 1e-9)));
  return Math.max(0, cumulativePrior[index(upper)] - cumulativePrior[index(lower)]);
}

/** Low-pass and keep every `factor`-th sample (a windowed-sinc FIR). */
export function decimate(x: Float32Array, factor: number): Float32Array {
  if (factor <= 1) return x;
  const taps = 16 * factor + 1;
  const half = (taps - 1) / 2;
  const cutoff = 0.45 / factor; // of the input rate
  const h = new Float32Array(taps);
  let sum = 0;
  for (let k = 0; k < taps; k++) {
    const n = k - half;
    const sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
    const window = 0.42 - 0.5 * Math.cos((2 * Math.PI * k) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * k) / (taps - 1));
    h[k] = sinc * window;
    sum += h[k];
  }
  for (let k = 0; k < taps; k++) h[k] /= sum;
  const out = new Float32Array(Math.floor(x.length / factor));
  for (let n = 0; n < out.length; n++) {
    const centre = n * factor;
    let acc = 0;
    for (let k = 0; k < taps; k++) {
      const i = centre + k - half;
      if (i >= 0 && i < x.length) acc += h[k] * x[i];
    }
    out[n] = acc;
  }
  return out;
}

interface Candidate {
  midi: number;
  prob: number;
}

export function analyzePitch(input: Float32Array, sampleRate: number, options: PyinOptions = {}): PitchTrack {
  const fmin = options.fminHz ?? 50;
  const fmax = options.fmaxHz ?? 1000;
  const hopSec = options.hopSec ?? 0.005;

  const factor = Math.max(1, Math.floor(sampleRate / ANALYSIS_RATE));
  const x = decimate(input, factor);
  const sr = sampleRate / factor;

  const tauMin = Math.max(2, Math.floor(sr / fmax));
  const tauMax = Math.ceil(sr / fmin);
  const width = tauMax; // one period of the lowest pitch
  const frames = Math.max(0, Math.floor(input.length / sampleRate / hopSec) + 1);

  const candidates: Candidate[][] = [];
  const voicedProb = new Float32Array(frames);
  const rms = new Float32Array(frames);

  const d = new Float64Array(tauMax + 2);
  const cmnd = new Float64Array(tauMax + 2);
  const frame = new Float64Array(width + tauMax + 2);

  for (let i = 0; i < frames; i++) {
    const centre = Math.round(i * hopSec * sr);
    const start = centre - Math.floor((width + tauMax) / 2);
    for (let j = 0; j < frame.length; j++) {
      const at = start + j;
      frame[j] = at >= 0 && at < x.length ? x[at] : 0;
    }

    rms[i] = frameRms(input, Math.round(i * hopSec * sampleRate), width * factor);

    // Difference function d(τ) = Σ (x_j − x_{j+τ})², and its cumulative mean normalisation.
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      let acc = 0;
      for (let j = 0; j < width; j++) {
        const diff = frame[j] - frame[j + tau];
        acc += diff * diff;
      }
      d[tau] = acc;
    }
    cmnd[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      running += d[tau];
      cmnd[tau] = running > 1e-12 ? (d[tau] * tau) / running : 1;
    }

    // The dips (local minima) in range, in order of lag.
    const dips: number[] = [];
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (cmnd[tau] < cmnd[tau - 1] && cmnd[tau] <= cmnd[tau + 1]) dips.push(tau);
    }

    const frameCandidates: Candidate[] = [];
    let total = 0;
    if (dips.length > 0) {
      // Dip k is picked by the thresholds above its own value but at or below
      // every earlier dip's value (an earlier dip under the threshold wins).
      let earlierMin = Infinity;
      let lowest = dips[0];
      for (const tau of dips) {
        const value = cmnd[tau];
        const prob = priorBetween(value, Math.min(earlierMin, 1));
        if (prob > 0) {
          frameCandidates.push({ midi: hzToMidi(sr / refineLag(cmnd, tau)), prob });
          total += prob;
        }
        earlierMin = Math.min(earlierMin, value);
        if (value < cmnd[lowest]) lowest = tau;
      }
      // Thresholds that no dip gets under give a small share to the lowest dip.
      const unpicked = priorBetween(0, cmnd[lowest]);
      if (unpicked > 0) {
        const midi = hzToMidi(sr / refineLag(cmnd, lowest));
        const prob = unpicked * ABSOLUTE_MIN_WEIGHT;
        const same = frameCandidates.find((c) => Math.abs(c.midi - midi) < 1e-6);
        if (same) same.prob += prob;
        else frameCandidates.push({ midi, prob });
        total += prob;
      }
    }
    candidates.push(frameCandidates);
    voicedProb[i] = Math.min(1, total);
  }

  const f0 = viterbi(candidates, hzToMidi(fmin), hzToMidi(fmax), hopSec);
  return { hopSec, f0, voicedProb, rms };
}

/** The dip's lag with a parabola fitted through it and its neighbours (sub-sample). */
function refineLag(cmnd: Float64Array, tau: number): number {
  const a = cmnd[tau - 1];
  const b = cmnd[tau];
  const c = cmnd[tau + 1];
  const denominator = a - 2 * b + c;
  if (Math.abs(denominator) < 1e-12) return tau;
  const shift = (0.5 * (a - c)) / denominator;
  return Math.abs(shift) <= 1 ? tau + shift : tau;
}

function frameRms(x: Float32Array, centre: number, width: number): number {
  const start = Math.max(0, centre - (width >> 1));
  const end = Math.min(x.length, centre + (width >> 1));
  if (end <= start) return 0;
  let acc = 0;
  for (let i = start; i < end; i++) acc += x[i] * x[i];
  return Math.sqrt(acc / (end - start));
}

/** The most likely path through (pitch bin × voiced/unvoiced); its pitch per frame, NaN when unvoiced. */
function viterbi(candidates: Candidate[][], minMidi: number, maxMidi: number, hopSec: number): Float32Array {
  const frames = candidates.length;
  const out = new Float32Array(frames).fill(Number.NaN);
  if (frames === 0) return out;

  const bins = Math.ceil((maxMidi - minMidi) * BINS_PER_SEMITONE) + 1;
  const states = bins * 2; // [0, bins) voiced, [bins, 2·bins) unvoiced
  const jump = Math.max(1, Math.round(MAX_JUMP_SEMITONES_PER_5MS * BINS_PER_SEMITONE * (hopSec / 0.005)));

  // log of the triangular pitch-move weights, normalised.
  const moveLog = new Float64Array(2 * jump + 1);
  let moveTotal = 0;
  for (let k = -jump; k <= jump; k++) moveTotal += jump + 1 - Math.abs(k);
  for (let k = -jump; k <= jump; k++) moveLog[k + jump] = Math.log((jump + 1 - Math.abs(k)) / moveTotal);
  const stayLog = Math.log(STAY_VOICING);
  const switchLog = Math.log(1 - STAY_VOICING);

  const binOf = (midi: number) => Math.round((midi - minMidi) * BINS_PER_SEMITONE);
  const observation = new Float64Array(states);
  const observe = (frameCandidates: Candidate[]) => {
    let total = 0;
    observation.fill(0, 0, bins);
    for (const c of frameCandidates) {
      const bin = binOf(c.midi);
      if (bin < 0 || bin >= bins) continue;
      observation[bin] += c.prob;
      total += c.prob;
    }
    const unvoiced = Math.max(0, 1 - total) / bins;
    for (let b = 0; b < bins; b++) {
      observation[b] = Math.log(observation[b] + 1e-12);
      observation[bins + b] = Math.log(unvoiced + 1e-12);
    }
  };

  let delta = new Float64Array(states);
  let next = new Float64Array(states);
  const back = new Int32Array(frames * states);

  observe(candidates[0]);
  for (let s = 0; s < states; s++) delta[s] = observation[s] - Math.log(states);

  for (let t = 1; t < frames; t++) {
    observe(candidates[t]);
    for (let s = 0; s < states; s++) {
      const voiced = s < bins;
      const bin = voiced ? s : s - bins;
      let best = -Infinity;
      let bestFrom = 0;
      const lo = Math.max(0, bin - jump);
      const hi = Math.min(bins - 1, bin + jump);
      for (let from = lo; from <= hi; from++) {
        const move = moveLog[bin - from + jump];
        const fromVoiced = delta[from] + move + (voiced ? stayLog : switchLog);
        if (fromVoiced > best) {
          best = fromVoiced;
          bestFrom = from;
        }
        const fromUnvoiced = delta[bins + from] + move + (voiced ? switchLog : stayLog);
        if (fromUnvoiced > best) {
          best = fromUnvoiced;
          bestFrom = bins + from;
        }
      }
      next[s] = best + observation[s];
      back[t * states + s] = bestFrom;
    }
    [delta, next] = [next, delta];
  }

  let state = 0;
  for (let s = 1; s < states; s++) if (delta[s] > delta[state]) state = s;
  for (let t = frames - 1; t >= 0; t--) {
    if (state < bins) {
      // The bin centre, or — closer to the truth — the frame's own candidate in that bin.
      const centre = minMidi + state / BINS_PER_SEMITONE;
      let pitch = centre;
      let nearest = 0.5 / BINS_PER_SEMITONE + 1e-9;
      for (const c of candidates[t]) {
        const distance = Math.abs(c.midi - centre);
        if (distance <= nearest) {
          nearest = distance;
          pitch = c.midi;
        }
      }
      out[t] = pitch;
    }
    if (t > 0) state = back[t * states + state];
  }
  return out;
}
