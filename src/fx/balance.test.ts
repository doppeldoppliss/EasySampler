import { describe, expect, it } from "vitest";
import { BAND_HZ, bandSpectrum, fitBalance, targetDb, type BalanceStyle } from "./balance";
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
});
