import { describe, expect, it } from "vitest";
import { applyCorrections, correctionLabel } from "./corrections";
import type { PitchTrack } from "./pyin";

function track(f0: number[]): PitchTrack {
  return { hopSec: 0.01, f0: Float32Array.from(f0), voicedProb: Float32Array.from(f0.map((v) => (Number.isFinite(v) ? 0.8 : 0.1))), rms: new Float32Array(f0.length).fill(0.1) };
}

describe("applyCorrections", () => {
  it("moves a stretch by an octave and leaves the rest and the input alone", () => {
    const t = track([60, 60, 60, 60, 60, 60]);
    const out = applyCorrections(t, [{ start: 0.02, end: 0.04, kind: "octave-up" }]);
    expect(Array.from(out.f0)).toEqual([60, 60, 72, 72, 60, 60]);
    expect(Array.from(t.f0)).toEqual([60, 60, 60, 60, 60, 60]);
    expect(Array.from(applyCorrections(t, [{ start: 0, end: 1, kind: "octave-down" }]).f0)).toEqual([48, 48, 48, 48, 48, 48]);
  });

  it("makes a stretch unvoiced", () => {
    const out = applyCorrections(track([60, 60, 60]), [{ start: 0.01, end: 0.02, kind: "unvoiced" }]);
    expect(out.f0[0]).toBe(60);
    expect(Number.isNaN(out.f0[1])).toBe(true);
    expect(out.voicedProb[1]).toBe(0);
  });

  it("makes a gap voiced by interpolating between its pitched neighbours", () => {
    const out = applyCorrections(track([60, NaN, NaN, NaN, 64, 64]), [{ start: 0.01, end: 0.04, kind: "voiced" }]);
    expect(Array.from(out.f0).map((v) => Math.round(v * 100) / 100)).toEqual([60, 61, 62, 63, 64, 64]);
    expect(out.voicedProb[2]).toBeCloseTo(0.9, 5);
    // Only one side pitched: hold that.
    expect(Array.from(applyCorrections(track([NaN, NaN, 57]), [{ start: 0, end: 0.02, kind: "voiced" }]).f0)).toEqual([57, 57, 57]);
    // Nothing pitched at all: nothing to borrow.
    expect(Number.isNaN(applyCorrections(track([NaN, NaN]), [{ start: 0, end: 1, kind: "voiced" }]).f0[0])).toBe(true);
  });

  it("applies in order (an octave on top of a repair)", () => {
    const out = applyCorrections(track([60, NaN, 60]), [
      { start: 0.01, end: 0.02, kind: "voiced" },
      { start: 0, end: 0.03, kind: "octave-up" },
    ]);
    expect(Array.from(out.f0)).toEqual([72, 72, 72]);
  });
});

describe("shift and set", () => {
  it("shifts a stretch by cents, and sets a stretch to one note (unvoiced frames included)", () => {
    const t = track([60, 60, Number.NaN, 60, 60]);
    const shifted = applyCorrections(t, [{ start: 0, end: 0.02, kind: "shift", cents: 700 }]);
    expect(Array.from(shifted.f0.slice(0, 2))).toEqual([67, 67]);
    expect(shifted.f0[3]).toBe(60);
    const set = applyCorrections(t, [{ start: 0.01, end: 0.04, kind: "set", midi: 64.5 }]);
    expect(Array.from(set.f0.slice(1, 4))).toEqual([64.5, 64.5, 64.5]);
    expect(set.voicedProb[2]).toBeGreaterThan(0.85);
    expect(set.f0[0]).toBe(60);
  });

  it("labels them", () => {
    const name = (midi: number) => `N${midi}`;
    expect(correctionLabel({ start: 0, end: 1, kind: "shift", cents: 10 }, name)).toBe("+10¢");
    expect(correctionLabel({ start: 0, end: 1, kind: "shift", cents: -100 }, name)).toBe("-1 半音");
    expect(correctionLabel({ start: 0, end: 1, kind: "set", midi: 62 }, name)).toBe("N62 に");
    expect(correctionLabel({ start: 0, end: 1, kind: "voiced" }, name)).toBe("有声に");
  });
});
