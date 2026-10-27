import { describe, expect, it } from "vitest";
import { fromSongNotes, newDrumTrack, removePad, sanitizeProject, shifted, snap, snapDown, songEnd, toSeqNotes, type Note } from "./model";

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

  it("portamento: a note that ends where one of another pitch starts is held a little past it (not one of the same pitch)", () => {
    const notes = [note(0, 1, 60), note(1, 1, 67), note(2, 1, 67), note(4, 1, 60)];
    const plain = toSeqNotes(notes, 120);
    const legato = toSeqNotes(notes, 120, true);
    expect(plain[0].end).toBe(0.5);
    expect(legato[0].end).toBeCloseTo(0.502, 6); // 60 → 67 touch: overlap
    expect(legato[1].end).toBe(1); // 67 → 67: a re-strike, as without portamento
    expect(legato[2].end).toBe(1.5); // a gap after it: nothing to slide to
    expect(legato[3].end).toBe(2.5);
  });

  it("keeps a track's portamento time (and puts a missing or odd one right)", () => {
    expect(sanitizeProject({ tracks: [{ glide: 0.15 }] }).tracks[0].glide).toBe(0.15);
    expect(sanitizeProject({ tracks: [{ glide: 99 }] }).tracks[0].glide).toBe(2);
    expect(sanitizeProject({ tracks: [{}] }).tracks[0].glide).toBe(0);
  });

  it("takes a MIDI part in beats, and copies with fresh ids", () => {
    const notes = fromSongNotes([{ start: 9, end: 9.5, pitch: 62, velocity: 127, channel: 0, startBeat: 4, endBeat: 4.5 }]);
    expect(notes).toMatchObject([{ start: 4, length: 0.5, pitch: 62, velocity: 1 }]);
    const copy = shifted(notes, 2, 12);
    expect(copy[0]).toMatchObject({ start: 6, pitch: 74 });
    expect(copy[0].id).not.toBe(notes[0].id);
    expect(songEnd([...notes, ...copy])).toBe(6.5);
  });

  it("drum rows: removing one drops its notes and moves the rows below up", () => {
    const t = newDrumTrack("ドラム 1", "m/kick");
    t.pads.push({ instrument: "m/snare" }, { instrument: "m/hat" });
    t.notes = [note(0, 1, 0), note(1, 1, 1), note(2, 1, 2)];
    removePad(t, 1);
    expect(t.pads.map((p) => p.instrument)).toEqual(["m/kick", "m/hat"]);
    expect(t.notes.map((n) => [n.start, n.pitch])).toEqual([
      [0, 0],
      [2, 1],
    ]);
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
