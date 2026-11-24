import { describe, expect, it } from "vitest";
import { barThickness, sceneLine, scenes } from "./dynamics";
import type { Note } from "./model";

let id = 0;
const note = (start: number, length: number, velocity = 1): Note => ({ id: id++, start, length, pitch: 60, velocity });
/** A track holding one note through each of these bars (4 beats a bar). */
const held = (from: number, to: number, velocity = 1) => Array.from({ length: to - from }, (_, k) => note((from + k) * 4, 4, velocity));

describe("場面の強弱", () => {
  it("measures a bar by the tracks sounding in it, for how much of it and how hard", () => {
    const t = barThickness([held(0, 2), [note(4, 2)], [note(4, 4, 0.5)]], 4);
    expect(t).toHaveLength(2);
    expect(t[0]).toBeCloseTo(1);
    expect(t[1]).toBeCloseTo(1 + 0.5 + 0.5);
    // A drum hit fills half a beat however short its note is.
    expect(barThickness([[note(0, 0.05), note(2, 0.05)]], 4)[0]).toBeCloseTo(0.25);
  });

  it("brings the thin scenes down and leaves the full ones", () => {
    // 4 bars of one track, 8 of four, 4 of two, 8 of four.
    const tracks = [held(0, 24), held(4, 12).concat(held(16, 24)), held(4, 12).concat(held(16, 24)), held(4, 24)];
    const list = scenes(barThickness(tracks, 4), 3);
    expect(list.map((s) => [s.from, s.to, s.db])).toEqual([
      [0, 4, -3],
      [4, 12, 0],
      [12, 16, -3],
      [16, 24, 0],
    ]);
    const line = sceneLine(list, 4);
    const quiet = Math.round(10 ** (-3 / 20) * 1000) / 1000;
    // Up over the beat before the full scene, down over the first beat of the thin one.
    expect(line).toEqual([
      { beat: 0, value: quiet },
      { beat: 15, value: quiet },
      { beat: 16, value: 1 },
      { beat: 48, value: 1 },
      { beat: 49, value: quiet },
      { beat: 63, value: quiet },
      { beat: 64, value: 1 },
      { beat: 96, value: 1 },
    ]);
    for (let k = 1; k < line.length; k++) expect(line[k].beat).toBeGreaterThanOrEqual(line[k - 1].beat);
  });

  it("takes the thinnest scene down by the whole depth, the ones between in part, and does not chase a one-bar break", () => {
    // Four tracks, three in bars 8–15 (the thinnest scene), one alone in bar 20.
    const tracks = [held(0, 24), held(0, 20).concat(held(21, 24)), held(0, 20).concat(held(21, 24)), held(0, 8).concat(held(16, 20), held(21, 24))];
    const list = scenes(barThickness(tracks, 4), 3);
    expect(list.map((s) => [s.from, s.to, s.db])).toEqual([
      [0, 8, 0],
      [8, 16, -3],
      [16, 24, 0],
    ]);
    const bars = (x: number) => [x, x, x, x];
    expect(scenes([...bars(4), ...bars(3), ...bars(2)], 3).map((s) => s.db)).toEqual([0, -1.5, -3]);
    // A lone thin intro takes the whole depth; the scene at three quarters is then only half way down.
    expect(scenes([...bars(1), ...bars(4), ...bars(3)], 3).map((s) => s.db)).toEqual([-3, 0, -1.5]);
    // Scenes within 15% of each other are one thickness.
    expect(scenes([...bars(4), ...bars(3.6), ...bars(4)], 3).map((s) => s.db)).toEqual([0]);
  });

  it("draws nothing for a song of one thickness, or with no notes", () => {
    expect(sceneLine(scenes(barThickness([held(0, 16), held(0, 16)], 4), 3), 4)).toEqual([]);
    expect(scenes(barThickness([], 4), 3)).toEqual([]);
  });
});
