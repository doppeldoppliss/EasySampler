import { describe, expect, it } from "vitest";
import { integratedLoudness, matchLoudness, ShortTermMeter, truePeak, stereoImage } from "./loudness";

const SR = 48000;
const sine = (hz: number, amp: number, sec: number, phase = 0) => Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SR + phase));

describe("loudness (BS.1770)", () => {
  it("reads a 1 kHz sine at -23 dBFS on both channels as -23 LUFS (EBU Tech 3341), and follows the level", () => {
    const x = sine(997, 10 ** (-23 / 20), 5);
    expect(integratedLoudness(x, x, SR)).toBeCloseTo(-23, 1);
    const quiet = sine(997, 0.1, 5);
    expect(integratedLoudness(quiet, quiet, SR)).toBeCloseTo(-20, 1);
    expect(integratedLoudness(new Float32Array(SR), new Float32Array(SR), SR)).toBe(-Infinity);
  });

  it("gates out the silence: a loud stretch and a long silence read as the loud stretch", () => {
    const x = new Float32Array(SR * 10);
    x.set(sine(997, 0.5, 3));
    expect(integratedLoudness(x, x, SR)).toBeCloseTo(integratedLoudness(sine(997, 0.5, 3), sine(997, 0.5, 3), SR), 0);
  });

  it("finds the true peak between the samples", () => {
    // A quarter of the rate, 45° off: every sample at 0.707, the wave itself reaching 1.
    const x = sine(SR / 4, 1, 0.1, Math.PI / 4);
    let sampled = 0;
    for (const v of x) sampled = Math.max(sampled, Math.abs(v));
    expect(sampled).toBeLessThan(0.71);
    expect(truePeak(x, x)).toBeGreaterThan(0.97);
  });

  it("brings a mix to a target loudness under a -1 dBTP ceiling", () => {
    let seed = 7;
    const noise = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
    const l = Float32Array.from({ length: SR * 6 }, () => 0.1 * noise());
    const r = Float32Array.from({ length: SR * 6 }, () => 0.1 * noise());
    // A few spikes the gain alone would push past the ceiling.
    for (let k = 1; k < 6; k++) l[k * SR] = 0.9;
    const out = matchLoudness(l, r, SR, -14, -1);
    expect(out.afterLufs).toBeGreaterThan(-14.5);
    expect(out.afterLufs).toBeLessThan(-13.5);
    expect(out.truePeakDb).toBeLessThanOrEqual(-0.95);
  });

  it("meters live: the short-term loudness of a steady sine", () => {
    const meter = new ShortTermMeter(SR);
    const x = sine(997, 0.1, 4);
    for (let i = 0; i < x.length; i += 128) meter.push(x.subarray(i, i + 128), x.subarray(i, i + 128), Math.min(128, x.length - i));
    expect(meter.shortTerm).toBeCloseTo(-20, 0);
    expect(meter.momentary).toBeCloseTo(-20, 0);
  });

  it("stereo image: the same on both sides is mono (1, no side), unrelated sides are wide (about 0), opposite is out of phase (−1)", () => {
    const n = 48000;
    const a = new Float32Array(n).map((_, i) => Math.sin(i * 0.05));
    const b = new Float32Array(n).map((_, i) => Math.sin(i * 0.0371 + 1));
    expect(stereoImage(a, a).correlation).toBeCloseTo(1, 5);
    expect(stereoImage(a, a).sideDb).toBeLessThan(-100);
    expect(Math.abs(stereoImage(a, b).correlation)).toBeLessThan(0.1);
    expect(stereoImage(a, b).sideDb).toBeCloseTo(0, 0);
    expect(stereoImage(a, a.map((x) => -x)).correlation).toBeCloseTo(-1, 5);
  });
});
