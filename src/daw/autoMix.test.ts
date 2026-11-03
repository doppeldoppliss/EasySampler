import { describe, expect, it } from "vitest";
import { balanceGains, kickDuck, lowCutFor, maskingDip, octaveFit, roomFor } from "./autoMix";
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
    // Bass: −20 → −16 (lead −2).
    expect(db(gains[1])).toBeCloseTo(4, 5);
    // Two accompaniments: each −6 − 3 = −9 under the lead.
    expect(db(gains[2])).toBeCloseTo(-9, 1);
    expect(db(gains[3])).toBeCloseTo(-9, 1);
  });

  it("volumes: an audio track (原曲) is the reference when there is one; gains stay in range", () => {
    const { gains, reference } = balanceGains(
      [
        { role: "lead", lufs: -30, gain: 1 },
        { role: "audio", lufs: -12, gain: 1 },
      ],
      2,
    );
    expect(reference).toBe(1);
    expect(gains[0]).toBe(2);
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

  it("ducks the bass and the accompaniment to the kick, not the lead or the drums", () => {
    expect(kickDuck("bass", 120, DEFAULT_FX.duck)).toMatchObject({ on: true, source: "kick", depthDb: -6, releaseMs: 250 });
    expect(kickDuck("chords", 120, DEFAULT_FX.duck)?.depthDb).toBe(-3);
    expect(kickDuck("lead", 120, DEFAULT_FX.duck)).toBeNull();
    expect(kickDuck("drum", 120, DEFAULT_FX.duck)).toBeNull();
  });

  it("moves a track by the octaves that bring it nearest its cut's pitch", () => {
    // A bass line around C2 on a voice recorded at C4: up two octaves.
    expect(octaveFit([note(36), note(38), note(40)], 60)).toBe(2);
    expect(octaveFit([note(58), note(62)], 60)).toBe(0);
    expect(octaveFit([note(86)], 60)).toBe(-2);
  });

  it("rooms by part and tempo: none on the bass, more on the accompaniment than the lead, longer when slower", () => {
    expect(roomFor("bass", 120, DEFAULT_FX.reverb)).toBeNull();
    const lead = roomFor("lead", 120, DEFAULT_FX.reverb)!;
    const backing = roomFor("backing", 120, DEFAULT_FX.reverb)!;
    expect(backing.mix).toBeGreaterThan(lead.mix);
    expect(roomFor("lead", 70, DEFAULT_FX.reverb)!.size).toBeGreaterThan(roomFor("lead", 170, DEFAULT_FX.reverb)!.size);
    expect(lead.preDelayMs).toBe(31);
  });

  it("a role set by hand wins, and a lead set by hand stops another being found", () => {
    const tracks = [
      { kind: "melodic" as const, notes: [note(72), note(74, 1), note(76, 2)], role: null },
      { kind: "melodic" as const, notes: [note(40), note(43, 1)], role: "lead" as const },
      { kind: "melodic" as const, notes: [note(64), note(65, 1)], role: "harmony" as const },
    ];
    expect(trackRoles(tracks).map((r) => r.role)).toEqual(["backing", "lead", "harmony"]);
  });
});
