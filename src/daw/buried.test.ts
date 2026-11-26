import { describe, expect, it } from "vitest";
import type { Audibility } from "../audio/ear";
import { buriedPoints, heardCell, type HeardTrack } from "./buried";

const a = (share: number, coveredBy: number | null, worstHz = 660, playing = 0.9): Audibility => ({ playing, share, heard: share * 3, worstHz, coveredBy, leastFrom: 72 });

describe("埋もれ diagnosis", () => {
  it("names a track the others cover, what covers it and where; a melody sooner than the rest", () => {
    const tracks: HeardTrack[] = [
      { name: "ベース 1", role: "bass", heard: a(0.001, 1) },
      { name: "ベース 2", role: "bass", heard: a(0.2, 2, 570) },
      { name: "和音 4", role: "chords", heard: a(0.087, 1) },
      { name: "メロディ 5", role: "lead", heard: a(0.018, 3, 1666) },
      { name: "メロディ 6", role: "lead", heard: a(0.2, 1, 3016) },
    ];
    const points = buriedPoints(tracks);
    expect(points.some((p) => p.includes("「ベース 1」(ベース)はほかの音に隠れて") && p.includes("「ベース 2」が 660 Hz") && p.includes("1:12"))).toBe(true);
    expect(points.some((p) => p.includes("メロディ「メロディ 5」がほかの音に隠れています") && p.includes("1.7 kHz"))).toBe(true);
    // 和音 4 at 8.7% is heard; ベース 2 and 和音 4 cover each other but are different parts.
    expect(points.some((p) => p.includes("「和音 4」"))).toBe(false);
    expect(points).toHaveLength(2);
    expect(heardCell(tracks[0], tracks)).toBe("0.1%(「ベース 2」・660 Hz)");
  });

  it("says when two tracks of one part cover each other, once", () => {
    const tracks: HeardTrack[] = [
      { name: "ベース 1", role: "bass", heard: a(0.028, 1, 660) },
      { name: "ベース 2", role: "bass", heard: a(0.105, 0, 570) },
      { name: "メロディ 5", role: "lead", heard: a(0.068, 3, 1666) },
      { name: "メロディ 6", role: "lead", heard: a(0.086, 2, 1666) },
    ];
    const points = buriedPoints(tracks);
    expect(points).toHaveLength(2);
    expect(points[0]).toContain("「ベース 1」と「ベース 2」(どちらもベース)が同じ音域(660 Hz あたり)");
    expect(points[1]).toContain("「メロディ 5」と「メロディ 6」");
  });

  it("leaves out what was not measured or barely plays", () => {
    const tracks: HeardTrack[] = [
      { name: "フィル", role: "backing", heard: a(0.001, 1, 660, 0.03) },
      { name: "ミュート", role: "chords", heard: null },
    ];
    expect(buriedPoints(tracks)).toEqual([]);
    expect(heardCell(tracks[0], tracks)).toBe("—");
  });
});
