import { describe, expect, it } from "vitest";
import { analyzeMaterial, prepareSource } from "../engine/prepare";
import { DEFAULT_FX, DEFAULT_PARAMS } from "../instrument/types";
import { parseMidi } from "../song/midi";
import { demoSyllable } from "../testsignals/synthVoice";
import { DRUM_KEYS, writeMidi } from "./midiWrite";
import { BACKING, emptyProject, newDrumTrack, newTrack, type Note } from "./model";
import { renderSong } from "./songRender";

const SR = 44100;
const n = (start: number, length: number, pitch: number, velocity = 0.8): Note => ({ id: 0, start, length, pitch, velocity });

describe("writeMidi", () => {
  it("writes the tempo, a track per song track, and drum rows on channel 10 as GM keys; it reads back the same", () => {
    const p = emptyProject();
    p.bpm = 150;
    p.tracks = [{ ...newTrack("メロ", "m/c"), notes: [n(0, 1, 60), n(1.5, 0.5, 64, 1)] }, { ...newDrumTrack("ドラム", "m/k"), notes: [n(0, 0.25, 0), n(1, 0.25, 1)] }];
    const song = parseMidi(writeMidi(p));
    expect(song.bpm).toBeCloseTo(150, 3);
    expect(song.tracks.map((t) => t.name)).toEqual(["メロ", "ドラム"]);
    expect(song.tracks[0].notes.map((x) => [x.startBeat, x.endBeat, x.pitch, x.velocity])).toEqual([
      [0, 1, 60, 102],
      [1.5, 2, 64, 127],
    ]);
    expect(song.tracks[1].notes.map((x) => [x.startBeat, x.pitch, x.channel])).toEqual([
      [0, DRUM_KEYS[0], 9],
      [1, DRUM_KEYS[1], 9],
    ]);
  });
});

describe("writeMidi, rows on the plain drum sound", () => {
  it("writes a row's own GM key (what a MIDI file's drum part brought in)", () => {
    const p = emptyProject();
    const d = newDrumTrack("ドラム");
    d.pads = [{ instrument: BACKING, key: 36 }, { instrument: BACKING, key: 42 }];
    d.notes = [n(0, 0.25, 0), n(0.5, 0.25, 1)];
    p.tracks = [d];
    const song = parseMidi(writeMidi(p));
    expect(song.tracks[0].notes.map((x) => x.pitch)).toEqual([36, 42]);
  });
});

describe("renderSong", () => {
  const material = demoSyllable(SR);
  const analysis = analyzeMaterial([material], SR);
  const source = prepareSource([material], analysis, SR);
  const instrument = { source, markers: analysis.markers, params: { ...DEFAULT_PARAMS, root: analysis.root!.midi }, hold: 1 };
  const plain = { fx: null, gain: 1, pan: 0, mute: false, solo: false };
  const rms = (x: Float32Array, a: number, b: number) => {
    let s = 0;
    for (let i = a; i < b; i++) s += x[i] * x[i];
    return Math.sqrt(s / Math.max(1, b - a));
  };

  it("plays every track's notes where they are, and runs on until the sound has died away", async () => {
    const click = new Float32Array(Math.round(0.05 * SR)).fill(0.3);
    const song = await renderSong({
      sampleRate: SR,
      bpm: 120,
      masterFx: null,
      tracks: [
        { id: "a", instrument, notes: [{ start: 0, end: 0.5, note: 62, velocity: 1, drum: false }], ...plain },
        { id: "d", instrument: null, samples: [[click]], notes: [{ start: 1, end: 1.1, note: 0, velocity: 1, drum: false }], ...plain },
      ],
    });
    const [l] = song.channels;
    expect(rms(l, Math.round(0.1 * SR), Math.round(0.4 * SR))).toBeGreaterThan(0.01);
    // The drum hit at 1 s: the click, nothing else is sounding by then.
    expect(rms(l, Math.round(1.005 * SR), Math.round(1.045 * SR))).toBeGreaterThan(0.2);
    expect(l.length / SR).toBeGreaterThan(1.04);
    expect(l.length / SR).toBeLessThan(2);
  });

  it("leaves out a muted track, and brings a mix over full scale down as a whole", async () => {
    const loud = new Float32Array(SR / 10).fill(0.8);
    const tracks = [
      { id: "x", instrument: null, samples: [[loud]], notes: [{ start: 0, end: 0.1, note: 0, velocity: 1, drum: false }], ...plain },
      { id: "y", instrument: null, samples: [[loud]], notes: [{ start: 0, end: 0.1, note: 0, velocity: 1, drum: false }], ...plain },
    ];
    const both = await renderSong({ sampleRate: SR, bpm: 120, masterFx: null, tracks });
    expect(both.gain).toBeCloseTo(0.98 / 1.6, 3);
    expect(Math.max(...both.channels[0])).toBeLessThanOrEqual(0.981);
    const one = await renderSong({ sampleRate: SR, bpm: 120, masterFx: null, tracks: [tracks[0], { ...tracks[1], mute: true }] });
    expect(one.gain).toBe(1);
    expect(Math.max(...one.channels[0])).toBeCloseTo(0.8, 3);
  });

  it("plays a part on the plain backing synth, and drum rows on its drum sound", async () => {
    const song = await renderSong({
      sampleRate: SR,
      bpm: 120,
      masterFx: null,
      tracks: [
        { id: "b", instrument: null, backing: true, notes: [{ start: 0, end: 0.5, note: 60, velocity: 1, drum: false }], ...plain },
        { id: "d", instrument: null, samples: [null], drumKeys: [38], notes: [{ start: 1, end: 1.1, note: 0, velocity: 1, drum: false }], ...plain },
      ],
    });
    const [l] = song.channels;
    expect(rms(l, Math.round(0.05 * SR), Math.round(0.4 * SR))).toBeGreaterThan(0.005);
    expect(rms(l, Math.round(1.0 * SR), Math.round(1.1 * SR))).toBeGreaterThan(0.005);
  });

  it("puts the master effects on the mix (a limiter keeps it under its ceiling)", async () => {
    const loud = new Float32Array(SR / 5).fill(0.9);
    const masterFx = structuredClone(DEFAULT_FX);
    masterFx.limiter.on = true;
    masterFx.limiter.gainDb = 0;
    masterFx.limiter.ceilingDb = -6;
    const song = await renderSong({ sampleRate: SR, bpm: 120, masterFx, tracks: [{ id: "x", instrument: null, samples: [[loud]], notes: [{ start: 0, end: 0.2, note: 0, velocity: 1, drum: false }], ...plain }] });
    const peak = Math.max(...song.channels[0].map(Math.abs));
    expect(peak).toBeLessThan(0.55);
  });
});
