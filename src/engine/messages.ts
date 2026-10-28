// What the page and the engine's AudioWorklet say to each other.
//
// Materials (prepared sources) and instruments (a cut of a material: markers
// and voice settings) are named by ids; tracks of a song play an instrument
// (or the plain backing); the "live" channel is what the keyboard plays.

import type { FxSettings, InstrumentParams, Markers } from "../instrument/types";
import type { SeqNote } from "../song/parts";
import type { AutoPoint, MixSettings } from "../song/player";
import type { PreparedSource } from "./engine";

export interface TrackSpec extends MixSettings {
  id: string;
  /** The instrument the notes play on, "backing" for the plain backing synth, "drum" for rendered one-shots, or "audio" for clips. */
  instrument: string | "backing" | "drum" | "audio";
  /** An audio track: note i plays clip i (a material's recording from an offset). */
  clips?: { material: string; offsetSec: number }[];
  notes: SeqNote[];
  /** A drum track: the one-shot (by sample id) each row plays; a note's pitch is its row. */
  samples?: (string | null)[];
  /** A drum track: the GM key of each row on the plain drum sound (null where a one-shot plays). */
  drumKeys?: (number | null)[];
  /** Portamento (seconds; 0 or absent = off). */
  glide?: number;
  /** 語尾を収める: the tail ends where the note does. */
  tailFit?: boolean;
}

export type ToEngine =
  | { type: "source"; material: string; source: PreparedSource | null }
  // hold: the note length a "stretch" sustain fills for this instrument (its material's export length).
  | { type: "instrument"; id: string; material: string; markers: Markers; params: InstrumentParams; hold?: number }
  | { type: "dropInstrument"; id: string }
  // The note length the "stretch" sustain fills (the export length, in seconds).
  | { type: "hold"; sec: number }
  | { type: "tempo"; bpm: number }
  // The keyboard: which instrument it plays, through which effects.
  // master: the keyboard goes through the master effects too (the 曲 view: heard as in the song); otherwise it bypasses them.
  | { type: "live"; instrument: string | null; fx: FxSettings | null; master?: boolean }
  | { type: "noteOn"; note: number; velocity: number }
  | { type: "noteOff"; note: number }
  | { type: "allOff" }
  // A rendered one-shot (a drum row's sound), kept by id; null forgets it.
  | { type: "sample"; id: string; channels: Float32Array[] | null }
  | { type: "previewSample"; id: string }
  // A short note on an instrument (placing a note on a track's roll), apart from the keyboard.
  | { type: "preview"; instrument: string; note: number; sec: number }
  // A song: its tracks (replacing any), then play from `fromSec` at context frame `atFrame`.
  // The kit (design.md 13.2) on the keyboard: on, the keys play the kit's sounds (by sample id, per GM key) instead of the instrument.
  | { type: "liveKit"; on: boolean; samples: (string | null)[]; keys: (number | null)[] }
  // One hit of the kit (a drum row's name tapped), whatever the keyboard plays.
  | { type: "kitHit"; key: number }
  | { type: "song"; tracks: TrackSpec[] }
  | { type: "songMix"; id: string; mix: MixSettings }
  | { type: "master"; fx: FxSettings | null }
  // The master volume line (song seconds; empty = none).
  | { type: "masterAuto"; points: AutoPoint[] }
  // The song's tempo map (where each tempo starts, song seconds).
  | { type: "tempoMap"; points: { sec: number; bpm: number }[] }
  | { type: "songPlay"; atFrame: number; fromSec: number }
  | { type: "songStop" }
  | { type: "songLoop"; loop: { startSec: number; endSec: number } | null };

export type FromEngine = { type: "status"; voices: number };
