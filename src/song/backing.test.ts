import { describe, expect, it } from "vitest";
import { BackingSynth, SYNTH_PRESETS, type SynthPreset } from "./backing";

const SR = 48000;

/** Plays `note` held for `holdSec`, then let go; the peak, the RMS over the hold, the power at the note, and when it fell silent. */
function play(preset: SynthPreset, note: number, holdSec: number, totalSec: number) {
  const synth = new BackingSynth(SR);
  synth.setPreset(preset);
  synth.noteOn(note, 1, false);
  const out = new Float32Array(Math.round(totalSec * SR));
  const block = 128;
  for (let at = 0; at < out.length; at += block) {
    if (at <= holdSec * SR && at + block > holdSec * SR) synth.noteOff(note, false);
    const n = Math.min(block, out.length - at);
    const part = out.subarray(at, at + n);
    synth.renderAdd(part, part, n, 1);
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const hz = 440 * 2 ** ((note - 69) / 12);
  // Power at the note's frequency against a quarter-tone off it, over the first 0.3 s after the attack.
  const at = (f: number) => {
    let re = 0;
    let im = 0;
    for (let i = Math.round(0.3 * SR); i < Math.round(0.6 * SR); i++) {
      re += out[i] * Math.cos((2 * Math.PI * f * i) / SR);
      im += out[i] * Math.sin((2 * Math.PI * f * i) / SR);
    }
    return re * re + im * im;
  };
  return { peak, onPitch: at(hz) / Math.max(1e-12, at(hz * 2 ** (0.5 / 12))), idle: synth.idle(), out };
}

describe("簡易シンセ presets", () => {
  for (const id of Object.keys(SYNTH_PRESETS) as SynthPreset[]) {
    it(`${id}: sounds at the note's pitch, stays well under full scale, and stops once let go`, () => {
      const r = play(id, 60, 0.8, 3);
      expect(r.peak).toBeGreaterThan(0.01);
      expect(r.peak).toBeLessThan(0.5);
      expect(r.onPitch).toBeGreaterThan(10);
      expect(r.idle).toBe(true);
    });
  }

  it("a piano or a bell dies away by itself while held; an organ holds", () => {
    for (const id of ["piano", "bell"] as const) expect(play(id, 60, 10, 6).idle).toBe(true);
    const organ = play("organ", 60, 10, 6);
    expect(organ.idle).toBe(false);
  });

  it("a high square has far less aliasing below its note than a bare one (PolyBLEP)", () => {
    // The strongest component under the fundamental (a Hann-windowed scan, 2 Hz steps), against the fundamental.
    const alias = (id: SynthPreset, note: number) => {
      const { out } = play(id, note, 1, 1);
      const f0 = 440 * 2 ** ((note - 69) / 12);
      const from = 4800;
      const n = 19200;
      const win = new Float32Array(n);
      for (let i = 0; i < n; i++) win[i] = out[from + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
      const power = (hz: number) => {
        let re = 0;
        let im = 0;
        const w = (2 * Math.PI * hz) / SR;
        for (let i = 0; i < n; i++) {
          re += win[i] * Math.cos(w * i);
          im += win[i] * Math.sin(w * i);
        }
        return re * re + im * im;
      };
      let below = 0;
      for (let hz = 60; hz < f0 * 0.8; hz += 2) below = Math.max(below, power(hz));
      return below / power(f0);
    };
    // C7: the 23rd harmonic folds back to about 140 Hz.
    const bare = alias("chip", 96);
    const smoothed = alias("lead", 96);
    expect(bare).toBeGreaterThan(1e-4);
    expect(smoothed).toBeLessThan(bare / 10);
  });

  it("an unknown 音色 plays the default", () => {
    const a = new BackingSynth(SR);
    a.setPreset("nope");
    const b = new BackingSynth(SR);
    for (const s of [a, b]) s.noteOn(69, 1, false);
    const x = new Float32Array(512);
    const y = new Float32Array(512);
    a.renderAdd(x, x, 512, 1);
    b.renderAdd(y, y, 512, 1);
    expect(Array.from(x)).toEqual(Array.from(y));
  });

  it("the drums' noise falls away at the top: a hat and a snare hold little over 16 kHz, and keep what is heard", () => {
    // Power in a band, by a plain transform of the hit's first 4096 samples.
    const bands = (key: number) => {
      const synth = new BackingSynth(SR);
      synth.noteOn(key, 1, true);
      const out = new Float32Array(4096);
      for (let at = 0; at < out.length; at += 128) synth.renderAdd(out.subarray(at, at + 128), new Float32Array(128), 128, 1);
      const power = [0, 0, 0];
      for (let k = 1; k < 2048; k += 5) {
        let re = 0;
        let im = 0;
        for (let n = 0; n < 4096; n++) {
          re += out[n] * Math.cos((2 * Math.PI * k * n) / 4096);
          im += out[n] * Math.sin((2 * Math.PI * k * n) / 4096);
        }
        const hz = (k * SR) / 4096;
        power[hz < 4000 ? 2 : hz < 12000 ? 0 : hz > 16000 ? 1 : 2] += re * re + im * im;
      }
      return { heard: power[0], over: power[1] };
    };
    for (const key of [42, 46, 49, 38]) {
      const b = bands(key);
      // (4–12 kHz against over 16 kHz: bare noise had the top the stronger by 5 dB and more on the hats.)
      expect(10 * Math.log10(b.over / b.heard)).toBeLessThan(-4);
    }
  });
});
