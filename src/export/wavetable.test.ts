import { describe, expect, it } from "vitest";
import { analyzePitch } from "../analysis/pyin";
import { rootPitch } from "../analysis/rootPitch";
import { readWavChunks } from "../audio/wav";
import { Engine } from "../engine/engine";
import { analyzeMaterial, prepareSource } from "../engine/prepare";
import { DEFAULT_EXPORT, DEFAULT_PARAMS, PRESETS } from "../instrument/types";
import { demoSyllable, synthVoice } from "../testsignals/synthVoice";
import { buildOne } from "./build";
import { buildWavetable, FRAME_SIZE } from "./wavetable";

const SR = 44100;

function setup() {
  const material = demoSyllable(SR);
  const analysis = analyzeMaterial([material], SR);
  const source = prepareSource([material], analysis, SR);
  return { material, analysis, source };
}

describe("buildWavetable", () => {
  it("cuts phase-aligned 2048-sample frames from the sustain's periods", () => {
    const { analysis, source } = setup();
    const table = buildWavetable(source, analysis.markers)!;
    expect(table).not.toBeNull();
    expect(table.samples.length).toBe(FRAME_SIZE * table.frames);
    expect(table.frames).toBeGreaterThan(5);
    expect(table.frames).toBeLessThanOrEqual(256);
    for (let f = 0; f < table.frames; f++) {
      const frame = table.samples.subarray(f * FRAME_SIZE, (f + 1) * FRAME_SIZE);
      let peak = 0;
      let mean = 0;
      for (const v of frame) {
        peak = Math.max(peak, Math.abs(v));
        mean += v;
      }
      expect(peak).toBeCloseTo(0.9, 2);
      expect(Math.abs(mean / FRAME_SIZE)).toBeLessThan(1e-3);
    }
    // Neighbouring frames of a steady vowel look alike (phase-aligned): high correlation.
    const a = table.samples.subarray(0, FRAME_SIZE);
    const b = table.samples.subarray(FRAME_SIZE, 2 * FRAME_SIZE);
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < FRAME_SIZE; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    expect(dot / Math.sqrt(na * nb)).toBeGreaterThan(0.9);
  });

  it("thins a long sustain to at most the frame limit", () => {
    const long = synthVoice({ sampleRate: SR, durationSec: 4, pitch: () => 57 }); // ~880 periods
    const analysis = analyzeMaterial([long], SR);
    const source = prepareSource([long], analysis, SR);
    const table = buildWavetable(source, { ...analysis.markers, sustainStart: 0.1, sustainEnd: 3.9 }, 64)!;
    expect(table.frames).toBe(64);
  });

  it("returns null for an unvoiced material", () => {
    const noise = new Float32Array(SR);
    let seed = 1;
    for (let i = 0; i < noise.length; i++) {
      seed = (seed * 16807) % 2147483647;
      noise[i] = (seed / 2147483647 - 0.5) * 0.5;
    }
    const analysis = analyzeMaterial([noise], SR);
    const source = prepareSource([noise], analysis, SR);
    expect(buildWavetable(source, analysis.markers)).toBeNull();
  });

  it("is exported as one mono WAV whose length is a whole number of frames", async () => {
    const { analysis, source } = setup();
    const cut = { name: "x", markers: analysis.markers, params: { ...DEFAULT_PARAMS, root: analysis.root!.midi }, note: 62, noteMode: "auto" as const };
    const built = await buildOne({ baseName: "ore", source, cut, settings: { ...DEFAULT_EXPORT, format: "wavetable" }, credit: { title: "", url: "", timecode: "", memo: "" } });
    expect(built.fileName).toBe("ore_wavetable.wav");
    const chunks = readWavChunks(await built.blob.arrayBuffer());
    expect(chunks.channels).toBe(1);
    expect(chunks.frames % FRAME_SIZE).toBe(0);
    expect(chunks.info.ICMT).toContain("2048 samples/frame");
    // The tag Serum and Vital read: frame size, and "0" = one frame per block (no morphing between frames); even-sized.
    expect(chunks.clm).toBe("<!>2048 00000000 wavetable (MADDAW)");
    const bytes = new Uint8Array(await built.blob.arrayBuffer());
    const at = bytes.findIndex((_, i) => bytes[i] === 0x63 && bytes[i + 1] === 0x6c && bytes[i + 2] === 0x6d && bytes[i + 3] === 0x20);
    expect(at).toBe(36); // right after fmt, before data
    expect(new DataView(bytes.buffer).getUint32(at + 4, true) % 2).toBe(0);
    // The preview sounds at the note.
    const pitch = rootPitch(analyzePitch(built.preview.channels[0], SR))!;
    expect(Math.abs(pitch.midi - 62)).toBeLessThan(0.3);
  });
});

describe("wavetable sustain (engine)", () => {
  it("repeats one period exactly: a dead-steady pitch, and identical consecutive periods", () => {
    const { analysis, source } = setup();
    const engine = new Engine(SR);
    engine.setSource(source);
    const params = PRESETS.find((p) => p.id === "wavetable")!.apply({ ...DEFAULT_PARAMS, root: analysis.root!.midi });
    engine.setInstrument(analysis.markers, params);
    const out = new Float32Array(2 * SR);
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    engine.noteOn(57, 1);
    for (let at = 0; at + 128 <= out.length; at += 128) {
      engine.render(l, r);
      out.set(l, at);
    }
    const pitch = rootPitch(analyzePitch(out.slice(SR, 2 * SR), SR))!;
    expect(Math.abs(pitch.midi - 57)).toBeLessThan(0.1);
    expect(pitch.spread).toBeLessThan(0.05);
    // Twenty periods later the waveform is the same. The exact period comes from the mark spacing (a few
    // cents off the nominal 220 Hz), so the lag is searched around 20 × 200.45 samples.
    const nominal = Math.round((20 * SR) / 220);
    let best = Infinity;
    for (let lag = Math.round(nominal * 0.97); lag <= Math.round(nominal * 1.03); lag++) {
      let diff = 0;
      let energy = 0;
      for (let i = SR; i < SR + 4000; i++) {
        diff += (out[i] - out[i + lag]) ** 2;
        energy += out[i] ** 2;
      }
      best = Math.min(best, diff / energy);
    }
    expect(best).toBeLessThan(0.05);
    // Whereas the pool mode (a random walk over periods) never repeats exactly.
    const engine2 = new Engine(SR);
    engine2.setSource(source);
    engine2.setInstrument(analysis.markers, { ...params, sustainMode: "pool" });
    const out2 = new Float32Array(2 * SR);
    engine2.noteOn(57, 1);
    for (let at = 0; at + 128 <= out2.length; at += 128) {
      engine2.render(l, r);
      out2.set(l, at);
    }
    let best2 = Infinity;
    for (let lag = Math.round(nominal * 0.97); lag <= Math.round(nominal * 1.03); lag++) {
      let diff = 0;
      let energy = 0;
      for (let i = SR; i < SR + 4000; i++) {
        diff += (out2[i] - out2[i + lag]) ** 2;
        energy += out2[i] ** 2;
      }
      best2 = Math.min(best2, diff / energy);
    }
    expect(best2).toBeGreaterThan(best);
  });
});
