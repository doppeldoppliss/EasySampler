// Arranging the song by whole stretches (design.md 13): a blank inserted, a
// stretch deleted, or a stretch played twice — on every track at once, notes
// and lines (automation) alike, so the parts stay together.

import { newId, sortNotes, type BeatPoint, type Note, type Project } from "./model";

export type ArrangeKind = "insert" | "delete" | "duplicate";

/** A line's value at a beat (straight lines between points; flat outside them). */
function valueAt(points: readonly BeatPoint[], beat: number): number {
  if (beat <= points[0].beat) return points[0].value;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (beat <= b.beat) return b.beat > a.beat ? a.value + ((b.value - a.value) * (beat - a.beat)) / (b.beat - a.beat) : b.value;
  }
  return points[points.length - 1].value;
}

/** A line with points added at the given beats (where it already passes), so cutting there keeps its shape. */
function pinned(points: readonly BeatPoint[], beats: number[]): BeatPoint[] {
  if (!points.length) return [];
  const out = points.map((q) => ({ ...q }));
  for (const beat of beats) {
    if (out.some((q) => Math.abs(q.beat - beat) < 1e-9)) continue;
    const point = { beat, value: valueAt(out, beat) };
    const at = out.findIndex((q) => q.beat > beat);
    out.splice(at < 0 ? out.length : at, 0, point);
  }
  return out;
}

/** Removes a point that repeats the one before it exactly (same beat and value). */
function tidy(points: BeatPoint[]): BeatPoint[] {
  return points.filter((q, i) => i === 0 || q.beat !== points[i - 1].beat || q.value !== points[i - 1].value);
}

export function arrangeLine(points: readonly BeatPoint[], kind: ArrangeKind, from: number, to: number): BeatPoint[] {
  if (!points.length) return [];
  const len = to - from;
  const p = pinned(points, [from, to]);
  const shift = (q: BeatPoint, by: number) => ({ beat: q.beat + by, value: q.value });
  if (kind === "insert") {
    // The value at the insertion holds across the blank.
    return tidy([...p.filter((q) => q.beat <= from), ...p.filter((q) => q.beat >= from).map((q) => shift(q, len))]);
  }
  if (kind === "delete") {
    // Up to the cut, then (a step at the same beat) on from where the deleted stretch ended.
    return tidy([...p.filter((q) => q.beat <= from), ...p.filter((q) => q.beat >= to).map((q) => shift(q, -len))]);
  }
  // duplicate: the stretch, its copy right after it, then the rest moved along.
  return tidy([
    ...p.filter((q) => q.beat <= to),
    ...p.filter((q) => q.beat >= from && q.beat <= to).map((q) => shift(q, len)),
    ...p.filter((q) => q.beat >= to).map((q) => shift(q, len)),
  ]);
}

export function arrangeNotes(notes: readonly Note[], kind: ArrangeKind, from: number, to: number): Note[] {
  const len = to - from;
  if (kind === "insert") return sortNotes(notes.map((n) => (n.start >= from - 1e-9 ? { ...n, start: n.start + len } : { ...n })));
  if (kind === "delete") {
    const out: Note[] = [];
    for (const n of notes) {
      if (n.start >= to - 1e-9) out.push({ ...n, start: n.start - len });
      else if (n.start < from - 1e-9) {
        // A note held into the deleted stretch ends where it starts.
        out.push({ ...n, length: Math.min(n.length, from - n.start) });
      }
    }
    return sortNotes(out);
  }
  const out = notes.map((n) => (n.start >= to - 1e-9 ? { ...n, start: n.start + len } : { ...n }));
  for (const n of notes) if (n.start >= from - 1e-9 && n.start < to - 1e-9) out.push({ ...n, id: newId(), start: n.start + len });
  return sortNotes(out);
}

/** Inserts a blank of [from, to)'s length at `from`, deletes [from, to), or plays it twice — on every track and line. */
export function arrange(project: Project, kind: ArrangeKind, from: number, to: number): void {
  if (!(to > from)) return;
  for (const t of project.tracks) {
    t.notes = arrangeNotes(t.notes, kind, from, to);
    t.volumeAuto = arrangeLine(t.volumeAuto, kind, from, to);
    t.panAuto = arrangeLine(t.panAuto, kind, from, to);
  }
  project.masterAuto = arrangeLine(project.masterAuto, kind, from, to);
  // A copy: the loop moves onto it (pressing again makes the next one).
  if (kind === "duplicate") project.loop = { ...project.loop, start: to, end: to + (to - from) };
}
