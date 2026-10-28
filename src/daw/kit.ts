// The drum kit (design.md 13.2): one per project, a sound per GM drum key.
// Drum sounds are not materials: no pitch analysis, no synthesis — each is a
// recording played once, as it is, when its key is struck (by the keyboard in
// the kit view, or by a drum track's notes, whose pitch is the GM key). A key
// with no sound of its own plays the plain drum sound (簡易ドラム), so a MIDI
// file's drums sound right away.

import { drumName } from "../song/parts";

export interface KitSlot {
  /** The GM drum key (35 = acoustic kick … 81). */
  key: number;
  /** The recording it plays (kept as audio:<id>), or null for the plain drum sound. */
  sample: string | null;
  /** What the sound is called (the file's name, or what it was cut from). */
  name: string;
  /** Linear volume (1 = as recorded). */
  gain: number;
  /** The part of the recording played (seconds from its start); end 0 = to its end. */
  start: number;
  end: number;
  /** Fade at the end (seconds). */
  fade: number;
}

export interface Kit {
  slots: KitSlot[];
}

/** The keys a kit shows first: the common GM drums, kick up. */
export const COMMON_KEYS = [36, 38, 42, 46, 39, 37, 49, 51, 45, 47, 50, 44, 54, 56, 57, 59];

/** Sounds that cut each other off (open / closed / pedal hi-hat). */
export const CHOKE_GROUPS: readonly (readonly number[])[] = [[42, 44, 46]];

export function emptyKit(): Kit {
  return { slots: [] };
}

export function slotFor(kit: Kit, key: number): KitSlot | undefined {
  return kit.slots.find((s) => s.key === key);
}

export function newSlot(key: number, sample: string | null, name: string): KitSlot {
  return { key, sample, name, gain: 1, start: 0, end: 0, fade: 0.01 };
}

const NAME_KEYS: [RegExp, number][] = [
  [/open.?h|o\.?h\.?h|ohh|hat.?open|オープン/i, 46],
  [/pedal|ペダル/i, 44],
  [/kick|bass.?drum|\bbd\b|キック|バスドラ/i, 36],
  [/snare|\bsd\b|snr|スネア/i, 38],
  [/clap|\bcp\b|クラップ|手拍子/i, 39],
  [/rim|side.?stick|リム/i, 37],
  [/h\.?h|hi.?hat|hat|chh|ハイハット|ハット/i, 42],
  [/crash|クラッシュ/i, 49],
  [/ride|ライド/i, 51],
  [/low.?tom|floor|ロータム/i, 45],
  [/hi.?tom|high.?tom|ハイタム/i, 50],
  [/tom|タム/i, 47],
  [/tamb|タンバリン/i, 54],
  [/cow|カウベル/i, 56],
  [/splash|スプラッシュ/i, 55],
  [/china|チャイナ/i, 52],
];

/** The key a sound is likely for, from its name (a file name): the named drum, or the next common key not taken. */
export function guessKey(name: string, taken: ReadonlySet<number>): number {
  for (const [pattern, key] of NAME_KEYS) if (pattern.test(name) && !taken.has(key)) return key;
  for (const [pattern, key] of NAME_KEYS) if (pattern.test(name)) return key;
  return COMMON_KEYS.find((k) => !taken.has(k)) ?? Math.min(81, 35 + taken.size);
}

/** A drum track's rows (GM keys, top to bottom): the core drums, the kit's keys, and the keys its notes use. */
export function drumRows(kit: Kit, notes: readonly { pitch: number }[]): number[] {
  const keys = new Set<number>([...COMMON_KEYS.slice(0, 7), ...kit.slots.map((s) => s.key), ...notes.map((n) => n.pitch)]);
  return [...keys].sort((a, b) => a - b);
}

/** A row's label: its GM name, and the sound on it. */
export function keyLabel(kit: Kit, key: number): string {
  const slot = slotFor(kit, key);
  return slot?.sample ? `${drumName(key)}: ${slot.name}` : `${drumName(key)}(簡易)`;
}

export function sanitizeKit(raw: unknown): Kit {
  const r = (raw && typeof raw === "object" ? raw : {}) as { slots?: unknown };
  if (!Array.isArray(r.slots)) return emptyKit();
  const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
  const seen = new Set<number>();
  const slots: KitSlot[] = [];
  for (const s of r.slots) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    const key = Math.round(num(o.key, -1, -1, 127));
    if (key < 0 || seen.has(key)) continue;
    seen.add(key);
    slots.push({
      key,
      sample: typeof o.sample === "string" ? o.sample : null,
      name: typeof o.name === "string" ? o.name : drumName(key),
      gain: num(o.gain, 1, 0, 4),
      start: num(o.start, 0, 0, 600),
      end: num(o.end, 0, 0, 600),
      fade: num(o.fade, 0.01, 0, 5),
    });
  }
  return { slots: slots.sort((a, b) => a.key - b.key) };
}

/**
 * A slot's sound as it plays: the recording's stretch from start to end,
 * resampled to the output rate, faded in over a hair (so a cut mid-wave does
 * not click), faded out over `fade`, at its volume.
 */
export function renderSlot(slot: KitSlot, channels: readonly Float32Array[], sampleRate: number, outRate: number, resample: (x: Float32Array, ratio: number) => Float32Array): Float32Array[] {
  const from = Math.min(channels[0].length, Math.max(0, Math.round(slot.start * sampleRate)));
  const to = slot.end > slot.start ? Math.min(channels[0].length, Math.round(slot.end * sampleRate)) : channels[0].length;
  return channels.map((ch) => {
    let x: Float32Array = ch.slice(from, Math.max(from + 1, to));
    if (sampleRate !== outRate) x = resample(x, outRate / sampleRate);
    const fadeIn = Math.min(x.length, Math.round(0.002 * outRate));
    const fadeOut = Math.min(x.length, Math.round(slot.fade * outRate));
    for (let i = 0; i < x.length; i++) {
      let g = slot.gain;
      if (i < fadeIn) g *= i / fadeIn;
      if (i >= x.length - fadeOut) g *= (x.length - i) / Math.max(1, fadeOut);
      x[i] *= g;
    }
    return x;
  });
}

/**
 * Where a hit begins (seconds): the first moment it rises above a small share
 * of its peak, a hair earlier so its attack is whole. 0 for silence.
 */
export function detectOnset(channels: readonly Float32Array[], sampleRate: number): number {
  const n = channels[0]?.length ?? 0;
  let peak = 0;
  for (const ch of channels) for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(ch[i]));
  if (peak < 1e-4) return 0;
  const threshold = Math.max(peak * 0.05, 1e-3);
  for (let i = 0; i < n; i++) {
    for (const ch of channels) {
      if (Math.abs(ch[i]) >= threshold) return Math.max(0, i - Math.round(0.002 * sampleRate)) / sampleRate;
    }
  }
  return 0;
}
