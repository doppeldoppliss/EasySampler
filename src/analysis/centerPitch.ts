// The material's "average pitch" (平均キー) — the pitch a note is measured
// against: a note at that pitch plays the material as it is, and one a
// fifth higher shifts its whole pitch curve up a fifth.
//
// Only frames that are voiced and not near-silent count, each weighted by its
// level (the loud, held vowels are what the ear takes as "the" pitch; quiet
// tails and breaths hardly count). Three ways of summing up are offered so
// Phase 0 can compare them on real material.

import type { PitchTrack } from "./pyin";

export type CenterMethod = "median" | "mean" | "mode";

export interface CenterPitch {
  median: number;
  mean: number;
  mode: number;
  /** Seconds of the material that counted. */
  voicedSec: number;
  /** Weighted median absolute deviation from the median, in semitones: how much the pitch moves. */
  spread: number;
  /** 0–1: enough voiced material, and a pitch that holds still enough to call one. */
  confidence: number;
}

export interface CenterOptions {
  /** A frame needs at least this voicing probability. */
  minVoicedProb?: number;
  /** …and to be no more than this many dB below the loudest frame. */
  silenceDb?: number;
}

/** Histogram resolution and smoothing for the mode, in semitones. */
const MODE_BIN = 0.1;
const MODE_SMOOTH = 0.3;

export function centerPitch(track: PitchTrack, options: CenterOptions = {}): CenterPitch | null {
  const minVoicedProb = options.minVoicedProb ?? 0.5;
  const silenceDb = options.silenceDb ?? 40;

  let peak = 0;
  for (const level of track.rms) peak = Math.max(peak, level);
  const floor = peak * 10 ** (-silenceDb / 20);

  const pitches: number[] = [];
  const weights: number[] = [];
  for (let i = 0; i < track.f0.length; i++) {
    const pitch = track.f0[i];
    if (!Number.isFinite(pitch) || track.voicedProb[i] < minVoicedProb || track.rms[i] <= floor) continue;
    pitches.push(pitch);
    weights.push(track.rms[i]);
  }
  if (pitches.length === 0) return null;

  const median = weightedMedian(pitches, weights);
  const mean = weightedMean(pitches, weights);
  const mode = weightedMode(pitches, weights);
  const spread = weightedMedian(
    pitches.map((p) => Math.abs(p - median)),
    weights,
  );
  const voicedSec = pitches.length * track.hopSec;

  // Full confidence from 0.2 s of voice; less as the pitch wanders (a spread
  // of 2 semitones — a glide or a wide vibrato — halves it).
  const enough = Math.min(1, voicedSec / 0.2);
  const steady = 1 / (1 + (spread / 2) ** 2);
  return { median, mean, mode, voicedSec, spread, confidence: enough * steady };
}

export function pickCenter(center: CenterPitch, method: CenterMethod): number {
  return center[method];
}

export function weightedMedian(values: readonly number[], weights: readonly number[]): number {
  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  let total = 0;
  for (const w of weights) total += w;
  let running = 0;
  for (const i of order) {
    running += weights[i];
    if (running >= total / 2) return values[i];
  }
  return values[order[order.length - 1]];
}

export function weightedMean(values: readonly number[], weights: readonly number[]): number {
  let sum = 0;
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i] * weights[i];
    total += weights[i];
  }
  return total > 0 ? sum / total : Number.NaN;
}

/** The peak of a smoothed, weighted pitch histogram — the pitch held longest and loudest. */
export function weightedMode(values: readonly number[], weights: readonly number[]): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const reach = Math.ceil((3 * MODE_SMOOTH) / MODE_BIN);
  const bins = Math.round((hi - lo) / MODE_BIN) + 1 + 2 * reach;
  const histogram = new Float64Array(bins);
  for (let i = 0; i < values.length; i++) {
    const at = (values[i] - lo) / MODE_BIN + reach;
    const centre = Math.round(at);
    for (let b = Math.max(0, centre - reach); b <= Math.min(bins - 1, centre + reach); b++) {
      const distance = ((b - at) * MODE_BIN) / MODE_SMOOTH;
      histogram[b] += weights[i] * Math.exp(-0.5 * distance * distance);
    }
  }
  let best = 0;
  for (let b = 1; b < bins; b++) if (histogram[b] > histogram[best]) best = b;
  // Refine between bins with a parabola through the peak.
  const a = histogram[best - 1] ?? histogram[best];
  const c = histogram[best + 1] ?? histogram[best];
  const denominator = a - 2 * histogram[best] + c;
  const shift = denominator !== 0 ? (0.5 * (a - c)) / denominator : 0;
  return lo + (best - reach + (Math.abs(shift) <= 1 ? shift : 0)) * MODE_BIN;
}
