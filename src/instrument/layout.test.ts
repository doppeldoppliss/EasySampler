import { describe, expect, it } from "vitest";
import { analyzePitch } from "../analysis/pyin";
import { Engine } from "../engine/engine";
import { analyzeMaterial, prepareSource } from "../engine/prepare";
import { renderNote } from "../export/render";
import { demoSyllable } from "../testsignals/synthVoice";
import { collapsedTime, expandedTime, normalizeRemoved, outputLayout, removedWithin, usedBetween } from "./layout";
import { DEFAULT_PARAMS, type InstrumentParams, type Markers } from "./types";

const SR = 44100;

const markers: Markers = { rangeStart: 0.1, rangeEnd: 1.1, attack: 0.2, sustainStart: 0.3, sustainEnd: 0.6, tailStart: 0.6 };

describe("removals", () => {
  it("normalizes: sorted, merged, clamped to the range, empties dropped", () => {
    const out = normalizeRemoved(
      [
        { start: 0.9, end: 1.5 },
        { start: 0.5, end: 0.4 }, // reversed
        { start: 0.35, end: 0.45 },
        { start: 0.0, end: 0.15 },
        { start: 0.7, end: 0.7 },
      ],
      0.1,
      1.1,
    );
    expect(out).toEqual([
      { start: 0.1, end: 0.15 },
      { start: 0.35, end: 0.5 },
      { start: 0.9, end: 1.1 },
    ]);
  });

  it("measures what is removed within a span, and what is left", () => {
    const removed = [{ start: 0.35, end: 0.45 }];
    expect(removedWithin(removed, 0.3, 0.6)).toBeCloseTo(0.1);
    expect(removedWithin(removed, 0.4, 0.6)).toBeCloseTo(0.05);
    expect(removedWithin(removed, 0.5, 0.6)).toBe(0);
    expect(usedBetween({ ...markers, removed }, 0.3, 0.6)).toBeCloseTo(0.2);
    expect(usedBetween(markers, 0.3, 0.6)).toBeCloseTo(0.3);
  });
});

describe("outputLayout", () => {
  it("elastic sustain fills the hold after the head; the tail follows when enabled", () => {
    const p: InstrumentParams = { ...DEFAULT_PARAMS, tail: { enabled: true, limit: "unlimited" } };
    const layout = outputLayout(markers, p, 2);
    expect(layout.headSec).toBeCloseTo(0.2);
    expect(layout.sustainSec).toBeCloseTo(1.8);
    expect(layout.tailSec).toBeCloseTo(0.5);
    expect(layout.sustainRatio).toBeCloseTo(6);
    expect(layout.elastic).toBe(true);
    expect(layout.totalSec).toBeCloseTo(2.5);
    expect(outputLayout(markers, { ...DEFAULT_PARAMS, tail: { enabled: false, limit: "unlimited" } }, 2).tailSec).toBe(0);
  });

  it("head and tail stretch; a one-shot plays every part at its own speed and ignores the hold", () => {
    const p: InstrumentParams = { ...DEFAULT_PARAMS, sustainMode: "none", stretch: { head: 2, sustain: 3, tail: 0.5 } };
    const layout = outputLayout(markers, p, 99);
    expect(layout.headSec).toBeCloseTo(0.4);
    expect(layout.sustainSec).toBeCloseTo(0.9);
    expect(layout.tailSec).toBeCloseTo(0.25);
    expect(layout.elastic).toBe(false);
    expect(layout.totalSec).toBeCloseTo(1.55);
  });

  it("removed stretches shorten the parts they fall in", () => {
    const m: Markers = { ...markers, removed: [{ start: 0.15, end: 0.25 }, { start: 0.4, end: 0.5 }] };
    const layout = outputLayout(m, { ...DEFAULT_PARAMS, sustainMode: "none" }, 1);
    expect(layout.headSrcSec).toBeCloseTo(0.1);
    expect(layout.sustainSrcSec).toBeCloseTo(0.2);
  });
});

describe("engine: removals and speeds", () => {
  function setup(overrides: Partial<InstrumentParams> = {}, edit: (m: Markers) => Markers = (m) => m) {
    const material = demoSyllable(SR); // 0.09 s hiss, then the vowel
    const analysis = analyzeMaterial([material], SR);
    const source = prepareSource([material], analysis, SR);
    const params: InstrumentParams = { ...DEFAULT_PARAMS, root: analysis.root!.midi, ...overrides };
    return { analysis, source, params, markers: edit(analysis.markers) };
  }
  const voicedOnset = (x: Float32Array) => analyzePitch(x, SR).f0.findIndex((v) => Number.isFinite(v)) * 0.005;

  it("skips a removed stretch: cutting the hiss out makes the vowel start at once", () => {
    const plain = setup();
    const before = renderNote(plain.source, plain.markers, plain.params, 62, 1).channels[0];
    const cut = setup({}, (m) => ({ ...m, removed: [{ start: m.rangeStart, end: m.sustainStart - 0.005 }] }));
    const after = renderNote(cut.source, cut.markers, cut.params, 62, 1).channels[0];
    expect(voicedOnset(before)).toBeGreaterThan(0.06);
    expect(voicedOnset(after)).toBeLessThan(0.03);
  });

  it("stretches the head: at ×2 a one-shot grows by the head's length", () => {
    const one = setup({ sustainMode: "none" });
    const two = setup({ sustainMode: "none", stretch: { head: 2, sustain: 1, tail: 1 } });
    const a = renderNote(one.source, one.markers, one.params, 62, 1).channels[0].length / SR;
    const b = renderNote(two.source, two.markers, two.params, 62, 1).channels[0].length / SR;
    const headSrc = one.markers.sustainStart - one.markers.rangeStart;
    expect(headSrc).toBeGreaterThan(0.05);
    expect(b - a).toBeGreaterThan(headSrc * 0.8);
    expect(b - a).toBeLessThan(headSrc * 1.2);
  });

  it("a one-shot with the sustain at ×3 comes out longer by the stretched amount", () => {
    const base = setup({ sustainMode: "none" });
    const stretched = setup({ sustainMode: "none", stretch: { head: 1, sustain: 3, tail: 1 } });
    const a = renderNote(base.source, base.markers, base.params, 62, 1).channels[0].length / SR;
    const b = renderNote(stretched.source, stretched.markers, stretched.params, 62, 1).channels[0].length / SR;
    const sustainSrc = base.markers.sustainEnd - base.markers.sustainStart;
    expect(b - a).toBeGreaterThan(sustainSrc * 2 * 0.8);
    expect(b - a).toBeLessThan(sustainSrc * 2 * 1.2);
  });

  it("the pool ignores marks inside a removed stretch", () => {
    const { analysis, source, params } = setup();
    const m = analysis.markers;
    // Remove all but the first 30 ms of the sustain: the pool shrinks but the note still plays.
    const engine = new Engine(SR);
    engine.setSource(source);
    engine.setInstrument({ ...m, removed: [{ start: m.sustainStart + 0.03, end: m.sustainEnd }] }, params);
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    engine.noteOn(62, 1);
    let energy = 0;
    for (let i = 0; i < 300; i++) {
      engine.render(l, r);
      if (i > 150) for (const v of l) energy += v * v;
    }
    expect(energy).toBeGreaterThan(0.01);
  });
});

describe("collapsed / expanded time (the editor's view with removals closed up)", () => {
  const removed = [
    { start: 0.2, end: 0.3 },
    { start: 0.5, end: 0.7 },
  ];
  it("closes up the removed stretches and lands inside ones on the seam", () => {
    expect(collapsedTime(0.1, removed)).toBeCloseTo(0.1);
    expect(collapsedTime(0.25, removed)).toBeCloseTo(0.2);
    expect(collapsedTime(0.4, removed)).toBeCloseTo(0.3);
    expect(collapsedTime(0.6, removed)).toBeCloseTo(0.4);
    expect(collapsedTime(1.0, removed)).toBeCloseTo(0.7);
  });
  it("inverts, skipping the removed stretches", () => {
    expect(expandedTime(0.1, removed)).toBeCloseTo(0.1);
    expect(expandedTime(0.2, removed)).toBeCloseTo(0.3); // the seam shows what follows the cut
    expect(expandedTime(0.3, removed)).toBeCloseTo(0.4);
    expect(expandedTime(0.4, removed)).toBeCloseTo(0.7);
    expect(expandedTime(0.7, removed)).toBeCloseTo(1.0);
    for (const t of [0, 0.15, 0.35, 0.45, 0.8, 1.2]) expect(expandedTime(collapsedTime(t, removed), removed)).toBeCloseTo(t);
  });
});
