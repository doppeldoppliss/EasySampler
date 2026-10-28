// What a song track plays its notes on (shared by the AudioWorklet and the
// offline song export, so the file sounds as the page does): an Engine on one
// cut, a drum track's rendered one-shots, or the plain backing.

import { Engine, type PreparedSource } from "../engine/engine";
import { BackingSynth } from "./backing";
import type { TrackSound } from "./player";

/** Drum keys that cut each other off (open / closed / pedal hi-hat). */
const CHOKE: ReadonlyMap<number, number> = new Map([
  [42, 1],
  [44, 1],
  [46, 1],
]);
/** How fast a choked hit fades (samples per step of its gain, about 5 ms). */
const CHOKE_FADE = 240;

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
  setTempo(bpm: number): void {
    this.engine.setTempo(bpm);
  }
  /** 語尾を収める: song notes hand their length on, so the tail ends with the note. */
  fitTail = false;
  noteOn(note: number, velocity: number, _drum = false, lengthSec?: number): void {
    this.engine.noteOn(note, velocity, this.fitTail ? lengthSec : undefined);
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

/** A drum track: each row a rendered one-shot, played as it is (no pitch change, no note-off), or the plain drum sound of a GM key. */
export class SampleSound implements TrackSound {
  /** Row → sample, as the track was loaded. */
  rows: (Float32Array[] | null)[] = [];
  /** Row → GM drum key, for a row on the plain drum sound (簡易ドラム). */
  keys: (number | null)[] = [];
  private voices: { sample: Float32Array[]; at: number; gain: number; row: number; fade: number }[] = [];
  /** Rows are GM drum keys (a kit): an open hi-hat is cut off by a closed one and the other way round. */
  chokes = false;
  private readonly synth: BackingSynth | null;
  private static readonly MAX_VOICES = 16;
  constructor(sampleRate?: number) {
    this.synth = sampleRate ? new BackingSynth(sampleRate) : null;
  }
  noteOn(row: number, velocity: number): void {
    if (this.chokes) {
      const group = CHOKE.get(row);
      if (group !== undefined) for (const v of this.voices) if (v.row !== row && CHOKE.get(v.row) === group && v.fade === 0) v.fade = CHOKE_FADE;
    }
    const sample = this.rows[row];
    if (!sample) {
      const key = this.keys[row];
      if (key !== null && key !== undefined) this.synth?.noteOn(key, velocity, true);
      return;
    }
    if (this.voices.length >= SampleSound.MAX_VOICES) this.voices.shift();
    this.voices.push({ sample, at: 0, gain: velocity, row, fade: 0 });
  }
  noteOff(): void {
    // a one-shot plays to its end
  }
  /** Everything fades out over a few ms (a loop's wrap, a stop): no click. */
  allOff(): void {
    for (const v of this.voices) if (v.fade === 0) v.fade = CHOKE_FADE;
    this.synth?.allOff();
  }
  render(left: Float32Array, right: Float32Array, frames: number): void {
    left.fill(0, 0, frames);
    if (right !== left) right.fill(0, 0, frames);
    this.synth?.renderAdd(left, right, frames, 1);
    for (const v of this.voices) {
      const l = v.sample[0];
      const r = v.sample[1] ?? l;
      const n = Math.min(frames, l.length - v.at);
      for (let i = 0; i < n; i++) {
        let g = v.gain;
        if (v.fade > 0) {
          g *= v.fade / CHOKE_FADE;
          v.fade = Math.max(1e-9, v.fade - 1);
        }
        left[i] += l[v.at + i] * g;
        if (right !== left) right[i] += r[v.at + i] * g;
      }
      v.at += n;
    }
    // (A choked hit is done once its fade has run out.)
    this.voices = this.voices.filter((v) => v.at < v.sample[0].length && !(v.fade > 0 && v.fade < 1));
  }
  idle(): boolean {
    return this.voices.length === 0 && (this.synth?.idle() ?? true);
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

