// The page's side of the engine: the AudioContext, the worklet node, and the
// analysis Worker.
//
// Browsers only let sound start from a user gesture (a tap, a key), and iOS
// suspends ("interrupts") the context when another app takes over. So the
// context is created and resumed inside the first gesture, and resumed again
// on the next one after any interruption.

import type { PitchTrack } from "../analysis/pyin";
import type { PreparedSource } from "../engine/engine";
import type { FromEngine, ToEngine } from "../engine/messages";
import type { MaterialAnalysis } from "../engine/prepare";
import type { InstrumentParams, Markers } from "../instrument/types";
import type { SeqNote } from "../song/parts";
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
  private preview: AudioBufferSourceNode | null = null;
  private previewStartedAt = 0;
  /** Seconds into the buffer the preview started at (seeking). */
  private previewOffset = 0;
  private previewDuration = 0;
  /** The buffer last played, so a seek can restart it from elsewhere. */
  private lastBuffer: AudioBuffer | null = null;
  onStatus: (voices: number) => void = () => {};
  onError: (message: string) => void = () => {};
  onPreviewEnd: () => void = () => {};

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

  /** Analyses a material for an engine at `targetRate` (in the Worker); with `track`, only the marks are found again. */
  analyze(channels: Float32Array[], sampleRate: number, targetRate = this.sampleRate, track?: PitchTrack): Promise<{ analysis: MaterialAnalysis; source: PreparedSource; elapsedMs: number }> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, (response) => (response.ok ? resolve(response) : reject(new Error(response.message))));
      const request: AnalysisRequest = { id, channels: channels.map((c) => c.slice()), sampleRate, targetRate, track };
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

  /** The tempo the tail's length limit counts in. */
  setTempo(bpm: number): void {
    this.pending = this.pending.filter((m) => m.type !== "tempo");
    this.post({ type: "tempo", bpm });
  }

  allOff(): void {
    if (this.node) this.post({ type: "allOff" });
  }

  // ------------------------------------------------------------ 曲で試す

  /** Hands the song's notes to the engine (stops any song playing). */
  loadSong(material: SeqNote[], backing: SeqNote[]): void {
    this.pending = this.pending.filter((m) => m.type !== "song" && m.type !== "songPlay");
    this.post({ type: "song", material, backing });
  }

  /**
   * Plays the loaded song from `fromSec`, a moment from now (so every note
   * of the first block lands on time). Returns the context time it starts
   * at, for the playhead. Call from a gesture.
   */
  playSong(fromSec: number): number {
    this.unlock();
    const context = this.context!;
    const at = context.currentTime + 0.08;
    this.post({ type: "songPlay", atFrame: Math.round(at * context.sampleRate), fromSec });
    return at;
  }

  stopSong(): void {
    this.pending = this.pending.filter((m) => m.type !== "songPlay");
    if (this.node) this.post({ type: "songStop" });
  }

  setSongGain(backing: number, material: number): void {
    this.pending = this.pending.filter((m) => m.type !== "songGain");
    this.post({ type: "songGain", backing, material });
  }

  /** The audio clock (seconds), or null before the audio started. */
  get currentTime(): number | null {
    return this.context?.currentTime ?? null;
  }

  /** Plays a rendered buffer (the file as it will be written) once, from `fromSec`; a second call stops the first. Call from a gesture. */
  playBuffer(channels: readonly Float32Array[], sampleRate: number, fromSec = 0): void {
    this.unlock();
    const context = this.context!;
    const frames = channels[0]?.length ?? 0;
    if (frames === 0) return;
    const buffer = context.createBuffer(channels.length, frames, sampleRate);
    channels.forEach((channel, i) => buffer.getChannelData(i).set(channel));
    this.stopPreview();
    this.lastBuffer = buffer;
    this.startPreview(buffer, fromSec);
  }

  private startPreview(buffer: AudioBuffer, fromSec: number): void {
    const context = this.context!;
    const offset = Math.max(0, Math.min(buffer.duration, fromSec));
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(context.destination);
    // Only the node still in charge reports the end: a seek swaps nodes without ending the preview.
    node.onended = () => {
      if (this.preview !== node) return;
      this.preview = null;
      this.onPreviewEnd();
    };
    node.start(0, offset);
    this.preview = node;
    this.previewStartedAt = context.currentTime;
    this.previewOffset = offset;
    this.previewDuration = buffer.duration;
  }

  /** Seconds into the preview that is playing, or null when none is. */
  previewPosition(): number | null {
    if (!this.preview || !this.context) return null;
    return Math.min(this.previewDuration, Math.max(0, this.previewOffset + this.context.currentTime - this.previewStartedAt));
  }

  /** The length of the preview last played (seconds), or 0. */
  get previewLength(): number {
    return this.lastBuffer?.duration ?? 0;
  }

  /** Moves the playing preview to `sec` (nothing when none is playing). */
  seekPreview(sec: number): void {
    if (!this.preview || !this.lastBuffer) return;
    this.halt();
    this.startPreview(this.lastBuffer, sec);
  }

  /** Stops the node without reporting an end. */
  private halt(): void {
    const node = this.preview;
    this.preview = null;
    try {
      node?.stop();
    } catch {
      // already stopped
    }
  }

  stopPreview(): void {
    const was = this.preview !== null;
    this.halt();
    if (was) this.onPreviewEnd();
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
