import { describe, expect, it } from "vitest";
import { demoPhrasePitch, synthVoice } from "../testsignals/synthVoice";
import { centerPitch } from "./centerPitch";
import { hzToMidi, midiToHz, parseNoteName, pitchLabel } from "./pitch";
import { analyzePitch } from "./pyin";

const SR = 44100;

function voicedFrames(f0: Float32Array): number[] {
  return [...f0].filter((v) => Number.isFinite(v));
}

describe("pitch units", () => {
  it("converts between Hz, MIDI and names", () => {
    expect(hzToMidi(440)).toBeCloseTo(69, 6);
    expect(midiToHz(60)).toBeCloseTo(261.626, 2);
    expect(pitchLabel(62.37)).toBe("D4 +37¢");
    expect(pitchLabel(60)).toBe("C4");
    expect(parseNoteName("A#3")).toBe(58);
    expect(parseNoteName("Bb3")).toBe(58);
    expect(parseNoteName("x")).toBeNull();
  });
});

describe("analyzePitch (pYIN)", () => {
  it("tracks a steady voice to within a few cents", () => {
    const x = synthVoice({ sampleRate: SR, durationSec: 0.8, pitch: () => 57 }); // A3, 220 Hz
    const track = analyzePitch(x, SR);
    const middle = [...track.f0.slice(20, track.f0.length - 20)];
    expect(middle.every((v) => Number.isFinite(v))).toBe(true);
    for (const v of middle) expect(Math.abs(v - 57)).toBeLessThan(0.05);
  });

  it("follows a moving pitch without octave jumps", () => {
    const pitch = (t: number) => 50 + 14 * t; // a two-octave… well, 14-semitone glide over 1 s
    const x = synthVoice({ sampleRate: SR, durationSec: 1, pitch });
    const track = analyzePitch(x, SR);
    let checked = 0;
    for (let i = 20; i < track.f0.length - 20; i++) {
      const truth = pitch(i * track.hopSec);
      expect(Math.abs(track.f0[i] - truth)).toBeLessThan(0.3);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("works across the voice's range", () => {
    // E2 … A#5 (the default range tops out at 1 kHz ≈ B5).
    for (const midi of [40, 52, 64, 76, 82]) {
      const x = synthVoice({ sampleRate: 48000, durationSec: 0.5, pitch: () => midi });
      const track = analyzePitch(x, 48000);
      const centre = centerPitch(track);
      expect(centre).not.toBeNull();
      expect(Math.abs(centre!.median - midi)).toBeLessThan(0.1);
    }
  });

  it("calls silence and noise unvoiced", () => {
    const silence = new Float32Array(SR / 2);
    expect(voicedFrames(analyzePitch(silence, SR).f0)).toHaveLength(0);

    let seed = 1;
    const noise = new Float32Array(SR / 2).map(() => {
      seed = (seed * 16807) % 2147483647;
      return (seed / 2147483647 - 0.5) * 0.5;
    });
    const track = analyzePitch(noise, SR);
    expect(voicedFrames(track.f0).length).toBeLessThan(track.f0.length * 0.1);
  });
});

describe("centerPitch", () => {
  it("finds the held pitch of a phrase with scoop, vibrato and fall", () => {
    const duration = 1.2;
    const x = synthVoice({ sampleRate: SR, durationSec: duration, pitch: demoPhrasePitch(62, duration) });
    const centre = centerPitch(analyzePitch(x, SR))!;
    expect(Math.abs(centre.median - 62)).toBeLessThan(0.15);
    expect(Math.abs(centre.mode - 62)).toBeLessThan(0.15);
    // The mean is pulled down by the scoop and the fall — why it isn't the default.
    expect(centre.mean).toBeLessThan(centre.median);
    expect(centre.confidence).toBeGreaterThan(0.8);
  });

  it("is null when nothing is voiced", () => {
    expect(centerPitch(analyzePitch(new Float32Array(SR / 4), SR))).toBeNull();
  });
});
