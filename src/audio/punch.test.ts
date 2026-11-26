import { describe, expect, it } from "vitest";
import { lowPunchDb } from "./punch";

const SR = 48000;
/** Kicks (a 60 Hz thump falling over 150 ms) every half second over a held 50 Hz bass at `bassDb`. */
function song(bassDb: number, kickAttack = 1): Float32Array {
  const out = new Float32Array(SR * 12);
  const bass = 10 ** (bassDb / 20);
  for (let i = 0; i < out.length; i++) out[i] = bass * Math.sin((2 * Math.PI * 50 * i) / SR);
  for (let at = 0; at < out.length; at += SR / 2)
    for (let i = 0; i < 0.3 * SR && at + i < out.length; i++) {
      const t = i / SR;
      // (The first 20 ms louder by `kickAttack`: what a transient shaper's attack does.)
      out[at + i] += 0.5 * (t < 0.02 ? kickAttack : 1) * Math.exp(-t / 0.15) * Math.sin(2 * Math.PI * 60 * t);
    }
  return out;
}

describe("the kick's punch under 150 Hz", () => {
  it("reads higher for a kick over a quiet bass than over a loud one, and for a sharper kick", () => {
    const quiet = song(-30), loud = song(-8), sharp = song(-8, 2);
    expect(lowPunchDb(quiet, quiet, SR)).toBeGreaterThan(lowPunchDb(loud, loud, SR) + 2);
    expect(lowPunchDb(sharp, sharp, SR)).toBeGreaterThan(lowPunchDb(loud, loud, SR) + 1);
  });

  it("reads nothing of silence", () => {
    const quiet = new Float32Array(SR * 4);
    expect(Number.isNaN(lowPunchDb(quiet, quiet, SR))).toBe(true);
  });
});
