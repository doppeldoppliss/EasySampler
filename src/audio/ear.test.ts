import { describe, expect, it } from "vitest";
import { audibility, earPattern, EAR_BANDS } from "./ear";
import { integratedLoudness } from "./loudness";

const SR = 48000;
const LEN = SR * 3;

const tone = (hz: number, db: number) => {
  const a = 10 ** (db / 20);
  return Float32Array.from({ length: LEN }, (_, i) => a * Math.sin((2 * Math.PI * hz * i) / SR));
};
/** Noise in one octave around `hz`. */
function bandNoise(hz: number, db: number): Float32Array {
  let seed = 3;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const out = new Float32Array(LEN);
  // A sum of many sines across the octave, at random phases: flat enough for the bands.
  const n = 60;
  const a = (10 ** (db / 20) * Math.SQRT2) / Math.sqrt(n);
  for (let k = 0; k < n; k++) {
    const f = hz * 2 ** (k / n - 0.5);
    const ph = Math.PI * rand();
    const w = (2 * Math.PI * f) / SR;
    for (let i = 0; i < LEN; i++) out[i] += a * Math.sin(w * i + ph);
  }
  return out;
}
const silent = new Float32Array(LEN);
const mono = (x: Float32Array) => earPattern(x, x, SR);
const lufsOf = (...xs: [Float32Array, Float32Array][]) => {
  const l = new Float32Array(LEN), r = new Float32Array(LEN);
  for (const [a, b] of xs) for (let i = 0; i < LEN; i++) { l[i] += a[i]; r[i] += b[i]; }
  return integratedLoudness(l, r, SR);
};

describe("the ear model", () => {
  it("has its bands from 30 Hz to 16 kHz, one ERB each", () => {
    expect(EAR_BANDS.lo[0]).toBeCloseTo(30, 0);
    expect(EAR_BANDS.hi[EAR_BANDS.hi.length - 1]).toBeGreaterThan(14000);
    expect(EAR_BANDS.hz.length).toBeGreaterThan(30);
  });

  it("a sound alone is all heard; under a loud sound at its own pitch it is nearly gone; far from it, it is not", () => {
    const quiet = tone(1000, -40);
    const alone = audibility([mono(quiet)], lufsOf([quiet, quiet]))[0]!;
    expect(alone.heard).toBeGreaterThan(0.99);
    expect(alone.share).toBeGreaterThan(0.99);

    const near = bandNoise(1000, -12);
    const under = audibility([mono(quiet), mono(near)], lufsOf([quiet, quiet], [near, near]));
    expect(under[0]!.heard).toBeLessThan(0.15);
    expect(under[0]!.coveredBy).toBe(1);
    expect(Math.abs(Math.log2(under[0]!.worstHz / 1000))).toBeLessThan(0.5);

    const far = bandNoise(150, -12);
    const apart = audibility([mono(quiet), mono(far)], lufsOf([quiet, quiet], [far, far]));
    expect(apart[0]!.heard).toBeGreaterThan(0.6);
    expect(apart[0]!.heard).toBeGreaterThan(under[0]!.heard * 4);
  });

  it("hears a sound in one ear past what covers it in the other", () => {
    const quiet = tone(1000, -40);
    const near = bandNoise(1000, -12);
    const together = audibility([mono(quiet), mono(near)], lufsOf([quiet, quiet], [near, near]))[0]!;
    const apart = audibility([earPattern(quiet, silent, SR), earPattern(silent, near, SR)], lufsOf([quiet, silent], [silent, near]))[0]!;
    expect(apart.heard).toBeGreaterThan(0.9);
    expect(apart.heard).toBeGreaterThan(together.heard * 4);
  });

  it("counts only where a sound plays, and says nothing of what was not measured", () => {
    const half = tone(500, -20).map((x, i) => (i < LEN / 2 ? x : 0));
    const r = audibility([mono(half), null], lufsOf([half, half]));
    expect(r[0]!.playing).toBeGreaterThan(0.4);
    expect(r[0]!.playing).toBeLessThan(0.6);
    expect(r[1]).toBeNull();
  });
});
