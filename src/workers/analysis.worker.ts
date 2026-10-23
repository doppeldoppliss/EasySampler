// Analysis off the UI thread: pitch track, pitch marks, root and suggested
// markers, plus the material resampled for the engine.

import type { PitchTrack } from "../analysis/pyin";
import type { PreparedSource } from "../engine/engine";
import { analyzeMaterial, prepareSource, type MaterialAnalysis } from "../engine/prepare";

export interface AnalysisRequest {
  id: number;
  channels: Float32Array[];
  sampleRate: number;
  /** The engine's (AudioContext's) sample rate. */
  targetRate: number;
  /** A pitch track to use as it is (hand-corrected): only the marks are found again. */
  track?: PitchTrack;
}

export type AnalysisResponse =
  | { id: number; ok: true; analysis: MaterialAnalysis; source: PreparedSource; elapsedMs: number }
  | { id: number; ok: false; message: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<AnalysisRequest>) => void) | null;
  postMessage(message: AnalysisResponse, transfer?: Transferable[]): void;
};

scope.onmessage = (event) => {
  const { id, channels, sampleRate, targetRate, track } = event.data;
  try {
    const started = performance.now();
    const analysis = analyzeMaterial(channels, sampleRate, track);
    const source = prepareSource(channels, analysis, targetRate);
    const elapsedMs = performance.now() - started;
    scope.postMessage({ id, ok: true, analysis, source, elapsedMs }, source.channels.map((c) => c.buffer as ArrayBuffer));
  } catch (error) {
    scope.postMessage({ id, ok: false, message: error instanceof Error ? error.message : String(error) });
  }
};
