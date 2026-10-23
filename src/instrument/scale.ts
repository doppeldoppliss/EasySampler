// Scales for 音階に合わせる (VocalShifter's クオンタイズ / 自動補正): every
// frame's pitch lands on the nearest note of a scale instead of on one root.

export type ScaleId = "chromatic" | "major" | "minor" | "pentatonic";

/** Semitones above the key. */
const INTERVALS: Record<ScaleId, readonly number[]> = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 2, 4, 7, 9],
};

export const SCALE_LABELS: Record<ScaleId, string> = {
  chromatic: "半音階(最寄りの半音)",
  major: "長調",
  minor: "短調(自然的)",
  pentatonic: "ペンタトニック(メジャー)",
};

export const KEY_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** The scale note (MIDI) nearest to `midi`, in `scale` on `key` (0 = C … 11 = B); ties go up. */
export function quantizeToScale(midi: number, scale: ScaleId, key: number): number {
  if (!Number.isFinite(midi)) return midi;
  const steps = INTERVALS[scale];
  const rel = midi - key;
  const octave = Math.floor(rel / 12);
  let best = Number.NaN;
  let bestDistance = Infinity;
  for (let o = octave - 1; o <= octave + 1; o++) {
    for (const step of steps) {
      const candidate = o * 12 + step;
      const distance = Math.abs(candidate - rel);
      if (distance < bestDistance || (distance === bestDistance && candidate > best)) {
        bestDistance = distance;
        best = candidate;
      }
    }
  }
  return best + key;
}
