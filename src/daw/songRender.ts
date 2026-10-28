// The song as a file (design.md 13, phase 3): the same mixer and sounds the
// page plays through, run offline over the whole song, then the master
// effects. What you hear is what is written.

import type { PreparedSource } from "../engine/engine";
import { FxChain } from "../fx/chain";
import type { FxSettings, InstrumentParams, Markers } from "../instrument/types";
import type { SeqNote } from "../song/parts";
import { SongPlayer, type PlayerTrack, type TrackSound } from "../song/player";
import { BackingSound, EngineSound, SampleSound } from "../song/sounds";

export interface RenderInstrument {
  source: PreparedSource;
  markers: Markers;
  params: InstrumentParams;
  /** The note length a "stretch" sustain fills (the material's export length). */
  hold: number;
}

export interface RenderTrack {
  id: string;
  /** A melodic track's cut, or null for a drum track (or one that plays nothing). */
  instrument: RenderInstrument | null;
  /** A drum track's rows: the one-shot each plays. */
  samples?: (Float32Array[] | null)[];
  /** A drum track: the GM key of each row on the plain drum sound (null where a one-shot plays). */
  drumKeys?: (number | null)[];
  /** A track on the plain backing synth (簡易シンセ). */
  backing?: boolean;
  notes: SeqNote[];
  /** Portamento (seconds; 0 or absent = off). */
  glide?: number;
  /** 語尾を収める: the tail ends where the note does. */
  tailFit?: boolean;
  fx: FxSettings | null;
  gain: number;
  pan: number;
  mute: boolean;
  solo: boolean;
}

export interface SongRenderInput {
  sampleRate: number;
  bpm: number;
  tracks: RenderTrack[];
  masterFx: FxSettings | null;
  /**
   * Only this stretch of the output, exactly (no ring-out, no silence trimmed): for a loop, the notes are
   * given twice and the second pass is kept, so what rings past the loop's end is heard at its start.
   */
  window?: { fromSec: number; lengthSec: number };
}

export interface RenderedSong {
  channels: [Float32Array, Float32Array];
  sampleRate: number;
  /** Gain applied to keep the mix under full scale (1 = none). */
  gain: number;
}

const BLOCK = 128;
/** After the last note: how long the voices may ring on at most, and the effects' tails after that. */
const MAX_RING_SEC = 10;
const FX_TAIL_SEC = 1.5;
/** Blocks between progress reports (about 3 s of audio at 48 kHz). */
const REPORT_EVERY = 1024;

/** Renders the song from its start to where everything has died away. `progress` (0–1) may yield to the screen. */
export async function renderSong(input: SongRenderInput, progress?: (share: number) => Promise<void>): Promise<RenderedSong> {
  const sr = input.sampleRate;
  const sounds: TrackSound[] = [];
  const tracks: PlayerTrack[] = [];
  for (const t of input.tracks) {
    let sound: TrackSound | null = null;
    if (t.samples) {
      const s = new SampleSound(sr);
      s.rows = t.samples;
      s.keys = t.drumKeys ?? [];
      s.chokes = true;
      sound = s;
    } else if (t.backing) {
      sound = new BackingSound(sr);
    } else if (t.instrument) {
      const s = new EngineSound(sr);
      s.engine.setSource(t.instrument.source);
      s.engine.setInstrument(t.instrument.markers, t.instrument.params);
      s.engine.setHold(t.instrument.hold);
      s.engine.setTempo(input.bpm);
      s.setGlide(t.glide ?? 0);
      s.fitTail = t.tailFit === true;
      sound = s;
    }
    if (!sound) continue;
    sounds.push(sound);
    tracks.push({ id: t.id, sound, notes: t.notes, fx: t.fx, gain: t.gain, pan: t.pan, mute: t.mute, solo: t.solo });
  }
  const player = new SongPlayer(sr);
  player.setTracks(tracks);
  player.setTempo(input.bpm);
  player.play(0, 0);
  const master = new FxChain(sr);
  if (input.masterFx) master.set(input.masterFx);
  master.setTempo(input.bpm);
  const masterOn = input.masterFx !== null && master.active;
  const anyFx = masterOn || tracks.some((t) => t.fx !== null);
  // How long the effects may ring on after the sounds stop (a delay's repeats, a reverb's tail).
  const fxTail = Math.max(FX_TAIL_SEC, FxChain.tailSec(input.masterFx, input.bpm), ...input.tracks.map((t) => FxChain.tailSec(t.fx, input.bpm)));

  let lastEnd = 0;
  for (const t of tracks) for (const n of t.notes) lastEnd = Math.max(lastEnd, n.end);
  const win = input.window;
  const endFrame = win ? Math.round((win.fromSec + win.lengthSec) * sr) : Math.ceil(lastEnd * sr);
  const hardEnd = win ? endFrame : endFrame + Math.ceil(MAX_RING_SEC * sr);
  let left = new Float32Array(endFrame + sr * 2);
  let right = new Float32Array(left.length);
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  let at = 0;
  let quietSince = -1;
  for (let block = 0; at < hardEnd; block++) {
    player.render(at, l, r, BLOCK);
    if (masterOn) master.process(l, r, BLOCK);
    if (at + BLOCK > left.length) {
      const grow = (x: Float32Array) => {
        const y = new Float32Array(Math.max(at + BLOCK, Math.ceil(x.length * 1.5)));
        y.set(x);
        return y;
      };
      left = grow(left);
      right = grow(right);
    }
    left.set(l, at);
    right.set(r, at);
    at += BLOCK;
    // Past the last note, once every sound is silent the effects get their tail, then it ends.
    if (!win && at >= endFrame) {
      if (quietSince < 0 && sounds.every((s) => s.idle())) quietSince = at;
      if (quietSince >= 0 && at - quietSince >= (anyFx ? fxTail : 0.05) * sr) break;
    }
    if (progress && block % REPORT_EVERY === REPORT_EVERY - 1) await progress(Math.min(1, at / Math.max(1, endFrame)));
  }

  // A window: exactly that stretch.
  if (win) {
    const from = Math.round(win.fromSec * sr);
    const length = Math.round(win.lengthSec * sr);
    left = left.slice(from, from + length);
    right = right.slice(from, from + length);
    at = left.length;
  }
  // The trailing silence goes; a mix over full scale is brought down as a whole.
  let end = 0;
  let peak = 0;
  for (let i = 0; i < at; i++) {
    const a = Math.max(Math.abs(left[i]), Math.abs(right[i]));
    if (a > 1e-4) end = i + 1;
    if (a > peak) peak = a;
  }
  end = win ? at : Math.min(at, end + Math.round(0.05 * sr));
  const gain = peak > 0.999 ? 0.98 / peak : 1;
  const outL = left.slice(0, end);
  const outR = right.slice(0, end);
  if (gain !== 1)
    for (let i = 0; i < end; i++) {
      outL[i] *= gain;
      outR[i] *= gain;
    }
  return { channels: [outL, outR], sampleRate: sr, gain };
}
