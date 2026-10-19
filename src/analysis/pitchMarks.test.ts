import { describe, expect, it } from "vitest";
import { demoPhrasePitch, demoSyllable, synthVoice } from "../testsignals/synthVoice";
import { midiToHz } from "./pitch";
import { findPitchMarks, pitchAt } from "./pitchMarks";
import { analyzePitch } from "./pyin";

const SR = 44100;

function noise(length: number, amplitude: number, seed = 99): Float32Array {
  let s = seed;
  return new Float32Array(length).map(() => {
    s = (s * 16807) % 2147483647;
    return (s / 2147483647 - 0.5) * 2 * amplitude;
  });
}

function voicedIntervals(marks: ReturnType<typeof findPitchMarks>): { at: number; gap: number }[] {
  const out: { at: number; gap: number }[] = [];
  for (let i = 1; i < marks.positions.length; i++) {
    if (marks.voiced[i] && marks.voiced[i - 1]) out.push({ at: (marks.positions[i] + marks.positions[i - 1]) / 2, gap: marks.positions[i] - marks.positions[i - 1] });
  }
  return out;
}

describe("findPitchMarks (cross-correlation)", () => {
  it("puts one mark per period, to a fraction of a sample", () => {
    const x = synthVoice({ sampleRate: SR, durationSec: 0.5, pitch: () => 57 }); // 220 Hz
    const intervals = voicedIntervals(findPitchMarks(x, SR, analyzePitch(x, SR)));
    expect(intervals.length).toBeGreaterThan(90);
    for (const { gap } of intervals) expect(Math.abs(gap - SR / 220)).toBeLessThan(0.5);
  });

  it("follows a moving pitch", () => {
    const pitch = demoPhrasePitch(60, 0.8);
    const x = synthVoice({ sampleRate: SR, durationSec: 0.8, pitch });
    const intervals = voicedIntervals(findPitchMarks(x, SR, analyzePitch(x, SR)));
    expect(intervals.length).toBeGreaterThan(150);
    for (const { at, gap } of intervals) {
      const period = SR / midiToHz(pitch(at / SR));
      expect(Math.abs(gap / period - 1)).toBeLessThan(0.03);
    }
  });

  it("holds the period in noise (20 dB SNR)", () => {
    const clean = synthVoice({ sampleRate: SR, durationSec: 0.6, pitch: () => 52 });
    const hiss = noise(clean.length, 0.05);
    const noisy = clean.map((v, i) => v + hiss[i]);
    const intervals = voicedIntervals(findPitchMarks(noisy, SR, analyzePitch(noisy, SR)));
    expect(intervals.length).toBeGreaterThan(70);
    const period = SR / midiToHz(52);
    const off = intervals.filter(({ gap }) => Math.abs(gap - period) > 2);
    expect(off.length).toBeLessThan(intervals.length * 0.05);
  });

  it("covers unvoiced stretches with a 5 ms grid", () => {
    const x = demoSyllable(SR);
    const marks = findPitchMarks(x, SR, analyzePitch(x, SR));
    const hissMarks = [...marks.positions].filter((p, i) => p < 0.08 * SR && !marks.voiced[i]);
    expect(hissMarks.length).toBeGreaterThan(12);
    for (let i = 1; i < marks.positions.length; i++) expect(marks.positions[i]).toBeGreaterThan(marks.positions[i - 1]);
  });

  it("finds no pulses in noise", () => {
    const x = noise(SR / 2, 0.3);
    const marks = findPitchMarks(x, SR, analyzePitch(x, SR));
    expect([...marks.voiced].filter(Boolean).length).toBeLessThan(10);
  });

  it("reads the track's pitch between frames", () => {
    const x = synthVoice({ sampleRate: SR, durationSec: 0.4, pitch: () => 64 });
    expect(Math.abs(pitchAt(analyzePitch(x, SR), 0.2) - 64)).toBeLessThan(0.05);
  });
});
