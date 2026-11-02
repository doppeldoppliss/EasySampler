import { describe, expect, it } from "vitest";
import { analyzeMaterial, prepareSource } from "../engine/prepare";
import { DEFAULT_FX, DEFAULT_PARAMS } from "../instrument/types";
import { parseMidi } from "../song/midi";
import { demoSyllable } from "../testsignals/synthVoice";
import { writeMidi } from "./midiWrite";
import { emptyProject, newDrumTrack, newTrack, type Note } from "./model";
import { evenStems, renderSong } from "./songRender";
import { FxChain } from "../fx/chain";

const SR = 44100;
const n = (start: number, length: number, pitch: number, velocity = 0.8): Note => ({ id: 0, start, length, pitch, velocity });

describe("writeMidi", () => {
  it("writes the tempo, a track per song track, and drum notes on channel 10 on their GM keys; it reads back the same", () => {
    const p = emptyProject();
    p.bpm = 150;
    p.tracks = [{ ...newTrack("メロ", "m/c"), notes: [n(0, 1, 60), n(1.5, 0.5, 64, 1)] }, { ...newDrumTrack("ドラム"), notes: [n(0, 0.25, 36), n(1, 0.25, 42)] }];
    const song = parseMidi(writeMidi(p));
    expect(song.bpm).toBeCloseTo(150, 3);
    expect(song.tracks.map((t) => t.name)).toEqual(["メロ", "ドラム"]);
    expect(song.tracks[0].notes.map((x) => [x.startBeat, x.endBeat, x.pitch, x.velocity])).toEqual([
      [0, 1, 60, 102],
      [1.5, 2, 64, 127],
    ]);
    expect(song.tracks[1].notes.map((x) => [x.startBeat, x.pitch, x.channel])).toEqual([
      [0, 36, 9],
      [1, 42, 9],
    ]);
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

describe("renderSong: a window (the loop range, seamless)", () => {
  it("is exactly the window, and what rang past the loop's end is heard at its start", async () => {
    const SR = 44100;
    const ring = new Float32Array(Math.round(0.3 * SR)).fill(0.4); // longer than the loop
    const plain = { fx: null, gain: 1, pan: 0, mute: false, solo: false };
    // A hit at 0.1 s of a 0.2 s loop, given twice (as the page does); the second pass is kept.
    const notes = [0.1, 0.3].map((start) => ({ start, end: start + 0.01, note: 0, velocity: 1, drum: false }));
    const song = await renderSong({ sampleRate: SR, bpm: 120, masterFx: null, window: { fromSec: 0.2, lengthSec: 0.2 }, tracks: [{ id: "d", instrument: null, samples: [[ring]], notes, ...plain }] });
    expect(song.channels[0].length).toBe(Math.round(0.2 * SR));
    // At the window's start the first hit (from 0.1 s, 0.3 s long) still rings.
    expect(Math.abs(song.channels[0][10])).toBeGreaterThan(0.3);
  });
});

describe("stems", () => {
  it("come out at one gain and one length, so they add up to the mix", async () => {
    const loud = new Float32Array(SR / 10).fill(0.8);
    const plain = { fx: null, gain: 1, pan: 0, mute: false, solo: false };
    const a = await renderSong({ sampleRate: SR, bpm: 120, masterFx: null, raw: true, tracks: [{ id: "x", instrument: null, samples: [[loud]], notes: [{ start: 0, end: 0.1, note: 0, velocity: 1, drum: false }], ...plain }] });
    const b = await renderSong({ sampleRate: SR, bpm: 120, masterFx: null, raw: true, tracks: [{ id: "y", instrument: null, samples: [[loud.map((v) => v * 2)]], notes: [{ start: 0.5, end: 0.6, note: 0, velocity: 1, drum: false }], ...plain }] });
    const even = evenStems([a.channels, b.channels]);
    expect(even.stems[0][0].length).toBe(even.stems[1][0].length);
    // The louder one (1.6) sets the gain for both: their levels keep their ratio.
    expect(even.gain).toBeCloseTo(0.98 / 1.6, 3);
    expect(Math.max(...even.stems[0][0]) / Math.max(...even.stems[1][0])).toBeCloseTo(0.5, 3);
  });
});

describe("tempo changes and the master effects", () => {
  it("the player tells the master its new tempo", async () => {
    const seen: number[] = [];
    const original = FxChain.prototype.setTempo;
    FxChain.prototype.setTempo = function (bpm: number) {
      seen.push(bpm);
      return original.call(this, bpm);
    };
    try {
      const click = new Float32Array(100).fill(0.3);
      await renderSong({ sampleRate: SR, bpm: 120, masterFx: DEFAULT_FX, tempoMap: [{ sec: 0, bpm: 120 }, { sec: 0.5, bpm: 90 }], tracks: [{ id: "d", instrument: null, samples: [[click]], notes: [{ start: 0, end: 0.1, note: 0, velocity: 1, drum: false }, { start: 1, end: 1.1, note: 0, velocity: 1, drum: false }], fx: null, gain: 1, pan: 0, mute: false, solo: false }] });
    } finally {
      FxChain.prototype.setTempo = original;
    }
    expect(seen.filter((b) => b === 90).length).toBeGreaterThanOrEqual(2); // the track's chain and the master's
  });
});
