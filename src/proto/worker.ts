// Phase 0: the analysis and the time-domain methods run here, off the UI
// thread — as they will in the app — so the page stays responsive and the
// timings are what a worker really achieves (on an iPad too).

import { centerPitch, type CenterPitch } from "../analysis/centerPitch";
import { analyzePitch, type PitchTrack } from "../analysis/pyin";
import { psolaShift } from "../dsp/psola";
import { resampleShift } from "../dsp/resample";
import { renderNotes, type Material, type RenderResult, type RenderSettings, type TestNote } from "./melody";

export type WorkerRequest =
  | { id: number; type: "analyze"; samples: Float32Array; sampleRate: number }
  | { id: number; type: "render"; method: "psola" | "resample"; material: Material; notes: TestNote[]; settings: RenderSettings };

export type WorkerResponse =
  | { id: number; type: "analyze"; track: PitchTrack; center: CenterPitch | null; elapsedMs: number }
  | { id: number; type: "render"; result: RenderResult }
  | { id: number; type: "error"; message: string };

// (The project is typed against the DOM library; this is the worker side of it.)
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
};

scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === "analyze") {
      const started = performance.now();
      const track = analyzePitch(request.samples, request.sampleRate);
      const center = centerPitch(track);
      const response: WorkerResponse = { id: request.id, type: "analyze", track, center, elapsedMs: performance.now() - started };
      scope.postMessage(response);
    } else {
      const shifter = request.method === "psola" ? psolaShift : resampleShift;
      const result = await renderNotes(request.method, shifter, request.material, request.notes, request.settings);
      const response: WorkerResponse = { id: request.id, type: "render", result };
      scope.postMessage(response, [result.audio.buffer]);
    }
  } catch (error) {
    scope.postMessage({ id: request.id, type: "error", message: error instanceof Error ? error.message : String(error) } satisfies WorkerResponse);
  }
};
