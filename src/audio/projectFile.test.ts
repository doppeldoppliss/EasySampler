import { describe, expect, it } from "vitest";
import { buildProjectFile, parseProjectFile } from "./projectFile";
import { remapMaterials } from "./projects";
import { zipStore } from "../export/zip";

describe("project file (.easysampler)", () => {
  it("brings back the song, the settings and the samples exactly", () => {
    const a = new Float32Array([0, 0.5, -0.25, 1e-7, -1]);
    const b = new Float32Array([0.125, -0.125]);
    const project = { bpm: 140, tracks: [{ instrument: "m1/c1", notes: [{ start: 0, length: 1, pitch: 60, velocity: 0.8 }] }], materials: [{ id: "m1", name: "声" }] };
    const bytes = buildProjectFile({
      name: "曲 A",
      project,
      materials: [
        { id: "m1", name: "声", sampleRate: 48000, channels: [a, a.map((x) => -x)], settings: '{"cuts":[]}' },
        { id: "m2", name: "ピアノ", sampleRate: 44100, channels: [b], settings: null },
      ],
    });
    const back = parseProjectFile(bytes);
    expect(back.name).toBe("曲 A");
    expect(back.project).toEqual(project);
    expect(back.materials.map((m) => [m.id, m.name, m.sampleRate, m.channels.length, m.settings])).toEqual([
      ["m1", "声", 48000, 2, '{"cuts":[]}'],
      ["m2", "ピアノ", 44100, 1, null],
    ]);
    expect([...back.materials[0].channels[0]]).toEqual([...a]);
    expect([...back.materials[0].channels[1]]).toEqual([...a.map((x) => -x)]);
    expect([...back.materials[1].channels[0]]).toEqual([...b]);
  });

  it("says plainly when a file is not a project", () => {
    expect(() => parseProjectFile(new Uint8Array([1, 2, 3]))).toThrow(/プロジェクトファイルではありません/);
    expect(() => parseProjectFile(zipStore([{ name: "other.txt", data: new Uint8Array([65]) }]))).toThrow(/easysampler.json/);
  });
});

describe("a project moved to new material ids (a copy, a file opened)", () => {
  it("renames the materials, the one edited, and every track's and drum row's cut", () => {
    const data = {
      materials: [{ id: "m1", name: "声" }, { id: "m2", name: "ピアノ" }],
      editing: "m2",
      tracks: [{ instrument: "m1/c1", pads: [] }, { instrument: "backing", pads: [] }, { instrument: null, pads: [{ instrument: "m2/k" }, { instrument: "backing", key: 36 }] }],
    };
    const out = remapMaterials(data, new Map([["m1", "x1"], ["m2", "x2"]])) as typeof data;
    expect(out.materials.map((m) => m.id)).toEqual(["x1", "x2"]);
    expect(out.editing).toBe("x2");
    expect(out.tracks.map((t) => t.instrument)).toEqual(["x1/c1", "backing", null]);
    expect(out.tracks[2].pads.map((p) => p.instrument)).toEqual(["x2/k", "backing"]);
    expect(data.materials[0].id).toBe("m1"); // the original is left as it was
  });
});
