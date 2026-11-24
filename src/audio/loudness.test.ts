import { describe, expect, it } from "vitest";
import { integratedLoudness, limit, matchLoudness, ShortTermMeter, truePeak, stereoImage } from "./loudness";

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

  it("limits a bass note without bending its wave: the gain stays down through the note, not following each half wave", () => {
    // 55 Hz, 3 dB over the ceiling: what is left once the 55 Hz is taken out (a hard clip leaves about −17 dB).
    const ceiling = 10 ** (-1 / 20);
    const l = sine(55, ceiling * 10 ** (3 / 20), 3);
    const r = l.slice();
    limit(l, r, SR, ceiling);
    expect(truePeak(l, r)).toBeLessThanOrEqual(ceiling * 1.0005);
    const from = SR;
    const n = SR;
    let a = 0;
    let b = 0;
    let total = 0;
    for (let i = 0; i < n; i++) {
      const p = (2 * Math.PI * 55 * i) / SR;
      a += l[from + i] * Math.cos(p);
      b += l[from + i] * Math.sin(p);
      total += l[from + i] ** 2;
    }
    const tone = (a * a + b * b) * (2 / n);
    expect(10 * Math.log10(Math.max(1e-12, total - tone) / total)).toBeLessThan(-60);
    // And it lets go: half a second after a single spike, the gain is back.
    const x = sine(440, 0.5, 2);
    const y = x.slice();
    x[SR] = y[SR] = 2;
    limit(x, y, SR, ceiling);
    expect(Math.abs(x[SR])).toBeLessThanOrEqual(ceiling);
    expect(Math.abs(x[SR + SR / 2 + 27])).toBeCloseTo(Math.abs(0.5 * Math.sin((2 * Math.PI * 440 * (SR + SR / 2 + 27)) / SR)), 2);
  });

  it("reaches the target when the limiter has to work: what it takes off is made up", () => {
    let seed = 3;
    const noise = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
    // Noise with a burst five times as loud for 20 ms every half second: the plain gain to −11 LUFS puts the bursts well over.
    const make = () => Float32Array.from({ length: SR * 6 }, (_, i) => (i % (SR / 2) < SR / 50 ? 0.25 : 0.05) * noise());
    const l = make();
    const r = make();
    const out = matchLoudness(l, r, SR, -11, -1);
    expect(out.gainDb).toBeGreaterThan(-11 - out.beforeLufs + 0.2);
    expect(Math.abs(out.afterLufs + 11)).toBeLessThan(0.15);
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

  it("says which side a mix leans to, by what the ear places: the lows in the middle do not hide it", () => {
    // A bass in the middle, far louder than a voice-range tone that is 6 dB stronger on the right.
    const bass = sine(60, 0.5, 2);
    const mid = sine(1500, 0.1, 2);
    const l = bass.map((x, i) => x + mid[i] * 0.5);
    const r = bass.map((x, i) => x + mid[i]);
    const image = stereoImage(l, r, SR);
    expect(image.balanceDb).toBeLessThan(-4);
    expect(image.balanceDb).toBeGreaterThan(-6.5);
    expect(stereoImage(r, l, SR).balanceDb).toBeCloseTo(-image.balanceDb, 5);
    expect(Math.abs(stereoImage(l, l, SR).balanceDb)).toBeLessThan(1e-6);
  });
});
