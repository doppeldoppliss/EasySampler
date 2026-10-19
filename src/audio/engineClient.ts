// The page's side of the engine: the AudioContext, the worklet node, and the
// analysis Worker.
//
// Browsers only let sound start from a user gesture (a tap, a key), and iOS
// suspends ("interrupts") the context when another app takes over. So the
// context is created and resumed inside the first gesture, and resumed again
// on the next one after any interruption.

import type { PreparedSource } from "../engine/engine";
import type { FromEngine, ToEngine } from "../engine/messages";
import type { MaterialAnalysis } from "../engine/prepare";
import type { InstrumentParams, Markers } from "../instrument/types";
import type { AnalysisRequest, AnalysisResponse } from "../workers/analysis.worker";
import workletUrl from "../engine/worklet.ts?worker&url";

type AudioSessionNavigator = Navigator & { audioSession?: { type: string } };

export class EngineClient {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  /** Messages sent before the worklet was up, replayed once it is. */
  private pending: ToEngine[] = [];
  private lastSource: PreparedSource | null = null;
  private lastInstrument: ToEngine | null = null;
  private worker = new Worker(new URL("../workers/analysis.worker.ts", import.meta.url), { type: "module" });
  private nextId = 1;
  private waiting = new Map<number, (response: AnalysisResponse) => void>();
  onStatus: (voices: number) => void = () => {};
  onError: (message: string) => void = () => {};

  constructor() {
    this.worker.onmessage = (event: MessageEvent<AnalysisResponse>) => {
      this.waiting.get(event.data.id)?.(event.data);
      this.waiting.delete(event.data.id);
    };
  }

  /** The rate the engine runs at (the context's, once there is one; 48 kHz is the usual guess before). */
  get sampleRate(): number {
    return this.context?.sampleRate ?? 48000;
  }

  get started(): boolean {
    return this.context !== null;
  }

  /** Call from inside a user gesture: creates or resumes the audio. */
  unlock(): void {
    if (!this.context) {
      const session = (navigator as AudioSessionNavigator).audioSession;
      try {
        // iPhone / iPad: sound even with the silent switch on.
        if (session) session.type = "playback";
      } catch {
        // not settable here
      }
      this.context = new AudioContext({ latencyHint: "interactive" });
      this.setUpWorklet(this.context).catch((error: unknown) => this.onError(error instanceof Error ? error.message : String(error)));
    }
    if (this.context.state !== "running") void this.context.resume();
  }

  private async setUpWorklet(context: AudioContext): Promise<void> {
    await context.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(context, "maddaw-engine", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    node.port.onmessage = (event: MessageEvent<FromEngine>) => {
      if (event.data.type === "status") this.onStatus(event.data.voices);
    };
    node.connect(context.destination);
    this.node = node;
    for (const message of this.pending) this.post(message);
    this.pending = [];
  }

  private post(message: ToEngine): void {
    if (!this.node) {
      this.pending.push(message);
      return;
    }
    this.node.port.postMessage(message);
  }

  /** Analyses a material for an engine at `targetRate` (in the Worker). */
  analyze(channels: Float32Array[], sampleRate: number, targetRate = this.sampleRate): Promise<{ analysis: MaterialAnalysis; source: PreparedSource; elapsedMs: number }> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, (response) => (response.ok ? resolve(response) : reject(new Error(response.message))));
      const request: AnalysisRequest = { id, channels: channels.map((c) => c.slice()), sampleRate, targetRate };
      this.worker.postMessage(request);
    });
  }

  setSource(source: PreparedSource | null): void {
    this.lastSource = source;
    // Replace any queued source rather than sending two.
    this.pending = this.pending.filter((m) => m.type !== "source");
    this.post({ type: "source", source });
  }

  setInstrument(markers: Markers, params: InstrumentParams): void {
    const message: ToEngine = { type: "instrument", markers, params };
    this.lastInstrument = message;
    this.pending = this.pending.filter((m) => m.type !== "instrument");
    this.post(message);
  }

  // Notes played before the worklet is up (the very first tap starts the
  // audio) wait in the queue, so that first tap still sounds.
  noteOn(note: number, velocity: number): void {
    this.post({ type: "noteOn", note, velocity });
  }

  noteOff(note: number): void {
    this.post({ type: "noteOff", note });
  }

  allOff(): void {
    if (this.node) this.post({ type: "allOff" });
  }

  /** The source last sent, and whether it was made for the engine's actual rate. */
  sourceMatchesRate(): boolean {
    return !this.lastSource || this.lastSource.sampleRate === this.sampleRate;
  }

  /** Re-sends the current instrument (e.g. after a source was re-prepared). */
  resendInstrument(): void {
    if (this.lastInstrument) this.post(this.lastInstrument);
  }
}
