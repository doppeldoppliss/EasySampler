import { describe, expect, it } from "vitest";
import { midiToHz } from "../../src/analysis/pitch";
import { artefactMetrics, levelMetrics, pitchMetrics, report, seamMetrics, toneMetrics } from "./metrics";

const SR = 44100;

function tone(midi: number, sec: number, amp = 0.5, vibrato?: { hz: number; cents: number }): Float32Array {
  const out = new Float32Array(Math.round(sec * SR));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const cents = vibrato ? vibrato.cents * Math.sin(2 * Math.PI * vibrato.hz * t) : 0;
    phase += midiToHz(midi + cents / 100) / SR;
    // A few harmonics, so pYIN has something to hold on to.
    out[i] = amp * (Math.sin(2 * Math.PI * phase) + 0.4 * Math.sin(4 * Math.PI * phase) + 0.2 * Math.sin(6 * Math.PI * phase)) * 0.6;
  }
  return out;
}

describe("pitchMetrics", () => {
  it("measures the error and sees a vibrato", () => {
    const flat = pitchMetrics(tone(62, 1), SR, 62, 0.1, 0.9);
    expect(Math.abs(flat.medianCents)).toBeLessThan(5);
    expect(flat.spreadCents).toBeLessThan(10);
    expect(flat.vibratoHz).toBe(0);
    const off = pitchMetrics(tone(62.3, 1), SR, 62, 0.1, 0.9);
    expect(off.medianCents).toBeGreaterThan(20);
    const vib = pitchMetrics(tone(62, 1.5, 0.5, { hz: 5.5, cents: 40 }), SR, 62, 0.1, 1.4);
    expect(Math.abs(vib.vibratoHz - 5.5)).toBeLessThan(0.5);
    expect(vib.vibratoCents).toBeGreaterThan(25);
  });
});

describe("levelMetrics", () => {
  it("finds the attack, the fade and the silence", () => {
    const x = tone(60, 1);
    const n = x.length;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      x[i] *= Math.min(1, t / 0.05) * (t > 0.7 ? Math.max(0, (0.9 - t) / 0.2) : 1);
    }
    const m = levelMetrics(x, SR);
    expect(m.attackSec).toBeGreaterThan(0.03);
    expect(m.attackSec).toBeLessThan(0.07);
    expect(m.soundingSec).toBeLessThan(0.92);
    expect(m.fadeOutSec).toBeGreaterThan(0.1);
    expect(m.trailingSilenceSec).toBeGreaterThan(0.08);
    expect(Math.abs(m.dcOffset)).toBeLessThan(0.01);
  });
});

describe("artefacts and tone", () => {
  it("hears a click, clipping, a buzz and a dropout", () => {
    const clean = tone(60, 1);
    const a = artefactMetrics(clean, SR, 1);
    expect(a.clicks.count).toBe(0);
    expect(a.clippedSamples).toBe(0);
    expect(a.amRoughness.depth).toBeLessThan(0.1);
    const clicked = clean.slice();
    clicked[20000] += 0.8;
    expect(artefactMetrics(clicked, SR, 1).clicks.count).toBeGreaterThanOrEqual(1);
    const clipped = Float32Array.from(clean, (v) => Math.max(-1, Math.min(1, v * 4)));
    expect(artefactMetrics(clipped, SR, 1).clippedSamples).toBeGreaterThan(100);
    const buzz = Float32Array.from(clean, (v, i) => v * (1 - 0.5 * (0.5 - 0.5 * Math.cos((2 * Math.PI * 80 * i) / SR))));
    const b = artefactMetrics(buzz, SR, 1);
    expect(Math.abs(b.amRoughness.hz - 80)).toBeLessThan(10);
    expect(b.amRoughness.depth).toBeGreaterThan(0.15);
    const gap = clean.slice();
    gap.fill(0, Math.round(0.5 * SR), Math.round(0.53 * SR));
    expect(artefactMetrics(gap, SR, 1).dropouts.count).toBe(1);
  });

  it("tells a bright noise from a dark tone", () => {
    const dark = toneMetrics(tone(48, 0.5), SR, 0.5);
    let seed = 1;
    const noise = Float32Array.from({ length: SR / 2 }, () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 0.6 - 0.3);
    const bright = toneMetrics(noise, SR, 0.5);
    expect(bright.centroidHz).toBeGreaterThan(dark.centroidHz * 3);
    expect(bright.flatness).toBeGreaterThan(dark.flatness * 5);
    expect(bright.hissBand).toBeGreaterThan(0.3);
  });

  it("judges a loop seam", () => {
    const period = 168; // an exact period: the tone's frequency is SR / 168
    const x = tone(69 + 12 * Math.log2(SR / period / 440), 1);
    const start = 10 * period;
    const good = seamMetrics(x, SR, start, start + 20 * period);
    expect(good.stepRelative).toBeLessThan(0.1);
    const bad = seamMetrics(x, SR, start, start + 20 * period + Math.round(period / 4));
    expect(bad.stepRelative).toBeGreaterThan(good.stepRelative + 0.5);
  });

  it("writes warnings for the bad things only", () => {
    const clean = report([tone(62, 1)], SR, { targetMidi: 62, sustainFromSec: 0.1, sustainToSec: 0.9 });
    expect(clean.warnings).toEqual([]);
    const x = tone(62, 1);
    x[20000] += 0.8;
    const dirty = report([x], SR, { targetMidi: 60, sustainFromSec: 0.1, sustainToSec: 0.9 });
    expect(dirty.warnings.some((w) => w.startsWith("クリック"))).toBe(true);
    expect(dirty.warnings.some((w) => w.startsWith("音程のずれ"))).toBe(true);
  });
});
