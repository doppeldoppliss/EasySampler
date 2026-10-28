import { describe, expect, it } from "vitest";
import { arrange, arrangeLine, arrangeNotes } from "./arrange";
import { emptyProject, type Note } from "./model";

const note = (start: number, length: number, pitch = 60): Note => ({ id: 0, start, length, pitch, velocity: 0.8 });
const starts = (notes: Note[]) => notes.map((n) => [n.start, n.length]);

describe("arrange", () => {
  it("inserts a blank: what starts at or after the point moves along", () => {
    const out = arrangeNotes([note(0, 2), note(4, 1), note(6, 1)], "insert", 4, 8);
    expect(starts(out)).toEqual([[0, 2], [8, 1], [10, 1]]);
  });

  it("deletes a stretch: its notes go, a note held into it is cut, the rest moves back", () => {
    const out = arrangeNotes([note(2, 4), note(4, 1), note(7, 1), note(8, 2)], "delete", 4, 8);
    expect(starts(out)).toEqual([[2, 2], [4, 2]]);
  });

  it("duplicates a stretch right after itself, moving the rest along", () => {
    const out = arrangeNotes([note(0, 1), note(1, 1), note(4, 1)], "duplicate", 0, 4);
    expect(starts(out)).toEqual([[0, 1], [1, 1], [4, 1], [5, 1], [8, 1]]);
  });

  it("keeps a line's shape: a ramp over a duplicated stretch ramps again in the copy", () => {
    const line = [{ beat: 0, value: 0 }, { beat: 4, value: 1 }];
    const out = arrangeLine(line, "duplicate", 0, 4);
    expect(out).toEqual([{ beat: 0, value: 0 }, { beat: 4, value: 1 }, { beat: 4, value: 0 }, { beat: 8, value: 1 }]);
    // Insert: the value at the point holds across the blank.
    expect(arrangeLine(line, "insert", 2, 4)).toEqual([{ beat: 0, value: 0 }, { beat: 2, value: 0.5 }, { beat: 4, value: 0.5 }, { beat: 6, value: 1 }]);
    // Delete: a step from the value at the cut to the value where the stretch ended.
    expect(arrangeLine(line, "delete", 1, 3)).toEqual([{ beat: 0, value: 0 }, { beat: 1, value: 0.25 }, { beat: 1, value: 0.75 }, { beat: 2, value: 1 }]);
    expect(arrangeLine([], "insert", 0, 4)).toEqual([]);
  });

  it("works on every track and the master line; a copy moves the loop onto it", () => {
    const p = emptyProject();
    p.tracks[0].notes = [note(0, 1)];
    p.tracks.push({ ...p.tracks[0], id: "b", notes: [note(2, 1, 36)] });
    p.masterAuto = [{ beat: 0, value: 1 }];
    p.loop = { start: 0, end: 4, on: true };
    arrange(p, "duplicate", 0, 4);
    expect(p.tracks.map((t) => t.notes.map((n) => n.start))).toEqual([[0, 4], [2, 6]]);
    expect(p.loop).toEqual({ start: 4, end: 8, on: true });
    expect(p.masterAuto.length).toBeGreaterThan(1);
  });
});
