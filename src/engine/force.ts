// 強制シンセ化 (design.md 39): a pitch forced onto what has none. The engine's
// PSOLA moves a voice by its periods, so consonants, breath and noise — which
// have no period — stay as recorded. These two work on the sound itself and
// need no period, per voice, at the voice's own note:
//
//  - "comb" (共鳴): a feedback comb tuned to the note. Noise put through it
//    rings at the note and its harmonics; the grain of the voice stays.
//  - "vocoder" (ボコーダー): the sound's spectral envelope (a bank of band
//    levels) laid onto a sawtooth at the note. Everything becomes the synth;
//    the words stay as the envelope's movement.
//
// Mono in, mono out (the engine routes what is to be forced — the unvoiced
// grains, or the whole voice — through it and mixes by `amount`).

/** The comb rings about this long (seconds to 1/e), whatever the note. */
const COMB_RING_SEC = 0.06;
/** The lowest note the comb's delay holds (Hz). */
const COMB_MIN_HZ = 20;

/** The vocoder's bands: centres from 120 Hz to 10 kHz, evenly on a log scale. */
const BANDS = 16;
const BAND_LOW_HZ = 120;
const BAND_HIGH_HZ = 10000;
const BAND_Q = 5;
/** The band levels follow the sound this fast (seconds): quick up, a little slower down. */
const ENV_ATTACK_SEC = 0.002;
const ENV_RELEASE_SEC = 0.012;
/** Brings the vocoder's level to about the level of what went in (measured on voices and noise). */
const VOCODER_GAIN = 6.5;

/** The band-pass coefficients (RBJ, 0 dB at the centre) for a sample rate: b0 (b2 = −b0, b1 = 0), a1, a2 per band. */
export function vocoderBands(sampleRate: number): Float64Array {
  const out = new Float64Array(BANDS * 3);
  for (let k = 0; k < BANDS; k++) {
    const hz = Math.min(0.45 * sampleRate, BAND_LOW_HZ * (BAND_HIGH_HZ / BAND_LOW_HZ) ** (k / (BANDS - 1)));
    const w = (2 * Math.PI * hz) / sampleRate;
    const alpha = Math.sin(w) / (2 * BAND_Q);
    const a0 = 1 + alpha;
    out[k * 3] = alpha / a0;
    out[k * 3 + 1] = (-2 * Math.cos(w)) / a0;
    out[k * 3 + 2] = (1 - alpha) / a0;
  }
  return out;
}

/** One voice's state for both ways (made once per voice, cleared at each note). */
export class ForceState {
  /** The comb's delay line and where it writes. */
  private readonly delay: Float32Array;
  private at = 0;
  /** The comb: the level going in (held a while) and coming out, as powers. */
  private envIn = 0;
  private envOut = 0;
  private meanIn = 0;
  /** Per band: the modulator's filter (x1, x2, y1, y2), the carrier's (x1, x2, y1, y2), the level. */
  private readonly bank = new Float64Array(BANDS * 9);
  /** The carrier's phase (0–1). */
  private phase = 0;
  /** ±: a hair of sound at the top of the spectrum, so the filters never decay into denormals. */
  private flip = 1e-18;

  private readonly sampleRate: number;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.delay = new Float32Array(Math.ceil(sampleRate / COMB_MIN_HZ) + 4);
  }

  reset(): void {
    this.delay.fill(0);
    this.bank.fill(0);
    this.at = 0;
    this.envIn = 0;
    this.envOut = 0;
    this.meanIn = 0;
    this.phase = 0;
  }

  /** The comb, in place over `frames` samples of `x`, tuned to `hz`. */
  comb(x: Float32Array, frames: number, hz: number): void {
    const sr = this.sampleRate;
    const delay = this.delay;
    const n = delay.length;
    const f = Math.max(COMB_MIN_HZ, Math.min(0.45 * sr, hz));
    const d = sr / f;
    const g = Math.exp(-1 / (f * COMB_RING_SEC));
    // (Noise through a comb gains 1 / (1 − g²) in power: taken back out, so the level stays about the same.)
    // (× 1.4: the fractional delay dulls the loop a little, about 3 dB on noise.)
    const norm = 1.4 * Math.sqrt(1 - g * g);
    let at = this.at;
    let envIn = this.envIn;
    let envOut = this.envOut;
    let mean = this.meanIn;
    const follow = 1 - Math.exp(-1 / (0.005 * sr));
    const hold = Math.exp(-1 / (4 * COMB_RING_SEC * sr));
    for (let i = 0; i < frames; i++) {
      let read = at - d;
      if (read < 0) read += n;
      const i0 = Math.floor(read);
      const frac = read - i0;
      const a = delay[i0];
      const b = delay[i0 + 1 < n ? i0 + 1 : 0];
      const dry = x[i];
      const y = dry + g * (a + (b - a) * frac);
      delay[at] = y;
      if (++at >= n) at = 0;
      // A sound already at the note adds up in the loop (up to 1 / (1 − g), not the noise's share): the level that
      // came out is held to the level that went in — which lets go slowly, so the ring after a sound is not cut.
      const p = dry * dry;
      mean += (p - mean) * follow;
      envIn = mean > envIn * hold ? mean : envIn * hold;
      const out = y * norm;
      envOut += (out * out - envOut) * follow;
      x[i] = envOut > envIn && envOut > 1e-12 ? out * Math.sqrt(envIn / envOut) : out;
    }
    this.at = at;
    this.envIn = envIn;
    this.envOut = envOut;
    this.meanIn = mean;
  }

  /** The vocoder, in place over `frames` samples of `x`: its band levels on a sawtooth at `hz`. */
  vocoder(x: Float32Array, frames: number, hz: number, bands: Float64Array): void {
    const sr = this.sampleRate;
    const bank = this.bank;
    const step = Math.max(COMB_MIN_HZ, Math.min(0.45 * sr, hz)) / sr;
    const up = 1 - Math.exp(-1 / (ENV_ATTACK_SEC * sr));
    const down = 1 - Math.exp(-1 / (ENV_RELEASE_SEC * sr));
    let phase = this.phase;
    let flip = this.flip;
    for (let i = 0; i < frames; i++) {
      flip = -flip;
      const m = x[i] + flip;
      // The carrier: a sawtooth, its step smoothed (PolyBLEP) so high notes do not alias.
      let c = 2 * phase - 1;
      if (phase < step) {
        const t = phase / step;
        c -= t + t - t * t - 1;
      } else if (phase > 1 - step) {
        const t = (phase - 1) / step;
        c -= t * t + t + t + 1;
      }
      phase += step;
      if (phase >= 1) phase -= 1;
      let out = 0;
      for (let k = 0, s = 0, q = 0; k < BANDS; k++, s += 9, q += 3) {
        const b0 = bands[q];
        const a1 = bands[q + 1];
        const a2 = bands[q + 2];
        // The sound's band, and its level.
        const my = b0 * (m - bank[s + 1]) - a1 * bank[s + 2] - a2 * bank[s + 3];
        bank[s + 1] = bank[s];
        bank[s] = m;
        bank[s + 3] = bank[s + 2];
        bank[s + 2] = my;
        const level = my < 0 ? -my : my;
        const env = bank[s + 8];
        bank[s + 8] = env + (level - env) * (level > env ? up : down);
        // The carrier's band, at that level.
        const cy = b0 * (c - bank[s + 5]) - a1 * bank[s + 6] - a2 * bank[s + 7];
        bank[s + 5] = bank[s + 4];
        bank[s + 4] = c;
        bank[s + 7] = bank[s + 6];
        bank[s + 6] = cy;
        out += cy * bank[s + 8];
      }
      x[i] = out * VOCODER_GAIN;
    }
    this.phase = phase;
    this.flip = flip;
  }
}
