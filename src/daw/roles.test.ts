import { describe, expect, it } from "vitest";
import type { Note } from "./model";
import { autoNames, isGenericName, rangeFromRoot, spreadPans, trackRoles } from "./roles";

const line = (pitches: number[], step = 1): Note[] => pitches.map((p, i) => ({ id: i, start: i * step, length: step, pitch: p, velocity: 0.8 }));
const chords = (roots: number[]): Note[] => roots.flatMap((r, i) => [r, r + 4, r + 7].map((p, k) => ({ id: i * 3 + k, start: i * 2, length: 2, pitch: p, velocity: 0.7 })));
const melodic = (notes: Note[], name = "MIDI Out") => ({ kind: "melodic" as const, notes, name });
const song = [
  { kind: "drum" as const, notes: line([36, 38, 36, 38]), name: "MIDI Out #10" },
  melodic(line([36, 38, 40, 41, 43, 36, 38]), "MIDI Out #2"),
  melodic(line([72, 74, 76, 77, 79, 77, 76, 74, 72, 71, 72, 74], 0.5), "MIDI Out #1"),
  melodic(chords([60, 65, 67, 60]), "MIDI Out #3"),
  melodic(line([64, 65, 67, 64]), "MIDI Out #4"),
  melodic(line([55, 57, 59, 60]), "Strings"),
];

describe("track roles", () => {
  it("tells the drums, the bass, the lead, chords and the rest apart", () => {
    expect(trackRoles(song).map((r) => r.role)).toEqual(["drum", "bass", "lead", "chords", "backing", "backing"]);
  });

  it("names the nameless tracks by role (or GM family), numbering repeats, and keeps the names a track has", () => {
    expect(isGenericName("MIDI Out #12")).toBe(true);
    expect(isGenericName("Strings")).toBe(false);
    expect(autoNames(song)).toEqual(["ドラム", "ベース", "メロディ", "和音", "伴奏", null]);
    // A GM program for the backing line: its family (the lead keeps its role's name).
    expect(autoNames(song, [null, null, 0, null, 25, null])[4]).toBe("ギター");
    expect(autoNames([melodic(line([64, 65])), melodic(line([66, 67]))])).toEqual(["伴奏", "メロディ"]);
  });

  it("spreads the chords and the accompaniment left and right, the drums, bass and lead in the middle", () => {
    const pans = spreadPans(song);
    expect(pans[0]).toBe(0);
    expect(pans[1]).toBe(0);
    expect(pans[2]).toBe(0);
    const sides = [pans[3]!, pans[4]!, pans[5]!];
    expect(sides.some((p) => p < 0)).toBe(true);
    expect(sides.some((p) => p > 0)).toBe(true);
    for (const p of sides) expect(Math.abs(p)).toBeGreaterThanOrEqual(0.35);
  });

  it("measures how far the notes go from the recorded pitch", () => {
    expect(rangeFromRoot(line([30, 40, 50, 60, 70]), 66)).toEqual({ below: 36, above: 4 });
  });
});
