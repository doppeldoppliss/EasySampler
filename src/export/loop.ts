// A loopable file (design.md 5, ループ WAV): the rendered note gets a loop
// region inside its sustain, made seamless by crossfading the end of the
// region into what precedes its start. A sampler that reads the loop (from
// the WAV's smpl chunk, the SFZ or the dspreset) can then hold the note for
// as long as it likes, at the pitch the file was rendered at.

import type { InstrumentParams } from "../instrument/types";
import type { Rendered } from "./render";

export interface Loop {
  /** Sample frames: the loop plays [start, end) and jumps back to start. */
  start: number;
  end: number;
  /** Frames of crossfade already baked into the audio before `end`. */
  crossfade: number;
}

/** The loop starts this long after the head, past the attack/decay transient. */
const SETTLE_SEC = 0.15;
/** Margin before the release. */
const END_MARGIN_SEC = 0.03;
const CROSSFADE_SEC = 0.08;
/** A loop shorter than this isn't worth having. */
const MIN_LOOP_SEC = 0.2;

/**
 * Chooses the loop region of a rendered note and makes it seamless, in
 * place. Returns null (and changes nothing) when there isn't enough sustain
 * to loop — a one-shot, or a very short hold.
 */
export function applyLoop(rendered: Rendered, params: InstrumentParams): Loop | null {
  // Nothing held to loop: a one-shot, the sustain switched off, or a level dying away (減衰) — a loop there
  // would jump back up in level on every pass.
  if (params.sustainMode === "none" || !params.sustainEnabled || params.amp.sustain < 0.05) return null;
  const rate = rendered.sampleRate;
  const frames = rendered.channels[0].length;
  const settle = Math.max(SETTLE_SEC, params.amp.attack + params.amp.decay);
  const start = Math.round((rendered.headSec + settle) * rate);
  const end = Math.min(frames, Math.round((rendered.holdEndSec - END_MARGIN_SEC) * rate));
  if (end - start < MIN_LOOP_SEC * rate) return null;
  const crossfade = Math.min(Math.round(CROSSFADE_SEC * rate), Math.floor((end - start) / 4), start);
  // Over the last `crossfade` frames of the loop, blend toward the frames just before `start`, so
  // frame `end` (= frame `start` on the jump) is reached without a step.
  for (const channel of rendered.channels) {
    for (let n = 0; n < crossfade; n++) {
      const w = 0.5 - 0.5 * Math.cos((Math.PI * (n + 1)) / (crossfade + 1)); // 0 → 1
      const i = end - crossfade + n;
      const j = start - crossfade + n;
      channel[i] = channel[i] * (1 - w) + channel[j] * w;
    }
  }
  return { start, end, crossfade };
}

/** How long a loopable file is held, at least: enough sustain to pick a loop from. */
export const LOOP_MIN_HOLD_SEC = 2;
