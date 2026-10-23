// Playing the instrument: an on-screen keyboard (multi-touch, slide between
// keys) and the computer keyboard as a piano (design.md 7.4–7.5).
//
// Computer keys follow Ableton's layout so switchers feel at home: the A row
// is the white keys (A = C), W E T Y U O P the black ones, Z/X shift the
// octave and C/V the velocity. Keys are read by physical position
// (KeyboardEvent.code), so a JIS keyboard plays the same. With the Japanese
// IME on, key presses arrive as composition instead of keys — that's
// detected and the user told to switch to direct input.

import { pitchLabel } from "../analysis/pitch";
import { el, isTypingTarget } from "./dom";

export interface NoteSink {
  noteOn(note: number, velocity: number): void;
  noteOff(note: number): void;
}

const BLACK = new Set([1, 3, 6, 8, 10]);

export class OnScreenKeyboard {
  readonly element: HTMLElement;
  private keys = new Map<number, HTMLElement>();
  /** Which note each finger / pointer is holding. */
  private held = new Map<number, number>();
  private rootKey: HTMLElement | null = null;
  private rootMidi: number | null = null;
  private sink: NoteSink;
  low: number;
  high: number;

  constructor(sink: NoteSink, low = 48, high = 84) {
    this.sink = sink;
    this.low = low;
    this.high = high;
    this.element = el("div", { className: "piano", role: "group", ariaLabel: "鍵盤" });
    this.build();
    this.element.addEventListener("pointerdown", (event) => this.press(event));
    this.element.addEventListener("pointermove", (event) => this.slide(event));
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
      this.element.addEventListener(type, (event) => this.lift(event.pointerId));
    }
    this.element.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  /** Shows another stretch of notes (the same width), keeping the root mark. */
  setRange(low: number, high: number): void {
    for (const [id, note] of this.held) {
      this.sink.noteOff(note);
      this.held.delete(id);
    }
    this.low = low;
    this.high = high;
    this.build();
    this.setRoot(this.rootMidi);
  }

  private build(): void {
    const { low, high } = this;
    this.element.replaceChildren();
    this.keys.clear();
    this.rootKey = null;
    const whites = [...Array(high - low + 1).keys()].map((i) => low + i).filter((n) => !BLACK.has(n % 12));
    const whiteWidth = 100 / whites.length;
    let whiteIndex = 0;
    for (let note = low; note <= high; note++) {
      const black = BLACK.has(note % 12);
      const key = el("div", { className: black ? "key black" : "key white", dataset: { note: String(note) } });
      if (black) {
        key.style.left = `${whiteIndex * whiteWidth - whiteWidth * 0.3}%`;
        key.style.width = `${whiteWidth * 0.6}%`;
      } else {
        key.style.left = `${whiteIndex * whiteWidth}%`;
        key.style.width = `${whiteWidth}%`;
        if (note % 12 === 0) key.append(el("span", { className: "key-label", textContent: pitchLabel(note) }));
        whiteIndex++;
      }
      this.keys.set(note, key);
      this.element.append(key);
    }
  }

  /** Marks the key nearest the root pitch (where the material plays as it is). */
  setRoot(midi: number | null): void {
    this.rootMidi = midi;
    this.rootKey?.classList.remove("root");
    this.rootKey = midi === null ? null : (this.keys.get(Math.round(midi)) ?? null);
    this.rootKey?.classList.add("root");
  }

  showPressed(note: number, down: boolean): void {
    this.keys.get(note)?.classList.toggle("down", down);
  }

  private noteAt(x: number, y: number): { note: number; velocity: number } | null {
    const target = document.elementFromPoint(x, y);
    const key = target instanceof HTMLElement ? target.closest<HTMLElement>(".key") : null;
    if (!key || !this.element.contains(key)) return null;
    // Further down the key plays louder (as on a real key, where the finger lands deeper).
    const box = key.getBoundingClientRect();
    const depth = Math.max(0, Math.min(1, (y - box.top) / box.height));
    return { note: Number(key.dataset.note), velocity: 0.45 + 0.55 * depth };
  }

  private press(event: PointerEvent): void {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    const hit = this.noteAt(event.clientX, event.clientY);
    if (!hit) return;
    event.preventDefault();
    try {
      this.element.setPointerCapture(event.pointerId);
    } catch {
      // (a pointer that is already gone)
    }
    this.held.set(event.pointerId, hit.note);
    this.showPressed(hit.note, true);
    this.sink.noteOn(hit.note, hit.velocity);
  }

  private slide(event: PointerEvent): void {
    const current = this.held.get(event.pointerId);
    if (current === undefined) return;
    const hit = this.noteAt(event.clientX, event.clientY);
    if (!hit || hit.note === current) return;
    this.showPressed(current, false);
    this.sink.noteOff(current);
    this.held.set(event.pointerId, hit.note);
    this.showPressed(hit.note, true);
    this.sink.noteOn(hit.note, hit.velocity);
  }

  private lift(pointerId: number): void {
    const note = this.held.get(pointerId);
    if (note === undefined) return;
    this.held.delete(pointerId);
    this.showPressed(note, false);
    this.sink.noteOff(note);
  }
}

/** code → semitones above the base C. */
const PIANO_KEYS: Record<string, number> = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11,
  KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16,
};

export interface PcKeyboardState {
  enabled: boolean;
  baseNote: number;
  velocity: number;
}

export class PcKeyboard {
  readonly state: PcKeyboardState = { enabled: true, baseNote: 60, velocity: 0.8 };
  /** Physical key → the note it started (so an octave change mid-hold still releases the right note). */
  private down = new Map<string, number>();
  onChange: (state: PcKeyboardState) => void = () => {};
  onIme: () => void = () => {};
  onNote: (note: number, down: boolean) => void = () => {};

  private sink: NoteSink;

  constructor(sink: NoteSink) {
    this.sink = sink;
    window.addEventListener("keydown", (event) => this.keyDown(event));
    window.addEventListener("keyup", (event) => this.keyUp(event));
    window.addEventListener("blur", () => this.releaseAll());
  }

  toggle(): void {
    this.state.enabled = !this.state.enabled;
    if (!this.state.enabled) this.releaseAll();
    this.onChange(this.state);
  }

  private keyDown(event: KeyboardEvent): void {
    if (isTypingTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.isComposing || event.keyCode === 229 || event.key === "Process") {
      if (this.state.enabled) this.onIme();
      return;
    }
    if (event.code === "KeyM") {
      if (!event.repeat) this.toggle();
      event.preventDefault();
      return;
    }
    if (!this.state.enabled) return;
    const step = PIANO_KEYS[event.code];
    if (step !== undefined) {
      event.preventDefault();
      if (event.repeat || this.down.has(event.code)) return;
      const note = this.state.baseNote + step;
      this.down.set(event.code, note);
      this.sink.noteOn(note, this.state.velocity);
      this.onNote(note, true);
      return;
    }
    const changes: Record<string, () => void> = {
      KeyZ: () => (this.state.baseNote = Math.max(24, this.state.baseNote - 12)),
      KeyX: () => (this.state.baseNote = Math.min(96, this.state.baseNote + 12)),
      KeyC: () => (this.state.velocity = Math.max(0.2, Math.round((this.state.velocity - 0.2) * 10) / 10)),
      KeyV: () => (this.state.velocity = Math.min(1, Math.round((this.state.velocity + 0.2) * 10) / 10)),
    };
    const change = changes[event.code];
    if (change) {
      event.preventDefault();
      change();
      this.onChange(this.state);
    }
  }

  private keyUp(event: KeyboardEvent): void {
    const note = this.down.get(event.code);
    if (note === undefined) return;
    this.down.delete(event.code);
    this.sink.noteOff(note);
    this.onNote(note, false);
  }

  private releaseAll(): void {
    for (const note of this.down.values()) {
      this.sink.noteOff(note);
      this.onNote(note, false);
    }
    this.down.clear();
  }
}
