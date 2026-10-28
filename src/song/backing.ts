// The plain backing for "曲で試す": the song's other parts as soft
// triangle tones and drum hits made of noise and swept sines — just enough
// to hear whether the material sits in the song, cheap enough to run in the
// audio thread next to the material's voices.

const MAX_VOICES = 48;
const ATTACK_SEC = 0.004;
const RELEASE_SEC = 0.08;
const TONE_LEVEL = 0.1;
const DRUM_LEVEL = 0.35;

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
  released: boolean;
  level: number;
  env: number;
  /** Per-sample envelope multiplier while decaying (drums) or released (tones). */
  decay: number;
  phase: number;
  /** Phase step per sample (tones: fixed; kick / tom: sweeps down). */
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

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    for (let i = 0; i < MAX_VOICES; i++) {
      this.voices.push({ active: false, note: 0, drum: null, released: false, level: 0, env: 0, decay: 1, phase: 0, step: 0, stepEnd: 0, last: 0, age: 0, order: 0 });
    }
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
      v.level = DRUM_LEVEL * velocity * (kind === "hat" || kind === "click" ? 0.5 : kind === "cymbal" ? 0.4 : 1);
      v.env = 1;
      v.decay = Math.exp(Math.log(0.001) / (DECAY[kind] * sr));
      const startHz = kind === "kick" ? 150 : 120 + (note - 41) * 12;
      const endHz = kind === "kick" ? 45 : startHz * 0.6;
      v.step = startHz / sr;
      v.stepEnd = endHz / sr;
    } else {
      v.drum = null;
      v.level = TONE_LEVEL * velocity;
      v.env = 0;
      v.decay = Math.exp(Math.log(0.001) / (RELEASE_SEC * sr));
      v.step = (440 * 2 ** ((note - 69) / 12)) / sr;
      v.stepEnd = v.step;
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
    const attackStep = 1 / Math.max(1, ATTACK_SEC * this.sampleRate);
    const sweep = Math.exp(Math.log(0.5) / (0.04 * this.sampleRate));
    for (const v of this.voices) {
      if (!v.active) continue;
      const level = v.level * gain;
      for (let i = 0; i < frames; i++) {
        let s: number;
        if (v.drum === null) {
          if (v.released) v.env *= v.decay;
          else if (v.env < 1) v.env = Math.min(1, v.env + attackStep);
          // Triangle from the phase.
          const ph = v.phase - Math.floor(v.phase);
          s = ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph;
          v.phase += v.step;
        } else {
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
      if ((v.released || v.drum !== null) && v.env < 0.001) v.active = false;
    }
  }
}
