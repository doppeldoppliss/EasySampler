import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS } from "../instrument/types";
import { Engine } from "./engine";
import { analyzeMaterial, prepareSource } from "./prepare";

const SR = 48000;

/** Power at a frequency over the middle of `x` (Hann-windowed). */
function power(x: Float32Array, hz: number): number {
  const from = x.length >> 2;
  const n = x.length >> 1;
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    re += x[from + i] * w * Math.cos((2 * Math.PI * hz * i) / SR);
    im += x[from + i] * w * Math.sin((2 * Math.PI * hz * i) / SR);
  }
  return re * re + im * im;
}
const rms = (x: Float32Array) => Math.sqrt(x.subarray(x.length >> 2, (3 * x.length) >> 2).reduce((a, v) => a + v * v, 0) / (x.length >> 1));

/** A chord (what the period analysis has no one pitch for): three tones a major triad apart. */
function chord(seconds: number): Float32Array {
  const hz = [220, 277.18, 329.63];
  return Float32Array.from({ length: Math.round(SR * seconds) }, (_, i) => hz.reduce((a, f) => a + 0.12 * Math.sin((2 * Math.PI * f * i) / SR), 0));
}

function play(x: Float32Array, semitones: number): Float32Array {
  const analysis = analyzeMaterial([x], SR);
  const source = prepareSource([x], analysis, SR);
  const dur = x.length / SR;
  const engine = new Engine(SR);
  engine.setSource(source);
  engine.setInstrument(
    { ...analysis.markers, rangeStart: 0, rangeEnd: dur, attack: dur, sustainStart: dur, sustainEnd: dur, tailStart: dur },
    { ...DEFAULT_PARAMS, root: 60, sustainMode: "none", sustainEnabled: false, transposeOnly: true, flatten: 0, pitchMode: "wsola" },
  );
  engine.noteOn(60 + semitones, 1);
  const out = new Float32Array(x.length);
  const l = new Float32Array(128);
  const r = new Float32Array(128);
  for (let at = 0; at + 128 <= out.length; at += 128) {
    engine.render(l, r, 128);
    out.set(l, at);
  }
  return out;
}

describe("波形合わせ (pitchMode wsola)", () => {
  it("moves every tone of a chord by the shift, at the level it had, for as long as it was", () => {
    const x = chord(1.5);
    for (const semitones of [-6, 5, 12]) {
      const y = play(x, semitones);
      const ratio = 2 ** (semitones / 12);
      for (const hz of [220, 277.18, 329.63]) {
        // The tone is where the shift puts it, and no longer where it was.
        // (A tempered chord never quite repeats, so the grains meet a little out of step: some dB of a long
        // measurement's power is spread to either side of the tone.)
        expect(10 * Math.log10(power(y, hz * ratio) / power(x, hz))).toBeGreaterThan(-8);
        expect(10 * Math.log10(power(y, hz * ratio) / power(y, hz * ratio * 1.09))).toBeGreaterThan(20);
        expect(10 * Math.log10(power(y, hz * ratio) / power(y, hz))).toBeGreaterThan(15);
      }
      expect(20 * Math.log10(rms(y) / rms(x))).toBeGreaterThan(-1.5);
      expect(20 * Math.log10(rms(y) / rms(x))).toBeLessThan(1.5);
    }
  });

  it("plays the material itself when the note is the root", () => {
    const x = chord(1);
    const y = play(x, 0);
    // (Each grain goes on from the last: the material unbroken, tone for tone.)
    for (const hz of [220, 277.18, 329.63]) expect(Math.abs(10 * Math.log10(power(y, hz) / power(x, hz)))).toBeLessThan(0.3);
    expect(Math.abs(20 * Math.log10(rms(y) / rms(x)))).toBeLessThan(0.3);
  });
});
