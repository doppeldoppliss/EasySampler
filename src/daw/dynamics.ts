// 場面の強弱 (design.md 43): a master volume line drawn from the arrangement — how thick each bar is (how many
// tracks sound in it, for how much of it, how hard), the bars gathered into scenes of about one thickness, and the
// thinner scenes brought down a little so the full ones stand out. Nothing is rendered: it reads the notes. A
// starting point, to finish by hand on the line.

import type { BeatPoint, Note } from "./model";

/** A note counts for at least this long (beats): a drum hit is a short note but fills its place in the bar. */
const MIN_NOTE_BEATS = 0.5;
/** Steps per beat the bars are looked at in. */
const STEPS = 4;
/** A bar this far (of the full thickness) from the scene so far starts a new scene. */
const SCENE_STEP = 0.08;
/** Scenes shorter than this (bars) join a neighbour: a one-bar break keeps its own drop in thickness, the line does not chase it. */
const MIN_SCENE_BARS = 2;
/**
 * The thinnest scene comes down by the whole depth, the others by their place between it and the full ones — but
 * the thinnest is taken for no thinner than half the full thickness (a lone intro does not flatten the rest) and
 * no thicker than THIN_MOST (scenes within 15% of each other are one thickness: nothing is made of that).
 */
const THIN_LEAST = 0.5;
const THIN_MOST = 0.85;
/** The line moves between two scenes over this long (beats): up before the bar line (the full scene starts at its level), down after it. */
const RAMP_BEATS = 1;

export interface Scene {
  /** Bars, [from, to). */
  from: number;
  to: number;
  /** Its thickness against the full scenes' (0–1). */
  level: number;
  /** What the line gives it (dB, 0 or under). */
  db: number;
}

/** How thick each bar is: over the tracks, the share of the bar in which each sounds, by how hard its notes are hit. */
export function barThickness(tracks: readonly (readonly Note[])[], beatsPerBar: number): number[] {
  let end = 0;
  for (const notes of tracks) for (const n of notes) end = Math.max(end, n.start + n.length);
  const bars = Math.ceil(end / beatsPerBar - 1e-9);
  const perBar = Math.max(1, Math.round(beatsPerBar * STEPS));
  const out = new Array<number>(Math.max(0, bars)).fill(0);
  for (const notes of tracks) {
    // The hardest note sounding in each step.
    const steps = new Float32Array(bars * perBar);
    for (const n of notes) {
      const from = Math.max(0, Math.floor(n.start * STEPS + 1e-6));
      const to = Math.min(steps.length, Math.ceil((n.start + Math.max(n.length, MIN_NOTE_BEATS)) * STEPS - 1e-6));
      for (let k = from; k < to; k++) if (n.velocity > steps[k]) steps[k] = n.velocity;
    }
    for (let b = 0; b < bars; b++) {
      let sum = 0;
      for (let k = 0; k < perBar; k++) sum += steps[b * perBar + k];
      out[b] += sum / perBar;
    }
  }
  return out;
}

/**
 * The song's scenes and what each comes down by: bars of about one thickness together, the thickness measured
 * against the full bars' (the 90th percentile), the thinnest scene down by `depthDb` and the others in between (in
 * 0.5 dB steps; scenes that end on the same value are one).
 */
export function scenes(thickness: readonly number[], depthDb: number): Scene[] {
  const sounding = thickness.filter((x) => x > 0).sort((a, b) => a - b);
  if (!sounding.length) return [];
  const full = sounding[Math.min(sounding.length - 1, Math.floor(sounding.length * 0.9))];
  // (A silent bar is no scene of its own: it takes the bar before it, or the first sounding one.)
  const first = thickness.find((x) => x > 0)!;
  const level: number[] = [];
  thickness.forEach((x, b) => level.push(x > 0 ? Math.min(1, x / full) : b ? level[b - 1] : Math.min(1, first / full)));
  // Cut where a bar leaves the scene so far.
  let parts: { from: number; to: number }[] = [];
  let from = 0;
  let sum = 0;
  level.forEach((x, b) => {
    if (b > from && Math.abs(x - sum / (b - from)) > SCENE_STEP) {
      parts.push({ from, to: b });
      from = b;
      sum = 0;
    }
    sum += x;
  });
  parts.push({ from, to: level.length });
  const mean = (p: { from: number; to: number }) => level.slice(p.from, p.to).reduce((a, x) => a + x, 0) / (p.to - p.from);
  // The short ones join the neighbour nearer in thickness.
  for (;;) {
    const k = parts.findIndex((p) => p.to - p.from < MIN_SCENE_BARS);
    if (k < 0 || parts.length === 1) break;
    const before = k > 0 ? Math.abs(mean(parts[k - 1]) - mean(parts[k])) : Infinity;
    const after = k < parts.length - 1 ? Math.abs(mean(parts[k + 1]) - mean(parts[k])) : Infinity;
    const j = before <= after ? k - 1 : k;
    parts = [...parts.slice(0, j), { from: parts[j].from, to: parts[j + 1].to }, ...parts.slice(j + 2)];
  }
  // (A scene is as thick as its middle bar: a one-bar break that joined it does not pull the whole scene down.)
  const median = (p: { from: number; to: number }) => level.slice(p.from, p.to).sort((a, b) => a - b)[(p.to - p.from) >> 1];
  const thinnest = Math.min(...parts.map(median));
  const floor = Math.min(THIN_MOST, Math.max(THIN_LEAST, thinnest));
  const out: Scene[] = [];
  for (const p of parts) {
    const l = median(p);
    const db = thinnest > THIN_MOST ? 0 : -Math.round(2 * depthDb * Math.min(1, Math.max(0, (1 - l) / (1 - floor)))) / 2 || 0;
    const last = out[out.length - 1];
    if (last && last.db === db) {
      last.level = (last.level * (last.to - last.from) + l * (p.to - p.from)) / (p.to - last.from);
      last.to = p.to;
    } else out.push({ from: p.from, to: p.to, level: l, db });
  }
  return out;
}

/** The master volume line for the scenes (empty when none comes down): up to a fuller scene over the last beat before it, down to a thinner one over its first beat. */
export function sceneLine(list: readonly Scene[], beatsPerBar: number): BeatPoint[] {
  if (!list.some((s) => s.db < 0)) return [];
  const value = (s: Scene) => Math.round(10 ** (s.db / 20) * 1000) / 1000;
  const points: BeatPoint[] = [{ beat: 0, value: value(list[0]) }];
  for (let k = 1; k < list.length; k++) {
    const at = list[k].from * beatsPerBar;
    const a = value(list[k - 1]);
    const b = value(list[k]);
    const ramp = Math.min(RAMP_BEATS, ((list[k].to - list[k].from) * beatsPerBar) / 2, ((list[k - 1].to - list[k - 1].from) * beatsPerBar) / 2);
    if (b > a) points.push({ beat: at - ramp, value: a }, { beat: at, value: b });
    else points.push({ beat: at, value: a }, { beat: at + ramp, value: b });
  }
  points.push({ beat: list[list.length - 1].to * beatsPerBar, value: value(list[list.length - 1]) });
  return points;
}
