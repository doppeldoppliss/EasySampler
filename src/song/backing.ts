// The plain backing (簡易シンセ): a song's parts as simple tones and drum hits
// made of noise and swept sines — enough to hear whether the material sits in
// the song, cheap enough to run in the audio thread next to the material's
// voices. The tones come in a few presets (音色: soft triangle, piano-ish,
// organ, strings, lead, 8-bit, bass, bell), each an oscillator, an envelope
// and (for some) a low-pass that closes as the note goes on.

const MAX_VOICES = 48;
const DRUM_LEVEL = 0.35;

type Wave = "tri" | "saw" | "square" | "chip" | "organ" | "fm" | "bass";

interface Preset {
  label: string;
  wave: Wave;
  /** Detuned copies of the oscillator (cents from the note, up to 3; empty = one). */
  detune: number[];
  attackSec: number;
  /** Seconds the level takes (to about −60 dB of the way) from full down to `sustain`. */
  decaySec: number;
  /** 0–1: the level held while the key is down (0: the note dies away by itself, as a piano or a bell does). */
  sustain: number;
  releaseSec: number;
  /** The low-pass (none when 0): a base, plus a multiple of the note's frequency, plus an envelope (Hz, × velocity) closing over `filterDecaySec`. */
  cutoffHz: number;
  cutoffKey: number;
  filterEnvHz: number;
  filterDecaySec: number;
  level: number;
}

/** The 簡易シンセ's tone presets (a track's 音色). "soft" is the original plain triangle. */
export const SYNTH_PRESETS = {
  soft: { label: "やわらか(三角波)", wave: "tri", detune: [], attackSec: 0.004, decaySec: 1, sustain: 1, releaseSec: 0.08, cutoffHz: 0, cutoffKey: 0, filterEnvHz: 0, filterDecaySec: 1, level: 0.1 },
  piano: { label: "ピアノ風", wave: "saw", detune: [], attackSec: 0.002, decaySec: 2.2, sustain: 0, releaseSec: 0.25, cutoffHz: 300, cutoffKey: 2, filterEnvHz: 5000, filterDecaySec: 0.5, level: 0.13 },
  organ: { label: "オルガン", wave: "organ", detune: [], attackSec: 0.006, decaySec: 1, sustain: 1, releaseSec: 0.06, cutoffHz: 0, cutoffKey: 0, filterEnvHz: 0, filterDecaySec: 1, level: 0.06 },
  strings: { label: "ストリングス", wave: "saw", detune: [-9, 0, 9], attackSec: 0.25, decaySec: 1, sustain: 1, releaseSec: 0.5, cutoffHz: 1800, cutoffKey: 3, filterEnvHz: 0, filterDecaySec: 1, level: 0.06 },
  lead: { label: "シンセリード", wave: "square", detune: [-6, 6], attackSec: 0.005, decaySec: 1, sustain: 1, releaseSec: 0.12, cutoffHz: 2500, cutoffKey: 4, filterEnvHz: 3000, filterDecaySec: 0.25, level: 0.06 },
  chip: { label: "ピコピコ(8bit)", wave: "chip", detune: [], attackSec: 0.001, decaySec: 1, sustain: 1, releaseSec: 0.03, cutoffHz: 0, cutoffKey: 0, filterEnvHz: 0, filterDecaySec: 1, level: 0.05 },
  bass: { label: "シンセベース", wave: "bass", detune: [], attackSec: 0.003, decaySec: 0.6, sustain: 0.7, releaseSec: 0.08, cutoffHz: 250, cutoffKey: 1.5, filterEnvHz: 2500, filterDecaySec: 0.18, level: 0.14 },
  bell: { label: "ベル", wave: "fm", detune: [], attackSec: 0.001, decaySec: 3, sustain: 0, releaseSec: 0.6, cutoffHz: 0, cutoffKey: 0, filterEnvHz: 0, filterDecaySec: 1, level: 0.09 },
} satisfies Record<string, Preset>;

export type SynthPreset = keyof typeof SYNTH_PRESETS;
export const DEFAULT_SYNTH: SynthPreset = "soft";

export function isSynthPreset(x: unknown): x is SynthPreset {
  return typeof x === "string" && Object.prototype.hasOwnProperty.call(SYNTH_PRESETS, x);
}

/** PolyBLEP: a saw's or a square's step smoothed over a sample each side (no aliasing whine on high notes). */
function blep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

const TAU = 2 * Math.PI;

type DrumKind = "kick" | "snare" | "hat" | "openHat" | "cymbal" | "tom" | "click";

function drumKind(pitch: number): DrumKind {
  if (pitch === 35 || pitch === 36) return "kick";
  if (pitch === 38 || pitch === 40 || pitch === 39 || pitch === 37) return "snare";
  if (pitch === 42 || pitch === 44) return "hat";
  if (pitch === 46) return "openHat";
  if (pitch === 49 || pitch === 51 || pitch === 52 || pitch === 53 || pitch === 55 || pitch === 57 || pitch === 59) return "cymbal";
  if (pitch >= 41 && pitch <= 50) return "tom";
  return "click";
}

/** Decay time (seconds to about −60 dB) for each drum. */
const DECAY: Record<DrumKind, number> = { kick: 0.35, snare: 0.18, hat: 0.05, openHat: 0.3, cymbal: 1.2, tom: 0.3, click: 0.06 };

interface BackingVoice {
  active: boolean;
  note: number;
  drum: DrumKind | null;
  /** A tone's preset (null for a drum). */
  preset: Preset | null;
  released: boolean;
  level: number;
  env: number;
  /** Per-sample envelope multiplier while decaying (drums) or released (tones). */
  decay: number;
  /** A tone: the attack is done, the level goes toward the sustain (by this per sample). */
  decaying: boolean;
  decayToSustain: number;
  /** A tone's filter envelope (1 → 0) and its per-sample multiplier; the two one-pole low-passes' states. */
  filterEnv: number;
  filterMul: number;
  lp1: number;
  lp2: number;
  velocity: number;
  /** A tone's oscillators: phases (0–1) and steps per sample (the detuned copies; the bass's second is its sub-octave, the bell's its modulator). */
  phases: Float64Array;
  steps: Float64Array;
  phase: number;
  /** Phase step per sample (tones: the note; kick / tom: sweeps down). */
  step: number;
  stepEnd: number;
  /** Previous noise sample (for the hats' high-pass). */
  last: number;
  age: number;
  order: number;
}

export class BackingSynth {
  private readonly sampleRate: number;
  private voices: BackingVoice[] = [];
  private order = 0;
  private seed = 0x1234567;
  /** The tones' preset (the drums are the same whichever it is). */
  private preset: Preset = SYNTH_PRESETS[DEFAULT_SYNTH];

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    for (let i = 0; i < MAX_VOICES; i++) {
      this.voices.push({
        active: false,
        note: 0,
        drum: null,
        preset: null,
        released: false,
        level: 0,
        env: 0,
        decay: 1,
        decaying: false,
        decayToSustain: 1,
        filterEnv: 0,
        filterMul: 1,
        lp1: 0,
        lp2: 0,
        velocity: 0,
        phases: new Float64Array(3),
        steps: new Float64Array(3),
        phase: 0,
        step: 0,
        stepEnd: 0,
        last: 0,
        age: 0,
        order: 0,
      });
    }
  }

  /** The 音色 new notes play with (an unknown id: the default). */
  setPreset(id: string | undefined): void {
    this.preset = SYNTH_PRESETS[isSynthPreset(id) ? id : DEFAULT_SYNTH];
  }

  private noise(): number {
    let x = this.seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x >>> 0;
    return this.seed / 2147483648 - 1;
  }

  noteOn(note: number, velocity: number, drum: boolean): void {
    const v = this.voices.find((x) => !x.active) ?? this.voices.reduce((a, b) => (b.order < a.order ? b : a));
    const sr = this.sampleRate;
    v.active = true;
    v.note = note;
    v.released = false;
    v.order = this.order++;
    v.age = 0;
    v.phase = 0;
    v.last = 0;
    if (drum) {
      const kind = drumKind(note);
      v.drum = kind;
      v.preset = null;
      v.level = DRUM_LEVEL * velocity * (kind === "hat" || kind === "click" ? 0.5 : kind === "cymbal" ? 0.4 : 1);
      v.env = 1;
      v.decay = Math.exp(Math.log(0.001) / (DECAY[kind] * sr));
      const startHz = kind === "kick" ? 150 : 120 + (note - 41) * 12;
      const endHz = kind === "kick" ? 45 : startHz * 0.6;
      v.step = startHz / sr;
      v.stepEnd = endHz / sr;
    } else {
      const p = this.preset;
      v.drum = null;
      v.preset = p;
      v.velocity = velocity;
      v.level = p.level * velocity;
      v.env = 0;
      v.decaying = false;
      v.decay = Math.exp(Math.log(0.001) / (p.releaseSec * sr));
      v.decayToSustain = Math.exp(Math.log(0.001) / (p.decaySec * sr));
      v.filterEnv = 1;
      v.filterMul = Math.exp(Math.log(0.001) / (p.filterDecaySec * sr));
      v.lp1 = 0;
      v.lp2 = 0;
      v.step = (440 * 2 ** ((note - 69) / 12)) / sr;
      v.stepEnd = v.step;
      const copies = p.detune.length || 1;
      for (let k = 0; k < 3; k++) {
        // (Each copy starts elsewhere in its cycle: copies started together would add up to a click.)
        v.phases[k] = (k * 0.37) % 1;
        v.steps[k] = k < copies ? v.step * 2 ** ((p.detune[k] ?? 0) / 1200) : 0;
      }
      if (p.wave === "bass") v.steps[1] = v.step / 2;
      if (p.wave === "fm") v.steps[1] = v.step * 3.5;
    }
  }

  noteOff(note: number, drum: boolean): void {
    if (drum) return; // drums ring out on their own
    for (const v of this.voices) if (v.active && !v.drum && !v.released && v.note === note) v.released = true;
  }

  /** Everything fades out over a few ms (a loop's wrap, a stop): no click. */
  allOff(): void {
    const quick = Math.exp(Math.log(0.001) / (0.006 * this.sampleRate));
    for (const v of this.voices) {
      if (!v.active) continue;
      v.released = true;
      v.decay = Math.min(v.decay, quick);
    }
  }

  /** Nothing sounding. */
  idle(): boolean {
    return !this.voices.some((v) => v.active);
  }

  /** Adds `frames` samples into the outputs at `gain` (once, when both are the same array). */
  renderAdd(outL: Float32Array, outR: Float32Array, frames: number, gain: number): void {
    const stereo = outR !== outL;
    const sweep = Math.exp(Math.log(0.5) / (0.04 * this.sampleRate));
    for (const v of this.voices) {
      if (!v.active) continue;
      const level = v.level * gain;
      for (let i = 0; i < frames; i++) {
        let s: number;
        if (v.drum === null) s = this.tone(v);
        else {
          v.env *= v.decay;
          switch (v.drum) {
            case "kick":
            case "tom": {
              s = Math.sin(2 * Math.PI * v.phase);
              v.phase += v.step;
              v.step = v.stepEnd + (v.step - v.stepEnd) * sweep;
              if (v.drum === "tom") s = 0.8 * s + 0.2 * this.noise();
              break;
            }
            case "snare": {
              s = 0.7 * this.noise() + 0.3 * Math.sin(2 * Math.PI * v.phase);
              v.phase += 190 / this.sampleRate;
              break;
            }
            case "hat":
            case "openHat":
            case "cymbal":
            case "click": {
              // First difference: noise tilted toward the highs.
              const n = this.noise();
              s = (n - v.last) * 0.5;
              v.last = n;
              break;
            }
          }
        }
        const out = s * v.env * level;
        outL[i] += out;
        if (stereo) outR[i] += out;
      }
      v.age += frames;
      // (A tone with no sustain dies away by itself, held or not.)
      if ((v.released || v.drum !== null || (v.preset?.sustain === 0 && v.decaying)) && v.env < 0.001) v.active = false;
    }
  }

  /** One sample of a tone: its envelope, its oscillator(s), its low-pass. */
  private tone(v: BackingVoice): number {
    const p = v.preset!;
    const sr = this.sampleRate;
    if (v.released) v.env *= v.decay;
    else if (!v.decaying) {
      v.env += 1 / Math.max(1, p.attackSec * sr);
      if (v.env >= 1) {
        v.env = 1;
        v.decaying = true;
      }
    } else if (p.sustain < 1) v.env = p.sustain + (v.env - p.sustain) * v.decayToSustain;
    const ph = v.phases;
    const st = v.steps;
    let s = 0;
    switch (p.wave) {
      case "tri": {
        const t = ph[0];
        s = t < 0.5 ? 4 * t - 1 : 3 - 4 * t;
        break;
      }
      case "saw":
      case "square": {
        const copies = p.detune.length || 1;
        for (let k = 0; k < copies; k++) {
          const t = ph[k];
          const dt = st[k];
          if (p.wave === "saw") s += 2 * t - 1 - blep(t, dt);
          else {
            const u = t + 0.5 - Math.floor(t + 0.5);
            s += (t < 0.5 ? 1 : -1) + blep(t, dt) - blep(u, dt);
          }
        }
        s /= Math.sqrt(copies);
        break;
      }
      case "chip":
        // A bare square, steps and all: the 8-bit sound is the edge.
        s = ph[0] < 0.5 ? 1 : -1;
        break;
      case "organ": {
        // Three drawbars: the note, its octave and the twelfth.
        const a = TAU * ph[0];
        s = Math.sin(a) + 0.5 * Math.sin(2 * a) + 0.3 * Math.sin(3 * a);
        break;
      }
      case "bass": {
        const t = ph[0];
        s = 0.7 * (2 * t - 1 - blep(t, st[0])) + 0.6 * Math.sin(TAU * ph[1]);
        break;
      }
      case "fm": {
        // A bell: a sine bent by another 3.5 times as fast, less and less as it rings.
        const index = 0.5 + 3.5 * v.env;
        s = Math.sin(TAU * ph[0] + index * Math.sin(TAU * ph[1]));
        break;
      }
    }
    for (let k = 0; k < 3; k++) {
      ph[k] += st[k];
      if (ph[k] >= 1) ph[k] -= 1;
    }
    if (p.cutoffHz > 0) {
      const hz = p.cutoffHz + p.cutoffKey * v.step * sr + p.filterEnvHz * v.velocity * v.filterEnv;
      v.filterEnv *= v.filterMul;
      const w = (TAU * Math.min(hz, 0.45 * sr)) / sr;
      const a = w / (1 + w);
      v.lp1 += a * (s - v.lp1);
      v.lp2 += a * (v.lp1 - v.lp2);
      s = v.lp2;
    }
    return s;
  }
}
