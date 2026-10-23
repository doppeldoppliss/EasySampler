// Synthesis markers (シンセ化マーカー), suggested from the analysis so a freshly
// loaded material is playable straight away (design.md 4.1). They can then
// be dragged.
//
// - range: the material minus its leading and trailing silence
// - attack (end of the head): where the first proper voiced stretch begins —
//   a consonant before it is the head, played once and never stretched
// - sustain: the steadiest stretch of that voice (pitch and level both
//   holding), which is what gets drawn out while a note is held
// - tail: everything after the sustain

import type { PitchTrack } from "../analysis/pyin";
import type { Markers } from "./types";

const SILENCE_DB = 50;
/** Voice quieter than this (below the peak) is a fading edge, not the voice itself. */
const VOICE_DB = 30;
const EDGE_MARGIN_SEC = 0.01;
/** A voiced run shorter than this doesn't count as "the" voice. */
const MIN_RUN_SEC = 0.03;
/** The sustain window: this share of the voiced run, within these bounds. */
const SUSTAIN_SHARE = 0.3;
const SUSTAIN_MIN_SEC = 0.06;
const SUSTAIN_MAX_SEC = 0.4;
/** Keep the sustain this far from the run's edges where there's room (onsets and releases wobble). */
const SUSTAIN_INSET_SEC = 0.04;

export function suggestMarkers(track: PitchTrack, durationSec: number): Markers {
  const hop = track.hopSec;
  const frames = track.f0.length;
  let peak = 0;
  for (const level of track.rms) peak = Math.max(peak, level);
  const floor = peak * 10 ** (-SILENCE_DB / 20);

  // Range: trim silence at both ends.
  let first = 0;
  while (first < frames && track.rms[first] <= floor) first++;
  let last = frames - 1;
  while (last > first && track.rms[last] <= floor) last--;
  const rangeStart = Math.max(0, first * hop - EDGE_MARGIN_SEC);
  const rangeEnd = Math.min(durationSec, last * hop + EDGE_MARGIN_SEC);

  // Voiced runs within the range.
  const voiceFloor = peak * 10 ** (-VOICE_DB / 20);
  const runs: [number, number][] = [];
  let runStart = -1;
  for (let i = first; i <= last + 1; i++) {
    const voiced = i <= last && Number.isFinite(track.f0[i]) && track.rms[i] > voiceFloor;
    if (voiced && runStart < 0) runStart = i;
    if (!voiced && runStart >= 0) {
      if ((i - runStart) * hop >= MIN_RUN_SEC) runs.push([runStart, i]);
      runStart = -1;
    }
  }

  if (runs.length === 0) {
    // Nothing pitched (a hit, a breath): no head, the middle as sustain, no tail.
    const span = rangeEnd - rangeStart;
    return clampMarkers({
      rangeStart,
      rangeEnd,
      attack: rangeStart,
      sustainStart: rangeStart + span * 0.3,
      sustainEnd: rangeStart + span * 0.7,
      tailStart: rangeEnd,
    });
  }

  const attack = runs[0][0] * hop;
  // The sustain comes from the longest run (the main vowel).
  const [from, to] = runs.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
  const runSec = (to - from) * hop;
  const windowFrames = Math.max(2, Math.round(Math.min(SUSTAIN_MAX_SEC, Math.max(SUSTAIN_MIN_SEC, runSec * SUSTAIN_SHARE)) / hop));
  const inset = Math.round(SUSTAIN_INSET_SEC / hop);
  let lo = from;
  let hi = to - windowFrames;
  if (hi - lo > 2 * inset) {
    lo += inset;
    hi -= inset;
  }

  let best = lo;
  let bestCost = Infinity;
  for (let start = lo; start <= Math.max(lo, hi); start++) {
    const cost = steadinessCost(track, start, Math.min(to, start + windowFrames));
    if (cost < bestCost) {
      bestCost = cost;
      best = start;
    }
  }
  const sustainStart = best * hop;
  const sustainEnd = Math.min(to, best + windowFrames) * hop;
  return clampMarkers({ rangeStart, rangeEnd, attack, sustainStart, sustainEnd, tailStart: sustainEnd });
}

/** Markers for a cut of the material: the suggestion made within [from, to) seconds only (a second 区間 of a long clip). */
export function suggestMarkersWithin(track: PitchTrack, from: number, to: number): Markers {
  const hop = track.hopSec;
  const first = Math.max(0, Math.floor(from / hop));
  const last = Math.min(track.f0.length, Math.ceil(to / hop));
  if (last - first < 2) return clampMarkers({ rangeStart: from, rangeEnd: to, attack: from, sustainStart: from, sustainEnd: to, tailStart: to });
  const window: PitchTrack = { hopSec: hop, f0: track.f0.slice(first, last), voicedProb: track.voicedProb.slice(first, last), rms: track.rms.slice(first, last) };
  const offset = first * hop;
  const m = suggestMarkers(window, to - offset);
  return clampMarkers({
    rangeStart: Math.max(from, m.rangeStart + offset),
    rangeEnd: Math.min(to, m.rangeEnd + offset),
    attack: m.attack + offset,
    sustainStart: m.sustainStart + offset,
    sustainEnd: m.sustainEnd + offset,
    tailStart: m.tailStart + offset,
  });
}

/** How much pitch (semitones) and level (in 6 dB units) move about within frames [from, to). Lower is steadier. */
function steadinessCost(track: PitchTrack, from: number, to: number): number {
  let n = 0;
  let pitchSum = 0;
  let pitchSq = 0;
  let levelSum = 0;
  let levelSq = 0;
  for (let i = from; i < to; i++) {
    const pitch = track.f0[i];
    if (!Number.isFinite(pitch)) return Infinity;
    const db = 20 * Math.log10(Math.max(track.rms[i], 1e-9));
    n++;
    pitchSum += pitch;
    pitchSq += pitch * pitch;
    levelSum += db;
    levelSq += db * db;
  }
  if (n < 2) return Infinity;
  const pitchVar = Math.max(0, pitchSq / n - (pitchSum / n) ** 2);
  const levelVar = Math.max(0, levelSq / n - (levelSum / n) ** 2);
  return Math.sqrt(pitchVar) + Math.sqrt(levelVar) / 6;
}

/** Puts the markers back in order (range start ≤ attack ≤ sustain start < sustain end ≤ tail ≤ range end). */
export function clampMarkers(m: Markers, minSustainSec = 0.01): Markers {
  const rangeStart = Math.max(0, Math.min(m.rangeStart, m.rangeEnd - minSustainSec));
  const rangeEnd = Math.max(m.rangeEnd, rangeStart + minSustainSec);
  const attack = Math.min(Math.max(m.attack, rangeStart), rangeEnd - minSustainSec);
  const sustainStart = Math.min(Math.max(m.sustainStart, attack), rangeEnd - minSustainSec);
  const sustainEnd = Math.min(Math.max(m.sustainEnd, sustainStart + minSustainSec), rangeEnd);
  const tailStart = Math.min(Math.max(m.tailStart, sustainEnd), rangeEnd);
  return { rangeStart, rangeEnd, attack, sustainStart, sustainEnd, tailStart };
}
