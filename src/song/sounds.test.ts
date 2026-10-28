import { describe, expect, it } from "vitest";
import { renderSong } from "../daw/songRender";
import { applyLoop } from "../export/loop";
import { DEFAULT_PARAMS, PRESETS } from "../instrument/types";
import { ClipSound, SampleSound } from "./sounds";
import { SongPlayer } from "./player";

describe("stops without a click, hi-hats choke in the file, a dying sound is not looped", () => {
  it("a drum hit stopped (loop wrap, stop) fades over a few ms instead of cutting off", () => {
    const s = new SampleSound(44100);
    s.rows = [[new Float32Array(44100).fill(0.5)]];
    s.noteOn(0, 1);
    const l = new Float32Array(128);
    s.render(l, l, 128);
    expect(l[127]).toBeCloseTo(0.5);
    s.allOff();
    s.render(l, l, 128);
    expect(l[0]).toBeGreaterThan(0.45); // no step at the stop
    for (let i = 0; i < 4; i++) s.render(l, l, 128);
    expect(s.idle()).toBe(true);
  });

  it("the song file chokes an open hi-hat when a closed one is struck, as playing does", async () => {
    const SR = 44100;
    const long = new Float32Array(SR).fill(0.3);
    const rows: (Float32Array[] | null)[] = Array.from({ length: 128 }, () => null);
    rows[46] = [long];
    rows[42] = [new Float32Array(10)];
    const song = await renderSong({
      sampleRate: SR,
      bpm: 120,
      masterFx: null,
      tracks: [{ id: "d", instrument: null, samples: rows, drumKeys: [], notes: [{ start: 0, end: 0.1, note: 46, velocity: 1, drum: false }, { start: 0.25, end: 0.3, note: 42, velocity: 1, drum: false }], fx: null, gain: 1, pan: 0, mute: false, solo: false }],
    });
    const at = (t: number) => Math.abs(song.channels[0][Math.round(t * SR)]);
    expect(at(0.2)).toBeGreaterThan(0.1);
    expect(at(0.3)).toBeLessThan(0.01); // cut off by the closed hat
  });

  it("does not loop a 減衰 note (it would jump back up in level every pass)", () => {
    const decay = PRESETS.find((p) => p.id === "decay")!.apply(DEFAULT_PARAMS);
    const rendered = { channels: [new Float32Array(44100 * 3).fill(0.1)], sampleRate: 44100, headSec: 0.1, holdEndSec: 2.8 } as unknown as Parameters<typeof applyLoop>[0];
    expect(applyLoop(rendered, decay)).toBeNull();
    expect(applyLoop(rendered, DEFAULT_PARAMS)).not.toBeNull();
  });
});

describe("audio track clips", () => {
  // A recording that counts its samples: sample i is i / 10000.
  const ramp = new Float32Array(10000).map((_, i) => i / 10000);

  it("plays a clip's recording from its offset, as recorded", async () => {
    const song = await renderSong({
      sampleRate: 1000,
      bpm: 120,
      masterFx: null,
      tracks: [{ id: "a", instrument: null, clips: [{ channels: [ramp], offsetSec: 2 }], notes: [{ start: 1, end: 3, note: 0, velocity: 1, drum: false }], fx: null, gain: 1, pan: 0, mute: false, solo: false }],
    });
    const out = song.channels[0];
    // Silent before 1 s; at 1.5 s, 0.5 s into the clip = 2.5 s into the recording (past the start fade).
    expect(Math.abs(out[500])).toBeLessThan(1e-6);
    expect(out[1500]).toBeCloseTo(2500 / 10000, 3);
    // Stopped at the note's end.
    expect(Math.abs(out[3100] ?? 0)).toBeLessThan(1e-6);
  });

  it("starts part-way when playback starts inside a clip", () => {
    const player = new SongPlayer(1000);
    const sound = new ClipSound(1000, () => [ramp]);
    sound.clips = [{ material: "m", offsetSec: 0 }];
    player.setTracks([{ id: "a", sound, notes: [{ start: 0, end: 5, note: 0, velocity: 1, drum: false }], fx: null, gain: 1, pan: 0, mute: false, solo: false }]);
    player.play(0, 2);
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    player.render(0, l, r, 128);
    // 2 s into the song = 2 s into the clip (after its short fade-in).
    expect(l[100]).toBeCloseTo(2100 / 10000, 3);
  });
});
