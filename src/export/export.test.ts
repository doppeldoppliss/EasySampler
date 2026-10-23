import { describe, expect, it } from "vitest";
import { analyzePitch } from "../analysis/pyin";
import { rootPitch } from "../analysis/rootPitch";
import { readWavChunks } from "../audio/wav";
import { analyzeMaterial, prepareSource } from "../engine/prepare";
import { suggestMarkersWithin } from "../instrument/markers";
import { DEFAULT_EXPORT, DEFAULT_PARAMS, PRESETS } from "../instrument/types";
import { demoSyllable } from "../testsignals/synthVoice";
import { buildBatch, buildKit, buildOne } from "./build";
import { applyLoop } from "./loop";
import { dspresetText, planZones, sfzText } from "./multisample";
import { renderNote } from "./render";
import { parseSettings, serializeSettings, type CutSettings } from "./settings";
import { crc32, listZip, zipStore } from "./zip";

const SR = 44100;

function setup() {
  const material = demoSyllable(SR);
  const analysis = analyzeMaterial([material], SR);
  const source = prepareSource([material], analysis, SR);
  const cut: CutSettings = { name: "区間 1", markers: analysis.markers, params: { ...DEFAULT_PARAMS, root: analysis.root!.midi }, note: 62, noteMode: "auto" };
  const credit = { title: "テスト", url: "https://example.com/sm1", timecode: "0:12", memo: "" };
  return { material, analysis, source, cut, credit };
}

describe("zip (store)", () => {
  it("round-trips names (UTF-8), sizes and CRCs", () => {
    const a = new TextEncoder().encode("hello");
    const b = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
    const zip = zipStore([{ name: "音源/a.txt", data: a }, { name: "音源/samples/b.bin", data: b }]);
    const list = listZip(zip);
    expect(list.map((e) => e.name)).toEqual(["音源/a.txt", "音源/samples/b.bin"]);
    expect(list[0].size).toBe(5);
    expect(list[0].crc).toBe(crc32(a));
    expect(Array.from(list[1].data)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926); // the standard check value
  });
});

describe("applyLoop", () => {
  it("picks a loop inside the sustain and makes the jump seamless", () => {
    const { source, cut } = setup();
    const rendered = renderNote(source, cut.markers, cut.params, 62, 2);
    const loop = applyLoop(rendered, cut.params)!;
    expect(loop).not.toBeNull();
    expect(loop.start / SR).toBeGreaterThan(rendered.headSec + 0.1);
    expect(loop.end / SR).toBeLessThan(rendered.holdEndSec);
    expect(loop.end - loop.start).toBeGreaterThan(0.5 * SR);
    // The frame after the loop's last frame, on the jump, is frame `start`: no step there.
    const x = rendered.channels[0];
    const step = Math.abs(x[loop.end - 1] - x[loop.start]);
    let typical = 0;
    for (let i = loop.start; i < loop.start + 200; i++) typical = Math.max(typical, Math.abs(x[i + 1] - x[i]));
    expect(step).toBeLessThan(typical * 1.5 + 1e-3);
  });

  it("gives up on a one-shot", () => {
    const { source, cut } = setup();
    const drum = PRESETS.find((p) => p.id === "drum")!.apply(cut.params);
    const rendered = renderNote(source, cut.markers, drum, 62, 2);
    expect(applyLoop(rendered, drum)).toBeNull();
  });
});

describe("multisample plan and definitions", () => {
  it("covers the whole keyboard without gaps or overlaps", () => {
    const zones = planZones(60);
    expect(zones.map((z) => z.note)).toEqual([48, 51, 54, 57, 60, 63, 66, 69, 72]);
    expect(zones[0].lowKey).toBe(0);
    expect(zones.at(-1)!.highKey).toBe(127);
    for (let i = 1; i < zones.length; i++) expect(zones[i].lowKey).toBe(zones[i - 1].highKey + 1);
    for (const z of zones) expect(z.lowKey <= z.note && z.note <= z.highKey).toBe(true);
  });

  it("writes SFZ regions and dspreset samples with the loops", () => {
    const zones = planZones(60).map((z) => ({ ...z, fileName: `x_${z.note}.wav`, loop: z.note === 60 ? { start: 1000, end: 5000, crossfade: 100 } : null }));
    const meta = { name: "x", samplesDir: "samples", releaseSec: 0.02, credit: "作品 / https://e.com" };
    const sfz = sfzText(zones, meta);
    expect(sfz).toContain("default_path=samples/");
    expect(sfz).toContain("<region> sample=x_60.wav pitch_keycenter=60 lokey=59 hikey=61 loop_mode=loop_continuous loop_start=1000 loop_end=4999");
    expect(sfz).toContain("sample=x_48.wav pitch_keycenter=48 lokey=0 hikey=49 loop_mode=no_loop");
    const ds = dspresetText(zones, meta);
    expect(ds).toContain(`<sample path="samples/x_60.wav" rootNote="60" loNote="59" hiNote="61" loopEnabled="true" loopStart="1000" loopEnd="4999" loopCrossfade="100" />`);
    expect(ds).toContain(`release="0.020"`);
    expect(ds.startsWith(`<?xml version="1.0"`)).toBe(true);
  });
});

describe("buildOne / buildBatch", () => {
  it("single: a WAV with the credit and the unity note", async () => {
    const { source, cut, credit } = setup();
    const built = await buildOne({ baseName: "ore", source, cut, settings: { ...DEFAULT_EXPORT, format: "single" }, credit });
    expect(built.fileName).toBe("ore_D4_2beat@120.wav");
    const chunks = readWavChunks(await built.blob.arrayBuffer());
    expect(chunks.info.INAM).toBe("テスト");
    expect(chunks.sampler?.unityNote).toBe(62);
    expect(chunks.sampler?.loop).toBeUndefined();
  });

  it("loop: a longer WAV with loop points in the smpl chunk", async () => {
    const { source, cut, credit } = setup();
    const built = await buildOne({ baseName: "ore", source, cut, settings: { ...DEFAULT_EXPORT, format: "loop" }, credit });
    expect(built.fileName).toBe("ore_D4_loop.wav");
    const chunks = readWavChunks(await built.blob.arrayBuffer());
    expect(chunks.frames / SR).toBeGreaterThan(1.9);
    expect(chunks.sampler?.loop).toBeDefined();
    expect(chunks.sampler!.loop!.end).toBeLessThanOrEqual(chunks.frames);
  });

  it("multisample: a zip with one WAV per zone at its own pitch, the SFZ, the dspreset and a README", async () => {
    const { source, cut, credit } = setup();
    const steps: number[] = [];
    const built = await buildOne({ baseName: "ore", source, cut, settings: { ...DEFAULT_EXPORT, format: "multisample" }, credit }, (d) => void steps.push(d));
    expect(built.fileName).toBe("ore.zip");
    expect(steps).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const list = listZip(new Uint8Array(await built.blob.arrayBuffer()));
    const names = list.map((e) => e.name);
    expect(names).toContain("ore/ore.sfz");
    expect(names).toContain("ore/ore.dspreset");
    expect(names).toContain("ore/README.txt");
    expect(names.filter((n) => n.startsWith("ore/samples/")).length).toBe(9);
    // The lowest and highest zones really are an octave apart.
    const wav = (name: string) => {
      const e = list.find((x) => x.name === name)!;
      const chunks = readWavChunks(e.data.buffer.slice(e.data.byteOffset, e.data.byteOffset + e.data.byteLength) as ArrayBuffer);
      const view = new DataView(e.data.buffer, e.data.byteOffset);
      const pcm = new Float32Array(chunks.frames);
      for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(44 + i * 2, true) / 32768;
      return { pcm, chunks };
    };
    const low = wav("ore/samples/ore_D3.wav");
    const high = wav("ore/samples/ore_D5.wav");
    expect(low.chunks.sampler?.unityNote).toBe(50);
    expect(high.chunks.sampler?.unityNote).toBe(74);
    expect(Math.abs(rootPitch(analyzePitch(low.pcm.slice(SR / 2, SR), SR))!.midi - 50)).toBeLessThan(0.3);
    expect(Math.abs(rootPitch(analyzePitch(high.pcm.slice(SR / 2, SR), SR))!.midi - 74)).toBeLessThan(0.3);
    expect(low.chunks.sampler?.loop).toBeDefined();
    const sfz = new TextDecoder().decode(list.find((e) => e.name === "ore/ore.sfz")!.data);
    expect(sfz).toContain("sample=ore_D4.wav pitch_keycenter=62");
  });

  it("batch: every cut's file plus settings.json in one zip", async () => {
    const { source, cut, credit, analysis } = setup();
    const second: CutSettings = { ...cut, name: "区間 2", note: 65 };
    const settings = { ...DEFAULT_EXPORT, format: "single" as const };
    const json = serializeSettings({ material: { name: "ore", durationSec: analysis.durationSec, sampleRate: SR, channels: 1 }, export: settings, credit, cuts: [cut, second], currentCut: 0, corrections: [] });
    const built = await buildBatch(
      [
        { baseName: "ore_区間 1", source, cut, settings, credit },
        { baseName: "ore_区間 2", source, cut: second, settings, credit },
      ],
      json,
      "ore",
    );
    expect(built.fileName).toBe("ore_cuts.zip");
    const names = listZip(new Uint8Array(await built.blob.arrayBuffer())).map((e) => e.name);
    expect(names).toEqual(["ore_区間 1_D4_2beat@120.wav", "ore_区間 2_F4_2beat@120.wav", "settings.json"]);
  });
});

describe("settings file", () => {
  it("round-trips, fills gaps from the defaults and rejects other files", () => {
    const { cut, credit, analysis } = setup();
    const corrections = [{ start: 0.1, end: 0.2, kind: "octave-down" as const }];
    const json = serializeSettings({ material: { name: "ore.mp4", durationSec: analysis.durationSec, sampleRate: SR, channels: 1 }, export: { ...DEFAULT_EXPORT, bpm: 165, format: "loop" }, credit, cuts: [cut], currentCut: 0, corrections });
    const back = parseSettings(json);
    expect(back.material.name).toBe("ore.mp4");
    expect(back.export.bpm).toBe(165);
    expect(back.export.format).toBe("loop");
    expect(back.corrections).toEqual(corrections);
    expect(back.cuts[0].params.wavetableCycles).toBe(1);
    expect(back.cuts[0].markers).toEqual(cut.markers);
    expect(back.cuts[0].params.flatten).toBe(1);
    expect(back.credit.url).toBe("https://example.com/sm1");

    const sparse = parseSettings(JSON.stringify({ app: "MADDAW", version: 1, cuts: [{ markers: { rangeStart: 0, rangeEnd: 1, sustainStart: 0.3, sustainEnd: 0.6 }, params: { flatten: 2 } }], corrections: [{ start: 1, end: 0.5, kind: "voiced" }, { start: 0, end: 1, kind: "nonsense" }, "x"] }));
    expect(sparse.corrections).toEqual([]); // every one of those is malformed
    expect(sparse.cuts[0].name).toBe("区間 1");
    expect(sparse.cuts[0].params.flatten).toBe(1);
    expect(sparse.cuts[0].params.wobble.micro).toBe(true);
    expect(sparse.export.beats).toBe(2);

    expect(() => parseSettings(JSON.stringify({ hello: 1 }))).toThrow();
    expect(() => parseSettings("not json")).toThrow();
  });
});

describe("suggestMarkersWithin", () => {
  it("stays inside the window and offsets the suggestion", () => {
    const { analysis } = setup();
    const from = 0.3;
    const to = 0.7;
    const m = suggestMarkersWithin(analysis.track, from, to);
    expect(m.rangeStart).toBeGreaterThanOrEqual(from);
    expect(m.rangeEnd).toBeLessThanOrEqual(to);
    expect(m.sustainStart).toBeGreaterThanOrEqual(m.rangeStart);
    expect(m.sustainEnd).toBeGreaterThan(m.sustainStart);
    expect(m.sustainEnd).toBeLessThanOrEqual(m.rangeEnd);
  });
});

describe("buildKit", () => {
  it("puts every sample on its own key from the first key up, as one-shots, with unique file names", async () => {
    const { source, cut, credit } = setup();
    const drum = { ...cut, params: PRESETS.find((p) => p.id === "drum")!.apply(cut.params) };
    const inputs = [
      { baseName: "kick", source, cut: drum, settings: DEFAULT_EXPORT, credit },
      { baseName: "kick", source, cut: drum, settings: DEFAULT_EXPORT, credit }, // a duplicate name
      { baseName: "voice", source, cut, settings: DEFAULT_EXPORT, credit }, // kept pitched (the user set it up)
    ];
    const built = await buildKit(inputs, "my kit", 36);
    expect(built.fileName).toBe("my kit.zip");
    const list = listZip(new Uint8Array(await built.blob.arrayBuffer()));
    const names = list.map((e) => e.name);
    expect(names).toEqual(["my kit/samples/kick.wav", "my kit/samples/kick_2.wav", "my kit/samples/voice.wav", "my kit/my kit.sfz", "my kit/my kit.dspreset", "my kit/README.txt"]);
    const sfz = new TextDecoder().decode(list[3].data);
    expect(sfz).toContain("sample=kick.wav pitch_keycenter=36 lokey=36 hikey=36 loop_mode=one_shot");
    expect(sfz).toContain("sample=kick_2.wav pitch_keycenter=37 lokey=37 hikey=37 loop_mode=one_shot");
    expect(sfz).toContain("sample=voice.wav pitch_keycenter=38 lokey=38 hikey=38 loop_mode=no_loop");
    expect(sfz).toContain("ampeg_release=1.500");
    const ds = new TextDecoder().decode(list[4].data);
    expect(ds).toContain(`rootNote="36" loNote="36" hiNote="36"`);
    expect(readWavChunks(list[0].data.buffer.slice(list[0].data.byteOffset, list[0].data.byteOffset + list[0].data.byteLength) as ArrayBuffer).sampler?.unityNote).toBe(36);
    expect(new TextDecoder().decode(list[5].data)).toContain("C2 = kick.wav");
  });
});
