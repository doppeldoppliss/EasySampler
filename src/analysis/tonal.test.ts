import { describe, expect, it } from "vitest";
import { tonalPitch, tonalStretches } from "./tonal";

const SR = 48000;

function noise(n: number, amp: number, seed = 3): Float32Array {
  let s = seed;
  return Float32Array.from({ length: n }, () => (((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1) * amp);
}

/** A stretch of "music": a loud rumble at 40 and 55 Hz and some hiss all through, and a note (five harmonics) from `from` to `to`. */
function mixed(seconds: number, notes: { from: number; to: number; hz: number }[]): Float32Array {
  const x = noise(Math.round(SR * seconds), 0.01);
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    x[i] += 0.3 * Math.sin(2 * Math.PI * 40 * t) + 0.2 * Math.sin(2 * Math.PI * 55 * t);
    for (const n of notes) {
      if (t < n.from || t >= n.to) continue;
      for (let h = 1; h <= 5; h++) x[i] += (0.05 / h) * Math.sin(2 * Math.PI * n.hz * h * t);
    }
  }
  return x;
}

describe("the pitch of a mixed sound", () => {
  it("finds where a note stands clear over a louder bass, and which note", () => {
    const x = mixed(2, [
      { from: 0.3, to: 0.7, hz: 523.25 },
      { from: 1.2, to: 1.5, hz: 440 },
    ]);
    const found = tonalStretches(x, SR).sort((a, b) => a.start - b.start);
    expect(found.length).toBe(2);
    expect(found[0].start).toBeGreaterThan(0.25);
    expect(found[0].end).toBeLessThan(0.75);
    expect(found[0].end - found[0].start).toBeGreaterThan(0.3);
    expect(Math.abs(found[0].midi - 72)).toBeLessThan(0.1);
    expect(found[1].start).toBeGreaterThan(1.15);
    expect(Math.abs(found[1].midi - 69)).toBeLessThan(0.1);
  });

  it("finds nothing in a rumble and hiss", () => {
    expect(tonalStretches(mixed(1.5, []), SR)).toEqual([]);
    expect(tonalPitch(mixed(1.5, []), SR, 0, 1.5)).toBeNull();
  });

  it("gives the note of a range, a little off the tempered pitch as it sounds", () => {
    // 20 cents over A4.
    const hz = 440 * 2 ** (0.2 / 12);
    const x = mixed(1, [{ from: 0, to: 1, hz }]);
    const note = tonalPitch(x, SR, 0.2, 0.8);
    expect(note).not.toBeNull();
    expect(Math.abs(note!.midi - 69.2)).toBeLessThan(0.05);
  });

  it("keeps one stretch where the estimate hops an octave", () => {
    // The second harmonic takes over halfway: the same note, heard an octave up by the numbers.
    const x = noise(SR, 0.005);
    for (let i = 0; i < x.length; i++) {
      const t = i / SR;
      const late = t > 0.5 ? 1 : 0;
      x[i] += (late ? 0.01 : 0.08) * Math.sin(2 * Math.PI * 330 * t) + (late ? 0.09 : 0.03) * Math.sin(2 * Math.PI * 660 * t) + 0.02 * Math.sin(2 * Math.PI * 990 * t);
    }
    const found = tonalStretches(x, SR);
    expect(found.length).toBe(1);
    expect(found[0].end - found[0].start).toBeGreaterThan(0.8);
    expect(Math.abs((((found[0].midi - 64 + 6) % 12) + 12) % 12 - 6)).toBeLessThan(0.1);
  });
});
