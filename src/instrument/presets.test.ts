import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, PRESETS, type InstrumentParams } from "./types";

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
    for (const id of ["synth", "short", "transpose", "decay"]) {
      const results = ["synth", "short", "transpose", "decay"].map((before) => JSON.stringify(apply(id, apply(before, base))));
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
