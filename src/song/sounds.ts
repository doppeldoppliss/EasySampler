// What a song track plays its notes on (shared by the AudioWorklet and the
// offline song export, so the file sounds as the page does): an Engine on one
// cut, a drum track's rendered one-shots, or the plain backing.

import { Engine, type PreparedSource } from "../engine/engine";
import { BackingSynth } from "./backing";
import type { TrackSound } from "./player";

/** An Engine as a track's sound, remembering which instrument and source it was set up with. */
export class EngineSound implements TrackSound {
  readonly engine: Engine;
  constructor(sampleRate: number) {
    this.engine = new Engine(sampleRate);
  }
  instrument: string | null = null;
  source: PreparedSource | null = null;
  setGlide(sec: number): void {
    this.engine.setGlide(sec);
  }
  noteOn(note: number, velocity: number): void {
    this.engine.noteOn(note, velocity);
  }
  noteOff(note: number): void {
    this.engine.noteOff(note);
  }
  allOff(): void {
    this.engine.allOff();
  }
  render(left: Float32Array, right: Float32Array, frames: number): void {
    this.engine.render(left, right, frames);
  }
  idle(): boolean {
    return this.engine.activeVoices() === 0;
  }
}

/** A drum track: each row a rendered one-shot, played as it is (no pitch change, no note-off). */
export class SampleSound implements TrackSound {
  /** Row → sample, as the track was loaded. */
  rows: (Float32Array[] | null)[] = [];
  private voices: { sample: Float32Array[]; at: number; gain: number }[] = [];
  private static readonly MAX_VOICES = 16;
  noteOn(row: number, velocity: number): void {
    const sample = this.rows[row];
    if (!sample) return;
    if (this.voices.length >= SampleSound.MAX_VOICES) this.voices.shift();
    this.voices.push({ sample, at: 0, gain: velocity });
  }
  noteOff(): void {
    // a one-shot plays to its end
  }
  allOff(): void {
    this.voices = [];
  }
  render(left: Float32Array, right: Float32Array, frames: number): void {
    left.fill(0, 0, frames);
    if (right !== left) right.fill(0, 0, frames);
    for (const v of this.voices) {
      const l = v.sample[0];
      const r = v.sample[1] ?? l;
      const n = Math.min(frames, l.length - v.at);
      for (let i = 0; i < n; i++) {
        left[i] += l[v.at + i] * v.gain;
        if (right !== left) right[i] += r[v.at + i] * v.gain;
      }
      v.at += n;
    }
    this.voices = this.voices.filter((v) => v.at < v.sample[0].length);
  }
  idle(): boolean {
    return this.voices.length === 0;
  }

  get sounding(): number {
    return this.voices.length;
  }
}

export class BackingSound implements TrackSound {
  private readonly synth: BackingSynth;
  constructor(sampleRate: number) {
    this.synth = new BackingSynth(sampleRate);
  }
  noteOn(note: number, velocity: number, drum: boolean): void {
    this.synth.noteOn(note, velocity, drum);
  }
  noteOff(note: number, drum: boolean): void {
    this.synth.noteOff(note, drum);
  }
  allOff(): void {
    this.synth.allOff();
  }
  render(left: Float32Array, right: Float32Array, frames: number): void {
    left.fill(0, 0, frames);
    if (right !== left) right.fill(0, 0, frames);
    this.synth.renderAdd(left, right, frames, 1);
  }
  idle(): boolean {
    return this.synth.idle();
  }
}

