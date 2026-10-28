// The page's side of the engine: the AudioContext, the worklet node, and the
// analysis Worker.
//
// Browsers only let sound start from a user gesture (a tap, a key), and iOS
// suspends ("interrupts") the context when another app takes over. So the
// context is created and resumed inside the first gesture, and resumed again
// on the next one after any interruption.

import type { PitchTrack, PyinOptions } from "../analysis/pyin";
import type { PreparedSource } from "../engine/engine";
import type { FromEngine, ToEngine, TrackSpec } from "../engine/messages";
import type { MaterialAnalysis } from "../engine/prepare";
import type { FxSettings, InstrumentParams, Markers } from "../instrument/types";
import type { SeqNote } from "../song/parts";
import type { AnalysisRequest, AnalysisResponse } from "../workers/analysis.worker";
import workletUrl from "../engine/worklet.ts?worker&url";

/** The material the one-material screens open, and the instrument their cut being edited is. */
export const MAIN_MATERIAL = "main";
export const CURRENT_INSTRUMENT = "current";

type AudioSessionNavigator = Navigator & { audioSession?: { type: string } };

export class EngineClient {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  /** Messages sent before the worklet was up, replayed once it is. */
  private pending: ToEngine[] = [];
  /** The sources sent, by material id (for re-preparing at the real rate). */
  private sources = new Map<string, PreparedSource | null>();
  /** The instruments defined, by id (sent again after a source changes). */
  private instruments = new Map<string, Extract<ToEngine, { type: "instrument" }>>();
  /** The song's tracks as last loaded (for mix changes on top). */
  private songTracks: TrackSpec[] = [];

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
    // The engine's code is fetched now, so the first note after the first tap does not wait for the network.
    if (typeof fetch === "function") fetch(workletUrl).catch(() => {});
  }

  private playbackClaimed = false;
  /** iPhone / iPad: sound even with the silent switch on — asked for when sound is wanted, not on the first tap
   *  (claiming "playback" stops whatever music was playing in another app). */
  private claimPlayback(): void {
    if (this.playbackClaimed) return;
    this.playbackClaimed = true;
    const session = (navigator as AudioSessionNavigator).audioSession;
    try {
      if (session) session.type = "playback";
    } catch {
      // not settable here
    }
  }

  /** The rate the engine runs at (the context's, once there is one; 48 kHz is the usual guess before). */
  get sampleRate(): number {
    return this.context?.sampleRate ?? 48000;
  }

  get started(): boolean {
    return this.context !== null;
  }

  /** What is heard in the browser, 0–1 (the listening volume: files are written as they are). */
  private volume = 1;
  private output: GainNode | null = null;

  /** The listening volume (0–1, as a gain): everything the page plays goes through it; exports do not. */
  setVolume(gain: number): void {
    this.volume = Math.max(0, Math.min(1, gain));
    if (this.output && this.context) this.output.gain.setTargetAtTime(this.volume, this.context.currentTime, 0.02);
  }

  /** Where the page's sound goes: the listening volume, then the speakers. */
  private out(context: AudioContext): AudioNode {
    if (!this.output) {
      this.output = context.createGain();
      this.output.gain.value = this.volume;
      this.output.connect(context.destination);
    }
    return this.output;
  }

  /** Call from inside a user gesture: creates or resumes the audio. */
  unlock(): void {
    if (!this.context) {
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
    node.connect(this.out(context));
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
  analyze(channels: Float32Array[], sampleRate: number, targetRate = this.sampleRate, track?: PitchTrack, pyin?: PyinOptions): Promise<{ analysis: MaterialAnalysis; source: PreparedSource; elapsedMs: number }> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, (response) => (response.ok ? resolve(response) : reject(new Error(response.message))));
      const request: AnalysisRequest = { id, channels: channels.map((c) => c.slice()), sampleRate, targetRate, track, pyin };
      this.worker.postMessage(request);
    });
  }

  /** A material's prepared samples (null drops them). */
  setSource(source: PreparedSource | null, material = MAIN_MATERIAL): void {
    this.sources.set(material, source);
    // Replace any queued source of that material rather than sending two.
    this.pending = this.pending.filter((m) => !(m.type === "source" && m.material === material));
    this.post({ type: "source", material, source });
  }

  /** The most voices one instrument (one track) may sound at once (set lower on a phone, design.md 13.1). */
  voiceCap = Infinity;

  /** An instrument: a cut (markers and voice settings) of a material. Engines on it follow at once. */
  defineInstrument(id: string, material: string, markers: Markers, params: InstrumentParams): void {
    const capped = params.maxVoices > this.voiceCap ? { ...params, maxVoices: this.voiceCap } : params;
    const message = { type: "instrument" as const, id, material, markers, params: capped };
    this.instruments.set(id, message);
    this.pending = this.pending.filter((m) => !(m.type === "instrument" && m.id === id));
    this.post(message);
  }

  dropInstrument(id: string): void {
    this.instruments.delete(id);
    this.post({ type: "dropInstrument", id });
  }

  /** A rendered one-shot (a drum row's sound) for the engine, by id; null forgets it. */
  setSample(id: string, channels: Float32Array[] | null): void {
    this.pending = this.pending.filter((m) => !(m.type === "sample" && m.id === id));
    this.post({ type: "sample", id, channels });
  }

  /** The kit on the keyboard (on in the kit view): each key plays its sound, by sample id, or the plain drum sound of a GM key. */
  setLiveKit(on: boolean, samples: (string | null)[], keys: (number | null)[]): void {
    this.pending = this.pending.filter((m) => m.type !== "liveKit");
    this.post({ type: "liveKit", on, samples, keys });
  }

  /** One hit of the kit (a drum row tapped), apart from the keyboard. */
  kitHit(key: number): void {
    this.claimPlayback();
    this.unlock();
    this.post({ type: "kitHit", key });
  }

  /** Plays a kept one-shot once (a drum row being placed). */
  previewSample(id: string): void {
    this.claimPlayback();
    this.unlock();
    this.post({ type: "previewSample", id });
  }

  /** A short note on an instrument (placing a note on a track), apart from the keyboard. */
  previewNote(instrument: string, note: number, sec = 0.25): void {
    this.claimPlayback();
    this.unlock();
    this.post({ type: "preview", instrument, note, sec });
  }

  /** The instrument the keyboard plays (曲で試す plays its material part on it too). */
  private liveInstrument: string = CURRENT_INSTRUMENT;

  /** What the keyboard plays, and through which effects. */
  /** What the keyboard plays, through which effects, and whether through the master too (the 曲 view). */
  setLive(instrument: string | null, fx: FxSettings | null, master = false): void {
    if (instrument) this.liveInstrument = instrument;
    this.pending = this.pending.filter((m) => m.type !== "live");
    this.post({ type: "live", instrument, fx, master });
  }

  /**
   * The one-material screens' call: the cut being edited is instrument
   * "current" of the material, and the keyboard plays it dry (effects are a
   * track's, design.md 13.1).
   */
  setInstrument(markers: Markers, params: InstrumentParams, hold = 1): void {
    this.defineInstrument(CURRENT_INSTRUMENT, MAIN_MATERIAL, markers, params);
    this.setHold(hold);
    this.setLive(CURRENT_INSTRUMENT, null);
  }

  // Notes played before the worklet is up (the very first tap starts the
  // audio) wait in the queue, so that first tap still sounds.
  noteOn(note: number, velocity: number): void {
    this.claimPlayback();
    this.post({ type: "noteOn", note, velocity });
  }

  noteOff(note: number): void {
    this.post({ type: "noteOff", note });
  }

  /** The note length (seconds) a "stretch" sustain fills: the export length. */
  setHold(sec: number): void {
    this.pending = this.pending.filter((m) => m.type !== "hold");
    this.post({ type: "hold", sec });
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

  /** The song's tracks (replacing any; stops a song playing). */
  loadTracks(tracks: TrackSpec[]): void {
    this.songTracks = tracks;
    this.pending = this.pending.filter((m) => m.type !== "song" && m.type !== "songPlay" && m.type !== "songMix");
    this.post({ type: "song", tracks });
  }

  /** Volume, pan, mute, solo and effects of one track, while it plays. */
  setTrackMix(id: string, mix: { gain: number; pan: number; mute: boolean; solo: boolean; fx: FxSettings | null }): void {
    this.songTracks = this.songTracks.map((t) => (t.id === id ? { ...t, ...mix } : t));
    this.pending = this.pending.filter((m) => !(m.type === "songMix" && m.id === id));
    this.post({ type: "songMix", id, mix: { gain: mix.gain, pan: mix.pan, mute: mix.mute, solo: mix.solo, fx: mix.fx } });
  }

  setMasterFx(fx: FxSettings | null): void {
    this.pending = this.pending.filter((m) => m.type !== "master");
    this.post({ type: "master", fx });
  }

  /** The one-material screens' song: the material's notes on the cut being edited (through its effects), the rest on the backing. */
  loadSong(material: SeqNote[], backing: SeqNote[]): void {
    const plain = { pan: 0, mute: false, solo: false };
    this.loadTracks([
      { id: "material", instrument: this.liveInstrument, notes: material, gain: 1, fx: null, ...plain },
      { id: "backing", instrument: "backing", notes: backing, gain: this.backingGain, fx: null, ...plain },
    ]);
  }

  private backingGain = 0.5;

  /**
   * Plays the loaded song from `fromSec`, a moment from now (so every note
   * of the first block lands on time). Returns the context time it starts
   * at, for the playhead. Call from a gesture.
   */
  playSong(fromSec: number): number {
    this.claimPlayback();
    this.unlock();
    const context = this.context!;
    const at = context.currentTime + 0.08;
    this.post({ type: "songPlay", atFrame: Math.round(at * context.sampleRate), fromSec });
    return at;
  }

  /** Loops [startSec, endSec) of the song while it plays; null stops looping. */
  setSongLoop(loop: { startSec: number; endSec: number } | null): void {
    this.pending = this.pending.filter((m) => m.type !== "songLoop");
    this.post({ type: "songLoop", loop });
  }

  stopSong(): void {
    this.pending = this.pending.filter((m) => m.type !== "songPlay");
    if (this.node) this.post({ type: "songStop" });
  }

  setSongGain(backing: number, material: number): void {
    this.backingGain = backing;
    for (const t of this.songTracks) {
      if (t.id === "backing") this.setTrackMix(t.id, { ...t, gain: backing });
      else if (t.id === "material") this.setTrackMix(t.id, { ...t, gain: material });
    }
  }

  /** The audio clock (seconds), or null before the audio started. */
  get currentTime(): number | null {
    return this.context?.currentTime ?? null;
  }

  /** Plays a rendered buffer (the file as it will be written) once, from `fromSec`; a second call stops the first. Call from a gesture. */
  playBuffer(channels: readonly Float32Array[], sampleRate: number, fromSec = 0): void {
    this.claimPlayback();
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
    node.connect(this.out(context));
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

  /** Whether a material's source was made for the engine's actual rate. */
  sourceMatchesRate(material = MAIN_MATERIAL): boolean {
    const source = this.sources.get(material);
    return !source || source.sampleRate === this.sampleRate;
  }

  /** Re-sends the instruments (after a source was re-prepared, engines are set up again). */
  resendInstrument(): void {
    for (const message of this.instruments.values()) this.post(message);
  }
}
