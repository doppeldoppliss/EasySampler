// What the page and the engine's AudioWorklet say to each other.

import type { InstrumentParams, Markers } from "../instrument/types";
import type { SeqNote } from "../song/parts";
import type { PreparedSource } from "./engine";

export type ToEngine =
  | { type: "source"; source: PreparedSource | null }
  | { type: "instrument"; markers: Markers; params: InstrumentParams }
  | { type: "noteOn"; note: number; velocity: number }
  | { type: "noteOff"; note: number }
  | { type: "allOff" }
  | { type: "tempo"; bpm: number }
  // 曲で試す: the notes, then play from `fromSec` at context frame `atFrame`.
  | { type: "song"; material: SeqNote[]; backing: SeqNote[] }
  | { type: "songPlay"; atFrame: number; fromSec: number }
  | { type: "songStop" }
  | { type: "songGain"; backing: number; material: number };

export type FromEngine = { type: "status"; voices: number };
