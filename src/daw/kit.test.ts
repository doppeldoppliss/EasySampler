import { describe, expect, it } from "vitest";
import { remapMaterials } from "../audio/projects";
import { drumRows, guessKey, newSlot, renderSlot, sanitizeKit } from "./kit";

describe("drum kit", () => {
  it("puts a file on the key its name says, or the next common one free", () => {
    const none = new Set<number>();
    expect(guessKey("Kick_01", none)).toBe(36);
    expect(guessKey("snare-tight", none)).toBe(38);
    expect(guessKey("HH closed", none)).toBe(42);
    expect(guessKey("open hat", none)).toBe(46);
    expect(guessKey("clap", none)).toBe(39);
    expect(guessKey("crash cymbal", none)).toBe(49);
    expect(guessKey("キック", none)).toBe(36);
    expect(guessKey("whoosh", none)).toBe(36);
    expect(guessKey("whoosh", new Set([36, 38]))).toBe(42);
  });

  it("shows the core drums, the kit's keys and the keys the notes use, kick first", () => {
    const kit = { slots: [newSlot(56, "s1", "cowbell")] };
    expect(drumRows(kit, [{ pitch: 81 }])).toEqual([36, 37, 38, 39, 42, 46, 49, 56, 81]);
  });

  it("cuts, fades and resamples a sound as the engine plays it", () => {
    const sr = 1000;
    const x = new Float32Array(1000).fill(1);
    const slot = { ...newSlot(36, "s", "kick"), start: 0.1, end: 0.5, fade: 0.1, gain: 0.5 };
    const [y] = renderSlot(slot, [x], sr, sr, (a) => a);
    expect(y.length).toBe(400);
    expect(y[200]).toBeCloseTo(0.5);
    expect(y[0]).toBe(0); // faded in over a hair
    expect(y[399]).toBeLessThan(0.01); // faded out
    const [z] = renderSlot({ ...slot, end: 0 }, [x], sr, 2 * sr, (a, ratio) => new Float32Array(Math.floor(a.length * ratio)).fill(1));
    expect(z.length).toBe(1800); // to the end, at twice the rate
  });

  it("repairs a stored kit (one slot per key, in key order)", () => {
    const kit = sanitizeKit({ slots: [{ key: 42, sample: "a" }, { key: 36, sample: "b", gain: 9 }, { key: 42 }, "x"] });
    expect(kit.slots.map((s) => [s.key, s.sample, s.gain])).toEqual([
      [36, "b", 4],
      [42, "a", 1],
    ]);
  });

  it("a copied project's kit points at the copied sounds", () => {
    const out = remapMaterials({ materials: [], kit: { slots: [{ key: 36, sample: "k1" }, { key: 38, sample: null }] } }, new Map([["k1", "k2"]])) as { kit: { slots: { sample: string | null }[] } };
    expect(out.kit.slots.map((s) => s.sample)).toEqual(["k2", null]);
  });
});

describe("drum kit: where a hit begins", async () => {
  const { detectOnset } = await import("./kit");
  it("finds the hit after leading silence, a hair early; 0 for silence or a hit at the start", () => {
    const sr = 10000;
    const x = new Float32Array(sr);
    for (let i = 3000; i < 4000; i++) x[i] = 0.5 * Math.exp(-(i - 3000) / 300);
    for (let i = 0; i < 3000; i++) x[i] = 0.0005; // a little noise floor
    expect(detectOnset([x], sr)).toBeCloseTo(0.298, 3);
    expect(detectOnset([new Float32Array(100)], sr)).toBe(0);
    const y = new Float32Array(100).fill(0.3);
    expect(detectOnset([y], sr)).toBe(0);
  });
});
