// Pitch marks (ピッチマーク): one point per glottal pulse, at the same phase
// of every period — what TD-PSOLA cuts its grains around.
//
// Cross-correlation tracking, as Praat's "To PointProcess (cc)": seed each
// voiced stretch at its loudest point near the middle, then step left and
// right one period at a time, each time picking — between 0.8 and 1.2
// periods on — the point whose surrounding period best matches the previous
// one's (refined to a fraction of a sample). Matching whole waveforms rather
// than picking peaks keeps the marks on the same phase even when the peaks
// wander (noise, reverb, compression), which is what PSOLA's quality hangs
// on. Points that match poorly (correlation < 0.3) are dropped, and gaps of
// about two periods are filled.
//
// Unvoiced stretches get marks on a fixed 5 ms grid; PSOLA plays those back
// unchanged.

import { midiToHz } from "./pitch";
import type { PitchTrack } from "./pyin";

export interface PitchMarks {
  /** Sample positions (fractional), ascending. */
  positions: Float64Array;
  /** 1 where the mark is a glottal pulse, 0 for a grid mark in an unvoiced stretch. */
  voiced: Uint8Array;
}

export const UNVOICED_STEP_SEC = 0.005;
const MIN_CORRELATION = 0.3;
/** A voiced stretch shorter than this many periods is left unvoiced. */
const MIN_PERIODS = 2;

/** The track's pitch at a time (MIDI), linearly between frames; NaN where unvoiced. */
export function pitchAt(track: PitchTrack, t: number): number {
  const at = t / track.hopSec;
  const i = Math.floor(at);
  const clamp = (k: number) => Math.max(0, Math.min(track.f0.length - 1, k));
  const a = track.f0[clamp(i)];
  const b = track.f0[clamp(i + 1)];
  if (Number.isFinite(a) && Number.isFinite(b)) return a + (b - a) * (at - i);
  return Number.isFinite(a) ? a : b;
}

/** The voiced stretches of the track, as sample ranges [from, to). */
function voicedRanges(track: PitchTrack, sampleRate: number, length: number): [number, number][] {
  const ranges: [number, number][] = [];
  const hop = track.hopSec * sampleRate;
  let start = -1;
  for (let i = 0; i <= track.f0.length; i++) {
    const voiced = i < track.f0.length && Number.isFinite(track.f0[i]);
    if (voiced && start < 0) start = i;
    if (!voiced && start >= 0) {
      const from = Math.max(0, Math.round((start - 0.5) * hop));
      const to = Math.min(length, Math.round((i - 0.5) * hop));
      if (to > from) ranges.push([from, to]);
      start = -1;
    }
  }
  return ranges;
}

/** Normalised correlation of the windows x[a−half … a+half] and x[b−half … b+half]. */
function correlation(x: Float32Array, a: number, b: number, half: number): number {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let k = -half; k <= half; k++) {
    const u = x[a + k] ?? 0;
    const v = x[b + k] ?? 0;
    ab += u * v;
    aa += u * u;
    bb += v * v;
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

interface Point {
  position: number;
  correlation: number;
}

/** The marks of one voiced stretch, by cross-correlation tracking from its middle outward. */
function trackStretch(x: Float32Array, from: number, to: number, periodAt: (n: number) => number): Point[] {
  const middle = Math.round((from + to) / 2);
  const middlePeriod = periodAt(middle);
  if (!Number.isFinite(middlePeriod) || to - from < MIN_PERIODS * middlePeriod) return [];

  // Seed: the largest excursion within half a period of the middle.
  let seed = middle;
  const reach = Math.round(middlePeriod / 2);
  for (let n = Math.max(from, middle - reach); n <= Math.min(to - 1, middle + reach); n++) {
    if (Math.abs(x[n]) > Math.abs(x[seed])) seed = n;
  }

  const step = (direction: 1 | -1): Point[] => {
    const points: Point[] = [];
    let previous = seed;
    for (;;) {
      const period = periodAt(previous);
      if (!Number.isFinite(period)) break;
      const half = Math.round(period / 2);
      const near = previous + direction * Math.ceil(0.8 * period);
      const far = previous + direction * Math.floor(1.2 * period);
      // Stop once the window around a candidate would leave the stretch.
      if (Math.min(near, far) - half < from || Math.max(near, far) + half >= to) break;
      const lo = Math.min(near, far);
      const hi = Math.max(near, far);
      const scores = new Float64Array(hi - lo + 1);
      let best = 0;
      for (let c = lo; c <= hi; c++) {
        scores[c - lo] = correlation(x, previous, c, half);
        if (scores[c - lo] > scores[best]) best = c - lo;
      }
      // Sub-sample refinement through the peak and its neighbours.
      let fraction = 0;
      if (best > 0 && best < scores.length - 1) {
        const a = scores[best - 1];
        const b = scores[best];
        const c = scores[best + 1];
        const denominator = a - 2 * b + c;
        if (denominator < 0) fraction = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denominator));
      }
      const position = lo + best + fraction;
      points.push({ position, correlation: scores[best] });
      previous = lo + best;
    }
    return points;
  };

  const left = step(-1).reverse();
  const right = step(1);
  return [...left, { position: seed, correlation: 1 }, ...right];
}

/** Drop poorly matching points, then fill gaps of about two or more periods and drop points far too close. */
function tidy(points: Point[], periodAt: (n: number) => number): number[] {
  const kept = points.filter((p) => p.correlation >= MIN_CORRELATION).map((p) => p.position);
  const out: number[] = [];
  for (const position of kept) {
    const previous = out[out.length - 1];
    if (previous === undefined) {
      out.push(position);
      continue;
    }
    const period = periodAt((previous + position) / 2);
    const gap = position - previous;
    if (!Number.isFinite(period)) {
      out.push(position);
    } else if (gap < 0.6 * period) {
      continue; // a doubled point
    } else if (gap > 1.6 * period && gap < 4.5 * period) {
      // A missed pulse or two (a dropped point): put them back, evenly.
      const missing = Math.round(gap / period) - 1;
      for (let k = 1; k <= missing; k++) out.push(previous + (gap * k) / (missing + 1));
      out.push(position);
    } else {
      out.push(position);
    }
  }
  return out;
}

export function findPitchMarks(x: Float32Array, sampleRate: number, track: PitchTrack): PitchMarks {
  const periodAt = (n: number) => {
    const midi = pitchAt(track, n / sampleRate);
    return Number.isFinite(midi) ? sampleRate / midiToHz(midi) : Number.NaN;
  };
  const step = Math.round(UNVOICED_STEP_SEC * sampleRate);
  const positions: number[] = [];
  const voiced: number[] = [];

  const fillUnvoiced = (until: number) => {
    let at = positions.length ? positions[positions.length - 1] + step : 0;
    for (; at < until - step / 2; at += step) {
      positions.push(at);
      voiced.push(0);
    }
  };

  for (const [from, to] of voicedRanges(track, sampleRate, x.length)) {
    const marks = tidy(trackStretch(x, from, to, periodAt), periodAt);
    if (marks.length < MIN_PERIODS) continue;
    fillUnvoiced(marks[0]);
    for (const mark of marks) {
      if (positions.length && mark <= positions[positions.length - 1]) continue;
      positions.push(mark);
      voiced.push(1);
    }
  }
  fillUnvoiced(x.length);
  return { positions: Float64Array.from(positions), voiced: Uint8Array.from(voiced) };
}
