import { describe, expect, it } from "vitest";
import { BAND_HZ, bandSpectrum, fitBalance, nearestStyle, targetDb, type BalanceStyle } from "./balance";
import { DEFAULT_FX } from "../instrument/types";

const SR = 48000;

/** A sound whose third-octave bands have these powers (dB): a few sines at random places in each band. */
function shaped(bandDb: readonly number[], sec = 2): Float32Array {
  const out = new Float32Array(SR * sec);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  BAND_HZ.forEach((hz, j) => {
    const per = 6;
    const amp = Math.sqrt((2 * 10 ** (bandDb[j] / 10)) / per) * 0.002;
    for (let k = 0; k < per; k++) {
      const f = hz * 2 ** ((rand() - 0.5) / 3.2);
      const ph = rand() * 2 * Math.PI;
      const w = (2 * Math.PI * f) / SR;
      for (let i = 0; i < out.length; i++) out[i] += amp * Math.sin(w * i + ph);
    }
  });
  return out;
}

const fit = (bandDb: number[], style: BalanceStyle = "standard") => fitBalance(bandSpectrum([shaped(bandDb)], SR)!, style, SR, structuredClone(DEFAULT_FX.eq));

describe("master EQ toward a tonal balance", () => {
  it("measures a shaped sound's bands back (within 2.5 dB, relative: the test sines sit near band edges)", () => {
    const want = targetDb("standard");
    const got = bandSpectrum([shaped(want)], SR)!;
    const off = got[16] - want[16];
    BAND_HZ.forEach((hz, j) => {
      if (hz >= 40) expect(Math.abs(got[j] - want[j] - off)).toBeLessThan(2.5);
    });
  });

  it("leaves a song already on the target nearly as it is", () => {
    const r = fit(targetDb("standard"));
    expect(Math.abs(r.eq.lowDb)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.eq.midDb)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.eq.highDb)).toBeLessThanOrEqual(1);
    expect(r.eq.lowCutHz).toBe(30);
  });

  it("brightens a dark song, cuts a muddy one around its mud, tames a boomy one", () => {
    const t = targetDb("standard");
    const dark = fit(t.map((d, j) => d - Math.max(0, 6 * Math.log2(BAND_HZ[j] / 2000))));
    expect(dark.eq.highDb).toBeGreaterThanOrEqual(2);
    const muddy = fit(t.map((d, j) => d + 7 * Math.exp(-((Math.log2(BAND_HZ[j] / 315) / 0.6) ** 2))));
    expect(muddy.eq.midDb).toBeLessThanOrEqual(-2);
    expect(muddy.eq.midHz).toBeGreaterThan(180);
    expect(muddy.eq.midHz).toBeLessThan(600);
    const boomy = fit(t.map((d, j) => d + (BAND_HZ[j] < 150 ? 8 : 0)));
    expect(boomy.eq.lowDb).toBeLessThanOrEqual(-2);
  });

  it("goes about halfway, within ±6 dB, and ends nearer the target than it began", () => {
    const t = targetDb("standard");
    const r = fit(t.map((d, j) => d + 12 * Math.log2(1000 / BAND_HZ[j]) * 0.5));
    for (const g of [r.eq.lowDb, r.eq.midDb, r.eq.highDb]) expect(Math.abs(g)).toBeLessThanOrEqual(6);
    const rms = (xs: number[]) => Math.sqrt(xs.reduce((a, x, j) => (BAND_HZ[j] >= 50 && BAND_HZ[j] <= 12000 ? a + x * x : a), 0));
    expect(rms(r.after)).toBeLessThan(rms(r.before) * 0.75);
  });

  it("the three styles want different things of the same song", () => {
    const song = targetDb("standard");
    const e = fit(song, "electronic").eq;
    const a = fit(song, "acoustic").eq;
    // Electronic wants more lows and more highs than standard has; acoustic less of both.
    expect(e.lowDb).toBeGreaterThan(a.lowDb);
    expect(e.highDb).toBeGreaterThan(a.highDb);
  });

  it("fits toward a reference song's own bands, and says which style a mix is nearest to", () => {
    const flat = { on: false, lowCutHz: 0, lowDb: 0, lowHz: 150, midDb: 0, midHz: 1000, midQ: 1, highDb: 0, highHz: 6000, highCutHz: 20000 };
    // A reference brighter than the song by 6 dB from 4 kHz up (whatever its level): the fit lifts the highs.
    const song = targetDb("standard");
    const reference = song.map((x, j) => x + 20 + (BAND_HZ[j] >= 4000 ? 6 : 0));
    const fit = fitBalance(song, reference, 48000, flat);
    expect(fit.eq.highDb).toBeGreaterThan(1.5);
    expect(Math.abs(fit.eq.lowDb)).toBeLessThan(1.1);
    // A song that already has the reference's shape is left alone.
    const same = fitBalance(reference, reference, 48000, flat);
    expect(Math.abs(same.eq.lowDb)).toBeLessThanOrEqual(0.5);
    expect(same.eq.midDb).toBe(0);
    expect(same.eq.highDb).toBe(0);
    for (const style of ["standard", "electronic", "acoustic"] as BalanceStyle[]) expect(nearestStyle(targetDb(style).map((x) => x - 30))).toBe(style);
  });

  it("uses a second bell for what one cannot reach: a hole and a bump apart from each other, the hole lifted by 3 dB at most", () => {
    const flat = { on: false, lowCutHz: 0, lowDb: 0, lowHz: 150, midDb: 0, midHz: 1000, midQ: 1, highDb: 0, highHz: 6000, highCutHz: 20000 };
    // The target with a 9 dB hole around 250 Hz and a 5 dB bump around 2 kHz.
    const song = targetDb("standard").map((x, j) => x - 9 * Math.exp(-((Math.log2(BAND_HZ[j] / 250) / 0.4) ** 2)) + 5 * Math.exp(-((Math.log2(BAND_HZ[j] / 2000) / 0.5) ** 2)));
    const fit = fitBalance(song, "standard", 48000, flat);
    const bells = [
      { hz: fit.eq.midHz, db: fit.eq.midDb },
      { hz: fit.eq.mid2Hz ?? 0, db: fit.eq.mid2Db ?? 0 },
    ];
    const lift = bells.find((b) => b.db > 0);
    const dip = bells.find((b) => b.db < 0);
    expect(lift && lift.hz > 180 && lift.hz < 350).toBe(true);
    expect(dip && dip.hz > 1400 && dip.hz < 2800).toBe(true);
    expect(fit.eq.mid2Db ?? 0).toBeLessThanOrEqual(3);
    const at250 = BAND_HZ.findIndex((hz) => hz > 240 && hz < 260);
    expect(Math.abs(fit.after[at250])).toBeLessThan(Math.abs(fit.before[at250]));
  });

  it("reads the bands an octave at a time: one third octave left thin by the song's notes is not a hole to fill", () => {
    const flat = { on: false, lowCutHz: 0, lowDb: 0, lowHz: 150, midDb: 0, midHz: 1000, midQ: 1, highDb: 0, highHz: 6000, highCutHz: 20000 };
    // A song in G: on the target but for the 250 Hz band, 9 dB under both neighbours (measured on a real one).
    const at250 = BAND_HZ.findIndex((hz) => hz > 240 && hz < 260);
    const song = targetDb("standard").map((x, j) => (j === at250 ? x - 9 : x));
    const fit = fitBalance(song, "standard", 48000, flat);
    for (const db of [fit.eq.midDb, fit.eq.mid2Db ?? 0]) expect(db).toBeLessThanOrEqual(1);
    expect(Math.abs(fit.eq.lowDb)).toBeLessThanOrEqual(1);
    // (Its octave reads about 3 dB short, not 9.)
    expect(fit.before[at250]).toBeGreaterThan(-4);
    // Its own notes' gaps in a reference song are not asked of the mix either.
    const reference = song.map((x) => x + 12);
    const toward = fitBalance(targetDb("standard"), reference, 48000, flat);
    for (const db of [toward.eq.midDb, toward.eq.mid2Db ?? 0]) expect(db).toBeGreaterThanOrEqual(-1);
  });
});
