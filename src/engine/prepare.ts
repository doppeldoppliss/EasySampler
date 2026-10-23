// Turning a loaded material into what the engine plays: analysed once (pitch
// track, pitch marks, root, suggested markers), then resampled to the
// engine's rate with the marks moved along. Runs in the analysis Worker.

import { findPitchMarks, pitchAt, type PitchMarks } from "../analysis/pitchMarks";
import { analyzePitch, type PitchTrack } from "../analysis/pyin";
import { rootPitch, type RootPitch } from "../analysis/rootPitch";
import { suggestMarkers } from "../instrument/markers";
import type { Markers } from "../instrument/types";
import type { PreparedSource } from "./engine";

export interface MaterialAnalysis {
  sampleRate: number;
  durationSec: number;
  track: PitchTrack;
  marks: PitchMarks;
  markers: Markers;
  /** Root pitch weighted toward the suggested sustain; null if nothing is pitched. */
  root: RootPitch | null;
}

export function mixToMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const mono = new Float32Array(channels[0].length);
  for (const channel of channels) for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / channels.length;
  return mono;
}

/** Analyses the material; with `givenTrack` (a corrected one) the pitch tracking is skipped and the marks found from it. */
export function analyzeMaterial(channels: readonly Float32Array[], sampleRate: number, givenTrack?: PitchTrack): MaterialAnalysis {
  const mono = mixToMono(channels);
  const durationSec = mono.length / sampleRate;
  const track = givenTrack ?? analyzePitch(mono, sampleRate);
  // Marks from the mid signal, shared by both channels (no wandering stereo image).
  const marks = findPitchMarks(mono, sampleRate, track);
  const markers = suggestMarkers(track, durationSec);
  const root = rootForMarkers(track, markers);
  return { sampleRate, durationSec, track, marks, markers, root };
}

/** The root over the used range, leaning on the sustain (what the ear takes as the pitch). */
export function rootForMarkers(track: PitchTrack, markers: Markers): RootPitch | null {
  return rootPitch(track, {
    from: markers.rangeStart,
    to: markers.rangeEnd,
    emphasis: { start: markers.sustainStart, end: markers.sustainEnd, weight: 3 },
  });
}

/** The material at the engine's rate, with the marks and their pitches. */
export function prepareSource(channels: readonly Float32Array[], analysis: MaterialAnalysis, targetRate: number): PreparedSource {
  const ratio = targetRate / analysis.sampleRate;
  const resampled = channels.slice(0, 2).map((c) => (ratio === 1 ? c.slice() : resample(c, ratio)));
  const count = analysis.marks.positions.length;
  const marks = new Float64Array(count);
  const f0 = new Float32Array(count);
  for (let k = 0; k < count; k++) {
    const position = analysis.marks.positions[k];
    marks[k] = position * ratio;
    f0[k] = analysis.marks.voiced[k] ? pitchAt(analysis.track, position / analysis.sampleRate) : Number.NaN;
  }
  return { sampleRate: targetRate, channels: resampled, marks, voiced: analysis.marks.voiced.slice(), f0 };
}

/** Cubic-interpolated sample-rate change (ratio = new rate ÷ old rate), low-passed first when going down. */
export function resample(x: Float32Array, ratio: number): Float32Array {
  const source = ratio < 1 ? lowPass(x, 0.45 * ratio) : x;
  const out = new Float32Array(Math.floor(x.length * ratio));
  for (let n = 0; n < out.length; n++) {
    const position = n / ratio;
    const i = Math.floor(position);
    const f = position - i;
    const at = (k: number) => (k >= 0 && k < source.length ? source[k] : 0);
    const y0 = at(i - 1);
    const y1 = at(i);
    const y2 = at(i + 1);
    const y3 = at(i + 2);
    out[n] = ((((0.5 * (y3 - y0) + 1.5 * (y1 - y2)) * f + (y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3)) * f + 0.5 * (y2 - y0)) * f) + y1;
  }
  return out;
}

/** Windowed-sinc low-pass; cutoff as a share of the sample rate. */
function lowPass(x: Float32Array, cutoff: number): Float32Array {
  const taps = 63;
  const half = (taps - 1) / 2;
  const h = new Float32Array(taps);
  let sum = 0;
  for (let k = 0; k < taps; k++) {
    const n = k - half;
    const sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
    h[k] = sinc * (0.42 - 0.5 * Math.cos((2 * Math.PI * k) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * k) / (taps - 1)));
    sum += h[k];
  }
  const out = new Float32Array(x.length);
  for (let n = 0; n < x.length; n++) {
    let acc = 0;
    for (let k = 0; k < taps; k++) {
      const i = n + k - half;
      if (i >= 0 && i < x.length) acc += h[k] * x[i];
    }
    out[n] = acc / sum;
  }
  return out;
}
