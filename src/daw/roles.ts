// What each track of a song is for, read from its notes (design.md 33): the
// drums, the bass (low), the lead (the busiest line on top, one note at a
// time), chords (notes sounding together) and the rest (accompaniment). Used
// to name tracks a MIDI file left nameless ("MIDI Out #3"), and to spread the
// accompaniment left and right (パンを自動で広げる). Also: how far a track's
// notes go from the pitch its cut was recorded at (崩れ・こもり).

import type { Note, Track } from "./model";

export type Role = "drum" | "audio" | "bass" | "lead" | "chords" | "backing";

export interface TrackRole {
  role: Role;
  /** The middle of its notes (MIDI), NaN without notes. */
  median: number;
}

/** A name a file or a new track gives that says nothing ("MIDI Out #3", "Track 5", "トラック 2", "#4"). */
export function isGenericName(name: string): boolean {
  return /^\s*(midi\s*out(\s*#?\d+)?|track\s*\d*|トラック\s*\d*|パート\s*\d*|#\d+|untitled|ドラム\s*\d*)?\s*$/i.test(name);
}

const median = (xs: number[]) => {
  if (!xs.length) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

/** How much of a track's time has more than one note sounding (0 = a single line). */
function chordShare(notes: readonly Note[]): number {
  if (notes.length < 2) return 0;
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  let overlapped = 0;
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i];
    // (Touching is not sounding together: a hair of legato is left out.)
    const with_ = sorted.some((m, j) => j !== i && m.start < n.start + n.length - 0.05 && m.start + m.length > n.start + 0.05);
    if (with_) overlapped++;
  }
  return overlapped / sorted.length;
}

/** Below this middle pitch (E3), a line is the bass. */
const BASS_BELOW = 52;

/** Each track's role (in the tracks' order). */
export function trackRoles(tracks: readonly Pick<Track, "kind" | "notes">[]): TrackRole[] {
  const roles: TrackRole[] = tracks.map((t) => ({ role: t.kind === "drum" ? "drum" : t.kind === "audio" ? "audio" : "backing", median: median(t.notes.map((n) => n.pitch)) }));
  let lead = -1;
  let best = 0;
  tracks.forEach((t, i) => {
    if (t.kind !== "melodic" || !t.notes.length) return;
    const share = chordShare(t.notes);
    if (roles[i].median < BASS_BELOW) roles[i].role = "bass";
    else if (share > 0.4) roles[i].role = "chords";
    else {
      // The lead: a single line, high, with many notes.
      const score = t.notes.length * (1 - share) * (roles[i].median - 40);
      if (score > best) {
        best = score;
        lead = i;
      }
    }
  });
  if (lead >= 0) roles[lead].role = "lead";
  return roles;
}

/** The GM instrument families (program ÷ 8), named. */
const GM_FAMILIES = ["ピアノ", "鍵盤打楽器", "オルガン", "ギター", "ベース", "ストリングス", "アンサンブル", "ブラス", "リード", "笛", "シンセリード", "シンセパッド", "シンセ効果", "民族楽器", "打楽器", "効果音"];
const ROLE_NAMES: Record<Role, string> = { drum: "ドラム", audio: "音声", bass: "ベース", lead: "メロディ", chords: "和音", backing: "伴奏" };

/**
 * Names for the tracks whose names say nothing: by their GM instrument when the file gave one (`programs[i]`),
 * otherwise by their role; the same name twice is numbered ("伴奏 2"). Tracks with names of their own keep them
 * (null in the result).
 */
export function autoNames(tracks: readonly Pick<Track, "kind" | "notes" | "name">[], programs: readonly (number | null)[] = []): (string | null)[] {
  const roles = trackRoles(tracks);
  const wanted = tracks.map((t, i) => {
    if (!isGenericName(t.name)) return null;
    const program = programs[i];
    // (A lead or a bass reads better by its role than by "ピアノ", the default program.)
    if (program !== null && program !== undefined && program > 0 && t.kind === "melodic" && roles[i].role !== "lead") return GM_FAMILIES[Math.floor(program / 8)] ?? ROLE_NAMES[roles[i].role];
    return ROLE_NAMES[roles[i].role];
  });
  const taken = new Set(tracks.filter((_, i) => wanted[i] === null).map((t) => t.name));
  const count = new Map<string, number>();
  for (const w of wanted) if (w) count.set(w, (count.get(w) ?? 0) + 1);
  const seen = new Map<string, number>();
  return wanted.map((w) => {
    if (!w) return null;
    let name = w;
    if ((count.get(w) ?? 0) > 1 || taken.has(w)) {
      let k = (seen.get(w) ?? 0) + 1;
      while (taken.has(`${w} ${k}`)) k++;
      seen.set(w, k);
      name = `${w} ${k}`;
    }
    taken.add(name);
    return name;
  });
}

/**
 * Pans spreading the song out: drums, bass, lead and audio in the middle (as they are), the rest — chords and
 * accompaniment — alternately left and right, further out the more there are, ordered by pitch so neighbours in
 * range end up on different sides. Returns a pan per track (null: leave it).
 */
export function spreadPans(tracks: readonly Pick<Track, "kind" | "notes">[]): (number | null)[] {
  const roles = trackRoles(tracks);
  const out: (number | null)[] = tracks.map(() => null);
  const side = roles
    .map((r, i) => ({ ...r, i }))
    .filter((r) => (r.role === "chords" || r.role === "backing") && tracks[r.i].notes.length > 0)
    .sort((a, b) => a.median - b.median);
  side.forEach((r, k) => {
    const amount = Math.min(0.7, 0.35 + 0.1 * Math.floor(k / 2));
    out[r.i] = k % 2 === 0 ? -amount : amount;
  });
  roles.forEach((r, i) => {
    if (r.role === "bass" || r.role === "lead" || r.role === "drum") out[i] = 0;
  });
  return out;
}

/**
 * How far a track's notes go from the pitch its cut was recorded at, in semitones (the 5th and 95th percentile,
 * so a stray note does not count): far down a voice turns muddy and breaks up, far up it turns thin.
 */
export function rangeFromRoot(notes: readonly Note[], root: number): { below: number; above: number } {
  if (!notes.length) return { below: 0, above: 0 };
  const s = notes.map((n) => n.pitch).sort((a, b) => a - b);
  const low = s[Math.floor(s.length * 0.05)];
  const high = s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
  return { below: Math.max(0, root - low), above: Math.max(0, high - root) };
}

/** Past these (semitones), the track is told: a lower material, or the plain synth, would do better. */
export const FAR_BELOW = 24;
export const FAR_ABOVE = 24;
