// What the page and the engine's AudioWorklet say to each other.
//
// Materials (prepared sources) and instruments (a cut of a material: markers
// and voice settings) are named by ids; tracks of a song play an instrument
// (or the plain backing); the "live" channel is what the keyboard plays.

import type { FxSettings, InstrumentParams, Markers } from "../instrument/types";
import type { SeqNote } from "../song/parts";
import type { MixSettings } from "../song/player";
import type { PreparedSource } from "./engine";

export interface TrackSpec extends MixSettings {
  id: string;
  /** The instrument the notes play on, "backing" for the plain backing synth, or "drum" for rendered one-shots. */
  instrument: string | "backing" | "drum";
  notes: SeqNote[];
  /** A drum track: the one-shot (by sample id) each row plays; a note's pitch is its row. */
  samples?: (string | null)[];
  /** Portamento (seconds; 0 or absent = off). */
  glide?: number;
}

export type ToEngine =
  | { type: "source"; material: string; source: PreparedSource | null }
  | { type: "instrument"; id: string; material: string; markers: Markers; params: InstrumentParams }
  | { type: "dropInstrument"; id: string }
  // The note length the "stretch" sustain fills (the export length, in seconds).
  | { type: "hold"; sec: number }
  | { type: "tempo"; bpm: number }
  // The keyboard: which instrument it plays, through which effects.
  | { type: "live"; instrument: string | null; fx: FxSettings | null }
  | { type: "noteOn"; note: number; velocity: number }
  | { type: "noteOff"; note: number }
  | { type: "allOff" }
  // A rendered one-shot (a drum row's sound), kept by id; null forgets it.
  | { type: "sample"; id: string; channels: Float32Array[] | null }
  | { type: "previewSample"; id: string }
  // A short note on an instrument (placing a note on a track's roll), apart from the keyboard.
  | { type: "preview"; instrument: string; note: number; sec: number }
  // A song: its tracks (replacing any), then play from `fromSec` at context frame `atFrame`.
  | { type: "song"; tracks: TrackSpec[] }
  | { type: "songMix"; id: string; mix: MixSettings }
  | { type: "master"; fx: FxSettings | null }
  | { type: "songPlay"; atFrame: number; fromSec: number }
  | { type: "songStop" }
  | { type: "songLoop"; loop: { startSec: number; endSec: number } | null };

export type FromEngine = { type: "status"; voices: number };
