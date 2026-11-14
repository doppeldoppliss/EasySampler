import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS } from "../instrument/types";
import { Engine, type PreparedSource } from "./engine";
import { ForceState, vocoderBands } from "./force";

const SR = 48000;

function noise(n: number, amp = 0.2): Float32Array {
  let seed = 7;
  return Float32Array.from({ length: n }, () => (((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1) * amp);
}
/** Power at a frequency over the second half of `x` (Hann-windowed). */
function power(x: Float32Array, hz: number): number {
  const from = x.length >> 1;
  const n = x.length - from;
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    re += x[from + i] * w * Math.cos((2 * Math.PI * hz * i) / SR);
    im += x[from + i] * w * Math.sin((2 * Math.PI * hz * i) / SR);
  }
  return re * re + im * im;
}
const rms = (x: Float32Array) => Math.sqrt(x.subarray(x.length >> 1).reduce((a, v) => a + v * v, 0) / (x.length - (x.length >> 1)));
function blocks(x: Float32Array, f: (b: Float32Array, n: number) => void): Float32Array {
  const y = x.slice();
  for (let at = 0; at < y.length; at += 128) f(y.subarray(at, at + 128), Math.min(128, y.length - at));
  return y;
}
/** How far the harmonics of `hz` stand over the points halfway between them (dB, the first six). */
function pitchedDb(x: Float32Array, hz: number): number {
  let on = 0;
  let between = 0;
  for (let h = 1; h <= 6; h++) {
    on += power(x, hz * h);
    between += power(x, hz * (h + 0.5));
  }
  return 10 * Math.log10(on / between);
}

describe("強制シンセ化: a pitch forced onto noise", () => {
  it("noise has no pitch; through the comb it rings at the note, at about the level it came in", () => {
    const x = noise(SR);
    expect(Math.abs(pitchedDb(x, 440))).toBeLessThan(6);
    const state = new ForceState(SR);
    const y = blocks(x, (b, n) => state.comb(b, n, 440));
    expect(pitchedDb(y, 440)).toBeGreaterThan(15);
    expect(Math.abs(20 * Math.log10(rms(y) / rms(x)))).toBeLessThan(3);
  });

  it("a sound already at the note does not blow up in the comb (it would add up 20-fold): out no louder than in", () => {
    const x = Float32Array.from({ length: SR }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR));
    const state = new ForceState(SR);
    const y = blocks(x, (b, n) => state.comb(b, n, 440));
    expect(20 * Math.log10(rms(y) / rms(x))).toBeLessThan(1);
    expect(20 * Math.log10(rms(y) / rms(x))).toBeGreaterThan(-6);
  });

  it("through the vocoder it is a tone at the note (stronger still), within 8 dB of the level it came in", () => {
    const x = noise(SR);
    const state = new ForceState(SR);
    const bands = vocoderBands(SR);
    const y = blocks(x, (b, n) => state.vocoder(b, n, 220, bands));
    expect(pitchedDb(y, 220)).toBeGreaterThan(25);
    expect(Math.abs(20 * Math.log10(rms(y) / rms(x)))).toBeLessThan(8);
  });

  it("the vocoder keeps the sound's colour: dark noise in, dark tone out", () => {
    // Noise low-passed hard (a one-pole at 300 Hz): the tone's highs stay far under its lows.
    const x = noise(SR);
    let lp = 0;
    for (let i = 0; i < x.length; i++) x[i] = lp += 0.04 * (x[i] - lp);
    const bright = noise(SR);
    const bands = vocoderBands(SR);
    const tilt = (y: Float32Array) => 10 * Math.log10(power(y, 220 * 20) / power(y, 220));
    const a = new ForceState(SR);
    const b = new ForceState(SR);
    const dark = tilt(blocks(x, (s, n) => a.vocoder(s, n, 220, bands)));
    const open = tilt(blocks(bright, (s, n) => b.vocoder(s, n, 220, bands)));
    expect(dark).toBeLessThan(open - 15);
  });

  it("silence in, silence out (and no numbers gone bad)", () => {
    const bands = vocoderBands(SR);
    for (const mode of ["comb", "vocoder"] as const) {
      const state = new ForceState(SR);
      const y = blocks(new Float32Array(SR), (b, n) => (mode === "comb" ? state.comb(b, n, 440) : state.vocoder(b, n, 440, bands)));
      expect(y.every((v) => Number.isFinite(v) && Math.abs(v) < 1e-9)).toBe(true);
    }
  });
});

describe("強制シンセ化 in the engine", () => {
  /** A material that is all noise: no pitch anywhere (marks every 5 ms, none voiced). */
  function noiseSource(): PreparedSource {
    const n = SR;
    const marks: number[] = [];
    for (let m = 240; m < n - 240; m += 240) marks.push(m);
    return { sampleRate: SR, channels: [noise(n)], marks: Float64Array.from(marks), voiced: new Uint8Array(marks.length), f0: new Float32Array(marks.length).fill(Number.NaN) };
  }
  function play(force: (typeof DEFAULT_PARAMS)["force"], note: number): Float32Array {
    const engine = new Engine(SR);
    engine.setSource(noiseSource());
    engine.setInstrument(
      { rangeStart: 0, rangeEnd: 1, attack: 0.3, sustainStart: 0.3, sustainEnd: 0.7, tailStart: 0.7, removed: [] },
      { ...DEFAULT_PARAMS, sustainMode: "none", sustainEnabled: false, force, amp: { ...DEFAULT_PARAMS.amp, attack: 0.001 } },
    );
    engine.noteOn(note, 1);
    // (The head plays, 0.3 s of it: measured inside that.)
    const out = new Float32Array(Math.round(SR * 0.28));
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    for (let at = 0; at + 128 <= out.length; at += 128) {
      engine.render(l, r, 128);
      out.set(l, at);
    }
    return out;
  }
  const hzOf = (note: number) => 440 * 2 ** ((note - 69) / 12);

  it("off: a pitchless material stays pitchless whatever the key", () => {
    expect(Math.abs(pitchedDb(play({ mode: "off", scope: "unvoiced", amount: 1 }, 57), hzOf(57)))).toBeLessThan(6);
  });

  it("comb and vocoder: the same material sounds at the key played, each key its own pitch", () => {
    for (const mode of ["comb", "vocoder"] as const) {
      for (const note of [57, 64]) {
        const y = play({ mode, scope: "unvoiced", amount: 1 }, note);
        expect(pitchedDb(y, hzOf(note))).toBeGreaterThan(12);
      }

      // (Not just any ringing: played at A3, it does not stand out at the harmonics of the key next to it.)
      expect(pitchedDb(play({ mode, scope: "unvoiced", amount: 1 }, 57), hzOf(58))).toBeLessThan(6);
    }
  });

  it("amount 0 is the sound as it was", () => {
    const dry = play({ mode: "off", scope: "unvoiced", amount: 1 }, 57);
    const zero = play({ mode: "vocoder", scope: "all", amount: 0 }, 57);
    expect(Array.from(zero.subarray(0, 4096))).toEqual(Array.from(dry.subarray(0, 4096)));
  });
});
