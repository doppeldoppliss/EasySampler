import { describe, expect, it } from "vitest";
import { encodeWav, readWavInfo } from "./wav";

describe("encodeWav", () => {
  it("writes a 16-bit PCM header and the samples", async () => {
    const blob = encodeWav([new Float32Array([0, 0.5, -0.5, 1])], 44100);
    const bytes = new DataView(await blob.arrayBuffer());
    expect(bytes.byteLength).toBe(44 + 8);
    expect(String.fromCharCode(bytes.getUint8(0), bytes.getUint8(1), bytes.getUint8(2), bytes.getUint8(3))).toBe("RIFF");
    expect(bytes.getUint32(4, true)).toBe(44 + 8 - 8);
    expect(bytes.getUint16(22, true)).toBe(1);
    expect(bytes.getUint32(24, true)).toBe(44100);
    expect(bytes.getInt16(44 + 2, true)).toBe(Math.floor(0.5 * 0x7fff));
    expect(bytes.getInt16(44 + 4, true)).toBe(-0x4000);
  });

  it("interleaves stereo", async () => {
    const blob = encodeWav([new Float32Array([0.25, 0.25]), new Float32Array([-0.25, -0.25])], 48000);
    const bytes = new DataView(await blob.arrayBuffer());
    expect(bytes.getUint16(22, true)).toBe(2);
    expect(bytes.getInt16(44, true)).toBeGreaterThan(0);
    expect(bytes.getInt16(46, true)).toBeLessThan(0);
  });

  it("carries the credit in a LIST/INFO chunk that reads back, with Japanese text and odd lengths", async () => {
    const info = { INAM: "デモ素材(合成音声「さー」)", IART: "https://example.com/watch/sm1", ICMT: "abc", ISFT: "MADDAW" };
    const blob = encodeWav([new Float32Array([0, 0.1, 0.2])], 44100, info);
    const bytes = await blob.arrayBuffer();
    expect(bytes.byteLength % 2).toBe(0);
    expect(new DataView(bytes).getUint32(4, true)).toBe(bytes.byteLength - 8);
    expect(readWavInfo(bytes)).toEqual(info);
  });

  it("writes no LIST chunk when the credit is empty", async () => {
    const blob = encodeWav([new Float32Array([0, 0])], 44100, { INAM: "", ICMT: "  " });
    expect((await blob.arrayBuffer()).byteLength).toBe(44 + 4);
  });
});
