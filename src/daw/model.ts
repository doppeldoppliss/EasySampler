// The song as it is edited (design.md 13): notes in beats, not seconds, so the
// grid, copying and a tempo change all stay exact. Seconds only appear when the
// notes are handed to the player.

import { sanitizeFx } from "../export/settings";
import { emptyKit, sanitizeKit, type Kit } from "./kit";
import { DEFAULT_FX, type FxSettings } from "../instrument/types";
import { DEFAULT_SYNTH, isSynthPreset, type SynthPreset } from "../song/backing";
import type { Role } from "./roles";

const ROLES: readonly Role[] = ["drum", "audio", "bass", "lead", "chords", "backing", "harmony"];
import type { SeqNote } from "../song/parts";
import type { SongNote } from "../song/midi";
import type { AutoPoint } from "../song/player";

export interface Note {
  /** Unique within its track (for selection; not saved meaningfully across sessions). */
  id: number;
  /** Beats (quarter notes) from the start of the song. */
  start: number;
  /** Beats; always > 0. */
  length: number;
  /** MIDI note, 0–127. */
  pitch: number;
  /** 0–1 (an audio track's clip: its volume). */
  velocity: number;
  /** An audio track's clip: the material it plays, from `offset` seconds into its recording (at its own speed and pitch). */
  clip?: { material: string; offset: number };
}

export interface Track {
  /** Stable within the project (the mixer and the audio thread know a track by it). */
  id: string;
  name: string;
  /**
   * "melodic": one cut played at the notes' pitches. "drum": the project's drum kit, a note's pitch being its GM drum key (design.md 13.2).
   * "audio": recordings placed on the timeline, each note a clip (`Note.clip`) on one row.
   */
  kind: "melodic" | "drum" | "audio";
  /** The cut it plays: "materialId/cutId" (design.md 13.1, a track = one cut), BACKING (簡易シンセ), or null when none is chosen. An audio track: the material a new clip plays. */
  instrument: string | null;
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
  /** On the 簡易シンセ (instrument BACKING): its 音色 (SYNTH_PRESETS). */
  synth: SynthPreset;
  /** Its part in the song set by hand (ミックス view), or null: worked out from the notes (roles.ts). */
  role: Role | null;
  /** The main one of its part, set by hand (ベース(メイン)): 音量を合わせる gives it the largest share of the part. */
  main: boolean;
  /** ハモリ (a melodic track): notes added in the key, played by the same cut. */
  harmony: Harmony;
  /** What a note placed on this track gets: its length (beats) and velocity (0–1) (Domino's default Gate / Velocity). */
  noteLength: number;
  noteVelocity: number;
  /** The volume line (a factor on `gain`, 0–2) and the pan line (−1…1, in place of `pan`); empty = none. */
  volumeAuto: BeatPoint[];
  panAuto: BeatPoint[];
}

/**
 * ハモリ: every note of the track gets company `voices` scale steps away in the key (`key` 0 = C … 11 = B, major
 * or natural minor): 2 = a third up, -2 a third down, 4 a fifth up, 7 an octave up. The added notes are as long as
 * theirs, `level` as strong. Not with portamento (the track is one note at a time then).
 */
export interface Harmony {
  on: boolean;
  key: number;
  minor: boolean;
  voices: number[];
  level: number;
}

export const DEFAULT_HARMONY: Harmony = { on: false, key: 0, minor: false, voices: [2], level: 0.8 };

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];

/** A pitch moved `steps` along the key's scale (a note off the scale keeps how far off it was, from the step under it). */
export function harmonizePitch(pitch: number, steps: number, key: number, minor: boolean): number {
  const scale = minor ? MINOR : MAJOR;
  const rel = (((pitch - key) % 12) + 12) % 12;
  let degree = 0;
  for (let d = 0; d < 7; d++) if (scale[d] <= rel) degree = d;
  const off = rel - scale[degree];
  const target = degree + steps;
  const octave = Math.floor(target / 7);
  const moved = pitch - rel + 12 * octave + scale[((target % 7) + 7) % 7] + off;
  return Math.max(0, Math.min(127, moved));
}

/** A track's notes with its ハモリ added (as they are, when it has none, or slides). */
export function withHarmony(notes: readonly Note[], harmony: Harmony | undefined, glide = 0): Note[] {
  if (!harmony?.on || !harmony.voices.length || glide > 0) return [...notes];
  const added: Note[] = [];
  // (A voice landing on a pitch already sounding then — written, or added for another note of a chord — is left
  // out: two notes on one pitch would double it and cut each other off.)
  const sounding = (pitch: number, n: Note) => [...notes, ...added].some((m) => m.pitch === pitch && m.start < n.start + n.length && m.start + m.length > n.start);
  for (const n of notes) {
    for (const steps of harmony.voices) {
      const pitch = harmonizePitch(n.pitch, steps, harmony.key, harmony.minor);
      if (!sounding(pitch, n)) added.push({ ...n, pitch, velocity: Math.max(0.01, Math.min(1, n.velocity * harmony.level)) });
    }
  }
  return [...notes, ...added];
}

/**
 * The key the notes are most likely in (Krumhansl–Schmuckler: the pitch classes, weighted by length, against each
 * key's profile).
 */
export function estimateKey(notes: readonly Note[]): { key: number; minor: boolean } {
  const major = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const minor = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const hist = new Array(12).fill(0);
  for (const n of notes) hist[((n.pitch % 12) + 12) % 12] += n.length;
  const corr = (a: number[], b: number[]) => {
    const ma = a.reduce((x, y) => x + y, 0) / 12;
    const mb = b.reduce((x, y) => x + y, 0) / 12;
    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = 0; i < 12; i++) {
      num += (a[i] - ma) * (b[i] - mb);
      da += (a[i] - ma) ** 2;
      db += (b[i] - mb) ** 2;
    }
    return da && db ? num / Math.sqrt(da * db) : 0;
  };
  let best = { key: 0, minor: false, score: -Infinity };
  for (let key = 0; key < 12; key++) {
    const rotated = hist.map((_, i) => hist[(i + key) % 12]);
    for (const [isMinor, profile] of [[false, major], [true, minor]] as const) {
      const score = corr(rotated, profile);
      if (score > best.score) best = { key, minor: isMinor, score };
    }
  }
  return { key: best.key, minor: best.minor };
}

/** A point of an automation line, in beats (straight lines between points, sorted by beat). */
export interface BeatPoint {
  beat: number;
  value: number;
}

/** What a volume line point may be (a factor: 1 = the fader's level, 2 = +6 dB). */
export const VOLUME_AUTO_MAX = 2;

/** A line as the player takes it (seconds). */
export function autoToSec(points: readonly BeatPoint[], tempo: Tempo): AutoPoint[] {
  return points.map((q) => ({ sec: beatsToSec(q.beat, tempo), value: q.value }));
}

/** A tempo change: from this beat on, this tempo (the song's start has `Project.bpm`). */
export interface TempoChange {
  beat: number;
  bpm: number;
}

/** A fixed tempo, or a song's tempo map (its starting tempo and the changes after it, sorted by beat). */
export type Tempo = number | { bpm: number; tempos?: readonly TempoChange[] };

/** The tempo at a beat. */
export function tempoAt(beat: number, tempo: Tempo): number {
  if (typeof tempo === "number") return tempo;
  let bpm = tempo.bpm;
  for (const c of tempo.tempos ?? []) {
    if (c.beat > beat) break;
    bpm = c.bpm;
  }
  return bpm;
}

/** The tempo map in seconds (where each tempo starts), for the player's tempo-synced effects. */
export function tempoMapSec(tempo: Tempo): { sec: number; bpm: number }[] {
  if (typeof tempo === "number") return [{ sec: 0, bpm: tempo }];
  return [{ sec: 0, bpm: tempo.bpm }, ...(tempo.tempos ?? []).map((c) => ({ sec: beatsToSec(c.beat, tempo), bpm: c.bpm }))];
}

/** A tempo list (the start's first) tidied: sorted, in range, repeats of the tempo before dropped; written to the project. */
export function setTempoList(project: Project, list: readonly TempoChange[]): void {
  const sorted = [...list].filter((c) => Number.isFinite(c.beat) && Number.isFinite(c.bpm)).sort((a, b) => a.beat - b.beat);
  const start = sorted.find((c) => c.beat <= 1e-9)?.bpm ?? project.bpm;
  const out: TempoChange[] = [];
  let last = Math.max(20, Math.min(400, start));
  for (const c of sorted) {
    if (c.beat <= 1e-9) continue;
    const bpm = Math.max(20, Math.min(400, c.bpm));
    // (Several at one beat: the last one counts.)
    if (out.length && Math.abs(out[out.length - 1].beat - c.beat) < 1e-9) out.pop();
    const before = out.length ? out[out.length - 1].bpm : last;
    if (bpm === before) continue;
    out.push({ beat: c.beat, bpm });
  }
  project.bpm = last;
  project.tempos = out;
}

/** The denominators a time signature may have. */
export const TIME_SIG_DENS = [2, 4, 8, 16] as const;

/** A time signature into the project (and the bar length that follows from it). */
export function setTimeSig(project: Project, num: number, den: number): void {
  const n = Math.max(1, Math.min(16, Math.round(num) || 4));
  const d = (TIME_SIG_DENS as readonly number[]).includes(den) ? den : 4;
  project.timeSig = { num: n, den: d };
  project.beatsPerBar = (n * 4) / d;
}

/** A track that plays the plain backing synth (簡易シンセ) instead of a cut: what a MIDI file's parts start on. */
export const BACKING = "backing";

export function newTrack(name: string, instrument: string | null = null): Track {
  return { id: newTrackId(), name, kind: "melodic", instrument, notes: [], fx: structuredClone(DEFAULT_FX), gain: 1, pan: 0, mute: false, solo: false, glide: 0, synth: DEFAULT_SYNTH, role: null, main: false, harmony: structuredClone(DEFAULT_HARMONY), noteLength: 1, noteVelocity: DEFAULT_VELOCITY, volumeAuto: [], panAuto: [] };
}

/** An audio track: clips of materials on the timeline (a new clip plays `material`). */
export function newAudioTrack(name: string, material: string | null): Track {
  return { ...newTrack(name, material), kind: "audio" };
}

/** A drum track: it plays the project's kit, its notes on GM drum keys. */
export function newDrumTrack(name: string): Track {
  return { ...newTrack(name, null), kind: "drum" };
}

export function newTrackId(): string {
  return `t${Math.random().toString(36).slice(2, 9)}`;
}

/** A material in the project: its samples and settings are kept under their own keys (audio:id, settings:id). */
export interface ProjectMaterial {
  id: string;
  name: string;
  /** A long recording (原曲・伴奏) for audio tracks only: no pitch analysis, no cuts, not on the 素材 side. */
  long?: boolean;
}

export interface Project {
  version: 1;
  bpm: number;
  /** The time signature (one for the whole song: no changes). */
  timeSig: { num: number; den: number };
  /** A bar's length in beats (quarter notes): `timeSig.num × 4 / timeSig.den` (6/8 → 3). */
  beatsPerBar: number;
  tracks: Track[];
  /** The materials, in the order they were opened. */
  materials: ProjectMaterial[];
  /** The material shown in the editor. */
  editing: string | null;
  /** The loop in beats, and whether playback follows it. */
  loop: { start: number; end: number; on: boolean };
  /** Tempo changes after the start (sorted by beat; the start's tempo is `bpm`). */
  tempos: TempoChange[];
  /** Effects on the whole mix. */
  masterFx: FxSettings;
  /** The master volume line (a factor, 0–2, after the master effects); empty = none. */
  masterAuto: BeatPoint[];
  /** ベースの強さ: how far over its usual level 音量を合わせる puts the bass (dB; 0, 3 or 6). */
  bassLevelDb: number;
  /** The drum kit the drum tracks and the kit view's keyboard play (design.md 13.2). */
  kit: Kit;
  /** Named places in the song (Aメロ, サビ…), sorted by beat. */
  markers: Marker[];
}

/** A named place in the song. */
export interface Marker {
  beat: number;
  name: string;
}

export const MIN_LENGTH = 1 / 64;
export const DEFAULT_VELOCITY = 0.8;
/** Portamento: a note that ends where the next (of another pitch) starts is held this much longer, so the next one starts while it is still held and slides from it. */
const LEGATO_OVERLAP_SEC = 0.002;

/** A track's volume at most: +6 dB. */
export const MAX_TRACK_GAIN = 10 ** (6 / 20);
/** The fader's bottom (dB): below it, silence. */
export const FADER_FLOOR_DB = -60;
/** A gain as the fader shows it (dB; the floor for silence). */
export function gainToDb(gain: number): number {
  return gain > 10 ** (FADER_FLOOR_DB / 20) ? 20 * Math.log10(gain) : FADER_FLOOR_DB;
}
/** The fader's dB as a gain (the floor = silence). */
export function dbToGain(db: number): number {
  return db <= FADER_FLOOR_DB ? 0 : Math.min(MAX_TRACK_GAIN, 10 ** (db / 20));
}

export function emptyProject(): Project {
  return { version: 1, bpm: 120, timeSig: { num: 4, den: 4 }, beatsPerBar: 4, tracks: [newTrack("トラック 1")], materials: [], editing: null, loop: { start: 0, end: 16, on: false }, tempos: [], masterFx: structuredClone(DEFAULT_FX), masterAuto: [], bassLevelDb: 0, kit: emptyKit(), markers: [] };
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

/** Beats from the song's start → seconds, through the tempo (a fixed one, or the song's map). */
export function beatsToSec(beats: number, tempo: Tempo): number {
  if (typeof tempo === "number") return (beats * 60) / tempo;
  let sec = 0;
  let at = 0;
  let bpm = tempo.bpm;
  for (const c of tempo.tempos ?? []) {
    if (c.beat >= beats) break;
    sec += ((c.beat - at) * 60) / bpm;
    at = c.beat;
    bpm = c.bpm;
  }
  return sec + ((beats - at) * 60) / bpm;
}

export function secToBeats(sec: number, tempo: Tempo): number {
  if (typeof tempo === "number") return (sec * tempo) / 60;
  let at = 0;
  let atSec = 0;
  let bpm = tempo.bpm;
  for (const c of tempo.tempos ?? []) {
    const cSec = atSec + ((c.beat - at) * 60) / bpm;
    if (cSec >= sec) break;
    at = c.beat;
    atSec = cSec;
    bpm = c.bpm;
  }
  return at + ((sec - atSec) * bpm) / 60;
}

/**
 * The notes as the player takes them (seconds). A note that overlaps the next
 * one of the same pitch is cut short where that one starts, so the re-strike is
 * heard (the engine has one voice per key). With `legato` (a track with portamento), a
 * note that ends right where one of another pitch starts overlaps it a little.
 */
export function toSeqNotes(notes: readonly Note[], bpm: Tempo, legato = false): SeqNote[] {
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

/** An audio track's clips as the player takes them: note i is clip i (`clips[i]`), from its start to its end (seconds). */
export function clipsToSeq(notes: readonly Note[], tempo: Tempo): { notes: SeqNote[]; clips: { material: string; offsetSec: number }[] } {
  const playing = notes.filter((n) => n.clip);
  return {
    notes: playing.map((n, i) => ({ start: beatsToSec(n.start, tempo), end: beatsToSec(n.start + n.length, tempo), note: i, velocity: n.velocity, drum: false })),
    clips: playing.map((n) => ({ material: n.clip!.material, offsetSec: n.clip!.offset })),
  };
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
function sanitizeHarmony(raw: unknown): Harmony {
  const h = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const voices = Array.isArray(h.voices) ? [...new Set(h.voices.filter((v): v is number => Number.isInteger(v) && v !== 0 && Math.abs(v) <= 14))] : [...DEFAULT_HARMONY.voices];
  return {
    on: h.on === true,
    key: Number.isInteger(h.key) && (h.key as number) >= 0 && (h.key as number) < 12 ? (h.key as number) : 0,
    minor: h.minor === true,
    voices,
    level: typeof h.level === "number" && Number.isFinite(h.level) ? Math.max(0, Math.min(1, h.level)) : DEFAULT_HARMONY.level,
  };
}

export function sanitizeProject(raw: unknown): Project {
  const d = emptyProject();
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, fallback: number, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback);
  const line = (v: unknown, lo: number, hi: number): BeatPoint[] =>
    Array.isArray(v)
      ? v
          .filter((q): q is Record<string, unknown> => !!q && typeof q === "object")
          .map((q) => ({ beat: num(q.beat, 0, 0, 100_000), value: num(q.value, (lo + hi) / 2, lo, hi) }))
          .sort((a, b) => a.beat - b.beat)
      : [];
  const tracks = Array.isArray(r.tracks)
    ? r.tracks.map((t, i) => {
        const tr = (t && typeof t === "object" ? t : {}) as Record<string, unknown>;
        // An earlier version's drum track: a note's pitch was its row, each row a key (or one by its place).
        const oldRows = tr.kind === "drum" && Array.isArray(tr.pads) && tr.pads.length ? (tr.pads as Record<string, unknown>[]) : null;
        const OLD_ROW_KEYS = [36, 38, 42, 46, 39, 49, 45, 47, 50, 51, 37, 56, 54, 41, 43, 48];
        const rowKey = (row: number) => {
          const k = oldRows?.[row]?.key;
          return typeof k === "number" ? k : (OLD_ROW_KEYS[row] ?? 36 + row);
        };
        const notes = Array.isArray(tr.notes)
          ? tr.notes
              .filter((n): n is Record<string, unknown> => !!n && typeof n === "object")
              .map((n) => ({
                id: newId(),
                start: num(n.start, 0, 0, 100_000),
                length: num(n.length, 1, MIN_LENGTH, 10_000),
                pitch: clampPitch(oldRows ? rowKey(Math.round(num(n.pitch, 0, 0, 127))) : num(n.pitch, 60, 0, 127)),
                velocity: num(n.velocity, DEFAULT_VELOCITY, 0.01, 1),
                ...(tr.kind === "audio" && n.clip && typeof n.clip === "object" && typeof (n.clip as Record<string, unknown>).material === "string"
                  ? { clip: { material: (n.clip as Record<string, unknown>).material as string, offset: num((n.clip as Record<string, unknown>).offset, 0, 0, 100_000) } }
                  : {}),
              }))
          : [];
        return {
          id: typeof tr.id === "string" && tr.id ? tr.id : newTrackId(),
          name: typeof tr.name === "string" && tr.name ? tr.name : `トラック ${i + 1}`,
          kind: tr.kind === "drum" ? ("drum" as const) : tr.kind === "audio" ? ("audio" as const) : ("melodic" as const),
          instrument: typeof tr.instrument === "string" && (tr.instrument.includes("/") || tr.instrument === BACKING || tr.kind === "audio") ? tr.instrument : null,
          notes: sortNotes(notes),
          fx: sanitizeFx(tr.fx),
          gain: num(tr.gain, 1, 0, MAX_TRACK_GAIN),
          pan: num(tr.pan, 0, -1, 1),
          mute: tr.mute === true,
          solo: tr.solo === true,
          glide: num(tr.glide, 0, 0, 2),
          synth: isSynthPreset(tr.synth) ? tr.synth : DEFAULT_SYNTH,
          role: typeof tr.role === "string" && ROLES.includes(tr.role as Role) ? (tr.role as Role) : null,
          main: tr.main === true,
          harmony: sanitizeHarmony(tr.harmony),
          noteLength: num(tr.noteLength, 1, MIN_LENGTH, 64),
          noteVelocity: num(tr.noteVelocity, DEFAULT_VELOCITY, 0.01, 1),
          volumeAuto: line(tr.volumeAuto, 0, VOLUME_AUTO_MAX),
          panAuto: line(tr.panAuto, -1, 1),
        };
      })
    : d.tracks;
  const loop = (r.loop && typeof r.loop === "object" ? r.loop : {}) as Record<string, unknown>;
  const start = num(loop.start, d.loop.start, 0, 100_000);
  const end = num(loop.end, d.loop.end, 0, 100_000);
  return {
    version: 1,
    bpm: num(r.bpm, d.bpm, 20, 400),
    ...(() => {
      const ts = (r.timeSig && typeof r.timeSig === "object" ? r.timeSig : {}) as Record<string, unknown>;
      const p = { timeSig: { num: 4, den: 4 }, beatsPerBar: 4 } as Project;
      setTimeSig(p, num(ts.num, Math.round(num(r.beatsPerBar, 4, 1, 16)), 1, 16), num(ts.den, 4, 2, 16));
      return { timeSig: p.timeSig, beatsPerBar: p.beatsPerBar };
    })(),
    tracks: tracks.length ? tracks : d.tracks,
    materials: Array.isArray(r.materials)
      ? r.materials
          .filter((m): m is Record<string, unknown> => !!m && typeof m === "object" && typeof (m as Record<string, unknown>).id === "string")
          .map((m) => ({ id: m.id as string, name: typeof m.name === "string" ? m.name : "素材", ...(m.long === true ? { long: true } : {}) }))
      : [],
    editing: typeof r.editing === "string" ? r.editing : null,
    loop: end > start ? { start, end, on: loop.on === true } : d.loop,
    masterFx: sanitizeFx(r.masterFx),
    masterAuto: line(r.masterAuto, 0, VOLUME_AUTO_MAX),
    bassLevelDb: num(r.bassLevelDb, 0, 0, 12),
    markers: Array.isArray(r.markers)
      ? r.markers
          .filter((q): q is Record<string, unknown> => !!q && typeof q === "object")
          .map((q) => ({ beat: num(q.beat, 0, 0, 100_000), name: typeof q.name === "string" ? q.name.slice(0, 40) : "マーカー" }))
          .sort((a, b) => a.beat - b.beat)
      : [],
    tempos: Array.isArray(r.tempos)
      ? r.tempos
          .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
          .map((c) => ({ beat: num(c.beat, 1, 0.001, 100_000), bpm: num(c.bpm, 120, 20, 400) }))
          .sort((a, b) => a.beat - b.beat)
      : [],
    kit: sanitizeKit(r.kit),
  };
}

/**
 * 素材を切り詰める: a material's recording now starts `from` seconds later, so its clips (on audio tracks, live or
 * as kept) read `from` seconds earlier; a clip that began in the part cut away starts at the new beginning.
 * Returns how many clips were moved.
 */
export function trimClips(tracks: unknown, material: string, from: number, tempo?: Tempo): number {
  let moved = 0;
  if (!Array.isArray(tracks)) return 0;
  for (const t of tracks as { notes?: unknown }[]) {
    if (!Array.isArray(t?.notes)) continue;
    const kept: unknown[] = [];
    for (const n of t.notes as { start?: unknown; length?: unknown; clip?: { material?: unknown; offset?: unknown } }[]) {
      kept.push(n);
      if (n?.clip?.material !== material || typeof n.clip.offset !== "number") continue;
      moved++;
      const gone = from - n.clip.offset;
      // A clip that began in the part cut away: what it played there is gone, so it starts that much later (in the
      // song's time), from the recording's new start — it stays where its sound was. Nothing left of it: it goes.
      if (gone > 0 && tempo !== undefined && typeof n.start === "number" && typeof n.length === "number") {
        const startSec = beatsToSec(n.start, tempo);
        const endSec = beatsToSec(n.start + n.length, tempo);
        if (startSec + gone >= endSec - 1e-6) {
          kept.pop();
          n.clip.offset = 0;
          continue;
        }
        const end = n.start + n.length;
        const start = secToBeats(startSec + gone, tempo);
        n.start = start;
        n.length = end - start;
      }
      n.clip.offset = Math.max(0, n.clip.offset - from);
    }
    if (kept.length !== t.notes.length) t.notes = kept;
  }
  return moved;
}
