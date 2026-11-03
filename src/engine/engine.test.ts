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

  it("fades out on release (over the release)", () => {
    const syllable = demoSyllable(SR);
    const off = play(setup(syllable).engine, 62, 0.5, 0.5);
    expect(rms(off, Math.round(0.56 * SR), Math.round(0.9 * SR))).toBeLessThan(1e-4);
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

describe("sustain on / off", () => {
  /** Seconds until the last audible sample of a note held `holdSec`. */
  function soundingSec(overrides: Partial<InstrumentParams>, holdSec: number): { sec: number; headSec: number } {
    const material = demoSyllable(SR);
    const { engine, analysis } = setup(material, overrides);
    const out = play(engine, 62, holdSec, 2);
    let last = 0;
    for (let i = 0; i < out.length; i++) if (Math.abs(out[i]) > 1e-4) last = i;
    const m = analysis.markers;
    return { sec: last / SR, headSec: m.sustainStart - m.rangeStart };
  }

  it("on (the default): the note lasts as long as it is held", () => {
    expect(soundingSec({}, 1.5).sec).toBeGreaterThan(1.45);
  });

  it("off (頭部だけ): only the head plays, however long the key is held", () => {
    const { sec, headSec } = soundingSec({ sustainEnabled: false }, 1.5);
    expect(sec).toBeLessThan(headSec + 0.05);
    expect(sec).toBeGreaterThan(headSec * 0.8);
  });

});

describe("引き延ばし: the note's own length", () => {
  it("a song's note paces the slowed pass to its own length, not the hold length", () => {
    const material = demoSyllable(SR);
    /** Seconds until the stretched pass reaches the sustain's end, from where the voice gets quieter-free pool: measured as the output length of a note let go at its own end. */
    const lastSound = (lengthSec: number | undefined) => {
      const { engine } = setup(material, { sustainMode: "stretch" });
      engine.setHold(0.5);
      const out = new Float32Array(Math.round(3 * SR));
      const l = new Float32Array(128);
      const r = new Float32Array(128);
      engine.noteOn(62, 1, lengthSec);
      const offAt = Math.round((lengthSec ?? 0.5) * SR);
      let off = false;
      for (let at = 0; at < out.length; at += 128) {
        if (!off && at >= offAt) (engine.noteOff(62), (off = true));
        engine.render(l, r, 128);
        out.set(l.subarray(0, Math.min(128, out.length - at)), at);
      }
      return out;
    };
    // The speed differs: the same moment of output reads a different place in the material.
    const short = lastSound(undefined);
    const long = lastSound(2);
    let diff = 0;
    const from = Math.round(0.35 * SR);
    for (let i = from; i < from + Math.round(0.1 * SR); i++) diff += Math.abs(short[i] - long[i]);
    expect(diff).toBeGreaterThan(1);
  });
});

describe("sustain off: letting go early", () => {
  it("doesn't cut the head short (it plays out like a one-shot)", () => {
    const material = demoSyllable(SR);
    const { engine, analysis } = setup(material, { sustainEnabled: false });
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
    const base = { sustainEnabled: false };
    const plain = play(setup(material, { ...base }).engine, 62, 1, 1);
    const faded = play(setup(material, { ...base, amp: { ...DEFAULT_PARAMS.amp, fadeOut: 0.15 } }).engine, 62, 1, 1);
    // The head is about 0.245 s; the fade covers its last 0.15 s.
    const p = envelope(plain, 0.03);
    const f = envelope(faded, 0.03);
    expect(f(0.05)).toBeCloseTo(p(0.05), 2); // before the fade: untouched
    expect(f(0.2)).toBeLessThan(p(0.2) * 0.6); // inside it: quieter
    expect(f(0.23)).toBeLessThan(p(0.23) * 0.3); // nearly out
  });

  it("makes the release at least as long as the fade when the note is let go", () => {
    const material = demoSyllable(SR);
    const base = {};
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
    const base = { sustainEnabled: false };
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

describe("vibrato and tremolo", () => {
  it("vibrato: a release fades it, a phase moves it; tremolo shakes the level", () => {
    const material = demoSyllable(SR);
    // (A long release keeps the note sounding after the key is let go: that is where the vibrato's release shows.)
    const base = { wobble: { ...DEFAULT_PARAMS.wobble, vibratoCents: 80, vibratoHz: 6, vibratoDelaySec: 0, vibratoAttackSec: 0.01 }, amp: { ...DEFAULT_PARAMS.amp, release: 1.5 } };
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
    const base = { sustainEnabled: false };
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
    const keep = centroidOf(play(setup(material, { formantFollow: 0, sustainOnlySynth: false }).engine, 62 + 19, 1, 0.1));
    const half = centroidOf(play(setup(material, { formantFollow: 0.5, sustainOnlySynth: false }).engine, 62 + 19, 1, 0.1));
    const full = centroidOf(play(setup(material, { formantFollow: 1, sustainOnlySynth: false }).engine, 62 + 19, 1, 0.1));
    expect(half).toBeGreaterThan(keep * 1.05);
    expect(full).toBeGreaterThan(half * 1.05);
  });
});

describe("Engine portamento (a song track's glide)", () => {
  const vowel = synthVoice({ sampleRate: SR, durationSec: 0.8, pitch: demoPhrasePitch(57, 0.8) });

  /** 60 for 0.6 s, then 67 starting while 60 is still held (as a legato pair is played), then 67 for 0.9 s. */
  function legatoPair(engine: Engine): { out: Float32Array; voicesAfter: number } {
    const out = new Float32Array(Math.ceil(1.5 * SR));
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    engine.noteOn(60, 1);
    let voicesAfter = -1;
    for (let at = 0; at < out.length; at += 128) {
      if (voicesAfter < 0 && at >= 0.6 * SR) {
        engine.noteOn(67, 1);
        engine.noteOff(60);
        voicesAfter = engine.activeVoices();
      }
      engine.render(l, r);
      out.set(l.subarray(0, Math.min(128, out.length - at)), at);
    }
    return { out, voicesAfter };
  }
  const pitchOf = (x: Float32Array, a: number, b: number) => rootPitch(analyzePitch(x.slice(Math.round(a * SR), Math.round(b * SR)), SR))!.midi;

  it("carries a holding cut's voice on to the next note and slides to it", () => {
    const { engine } = setup(vowel);
    engine.setGlide(0.3);
    const { out, voicesAfter } = legatoPair(engine);
    expect(voicesAfter).toBe(1); // no second attack: the same voice goes on
    const mid = pitchOf(out, 0.68, 0.78);
    expect(mid).toBeGreaterThan(61);
    expect(mid).toBeLessThan(66);
    expect(Math.abs(pitchOf(out, 1.0, 1.45) - 67)).toBeLessThan(0.3);
  });

  it("without a glide time, the next note is a voice of its own at its pitch at once", () => {
    const { engine } = setup(vowel);
    const { out, voicesAfter } = legatoPair(engine);
    expect(voicesAfter).toBe(2);
    expect(Math.abs(pitchOf(out, 1.0, 1.45) - 67)).toBeLessThan(0.3);
  });

  it("a cut that plays through once starts again, sliding from the last note's pitch", () => {
    const { engine } = setup(vowel, { sustainMode: "none" });
    engine.setGlide(0.3);
    const { out } = legatoPair(engine);
    const mid = pitchOf(out, 0.66, 0.76);
    expect(mid).toBeGreaterThan(61);
    expect(mid).toBeLessThan(66);
    expect(Math.abs(pitchOf(out, 1.0, 1.3) - 67)).toBeLessThan(0.3);
  });
});

describe("Engine: resampling presets leave the pitch shaping unused", () => {
  it("sounds the same whatever 平坦化 / リチューン say", async () => {
    const { PRESETS } = await import("../instrument/types");
    const vowel = synthVoice({ sampleRate: SR, durationSec: 0.6, pitch: demoPhrasePitch(57, 0.6) });
    const render = (over: Partial<InstrumentParams>) => {
      const { engine, analysis } = setup(vowel);
      const base: InstrumentParams = { ...PRESETS.find((p) => p.id === "short")!.apply({ ...DEFAULT_PARAMS, root: analysis.root!.midi }), pitchMode: "resample" };
      engine.setInstrument(analysis.markers, { ...base, ...over });
      return play(engine, 62, 0.3, 0.5);
    };
    const plain = render({});
    const shaped = render({ flatten: 1, tune: { retuneSec: 0.05 }, unvoicedGainDb: -20 });
    expect(shaped.length).toBe(plain.length);
    let diff = 0;
    for (let i = 0; i < plain.length; i++) diff = Math.max(diff, Math.abs(plain[i] - shaped[i]));
    expect(diff).toBeLessThan(1e-6);
  });
});

describe("Engine: 減衰 (synthesized, dying away while held)", () => {
  it("draws the vowel out while its level falls to nothing; it ends on its own, and stops soon when let go", async () => {
    const { PRESETS } = await import("../instrument/types");
    const vowel = synthVoice({ sampleRate: SR, durationSec: 0.8, pitch: demoPhrasePitch(57, 0.8) });
    const make = () => {
      const { engine, analysis } = setup(vowel);
      engine.setInstrument(analysis.markers, PRESETS.find((p) => p.id === "decay")!.apply({ ...DEFAULT_PARAMS, root: analysis.root!.midi }));
      return engine;
    };
    const dbAt = (x: Float32Array, t: number) => 20 * Math.log10(rms(x, Math.round(t * SR), Math.round((t + 0.1) * SR)) + 1e-12);
    // Held: ピアノ風 is gone (-60 dB) in 3 s, so 0.5 s → 2 s is about 30 dB down (and past the 0.8 s material: drawn out).
    const held = play(make(), 60, 6, 0.2);
    const drop = dbAt(held, 0.5) - dbAt(held, 2.0);
    expect(drop).toBeGreaterThan(25);
    expect(drop).toBeLessThan(35);
    expect(dbAt(held, 2.5)).toBeGreaterThan(-80);
    // Held on and on: over by itself (below -80 dB, about 4 s), not a silent voice kept.
    const engine = make();
    engine.noteOn(60, 1);
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    let at = 0;
    for (; at < 16 * SR && engine.activeVoices() > 0; at += 128) engine.render(l, r);
    expect(at / SR).toBeGreaterThan(3.5);
    expect(at / SR).toBeLessThan(5);
    // Let go after 0.5 s: gone a quarter second later.
    const short = play(make(), 60, 0.5, 1);
    expect(dbAt(short, 0.85)).toBeLessThan(-90);
  });
});

describe("離したら止める (stopOnRelease)", () => {
  it("a one-shot let go early plays out by default, and stops there (over the release) with the option", () => {
    const vowel = synthVoice({ sampleRate: SR, durationSec: 1.2, pitch: () => 57 });
    const base = { sustainMode: "none" as const, amp: { ...DEFAULT_PARAMS.amp, release: 0.02 } };
    const out = (stop: boolean) => play(setup(vowel, { ...base, stopOnRelease: stop }).engine, 57, 0.15, 0.8);
    const window = (x: Float32Array) => rms(x, Math.round(0.4 * SR), Math.round(0.6 * SR));
    expect(window(out(false))).toBeGreaterThan(0.01);
    expect(window(out(true))).toBeLessThan(1e-4);
    // The sustain switched off: the same.
    const off = play(setup(vowel, { sustainEnabled: false, stopOnRelease: true, amp: base.amp }).engine, 57, 0.15, 0.8);
    expect(window(off)).toBeLessThan(1e-4);
  });
});

describe("移調 (transposeOnly)", () => {
  it("moves the pitch as a whole: 平坦化 and 細かい揺れ set or not, the same sound as flatten 0", () => {
    const voice = synthVoice({ sampleRate: SR, durationSec: 0.8, pitch: (t) => 57 + 0.8 * Math.sin(2 * Math.PI * 1.5 * t) });
    const base = { sustainMode: "none" as const, flatten: 0, wobble: { ...DEFAULT_PARAMS.wobble, micro: false } };
    const plain = play(setup(voice, base).engine, 60, 0.6, 0.4);
    const tr = play(setup(voice, { ...base, transposeOnly: true, flatten: 1, wobble: { ...DEFAULT_PARAMS.wobble, micro: true } }).engine, 60, 0.6, 0.4);
    let diff = 0;
    for (let i = 0; i < plain.length; i++) diff = Math.max(diff, Math.abs(plain[i] - tr[i]));
    expect(diff).toBeLessThan(1e-6);
    // (Flattened, it differs.)
    const flat = play(setup(voice, { ...base, flatten: 1 }).engine, 60, 0.6, 0.4);
    let d2 = 0;
    for (let i = 0; i < plain.length; i++) d2 = Math.max(d2, Math.abs(plain[i] - flat[i]));
    expect(d2).toBeGreaterThan(0.01);
  });
});

describe("Engine: 伸ばす(移調)", () => {
  // A voice that rises steadily (a semitone a second) with a vibrato on it: the drift a long held note would wander with.
  const drifting = () => synthVoice({ sampleRate: SR, durationSec: 1.6, pitch: (t) => 57 + (t - 0.8) + 0.3 * Math.sin(2 * Math.PI * 5.5 * t) });
  /** The pitch (MIDI, from the note) every 0.2 s from 0.6 s on, the median of each step: a looped sustain 0.3–1.4 s held 2.4 s. */
  const steps = (driftFix: boolean) => {
    const material = drifting();
    const analysis = analyzeMaterial([material], SR);
    const engine = new Engine(SR);
    engine.setSource(prepareSource([material], analysis, SR));
    const root = analysis.root!.midi;
    engine.setInstrument({ ...analysis.markers, rangeStart: 0, sustainStart: 0.3, sustainEnd: 1.4 }, { ...DEFAULT_PARAMS, root, sustainMode: "loop", transposeOnly: true, flatten: 0, driftFix });
    const out = play(engine, 57, 2.4);
    const f0 = analyzePitch(out, SR).f0;
    const medians: number[] = [];
    for (let t = 0.6; t < 2.35; t += 0.2) {
      const span = Array.from(f0.slice(Math.round(t / 0.005), Math.round((t + 0.2) / 0.005))).filter(Number.isFinite).sort((x, y) => x - y);
      medians.push(span[span.length >> 1] - 57 + (57 - root));
    }
    return medians;
  };

  it("brings the sustain's slow drift onto the key (the contour kept without it)", () => {
    const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
    // As recorded, the loop goes up a semitone and jumps back each time round …
    expect(spread(steps(false))).toBeGreaterThan(0.6);
    // … with the drift brought in, it stays on the key (the vibrato averaged out in each step).
    const fixed = steps(true);
    expect(spread(fixed)).toBeLessThan(0.3);
    for (const m of fixed) expect(Math.abs(m)).toBeLessThan(0.2);
  });
});

describe("Engine: 持続部だけシンセ化", () => {
  // A scoop up into the note (two semitones under, over 0.25 s), then the vowel held with a vibrato.
  const scooped = () => synthVoice({ sampleRate: SR, durationSec: 1.2, pitch: (t) => (t < 0.25 ? 55 + 8 * t : 57 + 0.4 * Math.sin(2 * Math.PI * 5.5 * t)) });
  /** The output's pitch (MIDI) over a span, the median, from a note held 1.2 s. */
  const run = (sustainOnlySynth: boolean) => {
    const material = scooped();
    const analysis = analyzeMaterial([material], SR);
    const engine = new Engine(SR);
    engine.setSource(prepareSource([material], analysis, SR));
    engine.setInstrument({ ...analysis.markers, rangeStart: 0, sustainStart: 0.3, sustainEnd: 1.1 }, { ...DEFAULT_PARAMS, root: 57, sustainOnlySynth });
    const f0 = analyzePitch(play(engine, 57, 1.2), SR).f0;
    const at = (from: number, to: number) => {
      const xs = Array.from(f0.slice(Math.round(from / 0.005), Math.round(to / 0.005))).filter(Number.isFinite).sort((a, b) => a - b);
      return { median: xs[xs.length >> 1], spread: xs[Math.floor(xs.length * 0.9)] - xs[Math.floor(xs.length * 0.1)] };
    };
    return { head: at(0.04, 0.12), sustain: at(0.6, 1.1) };
  };

  it("on: the head keeps its scoop, the sustain is flat; off: both flat", () => {
    const on = run(true);
    const off = run(false);
    expect(on.head.median).toBeLessThan(56.2);
    expect(Math.abs(off.head.median - 57)).toBeLessThan(0.2);
    for (const r of [on, off]) {
      expect(Math.abs(r.sustain.median - 57)).toBeLessThan(0.1);
      expect(r.sustain.spread).toBeLessThan(0.15);
    }
  });
});

describe("Engine: a voiced gap the analysis lost the pitch of", () => {
  it("is moved onto the note like the vowel around it, not left at the recorded pitch", () => {
    // A vowel held at A3 a semitone sharp; 40 ms of it the analysis has no pitch for (a fast slide, a break).
    const vowel = synthVoice({ sampleRate: SR, durationSec: 1.2, pitch: (t) => (t > 0.5 && t < 0.54 ? 61 : 58) });
    const analysis = analyzeMaterial([vowel], SR);
    const source = prepareSource([vowel], analysis, SR);
    for (let k = 0; k < source.marks.length; k++) {
      const sec = source.marks[k] / SR;
      if (sec > 0.5 && sec < 0.54) {
        source.voiced[k] = 0;
        source.f0[k] = Number.NaN;
      }
    }
    const engine = new Engine(SR);
    engine.setSource(source);
    engine.setInstrument({ ...analysis.markers, rangeStart: 0, sustainStart: 0.2, sustainEnd: 1.1 }, { ...DEFAULT_PARAMS, root: 58, sustainMode: "stretch", sustainOnlySynth: false });
    const out = play(engine, 64, 1.2);
    // The stretch reads the sustain about 1:1 here; the lost 40 ms sits around 0.5 s of the output. Its energy at the
    // note (E4) against the recorded pitch the periods used to slip through at, untouched (C#4):
    const power = (midi: number) => {
      const hz = 440 * 2 ** ((midi - 69) / 12);
      let re = 0;
      let im = 0;
      for (let i = Math.round(0.505 * SR); i < Math.round(0.535 * SR); i++) {
        re += out[i] * Math.cos((2 * Math.PI * hz * i) / SR);
        im += out[i] * Math.sin((2 * Math.PI * hz * i) / SR);
      }
      return re * re + im * im;
    };
    expect(power(64)).toBeGreaterThan(4 * power(61));
  });
});
