import { describe, expect, it } from "vitest";
import { quantizeToScale } from "./scale";

describe("quantizeToScale", () => {
  it("lands on the nearest scale note, in any octave, ties up", () => {
    expect(quantizeToScale(61.4, "chromatic", 0)).toBe(61);
    expect(quantizeToScale(61.5, "chromatic", 0)).toBe(62);
    // C major: C# (61) → C (60) or D (62): 61.2 → D? no: |61.2−60| = 1.2, |61.2−62| = 0.8 → D.
    expect(quantizeToScale(61.2, "major", 0)).toBe(62);
    expect(quantizeToScale(60.8, "major", 0)).toBe(60);
    // E major (E F# G# A B C# D#): 61.94 → C#4 (61) is 0.94 away, D#4 (63) 1.06 → C#4.
    expect(quantizeToScale(61.94, "major", 4)).toBe(61);
    // A minor pentatonic-ish check: C major pentatonic (C D E G A): F (65) → E (64) (tie with G is not a tie: 1 vs 2).
    expect(quantizeToScale(65, "pentatonic", 0)).toBe(64);
    expect(quantizeToScale(Number.NaN, "major", 0)).toBeNaN();
    expect(quantizeToScale(47.9, "major", 0)).toBe(48);
  });
});
