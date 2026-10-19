import { describe, expect, it } from "vitest";
import { analyzePitch } from "../analysis/pyin";
import { demoSyllable, synthVoice } from "../testsignals/synthVoice";
import { clampMarkers, suggestMarkers } from "./markers";

const SR = 44100;

describe("suggestMarkers", () => {
  it("puts the head on the consonant and the sustain on the steady vowel", () => {
    const x = demoSyllable(SR); // 0.09 s hiss, then 0.75 s of /a/ (scoop at the start, fall in the last 0.2 s)
    const track = analyzePitch(x, SR);
    const m = suggestMarkers(track, x.length / SR);
    expect(Math.abs(m.attack - 0.09)).toBeLessThan(0.03);
    expect(m.rangeStart).toBeLessThan(0.02);
    expect(m.sustainStart).toBeGreaterThan(m.attack + 0.05); // past the scoop
    expect(m.sustainEnd).toBeLessThan(0.09 + 0.75 - 0.2); // before the fall
    expect(m.sustainEnd - m.sustainStart).toBeGreaterThan(0.06);
    expect(m.tailStart).toBe(m.sustainEnd);
  });

  it("trims silence around the material", () => {
    const voice = synthVoice({ sampleRate: SR, durationSec: 0.5, pitch: () => 57 });
    const x = new Float32Array(SR); // 0.25 s silence, voice, 0.25 s silence
    x.set(voice, SR / 4);
    const m = suggestMarkers(analyzePitch(x, SR), 1);
    expect(Math.abs(m.rangeStart - 0.25)).toBeLessThan(0.03);
    expect(Math.abs(m.rangeEnd - 0.75)).toBeLessThan(0.03);
  });

  it("gives a usable layout for unpitched material", () => {
    let seed = 3;
    const hit = new Float32Array(SR / 5).map((_, i) => {
      seed = (seed * 16807) % 2147483647;
      return (seed / 2147483647 - 0.5) * Math.exp(-i / 2000);
    });
    const m = suggestMarkers(analyzePitch(hit, SR), hit.length / SR);
    expect(m.attack).toBe(m.rangeStart);
    expect(m.sustainEnd).toBeGreaterThan(m.sustainStart);
    expect(m.tailStart).toBe(m.rangeEnd);
  });
});

describe("clampMarkers", () => {
  it("restores the order after a drag past a neighbour", () => {
    const m = clampMarkers({ rangeStart: 0.1, rangeEnd: 1, attack: 0.5, sustainStart: 0.3, sustainEnd: 0.2, tailStart: 0.1 });
    expect(m.attack).toBe(0.5);
    expect(m.sustainStart).toBe(0.5);
    expect(m.sustainEnd).toBeGreaterThan(m.sustainStart);
    expect(m.tailStart).toBeGreaterThanOrEqual(m.sustainEnd);
  });
});
