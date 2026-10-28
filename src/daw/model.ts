// The song as it is edited (design.md 13): notes in beats, not seconds, so the
// grid, copying and a tempo change all stay exact. Seconds only appear when the
// notes are handed to the player.

import { sanitizeFx } from "../export/settings";
import { DEFAULT_FX, type FxSettings } from "../instrument/types";
import type { SeqNote } from "../song/parts";
import type { SongNote } from "../song/midi";

export interface Note {
  /** Unique within its track (for selection; not saved meaningfully across sessions). */
  id: number;
  /** Beats (quarter notes) from the start of the song. */
  start: number;
  /** Beats; always > 0. */
  length: number;
  /** MIDI note, 0–127. */
  pitch: number;
  /** 0–1. */
  velocity: number;
}

export interface Track {
  /** Stable within the project (the mixer and the audio thread know a track by it). */
  id: string;
  name: string;
  /** "melodic": one cut played at the notes' pitches. "drum": one row per pad, each pad a cut played as recorded. */
  kind: "melodic" | "drum";
  /** The cut it plays: "materialId/cutId" (design.md 13.1, a track = one cut), BACKING (簡易シンセ), or null when none is chosen. */
  instrument: string | null;
  /** A drum track's rows, top to bottom; a note's pitch is its row's index. */
  pads: Pad[];
  notes: Note[];
  /** The track's effects (design.md 13.1: effects are the song side's, not the cut's). */
  fx: FxSettings;
  /** Linear volume (1 = as is). */
  gain: number;
  /** −1 (left) … 1 (right). */
  pan: number;
  mute: boolean;
  solo: boolean;
  /** Portamento (seconds; 0 = off): notes that touch or overlap slide from one to the next, one at a time. */
  glide: number;
  /** 語尾を収める: the tail is started early so it ends where the note does (otherwise it rings on after it). */
  tailFit: boolean;
}

export interface Pad {
  /** The cut the row plays (as recorded, once per note), BACKING for the plain drum sound, or null. */
  instrument: string | null;
  /** The GM drum key the row stands for (its plain drum sound, and its key in a MIDI file). */
  key?: number;
}

/** A track or a drum row that plays the plain backing synth (簡易シンセ) instead of a cut: what a MIDI file's parts start on. */
export const BACKING = "backing";

export function newTrack(name: string, instrument: string | null = null): Track {
  return { id: newTrackId(), name, kind: "melodic", instrument, pads: [], notes: [], fx: structuredClone(DEFAULT_FX), gain: 1, pan: 0, mute: false, solo: false, glide: 0, tailFit: false };
}

/** A drum track: its first row plays the given cut (if any). */
export function newDrumTrack(name: string, instrument: string | null = null): Track {
  return { ...newTrack(name, null), kind: "drum", pads: instrument ? [{ instrument }] : [] };
}

/** A drum track loses a row: its notes go, the rows below move up. */
export function removePad(track: Track, index: number): void {
  track.pads.splice(index, 1);
  track.notes = track.notes.filter((n) => n.pitch !== index).map((n) => (n.pitch > index ? { ...n, pitch: n.pitch - 1 } : n));
}

export function newTrackId(): string {
  return `t${Math.random().toString(36).slice(2, 9)}`;
}

/** A material in the project: its samples and settings are kept under their own keys (audio:id, settings:id). */
export interface ProjectMaterial {
  id: string;
  name: string;
}

export interface Project {
  version: 1;
  bpm: number;
  /** Beats in a bar (4/4 for now: no time-signature changes, design.md 13). */
  beatsPerBar: number;
  tracks: Track[];
  /** The materials, in the order they were opened. */
  materials: ProjectMaterial[];
  /** The material shown in the editor. */
  editing: string | null;
  /** The loop in beats, and whether playback follows it. */
  loop: { start: number; end: number; on: boolean };
  /** Effects on the whole mix. */
  masterFx: FxSettings;
}

export const MIN_LENGTH = 1 / 64;
export const DEFAULT_VELOCITY = 0.8;
/** Portamento: a note that ends where the next (of another pitch) starts is held this much longer, so the next one starts while it is still held and slides from it. */
const LEGATO_OVERLAP_SEC = 0.002;

export function emptyProject(): Project {
  return { version: 1, bpm: 120, beatsPerBar: 4, tracks: [newTrack("トラック 1")], materials: [], editing: null, loop: { start: 0, end: 16, on: false }, masterFx: structuredClone(DEFAULT_FX) };
}

let nextId = 1;
export function newId(): number {
  return nextId++;
}

/** Notes sorted by start then pitch (the order they are kept and drawn in). */
export function sortNotes(notes: Note[]): Note[] {
  return notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

/** The nearest grid line (beats); a grid of 0 leaves the value as it is. */
export function snap(beat: number, grid: number): number {
  return grid > 0 ? Math.round(beat / grid) * grid : beat;
}

/** The grid line at or before a value. */
export function snapDown(beat: number, grid: number): number {
  return grid > 0 ? Math.floor(beat / grid + 1e-9) * grid : beat;
}

export function clampPitch(pitch: number): number {
  return Math.max(0, Math.min(127, Math.round(pitch)));
}

/** Where the last note ends (beats). */
export function songEnd(notes: readonly Note[]): number {
  let end = 0;
  for (const n of notes) end = Math.max(end, n.start + n.length);
  return end;
}

export function beatsToSec(beats: number, bpm: number): number {
  return (beats * 60) / bpm;
}

export function secToBeats(sec: number, bpm: number): number {
  return (sec * bpm) / 60;
}

/**
 * The notes as the player takes them (seconds). A note that overlaps the next
 * one of the same pitch is cut short where that one starts, so the re-strike is
 * heard (the engine has one voice per key). With `legato` (a track with portamento), a
 * note that ends right where one of another pitch starts overlaps it a little.
 */
export function toSeqNotes(notes: readonly Note[], bpm: number, legato = false): SeqNote[] {
  const sorted = [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const out: SeqNote[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i];
    let end = n.start + n.length;
    for (let j = i + 1; j < sorted.length && sorted[j].start < end; j++) {
      if (sorted[j].pitch === n.pitch && sorted[j].start > n.start) {
        end = sorted[j].start;
        break;
      }
    }
    let endSec = beatsToSec(Math.max(n.start + MIN_LENGTH, end), bpm);
    if (legato && sorted.some((m) => m.pitch !== n.pitch && m.start > n.start && Math.abs(m.start - end) < 1e-6)) endSec += LEGATO_OVERLAP_SEC;
    out.push({ start: beatsToSec(n.start, bpm), end: endSec, note: n.pitch, velocity: n.velocity, drum: false });
  }
  return out;
}

/** A MIDI file's part as editable notes (beats as written, whatever the file's tempo). */
export function fromSongNotes(notes: readonly SongNote[]): Note[] {
  return sortNotes(
    notes.map((n) => ({
      id: newId(),
      start: n.startBeat,
      length: Math.max(MIN_LENGTH, n.endBeat - n.startBeat),
      pitch: n.pitch,
      velocity: Math.max(0.05, Math.min(1, n.velocity / 127)),
    })),
  );
}

/** Copies of notes, moved by `dBeats` and `dPitch`, with fresh ids. */
export function shifted(notes: readonly Note[], dBeats: number, dPitch: number): Note[] {
  return notes.map((n) => ({ ...n, id: newId(), start: Math.max(0, n.start + dBeats), pitch: clampPitch(n.pitch + dPitch) }));
}

/** A project read back from storage or a file: anything missing or odd is put right. */
export function sanitizeProject(raw: unknown): Project {
  const d = emptyProject();
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, fallback: number, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback);
  const tracks = Array.isArray(r.tracks)
    ? r.tracks.map((t, i) => {
        const tr = (t && typeof t === "object" ? t : {}) as Record<string, unknown>;
        const notes = Array.isArray(tr.notes)
          ? tr.notes
              .filter((n): n is Record<string, unknown> => !!n && typeof n === "object")
              .map((n) => ({
                id: newId(),
                start: num(n.start, 0, 0, 100_000),
                length: num(n.length, 1, MIN_LENGTH, 10_000),
                pitch: clampPitch(num(n.pitch, 60, 0, 127)),
                velocity: num(n.velocity, DEFAULT_VELOCITY, 0.01, 1),
              }))
          : [];
        return {
          id: typeof tr.id === "string" && tr.id ? tr.id : newTrackId(),
          name: typeof tr.name === "string" && tr.name ? tr.name : `トラック ${i + 1}`,
          kind: tr.kind === "drum" ? ("drum" as const) : ("melodic" as const),
          instrument: typeof tr.instrument === "string" && (tr.instrument.includes("/") || tr.instrument === BACKING) ? tr.instrument : null,
          pads: Array.isArray(tr.pads)
            ? tr.pads.map((p) => {
                const pad = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
                const key = typeof pad.key === "number" && Number.isFinite(pad.key) ? Math.max(0, Math.min(127, Math.round(pad.key))) : undefined;
                return { instrument: typeof pad.instrument === "string" && (pad.instrument.includes("/") || pad.instrument === BACKING) ? pad.instrument : null, ...(key === undefined ? {} : { key }) };
              })
            : [],
          notes: sortNotes(notes),
          fx: sanitizeFx(tr.fx),
          gain: num(tr.gain, 1, 0, 4),
          pan: num(tr.pan, 0, -1, 1),
          mute: tr.mute === true,
          solo: tr.solo === true,
          glide: num(tr.glide, 0, 0, 2),
          tailFit: tr.tailFit === true,
        };
      })
    : d.tracks;
  const loop = (r.loop && typeof r.loop === "object" ? r.loop : {}) as Record<string, unknown>;
  const start = num(loop.start, d.loop.start, 0, 100_000);
  const end = num(loop.end, d.loop.end, 0, 100_000);
  return {
    version: 1,
    bpm: num(r.bpm, d.bpm, 20, 400),
    beatsPerBar: Math.round(num(r.beatsPerBar, 4, 1, 16)),
    tracks: tracks.length ? tracks : d.tracks,
    materials: Array.isArray(r.materials)
      ? r.materials
          .filter((m): m is Record<string, unknown> => !!m && typeof m === "object" && typeof (m as Record<string, unknown>).id === "string")
          .map((m) => ({ id: m.id as string, name: typeof m.name === "string" ? m.name : "素材" }))
      : [],
    editing: typeof r.editing === "string" ? r.editing : null,
    loop: end > start ? { start, end, on: loop.on === true } : d.loop,
    masterFx: sanitizeFx(r.masterFx),
  };
}
