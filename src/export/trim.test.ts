import { describe, expect, it } from "vitest";
import { trimClips } from "../daw/model";
import { DEFAULT_PARAMS } from "../instrument/types";
import { trimSettings } from "./settings";

describe("素材を切り詰める", () => {
  const markers = { rangeStart: 1, rangeEnd: 3, attack: 1, sustainStart: 1.5, sustainEnd: 2.5, tailStart: 2.5, removed: [{ start: 0.2, end: 0.6 }, { start: 2, end: 2.2 }] };
  const settings = {
    material: { name: "x", durationSec: 5, sampleRate: 44100, channels: 1 },
    cuts: [{ id: "a", name: "音源 1", markers, params: DEFAULT_PARAMS, note: 60, noteMode: "auto" as const }],
    corrections: [{ start: 0, end: 0.5, kind: "unvoiced" as const }, { start: 1.2, end: 1.4, kind: "unvoiced" as const }],
  };

  it("moves every marker, removed stretch and correction back, dropping what was cut away", () => {
    const out = trimSettings(settings, 0.8, 3);
    const m = out.cuts[0].markers;
    expect([m.rangeStart, m.sustainStart, m.sustainEnd, m.rangeEnd].map((v) => +v.toFixed(3))).toEqual([0.2, 0.7, 1.7, 2.2]);
    expect(m.removed).toEqual([{ start: expect.closeTo(1.2), end: expect.closeTo(1.4) }]);
    expect(out.corrections.map((c) => [+c.start.toFixed(2), +c.end.toFixed(2)])).toEqual([[0.4, 0.6]]);
    expect(out.material.durationSec).toBe(3);
  });

  it("moves a material's clips, in a song as it is kept; a clip that began in the cut part starts at the new start", () => {
    const tracks = [
      { kind: "audio", notes: [{ clip: { material: "m1", offset: 2 } }, { clip: { material: "m1", offset: 0.3 } }, { clip: { material: "m2", offset: 2 } }] },
      { kind: "melodic", notes: [{ pitch: 60 }] },
    ];
    expect(trimClips(tracks, "m1", 0.8)).toBe(2);
    expect((tracks[0].notes as { clip: { offset: number } }[]).map((n) => n.clip.offset)).toEqual([expect.closeTo(1.2), 0, 2]);
  });

  it("a clip that began in the cut part starts later by what was cut, so it stays where its sound was; one wholly cut goes", () => {
    // 120 BPM: a beat is 0.5 s. Cut 1 s off the front.
    const tracks = [
      {
        kind: "audio",
        notes: [
          { start: 4, length: 4, clip: { material: "m1", offset: 0.5 } }, // 0.5 s of it gone: starts 1 beat later
          { start: 8, length: 1, clip: { material: "m1", offset: 0 } }, // 0.5 s long, all inside the cut: gone
          { start: 0, length: 2, clip: { material: "m1", offset: 3 } }, // after the cut: only its offset moves
        ],
      },
    ];
    expect(trimClips(tracks, "m1", 1, 120)).toBe(3);
    const notes = tracks[0].notes;
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({ start: 5, length: 3, clip: { offset: 0 } });
    expect(notes[1]).toMatchObject({ start: 0, length: 2, clip: { offset: 2 } });
  });
});
