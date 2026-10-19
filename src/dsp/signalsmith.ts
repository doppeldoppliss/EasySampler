// Signalsmith Stretch (MIT, WASM in an AudioWorklet): a spectral pitch
// shifter / time stretcher, here with its formant compensation on so the
// voice keeps its character. It's built for live playback, so the material
// is run through it in an OfflineAudioContext — faster than real time — and
// a pitch that moves (contour ≠ 1) is fed to it as a run of small scheduled
// changes.
//
// The node starts some way into the input (its own latency), so the
// material is given a lead-in of silence and the output read from where the
// material's start comes out.

import SignalsmithStretch from "signalsmith-stretch";
import { shiftAt, type ShiftRequest } from "./shift";

const LEAD_IN_SEC = 0.25;
/** How often the pitch is updated when it moves (contour ≠ 1). */
const CONTOUR_STEP_SEC = 0.01;
/**
 * A change made at some moment is heard from about half the node's latency
 * later (measured: flattening a 5.5 Hz vibrato works best at 0.065 s for a
 * latency of 0.12 s, at 44.1 and 48 kHz alike), so changes are made that much early.
 */
const CONTOUR_ADVANCE_SHARE = 0.55;

export interface SignalsmithOptions {
  /** Keep the formants where they are (default true). */
  formantCompensation?: boolean;
  /** Extra formant shift in semitones (0 = none). */
  formantSemitones?: number;
  /** How much earlier (s) than its moment a pitch change is made (default: CONTOUR_ADVANCE_SHARE of the latency). */
  contourAdvanceSec?: number;
}

export async function signalsmithShift(request: ShiftRequest, options: SignalsmithOptions = {}): Promise<Float32Array> {
  const { input, sampleRate, stretch } = request;
  const rate = 1 / stretch;
  const lead = Math.round(LEAD_IN_SEC * sampleRate);
  const padded = new Float32Array(lead + input.length + lead);
  padded.set(input, lead);

  const outLength = Math.round(input.length * stretch);
  // The material's start comes out at lead/rate, once the node's latency is accounted for (it does that itself).
  const outStart = Math.round(lead * stretch);
  const context = new OfflineAudioContext(1, outStart + outLength + lead, sampleRate);
  const node = await SignalsmithStretch(context, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
  node.connect(context.destination);
  await node.addBuffers([padded]);

  const base = {
    active: true,
    rate,
    formantCompensation: options.formantCompensation ?? true,
    formantSemitones: options.formantSemitones ?? 0,
    formantBaseHz: 0, // let it track the pitch
  };
  await node.schedule({ ...base, input: 0, outputTime: 0, output: 0, semitones: shiftAt(request, 0) });
  if (request.contour !== 1) {
    // The node keeps only changes scheduled for "now" onwards (scheduling one
    // drops every earlier one still pending), so the changes can't all be
    // queued up front: the rendering is paused at each step and the change
    // made there, as it would be live.
    const inputSec = input.length / sampleRate;
    const quantum = 128 / sampleRate; // suspend() rounds to render quanta
    const advance = options.contourAdvanceSec ?? CONTOUR_ADVANCE_SHARE * (await node.latency());
    for (let t = CONTOUR_STEP_SEC; t < inputSec; t += CONTOUR_STEP_SEC) {
      const at = Math.round(((LEAD_IN_SEC + t) * stretch - advance) / quantum) * quantum;
      const semitones = shiftAt(request, t);
      void context.suspend(at).then(async () => {
        await node.schedule({ outputTime: at, output: at, semitones });
        await context.resume();
      });
    }
  }

  const rendered = await context.startRendering();
  return rendered.getChannelData(0).slice(outStart, outStart + outLength);
}
