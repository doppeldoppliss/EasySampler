// 16-bit PCM WAV, mono or multichannel — what the app writes out. Optional
// chunks: LIST/INFO with the credit (作品名 etc.), which samplers and editors
// that read INFO tags show, and `smpl` with the root note and a loop, which
// samplers read to hold a note indefinitely.

/** INFO tags: 4-character ids (INAM = name, IART = artist/source, ICMT = comment, ISFT = software). */
export type WavInfo = Partial<Record<"INAM" | "IART" | "ICMT" | "ISFT" | "ICOP", string>>;

export interface WavSampler {
  /** MIDI note the file plays at its own pitch. */
  unityNote: number;
  /** Loop in sample frames: [start, end) — `end` is the first frame after the loop. */
  loop?: { start: number; end: number };
}

export interface WavExtras {
  /** A wavetable's frame size: written as the `clm ` chunk Serum and Vital read (Vital then steps through the frames as cut, instead of morphing between the first and the last). */
  wavetableFrame?: number;
}

export function encodeWav(channels: readonly Float32Array[], sampleRate: number, info?: WavInfo, sampler?: WavSampler, extras?: WavExtras): Blob {
  return new Blob([encodeWavBytes(channels, sampleRate, info, sampler, extras)], { type: "audio/wav" });
}

export function encodeWavBytes(channels: readonly Float32Array[], sampleRate: number, info?: WavInfo, sampler?: WavSampler, extras?: WavExtras): ArrayBuffer {
  const count = channels.length;
  const frames = channels[0]?.length ?? 0;
  const dataBytes = frames * count * 2;
  const list = encodeInfo(info);
  const smpl = encodeSampler(sampler, sampleRate);
  const clm = encodeClm(extras?.wavetableFrame);
  const buffer = new ArrayBuffer(44 + clm.byteLength + dataBytes + (dataBytes & 1) + list.byteLength + smpl.byteLength);
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
  // (the wavetable chunk sits before the data, where Serum puts it)
  new Uint8Array(buffer, 36).set(new Uint8Array(clm));
  const dataAt = 36 + clm.byteLength;
  text(dataAt, "data");
  view.setUint32(dataAt + 4, dataBytes, true);
  let at = dataAt + 8;
  for (let n = 0; n < frames; n++) {
    for (let c = 0; c < count; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][n]));
      view.setInt16(at, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      at += 2;
    }
  }
  at += dataBytes & 1; // chunks start on even bytes
  new Uint8Array(buffer, at).set(new Uint8Array(smpl));
  at += smpl.byteLength;
  new Uint8Array(buffer, at).set(new Uint8Array(list));
  return buffer;
}

/** The `clm ` chunk: Serum's wavetable tag, "<!>2048 00000000 wavetable (…)". The 2nd field's first digit is
 *  how Vital treats the frames (0 = each 2048-sample block is a frame, no interpolation). Even-sized: Vital's chunk
 *  walker does not pad, so an odd chunk would throw every chunk after it off. */
function encodeClm(frameSize?: number): ArrayBuffer {
  if (!frameSize) return new ArrayBuffer(0);
  let tag = `<!>${frameSize} 00000000 wavetable (MADDAW)`;
  if (tag.length & 1) tag += " ";
  const buffer = new ArrayBuffer(8 + tag.length);
  const view = new DataView(buffer);
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i));
  };
  text(0, "clm ");
  view.setUint32(4, tag.length, true);
  text(8, tag);
  return buffer;
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

/** The `smpl` chunk: unity note and, when given, one forward loop that plays forever. */
function encodeSampler(sampler: WavSampler | undefined, sampleRate: number): ArrayBuffer {
  if (!sampler) return new ArrayBuffer(0);
  const loops = sampler.loop ? 1 : 0;
  const size = 36 + 24 * loops;
  const buffer = new ArrayBuffer(8 + size);
  const view = new DataView(buffer);
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i));
  };
  text(0, "smpl");
  view.setUint32(4, size, true);
  view.setUint32(8, 0, true); // manufacturer
  view.setUint32(12, 0, true); // product
  view.setUint32(16, Math.round(1e9 / sampleRate), true); // sample period (ns)
  view.setUint32(20, Math.max(0, Math.min(127, Math.round(sampler.unityNote))), true);
  view.setUint32(24, 0, true); // pitch fraction
  view.setUint32(28, 0, true); // SMPTE format
  view.setUint32(32, 0, true); // SMPTE offset
  view.setUint32(36, loops, true);
  view.setUint32(40, 0, true); // sampler data
  if (sampler.loop) {
    view.setUint32(44, 0, true); // cue point id
    view.setUint32(48, 0, true); // forward
    view.setUint32(52, sampler.loop.start, true);
    view.setUint32(56, Math.max(sampler.loop.start, sampler.loop.end - 1), true); // last frame of the loop (inclusive)
    view.setUint32(60, 0, true); // fraction
    view.setUint32(64, 0, true); // play count: forever
  }
  return buffer;
}

/** Reads the INFO tags and the sampler chunk back out of a WAV (for tests and for showing a file's credit). */
export function readWavChunks(bytes: ArrayBuffer): { info: WavInfo; sampler?: WavSampler; clm?: string; frames: number; channels: number; sampleRate: number } {
  const view = new DataView(bytes);
  const tag = (at: number) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
  const info: WavInfo = {};
  let sampler: WavSampler | undefined;
  let clm: string | undefined;
  let frames = 0;
  let channels = 1;
  let sampleRate = 0;
  let at = 12;
  while (at + 8 <= bytes.byteLength) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    if (id === "fmt ") {
      channels = view.getUint16(at + 10, true);
      sampleRate = view.getUint32(at + 12, true);
    } else if (id === "data") {
      frames = size / (channels * 2);
    } else if (id === "clm ") {
      clm = new TextDecoder().decode(new Uint8Array(bytes, at + 8, size)).trim();
    } else if (id === "smpl") {
      sampler = { unityNote: view.getUint32(at + 20, true) };
      if (view.getUint32(at + 36, true) > 0) sampler.loop = { start: view.getUint32(at + 52, true), end: view.getUint32(at + 56, true) + 1 };
    } else if (id === "LIST" && tag(at + 8) === "INFO") {
      let p = at + 12;
      const end = at + 8 + size;
      const decoder = new TextDecoder();
      while (p + 8 <= end) {
        const key = tag(p) as keyof WavInfo;
        const length = view.getUint32(p + 4, true);
        info[key] = decoder.decode(new Uint8Array(bytes, p + 8, length)).replace(/\0+$/, "");
        p += 8 + length + (length & 1);
      }
    }
    at += 8 + size + (size & 1);
  }
  return { info, sampler, clm, frames, channels, sampleRate };
}

export function readWavInfo(bytes: ArrayBuffer): WavInfo {
  return readWavChunks(bytes).info;
}
