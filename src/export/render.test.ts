import { describe, expect, it } from "vitest";
import { analyzePitch } from "../analysis/pyin";
import { rootPitch } from "../analysis/rootPitch";
import { analyzeMaterial, prepareSource } from "../engine/prepare";
import { DEFAULT_EXPORT, DEFAULT_PARAMS, PRESETS, exportLengthSec, type InstrumentParams } from "../instrument/types";
import { demoSyllable } from "../testsignals/synthVoice";
import { exportFileName, renderNote } from "./render";

const SR = 44100;

function setup(overrides: Partial<InstrumentParams> = {}) {
  const material = demoSyllable(SR); // 0.09 s hiss + 0.75 s vowel around D4
  const analysis = analyzeMaterial([material], SR);
  const source = prepareSource([material], analysis, SR);
  const params: InstrumentParams = { ...DEFAULT_PARAMS, root: analysis.root!.midi, ...overrides };
  return { analysis, source, params };
}

function rms(x: Float32Array, from: number, to: number): number {
  let acc = 0;
  for (let i = from; i < to; i++) acc += x[i] * x[i];
  return Math.sqrt(acc / Math.max(1, to - from));
}

describe("renderNote (the exported file)", () => {
  it("comes out at the target note, flat, and about as long as asked", () => {
    const { analysis, source, params } = setup();
    const out = renderNote(source, analysis.markers, params, 64, 1.5);
    expect(out.sampleRate).toBe(SR);
    expect(out.channels).toHaveLength(1);
    const seconds = out.channels[0].length / SR;
    expect(seconds).toBeGreaterThan(1.4);
    expect(seconds).toBeLessThan(1.6);
    const pitch = rootPitch(analyzePitch(out.channels[0].slice(Math.round(0.3 * SR), Math.round(1.4 * SR)), SR))!;
    expect(Math.abs(pitch.midi - 64)).toBeLessThan(0.2);
    expect(pitch.spread).toBeLessThan(0.15);
  });

  it("keeps the consonant at the start and holds the level to the end", () => {
    const { analysis, source, params } = setup();
    const out = renderNote(source, analysis.markers, params, 60, 2).channels[0];
    expect(rms(out, 0, Math.round(0.07 * SR))).toBeGreaterThan(0.01);
    const early = rms(out, Math.round(0.4 * SR), Math.round(0.8 * SR));
    const late = rms(out, Math.round(1.5 * SR), Math.round(1.9 * SR));
    expect(late / early).toBeGreaterThan(0.6);
    expect(late / early).toBeLessThan(1.6);
  });

  it("is deterministic: the same settings give the same samples", () => {
    const { analysis, source, params } = setup();
    const a = renderNote(source, analysis.markers, params, 62, 1).channels[0];
    const b = renderNote(source, analysis.markers, params, 62, 1).channels[0];
    expect(a.length).toBe(b.length);
    expect(a.every((v, i) => v === b[i])).toBe(true);
  });

  it("a one-shot plays the material out and ignores the length", () => {
    const { analysis, source, params } = setup();
    const drum = PRESETS.find((p) => p.id === "drum")!.apply(params);
    const out = renderNote(source, analysis.markers, drum, Math.round(params.root), 5).channels[0];
    const range = analysis.markers.rangeEnd - analysis.markers.rangeStart;
    expect(out.length / SR).toBeGreaterThan(range * 0.8);
    expect(out.length / SR).toBeLessThan(range + 0.15);
  });

  it("never clips", () => {
    const { analysis, source, params } = setup();
    const out = renderNote(source, analysis.markers, { ...params, amp: { ...params.amp, velocitySens: 0 } }, 48, 1).channels[0];
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThanOrEqual(0.98 + 1e-6);
  });

  it("renders stereo when the material is stereo", () => {
    const material = demoSyllable(SR);
    const right = material.map((v) => v * 0.5);
    const analysis = analyzeMaterial([material, right], SR);
    const source = prepareSource([material, right], analysis, SR);
    const out = renderNote(source, analysis.markers, { ...DEFAULT_PARAMS, root: analysis.root!.midi }, 62, 0.5);
    expect(out.channels).toHaveLength(2);
    const l = rms(out.channels[0], 0, out.channels[0].length);
    const r = rms(out.channels[1], 0, out.channels[1].length);
    expect(r / l).toBeGreaterThan(0.4);
    expect(r / l).toBeLessThan(0.6);
  });
});

describe("export settings", () => {
  it("turns beats and BPM into seconds", () => {
    expect(exportLengthSec({ ...DEFAULT_EXPORT, beats: 2, bpm: 120 })).toBeCloseTo(1);
    expect(exportLengthSec({ ...DEFAULT_EXPORT, beats: 2, bpm: 165 })).toBeCloseTo(0.727, 2);
    expect(exportLengthSec({ ...DEFAULT_EXPORT, lengthMode: "seconds", seconds: 3 })).toBe(3);
  });

  it("names the file after the material, the note and the length", () => {
    expect(exportFileName("ore.mp4", 60, { ...DEFAULT_EXPORT, beats: 2, bpm: 165 }, false)).toBe("ore_C4_2beat@165.wav");
    expect(exportFileName("a:b/c.wav", 61, { ...DEFAULT_EXPORT, lengthMode: "seconds", seconds: 1.5 }, false)).toBe("a_b_c_Cs4_1.5s.wav");
    expect(exportFileName("hit", 59, DEFAULT_EXPORT, true)).toBe("hit_B3.wav");
  });
});
