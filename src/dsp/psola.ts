// TD-PSOLA (time-domain pitch-synchronous overlap-add): the voice is cut
// into grains, one per glottal pulse (two periods long, centred on the
// pulse), and laid back down at the spacing of the target pitch. Each grain
// keeps its own waveform — the vocal tract's response — so the formants stay
// where they were and the voice keeps its character; only the pulse rate
// changes. Because every grain can be spaced differently, a pitch that moves
// over time (contour ≠ 1) costs nothing extra.
//
// Unvoiced stretches (consonants, breath) have no pulses: they're cut into
// fixed 5 ms grains and laid back unchanged, which reconstructs them exactly
// (a Hann window overlapping itself by half sums to one).

import { midiToHz } from "../analysis/pitch";
import type { PitchTrack } from "../analysis/pyin";
import { pitchAt, shiftAt, type ShiftRequest } from "./shift";

export interface PitchMarks {
  /** Sample positions, ascending. */
  positions: number[];
  /** Whether each mark is a glottal pulse (true) or a fixed-step mark in an unvoiced stretch. */
  voiced: boolean[];
}

const UNVOICED_STEP_SEC = 0.005;
/** A voiced stretch shorter than this many periods is treated as unvoiced. */
const MIN_VOICED_PERIODS = 2;
/** Where the next pulse is looked for, either side of one period on, as a share of the period. */
const SEARCH_SHARE = 0.2;

/** The voiced stretches of the track, as sample ranges [start, end). */
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

export function findPitchMarks(x: Float32Array, sampleRate: number, track: PitchTrack): PitchMarks {
  const positions: number[] = [];
  const voiced: boolean[] = [];
  const step = Math.round(UNVOICED_STEP_SEC * sampleRate);
  const periodAt = (n: number) => {
    const midi = pitchAt(track, n / sampleRate);
    return Number.isFinite(midi) ? sampleRate / midiToHz(midi) : Number.NaN;
  };

  const addUnvoiced = (from: number, to: number) => {
    let at = positions.length ? positions[positions.length - 1] + step : from;
    for (; at < to; at += step) {
      positions.push(at);
      voiced.push(false);
    }
  };

  let cursor = 0;
  for (const [from, to] of voicedRanges(track, sampleRate, x.length)) {
    const firstPeriod = periodAt(from + 1);
    if (!Number.isFinite(firstPeriod) || to - from < MIN_VOICED_PERIODS * firstPeriod) continue;
    addUnvoiced(cursor, from);

    // The pulses point one way (up or down) throughout a stretch: follow
    // whichever way the biggest excursion goes.
    let max = 0;
    let min = 0;
    for (let n = from; n < to; n++) {
      max = Math.max(max, x[n]);
      min = Math.min(min, x[n]);
    }
    const sign = max >= -min ? 1 : -1;

    // The first pulse: the biggest peak within the first period after the
    // last mark has had room (no closer than half a period to it).
    let searchFrom = from;
    if (positions.length) searchFrom = Math.max(from, positions[positions.length - 1] + Math.round(firstPeriod / 2));
    let mark = peak(x, sign, searchFrom, Math.min(to, searchFrom + Math.round(firstPeriod)));
    while (mark < to) {
      positions.push(mark);
      voiced.push(true);
      const period = periodAt(mark);
      if (!Number.isFinite(period)) break;
      const expected = mark + period;
      const reach = SEARCH_SHARE * period;
      const lo = Math.max(mark + 1, Math.round(expected - reach));
      const hi = Math.round(expected + reach);
      // A window cut short by the stretch's end would pick a false peak at its edge.
      if (hi >= to) break;
      mark = peak(x, sign, lo, hi + 1);
    }
    cursor = to;
  }
  addUnvoiced(cursor, x.length);
  return { positions, voiced };
}

/** Index of the largest sign·x[n] for n in [from, to). */
function peak(x: Float32Array, sign: number, from: number, to: number): number {
  let best = from;
  for (let n = from + 1; n < to; n++) if (sign * x[n] > sign * x[best]) best = n;
  return best;
}

/** x at a fractional position (linear interpolation; zero outside). */
function sampleAt(x: Float32Array, position: number): number {
  const i = Math.floor(position);
  const f = position - i;
  const a = i >= 0 && i < x.length ? x[i] : 0;
  const b = i + 1 >= 0 && i + 1 < x.length ? x[i + 1] : 0;
  return a + (b - a) * f;
}

export function psolaShift(request: ShiftRequest, marks?: PitchMarks): Float32Array {
  const { input: x, sampleRate, stretch } = request;
  const { positions, voiced } = marks ?? findPitchMarks(x, sampleRate, request.track);
  const out = new Float32Array(Math.round(x.length * stretch));
  if (positions.length === 0) return out;

  const nearestMark = (position: number) => {
    let lo = 0;
    let hi = positions.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (positions[mid] < position) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && position - positions[lo - 1] < positions[lo] - position) lo--;
    return lo;
  };

  let ts = positions[0] * stretch; // output position of the next grain's centre
  while (ts < out.length) {
    const k = nearestMark(ts / stretch);
    const m = positions[k];
    // Each half of the grain reaches to the neighbouring mark.
    const left = k > 0 ? m - positions[k - 1] : positions[k + 1] - m || 1;
    const right = k < positions.length - 1 ? positions[k + 1] - m : left;
    const period = (left + right) / 2;

    let spacing = period;
    let gain = 1;
    if (voiced[k]) {
      const sourcePitch = sampleRate / period;
      const target = midiToHz(Math.log2(sourcePitch / 440) * 12 + 69 + shiftAt(request, m / sampleRate));
      spacing = sampleRate / target;
      // Pulses closer together carry more power (and further apart, less):
      // scale each grain so the loudness stays where it was.
      gain = Math.sqrt(spacing / period);
    }

    const first = Math.max(0, Math.ceil(ts - left));
    const last = Math.min(out.length - 1, Math.floor(ts + right));
    for (let n = first; n <= last; n++) {
      const d = n - ts;
      const w = d < 0 ? 0.5 + 0.5 * Math.cos((Math.PI * d) / left) : 0.5 + 0.5 * Math.cos((Math.PI * d) / right);
      out[n] += gain * w * sampleAt(x, m + d);
    }
    ts += Math.max(1, spacing);
  }
  return out;
}
