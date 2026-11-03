import { describe, expect, it } from "vitest";
import { DECAY_CHOICES, DECAY_TO_SILENCE, DEFAULT_PARAMS, PRESETS, decayChoiceOf, makeModeOf, withDecayChoice, withMakeMode, type DecayChoice, type InstrumentParams } from "./types";
import { parseSettings } from "../export/settings";

const apply = (id: string, p: InstrumentParams) => PRESETS.find((x) => x.id === id)!.apply(p);

describe("presets: each a full starting point", () => {
  it("leaves nothing of the preset before (シンセ化 after 減衰 holds, after 短い素材 draws out)", () => {
    const base = { ...DEFAULT_PARAMS, root: 57 };
    const afterDecay = apply("synth", apply("decay", base));
    expect(afterDecay.amp.sustain).toBe(DEFAULT_PARAMS.amp.sustain);
    expect(afterDecay.amp.release).toBe(DEFAULT_PARAMS.amp.release);
    const afterShort = apply("synth", apply("short", base));
    expect(afterShort.sustainMode).toBe("pool");
    expect(afterShort.flatten).toBe(1);
    // Every preset gives the same result whatever came before.
    for (const id of ["synth", "short", "transpose", "decay", "once"]) {
      const results = ["synth", "short", "transpose", "decay", "once"].map((before) => JSON.stringify(apply(id, apply(before, base))));
      expect(new Set(results).size).toBe(1);
    }
  });

  it("keeps what is the user's: the root, the fades, velocity, formant", () => {
    const mine: InstrumentParams = { ...DEFAULT_PARAMS, root: 62.3, rootMode: "manual", formantSemitones: 2, amp: { ...DEFAULT_PARAMS.amp, attack: 0.05, fadeOut: 0.4, velocitySens: 0.9 } };
    for (const preset of PRESETS) {
      const p = preset.apply(mine);
      expect([p.root, p.rootMode, p.formantSemitones, p.amp.attack, p.amp.fadeOut, p.amp.velocitySens]).toEqual([62.3, "manual", 2, 0.05, 0.4, 0.9]);
    }
  });
});

describe("作り方", () => {
  it("each preset belongs to its own 作り方", () => {
    for (const preset of PRESETS) expect(makeModeOf(preset.apply({ ...DEFAULT_PARAMS }))).toBe(preset.mode);
  });

  it("leaving 伸ばす and coming back finds its 伸ばし方 again, the rest untouched", () => {
    const held: InstrumentParams = { ...DEFAULT_PARAMS, sustainMode: "wavetable", pitchMode: "resample", flatten: 0.4 };
    const one = withMakeMode(held, "oneshot");
    expect([one.sustainMode, one.pitchMode, makeModeOf(one)]).toEqual(["none", "resample", "oneshot"]);
    // 頭部だけ, then back.
    const back = withMakeMode({ ...one, sustainEnabled: false }, "hold");
    expect([back.sustainMode, back.pitchMode, back.sustainEnabled, back.flatten]).toEqual(["wavetable", "resample", true, 0.4]);
  });

  it("移調 is a one-shot that leaves the pitch shaping set but unused; 伸ばす clears it", () => {
    const shaped: InstrumentParams = { ...DEFAULT_PARAMS, flatten: 0.7 };
    const tr = withMakeMode({ ...withMakeMode(shaped, "oneshot"), sustainEnabled: false }, "transpose");
    expect([makeModeOf(tr), tr.transposeOnly, tr.sustainMode, tr.sustainEnabled, tr.flatten]).toEqual(["transpose", true, "none", false, 0.7]);
    expect(makeModeOf(withMakeMode(tr, "oneshot"))).toBe("oneshot");
    const back = withMakeMode(tr, "hold");
    expect([makeModeOf(back), back.transposeOnly]).toEqual(["hold", false]);
  });

  it("an older file with the sustain switched off while drawn out opens as a one-shot of the head", () => {
    const file = JSON.stringify({ app: "EasySampler", version: 1, cuts: [{ markers: { rangeStart: 0, sustainStart: 0.1, sustainEnd: 0.5, tailStart: 0.6, rangeEnd: 1 }, params: { ...DEFAULT_PARAMS, sustainEnabled: false, sustainMode: "loop" } }] });
    const p = parseSettings(file).cuts[0].params;
    expect([makeModeOf(p), p.sustainEnabled, p.heldSustainMode]).toEqual(["oneshot", false, "loop"]);
    expect(makeModeOf(withMakeMode(p, "hold"))).toBe("hold");
    expect(withMakeMode(p, "hold").sustainMode).toBe("loop");
  });
});

describe("作り方: 伸ばす(移調)", () => {
  it("holds with the pitch moved as a whole; to and from the other 作り方", () => {
    const start = PRESETS.find((p) => p.mode === "holdTranspose")!.apply({ ...DEFAULT_PARAMS });
    expect([makeModeOf(start), start.sustainMode, start.transposeOnly, start.driftFix]).toEqual(["holdTranspose", "stretch", true, true]);
    // Between the two kinds of 伸ばす the 伸ばし方 stays.
    const plain = withMakeMode({ ...start, sustainMode: "loop" }, "hold");
    expect([makeModeOf(plain), plain.sustainMode, plain.transposeOnly]).toEqual(["hold", "loop", false]);
    // To 移調 and back finds the 伸ばし方 again.
    const tr = withMakeMode(start, "transpose");
    expect([makeModeOf(tr), tr.sustainMode]).toEqual(["transpose", "none"]);
    expect(withMakeMode(tr, "holdTranspose").sustainMode).toBe("stretch");
  });

  it("is read back from a file as it was", () => {
    const params = { ...DEFAULT_PARAMS, sustainMode: "pool", transposeOnly: true, driftFix: false };
    const file = JSON.stringify({ app: "EasySampler", version: 1, cuts: [{ markers: { rangeStart: 0, sustainStart: 0.1, sustainEnd: 0.5, rangeEnd: 1 }, params }] });
    const p = parseSettings(file).cuts[0].params;
    expect([makeModeOf(p), p.driftFix]).toEqual(["holdTranspose", false]);
  });
});

describe("音の消え方", () => {
  it("each ready choice is gone (-60 dB) in its time, and is read back as itself; anything else is 自分で決める", () => {
    for (const [choice, sec] of Object.entries(DECAY_CHOICES)) {
      const amp = withDecayChoice(DEFAULT_PARAMS.amp, choice as DecayChoice);
      expect(amp.decay * DECAY_TO_SILENCE).toBeCloseTo(sec);
      expect([amp.sustain, decayChoiceOf(amp)]).toEqual([0, choice]);
      expect(amp.release).toBeGreaterThanOrEqual(0.25);
    }
    expect(decayChoiceOf(DEFAULT_PARAMS.amp)).toBe("none");
    expect(decayChoiceOf({ ...withDecayChoice(DEFAULT_PARAMS.amp, "piano"), sustain: 0.3 })).toBe("custom");
    // 自分で決める keeps a decay already set, starts from ピアノ風 when there was none.
    const mine = { ...DEFAULT_PARAMS.amp, decay: 2, sustain: 0.2 };
    expect(withDecayChoice(mine, "custom")).toEqual(mine);
    expect(withDecayChoice(DEFAULT_PARAMS.amp, "custom").decay * DECAY_TO_SILENCE).toBeCloseTo(3);
    expect(decayChoiceOf(withDecayChoice(mine, "none"))).toBe("none");
  });
});
