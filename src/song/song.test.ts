import { describe, expect, it } from "vitest";
import { MidiParseError, parseMidi } from "./midi";
import { BackingSynth } from "./backing";
import { backingNotes, materialNotes, songParts, type SeqNote } from "./parts";
import { SongPlayer, type PlayerTrack, type TrackSound } from "./player";

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

  /** A track sound that records what it was told, and at which output sample; it renders `level` while a note is on. */
  function fakeSound(log: string[], tag = "", level = 0) {
    let rendered = 0;
    let on = 0;
    const sound: TrackSound = {
      noteOn: (note) => {
        on++;
        log.push(`${tag}on ${note} @${rendered}`);
      },
      noteOff: (note) => {
        on = Math.max(0, on - 1);
        log.push(`${tag}off ${note} @${rendered}`);
      },
      allOff: () => {
        on = 0;
        log.push(`${tag}allOff`);
      },
      render: (l, r, frames) => {
        l.fill(on ? level : 0, 0, frames);
        r.fill(on ? level : 0, 0, frames);
        rendered += frames;
      },
      idle: () => on === 0,
    };
    return sound;
  }

  const mix = { gain: 1, pan: 0, mute: false, solo: false, fx: null };
  const track = (id: string, sound: TrackSound, notes: SeqNote[], extra = {}): PlayerTrack => ({ id, sound, notes, ...mix, ...extra });
  const n = (start: number, end: number, note: number): SeqNote => ({ start, end, note, velocity: 1, drum: false });

  function run(player: SongPlayer, fromFrame: number, blocks: number): { l: Float32Array; r: Float32Array } {
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    for (let b = 0; b < blocks; b++) player.render(fromFrame + b * 128, l, r, 128);
    return { l, r };
  }

  it("fires every note on its exact sample, splitting blocks", () => {
    const player = new SongPlayer(SR);
    const log: string[] = [];
    player.setTracks([track("a", fakeSound(log), [n(0.1, 0.2, 60), n(0.2, 0.3, 60)])]);
    player.play(500, 0);
    run(player, 0, 8);
    // Context frame 500 = song 0; output sample = context frame here.
    expect(log.filter((x) => x !== "allOff")).toEqual(["on 60 @600", "off 60 @700", "on 60 @700", "off 60 @800"]);
  });

  it("keeps each track's events on its own sound", () => {
    const player = new SongPlayer(SR);
    const log: string[] = [];
    player.setTracks([track("a", fakeSound(log, "a:"), [n(0.05, 0.1, 60)]), track("b", fakeSound(log, "b:"), [n(0.07, 0.2, 48)])]);
    log.length = 0;
    player.play(0, 0);
    run(player, 0, 2);
    expect(log.filter((x) => x.startsWith("a:"))).toEqual(["a:on 60 @50", "a:off 60 @100"]);
    expect(log.filter((x) => x.startsWith("b:"))).toEqual(["b:on 48 @70", "b:off 48 @200"]);
  });

  it("starts mid-song from the given position, and late starts catch up", () => {
    const player = new SongPlayer(SR);
    const log: string[] = [];
    player.setTracks([track("a", fakeSound(log), [n(0.1, 0.15, 60), n(1.0, 1.1, 62)])]);
    log.length = 0;
    // Asked to start at context frame 0 from song 0.5 s, but the first block rendered is frame 256.
    player.play(0, 0.5);
    run(player, 256, 4);
    // Song 1.0 s = context frame 500 → the sound has rendered 500 − 256 = 244 frames by then.
    expect(log).toEqual(["on 62 @244", "off 62 @344"]);
  });

  it("loops: at the loop's end everything is released and the loop's start plays again, on the exact sample", () => {
    const player = new SongPlayer(SR);
    const log: string[] = [];
    player.setTracks([track("a", fakeSound(log), [n(0.1, 0.15, 60), n(0.3, 0.45, 62)])]);
    log.length = 0;
    player.setLoop({ startSec: 0.1, endSec: 0.4 });
    player.play(0, 0);
    run(player, 0, 8);
    expect(log).toEqual(["on 60 @100", "off 60 @150", "on 62 @300", "allOff", "on 60 @400", "off 60 @450", "on 62 @600", "allOff", "on 60 @700", "off 60 @750", "on 62 @900", "allOff", "on 60 @1000"]);
  });

  it("loops when the loop's end falls exactly on a block's end", () => {
    const player = new SongPlayer(SR);
    const log: string[] = [];
    player.setTracks([track("a", fakeSound(log), [n(0, 0.05, 60)])]);
    log.length = 0;
    player.setLoop({ startSec: 0, endSec: 0.256 }); // 256 frames = two blocks
    player.play(0, 0);
    run(player, 0, 5);
    expect(log).toEqual(["on 60 @0", "off 60 @50", "allOff", "on 60 @256", "off 60 @306", "allOff", "on 60 @512", "off 60 @562"]);
  });

  it("stops everything on stop", () => {
    const player = new SongPlayer(SR);
    const log: string[] = [];
    player.setTracks([track("a", fakeSound(log), [n(0, 5, 60)])]);
    log.length = 0;
    player.play(0, 0);
    run(player, 0, 1);
    player.stop();
    run(player, 128, 2);
    expect(log).toEqual(["on 60 @0", "allOff"]);
    expect(player.playing).toBe(false);
  });

  it("mixes: volume, balance pan, mute and solo", () => {
    const player = new SongPlayer(SR);
    const a = fakeSound([], "", 1);
    const b = fakeSound([], "", 1);
    player.setTracks([track("a", a, [n(0, 1, 60)], { gain: 0.5 }), track("b", b, [n(0, 1, 60)], { pan: -1 })]);
    player.play(0, 0);
    let out = run(player, 0, 1);
    // a: 0.5 both sides; b panned hard left: 1 left, 0 right.
    expect(out.l[10]).toBeCloseTo(1.5);
    expect(out.r[10]).toBeCloseTo(0.5);
    player.setMix("b", { ...mix, pan: -1, mute: true });
    out = run(player, 128, 1);
    expect(out.l[10]).toBeCloseTo(0.5);
    player.setMix("b", { ...mix, solo: true });
    out = run(player, 256, 1);
    expect(out.l[10]).toBeCloseTo(1);
    expect(out.r[10]).toBeCloseTo(1);
  });

  it("makes sound for the backing", () => {
    const player = new SongPlayer(48000);
    const synth = new BackingSynth(48000);
    const sound: TrackSound = {
      noteOn: (note, velocity, drum) => synth.noteOn(note, velocity, drum),
      noteOff: (note, drum) => synth.noteOff(note, drum),
      allOff: () => synth.allOff(),
      render: (l, r, frames) => {
        l.fill(0, 0, frames);
        r.fill(0, 0, frames);
        synth.renderAdd(l, r, frames, 1);
      },
      idle: () => synth.idle(),
    };
    player.setTracks([track("backing", sound, [{ start: 0, end: 0.05, note: 69, velocity: 1, drum: false }, { start: 0, end: 0.05, note: 36, velocity: 1, drum: true }])]);
    player.play(0, 0);
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    let energy = 0;
    for (let b = 0; b < 20; b++) {
      player.render(b * 128, l, r, 128);
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
