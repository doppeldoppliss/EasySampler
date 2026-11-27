import { describe, expect, it } from "vitest";
import { phraseMarks, toSeqNotes } from "./model";
import { PHRASE_END, PHRASE_START } from "../song/parts";

const n = (start: number, length: number, pitch = 60) => ({ id: start * 100 + pitch, start, length, pitch, velocity: 0.8 });

describe("phrases (しゃくり・フォール)", () => {
  it("a rest before starts a phrase, a rest after ends one; notes run together are inside", () => {
    // |♩♩♩♩| rest |♩ ♩|: two phrases.
    const notes = [n(0, 1), n(1, 1), n(2, 1), n(3, 1), n(6, 1), n(7, 1)];
    expect(phraseMarks(notes)).toEqual([PHRASE_START, 0, 0, PHRASE_END, PHRASE_START, PHRASE_END]);
  });

  it("a short gap between detached notes is not a rest; a chord shares its marks", () => {
    // Staccato eighths (a sixteenth apart) are one phrase; a held chord after a beat's rest is its own.
    const stacc = [n(0, 0.375), n(0.5, 0.375), n(1, 0.375)];
    expect(phraseMarks(stacc)).toEqual([PHRASE_START, 0, PHRASE_END]);
    const chord = [n(0, 1, 60), n(2, 2, 60), n(2, 2, 64), n(2, 2, 67)];
    expect(phraseMarks(chord)).toEqual([PHRASE_START | PHRASE_END, PHRASE_START | PHRASE_END, PHRASE_START | PHRASE_END, PHRASE_START | PHRASE_END]);
  });

  it("reaches the player's notes", () => {
    const seq = toSeqNotes([n(0, 1), n(1, 1), n(4, 1)], 120);
    expect(seq.map((s) => s.phrase ?? 0)).toEqual([PHRASE_START, PHRASE_END, PHRASE_START | PHRASE_END]);
  });
});
