import { describe, expect, it } from "vitest";
import { parseMidi } from "../song/midi";
import { arrange } from "./arrange";
import { writeMidi } from "./midiWrite";
import { beatsToSec, emptyProject, secToBeats, setTempoList, tempoAt, tempoMapSec } from "./model";

describe("tempo map", () => {
  const song = { bpm: 120, tempos: [{ beat: 8, bpm: 60 }] };

  it("turns beats into seconds through each tempo, and back", () => {
    // 8 beats at 120 = 4 s, then 60 BPM: 1 s a beat.
    expect(beatsToSec(8, song)).toBeCloseTo(4);
    expect(beatsToSec(10, song)).toBeCloseTo(6);
    expect(beatsToSec(4, song)).toBeCloseTo(2);
    for (const beat of [0, 3.5, 8, 9.25, 40]) expect(secToBeats(beatsToSec(beat, song), song)).toBeCloseTo(beat);
    expect(tempoAt(7.9, song)).toBe(120);
    expect(tempoAt(8, song)).toBe(60);
    expect(tempoMapSec(song)).toEqual([{ sec: 0, bpm: 120 }, { sec: 4, bpm: 60 }]);
    // A plain number is a fixed tempo.
    expect(beatsToSec(4, 120)).toBe(2);
  });

  it("tidies a list: sorted, one per beat, no repeats of the tempo before", () => {
    const p = emptyProject();
    setTempoList(p, [{ beat: 8, bpm: 140 }, { beat: 0, bpm: 100 }, { beat: 4, bpm: 100 }, { beat: 12, bpm: 140 }, { beat: 16, bpm: 90 }, { beat: 16, bpm: 95 }]);
    expect(p.bpm).toBe(100);
    expect(p.tempos).toEqual([{ beat: 8, bpm: 140 }, { beat: 16, bpm: 95 }]);
  });

  it("moves with the bars: a duplicated stretch keeps its tempos, and what follows keeps its own", () => {
    const p = emptyProject();
    setTempoList(p, [{ beat: 0, bpm: 120 }, { beat: 2, bpm: 90 }, { beat: 4, bpm: 150 }]);
    arrange(p, "duplicate", 0, 4);
    expect(p.tempos).toEqual([{ beat: 2, bpm: 90 }, { beat: 4, bpm: 120 }, { beat: 6, bpm: 90 }, { beat: 8, bpm: 150 }]);
    arrange(p, "delete", 0, 4);
    expect(p.bpm).toBe(120);
    expect(p.tempos).toEqual([{ beat: 2, bpm: 90 }, { beat: 4, bpm: 150 }]);
  });

  it("goes into a MIDI file and comes back from it", () => {
    const p = emptyProject();
    p.tracks[0].notes = [{ id: 1, start: 0, length: 1, pitch: 60, velocity: 0.8 }, { id: 2, start: 12, length: 1, pitch: 62, velocity: 0.8 }];
    setTempoList(p, [{ beat: 0, bpm: 120 }, { beat: 8, bpm: 60 }]);
    const back = parseMidi(writeMidi(p));
    expect(back.bpm).toBeCloseTo(120);
    expect(back.tempos.map((c) => [c.beat, Math.round(c.bpm)])).toEqual([[8, 60]]);
    // The second note: 4 s + 4 beats at 60 = 8 s.
    expect(back.tracks[0].notes[1].start).toBeCloseTo(8, 2);
  });
});
