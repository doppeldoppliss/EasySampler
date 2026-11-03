// Mixing done for you, from the tracks' roles (design.md 36): volumes to a
// balance (each track's loudness against the lead's), a clean-up EQ on each
// track (a low cut under its notes, a dip where it covers the lead), the bass
// and the accompaniment ducking to the kick, each track's octave brought
// toward its cut's recorded pitch, and a room on each by its part. Each is a
// starting point, undoable, for the ear to finish.

import { DEFAULT_FX, type FxSettings } from "../instrument/types";
import { BAND_HZ } from "../fx/balance";
import type { Note } from "./model";
import type { Role } from "./roles";

// ------------------------------------------------------------ volumes

/** How loud each part sits against the lead (dB, LUFS): the reference (an audio track, or the lead) at 0. */
export const LEVEL_FROM_LEAD: Record<Role, number> = { audio: 0, lead: 0, bass: -2, drum: -1, chords: -5, backing: -6, harmony: -8 };

export interface LevelIn {
  role: Role;
  /** Its loudness as it plays now (integrated LUFS, with its gain), null when it was not measured (silent, muted). */
  lufs: number | null;
  gain: number;
}

/**
 * New gains (null: leave it) bringing each measured track to its part's level. The reference keeps its gain: the
 * first audio track (原曲・伴奏), else the lead, else the loudest. Several tracks of one part share its level
 * (four accompaniments, each 6 dB under one).
 */
export function balanceGains(tracks: readonly LevelIn[], maxGain: number): { gains: (number | null)[]; reference: number; loweredDb: number } {
  const measured = tracks.map((t, i) => ({ ...t, i })).filter((t): t is LevelIn & { i: number; lufs: number } => t.lufs !== null && Number.isFinite(t.lufs));
  if (!measured.length) return { gains: tracks.map(() => null), reference: -1, loweredDb: 0 };
  const ref =
    measured.find((t) => t.role === "audio") ?? measured.find((t) => t.role === "lead") ?? measured.reduce((a, b) => (b.lufs > a.lufs ? b : a));
  const count = new Map<Role, number>();
  for (const t of measured) count.set(t.role, (count.get(t.role) ?? 0) + 1);
  const share = (role: Role) => 10 * Math.log10(count.get(role) ?? 1);
  // The lead's level, from the reference's (which is where its part says it is).
  const lead = ref.lufs - LEVEL_FROM_LEAD[ref.role] + share(ref.role);
  const wanted = tracks.map(() => null as number | null);
  for (const t of measured) {
    if (t === ref) continue;
    const want = lead + LEVEL_FROM_LEAD[t.role] - share(t.role);
    wanted[t.i] = t.gain * 10 ** ((want - t.lufs) / 20);
  }
  // A track that would need more than the fader gives: everything (the reference too) comes down by the
  // difference instead, so the balance holds (a quiet kit would otherwise stop at the top, under its level).
  const most = Math.max(...wanted.map((g) => g ?? 0));
  const lower = most > maxGain ? maxGain / most : 1;
  const gains = wanted.map((g) => (g === null ? null : Math.max(0.01, g * lower)));
  if (lower < 1) gains[ref.i] = Math.max(0.01, ref.gain * lower);
  return { gains, reference: ref.i, loweredDb: -20 * Math.log10(lower) };
}

// ------------------------------------------------------------ the clean-up EQ

const hzOf = (pitch: number) => 440 * 2 ** ((pitch - 69) / 12);

/** The low cut for a track: a little under its lowest notes (the 5th percentile), between 40 and 250 Hz. */
export function lowCutFor(notes: readonly Note[]): number {
  if (!notes.length) return 0;
  const sorted = notes.map((n) => n.pitch).sort((a, b) => a - b);
  const low = sorted[Math.floor(sorted.length * 0.05)];
  return Math.round(Math.min(250, Math.max(40, 0.7 * hzOf(low))));
}

/** A band spectrum (BAND_HZ, dB) against its own mean over 200 Hz – 5 kHz: where it is stronger than itself on average. */
function relative(db: readonly number[]): number[] {
  let sum = 0;
  let n = 0;
  BAND_HZ.forEach((hz, j) => {
    if (hz >= 200 && hz <= 5000) {
      sum += db[j];
      n++;
    }
  });
  return db.map((x) => x - sum / n);
}

/**
 * Where a track covers the lead: the band between 300 Hz and 4 kHz where both are strongest against themselves,
 * and how much to dip it there (2–3 dB); null when they do not meet (the lead not strong anywhere the track is).
 */
export function maskingDip(lead: readonly number[], track: readonly number[]): { hz: number; db: number } | null {
  const l = relative(lead);
  const t = relative(track);
  let best = -1;
  let score = 0;
  BAND_HZ.forEach((hz, j) => {
    if (hz < 300 || hz > 4000 || l[j] < 1 || t[j] < 0) return;
    const s = l[j] + t[j];
    if (s > score) {
      score = s;
      best = j;
    }
  });
  if (best < 0) return null;
  return { hz: Math.round(BAND_HZ[best]), db: score > 8 ? -3 : -2 };
}

/**
 * The clean-up EQ: its low cut and the dip (when there is one), on an EQ otherwise flat — not on what the track's
 * switched-off EQ was left at (its shelves would come back on with it).
 */
export function cleanEq(lowCutHz: number, dip: { hz: number; db: number } | null): FxSettings["eq"] {
  return { ...DEFAULT_FX.eq, on: true, lowCutHz, ...(dip ? { midHz: dip.hz, midDb: dip.db, midQ: 1.4 } : {}) };
}

// ------------------------------------------------------------ ducking to the kick

/** How far each part ducks to the kick (dB); the lead, the drums and the audio do not. */
const DUCK_DB: Partial<Record<Role, number>> = { bass: -6, chords: -3, backing: -3, harmony: -3 };

/** A track's ducking to the kick (null: it does not duck): back up over about an eighth note. */
export function kickDuck(role: Role, bpm: number, duck: FxSettings["duck"]): FxSettings["duck"] | null {
  const depthDb = DUCK_DB[role];
  if (depthDb === undefined) return null;
  return { ...duck, on: true, source: "kick", depthDb, releaseMs: Math.round(Math.min(300, Math.max(80, 30000 / bpm))) };
}

// ------------------------------------------------------------ octaves

/**
 * How many octaves (−2…2) to move a track's notes so their middle comes nearest the pitch its cut was recorded
 * at (0 when none comes nearer).
 */
export function octaveFit(notes: readonly Note[], root: number): number {
  if (!notes.length) return 0;
  const sorted = notes.map((n) => n.pitch).sort((a, b) => a - b);
  const mid = sorted[sorted.length >> 1];
  let best = 0;
  for (const k of [-1, 1, -2, 2]) if (Math.abs(mid + 12 * k - root) < Math.abs(mid + 12 * best - root) - 1e-9) best = k;
  // (Never off the keyboard.)
  while (best !== 0 && (sorted[0] + 12 * best < 0 || sorted[sorted.length - 1] + 12 * best > 127)) best -= Math.sign(best);
  return best;
}

// ------------------------------------------------------------ rooms

/** How much room each part gets (the reverb's dry/wet); the bass, the drums and the audio get none. */
const ROOM_MIX: Partial<Record<Role, number>> = { lead: 0.12, chords: 0.22, backing: 0.25, harmony: 0.28 };

/**
 * A track's room by its part (null: none): its tail about two beats long at the tempo, its pre-delay a 64th note (31 ms at 120)
 * (so the note stays clear in front of it), the accompaniment a little darker (further back).
 */
export function roomFor(role: Role, bpm: number, reverb: FxSettings["reverb"]): FxSettings["reverb"] | null {
  const mix = ROOM_MIX[role];
  if (mix === undefined) return null;
  const twoBeats = 120 / bpm;
  return {
    ...reverb,
    on: true,
    mix,
    size: Math.round(Math.min(0.85, Math.max(0.35, 0.35 + (twoBeats - 0.6) * 0.35)) * 100) / 100,
    damping: role === "lead" ? 0.45 : 0.6,
    preDelayMs: Math.round(Math.min(60, Math.max(10, 3750 / bpm))),
  };
}
