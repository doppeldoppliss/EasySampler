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
    const { sec, headSec } = soundingSec({ sustainEnabled: false, tail: { enabled: false, limit: "unlimited" } }, 1.5);
    expect(sec).toBeLessThan(headSec + 0.05);
    expect(sec).toBeGreaterThan(headSec * 0.8);
  });

  it("off, tail on: the head goes straight on to the tail", () => {
    const { sec, headSec, tailSec } = soundingSec({ sustainEnabled: false, tail: { enabled: true, limit: "unlimited" } }, 1.5);
    expect(sec).toBeGreaterThan(headSec + tailSec * 0.5);
    expect(sec).toBeLessThan(headSec + tailSec + 0.1);
  });
});

describe("sustain off: letting go early", () => {
  it("doesn't cut the head short (it plays out like a one-shot)", () => {
    const material = demoSyllable(SR);
    const { engine, analysis } = setup(material, { sustainEnabled: false, tail: { enabled: false, limit: "unlimited" } });
    const out = play(engine, 62, 0.05, 1);
    let last = 0;
    for (let i = 0; i < out.length; i++) if (Math.abs(out[i]) > 1e-4) last = i;
    const headSec = analysis.markers.sustainStart - analysis.markers.rangeStart;
    expect(last / SR).toBeGreaterThan(headSec * 0.8);
  });
});

describe("フェード (fade in / fade out)", () => {
  function envelope(out: Float32Array, windowSec: number): (atSec: number) => number {
    const w = Math.round(windowSec * SR);
    return (atSec) => {
      const from = Math.round(atSec * SR);
      return rms(out, from, Math.min(out.length, from + w));
    };
  }

  it("fades out over the last stretch of a head-only playout", () => {
    const material = demoSyllable(SR);
    const base = { sustainEnabled: false, tail: { enabled: false, limit: "unlimited" as const } };
    const plain = play(setup(material, { ...base }).engine, 62, 1, 1);
    const faded = play(setup(material, { ...base, amp: { ...DEFAULT_PARAMS.amp, fadeOut: 0.15 } }).engine, 62, 1, 1);
    // The head is about 0.245 s; the fade covers its last 0.15 s.
    const p = envelope(plain, 0.03);
    const f = envelope(faded, 0.03);
    expect(f(0.05)).toBeCloseTo(p(0.05), 2); // before the fade: untouched
    expect(f(0.2)).toBeLessThan(p(0.2) * 0.6); // inside it: quieter
    expect(f(0.23)).toBeLessThan(p(0.23) * 0.3); // nearly out
  });

  it("makes the release at least as long as the fade when the note is let go without a tail", () => {
    const material = demoSyllable(SR);
    const base = { tail: { enabled: false, limit: "unlimited" as const } };
    const short = play(setup(material, { ...base }).engine, 62, 0.5, 1);
    const long = play(setup(material, { ...base, amp: { ...DEFAULT_PARAMS.amp, fadeOut: 0.3 } }).engine, 62, 0.5, 1);
    const s = envelope(short, 0.03);
    const l = envelope(long, 0.03);
    expect(s(0.6)).toBeLessThan(1e-3); // the 20 ms release is long over
    expect(l(0.6)).toBeGreaterThan(s(0.6) + 0.01); // still fading
    expect(l(0.85)).toBeLessThan(1e-3); // and gone by 0.3 s after
  });

  it("fades in over the attack", () => {
    const material = demoSyllable(SR);
    const out = play(setup(material, { amp: { ...DEFAULT_PARAMS.amp, attack: 0.3 } }).engine, 62, 1, 0.2);
    const e = envelope(out, 0.03);
    expect(e(0.02)).toBeLessThan(e(0.4) * 0.3);
    expect(e(0.15)).toBeLessThan(e(0.4));
  });
});

describe("unvoicedFollow (音程なしの部分も移調に合わせる)", () => {
  /** The demo syllable with its hiss replaced by noise peaked near 5 kHz (a consonant has a colour, white noise has none). */
  function peakedMaterial(): Float32Array {
    const material = demoSyllable(SR);
    const hissEnd = Math.round(0.09 * SR);
    // A two-pole resonator at 5 kHz driven by noise (seeded, so the test is stable).
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    const r = 0.97;
    const w = (2 * Math.PI * 5000) / SR;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < hissEnd; i++) {
      const y = rnd() * 0.3 + 2 * r * Math.cos(w) * y1 - r * r * y2;
      y2 = y1;
      y1 = y;
      material[i] = y * 0.1 * Math.min(1, i / 200);
    }
    return material;
  }

  /** Spectral centroid (Hz) of the first `sec` seconds, by a plain DFT on a few hundred bins. */
  function centroid(out: Float32Array, sec: number): number {
    const n = Math.min(out.length, Math.round(sec * SR));
    const bins = 256;
    let num = 0;
    let den = 0;
    for (let b = 1; b < bins; b++) {
      const hz = (b / bins) * (SR / 2);
      let re = 0;
      let im = 0;
      for (let i = 0; i < n; i++) {
        const ph = (2 * Math.PI * hz * i) / SR;
        re += out[i] * Math.cos(ph);
        im -= out[i] * Math.sin(ph);
      }
      const p = re * re + im * im;
      num += hz * p;
      den += p;
    }
    return den > 0 ? num / den : 0;
  }

  it("leaves a consonant's colour alone by default, and moves it with the note when on", () => {
    const material = peakedMaterial();
    const base = { sustainEnabled: false, tail: { enabled: false, limit: "unlimited" as const } };
    const { analysis } = setup(material, base);
    const root = Math.round(analysis.root!.midi);
    const run = (follow: boolean, shift: number) => centroid(play(setup(material, { ...base, unvoicedFollow: follow }).engine, root + shift, 0.3, 0.1), 0.07);
    const offLow = run(false, -12);
    const offHigh = run(false, 12);
    const onLow = run(true, -12);
    const onHigh = run(true, 12);
    // Off: the same colour whatever the note.
    expect(Math.abs(offHigh - offLow) / offLow).toBeLessThan(0.1);
    // On: an octave apart in the note is clearly apart in colour (not necessarily a full octave: windows and aliasing blur it).
    expect(onHigh).toBeGreaterThan(onLow * 1.4);
    expect(onHigh).toBeGreaterThan(offHigh * 1.15);
    expect(onLow).toBeLessThan(offLow * 0.85);
  });
});

describe("sustain mode \"stretch\"", () => {
  it("fills the note it was told about, then carries on from the pool while the key is still held", () => {
    const material = demoSyllable(SR);
    const { engine } = setup(material, { sustainMode: "stretch" });
    engine.setHold(1);
    const out = play(engine, 62, 2.5, 0.2);
    const level = (sec: number) => rms(out, Math.round(sec * SR), Math.round((sec + 0.05) * SR));
    // Sounding through the slowed pass (0.245 s head + ~0.75 s of stretched sustain) …
    expect(level(0.5)).toBeGreaterThan(0.02);
    expect(level(0.9)).toBeGreaterThan(0.02);
    // … and still sounding well past it, from the pool.
    expect(level(2.0)).toBeGreaterThan(0.02);
    expect(level(2.4)).toBeGreaterThan(0.02);
  });

  it("reads the sustain at the stretch's pace: early in the hold it is early in the region, late it is late", () => {
    // A ramp over the sustain (level rising from 20 % to 100 %), with the markers pinned to the unramped
    // analysis (the ramp would otherwise move them), so where the read is shows in the output level.
    const material = demoSyllable(SR);
    const m = analyzeMaterial([material], SR).markers;
    for (let i = 0; i < material.length; i++) {
      const t = i / SR;
      if (t >= m.sustainStart && t < m.sustainEnd) material[i] *= 0.2 + 0.8 * ((t - m.sustainStart) / (m.sustainEnd - m.sustainStart));
    }
    const analysis = analyzeMaterial([material], SR);
    const engine = new Engine(SR);
    engine.setSource(prepareSource([material], analysis, SR));
    const root = analysis.root?.midi ?? 62;
    // (levelEven off: the level is the probe of the read position here.)
    engine.setInstrument(m, { ...DEFAULT_PARAMS, root, sustainMode: "stretch", levelEven: 0, amp: { ...DEFAULT_PARAMS.amp, velocitySens: 0 } });
    engine.setHold(2);
    const out = play(engine, Math.round(root), 2, 0.1);
    const level = (sec: number) => rms(out, Math.round(sec * SR), Math.round((sec + 0.1) * SR));
    expect(level(0.4)).toBeLessThan(level(1.6) * 0.6);
  });
});

describe("音階に合わせる (tune mode \"scale\")", () => {
  it("lands the note on the scale's nearest note instead of the root", () => {
    const material = demoSyllable(SR); // D4 −6¢
    const { analysis } = setup(material);
    const root = analysis.root!.midi;
    const played = Math.round(root);
    // E major: the material's D4 −6¢ (61.94) sits nearest C#4 (61).
    const out = play(setup(material, { tune: { ...DEFAULT_PARAMS.tune, mode: "scale", scale: "major", key: 4 } }).engine, played, 1.2, 0.1);
    const pitch = rootPitch(analyzePitch(out.slice(Math.round(0.3 * SR), Math.round(1.1 * SR)), SR))!;
    expect(Math.abs(pitch.midi - 61)).toBeLessThan(0.2);
    // Chromatic: on the nearest semitone, D4.
    const chroma = play(setup(material, { tune: { ...DEFAULT_PARAMS.tune, mode: "scale", scale: "chromatic", key: 0 } }).engine, played, 1.2, 0.1);
    const p2 = rootPitch(analyzePitch(chroma.slice(Math.round(0.3 * SR), Math.round(1.1 * SR)), SR))!;
    expect(Math.abs(p2.midi - 62)).toBeLessThan(0.2);
  });

  it("vibrato: a release fades it, a phase moves it; tremolo shakes the level", () => {
    const material = demoSyllable(SR);
    const base = { wobble: { ...DEFAULT_PARAMS.wobble, vibratoCents: 80, vibratoHz: 6, vibratoDelaySec: 0, vibratoAttackSec: 0.01 } };
    const kept = play(setup(material, base).engine, 62, 0.5, 0.6);
    const released = play(setup(material, { wobble: { ...base.wobble, vibratoReleaseSec: 0.1 } }).engine, 62, 0.5, 0.6);
    // After the release (plus the 0.1 s fade) the released one is steady while the kept one still wobbles.
    const spread = (out: Float32Array, from: number, to: number) => rootPitch(analyzePitch(out.slice(Math.round(from * SR), Math.round(to * SR)), SR))?.spread ?? 0;
    expect(spread(released, 0.7, 1.0)).toBeLessThan(spread(kept, 0.7, 1.0) * 0.5);
    const trem = play(setup(material, { wobble: { ...DEFAULT_PARAMS.wobble, vibratoHz: 4, vibratoDelaySec: 0, tremoloDepth: 0.9 } }).engine, 62, 1, 0.1);
    const plain = play(setup(material).engine, 62, 1, 0.1);
    const ripple = (out: Float32Array) => {
      const win = Math.round(0.02 * SR);
      const levels: number[] = [];
      for (let at = Math.round(0.3 * SR); at + win < Math.round(0.9 * SR); at += win) levels.push(rms(out, at, at + win));
      return Math.max(...levels) / Math.max(1e-6, Math.min(...levels));
    };
    expect(ripple(trem)).toBeGreaterThan(ripple(plain) * 2);
  });
});

describe("levelEven (持続部の音量を揃える)", () => {
  it("steadies the sustain of a decaying vowel, and leaves it alone at 0", () => {
    const material = demoSyllable(SR);
    const m = analyzeMaterial([material], SR).markers;
    for (let i = 0; i < material.length; i++) {
      const t = i / SR;
      if (t >= m.sustainStart) material[i] *= Math.max(0.1, 1 - (t - m.sustainStart) / (m.sustainEnd - m.sustainStart));
    }
    const unevenness = (levelEven: number) => {
      const engine = new Engine(SR);
      const analysis = analyzeMaterial([material], SR);
      engine.setSource(prepareSource([material], analysis, SR));
      engine.setInstrument(m, { ...DEFAULT_PARAMS, root: analysis.root?.midi ?? 62, levelEven, amp: { ...DEFAULT_PARAMS.amp, velocitySens: 0 } });
      const out = play(engine, 62, 1.5, 0.1);
      const win = Math.round(0.02 * SR);
      const levels: number[] = [];
      for (let at = Math.round(0.4 * SR); at + win < Math.round(1.4 * SR); at += win) levels.push(rms(out, at, at + win));
      const mean = levels.reduce((s, v) => s + v, 0) / levels.length;
      return Math.sqrt(levels.reduce((s, v) => s + (v - mean) ** 2, 0) / levels.length) / mean;
    };
    const raw = unevenness(0);
    const even = unevenness(1);
    expect(even).toBeLessThan(raw * 0.6);
    expect(even).toBeLessThan(0.15);
  });
});

describe("Melodyne-style controls", () => {
  function vibratoMaterial(): Float32Array {
    return synthVoice({ sampleRate: SR, durationSec: 1.2, pitch: (t) => 62 + 0.4 * Math.sin(2 * Math.PI * 5.5 * t) + 0.3 * Math.sin(2 * Math.PI * 0.4 * t) });
  }
  const measure = (out: Float32Array, from: number, to: number) => rootPitch(analyzePitch(out.slice(Math.round(from * SR), Math.round(to * SR)), SR))!;

  it("keepModulation 0 removes the vibrato while keepDrift keeps the slow wander (flatten 0)", () => {
    const material = vibratoMaterial();
    const both = measure(play(setup(material, { flatten: 0, sustainMode: "none" }).engine, 62, 1, 0.1), 0.2, 1.0);
    const noMod = measure(play(setup(material, { flatten: 0, sustainMode: "none", wobble: { ...DEFAULT_PARAMS.wobble, keepModulation: 0 } }).engine, 62, 1, 0.1), 0.2, 1.0);
    expect(noMod.spread).toBeLessThan(both.spread * 0.5);
  });

  it("retuneSec makes the correction glide in instead of snapping", () => {
    // A step from D4 to F4 half way; flattened to D4 with and without a 0.2 s retune.
    const material = synthVoice({ sampleRate: SR, durationSec: 1, pitch: (t) => (t < 0.5 ? 62 : 65) });
    const analysis = analyzeMaterial([material], SR);
    const run = (retuneSec: number) => {
      const engine = new Engine(SR);
      engine.setSource(prepareSource([material], analysis, SR));
      engine.setInstrument({ ...analysis.markers, rangeStart: 0, rangeEnd: 1, attack: 0.05, sustainStart: 0.1, sustainEnd: 0.9, tailStart: 0.9 }, { ...DEFAULT_PARAMS, root: 62, flatten: 1, sustainMode: "none", tune: { ...DEFAULT_PARAMS.tune, retuneSec } });
      return play(engine, 62, 1, 0.1);
    };
    const snap = measure(run(0), 0.55, 0.65).midi;
    const glide = measure(run(0.2), 0.55, 0.65).midi;
    expect(Math.abs(snap - 62)).toBeLessThan(0.3);
    expect(glide - 62).toBeGreaterThan(0.8); // still on its way down from F4
    expect(measure(run(0.2), 0.9, 1.0).midi - 62).toBeLessThan(0.4); // and arrived by the end
  });

  it("unvoicedGainDb −60 silences the hiss; formantFollow is a continuous amount", () => {
    const material = demoSyllable(SR);
    const base = { sustainEnabled: false, tail: { enabled: false, limit: "unlimited" as const } };
    const loud = play(setup(material, base).engine, 62, 0.3, 0.1);
    const muted = play(setup(material, { ...base, unvoicedGainDb: -60 }).engine, 62, 0.3, 0.1);
    expect(rms(muted, 0, Math.round(0.06 * SR))).toBeLessThan(rms(loud, 0, Math.round(0.06 * SR)) * 0.05);
    // Spectral centroid of the sustain (a plain DFT), played 19 semitones up: the formants follow by 0 / 4.8 / 9.6 semitones.
    const centroidOf = (out: Float32Array) => {
      const from = Math.round(0.3 * SR);
      const n = Math.min(out.length - from, Math.round(0.4 * SR));
      let num = 0;
      let den = 0;
      // (Stride 2 keeps the DFT honest up to 11 kHz; the bins stop at 5 kHz.)
      for (let b = 1; b < 100; b++) {
        const hz = b * 50;
        let re = 0;
        let im = 0;
        for (let i = 0; i < n; i += 2) {
          const ph = (2 * Math.PI * hz * i) / SR;
          re += out[from + i] * Math.cos(ph);
          im -= out[from + i] * Math.sin(ph);
        }
        const p = re * re + im * im;
        num += hz * p;
        den += p;
      }
      return num / den;
    };
    const keep = centroidOf(play(setup(material, { formantFollow: 0 }).engine, 62 + 19, 1, 0.1));
    const half = centroidOf(play(setup(material, { formantFollow: 0.5 }).engine, 62 + 19, 1, 0.1));
    const full = centroidOf(play(setup(material, { formantFollow: 1 }).engine, 62 + 19, 1, 0.1));
    expect(half).toBeGreaterThan(keep * 1.05);
    expect(full).toBeGreaterThan(half * 1.05);
  });
});
