// Playing a song inside the audio thread (or a test): note events at exact
// sample positions, the material's on the Engine and the rest on the plain
// backing. The page says when (an AudioContext frame) and from where (song
// seconds); a render block is split at every event in it.

import type { Engine } from "../engine/engine";
import { BackingSynth } from "./backing";
import type { SeqNote } from "./parts";

interface SongEvent {
  /** Song seconds × sample rate. */
  frame: number;
  on: boolean;
  material: boolean;
  note: number;
  velocity: number;
  drum: boolean;
}

export class SongPlayer {
  private readonly sampleRate: number;
  readonly backing: BackingSynth;
  private events: SongEvent[] = [];
  /** The context frame at which song time `fromFrame` plays; null when stopped. */
  private startFrame: number | null = null;
  private fromFrame = 0;
  private cursor = 0;
  private positioned = false;
  backingGain = 0.5;
  materialGain = 1;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.backing = new BackingSynth(sampleRate);
  }

  get playing(): boolean {
    return this.startFrame !== null;
  }

  load(material: readonly SeqNote[], backing: readonly SeqNote[]): void {
    const sr = this.sampleRate;
    const events: SongEvent[] = [];
    const add = (n: SeqNote, isMaterial: boolean) => {
      const start = Math.round(n.start * sr);
      const end = Math.max(start + 1, Math.round(n.end * sr));
      events.push({ frame: start, on: true, material: isMaterial, note: n.note, velocity: n.velocity, drum: n.drum });
      events.push({ frame: end, on: false, material: isMaterial, note: n.note, velocity: 0, drum: n.drum });
    };
    for (const n of material) add(n, true);
    for (const n of backing) add(n, false);
    // Note-offs before note-ons at the same frame (a repeated note re-strikes).
    events.sort((a, b) => a.frame - b.frame || Number(a.on) - Number(b.on));
    this.events = events;
    this.positioned = false;
  }

  /** Starts at context frame `atFrame`, from `fromSec` into the song. */
  play(atFrame: number, fromSec: number): void {
    this.startFrame = atFrame;
    this.fromFrame = Math.max(0, Math.round(fromSec * this.sampleRate));
    this.positioned = false;
  }

  stop(engine: Engine): void {
    if (this.startFrame === null) return;
    this.startFrame = null;
    engine.allOff();
    this.backing.allOff();
  }

  /** The first event at or after song frame `songFrame`. */
  private seek(songFrame: number): number {
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid].frame < songFrame) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private fire(e: SongEvent, engine: Engine): void {
    if (e.material) {
      if (e.on) engine.noteOn(e.note, e.velocity * this.materialGain);
      else engine.noteOff(e.note);
    } else if (e.on) this.backing.noteOn(e.note, e.velocity, e.drum);
    else this.backing.noteOff(e.note, e.drum);
  }

  /**
   * Renders `frames` samples starting at context frame `blockFrame`:
   * the Engine (material and the live keyboard) plus the backing.
   */
  render(blockFrame: number, outL: Float32Array, outR: Float32Array, frames: number, engine: Engine): void {
    let done = 0;
    if (this.startFrame !== null) {
      const songAt = (contextFrame: number) => this.fromFrame + (contextFrame - this.startFrame!);
      if (!this.positioned && blockFrame + frames > this.startFrame) {
        // Late start (the worklet came up after the play message): begin where the song is by now.
        this.cursor = this.seek(songAt(Math.max(blockFrame, this.startFrame)));
        this.positioned = true;
      }
      if (this.positioned) {
        while (this.cursor < this.events.length) {
          const e = this.events[this.cursor];
          const offset = e.frame - songAt(blockFrame);
          if (offset >= frames) break;
          if (offset > done) {
            this.renderSpan(outL, outR, done, offset, engine);
            done = offset;
          }
          this.fire(e, engine);
          this.cursor++;
        }
      }
    }
    if (done < frames) this.renderSpan(outL, outR, done, frames, engine);
  }

  private renderSpan(outL: Float32Array, outR: Float32Array, from: number, to: number, engine: Engine): void {
    const l = outL.subarray(from, to);
    const r = outR === outL ? l : outR.subarray(from, to);
    engine.render(l, r, to - from);
    this.backing.renderAdd(l, r, to - from, this.backingGain);
  }
}
