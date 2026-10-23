// 16-bit PCM WAV, mono or multichannel — what the app writes out. An
// optional LIST/INFO chunk carries the credit (作品名 etc.), which samplers
// and editors that read INFO tags show.

/** INFO tags: 4-character ids (INAM = name, IART = artist/source, ICMT = comment, ISFT = software). */
export type WavInfo = Partial<Record<"INAM" | "IART" | "ICMT" | "ISFT" | "ICOP", string>>;

export function encodeWav(channels: readonly Float32Array[], sampleRate: number, info?: WavInfo): Blob {
  const count = channels.length;
  const frames = channels[0]?.length ?? 0;
  const dataBytes = frames * count * 2;
  const list = encodeInfo(info);
  const buffer = new ArrayBuffer(44 + dataBytes + (dataBytes & 1) + list.byteLength);
  const view = new DataView(buffer);
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, count, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * count * 2, true);
  view.setUint16(32, count * 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, dataBytes, true);
  let at = 44;
  for (let n = 0; n < frames; n++) {
    for (let c = 0; c < count; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][n]));
      view.setInt16(at, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      at += 2;
    }
  }
  at += dataBytes & 1; // chunks start on even bytes
  new Uint8Array(buffer, at).set(new Uint8Array(list));
  return new Blob([buffer], { type: "audio/wav" });
}

/** A LIST chunk of type INFO with the given tags (UTF-8, NUL-terminated, even-padded); empty when there are none. */
function encodeInfo(info?: WavInfo): ArrayBuffer {
  const entries = Object.entries(info ?? {}).filter(([, value]) => value && value.trim() !== "") as [string, string][];
  if (entries.length === 0) return new ArrayBuffer(0);
  const encoder = new TextEncoder();
  const encoded = entries.map(([id, value]) => [id, encoder.encode(value)] as const);
  let size = 4; // "INFO"
  for (const [, bytes] of encoded) size += 8 + bytes.length + 1 + ((bytes.length + 1) & 1);
  const buffer = new ArrayBuffer(8 + size);
  const view = new DataView(buffer);
  const out = new Uint8Array(buffer);
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i));
  };
  text(0, "LIST");
  view.setUint32(4, size, true);
  text(8, "INFO");
  let at = 12;
  for (const [id, bytes] of encoded) {
    text(at, id);
    view.setUint32(at + 4, bytes.length + 1, true);
    out.set(bytes, at + 8);
    at += 8 + bytes.length + 1 + ((bytes.length + 1) & 1);
  }
  return buffer;
}

/** Reads the INFO tags back out of a WAV (for tests and for showing a file's credit). */
export function readWavInfo(bytes: ArrayBuffer): WavInfo {
  const view = new DataView(bytes);
  const tag = (at: number) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
  const info: WavInfo = {};
  let at = 12;
  while (at + 8 <= bytes.byteLength) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    if (id === "LIST" && tag(at + 8) === "INFO") {
      let p = at + 12;
      const end = at + 8 + size;
      const decoder = new TextDecoder();
      while (p + 8 <= end) {
        const key = tag(p) as keyof WavInfo;
        const length = view.getUint32(p + 4, true);
        let text = decoder.decode(new Uint8Array(bytes, p + 8, length));
        text = text.replace(/\0+$/, "");
        info[key] = text;
        p += 8 + length + (length & 1);
      }
    }
    at += 8 + size + (size & 1);
  }
  return info;
}
