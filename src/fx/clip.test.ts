import { describe, expect, it } from "vitest";
import { DEFAULT_FX } from "../instrument/types";
import { FxChain } from "./chain";
import { CLIP_ROOM, roundingFor, softClip } from "./clip";

const SR = 48000;

describe("ピークを丸める", () => {
  it("leaves the sound under the knee as it is and rounds what is over, never past the ceiling", () => {
    expect(softClip(0.3, 0.5)).toBe(0.3);
    expect(softClip(-0.5, 0.5)).toBe(-0.5);
    // Smooth at the knee, rising all the way, under knee × (1 + room).
    expect(softClip(0.5001, 0.5)).toBeCloseTo(0.5001, 4);
    let last = 0.5;
    for (let x = 0.51; x < 4; x += 0.01) {
      const y = softClip(x, 0.5);
      expect(y).toBeGreaterThanOrEqual(last);
      expect(y).toBeLessThanOrEqual(0.5 * (1 + CLIP_ROOM));
      expect(softClip(-x, 0.5)).toBe(-y);
      last = y;
    }
  });

  /** A steady tone with a short, far louder hit four times a second: a mix whose peaks stand far over its loudness. */
  const spiky = (hit: number) =>
    Float32Array.from({ length: SR * 4 }, (_, i) => {
      const k = i % (SR / 4);
      return 0.08 * Math.sin((2 * Math.PI * 330 * i) / SR) + (k < 240 ? hit * Math.sin((2 * Math.PI * 80 * k) / SR) * (1 - k / 240) : 0);
    });

  it("finds where to start for a peak a given height over the loudness, no further down than allowed", () => {
    const x = spiky(0.8);
    const found = roundingFor(x, x, SR, 12, 12)!;
    expect(found.beforePlr).toBeGreaterThan(15);
    expect(found.afterPlr).toBeLessThanOrEqual(12);
    expect(found.afterPlr).toBeGreaterThan(11);
    // Held to 3 dB under the peak: it stops there, short of the target.
    const held = roundingFor(x, x, SR, 12, 3)!;
    expect(held.underPeakDb).toBe(3);
    expect(held.afterPlr).toBeGreaterThan(12);
    expect(held.afterPlr).toBeLessThan(held.beforePlr);
  });

  it("asks for nothing when the mix is there already, or silent", () => {
    const tone = Float32Array.from({ length: SR * 2 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 330 * i) / SR));
    expect(roundingFor(tone, tone, SR, 12, 5)).toBeNull();
    expect(roundingFor(new Float32Array(SR), new Float32Array(SR), SR, 12, 5)).toBeNull();
  });

  it("works in the effects chain: the master's peaks come out rounded, the rest untouched", () => {
    const chain = new FxChain(SR);
    const fx = structuredClone(DEFAULT_FX);
    fx.clip = { on: true, thresholdDb: -12 };
    chain.set(fx);
    const x = spiky(0.8);
    const l = x.slice();
    const r = x.slice();
    for (let at = 0; at < l.length; at += 128) chain.process(l.subarray(at, at + 128), r.subarray(at, at + 128), 128);
    const knee = 10 ** (-12 / 20);
    let top = 0;
    for (let i = 0; i < l.length; i++) {
      top = Math.max(top, Math.abs(l[i]));
      if (Math.abs(x[i]) <= knee) expect(l[i]).toBe(x[i]);
    }
    expect(top).toBeLessThan(knee * (1 + CLIP_ROOM));
    expect(top).toBeGreaterThan(knee);
  });
});
