// Playing a song inside the audio thread (or a test): the mixer of design.md
// 13.1. Each track has its own sound (an Engine playing one cut, or the plain
// backing), its own notes, effects, volume, pan, mute and solo. Note events
// land on their exact sample: a render block is split at every event, per
// track, and at the loop's end. The page says when (an AudioContext frame) and
// from where (song seconds).

import { FxChain } from "../fx/chain";
import type { FxSettings } from "../instrument/types";
import type { SeqNote } from "./parts";

/** What a track plays its notes on. `render` fills (does not add to) the buffers. */
export interface TrackSound {
  noteOn(note: number, velocity: number, drum: boolean): void;
  noteOff(note: number, drum: boolean): void;
  allOff(): void;
  render(left: Float32Array, right: Float32Array, frames: number): void;
  /** Nothing sounding (no voice still releasing). */
  idle(): boolean;
}

export interface MixSettings {
  /** Linear gain (1 = as is). */
  gain: number;
  /** −1 (left) … 1 (right). */
  pan: number;
  mute: boolean;
  solo: boolean;
  fx: FxSettings | null;
}

export interface PlayerTrack extends MixSettings {
  id: string;
  sound: TrackSound;
  notes: readonly SeqNote[];
}

interface SongEvent {
  /** Song seconds × sample rate. */
  frame: number;
  on: boolean;
  note: number;
  velocity: number;
  drum: boolean;
}

/** After this long with nothing sounding, a track's effects stop being run (their tails have died away). */
const IDLE_SKIP_SEC = 3;

class Lane {
  readonly id: string;
  sound: TrackSound;
  readonly fx: FxChain;
  mix: MixSettings;
  events: SongEvent[] = [];
  cursor = 0;
  /** Frames of the current block already rendered into the scratch buffers. */
  done = 0;
  idleFrames = 0;
  l = new Float32Array(128);
  r = new Float32Array(128);

  constructor(id: string, sound: TrackSound, sampleRate: number) {
    this.id = id;
    this.sound = sound;
    this.fx = new FxChain(sampleRate);
    this.mix = { gain: 1, pan: 0, mute: false, solo: false, fx: null };
  }

  setMix(mix: MixSettings): void {
    this.mix = { ...mix };
    if (mix.fx) this.fx.set(mix.fx);
  }

  get fxOn(): boolean {
    return this.mix.fx !== null && this.fx.active;
  }
}

export class SongPlayer {
  private readonly sampleRate: number;
  private lanes: Lane[] = [];
  /** The context frame at which song time `fromFrame` plays; null when stopped. */
  private startFrame: number | null = null;
  private fromFrame = 0;
  private positioned = false;
  /** A loop in song frames: playing across its end jumps back to its start. */
  private loop: { start: number; end: number } | null = null;
  private bpm = 120;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
  }

  get playing(): boolean {
    return this.startFrame !== null;
  }

  /** The tracks, as a whole (stops what plays). A track whose id stays keeps its effects' state. */
  setTracks(tracks: readonly PlayerTrack[]): void {
    this.allOff();
    const old = new Map(this.lanes.map((l) => [l.id, l]));
    const sr = this.sampleRate;
    this.lanes = tracks.map((t) => {
      const lane = old.get(t.id) ?? new Lane(t.id, t.sound, sr);
      lane.sound = t.sound;
      lane.setMix(t);
      lane.fx.setTempo(this.bpm);
      const events: SongEvent[] = [];
      for (const n of t.notes) {
        const start = Math.round(n.start * sr);
        const end = Math.max(start + 1, Math.round(n.end * sr));
        events.push({ frame: start, on: true, note: n.note, velocity: n.velocity, drum: n.drum });
        events.push({ frame: end, on: false, note: n.note, velocity: 0, drum: n.drum });
      }
      // Note-offs before note-ons at the same frame (a repeated note re-strikes).
      events.sort((a, b) => a.frame - b.frame || Number(a.on) - Number(b.on));
      lane.events = events;
      return lane;
    });
    this.positioned = false;
  }

  /** Volume, pan, mute, solo and effects of tracks by id (the notes stay; playback goes on). */
  setMix(id: string, mix: MixSettings): void {
    this.lanes.find((l) => l.id === id)?.setMix(mix);
  }

  setTempo(bpm: number): void {
    this.bpm = bpm;
    for (const lane of this.lanes) lane.fx.setTempo(bpm);
  }

  /** Loops [startSec, endSec) of the song, or stops looping (null). */
  setLoop(loop: { startSec: number; endSec: number } | null): void {
    const sr = this.sampleRate;
    this.loop = loop && loop.endSec > loop.startSec ? { start: Math.round(loop.startSec * sr), end: Math.round(loop.endSec * sr) } : null;
  }

  /** Starts at context frame `atFrame`, from `fromSec` into the song. */
  play(atFrame: number, fromSec: number): void {
    this.startFrame = atFrame;
    this.fromFrame = Math.max(0, Math.round(fromSec * this.sampleRate));
    this.positioned = false;
    // The LFOs start with the song.
    for (const lane of this.lanes) lane.fx.reset();
  }

  stop(): void {
    if (this.startFrame === null) return;
    this.startFrame = null;
    this.allOff();
  }

  private allOff(): void {
    for (const lane of this.lanes) lane.sound.allOff();
  }

  /** The first event at or after song frame `songFrame`. */
  private static seek(events: readonly SongEvent[], songFrame: number): number {
    let lo = 0;
    let hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (events[mid].frame < songFrame) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Renders a lane's sound into its scratch buffers up to `to` (frames into the block). */
  private static fill(lane: Lane, to: number): void {
    if (to <= lane.done) return;
    lane.sound.render(lane.l.subarray(lane.done, to), lane.r.subarray(lane.done, to), to - lane.done);
    lane.done = to;
  }

  /**
   * Renders `frames` samples starting at context frame `blockFrame`: every
   * track's sound, its effects, volume and pan, summed into the outputs
   * (which are overwritten).
   */
  render(blockFrame: number, outL: Float32Array, outR: Float32Array, frames: number): void {
    outL.fill(0, 0, frames);
    if (outR !== outL) outR.fill(0, 0, frames);
    for (const lane of this.lanes) {
      lane.done = 0;
      if (lane.l.length < frames) {
        lane.l = new Float32Array(frames);
        lane.r = new Float32Array(frames);
      }
    }
    let fired = false;
    if (this.startFrame !== null) {
      const songAt = (contextFrame: number) => this.fromFrame + (contextFrame - this.startFrame!);
      if (!this.positioned && blockFrame + frames > this.startFrame) {
        // Late start (the worklet came up after the play message): begin where the song is by now.
        const at = songAt(Math.max(blockFrame, this.startFrame));
        for (const lane of this.lanes) lane.cursor = SongPlayer.seek(lane.events, at);
        this.positioned = true;
      }
      if (this.positioned) {
        let from = 0;
        for (;;) {
          // This stretch ends at the block's end, or at the loop's end if that comes first.
          const now = songAt(blockFrame + from);
          const loop = this.loop;
          // (A loop's end exactly on the block's end still wraps: `reach` may equal `frames`.)
          const reach = loop && now < loop.end ? from + (loop.end - now) : Infinity;
          const limit = Math.min(frames, reach);
          const base = songAt(blockFrame);
          for (const lane of this.lanes) {
            while (lane.cursor < lane.events.length) {
              const e = lane.events[lane.cursor];
              const offset = e.frame - base;
              if (offset >= limit) break;
              SongPlayer.fill(lane, Math.max(0, offset));
              if (e.on) lane.sound.noteOn(e.note, e.velocity, e.drum);
              else lane.sound.noteOff(e.note, e.drum);
              lane.cursor++;
              fired = true;
            }
          }
          if (!loop || reach > frames) break;
          // The loop's end: what sounds is released, and the song goes on from the loop's start.
          for (const lane of this.lanes) {
            SongPlayer.fill(lane, limit);
            lane.sound.allOff();
            lane.cursor = SongPlayer.seek(lane.events, loop.start);
          }
          this.fromFrame = loop.start;
          this.startFrame = blockFrame + limit;
          from = limit;
        }
      }
    }
    // The rest of the block, the effects, and the mix.
    const anySolo = this.lanes.some((l) => l.mix.solo);
    const idleLimit = IDLE_SKIP_SEC * this.sampleRate;
    for (const lane of this.lanes) {
      const quiet = lane.sound.idle();
      lane.idleFrames = quiet && !fired ? lane.idleFrames + frames : 0;
      if (lane.idleFrames > idleLimit && lane.done === 0) continue; // silent, effects died away: nothing to do
      SongPlayer.fill(lane, frames);
      if (lane.fxOn) lane.fx.process(lane.l, lane.r, frames);
      const { gain, pan, mute, solo } = lane.mix;
      if (mute || (anySolo && !solo) || gain <= 0) continue;
      // Balance pan: the centre is unity on both sides.
      const gl = gain * Math.min(1, 1 - pan);
      const gr = gain * Math.min(1, 1 + pan);
      const l = lane.l;
      const r = lane.r;
      if (outR === outL) for (let i = 0; i < frames; i++) outL[i] += (l[i] * gl + r[i] * gr) * 0.5;
      else
        for (let i = 0; i < frames; i++) {
          outL[i] += l[i] * gl;
          outR[i] += r[i] * gr;
        }
    }
  }
}
