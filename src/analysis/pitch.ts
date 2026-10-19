// Pitch units. Inside the app a pitch is a MIDI note number with a fraction
// (62.37 = D4 + 37 cents): averaging and shifting are then plain arithmetic,
// where in Hz they'd be skewed toward the high notes.

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** "D4 +37¢" — the nearest note and how far off it the pitch is. */
export function pitchLabel(midi: number): string {
  if (!Number.isFinite(midi)) return "—";
  const note = Math.round(midi);
  const cents = Math.round((midi - note) * 100);
  const name = `${NAMES[((note % 12) + 12) % 12]}${Math.floor(note / 12) - 1}`;
  if (cents === 0) return name;
  return `${name} ${cents > 0 ? "+" : "−"}${Math.abs(cents)}¢`;
}

/** "C4", "A#3", "Bb3" → MIDI number; null when it isn't a note name. */
export function parseNoteName(text: string): number | null {
  const match = /^\s*([A-Ga-g])([#b♯♭]?)(-?\d+)\s*$/.exec(text);
  if (!match) return null;
  const base = NAMES.indexOf(match[1].toUpperCase());
  const accidental = match[2] === "#" || match[2] === "♯" ? 1 : match[2] === "b" || match[2] === "♭" ? -1 : 0;
  return base + accidental + (Number(match[3]) + 1) * 12;
}
