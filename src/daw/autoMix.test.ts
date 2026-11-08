import { describe, expect, it } from "vitest";
import { balanceGains, cleanEq, kickDuck, madeByAuto, together, lowCutFor, maskingDip, octaveFit, roomFor } from "./autoMix";
import { BAND_HZ } from "../fx/balance";
import { DEFAULT_FX } from "../instrument/types";
import type { Note } from "./model";
import { trackRoles } from "./roles";

const note = (pitch: number, start = 0): Note => ({ id: pitch * 1000 + start, start, length: 1, pitch, velocity: 0.8 });

describe("自動ミックス", () => {
  it("volumes: the lead stays, the rest go to their parts' levels; parts shared by several tracks share the level", () => {
    const { gains, reference } = balanceGains(
      [
        { role: "lead", lufs: -14, gain: 1 },
        { role: "bass", lufs: -20, gain: 1 },
        { role: "backing", lufs: -14, gain: 1 },
        { role: "backing", lufs: -14, gain: 1 },
        { role: "chords", lufs: null, gain: 1 },
      ],
      4,
    );
    expect(reference).toBe(0);
    expect(gains[0]).toBeNull();
    expect(gains[4]).toBeNull();
    const db = (g: number | null) => 20 * Math.log10(g!);
    // Bass: −20 → −14 (as loud as the lead).
    expect(db(gains[1])).toBeCloseTo(6, 5);
    // Two accompaniments: each −6 − 3 = −9 under the lead.
    expect(db(gains[2])).toBeCloseTo(-9, 1);
    expect(db(gains[3])).toBeCloseTo(-9, 1);
  });

  it("volumes: an audio track (原曲) is the reference when there is one; no gain past the fader", () => {
    const { gains, reference } = balanceGains(
      [
        { role: "lead", lufs: -30, gain: 1 },
        { role: "audio", lufs: -12, gain: 1 },
      ],
      2,
    );
    expect(reference).toBe(1);
    expect(gains[0]).toBeCloseTo(2, 6);
    // (The lead wanted far more: the audio track came down instead of the lead stopping short.)
    expect(20 * Math.log10(gains[1]!)).toBeCloseTo(-12, 1);
  });

  it("the low cut sits a little under a track's low notes", () => {
    expect(lowCutFor([note(60), note(64), note(67)])).toBe(183); // 0.7 × C4
    expect(lowCutFor([note(36)])).toBe(46);
    expect(lowCutFor([note(84)])).toBe(250);
  });

  it("dips a track where it is strong and so is the lead; nothing when the lead is not strong there", () => {
    const flat = BAND_HZ.map(() => 0);
    const bump = (hz: number, db: number) => BAND_HZ.map((b) => db * Math.exp(-((Math.log2(b / hz) / 0.4) ** 2)));
    const dip = maskingDip(bump(1000, 6), bump(1000, 6).map((x, j) => x + flat[j]));
    expect(dip?.hz).toBeGreaterThan(800);
    expect(dip?.hz).toBeLessThan(1300);
    expect(dip?.db).toBe(-3);
    expect(maskingDip(bump(2500, 6), bump(400, 6))).toBeNull();
  });

  it("ducks the bass and the held chords to the kick, gently; not short chords, the lead or the drums", () => {
    expect(kickDuck("bass", 120, DEFAULT_FX.duck, 0.25)).toMatchObject({ on: true, source: "kick", depthDb: -3, releaseMs: 125 });
    expect(kickDuck("chords", 120, DEFAULT_FX.duck, 2)?.releaseMs).toBe(250);
    expect(kickDuck("chords", 120, DEFAULT_FX.duck, 2)?.depthDb).toBe(-2);
    expect(kickDuck("chords", 120, DEFAULT_FX.duck, 0.5)).toBeNull();
    expect(kickDuck("lead", 120, DEFAULT_FX.duck, 2)).toBeNull();
    expect(kickDuck("drum", 120, DEFAULT_FX.duck, 2)).toBeNull();
  });

  it("moves a track by the octaves that bring it nearest its cut's pitch", () => {
    // A bass line around C2 on a voice recorded at C4: up two octaves.
    expect(octaveFit([note(36), note(38), note(40)], 60)).toBe(2);
    expect(octaveFit([note(58), note(62)], 60)).toBe(0);
    expect(octaveFit([note(86)], 60)).toBe(-2);
  });

  it("rooms by part and tempo: none on the bass, more on the accompaniment than the lead, longer when slower", () => {
    expect(roomFor("bass", 120, DEFAULT_FX.reverb, 1)).toBeNull();
    const lead = roomFor("lead", 120, DEFAULT_FX.reverb, 1)!;
    const backing = roomFor("backing", 120, DEFAULT_FX.reverb, 1)!;
    expect(backing.mix).toBeGreaterThan(lead.mix);
    expect(roomFor("lead", 70, DEFAULT_FX.reverb, 1)!.size).toBeGreaterThan(roomFor("lead", 170, DEFAULT_FX.reverb, 1)!.size);
    expect(lead.preDelayMs).toBe(31);
    expect(lead.mix).toBe(0.06);
    // A fast part of sixteenths: no room.
    expect(roomFor("backing", 120, DEFAULT_FX.reverb, 0.13)).toBeNull();
  });

  it("a role set by hand wins, and a lead set by hand stops another being found", () => {
    const tracks = [
      { kind: "melodic" as const, notes: [note(72), note(74, 1), note(76, 2)], role: null },
      { kind: "melodic" as const, notes: [note(40), note(43, 1)], role: "lead" as const },
      { kind: "melodic" as const, notes: [note(64), note(65, 1)], role: "harmony" as const },
    ];
    expect(trackRoles(tracks).map((r) => r.role)).toEqual(["backing", "lead", "harmony"]);
  });

  it("a track that would need more than the fader gives brings everything down instead (the balance holds)", () => {
    const { gains, loweredDb } = balanceGains(
      [
        { role: "lead", lufs: -14, gain: 1 },
        { role: "drum", lufs: -30, gain: 1 },
      ],
      2,
    );
    const db = (g: number | null) => 20 * Math.log10(g!);
    // The kit wants +15 dB, the fader stops at +6: all 9 dB down, the lead too.
    expect(loweredDb).toBeCloseTo(9, 1);
    expect(db(gains[1])).toBeCloseTo(6, 1);
    expect(db(gains[0])).toBeCloseTo(-9, 1);
  });

  it("the clean-up EQ starts flat: a switched-off EQ's old shelves do not come back with it", () => {
    const eq = cleanEq(120, { hz: 800, db: -3 });
    expect(eq).toMatchObject({ on: true, lowCutHz: 120, lowDb: 0, highDb: 0, midHz: 800, midDb: -3 });
  });

  it("a bass line copied an octave up is the bass, not the lead", () => {
    const line = [36, 38, 40, 43, 41, 40, 38, 36];
    const bass = line.map((p, k) => note(p, k));
    const up = line.map((p, k) => note(p + 12, k));
    const melody = [72, 71, 69, 67].map((p, k) => note(p, k * 2));
    const roles = trackRoles([
      { kind: "melodic", notes: bass },
      { kind: "melodic", notes: up },
      { kind: "melodic", notes: melody },
    ]);
    expect(roles.map((r) => r.role)).toEqual(["bass", "bass", "lead"]);
  });

  it("a melody passed between tracks by section keeps its full level on each; tracks playing at once share it", () => {
    const bars = (from: number, to: number) => Array.from({ length: (to - from) * 4 }, (_, k) => note(72, from * 4 + k));
    // Three melody tracks, one after another (bars 0–4, 4–8, 8–12).
    expect(together([bars(0, 4), bars(4, 8), bars(8, 12)])).toBeCloseTo(1, 5);
    expect(together([bars(0, 4), bars(0, 4)])).toBeCloseTo(2, 5);
    const { gains, reference } = balanceGains(
      [
        { role: "lead", lufs: -14, gain: 1, notes: bars(0, 4) },
        { role: "lead", lufs: -20, gain: 1, notes: bars(4, 12) },
      ],
      4,
    );
    // The lead with the most notes is the reference; the other comes up to it, not 3 dB under.
    expect(reference).toBe(1);
    expect(20 * Math.log10(gains[0]!)).toBeCloseTo(-6, 1);
  });

  it("tells what the automatic mixing put in from what was set by hand (marked, or exactly its own, or nothing at all)", () => {
    const fx = structuredClone(DEFAULT_FX);
    expect(madeByAuto(fx, "reverb", 150)).toBe(true); // off: free
    fx.reverb = roomFor("chords", 150, fx.reverb, 1)!;
    expect(madeByAuto(fx, "reverb", 150)).toBe(true);
    delete fx.reverb.auto; // made before the mark: still its own formula
    expect(madeByAuto(fx, "reverb", 150)).toBe(true);
    fx.reverb.size = 0.15; // changed by hand
    expect(madeByAuto(fx, "reverb", 150)).toBe(false);
    fx.eq = { ...fx.eq, on: true, lowDb: -7 };
    expect(madeByAuto(fx, "eq", 150)).toBe(false);
    fx.eq = { ...DEFAULT_FX.eq, on: true, lowCutHz: 0 }; // on, doing nothing
    expect(madeByAuto(fx, "eq", 150)).toBe(true);
    fx.eq = { ...DEFAULT_FX.eq, on: true, lowCutHz: 163, midHz: 1000, midDb: -3, midQ: 1.4, lowDb: 5.5 }; // an old clean-up EQ
    expect(madeByAuto(fx, "eq", 150)).toBe(true);
    fx.duck = { ...fx.duck, on: true, source: "trackA" };
    expect(madeByAuto(fx, "duck", 150)).toBe(false);
    fx.duck.source = "kick";
    expect(madeByAuto(fx, "duck", 150)).toBe(true);
  });

  it("a synth bass (weight 2) under two voice basses takes half the bass's power, the voices a quarter each", () => {
    const bars = Array.from({ length: 16 }, (_, k) => note(40, k));
    const { gains } = balanceGains(
      [
        { role: "lead", lufs: -14, gain: 1, notes: bars.map((n) => ({ ...n, pitch: 72 })) },
        { role: "bass", lufs: -20, gain: 1, notes: bars, weight: 2 },
        { role: "bass", lufs: -20, gain: 1, notes: bars },
        { role: "bass", lufs: -20, gain: 1, notes: bars },
      ],
      4,
    );
    const lufs = gains.slice(1).map((g) => -20 + 20 * Math.log10(g!));
    // The bass's level is the lead's (−14); in power: ½, ¼, ¼ of it.
    expect(lufs[0]).toBeCloseTo(-14 - 3.01, 1);
    expect(lufs[1]).toBeCloseTo(-14 - 6.02, 1);
    const sum = 10 * Math.log10(lufs.reduce((a, l) => a + 10 ** (l / 10), 0));
    expect(sum).toBeCloseTo(-14, 1);
  });

  it("ベースの強さ: +3 puts the bass 3 dB over the lead", () => {
    const { gains } = balanceGains(
      [
        { role: "lead", lufs: -14, gain: 1 },
        { role: "bass", lufs: -20, gain: 1 },
      ],
      4,
      { bass: 3 },
    );
    expect(20 * Math.log10(gains[1]!)).toBeCloseTo(9, 5);
  });

  it("和音・伴奏の強さ: +3 puts the chords 3 dB nearer the lead", () => {
    const { gains } = balanceGains(
      [
        { role: "lead", lufs: -14, gain: 1 },
        { role: "chords", lufs: -20, gain: 1 },
      ],
      4,
      { chords: 3 },
    );
    // −5 under the lead, +3: −16 from −20.
    expect(20 * Math.log10(gains[1]!)).toBeCloseTo(4, 5);
  });
});
