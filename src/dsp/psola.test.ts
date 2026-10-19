import { describe, expect, it } from "vitest";
import { centerPitch } from "../analysis/centerPitch";
import { analyzePitch } from "../analysis/pyin";
import { demoPhrasePitch, synthVoice } from "../testsignals/synthVoice";
import { findPitchMarks, psolaShift } from "./psola";
import { resampleShift } from "./resample";
import type { ShiftRequest } from "./shift";

const SR = 44100;

function request(input: Float32Array, overrides: Partial<ShiftRequest> = {}): ShiftRequest {
  const track = analyzePitch(input, SR);
  const root = centerPitch(track)?.median ?? 60;
  return { input, sampleRate: SR, track, rootPitch: root, shift: 0, contour: 1, stretch: 1, ...overrides };
}

/** Spectral centroid (Hz) over the whole signal — where the energy sits, i.e. the formants. */
function centroid(x: Float32Array): number {
  const size = 2048;
  let weighted = 0;
  let total = 0;
  for (let start = 0; start + size <= x.length; start += size) {
    for (let k = 1; k < size / 2; k += 2) {
      let re = 0;
      let im = 0;
      for (let n = 0; n < size; n += 1) {
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / size);
        const angle = (2 * Math.PI * k * n) / size;
        re += w * x[start + n] * Math.cos(angle);
        im -= w * x[start + n] * Math.sin(angle);
      }
      const power = re * re + im * im;
      weighted += power * ((k * SR) / size);
      total += power;
    }
  }
  return weighted / total;
}

function rms(x: Float32Array): number {
  let acc = 0;
  for (const v of x) acc += v * v;
  return Math.sqrt(acc / x.length);
}

describe("findPitchMarks", () => {
  it("puts one voiced mark per period", () => {
    const x = synthVoice({ sampleRate: SR, durationSec: 0.5, pitch: () => 57 }); // 220 Hz
    const marks = findPitchMarks(x, SR, analyzePitch(x, SR));
    const voicedGaps: number[] = [];
    for (let i = 1; i < marks.positions.length; i++) {
      if (marks.voiced[i] && marks.voiced[i - 1]) voicedGaps.push(marks.positions[i] - marks.positions[i - 1]);
    }
    expect(voicedGaps.length).toBeGreaterThan(90);
    for (const gap of voicedGaps) expect(Math.abs(gap - SR / 220)).toBeLessThan(2);
  });
});

describe("psolaShift", () => {
  it("changes the pitch by the requested interval and keeps the length", () => {
    const x = synthVoice({ sampleRate: SR, durationSec: 0.8, pitch: demoPhrasePitch(57, 0.8) });
    for (const shift of [-7, -3, 4, 7]) {
      const req = request(x, { shift });
      const y = psolaShift(req);
      expect(y.length).toBe(x.length);
      const got = centerPitch(analyzePitch(y, SR))!.median;
      expect(Math.abs(got - (req.rootPitch + shift))).toBeLessThan(0.2);
    }
  });

  it("keeps the inflection (contour = 1) or flattens it (contour = 0)", () => {
    const x = synthVoice({ sampleRate: SR, durationSec: 0.8, pitch: demoPhrasePitch(57, 0.8) });
    const kept = centerPitch(analyzePitch(psolaShift(request(x, { shift: 5 })), SR))!;
    const flat = centerPitch(analyzePitch(psolaShift(request(x, { shift: 5, contour: 0 })), SR))!;
    const original = centerPitch(analyzePitch(x, SR))!;
    expect(Math.abs(kept.spread - original.spread)).toBeLessThan(0.08);
    expect(flat.spread).toBeLessThan(original.spread / 3);
  });

  it("keeps the formants where resampling moves them", () => {
    const x = synthVoice({ sampleRate: SR, durationSec: 0.6, pitch: () => 55 });
    const before = centroid(x);
    const psola = centroid(psolaShift(request(x, { shift: 7 })));
    const resampled = centroid(resampleShift(request(x, { shift: 7 })));
    expect(Math.abs(psola / before - 1)).toBeLessThan(0.12);
    expect(resampled / before).toBeGreaterThan(1.3); // moved up with the pitch (×1.5)
  });

  it("keeps the loudness", () => {
    const x = synthVoice({ sampleRate: SR, durationSec: 0.6, pitch: () => 57 });
    for (const shift of [-7, 7]) {
      const ratio = rms(psolaShift(request(x, { shift }))) / rms(x);
      expect(ratio).toBeGreaterThan(0.7);
      expect(ratio).toBeLessThan(1.4);
    }
  });

  it("stretches without changing the pitch", () => {
    const x = synthVoice({ sampleRate: SR, durationSec: 0.6, pitch: () => 57 });
    const y = psolaShift(request(x, { stretch: 1.5 }));
    expect(y.length).toBe(Math.round(x.length * 1.5));
    expect(Math.abs(centerPitch(analyzePitch(y, SR))!.median - 57)).toBeLessThan(0.15);
  });

  it("reconstructs an unvoiced sound unchanged", () => {
    let seed = 7;
    const noise = new Float32Array(SR / 4).map(() => {
      seed = (seed * 16807) % 2147483647;
      return (seed / 2147483647 - 0.5) * 0.4;
    });
    const y = psolaShift(request(noise, { shift: 5 }));
    let error = 0;
    for (let i = 500; i < noise.length - 500; i++) error = Math.max(error, Math.abs(y[i] - noise[i]));
    expect(error).toBeLessThan(0.02);
  });
});

describe("resampleShift", () => {
  it("shortens the sound as it raises the pitch", () => {
    const x = synthVoice({ sampleRate: SR, durationSec: 0.5, pitch: () => 57 });
    const y = resampleShift(request(x, { shift: 12 }));
    expect(y.length).toBe(Math.floor(x.length / 2));
    expect(Math.abs(centerPitch(analyzePitch(y, SR))!.median - 69)).toBeLessThan(0.1);
  });
});
