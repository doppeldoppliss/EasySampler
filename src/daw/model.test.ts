import { describe, expect, it } from "vitest";
import { fromSongNotes, sanitizeProject, shifted, snap, snapDown, songEnd, toSeqNotes, type Note } from "./model";

const note = (start: number, length: number, pitch: number): Note => ({ id: 0, start, length, pitch, velocity: 0.8 });

describe("daw model", () => {
  it("snaps to the grid (and leaves values alone with no grid)", () => {
    expect(snap(1.13, 0.25)).toBe(1.25);
    expect(snapDown(1.24, 0.25)).toBe(1);
    expect(snapDown(1.25, 0.25)).toBe(1.25);
    expect(snap(1.13, 0)).toBe(1.13);
    expect(snap(0.34, 1 / 3)).toBeCloseTo(1 / 3);
  });

  it("turns beats into seconds at the tempo, and cuts a same-pitch overlap where the next note starts", () => {
    const seq = toSeqNotes([note(0, 2, 60), note(1, 1, 60), note(1, 1, 64)], 120);
    expect(seq).toEqual([
      { start: 0, end: 0.5, note: 60, velocity: 0.8, drum: false },
      { start: 0.5, end: 1, note: 60, velocity: 0.8, drum: false },
      { start: 0.5, end: 1, note: 64, velocity: 0.8, drum: false },
    ]);
  });

  it("takes a MIDI part in beats, and copies with fresh ids", () => {
    const notes = fromSongNotes([{ start: 9, end: 9.5, pitch: 62, velocity: 127, channel: 0, startBeat: 4, endBeat: 4.5 }]);
    expect(notes).toMatchObject([{ start: 4, length: 0.5, pitch: 62, velocity: 1 }]);
    const copy = shifted(notes, 2, 12);
    expect(copy[0]).toMatchObject({ start: 6, pitch: 74 });
    expect(copy[0].id).not.toBe(notes[0].id);
    expect(songEnd([...notes, ...copy])).toBe(6.5);
  });

  it("repairs a stored project", () => {
    const p = sanitizeProject({ bpm: 9999, tracks: [{ notes: [{ start: -1, length: 0, pitch: 300 }, "x"] }], loop: { start: 4, end: 2 } });
    expect(p.bpm).toBe(400);
    expect(p.tracks[0].notes).toMatchObject([{ start: 0, pitch: 127 }]);
    expect(p.tracks[0].notes[0].length).toBeGreaterThan(0);
    expect(p.loop).toEqual({ start: 0, end: 16, on: false });
    expect(sanitizeProject(null).tracks).toHaveLength(1);
  });
});
