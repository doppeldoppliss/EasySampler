// A sung vowel built from scratch, for the tests and as the demo material
// before anything is loaded: a harmonic series whose amplitudes follow a
// fixed vowel envelope (formants), so the pitch can move while the timbre —
// the spectral envelope — stays put, exactly as with a real voice. Knowing
// both the true pitch curve and the true envelope is what lets the tests
// check the analysis and the pitch shifting against the truth.

import { midiToHz } from "../analysis/pitch";

export interface Formant {
  hz: number;
  bandwidthHz: number;
  gainDb: number;
}

/** /a/, roughly an adult voice. */
export const VOWEL_A: Formant[] = [
  { hz: 800, bandwidthHz: 80, gainDb: 0 },
  { hz: 1200, bandwidthHz: 90, gainDb: -4 },
  { hz: 2500, bandwidthHz: 120, gainDb: -14 },
  { hz: 3500, bandwidthHz: 150, gainDb: -22 },
];

/** Linear amplitude of the vowel's spectral envelope at a frequency. */
export function envelopeAt(hz: number, formants: readonly Formant[] = VOWEL_A): number {
  let amplitude = 0;
  for (const f of formants) {
    const x = (hz - f.hz) / (f.bandwidthHz / 2);
    amplitude += 10 ** (f.gainDb / 20) / (1 + x * x);
  }
  // The glottal source's roll-off (−12 dB/octave above ~100 Hz), plus a little floor.
  const tilt = 1 / (1 + (hz / 100) ** 2) ** 0.5;
  return (amplitude + 0.02) * tilt;
}

export interface SynthVoiceOptions {
  sampleRate: number;
  durationSec: number;
  /** Pitch (MIDI) at each moment, seconds → MIDI. */
  pitch: (t: number) => number;
  formants?: readonly Formant[];
  /** Fade in and out over this long, as a sung note would. */
  fadeSec?: number;
  peak?: number;
}

export function synthVoice(options: SynthVoiceOptions): Float32Array {
  const { sampleRate, durationSec, pitch } = options;
  const formants = options.formants ?? VOWEL_A;
  const fade = options.fadeSec ?? 0.03;
  const length = Math.round(sampleRate * durationSec);
  const out = new Float32Array(length);
  let phase = 0; // in cycles of the fundamental
  for (let n = 0; n < length; n++) {
    const t = n / sampleRate;
    const f0 = midiToHz(pitch(t));
    phase += f0 / sampleRate;
    const cycle = phase - Math.floor(phase);
    let sample = 0;
    const harmonics = Math.floor(sampleRate / 2 / f0);
    for (let k = 1; k <= harmonics; k++) {
      sample += envelopeAt(k * f0, formants) * Math.sin(2 * Math.PI * k * cycle);
    }
    const gain = Math.min(1, t / fade, (durationSec - t) / fade);
    out[n] = sample * Math.max(0, gain);
  }
  return normalize(out, options.peak ?? 0.5);
}

/** A natural-ish phrase: a scoop up into the note, a held tone with vibrato, a fall at the end. */
export function demoPhrasePitch(baseMidi: number, durationSec: number): (t: number) => number {
  return (t) => {
    const scoop = -1.5 * Math.exp(-t / 0.06);
    const vibratoDepth = 0.35 * Math.min(1, Math.max(0, (t - 0.25) / 0.3));
    const vibrato = vibratoDepth * Math.sin(2 * Math.PI * 5.5 * t);
    const fall = -2 * Math.max(0, (t - (durationSec - 0.2)) / 0.2) ** 2;
    return baseMidi + scoop + vibrato + fall;
  };
}

/**
 * A spoken-like syllable "sa": a hiss (the consonant, unvoiced) running into
 * a sung /a/ with a scoop, vibrato and a falling end — head, sustain and tail
 * for the synthesis markers to find. Deterministic (seeded noise).
 */
export function demoSyllable(sampleRate: number, baseMidi = 62): Float32Array {
  const hissSec = 0.09;
  const vowelSec = 0.75;
  const vowel = synthVoice({ sampleRate, durationSec: vowelSec, pitch: demoPhrasePitch(baseMidi, vowelSec), fadeSec: 0.02 });
  const hissLength = Math.round(hissSec * sampleRate);
  const out = new Float32Array(hissLength + vowel.length);
  let seed = 12345;
  let previous = 0;
  for (let n = 0; n < hissLength; n++) {
    seed = (seed * 16807) % 2147483647;
    const white = seed / 2147483647 - 0.5;
    const high = white - previous; // a first difference: the hiss lives up high
    previous = white;
    const envelope = Math.sin((Math.PI * n) / hissLength) ** 0.5;
    out[n] = high * envelope * 0.35;
  }
  out.set(vowel, hissLength);
  return out;
}

export function normalize(x: Float32Array, peak: number): Float32Array {
  let max = 0;
  for (const v of x) max = Math.max(max, Math.abs(v));
  if (max > 0) for (let i = 0; i < x.length; i++) x[i] *= peak / max;
  return x;
}
