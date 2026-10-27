import { describe, expect, it } from "vitest";
import { analyzePitch } from "../analysis/pyin";
import { rootPitch } from "../analysis/rootPitch";
import { analyzeMaterial, prepareSource } from "../engine/prepare";
import { Engine } from "../engine/engine";
import { renderNote } from "../export/render";
import { DEFAULT_PARAMS, PRESETS } from "../instrument/types";
import { synthPiano } from "./piano";

const SR = 44100;

describe("the built-in piano", () => {
  const piano = synthPiano({ sampleRate: SR });
  const analysis = analyzeMaterial([piano], SR);
  const source = prepareSource([piano], analysis, SR);
  const params = PRESETS.find((p) => p.id === "decay")!.apply({ ...DEFAULT_PARAMS, root: analysis.root!.midi });

  it("is heard as C4, and its analysed range keeps most of the ring", () => {
    expect(Math.abs(analysis.root!.midi - 60)).toBeLessThan(0.3);
    expect(analysis.markers.rangeEnd - analysis.markers.rangeStart).toBeGreaterThan(1.5);
    // The pitch holds all the way (the two strings of the unison must never cancel the fundamental).
    const f0 = analysis.track.f0.slice(Math.round(0.05 / analysis.track.hopSec), Math.round(2.7 / analysis.track.hopSec));
    expect(f0.every((v) => Number.isFinite(v) && Math.abs(v - 60) < 0.5)).toBe(true);
  });

  /** Played as in a song: held for holdSec, then let go; how long until it is silent. */
  function soundingSec(note: number, holdSec: number): number {
    const engine = new Engine(SR);
    engine.setSource(source);
    engine.setInstrument(analysis.markers, params);
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    engine.noteOn(note, 1);
    let at = 0;
    for (; at < 5 * SR && engine.activeVoices() > 0; at += 128) {
      if (at >= holdSec * SR && at < holdSec * SR + 128) engine.noteOff(note);
      engine.render(l, r);
    }
    return at / SR;
  }

  it("plays other notes at their pitch with the decay preset", () => {
    for (const note of [48, 67, 72]) {
      const rendered = renderNote(source, analysis.markers, params, note, 0.4);
      const got = rootPitch(analyzePitch(rendered.channels[0].slice(0, SR), SR))!.midi;
      expect(Math.abs(got - note)).toBeLessThan(0.3);
    }
  });

  it("stops soon after the key is let go (a damper), and rings on while held", () => {
    expect(soundingSec(60, 0.4)).toBeLessThan(0.7);
    expect(soundingSec(60, 4)).toBeGreaterThan(2.5);
  });
});
