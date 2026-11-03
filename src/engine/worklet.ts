// The engine inside an AudioWorklet: messages in, stereo out. Everything
// heavy (analysis, resampling) happened before the material got here; this
// only renders.
//
// It holds the materials (prepared sources) and instruments (a cut: markers
// and voice settings on a material) by id, an Engine per song track playing an
// instrument, the "live" Engine the keyboard plays, and the master effects.

import { ShortTermMeter } from "../audio/loudness";
import { FxChain } from "../fx/chain";
import type { InstrumentParams, Markers } from "../instrument/types";
import { SongPlayer, type TrackSound } from "../song/player";
import { BackingSound, ClipSound, EngineSound, SampleSound } from "../song/sounds";
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
/** Blocks between meter readings (about 20 per second). */
const METER_EVERY = 16;

interface Instrument {
  material: string;
  markers: Markers;
  params: InstrumentParams;
  /** Its material's export length (what a "stretch" sustain fills), when known. */
  hold?: number;
}

class EngineProcessor extends AudioWorkletProcessor {
  private readonly sources = new Map<string, PreparedSource | null>();
  /** Rendered one-shots (drum rows), by id. */
  private readonly samples = new Map<string, Float32Array[]>();
  private readonly samplePreview = new SampleSound();
  /** The kit on the keyboard (the kit view), and its sample ids per key. */
  private readonly liveKit = new SampleSound(sampleRate);
  private liveKitOn = false;
  private liveKitSamples: (string | null)[] = [];
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
  /** The same for a 簡易シンセ track. */
  private readonly synthPreview = new BackingSound(sampleRate);
  private synthPreviewLeft = 0;
  private synthPreviewNote = -1;
  private readonly liveFx = new FxChain(sampleRate);
  private liveFxOn = false;
  /** The keyboard through the master effects too (the 曲 view), or past them (dry). */
  private liveMaster = false;
  private readonly master = new FxChain(sampleRate);
  private masterOn = false;
  private hold = 1;
  private bpm = 120;
  private liveL = new Float32Array(128);
  private liveR = new Float32Array(128);
  private kitL = new Float32Array(128);
  private kitR = new Float32Array(128);
  private quanta = 0;
  private lastVoices = -1;
  // The meters: the output's loudest samples since the last reading, its loudness, and the tracks' peaks (from the song).
  private readonly loudness = new ShortTermMeter(sampleRate);
  private peakL = 0;
  private peakR = 0;
  private meterQuanta = 0;
  private metersQuiet = true;

  constructor() {
    super();
    this.liveKit.chokes = true;
    // A tempo change in the song reaches the master effects (and the keyboard's) too.
    this.song.onTempo = (bpm) => {
      this.master.setTempo(bpm);
      this.liveFx.setTempo(bpm);
    };
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
      sound.engine.setHold(inst.hold ?? this.hold);
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
      const kind = t.instrument === "backing" ? BackingSound : t.instrument === "drum" ? SampleSound : t.instrument === "audio" ? ClipSound : EngineSound;
      let sound = this.trackSounds.get(t.id);
      if (!(sound instanceof kind))
        sound =
          kind === EngineSound
            ? new EngineSound(sampleRate)
            : kind === SampleSound
              ? new SampleSound(sampleRate)
              : kind === ClipSound
                ? new ClipSound(sampleRate, (material) => this.sources.get(material)?.channels ?? null)
                : new BackingSound(sampleRate);
      if (sound instanceof ClipSound) sound.clips = t.clips ?? [];
      if (sound instanceof BackingSound) sound.setPreset(t.synth);
      if (sound instanceof EngineSound && sound.instrument !== t.instrument) this.apply(sound, t.instrument);
      if (sound instanceof EngineSound) sound.setGlide(t.glide ?? 0);
      if (sound instanceof SampleSound) {
        sound.rows = (t.samples ?? []).map((id) => (id ? (this.samples.get(id) ?? null) : null));
        sound.keys = t.drumKeys ?? [];
        sound.chokes = true;
      }
      next.set(t.id, sound);
    }
    this.trackSounds = next;
    this.trackSpecs = tracks;
    this.song.setTracks(tracks.map((t) => ({ ...t, sound: next.get(t.id)!, kicks: t.instrument === "drum" })));
    this.song.setTempo(this.bpm);
  }

  private handle(message: ToEngine): void {
    switch (message.type) {
      case "source":
        this.sources.set(message.material, message.source);
        this.refresh((id) => this.instruments.get(id)?.material === message.material);
        break;
      case "instrument":
        this.instruments.set(message.id, { material: message.material, markers: message.markers, params: message.params, hold: message.hold });
        this.refresh((id) => id === message.id);
        break;
      case "dropInstrument":
        this.instruments.delete(message.id);
        this.refresh((id) => id === message.id);
        break;
      case "live":
        if (this.live.instrument !== message.instrument) this.apply(this.live, message.instrument);
        if (message.fx) this.liveFx.set(message.fx);
        // (Effects all off: nothing to run for the keyboard.)
        this.liveFxOn = message.fx !== null && this.liveFx.active;
        this.liveMaster = message.master === true;
        break;
      case "noteOn":
        if (this.liveKitOn) this.liveKit.noteOn(message.note, message.velocity);
        else this.live.noteOn(message.note, message.velocity);
        break;
      case "noteOff":
        if (!this.liveKitOn) this.live.noteOff(message.note);
        break;
      case "allOff":
        this.live.allOff();
        this.liveKit.allOff();
        break;
      case "liveKit":
        this.liveKitOn = message.on;
        this.liveKitSamples = message.samples;
        this.liveKit.rows = message.samples.map((id) => (id ? (this.samples.get(id) ?? null) : null));
        this.liveKit.keys = message.keys;
        if (message.on) this.live.allOff();
        break;
      case "kitHit":
        this.liveKit.noteOn(message.key, 0.8);
        break;
      case "sample":
        if (message.channels) this.samples.set(message.id, message.channels);
        else this.samples.delete(message.id);
        // Drum tracks on it hear the new one from their next hit.
        for (const t of this.trackSpecs) {
          const sound = this.trackSounds.get(t.id);
          if (sound instanceof SampleSound) sound.rows = (t.samples ?? []).map((id) => (id ? (this.samples.get(id) ?? null) : null));
        }
        this.liveKit.rows = this.liveKitSamples.map((id) => (id ? (this.samples.get(id) ?? null) : null));
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
      case "previewSynth":
        if (this.synthPreviewNote >= 0) this.synthPreview.noteOff(this.synthPreviewNote, false);
        this.synthPreview.setPreset(message.preset);
        this.synthPreview.noteOn(message.note, 0.8, false);
        this.synthPreviewNote = message.note;
        this.synthPreviewLeft = Math.round(message.sec * sampleRate);
        break;
      case "hold":
        this.hold = message.sec;
        // (An instrument that knows its own length keeps it.)
        for (const sound of [this.live, this.preview, ...this.trackSounds.values()]) {
          if (sound instanceof EngineSound) sound.engine.setHold((sound.instrument ? this.instruments.get(sound.instrument)?.hold : undefined) ?? message.sec);
        }
        break;
      case "tempo":
        this.bpm = message.bpm;
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
      case "masterAuto":
        this.song.setMasterAuto(message.points);
        break;
      case "tempoMap":
        this.song.setTempoMap(message.points);
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

  /** What the speakers get (before the listening volume), measured; the readings go to the page while anything sounds. */
  private meter(left: Float32Array, right: Float32Array, frames: number): void {
    let pl = this.peakL;
    let pr = this.peakR;
    for (let i = 0; i < frames; i++) {
      const a = left[i] < 0 ? -left[i] : left[i];
      const b = right[i] < 0 ? -right[i] : right[i];
      if (a > pl) pl = a;
      if (b > pr) pr = b;
    }
    this.peakL = pl;
    this.peakR = pr;
    this.loudness.push(left, right, frames);
    if (++this.meterQuanta < METER_EVERY) return;
    this.meterQuanta = 0;
    const tracks = this.song.takePeaks();
    const quiet = pl < 1e-5 && pr < 1e-5 && tracks.every(([, p]) => p < 1e-5);
    // (Silence is sent once, so the meters fall to nothing, then not again until something sounds.)
    if (!(quiet && this.metersQuiet)) {
      this.port.postMessage({ type: "meters", tracks, peakL: pl, peakR: pr, momentary: this.loudness.momentary, shortTerm: this.loudness.shortTerm } satisfies FromEngine);
    }
    this.metersQuiet = quiet;
    this.peakL = 0;
    this.peakR = 0;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    const left = output[0];
    if (!left) return true;
    const right = output[1] ?? left;
    const frames = left.length;
    // The song's tracks, mixed.
    const songBeat = this.song.beatAtFrame(currentFrame);
    this.song.render(currentFrame, left, right, frames);
    // The keyboard (the cut, or the kit), through its effects (a track's, in the 曲 view):
    // before the master there, past it everywhere else.
    if (this.liveL.length < frames) {
      this.liveL = new Float32Array(frames);
      this.liveR = new Float32Array(frames);
      this.kitL = new Float32Array(frames);
      this.kitR = new Float32Array(frames);
    }
    const liveOn = !this.live.idle();
    const kitOn = !this.liveKit.idle();
    if (liveOn || kitOn || this.liveFxOn) {
      if (liveOn) this.live.render(this.liveL, this.liveR, frames);
      else {
        this.liveL.fill(0, 0, frames);
        this.liveR.fill(0, 0, frames);
      }
      if (kitOn) {
        this.liveKit.render(this.kitL, this.kitR, frames);
        for (let i = 0; i < frames; i++) {
          this.liveL[i] += this.kitL[i];
          this.liveR[i] += this.kitR[i];
        }
      }
      // (Run on while effects ring out: a reverb-like tail after the last key.)
      if (this.liveFxOn) this.liveFx.process(this.liveL, this.liveR, frames);
      if (this.liveMaster) {
        for (let i = 0; i < frames; i++) left[i] += this.liveL[i];
        if (right !== left) for (let i = 0; i < frames; i++) right[i] += this.liveR[i];
      }
    }
    // (Previews go through the kit's scratch buffers: the keyboard's, still to be added after the master, stay intact.)
    if (!this.samplePreview.idle()) {
      this.samplePreview.render(this.kitL, this.kitR, frames);
      for (let i = 0; i < frames; i++) left[i] += this.kitL[i];
      if (right !== left) for (let i = 0; i < frames; i++) right[i] += this.kitR[i];
    }
    if (!this.preview.idle()) {
      if (this.previewNote >= 0) {
        this.previewLeft -= frames;
        if (this.previewLeft <= 0) {
          this.preview.noteOff(this.previewNote);
          this.previewNote = -1;
        }
      }
      this.preview.render(this.kitL, this.kitR, frames);
      for (let i = 0; i < frames; i++) left[i] += this.kitL[i];
      if (right !== left) for (let i = 0; i < frames; i++) right[i] += this.kitR[i];
    }
    if (!this.synthPreview.idle()) {
      if (this.synthPreviewNote >= 0) {
        this.synthPreviewLeft -= frames;
        if (this.synthPreviewLeft <= 0) {
          this.synthPreview.noteOff(this.synthPreviewNote, false);
          this.synthPreviewNote = -1;
        }
      }
      this.synthPreview.render(this.kitL, this.kitR, frames);
      for (let i = 0; i < frames; i++) left[i] += this.kitL[i];
      if (right !== left) for (let i = 0; i < frames; i++) right[i] += this.kitR[i];
    }
    if (this.masterOn) {
      if (songBeat !== null) this.master.setBeat(songBeat);
      this.master.process(left, right, frames);
    }
    this.song.applyMaster(left, right, frames);
    if (!this.liveMaster && (liveOn || kitOn || this.liveFxOn)) {
      for (let i = 0; i < frames; i++) left[i] += this.liveL[i];
      if (right !== left) for (let i = 0; i < frames; i++) right[i] += this.liveR[i];
    }
    this.meter(left, right, frames);
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
