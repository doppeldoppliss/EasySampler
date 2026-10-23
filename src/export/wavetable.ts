// A wavetable for Vital (design.md 5, Phase 3): single periods of the
// material's sustain, each resampled to 2048 samples, laid end to end in
// one WAV. Vital's "Import as Wavetable" reads frames of 2048 samples
// (Serum and others follow the same convention), so the material's own
// timbre — one period at a time, in order — becomes a wavetable position to
// sweep through, without going through Pitch Splice.
//
// Every frame starts at a pitch mark (the glottal pulse), so the frames are
// phase-aligned and the sweep between them is smooth.

import type { PreparedSource } from "../engine/engine";
import type { Markers } from "../instrument/types";

export const FRAME_SIZE = 2048;
export const MAX_FRAMES = 256;

export interface Wavetable {
  /** FRAME_SIZE × frames samples, mono. */
  samples: Float32Array;
  frames: number;
}

/**
 * The periods inside the sustain region (or, when there are too few there,
 * the whole range), thinned evenly to at most `maxFrames`. Null when the
 * material has no two voiced marks to cut a period from.
 */
export function buildWavetable(source: PreparedSource, markers: Markers, maxFrames = MAX_FRAMES): Wavetable | null {
  const rate = source.sampleRate;
  const mono = source.channels.length > 1 ? mix(source.channels) : source.channels[0];
  const periods = voicedPeriods(source, markers.sustainStart * rate, markers.sustainEnd * rate);
  const chosen = periods.length >= 2 ? periods : voicedPeriods(source, markers.rangeStart * rate, markers.rangeEnd * rate);
  if (chosen.length === 0) return null;
  const frames = Math.min(maxFrames, chosen.length);
  const samples = new Float32Array(FRAME_SIZE * frames);
  for (let f = 0; f < frames; f++) {
    // Spread the frames evenly over the periods when there are more periods than frames.
    const [from, to] = chosen[Math.floor((f * chosen.length) / frames)];
    const frame = samples.subarray(f * FRAME_SIZE, (f + 1) * FRAME_SIZE);
    const length = to - from;
    let mean = 0;
    for (let i = 0; i < FRAME_SIZE; i++) {
      frame[i] = cubic(mono, from + (i / FRAME_SIZE) * length);
      mean += frame[i];
    }
    mean /= FRAME_SIZE;
    let peak = 0;
    for (let i = 0; i < FRAME_SIZE; i++) {
      frame[i] -= mean; // no DC offset in a cycle
      peak = Math.max(peak, Math.abs(frame[i]));
    }
    if (peak > 0) for (let i = 0; i < FRAME_SIZE; i++) frame[i] *= 0.9 / peak;
  }
  return { samples, frames };
}

/** [start, end) sample positions of each period between consecutive voiced marks within [from, to). */
function voicedPeriods(source: PreparedSource, from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  const marks = source.marks;
  for (let k = 0; k + 1 < marks.length; k++) {
    if (marks[k] < from || marks[k + 1] > to) continue;
    if (!source.voiced[k] || !source.voiced[k + 1]) continue;
    const length = marks[k + 1] - marks[k];
    // A period between 20 Hz and 2 kHz; anything else is a mark error.
    if (length < source.sampleRate / 2000 || length > source.sampleRate / 20) continue;
    out.push([marks[k], marks[k + 1]]);
  }
  return out;
}

function mix(channels: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(channels[0].length);
  for (const c of channels) for (let i = 0; i < out.length; i++) out[i] += c[i] / channels.length;
  return out;
}

function cubic(x: Float32Array, position: number): number {
  const i = Math.floor(position);
  const f = position - i;
  const at = (k: number) => (k >= 0 && k < x.length ? x[k] : 0);
  const y0 = at(i - 1);
  const y1 = at(i);
  const y2 = at(i + 1);
  const y3 = at(i + 2);
  const c1 = 0.5 * (y2 - y0);
  const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
  const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
  return ((c3 * f + c2) * f + c1) * f + y1;
}
