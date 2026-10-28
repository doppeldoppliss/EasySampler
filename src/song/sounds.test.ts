import { describe, expect, it } from "vitest";
import { renderSong } from "../daw/songRender";
import { applyLoop } from "../export/loop";
import { DEFAULT_PARAMS, PRESETS } from "../instrument/types";
import { SampleSound } from "./sounds";

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
