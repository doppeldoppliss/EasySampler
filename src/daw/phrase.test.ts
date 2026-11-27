import { describe, expect, it } from "vitest";
import { breathsBefore, DEFAULT_TRACK_BENDS, DEFAULT_TRACK_VIBRATO, noteGains, phraseMarks, sanitizeProject, stepsFrom, toSeqNotes } from "./model";
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

  it("reads its phrases by the track's own rests (数値)", () => {
    // Notes a sixteenth apart: one phrase each at a quarter beat; one phrase at half a beat.
    const notes = [n(0, 0.75), n(1, 0.75), n(2, 0.75)];
    expect(phraseMarks(notes).filter((m) => m & PHRASE_START)).toHaveLength(3);
    expect(phraseMarks(notes, 0.5, 0.5).filter((m) => m & PHRASE_START)).toHaveLength(1);
    expect(phraseMarks(notes, 0.5, 0.25).filter((m) => m & PHRASE_END)).toHaveLength(3);
  });

  it("keeps saved numbers inside their ranges, and gives a save from before them the defaults", () => {
    const p = sanitizeProject({ tracks: [{ name: "a", notes: [], vibrato: { on: true, depthCents: 999, rateHz: 6.2 }, bends: { scoop: 2.5, fall: -3, restBefore: 1 } }] });
    const t = p.tracks[0];
    expect(t.vibrato).toEqual({ ...DEFAULT_TRACK_VIBRATO, on: true, depthCents: 150, rateHz: 6.2 });
    expect(t.bends).toEqual({ ...DEFAULT_TRACK_BENDS, scoop: 2.5, fall: 0, restBefore: 1 });
    const old = sanitizeProject({ tracks: [{ name: "b", notes: [], vibrato: { on: true, minBeats: 2, depthCents: 60 }, bends: { scoop: 1, fall: 2 } }] }).tracks[0];
    expect(old.vibrato.rateHz).toBe(5.5);
    expect(old.bends.restAfter).toBe(0.5);
  });

  it("音程のつなぎ: each note inside a phrase knows its step from the one before (a chord's voices their own)", () => {
    const notes = [n(0, 1, 60), n(1, 1, 62), n(2, 1, 62), n(3, 1, 58), n(6, 1, 65)];
    const marks = phraseMarks(notes);
    // From 60 up to 62: the one before is 2 under (−2); the same 62: none; down to 58: 4 over (+4); after a rest: none.
    expect(stepsFrom(notes, marks)).toEqual([0, -2, 0, 4, 0]);
    const chords = [n(0, 1, 60), n(0, 1, 64), n(1, 1, 62), n(1, 1, 65)];
    expect(stepsFrom(chords, phraseMarks(chords))).toEqual([0, 0, -2, -1]);
    // With portamento they slide already: no steps reach the player.
    expect(toSeqNotes(notes, 120, true).some((s) => s.fromSemis)).toBe(false);
    expect(toSeqNotes(notes, 120).map((s) => s.fromSemis ?? 0)).toEqual([0, -2, 0, 4, 0]);
  });

  it("抑揚: higher in its phrase is louder, a phrase's last note softer; 揺らぎ the same every time, within its bounds", () => {
    const notes = [n(0, 1, 60), n(1, 1, 64), n(2, 1, 67), n(3, 1, 62)];
    const marks = phraseMarks(notes);
    const g = noteGains(notes, marks, { highDb: 4, endDb: 2 });
    // The middle is 63.25: −3.25, +0.75, +3.75 and −1.25 semitones from it, at 4 dB an octave; the last 2 dB less.
    expect(g[0]).toBeCloseTo((4 * -3.25) / 12, 6);
    expect(g[2]).toBeCloseTo((4 * 3.75) / 12, 6);
    expect(g[3]).toBeCloseTo((4 * -1.25) / 12 - 2, 6);
    const a = toSeqNotes(notes, 120, false, { humanMs: 10, humanVel: 0.1 });
    const b = toSeqNotes(notes, 120, false, { humanMs: 10, humanVel: 0.1 });
    expect(a).toEqual(b);
    a.forEach((s, i) => {
      expect(Math.abs(s.start - i * 0.5)).toBeLessThanOrEqual(0.0101);
      expect(Math.abs(s.gainDb ?? 0)).toBeLessThanOrEqual(-20 * Math.log10(0.9) + 1e-9);
    });
    expect(a.some((s, i) => Math.abs(s.start - i * 0.5) > 0.001)).toBe(true);
  });

  it("ブレス: before a phrase after a rest long enough, as long as asked or 80% of the rest", () => {
    // A phrase at 0 (nothing before it: but no time either), one after a beat's rest, one after half a beat's.
    const notes = [n(0, 1), n(2, 1), n(3.5, 1)];
    const marks = phraseMarks(notes, 0.25, 0.25);
    // At 120 a beat is 0.5 s: the second gets 0.25 s; the third (0.25 s of rest) 0.2 s; the first, at 0 s, none.
    expect(breathsBefore(notes, marks, 0.5, 0.25, 120)).toEqual([0, 0.25, 0.2]);
    expect(breathsBefore(notes, marks, 1, 0.25, 120)).toEqual([0, 0.25, 0]);
    expect(toSeqNotes(notes, 120, false, { restBefore: 0.25, restAfter: 0.25, breathRest: 0.5, breathSec: 0.25 }).map((s) => s.breathSec ?? 0)).toEqual([0, 0.25, 0.2]);
  });

  it("reaches the player's notes", () => {
    const seq = toSeqNotes([n(0, 1), n(1, 1), n(4, 1)], 120);
    expect(seq.map((s) => s.phrase ?? 0)).toEqual([PHRASE_START, PHRASE_END, PHRASE_START | PHRASE_END]);
  });
});
