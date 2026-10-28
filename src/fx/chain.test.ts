import { describe, expect, it } from "vitest";
import { DEFAULT_FX, type FxSettings } from "../instrument/types";
import { FxChain } from "./chain";

const SR = 48000;

function sine(hz: number, sec: number, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.round(sec * SR));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR);
  return out;
}

function rms(x: Float32Array, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

function fx(change: (f: FxSettings) => void): FxSettings {
  const f = structuredClone(DEFAULT_FX);
  change(f);
  return f;
}

/** Runs the chain over stereo copies of `input` in 128-sample blocks (as the worklet does). */
function run(settings: FxSettings, inputL: Float32Array, inputR = inputL, bpm = 120): [Float32Array, Float32Array] {
  const chain = new FxChain(SR);
  chain.set(settings);
  chain.setTempo(bpm);
  const l = inputL.slice();
  const r = inputR.slice();
  for (let at = 0; at < l.length; at += 128) {
    const n = Math.min(128, l.length - at);
    chain.process(l.subarray(at, at + n), r.subarray(at, at + n), n);
  }
  return [l, r];
}

describe("FxChain", () => {
  it("leaves the sound alone when every effect is off", () => {
    const x = sine(440, 0.1);
    const [l] = run(DEFAULT_FX, x);
    expect(l).toEqual(x);
  });

  it("EQ: the high cut takes the top off, the low cut the bottom", () => {
    const high = sine(12000, 0.2);
    const [cut] = run(fx((f) => ((f.eq.on = true), (f.eq.highCutHz = 1000))), high);
    expect(rms(cut, 2000)).toBeLessThan(rms(high, 2000) * 0.05);
    const low = sine(50, 0.4);
    const [lowCut] = run(fx((f) => ((f.eq.on = true), (f.eq.lowCutHz = 800))), low);
    expect(rms(lowCut, 4000)).toBeLessThan(rms(low, 4000) * 0.05);
  });

  it("EQ: a bell boost raises its band by about its gain", () => {
    const x = sine(1000, 0.3, 0.1);
    const [y] = run(fx((f) => ((f.eq.on = true), (f.eq.midHz = 1000), (f.eq.midDb = 6))), x);
    expect(20 * Math.log10(rms(y, 4000) / rms(x, 4000))).toBeCloseTo(6, 0);
  });

  it("saturation adds harmonics without blowing up", () => {
    const x = sine(200, 0.3, 0.8);
    const [y] = run(fx((f) => ((f.saturation.on = true), (f.saturation.drive = 1))), x);
    expect(Math.max(...y.map(Math.abs))).toBeLessThan(1.6);
    // Less like a sine: the residual after the best-fit sine is substantial.
    let dot = 0;
    let norm = 0;
    for (let i = 2000; i < x.length; i++) {
      dot += y[i] * x[i];
      norm += x[i] * x[i];
    }
    const k = dot / norm;
    let residual = 0;
    for (let i = 2000; i < x.length; i++) residual += (y[i] - k * x[i]) ** 2;
    expect(Math.sqrt(residual / (x.length - 2000))).toBeGreaterThan(0.05);
  });

  it("the filter's LFO sweeps: a low-pass lets a high tone through only at the top of the sweep", () => {
    const x = sine(3000, 2, 0.3);
    const [y] = run(fx((f) => ((f.filter.on = true), (f.filter.cutoffHz = 800), (f.filter.lfoOctaves = 3), (f.filter.lfoBeats = 2), (f.filter.resonance = 0))), x, x, 120);
    // 2 beats at 120 BPM = 1 s: the cutoff peaks at 0.25 s and bottoms out at 0.75 s.
    const at = (sec: number) => rms(y, Math.round((sec - 0.05) * SR), Math.round((sec + 0.05) * SR));
    expect(at(0.25)).toBeGreaterThan(at(0.75) * 5);
  });

  it("the crusher quantises to its bit depth", () => {
    const [y] = run(fx((f) => ((f.crush.on = true), (f.crush.bits = 2), (f.crush.downsample = 1))), sine(100, 0.05, 0.9));
    const levels = new Set([...y].map((v) => Math.round(v * 1000)));
    expect(levels.size).toBeLessThanOrEqual(5);
  });

  it("chorus and auto-pan turn mono into different left and right", () => {
    const x = sine(300, 0.5);
    for (const settings of [fx((f) => (f.chorus.on = true)), fx((f) => (f.pan.on = true))]) {
      const [l, r] = run(settings, x, x.slice());
      let diff = 0;
      for (let i = 0; i < l.length; i++) diff += Math.abs(l[i] - r[i]);
      expect(diff / l.length).toBeGreaterThan(0.01);
      expect(FxChain.makesStereo(settings)).toBe(true);
    }
  });

  it("width at 0 makes it mono; above 1 widens the side", () => {
    const l0 = sine(300, 0.1);
    const r0 = sine(450, 0.1);
    const [l, r] = run(fx((f) => ((f.width.on = true), (f.width.side = 0))), l0, r0);
    expect(l).toEqual(r);
    const [wl, wr] = run(fx((f) => ((f.width.on = true), (f.width.side = 2))), l0, r0);
    const side = (a: Float32Array, b: Float32Array) => rms(a.map((v, i) => v - b[i]));
    expect(side(wl, wr)).toBeCloseTo(side(l0, r0) * 2, 3);
  });

  it("the limiter keeps every sample under the ceiling, a look-ahead late", () => {
    const x = sine(100, 0.3, 0.9);
    x[5000] = 3; // a spike
    const settings = fx((f) => ((f.limiter.on = true), (f.limiter.gainDb = 6), (f.limiter.ceilingDb = -3)));
    const [y] = run(settings, x);
    const ceiling = 10 ** (-3 / 20);
    expect(Math.max(...y.map(Math.abs))).toBeLessThanOrEqual(ceiling + 1e-6);
    const chain = new FxChain(SR);
    chain.set(settings);
    expect(chain.latency).toBe(Math.round(0.002 * SR));
  });

  it("the transient shaper lifts the attack against the sustain", () => {
    // A burst that starts suddenly and holds.
    const x = sine(500, 0.3, 0.5);
    const [y] = run(fx((f) => ((f.transient.on = true), (f.transient.attackDb = 12), (f.transient.sustainDb = -6))), x);
    const early = rms(y, 0, Math.round(0.005 * SR)) / rms(x, 0, Math.round(0.005 * SR));
    const late = rms(y, Math.round(0.2 * SR), Math.round(0.3 * SR)) / rms(x, Math.round(0.2 * SR), Math.round(0.3 * SR));
    expect(early).toBeGreaterThan(late * 2);
    expect(late).toBeCloseTo(10 ** (-6 / 20), 1);
  });

  it("air lifts the top end", () => {
    const x = sine(12000, 0.2, 0.2);
    const [y] = run(fx((f) => ((f.air.on = true), (f.air.amount = 1))), x);
    expect(rms(y, 2000)).toBeGreaterThan(rms(x, 2000) * 1.5);
  });

  it("the compressor brings a loud part down toward the threshold, and make-up lifts it", () => {
    const x = sine(500, 0.5, 0.9);
    const settings = (makeupDb: number) => fx((f) => Object.assign(f.compressor, { on: true, thresholdDb: -20, ratio: 10, attackMs: 1, releaseMs: 50, makeupDb }));
    const tail = (a: Float32Array) => rms(a, Math.round(0.3 * SR));
    const [y] = run(settings(0), x);
    expect(tail(y)).toBeLessThan(tail(x) * 0.25);
    const [z] = run(settings(12), x);
    expect(tail(z) / tail(y)).toBeCloseTo(10 ** (12 / 20), 1);
    // A quiet sound under the threshold passes untouched.
    const q = sine(500, 0.2, 0.01);
    const [w] = run(settings(0), q);
    expect(rms(w, 2000)).toBeCloseTo(rms(q, 2000), 4);
  });

  it("the delay repeats a click one step later, quieter each time, ping-ponging", () => {
    const x = new Float32Array(SR * 2);
    x[0] = 1;
    const settings = fx((f) => Object.assign(f.delay, { on: true, beats: 0.5, feedback: 0.5, highCutHz: 20000, pingPong: true, mix: 1 }));
    const [l, r] = run(settings, x, x, 120);
    const step = Math.round(0.25 * SR); // an eighth note at 120 BPM
    const peakNear = (a: Float32Array, at: number) => {
      let m = 0;
      for (let i = at - 3; i <= at + 3; i++) m = Math.max(m, Math.abs(a[i]));
      return m;
    };
    expect(peakNear(l, step)).toBeGreaterThan(0.5);
    expect(peakNear(r, step)).toBeLessThan(0.05);
    expect(peakNear(r, step * 2)).toBeGreaterThan(0.2);
    expect(peakNear(r, step * 2)).toBeLessThan(peakNear(l, step));
    expect(FxChain.tailSec(settings, 120)).toBeGreaterThan(2);
  });

  it("the reverb leaves a stereo tail that dies away, and stays bounded", () => {
    const x = new Float32Array(SR * 3);
    for (let i = 0; i < 2400; i++) x[i] = Math.sin(i * 0.1) * 0.8;
    const settings = fx((f) => Object.assign(f.reverb, { on: true, size: 0.8, damping: 0.3, preDelayMs: 10, mix: 0.5 }));
    const [l, r] = run(settings, x);
    const early = rms(l, Math.round(0.1 * SR), Math.round(0.3 * SR));
    const late = rms(l, Math.round(2.5 * SR), Math.round(3 * SR));
    expect(early).toBeGreaterThan(0.005);
    expect(late).toBeLessThan(early * 0.3);
    let diff = 0;
    for (let i = SR / 10; i < SR / 5; i++) diff += Math.abs(l[i] - r[i]);
    expect(diff).toBeGreaterThan(1);
    let peak = 0;
    for (const a of [l, r]) for (const v of a) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThan(2);
    expect(FxChain.makesStereo(settings)).toBe(true);
  });
it("waits long enough for the reverb: every size has rung down to -60 dB within its tail", () => {
    for (const size of [0, 0.5, 1]) {
      const settings = fx((f) => Object.assign(f.reverb, { on: true, size, damping: 0, mix: 1, preDelayMs: 0 }));
      const tail = FxChain.tailSec(settings, 120);
      const x = new Float32Array(Math.ceil((tail + 0.5) * SR));
      x[0] = 1;
      const [l] = run(settings, x);
      // The level just after the tail, against the loudest 50 ms.
      let loud = 0;
      for (let at = 0; at + 2400 <= l.length; at += 2400) loud = Math.max(loud, rms(l, at, at + 2400));
      const after = rms(l, Math.floor(tail * SR), Math.floor(tail * SR) + 2400);
      expect(after).toBeLessThan(loud * 0.001);
    }
  });
});
