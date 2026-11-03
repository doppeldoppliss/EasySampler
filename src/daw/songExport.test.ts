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

  it("writes the time signature and the markers", () => {
    const p = emptyProject();
    p.timeSig = { num: 6, den: 8 };
    p.beatsPerBar = 3;
    p.markers = [{ beat: 6, name: "サビ" }];
    p.tracks = [{ ...newTrack("メロ", "m/c"), notes: [n(0, 1, 60)] }];
    const bytes = writeMidi(p);
    expect(parseMidi(bytes).timeSig).toEqual({ num: 6, den: 8 });
    // The marker's meta event (FF 06) with its name.
    const name = [...new TextEncoder().encode("サビ")];
    const at = bytes.findIndex((b, i) => b === 0xff && bytes[i + 1] === 0x06 && bytes[i + 2] === name.length);
    expect(at).toBeGreaterThan(0);
    expect([...bytes.slice(at + 3, at + 3 + name.length)]).toEqual(name);
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

  it("sidechain: a track ducks under another (its key), even with the key muted", async () => {
    const pad = Float32Array.from({ length: SR }, () => 0.3);
    const hit = new Float32Array(SR / 10).fill(0.8);
    const ducked = { ...structuredClone(DEFAULT_FX), duck: { ...DEFAULT_FX.duck, on: true, source: "kick", depthDb: -12, releaseMs: 50, thresholdDb: -24 } };
    const tracks = [
      { id: "kick", instrument: null, samples: [[hit]], notes: [{ start: 0.5, end: 0.6, note: 0, velocity: 1, drum: false }], ...plain, mute: true },
      { id: "pad", instrument: null, samples: [[pad]], notes: [{ start: 0, end: 1, note: 0, velocity: 1, drum: false }], ...plain, fx: ducked },
    ];
    const song = await renderSong({ sampleRate: SR, bpm: 120, masterFx: null, tracks });
    const at = (sec: number) => Math.abs(song.channels[0][Math.round(sec * SR)]);
    // Before the kick: the pad as it is; during it: about 12 dB down; well after it: back.
    expect(at(0.3)).toBeCloseTo(0.3, 2);
    expect(20 * Math.log10(at(0.55) / 0.3)).toBeLessThan(-10);
    expect(at(0.9)).toBeCloseTo(0.3, 2);
  });

  it("a loop range exported keeps the song's beats: a gate opens where it does in the song", async () => {
    // A pad through a gate open on the first beat of each 4-beat pattern only (sixteenths 0–3); the loop is beats 2–6.
    const pad = Float32Array.from({ length: SR * 4 }, () => 0.3);
    const gate = { ...structuredClone(DEFAULT_FX), gate: { ...DEFAULT_FX.gate, on: true, smoothMs: 2, steps: Array.from({ length: 16 }, (_, i) => i < 4) } };
    const tracks = [{ id: "pad", instrument: null, samples: [[pad]], notes: [{ start: 0, end: 4, note: 0, velocity: 1, drum: false }], ...plain, fx: gate }];
    // (At 120 BPM a beat is 0.5 s: the loop is 1–3 s of the song, rendered twice from 0 and the second pass kept.)
    const song = await renderSong({ sampleRate: SR, bpm: 120, masterFx: null, tracks, window: { fromSec: 2, lengthSec: 2 }, beatOffset: 2 - 4 });
    const level = (from: number, to: number) => Math.max(...Array.from(song.channels[0].subarray(Math.round(from * SR), Math.round(to * SR))).map(Math.abs));
    // Song beats 2–4 are closed; beat 4 (1 s into the loop) opens.
    expect(level(0.05, 0.9)).toBeLessThan(0.01);
    expect(level(1.05, 1.4)).toBeGreaterThan(0.25);
  });

  it("sidechains in a chain work in any track order (A ducks to B, B to C)", async () => {
    const pad = Float32Array.from({ length: SR }, () => 0.3);
    const duckTo = (source: string) => ({ ...structuredClone(DEFAULT_FX), duck: { ...DEFAULT_FX.duck, on: true, source, depthDb: -12, releaseMs: 50, thresholdDb: -24 } });
    const tracks = [
      { id: "A", instrument: null, samples: [[pad]], notes: [{ start: 0, end: 1, note: 0, velocity: 1, drum: false }], ...plain, fx: duckTo("B") },
      { id: "B", instrument: null, samples: [[pad]], notes: [{ start: 0, end: 1, note: 0, velocity: 1, drum: false }], ...plain, mute: true, fx: duckTo("C") },
      { id: "C", instrument: null, samples: [[pad]], notes: [], ...plain, mute: true },
    ];
    const song = await renderSong({ sampleRate: SR, bpm: 120, masterFx: null, tracks });
    // Only A is heard; B (loud, its own key C silent) holds A down.
    expect(20 * Math.log10(Math.abs(song.channels[0][Math.round(0.5 * SR)]) / 0.3)).toBeLessThan(-10);
  });

  it("書き出す音量: brings the song to the target loudness under -1 dBTP, quiet or loud", async () => {
    const tone = (amp: number) => Float32Array.from({ length: SR * 3 }, (_, i) => amp * Math.sin((2 * Math.PI * 440 * i) / SR));
    for (const amp of [0.05, 0.9]) {
      const tracks = [{ id: "x", instrument: null, samples: [[tone(amp)]], notes: [{ start: 0, end: 3, note: 0, velocity: 1, drum: false }], ...plain }];
      const song = await renderSong({ sampleRate: SR, bpm: 120, masterFx: null, tracks, loudness: { targetLufs: -14, ceilingDb: -1 } });
      expect(song.matched!.afterLufs).toBeGreaterThan(-14.6);
      expect(song.matched!.afterLufs).toBeLessThan(-13.4);
      expect(song.matched!.truePeakDb).toBeLessThanOrEqual(-0.95);
    }
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
