// Rendering the file (design.md 4–5): one note, played by the same Engine
// the keyboard uses, straight into a buffer — no AudioContext, no real-time
// constraint, and exactly what the user heard when trying it. The Engine's
// random walk is seeded, so the same settings give the same file.

import { Engine, type PreparedSource } from "../engine/engine";
import { FxChain } from "../fx/chain";
import { outputLayout } from "../instrument/layout";
import type { ExportSettings, InstrumentParams, Markers } from "../instrument/types";

export interface Rendered {
  channels: Float32Array[];
  sampleRate: number;
  /** Where the head (played once, unstretched) ends and the sustain begins, in seconds of output. */
  headSec: number;
  /** When the note was released (seconds of output); the file runs on through the release / tail. */
  holdEndSec: number;
}

const BLOCK = 128;
/** A one-shot (nothing is stretched) may run this long before it's cut off. */
const MAX_ONESHOT_SEC = 30;
/** After the release, the voice gets this long to finish (a tail, a long release). */
const MAX_AFTER_SEC = 8;
/** Anything above this peak is scaled down (never clipped). */
const PEAK = 0.98;
/** Trailing samples below this level are cut off, keeping a short margin. */
const SILENCE = 1e-4;
const MARGIN_SEC = 0.005;
/** Room left after the voice for the effects to ring out (chorus, filter, limiter release). */
const FX_TAIL_SEC = 0.15;

/**
 * Plays `note` for `holdSec` (the hold ends `release` early so the file is
 * about `holdSec` long when the tail is off) and renders until the voice
 * has finished. A one-shot instrument (sustain "none") ignores `holdSec`
 * and plays the material out. `bpm` is what a tail limited to a beat or a
 * bar is measured in.
 */
export function renderNote(source: PreparedSource, markers: Markers, params: InstrumentParams, note: number, holdSec: number, bpm = 120): Rendered {
  const rate = source.sampleRate;
  const engine = new Engine(rate);
  engine.setTempo(bpm);
  engine.setSource(source);
  engine.setInstrument(markers, { ...params, maxVoices: 1 });
  engine.setHold(holdSec);
  // Nothing to hold: a one-shot, or the sustain switched off.
  const oneShot = params.sustainMode === "none" || !params.sustainEnabled;
  // Without a tail the hold ends early by the release (or the longer 終わりのフェード), so the file is about `holdSec`.
  const releaseSec = Math.max(params.amp.release, params.amp.fadeOut);
  const releaseAt = oneShot ? Infinity : Math.max(0, holdSec - (params.tail.enabled ? 0 : releaseSec)) * rate;
  const limit = Math.ceil((oneShot ? MAX_ONESHOT_SEC : holdSec + MAX_AFTER_SEC) * rate);
  const fx = new FxChain(rate);
  fx.set(params.fx);
  fx.setTempo(bpm);
  // A mono material still comes out in stereo when the effects spread it.
  const stereo = source.channels.length > 1 || (fx.active && FxChain.makesStereo(params.fx));

  let left = new Float32Array(Math.ceil(Math.min(limit, (oneShot ? 2 : holdSec + 0.5) * rate)));
  let right = stereo ? new Float32Array(left.length) : left;
  const blockL = new Float32Array(BLOCK);
  const blockR = new Float32Array(BLOCK);
  engine.noteOn(note, 1);
  let released = false;
  let at = 0;
  while (at < limit && engine.activeVoices() > 0) {
    if (!released && at + BLOCK > releaseAt) {
      engine.noteOff(note);
      released = true;
    }
    engine.render(blockL, blockR);
    if (at + BLOCK > left.length) {
      left = grow(left, at + BLOCK);
      right = stereo ? grow(right, at + BLOCK) : left;
    }
    left.set(blockL, at);
    if (stereo) right.set(blockR, at);
    at += BLOCK;
  }

  // The effects, over the whole note (their LFOs start with it), shifted back by the limiter's look-ahead.
  if (fx.active) {
    const pad = Math.round(FX_TAIL_SEC * rate) + fx.latency;
    if (at + pad > left.length) {
      left = grow(left, at + pad);
      right = stereo ? grow(right, at + pad) : left;
    }
    left.fill(0, at, at + pad);
    if (stereo) right.fill(0, at, at + pad);
    fx.process(left, right, at + pad);
    const latency = fx.latency;
    left.copyWithin(0, latency, at + pad);
    if (stereo) right.copyWithin(0, latency, at + pad);
    at += pad - latency;
  }

  // Cut the trailing silence, scale down if anything would clip.
  const channels = stereo ? [left, right] : [left];
  let end = 0;
  let peak = 0;
  for (const channel of channels) {
    for (let i = 0; i < at; i++) {
      const v = Math.abs(channel[i]);
      if (v > SILENCE && i > end) end = i;
      if (v > peak) peak = v;
    }
  }
  const length = Math.min(at, end + 1 + Math.round(MARGIN_SEC * rate));
  const gain = peak > PEAK ? PEAK / peak : 1;
  // In preserve-length mode the head plays at its own speed (× its stretch); resampling also scales it with the pitch.
  const headSpeed = params.pitchMode === "resample" ? 2 ** ((note - params.root) / 12) : 1;
  const headSec = outputLayout(markers, params, holdSec).headSec / headSpeed;
  return {
    sampleRate: rate,
    headSec,
    holdEndSec: Math.min(length, released ? releaseAt : at) / rate,
    channels: channels.map((channel) => {
      const out = channel.slice(0, length);
      if (gain !== 1) for (let i = 0; i < out.length; i++) out[i] *= gain;
      return out;
    }),
  };
}

function grow(x: Float32Array, atLeast: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(Math.max(atLeast, x.length * 2));
  out.set(x);
  return out;
}

const NOTE_NAMES = ["C", "Cs", "D", "Ds", "E", "F", "Fs", "G", "Gs", "A", "As", "B"];

/** "Cs4" — a note name safe in file names (no '#'). */
export function fileNoteName(midi: number): string {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

/** A file's name without its extension ("take.1.wav" → "take.1"). */
export function stripExtension(fileName: string): string {
  return fileName.replace(/\.[A-Za-z0-9]{1,5}$/, "");
}

/** A name safe for every file system (characters, Windows' reserved names, trailing dots); falls back to "material". */
export function safeBaseName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/, "")
    .trim();
  if (!cleaned) return "material";
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned) ? `${cleaned}_` : cleaned;
}

/** `ore_C4_2beat@165.wav` — the material's name, the note, and how long. */
export function exportFileName(baseName: string, note: number, settings: ExportSettings, oneShot: boolean): string {
  const length = oneShot ? "" : settings.lengthMode === "beats" ? `_${trimNumber(settings.beats)}beat@${trimNumber(settings.bpm)}` : `_${trimNumber(settings.seconds)}s`;
  return `${safeBaseName(baseName)}_${fileNoteName(note)}${length}.wav`;
}

function trimNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}
