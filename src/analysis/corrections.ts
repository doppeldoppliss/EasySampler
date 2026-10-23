// Hand corrections to the pitch analysis (design.md 3, 解析結果の手直し):
// a stretch of the track is moved an octave, shifted by cents (a fifth
// or harmonic lock), set to one note, or declared unvoiced / voiced
// (VocalShifter's ピッチ誤検出修正). They are kept as a list and re-applied to the original analysis
// whenever they change, so each one can be undone, and the pitch marks are
// found again from the corrected track (an octave error moves every mark).

import type { PitchTrack } from "./pyin";

export type CorrectionKind = "octave-up" | "octave-down" | "shift" | "set" | "unvoiced" | "voiced";

export interface PitchCorrection {
  /** Seconds within the material. */
  start: number;
  end: number;
  kind: CorrectionKind;
  /** "shift": how far, in cents (+ up). */
  cents?: number;
  /** "set": the MIDI note (with a fraction) every frame in the stretch becomes. */
  midi?: number;
}

/** The track with the corrections applied, in order. The input is left as it is. */
export function applyCorrections(track: PitchTrack, corrections: readonly PitchCorrection[]): PitchTrack {
  const f0 = track.f0.slice();
  const voicedProb = track.voicedProb.slice();
  const hop = track.hopSec;
  for (const c of corrections) {
    const from = Math.max(0, Math.floor(c.start / hop));
    const to = Math.min(f0.length, Math.ceil(c.end / hop));
    if (to <= from) continue;
    switch (c.kind) {
      case "octave-up":
      case "octave-down": {
        const delta = c.kind === "octave-up" ? 12 : -12;
        for (let i = from; i < to; i++) if (Number.isFinite(f0[i])) f0[i] += delta;
        break;
      }
      case "shift": {
        const delta = (c.cents ?? 0) / 100;
        for (let i = from; i < to; i++) if (Number.isFinite(f0[i])) f0[i] += delta;
        break;
      }
      case "set": {
        // One pitch over the stretch, pitched or not (a consonant locked to the vowel's note, say).
        const midi = c.midi;
        if (midi === undefined || !Number.isFinite(midi)) break;
        for (let i = from; i < to; i++) {
          f0[i] = midi;
          voicedProb[i] = Math.max(voicedProb[i], 0.9);
        }
        break;
      }
      case "unvoiced":
        for (let i = from; i < to; i++) {
          f0[i] = Number.NaN;
          voicedProb[i] = 0;
        }
        break;
      case "voiced": {
        // Where pYIN gave no pitch, borrow it: linearly between the nearest pitched frames, or the nearest one.
        let before = from - 1;
        while (before >= 0 && !Number.isFinite(f0[before])) before--;
        for (let i = from; i < to; i++) {
          if (Number.isFinite(f0[i])) {
            before = i;
            voicedProb[i] = Math.max(voicedProb[i], 0.9);
            continue;
          }
          let after = i + 1;
          while (after < f0.length && !Number.isFinite(f0[after])) after++;
          const a = before >= 0 ? f0[before] : Number.NaN;
          const b = after < f0.length ? f0[after] : Number.NaN;
          if (Number.isFinite(a) && Number.isFinite(b)) f0[i] = a + ((b - a) * (i - before)) / (after - before);
          else if (Number.isFinite(a)) f0[i] = a;
          else if (Number.isFinite(b)) f0[i] = b;
          else continue; // nothing pitched anywhere: can't invent one
          voicedProb[i] = 0.9;
        }
        break;
      }
    }
  }
  return { hopSec: hop, f0, voicedProb, rms: track.rms };
}

export const CORRECTION_LABELS: Record<CorrectionKind, string> = {
  "octave-up": "オクターブ上",
  "octave-down": "オクターブ下",
  shift: "ずらす",
  set: "音名に",
  unvoiced: "無声に",
  voiced: "有声に",
};

/** "+10¢", "D4 に", "オクターブ上": one correction as text. */
export function correctionLabel(c: PitchCorrection, noteName: (midi: number) => string): string {
  if (c.kind === "shift") {
    const cents = Math.round(c.cents ?? 0);
    return Math.abs(cents) >= 100 && cents % 100 === 0 ? `${cents > 0 ? "+" : ""}${cents / 100} 半音` : `${cents > 0 ? "+" : ""}${cents}¢`;
  }
  if (c.kind === "set") return `${noteName(c.midi ?? 60)} に`;
  return CORRECTION_LABELS[c.kind];
}
