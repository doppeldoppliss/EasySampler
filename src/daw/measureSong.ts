// What a measuring render job works out from the samples (design.md 38), the same in the render worker and on the
// page where no worker can be made: loudness, peaks, the third-octave bands, width; and, when asked, where a soft
// clip would start (ピークを丸める) and the excitation in both ears (the 埋もれ diagnosis, design.md 50).

import { integratedLoudness, stereoImage, truePeak } from "../audio/loudness";
import { earPattern, type EarPattern } from "../audio/ear";
import { bandSpectrum } from "../fx/balance";
import { roundingFor, type Rounding } from "../fx/clip";
import type { RenderedSong } from "./songRender";

export interface RenderMeasure {
  /** Integrated loudness (LUFS; −Infinity when silent). */
  lufs: number;
  /** The highest sample and the true peak (dBFS / dBTP). */
  peakDb: number;
  truePeakDb: number;
  /** Third-octave band levels (BAND_HZ), null when silent. */
  bands: number[] | null;
  /** How wide it is (stereoImage). */
  correlation: number;
  sideDb: number;
  /** The left against the right over 400 Hz (dB, + = left), and the side against the mid there. */
  balanceDb: number;
  sideUpDb: number;
  /** Asked for with `rounding`: where a soft clip would start to bring the peak that near the loudness (null: none needed). */
  rounding?: Rounding | null;
  /** Asked for with `ear`: the excitation in both ears (audio/ear.ts). */
  ear?: EarPattern;
}

/** ピークを丸める for this peak over the loudness, no further under the peak than this. */
export interface RoundingAsk {
  targetPlr: number;
  maxUnderPeakDb: number;
}

/** What a measuring job may also work out. */
export interface MeasureAsk {
  rounding?: RoundingAsk;
  ear?: boolean;
}

const dB = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

export function measureSong(song: RenderedSong, ask: MeasureAsk = {}): RenderMeasure {
  const [l, r] = song.channels;
  let peak = 0;
  for (const c of song.channels) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
  return {
    lufs: integratedLoudness(l, r, song.sampleRate),
    peakDb: dB(peak),
    truePeakDb: dB(truePeak(l, r)),
    bands: bandSpectrum(song.channels, song.sampleRate),
    ...stereoImage(l, r, song.sampleRate),
    ...(ask.rounding ? { rounding: roundingFor(l, r, song.sampleRate, ask.rounding.targetPlr, ask.rounding.maxUnderPeakDb) } : {}),
    ...(ask.ear ? { ear: earPattern(l, r, song.sampleRate) } : {}),
  };
}
