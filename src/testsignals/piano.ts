// A piano-like note built from scratch: the sound a new project starts with,
// so there is something to play before any material is opened. Additive:
// slightly stretched partials (string stiffness), two strings a hair apart
// per partial (the slow beating of a real unison), a fast first decay and a
// long aftersound with the high partials dying first, a hammer-position notch
// in the spectrum, and a short thump of filtered noise at the strike.

import { midiToHz } from "../analysis/pitch";

export interface SynthPianoOptions {
  sampleRate: number;
  /** MIDI note (default C4). */
  midi?: number;
  durationSec?: number;
  peak?: number;
}

/** Name the built-in piano goes by in the project. */
export const PIANO_NAME = "ピアノ(内蔵)";

export function synthPiano(options: SynthPianoOptions): Float32Array {
  const sr = options.sampleRate;
  const f0 = midiToHz(options.midi ?? 60);
  const duration = options.durationSec ?? 3;
  const length = Math.round(sr * duration);
  const out = new Float32Array(length);
  /** Inharmonicity: partial k sits at k·f0·√(1 + B·k²). */
  const B = 0.0003;
  /** Where the hammer strikes (share of the string): partials with a node there are weak. */
  const strike = 1 / 7.5;

  for (let k = 1; k <= 48; k++) {
    const fk = k * f0 * Math.sqrt(1 + B * k * k);
    if (fk > sr * 0.45) break;
    const amp = (1 / k ** 1.1) * (0.15 + 0.85 * Math.abs(Math.sin(Math.PI * k * strike)));
    // Two-stage decay; higher partials decay faster in both stages.
    const tauFast = 0.7 / (1 + 0.3 * (k - 1));
    const tauSlow = 4.5 / (1 + 0.18 * (k - 1));
    const fastDecay = Math.exp(-1 / (tauFast * sr));
    const slowDecay = Math.exp(-1 / (tauSlow * sr));
    // The two strings of the unison, under a cent apart and struck together, one louder than the other:
    // they beat slowly but never cancel (a full cancellation would lose the pitch for a moment).
    const detune = 0.0004;
    const w1 = (2 * Math.PI * fk * (1 - detune / 2)) / sr;
    const w2 = (2 * Math.PI * fk * (1 + detune / 2)) / sr;
    const phase = k * 0.7;
    let fast = 0.65;
    let slow = 0.35;
    for (let n = 0; n < length; n++) {
      const env = fast + slow;
      if (env < 1e-5) break;
      out[n] += amp * env * (0.65 * Math.sin(w1 * n + phase) + 0.35 * Math.sin(w2 * n + phase));
      fast *= fastDecay;
      slow *= slowDecay;
    }
  }

  // The hammer: a few milliseconds of low-passed noise.
  let seed = 0x1234567;
  let lp = 0;
  const thumpLen = Math.round(0.03 * sr);
  const a = Math.exp((-2 * Math.PI * 1800) / sr);
  for (let n = 0; n < thumpLen; n++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const noise = ((seed >>> 0) / 4294967296) * 2 - 1;
    lp = a * lp + (1 - a) * noise;
    out[n] += 0.6 * lp * Math.exp(-n / (0.006 * sr));
  }

  // A clean start and end.
  const attack = Math.round(0.002 * sr);
  const release = Math.round(0.25 * sr);
  for (let n = 0; n < attack; n++) out[n] *= n / attack;
  for (let n = 0; n < release; n++) out[length - 1 - n] *= n / release;

  let peak = 0;
  for (let n = 0; n < length; n++) peak = Math.max(peak, Math.abs(out[n]));
  const gain = peak > 0 ? (options.peak ?? 0.6) / peak : 1;
  for (let n = 0; n < length; n++) out[n] *= gain;
  return out;
}
