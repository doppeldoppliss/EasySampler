// The engine inside an AudioWorklet: messages in, stereo out. Everything
// heavy (analysis, resampling) happened before the material got here; this
// only renders.
//
// It holds the materials (prepared sources) and instruments (a cut: markers
// and voice settings on a material) by id, an Engine per song track playing an
// instrument, the "live" Engine the keyboard plays, and the master effects.

import { FxChain } from "../fx/chain";
import type { InstrumentParams, Markers } from "../instrument/types";
import { SongPlayer, type TrackSound } from "../song/player";
import { BackingSound, EngineSound, SampleSound } from "../song/sounds";
import type { PreparedSource } from "./engine";
import type { FromEngine, ToEngine, TrackSpec } from "./messages";

// The AudioWorklet globals (the project is typed against the DOM library).
declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessorLike): void;
declare class AudioWorkletProcessorLike {
  readonly port: MessagePort;
}
declare const AudioWorkletProcessor: typeof AudioWorkletProcessorLike;

/** How often the voice count is reported (render quanta ≈ 0.1 s). */
const STATUS_EVERY = 32;

interface Instrument {
  material: string;
  markers: Markers;
  params: InstrumentParams;
}

class EngineProcessor extends AudioWorkletProcessor {
  private readonly sources = new Map<string, PreparedSource | null>();
  /** Rendered one-shots (drum rows), by id. */
  private readonly samples = new Map<string, Float32Array[]>();
  private readonly samplePreview = new SampleSound();
  private readonly instruments = new Map<string, Instrument>();
  private readonly song = new SongPlayer(sampleRate);
  /** The sounds of the song's tracks, by track id (kept across reloads, so a track keeps its engine). */
  private trackSounds = new Map<string, TrackSound>();
  private trackSpecs: TrackSpec[] = [];
  private readonly live = new EngineSound(sampleRate);
  /** Placing a note on a track: its instrument, briefly, without effects. */
  private readonly preview = new EngineSound(sampleRate);
  private previewLeft = 0;
  private previewNote = -1;
  private readonly liveFx = new FxChain(sampleRate);
  private liveFxOn = false;
  private readonly master = new FxChain(sampleRate);
  private masterOn = false;
  private hold = 1;
  private bpm = 120;
  private liveL = new Float32Array(128);
  private liveR = new Float32Array(128);
  private quanta = 0;
  private lastVoices = -1;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<ToEngine>) => this.handle(event.data);
  }

  /** Points an engine at an instrument (and its material), as it is now. */
  private apply(sound: EngineSound, id: string | null): void {
    const inst = id === null ? undefined : this.instruments.get(id);
    sound.instrument = id;
    const source = inst ? (this.sources.get(inst.material) ?? null) : null;
    if (source !== sound.source || !inst) {
      sound.source = inst ? source : null;
      sound.engine.setSource(sound.source);
    }
    if (inst && source) {
      sound.engine.setInstrument(inst.markers, inst.params);
      sound.engine.setHold(this.hold);
      sound.engine.setTempo(this.bpm);
    }
  }

  /** Every engine on an instrument (or on any instrument of a material) gets it again. */
  private refresh(match: (inst: string) => boolean): void {
    const all = [this.live, this.preview, ...this.trackSounds.values()];
    for (const sound of all) if (sound instanceof EngineSound && sound.instrument !== null && match(sound.instrument)) this.apply(sound, sound.instrument);
  }

  private setSong(tracks: TrackSpec[]): void {
    this.song.stop();
    const next = new Map<string, TrackSound>();
    for (const t of tracks) {
      const kind = t.instrument === "backing" ? BackingSound : t.instrument === "drum" ? SampleSound : EngineSound;
      let sound = this.trackSounds.get(t.id);
      if (!(sound instanceof kind)) sound = kind === EngineSound ? new EngineSound(sampleRate) : kind === SampleSound ? new SampleSound() : new BackingSound(sampleRate);
      if (sound instanceof EngineSound && sound.instrument !== t.instrument) this.apply(sound, t.instrument);
      if (sound instanceof EngineSound) sound.setGlide(t.glide ?? 0);
      if (sound instanceof SampleSound) sound.rows = (t.samples ?? []).map((id) => (id ? (this.samples.get(id) ?? null) : null));
      next.set(t.id, sound);
    }
    this.trackSounds = next;
    this.trackSpecs = tracks;
    this.song.setTracks(tracks.map((t) => ({ ...t, sound: next.get(t.id)! })));
    this.song.setTempo(this.bpm);
  }

  private handle(message: ToEngine): void {
    switch (message.type) {
      case "source":
        this.sources.set(message.material, message.source);
        this.refresh((id) => this.instruments.get(id)?.material === message.material);
        break;
      case "instrument":
        this.instruments.set(message.id, { material: message.material, markers: message.markers, params: message.params });
        this.refresh((id) => id === message.id);
        break;
      case "dropInstrument":
        this.instruments.delete(message.id);
        this.refresh((id) => id === message.id);
        break;
      case "live":
        if (this.live.instrument !== message.instrument) this.apply(this.live, message.instrument);
        this.liveFxOn = message.fx !== null;
        if (message.fx) this.liveFx.set(message.fx);
        break;
      case "noteOn":
        this.live.noteOn(message.note, message.velocity);
        break;
      case "noteOff":
        this.live.noteOff(message.note);
        break;
      case "allOff":
        this.live.allOff();
        break;
      case "sample":
        if (message.channels) this.samples.set(message.id, message.channels);
        else this.samples.delete(message.id);
        // Drum tracks on it hear the new one from their next hit.
        for (const t of this.trackSpecs) {
          const sound = this.trackSounds.get(t.id);
          if (sound instanceof SampleSound) sound.rows = (t.samples ?? []).map((id) => (id ? (this.samples.get(id) ?? null) : null));
        }
        break;
      case "previewSample": {
        const sample = this.samples.get(message.id);
        if (sample) {
          this.samplePreview.rows = [sample];
          this.samplePreview.noteOn(0, 0.8);
        }
        break;
      }
      case "preview":
        if (this.preview.instrument !== message.instrument) this.apply(this.preview, message.instrument);
        if (this.previewNote >= 0) this.preview.noteOff(this.previewNote);
        this.preview.noteOn(message.note, 0.8);
        this.previewNote = message.note;
        this.previewLeft = Math.round(message.sec * sampleRate);
        break;
      case "hold":
        this.hold = message.sec;
        for (const sound of [this.live, this.preview, ...this.trackSounds.values()]) if (sound instanceof EngineSound) sound.engine.setHold(message.sec);
        break;
      case "tempo":
        this.bpm = message.bpm;
        for (const sound of [this.live, this.preview, ...this.trackSounds.values()]) if (sound instanceof EngineSound) sound.engine.setTempo(message.bpm);
        this.liveFx.setTempo(message.bpm);
        this.master.setTempo(message.bpm);
        this.song.setTempo(message.bpm);
        break;
      case "song":
        this.setSong(message.tracks);
        break;
      case "songMix":
        this.song.setMix(message.id, message.mix);
        this.trackSpecs = this.trackSpecs.map((t) => (t.id === message.id ? { ...t, ...message.mix } : t));
        break;
      case "master":
        this.masterOn = message.fx !== null;
        if (message.fx) this.master.set(message.fx);
        break;
      case "songPlay":
        this.song.play(message.atFrame, message.fromSec);
        this.master.reset();
        break;
      case "songStop":
        this.song.stop();
        break;
      case "songLoop":
        this.song.setLoop(message.loop);
        break;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    const left = output[0];
    if (!left) return true;
    const right = output[1] ?? left;
    const frames = left.length;
    // The song's tracks, mixed.
    this.song.render(currentFrame, left, right, frames);
    // The keyboard, through its effects.
    if (this.liveL.length < frames) {
      this.liveL = new Float32Array(frames);
      this.liveR = new Float32Array(frames);
    }
    if (!this.live.idle()) {
      this.live.render(this.liveL, this.liveR, frames);
      if (this.liveFxOn) this.liveFx.process(this.liveL, this.liveR, frames);
      for (let i = 0; i < frames; i++) left[i] += this.liveL[i];
      if (right !== left) for (let i = 0; i < frames; i++) right[i] += this.liveR[i];
    }
    if (!this.samplePreview.idle()) {
      this.samplePreview.render(this.liveL, this.liveR, frames);
      for (let i = 0; i < frames; i++) left[i] += this.liveL[i];
      if (right !== left) for (let i = 0; i < frames; i++) right[i] += this.liveR[i];
    }
    if (!this.preview.idle()) {
      if (this.previewNote >= 0) {
        this.previewLeft -= frames;
        if (this.previewLeft <= 0) {
          this.preview.noteOff(this.previewNote);
          this.previewNote = -1;
        }
      }
      this.preview.render(this.liveL, this.liveR, frames);
      for (let i = 0; i < frames; i++) left[i] += this.liveL[i];
      if (right !== left) for (let i = 0; i < frames; i++) right[i] += this.liveR[i];
    }
    if (this.masterOn) this.master.process(left, right, frames);
    if (++this.quanta >= STATUS_EVERY) {
      this.quanta = 0;
      let voices = this.live.engine.activeVoices();
      for (const sound of this.trackSounds.values()) {
        if (sound instanceof EngineSound) voices += sound.engine.activeVoices();
        else if (sound instanceof SampleSound) voices += sound.sounding;
      }
      if (voices !== this.lastVoices) {
        this.lastVoices = voices;
        this.port.postMessage({ type: "status", voices } satisfies FromEngine);
      }
    }
    return true;
  }
}

registerProcessor("maddaw-engine", EngineProcessor);
