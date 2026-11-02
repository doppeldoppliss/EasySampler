// What a loaded MIDI file offers 「MIDI を開く」: its parts — a track each (a
// part per channel when a track holds several), a drum track also as one part
// per drum sound.

import { pitchLabel } from "../analysis/pitch";
import type { Song, SongNote } from "./midi";

/** A note as the player takes it: seconds, a MIDI note, velocity 0–1. */
export interface SeqNote {
  start: number;
  end: number;
  note: number;
  velocity: number;
  /** Played as a drum hit by the backing (ignored for the material). */
  drum: boolean;
}

export interface SongPart {
  id: string;
  label: string;
  notes: SongNote[];
  drum: boolean;
  /** Set for a drum part of one sound: its MIDI note. */
  drumPitch: number | null;
  /**
   * Another part with the same notes (doubled tracks are common), as is or
   * shifted in time by `shiftSec` (an echo layer). An exact double is left
   * out of the backing; an echo only when its source is the material.
   */
  duplicateOf: string | null;
  shiftSec: number;
}

const DRUM_CHANNEL = 9;

const DRUM_NAMES: Record<number, string> = {
  35: "キック",
  36: "キック",
  37: "サイドスティック",
  38: "スネア",
  39: "クラップ",
  40: "スネア",
  41: "タム(低)",
  42: "ハイハット(閉)",
  43: "タム(低)",
  44: "ハイハット(ペダル)",
  45: "タム(中)",
  46: "ハイハット(開)",
  47: "タム(中)",
  48: "タム(高)",
  49: "クラッシュ",
  50: "タム(高)",
  51: "ライド",
  52: "チャイナ",
  53: "ライドベル",
  54: "タンバリン",
  55: "スプラッシュ",
  56: "カウベル",
  57: "クラッシュ",
  59: "ライド",
};

export function drumName(pitch: number): string {
  return DRUM_NAMES[pitch] ?? `ドラム ${pitch}`;
}

function rangeLabel(notes: SongNote[]): string {
  let lo = 127;
  let hi = 0;
  for (const n of notes) {
    lo = Math.min(lo, n.pitch);
    hi = Math.max(hi, n.pitch);
  }
  return lo === hi ? pitchLabel(lo) : `${pitchLabel(lo)}–${pitchLabel(hi)}`;
}

/** How far `b` is `a` moved later (0 for the same notes), or null when it isn't a copy at all. */
const MAX_ECHO_SEC = 1;
function copyShift(a: SongNote[], b: SongNote[]): number | null {
  if (a.length !== b.length || a.length === 0) return null;
  const shift = b[0].start - a[0].start;
  if (Math.abs(shift) > MAX_ECHO_SEC) return null;
  for (let i = 0; i < a.length; i++) {
    if (a[i].pitch !== b[i].pitch || Math.abs(b[i].start - a[i].start - shift) > 0.002) return null;
    // (The last note of an echo is often cut off where the song ends.)
    if (i < a.length - 1 && Math.abs(b[i].end - a[i].end - shift) > 0.002) return null;
  }
  return Math.abs(shift) < 0.002 ? 0 : shift;
}

export function songParts(song: Song): SongPart[] {
  const parts: SongPart[] = [];
  for (const track of song.tracks) {
    const title = track.name ? `#${track.index} ${track.name}` : `#${track.index}`;
    const melodic = track.notes.filter((n) => n.channel !== DRUM_CHANNEL);
    const drums = track.notes.filter((n) => n.channel === DRUM_CHANNEL);
    const channels = [...new Set(melodic.map((n) => n.channel))].sort((a, b) => a - b);
    if (channels.length > 1) {
      for (const ch of channels) {
        const notes = melodic.filter((n) => n.channel === ch);
        parts.push({ id: `t${track.index}c${ch}`, label: `${title} ch${ch + 1}(${notes.length} 音・${rangeLabel(notes)})`, notes, drum: false, drumPitch: null, duplicateOf: null, shiftSec: 0 });
      }
    } else if (melodic.length > 0) {
      parts.push({ id: `t${track.index}`, label: `${title}(${melodic.length} 音・${rangeLabel(melodic)})`, notes: melodic, drum: false, drumPitch: null, duplicateOf: null, shiftSec: 0 });
    }
    if (drums.length > 0) {
      parts.push({ id: `t${track.index}d`, label: `${title} ドラム全部(${drums.length} 音)`, notes: drums, drum: true, drumPitch: null, duplicateOf: null, shiftSec: 0 });
      const pitches = [...new Set(drums.map((n) => n.pitch))].sort((a, b) => a - b);
      for (const pitch of pitches) {
        const notes = drums.filter((n) => n.pitch === pitch);
        parts.push({ id: `t${track.index}d${pitch}`, label: `${title} ドラム: ${drumName(pitch)}(${pitch}・${notes.length} 音)`, notes, drum: true, drumPitch: pitch, duplicateOf: null, shiftSec: 0 });
      }
    }
  }
  // Whole parts only (a single drum sound is part of its drum part anyway).
  const whole = parts.filter((p) => p.drumPitch === null);
  for (let i = 0; i < whole.length; i++) {
    for (let j = 0; j < i; j++) {
      if (whole[j].duplicateOf !== null) continue;
      const shift = copyShift(whole[j].notes, whole[i].notes);
      if (shift === null) continue;
      const source = whole[j].label.split("(")[0];
      whole[i].duplicateOf = whole[j].id;
      whole[i].shiftSec = shift;
      whole[i].label += shift === 0 ? `(${source} と同じ)` : `(${source} を ${Math.round(shift * 1000)} ms ずらした重ね)`;
      break;
    }
  }
  return parts;
}
