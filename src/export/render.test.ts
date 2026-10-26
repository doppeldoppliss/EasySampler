import { describe, expect, it } from "vitest";
import { analyzePitch } from "../analysis/pyin";
import { rootPitch } from "../analysis/rootPitch";
import { analyzeMaterial, prepareSource } from "../engine/prepare";
import { DEFAULT_EXPORT, DEFAULT_FX, DEFAULT_PARAMS, PRESETS, exportLengthSec, type InstrumentParams } from "../instrument/types";
import { demoSyllable } from "../testsignals/synthVoice";
import { exportFileName, renderNote, safeBaseName, stripExtension } from "./render";

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
  it("comes out at the target note, flat, and about as long as asked (no tail)", () => {
    const { analysis, source, params } = setup({ tail: { enabled: false, limit: "unlimited" } });
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

describe("file names", () => {
  it("keeps dots inside a name, strips one extension, and avoids what Windows refuses", () => {
    expect(stripExtension("take.1.wav")).toBe("take.1");
    expect(stripExtension("声")).toBe("声");
    expect(safeBaseName("a/b:c*d?e\"f<g>h|i")).toBe("a_b_c_d_e_f_g_h_i");
    expect(safeBaseName("name. ")).toBe("name");
    expect(safeBaseName("aux")).toBe("aux_");
    expect(safeBaseName("COM1")).toBe("COM1_");
    expect(safeBaseName("   ")).toBe("material");
    expect(safeBaseName("take.1")).toBe("take.1");
  });
});

describe("export settings", () => {
  it("turns beats and BPM into seconds", () => {
    expect(exportLengthSec({ ...DEFAULT_EXPORT, beats: 2, bpm: 120 })).toBeCloseTo(1);
    expect(exportLengthSec({ ...DEFAULT_EXPORT, beats: 2, bpm: 165 })).toBeCloseTo(0.727, 2);
    expect(exportLengthSec({ ...DEFAULT_EXPORT, lengthMode: "seconds", seconds: 3 })).toBe(3);
  });

  it("names the file after the material, the note and the length", () => {
    expect(exportFileName("ore", 60, { ...DEFAULT_EXPORT, beats: 2, bpm: 165 }, false)).toBe("ore_C4_2beat@165.wav");
    expect(exportFileName("take.1", 60, { ...DEFAULT_EXPORT, beats: 2, bpm: 165 }, false)).toBe("take.1_C4_2beat@165.wav"); // (the extension is stripped once, by whoever holds the file name)
    expect(exportFileName("a:b/c", 61, { ...DEFAULT_EXPORT, lengthMode: "seconds", seconds: 1.5 }, false)).toBe("a_b_c_Cs4_1.5s.wav");
    expect(exportFileName("hit", 59, DEFAULT_EXPORT, true)).toBe("hit_B3.wav");
  });
});

describe("renderNote with effects", () => {
  it("bakes the effects in: a mono material with chorus comes out stereo, about as long as without", () => {
    const { analysis, source, params } = setup();
    const plain = renderNote(source, analysis.markers, params, 62, 1);
    const fx = structuredClone(DEFAULT_FX);
    fx.chorus.on = true;
    fx.chorus.mix = 0.6;
    const out = renderNote(source, analysis.markers, params, 62, 1, 120, fx);
    expect(out.channels).toHaveLength(2);
    const [l, r] = out.channels;
    let diff = 0;
    for (let i = 0; i < l.length; i++) diff += Math.abs(l[i] - r[i]);
    expect(diff / l.length).toBeGreaterThan(1e-3);
    expect(Math.abs(l.length - plain.channels[0].length) / SR).toBeLessThan(0.2);
  });

  it("lines the limiter's look-ahead back up: the note starts where it did without it", () => {
    const { analysis, source, params } = setup();
    const onset = (x: Float32Array) => x.findIndex((v) => Math.abs(v) > 1e-3);
    const plain = renderNote(source, analysis.markers, params, 62, 1);
    const fx = structuredClone(DEFAULT_FX);
    fx.limiter.on = true;
    fx.limiter.gainDb = 0;
    const limited = renderNote(source, analysis.markers, params, 62, 1, 120, fx);
    expect(Math.abs(onset(limited.channels[0]) - onset(plain.channels[0]))).toBeLessThanOrEqual(2);
  });
});

describe("renderNote with the tail (on by default)", () => {
  it("runs on past the asked length by the tail", () => {
    const { analysis, source, params } = setup();
    expect(params.tail.enabled).toBe(true);
    const withTail = renderNote(source, analysis.markers, params, 64, 1.5);
    const without = renderNote(source, analysis.markers, { ...params, tail: { enabled: false, limit: "unlimited" } }, 64, 1.5);
    expect(withTail.channels[0].length).toBeGreaterThan(without.channels[0].length);
  });
});
