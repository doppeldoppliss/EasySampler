// A picture of the note (tools/eval): a spectrogram with the detected pitch
// drawn over it, the waveform and the level underneath — written as a PNG
// without any library (zlib from Node, the CRC from the zip writer).

import { deflateSync } from "node:zlib";
import { analyzePitch } from "../../src/analysis/pyin";
import { midiToHz } from "../../src/analysis/pitch";
import { crc32 } from "../../src/export/zip";
import { envelope, fft } from "./metrics";

class Image {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 3);
  }
  set(x: number, y: number, r: number, g: number, b: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 3;
    this.data[i] = r;
    this.data[i + 1] = g;
    this.data[i + 2] = b;
  }
  rect(x0: number, y0: number, w: number, h: number, r: number, g: number, b: number): void {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.set(x, y, r, g, b);
  }
  line(x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number): void {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    for (let s = 0; s <= steps; s++) this.set(Math.round(x0 + ((x1 - x0) * s) / steps), Math.round(y0 + ((y1 - y0) * s) / steps), r, g, b);
  }
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  out.set([...type].map((c) => c.charCodeAt(0)), 4);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

export function encodePng(image: Image): Uint8Array {
  const { width, height, data } = image;
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // filter: none
    raw.set(data.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  }
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** dB → a warm colour ramp (black → purple → orange → white). */
function heat(t: number): [number, number, number] {
  const c = Math.max(0, Math.min(1, t));
  const stops: [number, [number, number, number]][] = [
    [0, [8, 6, 20]],
    [0.3, [80, 20, 110]],
    [0.6, [210, 70, 40]],
    [0.85, [250, 190, 60]],
    [1, [255, 255, 240]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (c <= stops[i][0]) {
      const [a, ca] = stops[i - 1];
      const [b, cb] = stops[i];
      const u = (c - a) / (b - a);
      return [Math.round(ca[0] + (cb[0] - ca[0]) * u), Math.round(ca[1] + (cb[1] - ca[1]) * u), Math.round(ca[2] + (cb[2] - ca[2]) * u)];
    }
  }
  return [255, 255, 240];
}

export interface PictureOptions {
  targetMidi?: number;
  /** Marks in output seconds (head end, hold end …) drawn as vertical lines. */
  marks?: { sec: number; label?: string }[];
}

/** The spectrogram (log frequency 60 Hz – Nyquist, 70 dB range) with the pitch track, then the waveform, then the level. */
export function picture(x: Float32Array, sampleRate: number, options: PictureOptions = {}): Uint8Array {
  const width = Math.max(400, Math.min(1600, Math.round((x.length / sampleRate) * 500)));
  const specH = 360;
  const waveH = 90;
  const envH = 60;
  const image = new Image(width, specH + waveH + envH + 3);
  const n = 2048;
  const hopSec = x.length / sampleRate / width;
  const fmin = 60;
  const fmax = sampleRate / 2;
  const yOf = (hz: number) => specH - 1 - Math.round(((Math.log(Math.max(fmin, hz)) - Math.log(fmin)) / (Math.log(fmax) - Math.log(fmin))) * (specH - 1));
  // Spectrogram column by column.
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  let globalMax = 1e-9;
  const columns: Float32Array[] = [];
  for (let col = 0; col < width; col++) {
    const from = Math.round(col * hopSec * sampleRate) - n / 2;
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < n; i++) re[i] = (x[from + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
    fft(re, im);
    const mag = new Float32Array(n / 2 + 1);
    for (let k = 0; k <= n / 2; k++) {
      mag[k] = Math.hypot(re[k], im[k]);
      if (mag[k] > globalMax) globalMax = mag[k];
    }
    columns.push(mag);
  }
  const range = 70;
  for (let col = 0; col < width; col++) {
    const mag = columns[col];
    // Each pixel row: the strongest bin that maps to it.
    const rowMax = new Float32Array(specH);
    for (let k = 1; k <= n / 2; k++) {
      const y = yOf((k * sampleRate) / n);
      if (y >= 0 && y < specH && mag[k] > rowMax[y]) rowMax[y] = mag[k];
    }
    let last = 0;
    for (let y = specH - 1; y >= 0; y--) {
      if (rowMax[y] > 0) last = rowMax[y];
      const db = 20 * Math.log10(last / globalMax + 1e-12);
      const [r, g, b] = heat((db + range) / range);
      image.set(col, y, r, g, b);
    }
  }
  // Octave grid lines and the target.
  for (let midi = 24; midi <= 108; midi += 12) {
    const y = yOf(midiToHz(midi));
    for (let col = 0; col < width; col += 3) image.set(col, y, 90, 90, 110);
  }
  if (options.targetMidi !== undefined) {
    const y = yOf(midiToHz(options.targetMidi));
    for (let col = 0; col < width; col++) image.set(col, y, 80, 200, 255);
  }
  // The detected pitch (white, 2 px) with its harmonics' positions implied by the grid.
  const track = analyzePitch(x, sampleRate);
  for (let i = 0; i < track.f0.length; i++) {
    const f = track.f0[i];
    if (!Number.isFinite(f) || track.voicedProb[i] < 0.5) continue;
    const col = Math.round((i * track.hopSec) / hopSec);
    const y = yOf(midiToHz(f));
    image.set(col, y, 255, 255, 255);
    image.set(col, y - 1, 255, 255, 255);
  }
  // Waveform lane.
  const waveTop = specH + 1;
  image.rect(0, specH, width, 1, 60, 60, 70);
  image.rect(0, waveTop, width, waveH, 24, 24, 30);
  const mid = waveTop + waveH / 2;
  for (let col = 0; col < width; col++) {
    const a = Math.round(col * hopSec * sampleRate);
    const b = Math.round((col + 1) * hopSec * sampleRate);
    let lo = 0;
    let hi = 0;
    for (let i = a; i < b && i < x.length; i++) {
      if (x[i] < lo) lo = x[i];
      if (x[i] > hi) hi = x[i];
    }
    image.line(col, mid - hi * (waveH / 2 - 2), col, mid - lo * (waveH / 2 - 2), 150, 190, 230);
  }
  // Level lane (RMS, 0 … peak).
  const envTop = waveTop + waveH + 1;
  image.rect(0, waveTop + waveH, width, 1, 60, 60, 70);
  image.rect(0, envTop, width, envH, 24, 24, 30);
  const env = envelope(x, sampleRate, 0.01, 0.002);
  const envMax = Math.max(1e-9, ...env.values);
  for (let col = 0; col < width; col++) {
    const i = Math.min(env.values.length - 1, Math.floor((col * hopSec) / env.hopSec));
    const h = Math.round((env.values[i] / envMax) * (envH - 4));
    image.line(col, envTop + envH - 2, col, envTop + envH - 2 - h, 120, 220, 160);
  }
  // Time ticks every 0.1 s (longer every 0.5 s) along the bottom of the spectrogram, and the marks.
  for (let t = 0; t < x.length / sampleRate; t += 0.1) {
    const col = Math.round(t / hopSec);
    const long = Math.round(t * 10) % 5 === 0;
    image.rect(col, specH - (long ? 12 : 6), 1, long ? 12 : 6, 230, 230, 230);
  }
  for (const m of options.marks ?? []) {
    const col = Math.round(m.sec / hopSec);
    for (let y = 0; y < image.height; y += 2) image.set(col, y, 255, 120, 200);
  }
  return encodePng(image);
}
