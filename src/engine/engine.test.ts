import { describe, expect, it } from "vitest";
import { analyzePitch } from "../analysis/pyin";
import { rootPitch } from "../analysis/rootPitch";
import { DEFAULT_PARAMS, type InstrumentParams } from "../instrument/types";
import { demoPhrasePitch, demoSyllable, synthVoice } from "../testsignals/synthVoice";
import { Engine } from "./engine";
import { analyzeMaterial, prepareSource, resample } from "./prepare";

const SR = 44100;

function setup(material: Float32Array, overrides: Partial<InstrumentParams> = {}, rate = SR) {
  const analysis = analyzeMaterial([material], SR);
  const engine = new Engine(rate);
  engine.setSource(prepareSource([material], analysis, rate));
  const params: InstrumentParams = { ...DEFAULT_PARAMS, root: analysis.root?.midi ?? 60, ...overrides };
  engine.setInstrument(analysis.markers, params);
  return { engine, analysis, params };
}

/** Plays a note for `holdSec`, then releases it and renders `afterSec` more. Mono (left channel). */
function play(engine: Engine, note: number, holdSec: number, afterSec = 0.2, velocity = 1): Float32Array {
  const rate = engine.sampleRate;
  const total = Math.ceil((holdSec + afterSec) * rate);
  const out = new Float32Array(total);
  const l = new Float32Array(128);
  const r = new Float32Array(128);
  engine.noteOn(note, velocity);
  let released = false;
  for (let at = 0; at < total; at += 128) {
    if (!released && at >= holdSec * rate) {
      engine.noteOff(note);
      released = true;
    }
    engine.render(l, r);
    out.set(l.subarray(0, Math.min(128, total - at)), at);
  }
  return out;
}

function rms(x: Float32Array, from = 0, to = x.length): number {
  let acc = 0;
  for (let i = from; i < to; i++) acc += x[i] * x[i];
  return Math.sqrt(acc / Math.max(1, to - from));
}

describe("Engine (PSOLA material synth)", () => {
  const vowel = synthVoice({ sampleRate: SR, durationSec: 0.8, pitch: demoPhrasePitch(57, 0.8) });

  it("plays the material at its own pitch on the root note, and shifted on others", () => {
    const { engine, params } = setup(vowel);
    for (const shift of [0, 5, -7, 12]) {
      const out = play(engine, Math.round(params.root) + shift, 1.0);
      const got = rootPitch(analyzePitch(out, SR))!;
      expect(Math.abs(got.midi - (Math.round(params.root) + shift))).toBeLessThan(0.25);
    }
  });

  it("holds the note far beyond the material's length, at a steady level", () => {
    const { engine } = setup(vowel);
    const out = play(engine, 60, 3.0); // the material is 0.8 s
    const early = rms(out, 0.6 * SR, 1.0 * SR);
    const late = rms(out, 2.4 * SR, 2.9 * SR);
    expect(late).toBeGreaterThan(early * 0.6);
    expect(late).toBeLessThan(early * 1.6);
    const tail = rootPitch(analyzePitch(out.slice(2 * SR, 2.9 * SR), SR))!;
    expect(Math.abs(tail.midi - 60)).toBeLessThan(0.25);
  });

  it("keeps the inflection at flatten 0 and flattens it at 1", () => {
    const original = rootPitch(analyzePitch(vowel, SR))!;
    const kept = rootPitch(analyzePitch(play(setup(vowel, { flatten: 0, sustainMode: "none" }).engine, 62, 0.8), SR))!;
    const flat = rootPitch(analyzePitch(play(setup(vowel, { flatten: 1, sustainMode: "none", wobble: { ...DEFAULT_PARAMS.wobble, micro: false } }).engine, 62, 0.8), SR))!;
    expect(Math.abs(kept.spread - original.spread)).toBeLessThan(0.1);
    expect(flat.spread).toBeLessThan(original.spread / 3);
  });

  it("protects the head: the consonant plays once, unstretched, before the vowel", () => {
    const syllable = demoSyllable(SR); // 0.09 s hiss, then the vowel
    const { engine } = setup(syllable);
    const out = play(engine, 66, 1.0);
    // The hiss comes first and keeps its length.
    const hiss = rms(out, 0, Math.round(0.07 * SR));
    expect(hiss).toBeGreaterThan(0.01);
    const voicedStart = analyzePitch(out, SR).f0.findIndex((v) => Number.isFinite(v)) * 0.005;
    expect(voicedStart).toBeGreaterThan(0.06);
    expect(voicedStart).toBeLessThan(0.14);
  });

  it("fades out on release when the tail is off, and plays the tail when it is on", () => {
    const syllable = demoSyllable(SR);
    const off = play(setup(syllable, { tail: { enabled: false, limit: "unlimited" } }).engine, 62, 0.5, 0.5);
    expect(rms(off, Math.round(0.56 * SR), Math.round(0.9 * SR))).toBeLessThan(1e-4);
    const on = play(setup(syllable, { tail: { enabled: true, limit: "unlimited" } }).engine, 62, 0.5, 0.5);
    expect(rms(on, Math.round(0.56 * SR), Math.round(0.65 * SR))).toBeGreaterThan(0.01);
  });

  it("resample mode raises the pitch and shortens the sound together", () => {
    const { engine, params } = setup(vowel, { pitchMode: "resample", sustainMode: "none" });
    const out = play(engine, Math.round(params.root) + 12, 1.0, 0.3);
    const got = rootPitch(analyzePitch(out, SR))!;
    expect(Math.abs(got.midi - (Math.round(params.root) + 12))).toBeLessThan(0.3);
    // An octave up plays twice as fast: 0.8 s of material lasts about 0.4 s.
    expect(rms(out, Math.round(0.5 * SR), Math.round(0.7 * SR))).toBeLessThan(1e-3);
  });

  it("plays chords and respects the polyphony limit", () => {
    const { engine } = setup(vowel, { maxVoices: 3 });
    for (const note of [60, 64, 67, 71, 74]) engine.noteOn(note, 0.8);
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    for (let i = 0; i < 400; i++) engine.render(l, r);
    expect(engine.activeVoices()).toBeLessThanOrEqual(3);
    expect(l.every((v) => Number.isFinite(v))).toBe(true);
    expect(rms(l)).toBeGreaterThan(0.01);
  });

  it("works when the engine runs at another rate than the material", () => {
    const { engine, params } = setup(vowel, {}, 48000);
    const out = play(engine, Math.round(params.root) + 3, 1.0);
    const got = rootPitch(analyzePitch(out, 48000))!;
    expect(Math.abs(got.midi - (Math.round(params.root) + 3))).toBeLessThan(0.25);
  });

  it("keeps the loudness roughly constant across shifts", () => {
    const levels = [-7, 0, 7].map((shift) => {
      const { engine, params } = setup(vowel);
      return rms(play(engine, Math.round(params.root) + shift, 1.0), 0.2 * SR, 0.9 * SR);
    });
    for (const level of levels) {
      expect(level / levels[1]).toBeGreaterThan(0.6);
      expect(level / levels[1]).toBeLessThan(1.6);
    }
  });
});

describe("resample", () => {
  it("changes the length by the ratio and keeps a tone's pitch", () => {
    const x = synthVoice({ sampleRate: SR, durationSec: 0.4, pitch: () => 57 });
    const y = resample(x, 48000 / SR);
    expect(Math.abs(y.length - x.length * (48000 / SR))).toBeLessThan(2);
    expect(Math.abs(rootPitch(analyzePitch(y, 48000))!.midi - 57)).toBeLessThan(0.05);
  });
});

describe("tail length limit", () => {
  /** Renders a held note, releases it, and returns how many samples sound after the release. */
  function afterRelease(limit: "unlimited" | "beat" | "bar", bpm: number): number {
    const material = demoSyllable(SR);
    const { engine } = setup(material, { tail: { enabled: true, limit } });
    engine.setTempo(bpm);
    const out = play(engine, 60, 0.6, 4);
    const releaseAt = Math.round(0.6 * SR);
    let last = releaseAt;
    for (let i = releaseAt; i < out.length; i++) if (Math.abs(out[i]) > 1e-4) last = i;
    return (last - releaseAt) / SR;
  }

  it("cuts the tail at one beat / one bar of the tempo, and leaves it alone when unlimited", () => {
    const unlimited = afterRelease("unlimited", 600);
    // At 600 BPM a beat is 0.1 s, a bar 0.4 s; the cut fades over 30 ms.
    const beat = afterRelease("beat", 600);
    expect(beat).toBeLessThan(0.1 + 0.05);
    expect(beat).toBeGreaterThan(0.05);
    expect(afterRelease("bar", 600)).toBeLessThanOrEqual(Math.min(unlimited, 0.4 + 0.05));
    expect(unlimited).toBeGreaterThan(beat);
  });
});

describe("sustain on / off", () => {
  /** Seconds until the last audible sample of a note held `holdSec`. */
  function soundingSec(overrides: Partial<InstrumentParams>, holdSec: number): { sec: number; headSec: number; tailSec: number } {
    const material = demoSyllable(SR);
    const { engine, analysis } = setup(material, overrides);
    const out = play(engine, 62, holdSec, 2);
    let last = 0;
    for (let i = 0; i < out.length; i++) if (Math.abs(out[i]) > 1e-4) last = i;
    const m = analysis.markers;
    return { sec: last / SR, headSec: m.sustainStart - m.rangeStart, tailSec: m.rangeEnd - Math.max(m.tailStart, m.sustainStart) };
  }

  it("on (the default): the note lasts as long as it is held", () => {
    expect(soundingSec({}, 1.5).sec).toBeGreaterThan(1.45);
  });

  it("off, tail off: only the head plays, however long the key is held", () => {
    const { sec, headSec } = soundingSec({ sustainEnabled: false }, 1.5);
    expect(sec).toBeLessThan(headSec + 0.05);
    expect(sec).toBeGreaterThan(headSec * 0.8);
  });

  it("off, tail on: the head goes straight on to the tail", () => {
    const { sec, headSec, tailSec } = soundingSec({ sustainEnabled: false, tail: { enabled: true, limit: "unlimited" } }, 1.5);
    expect(sec).toBeGreaterThan(headSec + tailSec * 0.5);
    expect(sec).toBeLessThan(headSec + tailSec + 0.1);
  });
});
