import { describe, expect, it } from "vitest";
import type { Engine } from "../engine/engine";
import { MidiParseError, parseMidi } from "./midi";
import { backingNotes, materialNotes, songParts } from "./parts";
import { SongPlayer } from "./player";

// ------------------------------------------------------------ a tiny SMF writer

function vlq(n: number): number[] {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
}

type Ev = [delta: number, ...bytes: number[]];

function track(events: Ev[]): number[] {
  const body = events.flatMap(([delta, ...bytes]) => [...vlq(delta), ...bytes]).concat([0, 0xff, 0x2f, 0]);
  const n = body.length;
  return [0x4d, 0x54, 0x72, 0x6b, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255, ...body];
}

function smf(ppq: number, tracks: Ev[][]): Uint8Array {
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.length, ppq >> 8, ppq & 255];
  return Uint8Array.from([...header, ...tracks.flatMap(track)]);
}

const name = (text: string): number[] => [0xff, 0x03, text.length, ...[...text].map((c) => c.charCodeAt(0))];
const tempo = (bpm: number): number[] => {
  const us = Math.round(60e6 / bpm);
  return [0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255];
};

const PPQ = 96;

/** Conductor at 120 BPM, then 60 BPM from beat 4; a melody of C4 D4 (overlapping C4s); a drum track. */
function demoSong(): Uint8Array {
  return smf(PPQ, [
    [[0, ...tempo(120)], [PPQ * 4, ...tempo(60)]],
    [
      [0, ...name("Lead")],
      [0, 0xc0, 80],
      [0, 0x90, 60, 100], // C4 at 0 s
      [PPQ, 0x90, 60, 90], // a second C4 at 0.5 s, before the first ends
      [PPQ, 0x80, 60, 0], // first C4 off at 1.0 s
      [0, 0x80, 60, 0], // second off at 1.0 s
      [PPQ * 2, 0x90, 62, 127], // D4 at beat 4 = 2.0 s (tempo changes here)
      [PPQ, 0x80, 62, 0], // one beat at 60 BPM → 3.0 s
    ],
    [
      [0, ...name("Drums")],
      [0, 0x99, 36, 100],
      [PPQ / 2, 0x89, 36, 0],
      [PPQ / 2, 0x99, 38, 100],
      [PPQ / 2, 0x99, 42, 0], // velocity 0 = note-off with nothing open: ignored
      [0, 0x89, 38, 0],
    ],
    [
      [0, ...name("Lead copy")],
      [0, 0x90, 60, 100],
      [PPQ, 0x90, 60, 90],
      [PPQ, 0x80, 60, 0],
      [0, 0x80, 60, 0],
      [PPQ * 2, 0x90, 62, 127],
      [PPQ, 0x80, 62, 0],
    ],
  ]);
}

describe("parseMidi", () => {
  it("applies the tempo map and reads names and programs", () => {
    const song = parseMidi(demoSong());
    expect(song.tracks.map((t) => t.name)).toEqual(["Lead", "Drums", "Lead copy"]);
    expect(song.bpm).toBeCloseTo(120);
    expect(song.hasTempoChanges).toBe(true);
    const lead = song.tracks[0];
    expect(lead.program).toBe(80);
    expect(lead.notes.map((n) => [n.pitch, n.start, n.end])).toEqual([
      [60, 0, 1],
      [60, 0.5, 1],
      [62, 2, 3],
    ]);
    expect(song.durationSec).toBeCloseTo(3);
  });

  it("puts the bars where the beats fall, across the tempo change", () => {
    const song = parseMidi(demoSong());
    // Bar 1 = beats 0–4 at 120 BPM (2 s); bar 2 starts at 2 s and runs 4 beats at 60 BPM.
    expect(song.bars[0]).toBe(0);
    expect(song.bars[1]).toBeCloseTo(2);
    expect(song.bars[2]).toBeCloseTo(6);
    expect(song.bars.length).toBe(3);
  });

  it("refuses what isn't a MIDI file", () => {
    expect(() => parseMidi(new TextEncoder().encode("RIFF....WAVEfmt "))).toThrow(MidiParseError);
    expect(() => parseMidi(smf(PPQ, [[[0, 0x90, 60, 100]]]).subarray(0, 25))).toThrow(MidiParseError);
  });
});

describe("songParts", () => {
  it("offers each track, a drum track per sound too, and spots doubled tracks", () => {
    const parts = songParts(parseMidi(demoSong()));
    expect(parts.map((p) => p.id)).toEqual(["t1", "t2d", "t2d36", "t2d38", "t3"]);
    expect(parts.find((p) => p.id === "t3")!.duplicateOf).toBe("t1");
    expect(parts.find((p) => p.id === "t2d38")!.label).toContain("スネア");
  });

  it("leaves the material's own part and the doubles out of the backing", () => {
    const parts = songParts(parseMidi(demoSong()));
    const lead = parts.find((p) => p.id === "t1")!;
    const backing = backingNotes(parts, lead);
    expect(backing.every((n) => n.drum)).toBe(true);
    expect(backing.length).toBe(2);
    // A single drum sound as the material: the rest of the kit (and the lead) still play.
    const kick = parts.find((p) => p.id === "t2d36")!;
    const withKick = backingNotes(parts, kick);
    expect(withKick.filter((n) => n.drum).map((n) => n.note)).toEqual([38]);
    expect(withKick.filter((n) => !n.drum).length).toBe(3);
  });
});

describe("materialNotes", () => {
  it("cuts a same-pitch note short where the next one starts, and transposes", () => {
    const lead = songParts(parseMidi(demoSong()))[0];
    const notes = materialNotes(lead, 12, null);
    expect(notes.map((n) => n.note)).toEqual([72, 72, 74]);
    expect(notes[0].end).toBeLessThan(0.5);
    expect(notes[1].end).toBe(1);
  });

  it("plays a drum part on one fixed note", () => {
    const kit = songParts(parseMidi(demoSong())).find((p) => p.id === "t2d")!;
    expect(materialNotes(kit, 5, 64).map((n) => n.note)).toEqual([64, 64]);
  });
});

describe("SongPlayer", () => {
  const SR = 1000;

  /** Records what the engine was told, and at which output sample. */
  function fakeEngine() {
    const log: string[] = [];
    let rendered = 0;
    const engine = {
      noteOn: (note: number) => log.push(`on ${note} @${rendered}`),
      noteOff: (note: number) => log.push(`off ${note} @${rendered}`),
      allOff: () => log.push("allOff"),
      render: (l: Float32Array, r: Float32Array, frames: number) => {
        l.fill(0, 0, frames);
        r.fill(0, 0, frames);
        rendered += frames;
      },
    };
    return { engine: engine as unknown as Engine, log };
  }

  function run(player: SongPlayer, engine: Engine, fromFrame: number, blocks: number): void {
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    for (let b = 0; b < blocks; b++) player.render(fromFrame + b * 128, l, r, 128, engine);
  }

  it("fires every note on its exact sample, splitting blocks", () => {
    const player = new SongPlayer(SR);
    const { engine, log } = fakeEngine();
    player.load(
      [
        { start: 0.1, end: 0.2, note: 60, velocity: 1, drum: false },
        { start: 0.2, end: 0.3, note: 60, velocity: 1, drum: false },
      ],
      [],
    );
    player.play(500, 0);
    run(player, engine, 0, 8);
    // Context frame 500 = song 0; output sample = context frame here.
    expect(log).toEqual(["on 60 @600", "off 60 @700", "on 60 @700", "off 60 @800"]);
  });

  it("starts mid-song from the given position, and late starts catch up", () => {
    const player = new SongPlayer(SR);
    const { engine, log } = fakeEngine();
    player.load(
      [
        { start: 0.1, end: 0.15, note: 60, velocity: 1, drum: false },
        { start: 1.0, end: 1.1, note: 62, velocity: 1, drum: false },
      ],
      [],
    );
    // Asked to start at context frame 0 from song 0.5 s, but the first block rendered is frame 256.
    player.play(0, 0.5);
    run(player, engine, 256, 4);
    // Song 1.0 s = context frame 500 → output sample 500 − 256 = 244.
    expect(log).toEqual(["on 62 @244", "off 62 @344"]);
  });

  it("stops everything on stop", () => {
    const player = new SongPlayer(SR);
    const { engine, log } = fakeEngine();
    player.load([{ start: 0, end: 5, note: 60, velocity: 1, drum: false }], []);
    player.play(0, 0);
    run(player, engine, 0, 1);
    player.stop(engine);
    run(player, engine, 128, 2);
    expect(log).toEqual(["on 60 @0", "allOff"]);
    expect(player.playing).toBe(false);
  });

  it("makes sound for the backing", () => {
    const player = new SongPlayer(48000);
    const { engine } = fakeEngine();
    player.load([], [
      { start: 0, end: 0.05, note: 69, velocity: 1, drum: false },
      { start: 0, end: 0.05, note: 36, velocity: 1, drum: true },
    ]);
    player.play(0, 0);
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    let energy = 0;
    for (let b = 0; b < 20; b++) {
      player.render(b * 128, l, r, 128, engine);
      for (const v of l) energy += v * v;
    }
    expect(energy).toBeGreaterThan(0.01);
  });
});

describe("echo layers", () => {
  it("recognises a copy shifted in time and keeps it out of the backing only when its source is the material", () => {
    const song = parseMidi(
      smf(PPQ, [
        [[0, ...name("Lead")], [0, 0x90, 60, 100], [PPQ, 0x80, 60, 0], [0, 0x90, 64, 100], [PPQ, 0x80, 64, 0]],
        [[0, ...name("Echo")], [PPQ / 3, 0x90, 60, 60], [PPQ, 0x80, 60, 0], [0, 0x90, 64, 60], [PPQ, 0x80, 64, 0]],
        [[0, ...name("Bass")], [0, 0x90, 36, 100], [PPQ * 2, 0x80, 36, 0]],
      ]),
    );
    const parts = songParts(song);
    const echo = parts.find((p) => p.id === "t1")!;
    expect(echo.duplicateOf).toBe("t0");
    expect(echo.shiftSec).toBeCloseTo(1 / 6, 3);
    expect(echo.label).toContain("ずらした重ね");
    const lead = parts.find((p) => p.id === "t0")!;
    const bass = parts.find((p) => p.id === "t2")!;
    expect(backingNotes(parts, lead).map((n) => n.note)).toEqual([36]);
    expect(backingNotes(parts, bass).length).toBe(4);
  });
});
