import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, PRESETS, makeModeOf, withMakeMode, type InstrumentParams } from "./types";
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

  it("keeps what is the user's: the root, the fades, velocity, formant, fixed pitch", () => {
    const mine: InstrumentParams = { ...DEFAULT_PARAMS, root: 62.3, rootMode: "manual", formantSemitones: 2, fixedPitch: true, amp: { ...DEFAULT_PARAMS.amp, attack: 0.05, fadeOut: 0.4, velocitySens: 0.9 } };
    for (const preset of PRESETS) {
      const p = preset.apply(mine);
      expect([p.root, p.rootMode, p.formantSemitones, p.fixedPitch, p.amp.attack, p.amp.fadeOut, p.amp.velocitySens]).toEqual([62.3, "manual", 2, true, 0.05, 0.4, 0.9]);
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
