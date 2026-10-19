// The material's root pitch (基準ピッチ): the pitch a note is measured
// against. A note at the root plays the material at its own pitch; a note a
// fifth higher moves it up a fifth.
//
// A weighted median in semitones over the voiced frames. Each frame weighs
// by how loud it is, how surely voiced, and how steady its pitch is — a held
// vowel is what the ear takes as "the" pitch, while scoops, falls and
// breaths hardly count. Within a sustain region (when one is given) frames
// weigh more still: a gliding sound is heard at the pitch it settles on.

import type { PitchTrack } from "./pyin";

export interface RootPitch {
  /** MIDI number with cents (61.63 = D4 −37¢). */
  midi: number;
  /** Seconds of material that counted. */
  voicedSec: number;
  /** Weighted median absolute deviation from the root, in semitones. */
  spread: number;
  /** 0–1: enough voice, and a pitch that holds still enough to call one. */
  confidence: number;
}

export interface RootOptions {
  /** Only frames within [from, to) seconds count (default: all). */
  from?: number;
  to?: number;
  /** Frames within this span (seconds) count this many times more (default ×3). */
  emphasis?: { start: number; end: number; weight?: number };
  /** Frames more than this many dB below the loudest are ignored. */
  silenceDb?: number;
}

/** Pitch slope (semitones/second) at which a frame's steadiness weight halves. */
const STEADY_SLOPE = 12;
const MIN_VOICED_PROB = 0.5;

export function rootPitch(track: PitchTrack, options: RootOptions = {}): RootPitch | null {
  const hop = track.hopSec;
  const first = Math.max(0, Math.floor((options.from ?? 0) / hop));
  const last = Math.min(track.f0.length, options.to === undefined ? track.f0.length : Math.ceil(options.to / hop));

  let peak = 0;
  for (let i = first; i < last; i++) peak = Math.max(peak, track.rms[i]);
  const floor = peak * 10 ** (-(options.silenceDb ?? 40) / 20);

  const values: number[] = [];
  const weights: number[] = [];
  for (let i = first; i < last; i++) {
    const pitch = track.f0[i];
    if (!Number.isFinite(pitch) || track.voicedProb[i] < MIN_VOICED_PROB || track.rms[i] <= floor) continue;
    const before = track.f0[i - 1];
    const after = track.f0[i + 1];
    let slope = 0;
    if (Number.isFinite(before) && Number.isFinite(after)) slope = Math.abs(after - before) / (2 * hop);
    else if (Number.isFinite(before)) slope = Math.abs(pitch - before) / hop;
    else if (Number.isFinite(after)) slope = Math.abs(after - pitch) / hop;
    const steady = 1 / (1 + (slope / STEADY_SLOPE) ** 2);
    const t = i * hop;
    const emphasis = options.emphasis && t >= options.emphasis.start && t < options.emphasis.end ? (options.emphasis.weight ?? 3) : 1;
    values.push(pitch);
    weights.push(track.rms[i] * track.voicedProb[i] * steady * emphasis);
  }
  if (values.length === 0) return null;

  const midi = weightedMedian(values, weights);
  const spread = weightedMedian(
    values.map((v) => Math.abs(v - midi)),
    weights,
  );
  const voicedSec = values.length * hop;
  // Full confidence from 0.15 s of voice; less as the pitch wanders (a spread of 2 semitones halves it).
  const confidence = Math.min(1, voicedSec / 0.15) / (1 + (spread / 2) ** 2);
  return { midi, voicedSec, spread, confidence };
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
