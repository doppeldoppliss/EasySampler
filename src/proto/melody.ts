// Phase 0: the test phrases the material is fitted to, and laying the fitted
// notes out on a timeline. Each note is shifted on its own (no cache) so the
// measured time is what that many notes really cost.

import type { PitchTrack } from "../analysis/pyin";
import type { ShiftMethod, ShiftRequest } from "../dsp/shift";

export interface TestNote {
  startSec: number;
  durSec: number;
  /** MIDI */
  pitch: number;
}

export type PatternId = "single" | "scale" | "wide" | "melody";

export const PATTERNS: { id: PatternId; label: string }[] = [
  { id: "single", label: "単音(指定した高さ)" },
  { id: "scale", label: "長音階(基準付近から1オクターブ)" },
  { id: "wide", label: "大きな移調(−12〜+12)" },
  { id: "melody", label: "短いメロディ(かえるの歌)" },
];

/** The test phrase, pitched around the material's own pitch so the shifts stay modest. */
export function patternNotes(id: PatternId, rootPitch: number, singlePitch: number, beatSec: number): TestNote[] {
  const tonic = Math.round(rootPitch);
  const steps = (intervals: number[], beats: number[] = intervals.map(() => 1)) => {
    let at = 0;
    return intervals.map((interval, i) => {
      const note = { startSec: at * beatSec, durSec: beats[i] * beatSec, pitch: tonic + interval };
      at += beats[i];
      return note;
    });
  };
  switch (id) {
    case "single":
      return [{ startSec: 0, durSec: 2 * beatSec, pitch: singlePitch }];
    case "scale":
      return steps([0, 2, 4, 5, 7, 9, 11, 12]);
    case "wide":
      return steps([-12, -7, 0, 7, 12], [2, 2, 2, 2, 2]);
    case "melody":
      // A German folk song (public domain): ドレミファミレド ミファソラソファミ.
      return steps([0, 2, 4, 5, 4, 2, 0, 4, 5, 7, 9, 7, 5, 4], [1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 2]);
  }
}

export type LengthMode = "oneshot" | "stretch";

export interface Material {
  samples: Float32Array;
  sampleRate: number;
  track: PitchTrack;
  rootPitch: number;
}

export interface RenderSettings {
  contour: number;
  lengthMode: LengthMode;
}

export type Shifter = (request: ShiftRequest) => Float32Array | Promise<Float32Array>;

export interface RenderResult {
  method: ShiftMethod;
  audio: Float32Array;
  /** Wall-clock time spent shifting (ms). */
  elapsedMs: number;
  /** Seconds of audio the notes produced. */
  producedSec: number;
}

const NOTE_END_FADE_SEC = 0.012;

export async function renderNotes(
  method: ShiftMethod,
  shifter: Shifter,
  material: Material,
  notes: readonly TestNote[],
  settings: RenderSettings,
): Promise<RenderResult> {
  const { sampleRate } = material;
  const materialSec = material.samples.length / sampleRate;
  const endSec = Math.max(...notes.map((n) => n.startSec + Math.max(n.durSec, materialSec)));
  const out = new Float32Array(Math.ceil((endSec + 0.5) * sampleRate));
  let elapsedMs = 0;
  let producedSec = 0;

  for (const note of notes) {
    const stretch = settings.lengthMode === "stretch" ? note.durSec / materialSec : 1;
    const request: ShiftRequest = {
      input: material.samples,
      sampleRate,
      track: material.track,
      rootPitch: material.rootPitch,
      shift: note.pitch - material.rootPitch,
      contour: settings.contour,
      stretch,
    };
    const started = performance.now();
    const shifted = await shifter(request);
    elapsedMs += performance.now() - started;
    producedSec += shifted.length / sampleRate;

    // One-shot: the note's end cuts the sound (with a short fade); a stretched note already fits.
    const length = Math.min(shifted.length, Math.round(note.durSec * sampleRate));
    const fade = Math.round(NOTE_END_FADE_SEC * sampleRate);
    const offset = Math.round(note.startSec * sampleRate);
    for (let i = 0; i < length && offset + i < out.length; i++) {
      const gain = Math.min(1, (length - i) / fade);
      out[offset + i] += shifted[i] * gain;
    }
  }
  return { method, audio: out, elapsedMs, producedSec };
}
