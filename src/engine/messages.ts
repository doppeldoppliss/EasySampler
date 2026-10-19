// What the page and the engine's AudioWorklet say to each other.

import type { InstrumentParams, Markers } from "../instrument/types";
import type { PreparedSource } from "./engine";

export type ToEngine =
  | { type: "source"; source: PreparedSource | null }
  | { type: "instrument"; markers: Markers; params: InstrumentParams }
  | { type: "noteOn"; note: number; velocity: number }
  | { type: "noteOff"; note: number }
  | { type: "allOff" };

export type FromEngine = { type: "status"; voices: number };
