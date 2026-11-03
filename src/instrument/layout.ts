// What the output looks like in time (design.md 4, タイム): the head as
// recorded (or at its own speed), the sustain filling the note, the tail
// after it — minus the stretches that were cut out. One place to compute
// it, so the editor's "after" lane, the loop finder and the engine agree.

import type { InstrumentParams, Markers, TimeRange } from "./types";

export interface OutputLayout {
  /** Seconds of output taken by each part. */
  headSec: number;
  sustainSec: number;
  tailSec: number;
  /** Seconds of material each part uses (after removals). */
  headSrcSec: number;
  sustainSrcSec: number;
  tailSrcSec: number;
  /** How much the sustain is stretched (output ÷ source); Infinity when there is no source to stretch. */
  sustainRatio: number;
  /** True when the sustain fills the note's length (pool / loop / wavetable) rather than playing at a fixed speed. */
  elastic: boolean;
  totalSec: number;
}

/** The removals sorted, merged where they overlap, and kept inside [rangeStart, rangeEnd]. */
export function normalizeRemoved(ranges: readonly TimeRange[] | undefined, rangeStart: number, rangeEnd: number): TimeRange[] {
  const sorted = (ranges ?? [])
    .map((r) => ({ start: Math.max(rangeStart, Math.min(r.start, r.end)), end: Math.min(rangeEnd, Math.max(r.start, r.end)) }))
    .filter((r) => r.end - r.start > 1e-6)
    .sort((a, b) => a.start - b.start);
  const out: TimeRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/**
 * Display time: source time with the removed stretches closed up (the
 * editor shows the material as it will play). A source time inside a
 * removed stretch lands on the seam.
 */
/**
 * The stretches that do not play: with the sustain off (頭部だけ), everything
 * after the head; with the sustain held (伸ばす), everything after it ("tail"
 * = the part after the sustain, which only a one-shot plays). The head always plays.
 */
export function hiddenParts(markers: Markers, parts: { sustain: boolean; tail: boolean }): TimeRange[] {
  let range: TimeRange | null = null;
  if (!parts.sustain) range = { start: markers.sustainStart, end: markers.rangeEnd };
  else if (!parts.tail) range = { start: markers.sustainEnd, end: markers.rangeEnd };
  return range && range.end > range.start ? [range] : [];
}

/**
 * Which parts `params` plays: the sustain unless switched off (頭部だけ); what follows it only in a one-shot.
 * `tail` is 録音の終わりまで: the range played through once as it is, the head and the sustain not told apart.
 */
export function playedParts(params: InstrumentParams): { sustain: boolean; tail: boolean } {
  return { sustain: params.sustainEnabled, tail: params.sustainEnabled && params.sustainMode === "none" };
}

/** What `params` leaves out. */
export function hiddenPartsOf(markers: Markers, params: InstrumentParams): TimeRange[] {
  return hiddenParts(markers, playedParts(params));
}

export function collapsedTime(t: number, removed: readonly TimeRange[]): number {
  let out = t;
  for (const r of removed) {
    if (t >= r.end) out -= r.end - r.start;
    else if (t > r.start) out -= t - r.start;
  }
  return out;
}

/** The inverse of collapsedTime: the source time shown at display time `d` (never inside a removed stretch). */
export function expandedTime(d: number, removed: readonly TimeRange[]): number {
  let t = d;
  for (const r of removed) {
    if (t >= r.start) t += r.end - r.start;
    else break;
  }
  return t;
}

/** Seconds of [from, to) that are removed. */
export function removedWithin(removed: readonly TimeRange[], from: number, to: number): number {
  let sum = 0;
  for (const r of removed) sum += Math.max(0, Math.min(to, r.end) - Math.max(from, r.start));
  return sum;
}

/** Seconds of material actually used between two points. */
export function usedBetween(markers: Markers, from: number, to: number): number {
  if (to <= from) return 0;
  return to - from - removedWithin(normalizeRemoved(markers.removed, markers.rangeStart, markers.rangeEnd), from, to);
}

/**
 * The output's parts for a note held `holdSec` (the time until release).
 * For an elastic sustain the sustain fills what the head leaves of the hold;
 * with sustain mode "none" every part plays at its own speed and the hold is
 * ignored.
 */
export function outputLayout(markers: Markers, params: InstrumentParams, holdSec: number): OutputLayout {
  const resample = params.pitchMode === "resample";
  // In resample mode the speed follows the pitch; that shift isn't known here, so the layout assumes the root.
  const headSrcSec = usedBetween(markers, markers.rangeStart, markers.sustainStart);
  const sustainSrcSec = usedBetween(markers, markers.sustainStart, markers.sustainEnd);
  const skipped = !params.sustainEnabled;
  const elastic = !skipped && params.sustainMode !== "none";
  // (録音の終わりまで plays at the recording's pace throughout.)
  const headSec = headSrcSec * (skipped || elastic ? params.stretch.head : 1);
  let sustainSec: number;
  let tailSrcSec: number;
  let tailSec: number;
  if (skipped) {
    // The head only; the hold doesn't matter.
    sustainSec = 0;
    tailSrcSec = 0;
    tailSec = 0;
  } else if (elastic) {
    sustainSec = Math.max(0, holdSec - headSec);
    tailSrcSec = 0;
    tailSec = 0;
  } else {
    // 録音の終わりまで: on to the range's end, as recorded.
    sustainSec = sustainSrcSec;
    tailSrcSec = usedBetween(markers, markers.sustainEnd, markers.rangeEnd);
    tailSec = tailSrcSec;
  }
  void resample;
  return {
    headSec,
    sustainSec,
    tailSec,
    headSrcSec,
    sustainSrcSec,
    tailSrcSec,
    sustainRatio: sustainSrcSec > 0 ? sustainSec / sustainSrcSec : Infinity,
    elastic,
    totalSec: headSec + sustainSec + tailSec,
  };
}
