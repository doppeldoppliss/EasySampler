// ピークを丸める (design.md 45): a soft clip — the sound as it is up to a height, and a rounded shoulder over it —
// and how high to set it for a song: the few peaks (the drums' first milliseconds) that stand far over the rest
// are what keeps a mix thin beside a finished song at one loudness; rounding them brings the peak nearer the
// loudness (the "density") without a compressor's pumping (a compressor lets those peaks through and pulls the
// rest down: measured on two songs, it made the gap wider).

import { integratedLoudness, truePeak } from "../audio/loudness";

/** How far over the knee the shoulder ends, as a share of the knee (0.35: the ceiling is 2.6 dB over the knee). */
export const CLIP_ROOM = 0.35;

/** A sample through the soft clip: straight up to `knee` (linear), a tanh shoulder from there to knee × (1 + CLIP_ROOM). */
export function softClip(x: number, knee: number): number {
  const a = x < 0 ? -x : x;
  if (a <= knee) return x;
  const room = knee * CLIP_ROOM;
  const y = knee + room * Math.tanh((a - knee) / room);
  return x < 0 ? -y : y;
}

export interface Rounding {
  /** Where the rounding starts (dBFS). */
  thresholdDb: number;
  /** The peak over the loudness (dB: true peak − integrated LUFS) before and after. */
  beforePlr: number;
  afterPlr: number;
  /** How far under the highest sample it starts (dB). */
  underPeakDb: number;
}

const dB = (x: number) => 20 * Math.log10(Math.max(1e-12, x));

/**
 * Where to start rounding a mix so that its peak stands `targetPlr` dB over its loudness: knees tried from the
 * highest sample down in 0.5 dB steps, no further than `maxUnderPeakDb` (past about 5 dB the clip is on tens of
 * peaks a second and begins to be heard). Null when the mix is silent or there already.
 */
export function roundingFor(left: Float32Array, right: Float32Array, sampleRate: number, targetPlr: number, maxUnderPeakDb: number): Rounding | null {
  let peak = 0;
  for (let i = 0; i < left.length; i++) {
    const a = Math.max(Math.abs(left[i]), Math.abs(right[i]));
    if (a > peak) peak = a;
  }
  const lufs = integratedLoudness(left, right, sampleRate);
  if (!(peak > 0) || !Number.isFinite(lufs)) return null;
  // (By the true peak, as the export's ceiling and a meter take it: rounded, the wave between the samples stands
  // about 1 dB over the samples, and by the samples alone a song came out 1.2 dB short of what was said.)
  const beforePlr = dB(truePeak(left, right)) - lufs;
  if (beforePlr <= targetPlr) return null;
  const l = new Float32Array(left.length);
  const r = new Float32Array(right.length);
  let best: Rounding | null = null;
  for (let under = 0.5; under <= maxUnderPeakDb + 1e-9; under += 0.5) {
    const knee = peak * 10 ** (-under / 20);
    for (let i = 0; i < left.length; i++) {
      l[i] = softClip(left[i], knee);
      r[i] = softClip(right[i], knee);
    }
    const afterPlr = dB(truePeak(l, r)) - integratedLoudness(l, r, sampleRate);
    best = { thresholdDb: Math.round(dB(knee) * 10) / 10, beforePlr, afterPlr, underPeakDb: under };
    if (afterPlr <= targetPlr) break;
  }
  return best;
}
