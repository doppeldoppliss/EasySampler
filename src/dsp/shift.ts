// What every pitch-shifting method is asked to do, so they can be swapped
// and compared (design.md 4.3 / 5.1).
//
// The target pitch at input time t is
//   target(t) = rootPitch + shift + contour × (f0(t) − rootPitch)
// so contour = 1 moves the whole pitch curve by `shift` (the default: the
// material's own inflection is kept), contour = 0 flattens it onto one pitch.

import type { PitchTrack } from "../analysis/pyin";

export interface ShiftRequest {
  input: Float32Array;
  sampleRate: number;
  track: PitchTrack;
  /** The material's reference pitch (MIDI), e.g. its weighted median. */
  rootPitch: number;
  /** Semitones to move the reference pitch by: note pitch − rootPitch. */
  shift: number;
  /** 1 = keep the inflection, 0 = flatten, >1 = exaggerate. */
  contour: number;
  /** Output length ÷ input length (1 = same length). */
  stretch: number;
}

export type ShiftMethod = "resample" | "psola" | "signalsmith";

/** The material's pitch at input time t (MIDI), linearly between frames; NaN where unvoiced. */
export function pitchAt(track: PitchTrack, t: number): number {
  const at = t / track.hopSec;
  const i = Math.floor(at);
  const a = track.f0[Math.max(0, Math.min(track.f0.length - 1, i))];
  const b = track.f0[Math.max(0, Math.min(track.f0.length - 1, i + 1))];
  if (Number.isFinite(a) && Number.isFinite(b)) return a + (b - a) * (at - i);
  return Number.isFinite(a) ? a : b;
}

/** How many semitones to move the material by at input time t (constant when contour = 1). */
export function shiftAt(request: ShiftRequest, t: number): number {
  if (request.contour === 1) return request.shift;
  const f0 = pitchAt(request.track, t);
  if (!Number.isFinite(f0)) return request.shift;
  return request.shift + (request.contour - 1) * (f0 - request.rootPitch);
}
