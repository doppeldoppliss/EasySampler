// The piano roll (design.md 13, phase 1): notes on a beat grid, edited with a
// mouse or a finger.
//
// Mouse / pen (after Domino): click on empty grid = a note there (the length
// and velocity set for new notes); drag on empty = select a box (Shift adds);
// drag a note = move the selection (Ctrl at the start = a copy; Ctrl pressed
// during the drag, or Alt = off the grid); drag a note's right end = change
// the length; double-click a note = delete; right-click = the menu (on a note:
// its length and velocity become the ones for new notes, a "dropper"); a
// right-click during a drag cancels it. Finger: tap = a note, drag on empty =
// scroll (or select, with 範囲選択 on), long-press = the menu.
// Drum rows: a click on a row's name selects its notes (Shift adds).
// The ruler: tap = play from there, double-tap = start playing, drag = loop range.
// Scrolling: the bars along the right and bottom edges (drag the thumb, or
// press the track to jump there), the wheel (Shift = sideways), a middle-
// button drag, or a finger dragged on empty grid.
// The velocity lane (強弱, when shown) under the notes: drag across it to set
// each note's velocity (only the selected notes', when some are selected).
// Keys (when the roll has the focus): Delete, Ctrl+A / C / X / V / D, arrows
// (Shift = an octave), Ctrl+Z / Y, Space = play / stop, Esc,
// Ctrl+PageUp / PageDown = the track before / after.

import { clampPitch, DEFAULT_VELOCITY, MIN_LENGTH, newId, shifted, snap, snapDown, songEnd, sortNotes, type Note } from "../daw/model";
import { cssVar } from "./dom";

const KEYS_W = 44;
const RULER_H = 24;
const COARSE = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
const ROW_H = COARSE ? 20 : 13;
const EDGE_MOUSE = 6;
const EDGE_TOUCH = 14;
const TAP_PX = COARSE ? 10 : 4;
const DOUBLE_TAP_MS = 350;
/** A finger held still this long opens the menu (as a right-click does). */
const LONG_PRESS_MS = 550;
const HISTORY = 200;
/** The scroll bars' thickness, and the shortest a thumb gets. */
const SCROLLBAR = COARSE ? 14 : 10;
const MIN_THUMB = COARSE ? 36 : 24;
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const isBlack = (pitch: number) => [1, 3, 6, 8, 10].includes(((pitch % 12) + 12) % 12);

type Drag =
  | { kind: "pending"; x: number; y: number; shift: boolean; fine: boolean }
  | { kind: "pan"; x: number; y: number; beat: number; top: number }
  | { kind: "box"; x0: number; y0: number; x1: number; y1: number; add: Set<number> }
  | { kind: "move"; anchor: Note; x: number; y: number; orig: Map<number, Note>; moved: boolean; lastPitch: number; ctrl: boolean }
  | { kind: "resize"; anchor: Note; orig: Map<number, Note>; ctrl: boolean }
  | { kind: "ruler"; x: number; moved: boolean }
  | { kind: "velocity"; x: number; value: number }
  | { kind: "scrollH"; grab: number }
  | { kind: "scrollV"; grab: number };

export interface Loop {
  start: number;
  end: number;
  on: boolean;
}

export class PianoRoll {
  readonly element: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  /** Something was changed (after a gesture or a command, not during a drag). */
  onChange: (notes: Note[]) => void = () => {};
  /** The ruler was tapped (play = double tap). */
  onSeek: (beat: number, play: boolean) => void = () => {};
  onLoopChange: (loop: Loop) => void = () => {};
  /** A pitch to sound briefly (a note placed or moved, a key on the left). */
  onPreview: (pitch: number) => void = () => {};
  onTogglePlay: () => void = () => {};
  /** Selection or history changed (for the buttons around the roll). */
  onStateChange: () => void = () => {};
  /** The menu asked for (a right-click, a long press) at a page position, on a note or on empty grid. */
  onMenu: (clientX: number, clientY: number, note: Note | null) => void = () => {};
  /** The length or velocity for new notes changed (a note resized, or picked with the dropper). */
  onDefaultsChange: () => void = () => {};
  /** Ctrl+PageUp / PageDown: the track before / after. */
  onTrackStep: (delta: number) => void = () => {};

  /** Snap in beats (0 = off). */
  grid = 0.25;
  /** Finger drag on empty grid selects instead of scrolling. */
  selectMode = false;
  /** Length of the next note placed (follows the last one resized, or the one picked). */
  lastLength = 1;
  /** Velocity of the next note placed (0–1). */
  defaultVelocity = DEFAULT_VELOCITY;
  /**
   * A drum track's rows ↔ GM keys (set by the panel; null for a melodic track): the clipboard keeps
   * keys, so notes pasted into another track land on the same drums (or pitches), or not at all.
   */
  pitchToKey: ((pitch: number) => number) | null = null;
  keyToPitch: ((key: number) => number | null) | null = null;
  /** Other tracks' notes, drawn faintly behind (オニオンスキン), or none. */
  private ghosts: readonly { start: number; length: number; pitch: number }[] = [];
  /** A right-click that cancelled a drag: no menu for it. */
  private menuSuppressed = false;
  private longPress = 0;
  /** The velocity lane is shown under the notes. */
  private velocityLane = false;

  get showVelocity(): boolean {
    return this.velocityLane;
  }

  set showVelocity(on: boolean) {
    this.velocityLane = on;
    this.draw();
  }

  /** The velocity lane's height (0 when hidden). */
  private get laneH(): number {
    return this.velocityLane ? (COARSE ? 76 : 60) : 0;
  }

  private notesList: Note[] = [];
  private selected = new Set<number>();
  private clipboard: Note[] = [];
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private beatsPerBar = 4;
  private loop: Loop = { start: 0, end: 16, on: false };
  private playhead: number | null = null;
  private root: number | null = null;
  /** Leftmost beat shown, and the pitch whose row's top is at the ruler's bottom. */
  private scrollBeat = 0;
  private topPitch = 84;
  private pxPerBeat = COARSE ? 56 : 48;
  private drag: Drag | null = null;
  /** Drum rows (top to bottom), or null for the keyboard. In row mode a note's pitch is its row's index. */
  private rowNames: string[] | null = null;
  /** Row mode: the first row shown. */
  private scrollRow = 0;

  private get keysW(): number {
    return this.rowNames ? (COARSE ? 96 : 120) : KEYS_W;
  }

  private get rowH(): number {
    return this.rowNames ? (COARSE ? 34 : 26) : ROW_H;
  }

  private clampP(pitch: number): number {
    return this.rowNames ? Math.max(0, Math.min(this.rowNames.length - 1, Math.round(pitch))) : clampPitch(pitch);
  }

  /** Drum rows (names, top to bottom), or null for the keyboard. */
  setRows(names: string[] | null): void {
    this.rowNames = names ? [...names] : null;
    this.scrollRow = Math.max(0, Math.min(this.scrollRow, (names?.length ?? 1) - 1));
    this.draw();
  }

  get rowCount(): number | null {
    return this.rowNames?.length ?? null;
  }

  /** A frame() asked for before the roll had a size (it was hidden): done on the first sized draw. */
  private pendingFrame: number | null = null;
  /** The user scrolled or zoomed: the view is theirs, a new root does not move it. */
  private viewTouched = false;
  private lastRulerTap = 0;
  private gestureStart = "";

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "piano-roll-canvas";
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("aria-label", "ピアノロール");
    this.element = document.createElement("div");
    this.element.className = "piano-roll";
    this.element.append(this.canvas);
    this.canvas.addEventListener("pointerdown", (e) => this.down(e));
    this.canvas.addEventListener("pointermove", (e) => this.move(e));
    this.canvas.addEventListener("pointerup", (e) => this.up(e));
    this.canvas.addEventListener("pointercancel", () => this.cancel());
    this.canvas.addEventListener("dblclick", (e) => this.doubleClick(e));
    // (The middle button drags the view: not the browser's own auto-scroll.)
    this.canvas.addEventListener("mousedown", (e) => {
      if (e.button === 1) e.preventDefault();
    });
    this.canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (this.menuSuppressed) {
        this.menuSuppressed = false;
        return;
      }
      const { x, y } = this.local(e);
      this.menuAt(x, y, e.clientX, e.clientY);
    });
    this.canvas.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    this.canvas.addEventListener("keydown", (e) => this.key(e));
    new ResizeObserver(() => this.draw()).observe(this.canvas);
    window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => this.draw());
  }

  // ------------------------------------------------------------- state in and out

  get notes(): Note[] {
    return this.notesList;
  }

  get selectionSize(): number {
    return this.selected.size;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** The undo / redo history (to keep it while another track is shown). */
  takeHistory(): { undo: string[]; redo: string[] } {
    return { undo: [...this.undoStack], redo: [...this.redoStack] };
  }

  /** Puts a kept history back (right after the same notes were set again). */
  giveHistory(history: { undo: string[]; redo: string[] }): void {
    this.undoStack = [...history.undo];
    this.redoStack = [...history.redo];
    this.onStateChange();
  }

  /** Replaces the notes (a load or an import); `keepHistory` makes it one undoable step. */
  setNotes(notes: Note[], keepHistory = false): void {
    // (A drag under way belongs to the notes being replaced: it ends here, so it cannot land in the new ones' history.)
    this.drag = null;
    this.clearLongPress();
    if (keepHistory) this.pushUndo();
    else {
      this.undoStack = [];
      this.redoStack = [];
    }
    this.notesList = sortNotes(notes.map((n) => ({ ...n })));
    this.gestureStart = this.snapshot();
    this.selected.clear();
    this.draw();
    this.onStateChange();
  }

  /** Scrolls so the notes (or the given pitch) are in view. */
  frame(aroundPitch: number): void {
    if (this.canvas.clientHeight === 0) {
      this.pendingFrame = aroundPitch;
      return;
    }
    this.pendingFrame = null;
    this.viewTouched = false;
    if (this.rowNames) {
      this.scrollRow = 0;
      this.scrollBeat = this.notesList.length ? Math.max(0, snapDown(Math.min(...this.notesList.map((n) => n.start)), this.beatsPerBar)) : 0;
      this.draw();
      return;
    }
    const rows = this.visibleRows();
    if (this.notesList.length) {
      const lo = Math.min(...this.notesList.map((n) => n.pitch));
      const hi = Math.max(...this.notesList.map((n) => n.pitch));
      this.topPitch = Math.min(127, Math.max(hi + 2, Math.round((lo + hi) / 2 + rows / 2)));
      this.scrollBeat = Math.max(0, snapDown(Math.min(...this.notesList.map((n) => n.start)), this.beatsPerBar));
    } else {
      this.topPitch = Math.min(127, Math.round(aroundPitch + rows / 2));
    }
    this.draw();
  }

  setBeatsPerBar(beats: number): void {
    this.beatsPerBar = beats;
    this.draw();
  }

  setLoop(loop: Loop): void {
    this.loop = { ...loop };
    this.draw();
  }

  /** The playing position (beats), or null; `follow` scrolls along when it leaves the view. */
  setPlayhead(beat: number | null, follow = false): void {
    this.playhead = beat;
    if (follow && beat !== null) {
      const span = this.visibleBeats();
      if (beat < this.scrollBeat || beat > this.scrollBeat + span * 0.95) this.scrollBeat = Math.max(0, beat - span * 0.05);
    }
    this.draw();
  }

  /** The material's note (marked on the keys); an empty roll the user has not scrolled centres on it. */
  setRoot(pitch: number | null): void {
    if (pitch === this.root) return;
    this.root = pitch;
    if (pitch !== null && this.notesList.length === 0 && !this.viewTouched) this.frame(pitch);
    else this.draw();
  }

  /** Other tracks' notes to show faintly behind this one's (オニオンスキン); empty for none. */
  setGhosts(notes: readonly { start: number; length: number; pitch: number }[]): void {
    this.ghosts = notes;
    this.draw();
  }

  get hasClipboard(): boolean {
    return this.clipboard.length > 0;
  }

  // ------------------------------------------------------------- commands

  selectNone(): void {
    if (!this.selected.size) return;
    this.selected.clear();
    this.draw();
    this.onStateChange();
  }

  /** A drum row's notes (Shift: added to the selection). */
  selectRow(row: number, add = false): void {
    if (!add) this.selected.clear();
    for (const n of this.notesList) if (n.pitch === row) this.selected.add(n.id);
    this.draw();
    this.onStateChange();
  }

  /** Changes every selected note (all of them when none is selected) as one undoable step. */
  changeNotes(change: (n: Note) => void): number {
    const targets = this.selected.size ? this.selection() : this.notesList;
    this.edit(() => {
      for (const n of targets) {
        change(n);
        n.length = Math.max(MIN_LENGTH, n.length);
        n.velocity = Math.max(0.01, Math.min(1, n.velocity));
        n.pitch = this.clampP(n.pitch);
        n.start = Math.max(0, n.start);
      }
    });
    return targets.length;
  }

  /**
   * スライス: the selected notes (all when none is selected) that run across
   * the beat are cut there into two. Returns how many were cut.
   */
  sliceAt(beat: number): number {
    const targets = (this.selected.size ? this.selection() : this.notesList).filter((n) => n.start < beat - 1e-9 && n.start + n.length > beat + 1e-9);
    if (!targets.length) return 0;
    this.edit(() => {
      for (const n of targets) {
        const right: Note = { ...n, id: newId(), start: beat, length: n.start + n.length - beat };
        n.length = beat - n.start;
        this.notesList.push(right);
        this.selected.add(right.id);
      }
    });
    return targets.length;
  }

  /** The playing / step position (beats), or null. */
  get position(): number | null {
    return this.playhead;
  }

  /** Lengthens the notes that start at a beat on the given pitches (step input's タイ). */
  lengthenAt(start: number, pitches: readonly number[], by: number): void {
    this.edit(() => {
      for (const n of this.notesList) if (Math.abs(n.start - start) < 1e-9 && pitches.includes(n.pitch)) n.length = Math.max(MIN_LENGTH, n.length + by);
    });
  }

  selectAll(): void {
    this.selected = new Set(this.notesList.map((n) => n.id));
    this.draw();
    this.onStateChange();
  }

  deleteSelected(): void {
    if (this.selected.size) this.edit(() => this.removeIds(this.selected));
  }

  /** Copies of the selection right after it (Ctrl+D). */
  duplicateSelected(): void {
    const sel = this.selection();
    if (!sel.length) return;
    const from = Math.min(...sel.map((n) => n.start));
    const to = Math.max(...sel.map((n) => n.start + n.length));
    const step = this.grid > 0 ? Math.max(this.grid, snap(to - from, this.grid)) : to - from;
    this.edit(() => {
      const copies = shifted(sel, step, 0);
      this.notesList.push(...copies);
      this.selected = new Set(copies.map((n) => n.id));
    });
  }

  transposeSelected(semitones: number): void {
    if (!this.selected.size) return;
    this.edit(() => {
      for (const n of this.selection()) n.pitch = this.clampP(n.pitch + semitones);
    });
    const first = this.selection()[0];
    if (first) this.onPreview(first.pitch);
  }

  /** Moves the selection by beats (arrow keys). */
  nudgeSelected(beats: number): void {
    const sel = this.selection();
    if (!sel.length) return;
    const room = Math.min(...sel.map((n) => n.start));
    const d = Math.max(-room, beats);
    if (d === 0) return;
    this.edit(() => {
      for (const n of sel) n.start += d;
    });
  }

  /**
   * Puts the selected notes (all of them when none is selected) on the grid:
   * each start to the nearest line, each end too (at least one step long).
   * Returns how many notes moved or changed length; nothing happens with no grid.
   */
  quantize(): number {
    const g = this.grid;
    if (!(g > 0)) return 0;
    const targets = this.selected.size ? this.selection() : this.notesList;
    let changed = 0;
    this.edit(() => {
      for (const n of targets) {
        const start = Math.max(0, snap(n.start, g));
        const length = Math.max(g, snap(n.start + n.length, g) - start);
        if (Math.abs(start - n.start) > 1e-9 || Math.abs(length - n.length) > 1e-9) changed++;
        n.start = start;
        n.length = length;
      }
    });
    return changed;
  }

  /** Sets the velocity of the selected notes (all of them when none is selected). */
  setVelocity(velocity: number): void {
    const v = Math.max(0.05, Math.min(1, velocity));
    const targets = this.selected.size ? this.selection() : this.notesList;
    this.edit(() => {
      for (const n of targets) n.velocity = v;
    });
  }

  /** The velocity shared by the selected notes, or null (none selected, or they differ). */
  get selectedVelocity(): number | null {
    const sel = this.selection();
    if (!sel.length) return null;
    const v = sel[0].velocity;
    return sel.every((n) => Math.abs(n.velocity - v) < 1e-6) ? v : null;
  }

  /** A note added from outside (step input): one undoable step; `chord` keeps the notes just added selected with it. */
  insertNote(start: number, length: number, pitch: number, velocity: number, chord = false): void {
    const note: Note = { id: newId(), start: Math.max(0, start), length: Math.max(MIN_LENGTH, length), pitch: this.clampP(pitch), velocity };
    this.edit(() => {
      this.notesList.push(note);
      if (!chord) this.selected.clear();
      this.selected.add(note.id);
    });
    // Keep it in view.
    if (!this.rowNames) {
      const rows = this.visibleRows();
      if (note.pitch > this.topPitch - 1 || note.pitch < this.topPitch - rows + 1) {
        this.topPitch = Math.min(127, note.pitch + Math.round(rows / 2));
        this.draw();
      }
    }
  }

  /** Removes the given note if it is still there (step input's 戻る). */
  removeNoteAt(start: number, pitch: number): boolean {
    const hit = this.notesList.find((n) => Math.abs(n.start - start) < 1e-9 && n.pitch === pitch);
    if (!hit) return false;
    this.edit(() => this.removeIds(new Set([hit.id])));
    return true;
  }

  copy(cut = false): void {
    const sel = this.selection();
    if (!sel.length) return;
    this.clipboard = sel.map((n) => ({ ...n, pitch: this.pitchToKey ? this.pitchToKey(n.pitch) : n.pitch }));
    if (cut) this.deleteSelected();
  }

  /** Pastes at the playhead (or the start of the view). */
  paste(): void {
    if (!this.clipboard.length) return;
    const from = Math.min(...this.clipboard.map((n) => n.start));
    const at = snap(this.playhead ?? this.scrollBeat, this.grid);
    // Keys back to this track's rows (or pitches); a drum this track has no row for is left out.
    const here = this.clipboard
      .map((n) => ({ ...n, pitch: this.keyToPitch ? this.keyToPitch(n.pitch) : n.pitch }))
      .filter((n): n is Note => n.pitch !== null)
      .map((n) => ({ ...n, pitch: this.clampP(n.pitch) }));
    if (!here.length) return;
    this.edit(() => {
      const copies = shifted(here, at - from, 0).map((n) => ({ ...n, pitch: this.clampP(n.pitch) }));
      this.notesList.push(...copies);
      this.selected = new Set(copies.map((n) => n.id));
    });
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (prev === undefined) return;
    this.redoStack.push(this.snapshot());
    this.restore(prev);
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (next === undefined) return;
    this.undoStack.push(this.snapshot());
    this.restore(next);
  }

  zoom(factor: number, atX = this.keysW + (this.width() - this.keysW) / 2): void {
    const beat = this.beatAt(atX);
    this.pxPerBeat = Math.max(6, Math.min(400, this.pxPerBeat * factor));
    this.scrollBeat = Math.max(0, beat - (atX - this.keysW) / this.pxPerBeat);
    this.draw();
  }

  // ------------------------------------------------------------- editing plumbing

  private selection(): Note[] {
    return this.notesList.filter((n) => this.selected.has(n.id));
  }

  private snapshot(): string {
    return JSON.stringify(this.notesList);
  }

  private pushUndo(state = this.snapshot()): void {
    this.undoStack.push(state);
    if (this.undoStack.length > HISTORY) this.undoStack.shift();
    this.redoStack = [];
  }

  private restore(state: string): void {
    this.notesList = (JSON.parse(state) as Note[]).map((n) => ({ ...n, id: newId() }));
    this.selected.clear();
    this.draw();
    this.onChange(this.notesList);
    this.onStateChange();
  }

  /** One undoable change. */
  private edit(change: () => void): void {
    const before = this.snapshot();
    change();
    sortNotes(this.notesList);
    if (this.snapshot() === before) return;
    this.pushUndo(before);
    this.draw();
    this.onChange(this.notesList);
    this.onStateChange();
  }

  private removeIds(ids: Set<number>): void {
    this.notesList = this.notesList.filter((n) => !ids.has(n.id));
    for (const id of ids) this.selected.delete(id);
  }

  // ------------------------------------------------------------- geometry

  private width(): number {
    return this.canvas.clientWidth;
  }

  private visibleRows(): number {
    return Math.max(1, (this.canvas.clientHeight - RULER_H - this.laneH) / this.rowH);
  }

  private visibleBeats(): number {
    return Math.max(0.5, (this.width() - this.keysW) / this.pxPerBeat);
  }

  private beatAt(x: number): number {
    return this.scrollBeat + (x - this.keysW) / this.pxPerBeat;
  }

  private xOf(beat: number): number {
    return this.keysW + (beat - this.scrollBeat) * this.pxPerBeat;
  }

  private pitchAt(y: number): number {
    if (this.rowNames) return this.clampP(Math.floor((y - RULER_H) / this.rowH) + this.scrollRow);
    return this.clampP(Math.ceil(this.topPitch - (y - RULER_H) / this.rowH));
  }

  private yOf(pitch: number): number {
    if (this.rowNames) return RULER_H + (pitch - this.scrollRow) * this.rowH;
    return RULER_H + (this.topPitch - pitch) * this.rowH;
  }

  private noteAt(x: number, y: number, edgeReach = EDGE_MOUSE): { note: Note; edge: boolean } | null {
    if (x < this.keysW || y < RULER_H || this.inLane(y)) return null;
    const pitch = this.pitchAt(y);
    for (let i = this.notesList.length - 1; i >= 0; i--) {
      const n = this.notesList[i];
      if (n.pitch !== pitch) continue;
      const x0 = this.xOf(n.start);
      const x1 = this.xOf(n.start + n.length);
      if (x >= x0 && x <= x1 + 2) return { note: n, edge: x1 - x0 > edgeReach * 2 && x >= x1 - edgeReach };
    }
    return null;
  }

  /** Where the notes end at the bottom (the velocity lane, when shown, is under them). */
  private get notesBottom(): number {
    return this.canvas.clientHeight - this.laneH;
  }

  /** How far the song reaches sideways (beats): past the last note, the loop and the view. */
  private contentBeats(): number {
    return Math.max(songEnd(this.notesList) + this.beatsPerBar * 4, this.loop.end + this.beatsPerBar, this.scrollBeat + this.visibleBeats(), this.beatsPerBar * 8);
  }

  /** The sideways bar: its track (x0…x1 at y0…y1) and its thumb (a…b). */
  private hBar(): { x0: number; x1: number; y0: number; y1: number; a: number; b: number } {
    const x0 = this.keysW;
    const x1 = this.width() - SCROLLBAR;
    const y1 = this.notesBottom;
    const track = Math.max(1, x1 - x0);
    const total = this.contentBeats();
    const len = Math.min(track, Math.max(MIN_THUMB, (this.visibleBeats() / total) * track));
    const a = x0 + (this.scrollBeat / Math.max(1e-9, total - this.visibleBeats())) * (track - len);
    return { x0, x1, y0: y1 - SCROLLBAR, y1, a: Math.min(a, x1 - len), b: Math.min(a, x1 - len) + len };
  }

  /** The up-down bar (pitches, or a drum track's rows). */
  private vBar(): { x0: number; x1: number; y0: number; y1: number; a: number; b: number } {
    const x1 = this.width();
    const y0 = RULER_H;
    const y1 = this.notesBottom - SCROLLBAR;
    const track = Math.max(1, y1 - y0);
    const rows = this.visibleRows();
    const total = this.rowNames ? Math.max(rows, this.rowNames.length) : 128;
    const first = this.rowNames ? this.scrollRow : 127 - this.topPitch;
    const len = Math.min(track, Math.max(MIN_THUMB, (rows / total) * track));
    const room = Math.max(1e-9, total - rows);
    const a = y0 + (Math.max(0, Math.min(room, first)) / room) * (track - len);
    return { x0: x1 - SCROLLBAR, x1, y0, y1, a, b: a + len };
  }

  /** Scrolls so the sideways thumb's start is at x. */
  private scrollToH(thumbStart: number): void {
    const bar = this.hBar();
    const len = bar.b - bar.a;
    const share = Math.max(0, Math.min(1, (thumbStart - bar.x0) / Math.max(1, bar.x1 - bar.x0 - len)));
    this.scrollBeat = share * Math.max(0, this.contentBeats() - this.visibleBeats());
    this.viewTouched = true;
    this.clampView();
    this.draw();
  }

  private scrollToV(thumbStart: number): void {
    const bar = this.vBar();
    const len = bar.b - bar.a;
    const share = Math.max(0, Math.min(1, (thumbStart - bar.y0) / Math.max(1, bar.y1 - bar.y0 - len)));
    const rows = this.visibleRows();
    if (this.rowNames) this.scrollRow = share * Math.max(0, this.rowNames.length - rows);
    else this.topPitch = 127 - share * Math.max(0, 128 - rows);
    this.viewTouched = true;
    this.clampView();
    this.draw();
  }

  private inLane(y: number): boolean {
    return this.laneH > 0 && y >= this.canvas.clientHeight - this.laneH;
  }

  /** The velocity a height in the lane stands for. */
  private velocityAt(y: number): number {
    const ch = this.canvas.clientHeight;
    const top = ch - this.laneH + 6;
    const bottom = ch - 4;
    return Math.max(0.05, Math.min(1, (bottom - y) / Math.max(1, bottom - top)));
  }

  /** Sets the velocity of the notes that start between two x positions (the selected ones only, when some are). */
  private paintVelocity(xa: number, xb: number, value: number): void {
    const lo = Math.min(xa, xb) - 4;
    const hi = Math.max(xa, xb) + 4;
    const only = this.selected.size > 0;
    for (const n of this.notesList) {
      if (only && !this.selected.has(n.id)) continue;
      const x = this.xOf(n.start);
      if (x >= lo && x <= hi) n.velocity = value;
    }
  }

  private clampView(): void {
    this.scrollBeat = Math.max(0, this.scrollBeat);
    if (this.rowNames) {
      this.scrollRow = Math.max(0, Math.min(Math.max(0, this.rowNames.length - Math.floor(this.visibleRows())), Math.round(this.scrollRow)));
      return;
    }
    const rows = this.visibleRows();
    this.topPitch = Math.max(Math.min(127, rows - 1), Math.min(127, this.topPitch));
  }

  // ------------------------------------------------------------- pointer

  private local(e: PointerEvent | MouseEvent): { x: number; y: number } {
    const box = this.canvas.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  }

  /** The menu at a point: on a note, the dropper first (its length and velocity for new notes), and the note joins the selection. */
  private menuAt(x: number, y: number, clientX: number, clientY: number): void {
    const hit = y >= RULER_H && !this.inLane(y) ? this.noteAt(x, y) : null;
    if (hit) {
      this.lastLength = hit.note.length;
      this.defaultVelocity = hit.note.velocity;
      this.onDefaultsChange();
      if (!this.selected.has(hit.note.id)) this.selected = new Set([hit.note.id]);
      this.draw();
      this.onStateChange();
    }
    this.onMenu(clientX, clientY, hit?.note ?? null);
  }

  private clearLongPress(): void {
    clearTimeout(this.longPress);
    this.longPress = 0;
  }

  private down(e: PointerEvent): void {
    // A right-click during a drag cancels it (as in Domino); otherwise it is the menu (contextmenu).
    if (e.pointerType === "mouse" && e.button === 2) {
      if (this.drag && this.drag.kind !== "pending") {
        this.cancel();
        this.menuSuppressed = true;
      }
      return;
    }
    const middle = e.pointerType === "mouse" && e.button === 1;
    if (e.button !== 0 && e.pointerType === "mouse" && !middle) return;
    this.canvas.focus({ preventScroll: true });
    const { x, y } = this.local(e);
    const fine = e.pointerType === "mouse" || e.pointerType === "pen";
    this.canvas.setPointerCapture(e.pointerId);
    this.gestureStart = this.snapshot();
    if (middle) {
      // The middle button drags the view anywhere (and does not start the browser's auto-scroll).
      e.preventDefault();
      this.drag = { kind: "pan", x, y, beat: this.scrollBeat, top: this.rowNames ? this.scrollRow : this.topPitch };
      return;
    }
    // The scroll bars: drag the thumb, or press the track to bring the thumb there.
    const h = this.hBar();
    if (x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1) {
      if (x < h.a || x > h.b) this.scrollToH(x - (h.b - h.a) / 2);
      this.drag = { kind: "scrollH", grab: x - this.hBar().a };
      return;
    }
    const v = this.vBar();
    if (x >= v.x0 && x <= v.x1 && y >= v.y0 && y <= v.y1) {
      if (y < v.a || y > v.b) this.scrollToV(y - (v.b - v.a) / 2);
      this.drag = { kind: "scrollV", grab: y - this.vBar().a };
      return;
    }
    if (y < RULER_H && x >= this.keysW) {
      this.drag = { kind: "ruler", x, moved: false };
      return;
    }
    if (this.inLane(y)) {
      // (a little into the keys too: the bar of a note at the left edge starts right on it)
      if (x < this.keysW - 8) {
        this.drag = null;
        return;
      }
      const value = this.velocityAt(y);
      this.drag = { kind: "velocity", x, value };
      this.paintVelocity(x, x, value);
      this.draw();
      return;
    }
    if (x < this.keysW) {
      // A drum row's name selects its notes; a key sounds its pitch.
      if (this.rowNames) this.selectRow(this.pitchAt(y), e.shiftKey);
      this.onPreview(this.pitchAt(y));
      this.drag = null;
      return;
    }
    if (e.pointerType === "touch") {
      this.clearLongPress();
      const clientX = e.clientX;
      const clientY = e.clientY;
      this.longPress = window.setTimeout(() => {
        this.longPress = 0;
        const d = this.drag;
        // Only a finger that stayed put: nothing moved, nothing scrolled.
        if (!d || (d.kind !== "pending" && !(d.kind === "move" && !d.moved) && d.kind !== "resize")) return;
        if (d.kind === "resize") this.restore(this.gestureStart);
        this.drag = null;
        this.menuAt(x, y, clientX, clientY);
      }, LONG_PRESS_MS);
    }
    const hit = this.noteAt(x, y, fine ? EDGE_MOUSE : EDGE_TOUCH);
    if (hit) {
      if (e.shiftKey && fine) {
        if (this.selected.has(hit.note.id)) this.selected.delete(hit.note.id);
        else this.selected.add(hit.note.id);
        this.drag = null;
        this.draw();
        this.onStateChange();
        return;
      }
      if (!this.selected.has(hit.note.id)) this.selected = new Set([hit.note.id]);
      if ((e.ctrlKey || e.metaKey) && !hit.edge) {
        // Ctrl-drag: the copies move, the originals stay.
        const copies = shifted(this.selection(), 0, 0);
        this.notesList.push(...copies);
        const anchorCopy = copies[this.selection().indexOf(hit.note)] ?? copies[0];
        this.selected = new Set(copies.map((n) => n.id));
        this.startMove(anchorCopy, x, y, true);
      } else if (hit.edge) {
        this.drag = { kind: "resize", anchor: hit.note, orig: this.origOfSelection(), ctrl: e.ctrlKey || e.metaKey };
      } else this.startMove(hit.note, x, y, e.ctrlKey || e.metaKey);
      this.draw();
      this.onStateChange();
      return;
    }
    this.drag = { kind: "pending", x, y, shift: e.shiftKey, fine };
  }

  private startMove(anchor: Note, x: number, y: number, ctrl = false): void {
    this.drag = { kind: "move", anchor, x, y, orig: this.origOfSelection(), moved: false, lastPitch: anchor.pitch, ctrl };
  }

  /** Off the grid for this move: Alt, or Ctrl pressed after the drag began (Domino's temporary snap toggle). */
  private static free(e: PointerEvent, ctrlAtStart: boolean): boolean {
    return e.altKey || (!ctrlAtStart && (e.ctrlKey || e.metaKey));
  }

  private origOfSelection(): Map<number, Note> {
    return new Map(this.selection().map((n) => [n.id, { ...n }]));
  }

  private move(e: PointerEvent): void {
    const d = this.drag;
    const { x, y } = this.local(e);
    if (!d) {
      if (e.pointerType === "mouse") {
        const hit = this.noteAt(x, y);
        const h = this.hBar();
        const v = this.vBar();
        const onBar = (x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1) || (x >= v.x0 && y >= v.y0 && y <= v.y1);
        this.canvas.style.cursor = onBar ? "default" : y < RULER_H ? "pointer" : hit?.edge ? "ew-resize" : hit ? "move" : "default";
      }
      return;
    }
    switch (d.kind) {
      case "pending": {
        if (Math.hypot(x - d.x, y - d.y) < TAP_PX) return;
        this.clearLongPress();
        if (d.fine || this.selectMode) this.drag = { kind: "box", x0: d.x, y0: d.y, x1: x, y1: y, add: d.shift ? new Set(this.selected) : new Set() };
        else this.drag = { kind: "pan", x: d.x, y: d.y, beat: this.scrollBeat, top: this.rowNames ? this.scrollRow : this.topPitch };
        this.move(e);
        return;
      }
      case "pan":
        this.viewTouched = true;
        this.scrollBeat = d.beat - (x - d.x) / this.pxPerBeat;
        if (this.rowNames) this.scrollRow = Math.round(d.top - (y - d.y) / this.rowH);
        else this.topPitch = d.top + (y - d.y) / this.rowH;
        this.clampView();
        this.draw();
        return;
      case "box": {
        d.x1 = x;
        d.y1 = y;
        const b0 = Math.min(this.beatAt(d.x0), this.beatAt(d.x1));
        const b1 = Math.max(this.beatAt(d.x0), this.beatAt(d.x1));
        const p0 = Math.min(this.pitchAt(d.y0), this.pitchAt(d.y1));
        const p1 = Math.max(this.pitchAt(d.y0), this.pitchAt(d.y1));
        this.selected = new Set(d.add);
        for (const n of this.notesList) if (n.pitch >= p0 && n.pitch <= p1 && n.start < b1 && n.start + n.length > b0) this.selected.add(n.id);
        this.draw();
        return;
      }
      case "move": {
        if (!d.moved && Math.hypot(x - d.x, y - d.y) < TAP_PX) return;
        d.moved = true;
        this.clearLongPress();
        const anchorOrig = d.orig.get(d.anchor.id)!;
        const raw = anchorOrig.start + (x - d.x) / this.pxPerBeat;
        let dBeat = (PianoRoll.free(e, d.ctrl) ? raw : snap(raw, this.grid)) - anchorOrig.start;
        const earliest = Math.min(...[...d.orig.values()].map((n) => n.start));
        dBeat = Math.max(-earliest, dBeat);
        const dPitch = this.pitchAt(y) - this.pitchAt(d.y);
        for (const n of this.notesList) {
          const o = d.orig.get(n.id);
          if (!o) continue;
          n.start = o.start + dBeat;
          n.pitch = this.clampP(o.pitch + dPitch);
        }
        if (d.anchor.pitch !== d.lastPitch) {
          d.lastPitch = d.anchor.pitch;
          this.onPreview(d.anchor.pitch);
        }
        this.draw();
        return;
      }
      case "resize": {
        const anchorOrig = d.orig.get(d.anchor.id)!;
        const rawEnd = this.beatAt(x);
        const minLen = this.grid > 0 ? this.grid : MIN_LENGTH;
        const end = PianoRoll.free(e, d.ctrl) ? rawEnd : snap(rawEnd, this.grid);
        this.clearLongPress();
        const dLen = Math.max(minLen, end - anchorOrig.start) - anchorOrig.length;
        for (const n of this.notesList) {
          const o = d.orig.get(n.id);
          if (o) n.length = Math.max(minLen, o.length + dLen);
        }
        this.lastLength = d.anchor.length;
        this.onDefaultsChange();
        this.draw();
        return;
      }
      case "scrollH":
        this.scrollToH(x - d.grab);
        return;
      case "scrollV":
        this.scrollToV(y - d.grab);
        return;
      case "velocity": {
        d.value = this.velocityAt(y);
        this.paintVelocity(d.x, x, d.value);
        d.x = x;
        this.draw();
        return;
      }
      case "ruler": {
        if (!d.moved && Math.abs(x - d.x) < TAP_PX) return;
        d.moved = true;
        const g = Math.max(this.grid || 0.25, 0.25);
        const a = snapDown(Math.max(0, this.beatAt(Math.min(d.x, x))), g);
        const b = Math.max(a + g, snap(this.beatAt(Math.max(d.x, x)), g));
        this.loop = { start: a, end: b, on: true };
        this.draw();
        return;
      }
    }
  }

  private up(e: PointerEvent): void {
    this.clearLongPress();
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const { x, y } = this.local(e);
    switch (d.kind) {
      case "pending": {
        if (this.rowNames && this.rowNames.length === 0) return; // a drum track with no rows yet
        // A tap on empty grid: a note there.
        const start = Math.max(0, snapDown(this.beatAt(x), this.grid));
        const note: Note = { id: newId(), start, length: this.lastLength, pitch: this.pitchAt(y), velocity: this.defaultVelocity };
        this.notesList.push(note);
        this.selected = new Set([note.id]);
        this.finishGesture();
        this.onPreview(note.pitch);
        return;
      }
      case "ruler": {
        if (d.moved) {
          this.onLoopChange({ ...this.loop });
          return;
        }
        const now = performance.now();
        const play = now - this.lastRulerTap < DOUBLE_TAP_MS;
        this.lastRulerTap = play ? 0 : now;
        this.onSeek(Math.max(0, snap(this.beatAt(x), this.grid)), play);
        return;
      }
      case "box":
      case "pan":
      case "scrollH":
      case "scrollV":
        this.draw();
        this.onStateChange();
        return;
      case "move":
      case "resize":
      case "velocity":
        this.finishGesture();
        return;
    }
  }

  private cancel(): void {
    this.clearLongPress();
    if (this.drag && this.drag.kind !== "pan" && this.drag.kind !== "pending" && this.drag.kind !== "scrollH" && this.drag.kind !== "scrollV") this.restore(this.gestureStart);
    this.drag = null;
  }

  /** A drag or a tap ended: one undoable step if anything changed. */
  private finishGesture(): void {
    sortNotes(this.notesList);
    if (this.snapshot() !== this.gestureStart) {
      this.pushUndo(this.gestureStart);
      this.onChange(this.notesList);
    }
    this.draw();
    this.onStateChange();
  }

  private doubleClick(e: MouseEvent): void {
    const { x, y } = this.local(e);
    const hit = this.noteAt(x, y);
    if (hit && !hit.edge) this.edit(() => this.removeIds(new Set([hit.note.id])));
  }

  private wheel(e: WheelEvent): void {
    const { x } = this.local(e);
    e.preventDefault();
    this.viewTouched = true;
    if (e.ctrlKey || e.metaKey) {
      this.zoom(Math.exp(-e.deltaY * 0.01), Math.max(this.keysW, x));
      return;
    }
    const unit = e.deltaMode === 1 ? 16 : 1;
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const delta = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * unit;
      this.scrollBeat += delta / this.pxPerBeat;
    } else if (this.rowNames) this.scrollRow += Math.sign(e.deltaY);
    else this.topPitch -= (e.deltaY * unit) / this.rowH / 2;
    this.clampView();
    this.draw();
  }

  private key(e: KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    let handled = true;
    if (k === "delete" || k === "backspace") this.deleteSelected();
    else if (k === "escape") {
      this.selected.clear();
      this.draw();
      this.onStateChange();
    } else if (k === " " || e.code === "Space") this.onTogglePlay();
    else if (mod && k === "a") this.selectAll();
    else if (mod && k === "c") this.copy();
    else if (mod && k === "x") this.copy(true);
    else if (mod && k === "v") this.paste();
    else if (mod && k === "d") this.duplicateSelected();
    else if (mod && (k === "y" || (k === "z" && e.shiftKey))) this.redo();
    else if (mod && k === "z") this.undo();
    else if (k === "arrowup" || k === "arrowdown") this.transposeSelected((k === "arrowup" ? 1 : -1) * (e.shiftKey ? 12 : 1));
    else if (k === "arrowleft" || k === "arrowright") this.nudgeSelected((k === "arrowright" ? 1 : -1) * (this.grid || 0.25));
    else if (mod && (k === "pageup" || k === "pagedown")) this.onTrackStep(k === "pageup" ? -1 : 1);
    else handled = false;
    if (handled) {
      e.preventDefault();
      // (The page's own Space / Ctrl+Z belong to the material editor.)
      e.stopPropagation();
    }
  }

  // ------------------------------------------------------------- drawing

  draw(): void {
    const dpr = window.devicePixelRatio || 1;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    const W = Math.max(1, Math.round(cw * dpr));
    const H = Math.max(1, Math.round(ch * dpr));
    if (this.canvas.width !== W) this.canvas.width = W;
    if (this.canvas.height !== H) this.canvas.height = H;
    const g = this.canvas.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cw, ch);
    if (this.pendingFrame !== null && ch > 0) {
      const p = this.pendingFrame;
      this.frame(p); // (draws again, sized)
      return;
    }
    this.clampView();

    const rowsMode = this.rowNames !== null;
    const firstPitch = Math.min(this.pitchAt(ch - 1), this.pitchAt(RULER_H));
    const lastPitch = rowsMode ? Math.min(this.rowNames!.length - 1, Math.max(this.pitchAt(ch - 1), this.pitchAt(RULER_H))) : Math.max(this.pitchAt(ch - 1), this.pitchAt(RULER_H));
    const laneTop = ch - this.laneH;
    // Rows: the black keys' rows shaded and a line under every C, or (drum rows) every other row shaded and a line under each.
    for (let p = firstPitch; p <= lastPitch; p++) {
      const y = this.yOf(p);
      if (rowsMode) {
        if (p % 2) {
          g.fillStyle = cssVar("--outside");
          g.fillRect(this.keysW, y, cw - this.keysW, this.rowH);
        }
        g.fillStyle = cssVar("--grid");
        g.fillRect(this.keysW, y + this.rowH - 1, cw - this.keysW, 1);
        continue;
      }
      if (isBlack(p)) {
        g.fillStyle = cssVar("--outside");
        g.fillRect(this.keysW, y, cw - this.keysW, this.rowH);
      }
      if (p % 12 === 0) {
        g.fillStyle = cssVar("--grid-strong");
        g.fillRect(this.keysW, y + this.rowH - 1, cw - this.keysW, 1);
      }
    }
    // The loop range, under everything.
    const lx0 = this.xOf(this.loop.start);
    const lx1 = this.xOf(this.loop.end);
    if (this.loop.on) {
      g.globalAlpha = 0.08;
      g.fillStyle = cssVar("--accent");
      g.fillRect(Math.max(this.keysW, lx0), RULER_H, Math.max(0, Math.min(cw, lx1) - Math.max(this.keysW, lx0)), ch - RULER_H);
      g.globalAlpha = 1;
    }
    // Vertical lines: the grid, the beats, the bars.
    const view0 = this.scrollBeat;
    const view1 = this.beatAt(cw);
    const step = this.grid > 0 && this.grid * this.pxPerBeat >= 6 ? this.grid : this.pxPerBeat >= 6 ? 1 : this.beatsPerBar;
    for (let b = snapDown(view0, step); b <= view1; b += step) {
      const x = Math.round(this.xOf(b));
      const bar = Math.abs(b / this.beatsPerBar - Math.round(b / this.beatsPerBar)) < 1e-6;
      const beat = Math.abs(b - Math.round(b)) < 1e-6;
      g.fillStyle = cssVar(bar ? "--grid-strong" : "--grid");
      g.globalAlpha = bar || beat ? 1 : 0.5;
      g.fillRect(x, RULER_H, 1, ch - RULER_H);
    }
    g.globalAlpha = 1;

    // Notes.
    const accent = cssVar("--accent");
    const selectedColor = cssVar("--warn");
    const text = cssVar("--text");
    g.font = `${Math.min(11, this.rowH - 3)}px system-ui, sans-serif`;
    g.textBaseline = "middle";
    if (!rowsMode && this.ghosts.length) {
      g.fillStyle = cssVar("--muted");
      for (const n of this.ghosts) {
        if (n.pitch < firstPitch || n.pitch > lastPitch) continue;
        const x0 = this.xOf(n.start);
        const x1 = this.xOf(n.start + n.length);
        if (x1 < this.keysW || x0 > cw) continue;
        const left = Math.max(this.keysW, x0);
        g.globalAlpha = 0.28;
        g.fillRect(left + 0.5, this.yOf(n.pitch) + 2, Math.max(2, x1 - left - 1), this.rowH - 4);
      }
      g.globalAlpha = 1;
    }
    for (const n of this.notesList) {
      if (n.pitch < firstPitch || n.pitch > lastPitch) continue;
      const x0 = this.xOf(n.start);
      const x1 = this.xOf(n.start + n.length);
      if (x1 < this.keysW || x0 > cw) continue;
      const y = this.yOf(n.pitch);
      const sel = this.selected.has(n.id);
      g.globalAlpha = 0.45 + 0.55 * n.velocity;
      g.fillStyle = sel ? selectedColor : accent;
      g.fillRect(Math.max(this.keysW, x0) + 0.5, y + 1, Math.max(2, x1 - Math.max(this.keysW, x0) - 1), this.rowH - 2);
      g.globalAlpha = 1;
      if (sel) {
        g.strokeStyle = text;
        g.lineWidth = 1;
        g.strokeRect(Math.max(this.keysW, x0) + 0.5, y + 1.5, Math.max(2, x1 - Math.max(this.keysW, x0) - 1), this.rowH - 3);
      }
      if (!rowsMode && x1 - x0 > 28 && this.rowH >= 12) {
        g.fillStyle = cssVar("--accent-text");
        g.fillText(NAMES[n.pitch % 12] + (Math.floor(n.pitch / 12) - 1), Math.max(this.keysW, x0) + 3, y + this.rowH / 2);
      }
    }

    // The scroll bars, over the grid's right and bottom edges.
    {
      const thumb = cssVar("--muted");
      for (const [bar, across] of [[this.hBar(), true], [this.vBar(), false]] as const) {
        g.globalAlpha = 0.12;
        g.fillStyle = thumb;
        g.fillRect(bar.x0, bar.y0, bar.x1 - bar.x0, bar.y1 - bar.y0);
        g.globalAlpha = this.drag?.kind === (across ? "scrollH" : "scrollV") ? 0.85 : 0.6;
        const r = (across ? bar.y1 - bar.y0 : bar.x1 - bar.x0) / 2 - 2;
        g.beginPath();
        if (across) g.roundRect(bar.a, bar.y0 + 2, Math.max(4, bar.b - bar.a), bar.y1 - bar.y0 - 4, r);
        else g.roundRect(bar.x0 + 2, bar.a, bar.x1 - bar.x0 - 4, Math.max(4, bar.b - bar.a), r);
        g.fill();
        g.globalAlpha = 1;
      }
    }

    // The selection box.
    const d = this.drag;
    if (d?.kind === "box") {
      g.strokeStyle = text;
      g.setLineDash([4, 3]);
      g.strokeRect(Math.min(d.x0, d.x1) + 0.5, Math.min(d.y0, d.y1) + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      g.setLineDash([]);
    }

    // The keys on the left (or the drum rows' names).
    g.fillStyle = cssVar("--panel");
    g.fillRect(0, RULER_H, this.keysW, ch - RULER_H);
    if (rowsMode) {
      g.font = `${COARSE ? 13 : 12}px system-ui, sans-serif`;
      for (let p = firstPitch; p <= lastPitch; p++) {
        const y = this.yOf(p);
        g.fillStyle = cssVar(p % 2 ? "--outside" : "--panel");
        g.fillRect(0, y, this.keysW - 1, this.rowH);
        g.fillStyle = cssVar("--text");
        let label = this.rowNames![p] ?? "";
        while (label.length > 1 && g.measureText(label).width > this.keysW - 10) label = label.slice(0, -1);
        g.fillText(label === this.rowNames![p] ? label : `${label.slice(0, -1)}…`, 5, y + this.rowH / 2);
      }
      if (this.rowNames!.length === 0) {
        g.fillStyle = cssVar("--muted");
        g.fillText("行がありません", 5, RULER_H + 16);
      }
    } else for (let p = firstPitch; p <= lastPitch; p++) {
      const y = this.yOf(p);
      g.fillStyle = cssVar(p === this.root ? "--key-root" : isBlack(p) ? "--key-black" : "--key-white");
      g.fillRect(0, y, isBlack(p) ? this.keysW * 0.62 : this.keysW - 1, this.rowH - (isBlack(p) ? 1 : 0));
      if (p % 12 === 0 || p === this.root) {
        g.fillStyle = p === this.root ? cssVar("--accent-text") : cssVar("--muted");
        g.fillText(`${NAMES[p % 12]}${Math.floor(p / 12) - 1}`, 3, y + this.rowH / 2);
      }
    }
    g.fillStyle = cssVar("--line");
    g.fillRect(this.keysW - 1, RULER_H, 1, ch - RULER_H);

    // The velocity lane: a bar per note, as high as it is strong.
    if (this.laneH > 0) {
      g.fillStyle = cssVar("--panel");
      g.fillRect(0, laneTop, cw, this.laneH);
      g.fillStyle = cssVar("--line");
      g.fillRect(0, laneTop, cw, 1);
      g.fillStyle = cssVar("--muted");
      g.font = `${COARSE ? 13 : 12}px system-ui, sans-serif`;
      g.fillText("強弱", 5, laneTop + this.laneH / 2);
      const top = laneTop + 6;
      const bottom = ch - 4;
      g.fillStyle = cssVar("--grid");
      g.fillRect(this.keysW, top, cw - this.keysW, 1);
      const barW = COARSE ? 6 : 4;
      for (const n of this.notesList) {
        const x = this.xOf(n.start);
        if (x < this.keysW - barW || x > cw) continue;
        const h = Math.max(2, n.velocity * (bottom - top));
        g.fillStyle = this.selected.has(n.id) ? selectedColor : accent;
        g.fillRect(Math.round(x), bottom - h, barW, h);
      }
      if (d?.kind === "velocity") {
        g.fillStyle = text;
        g.fillText(String(Math.round(d.value * 127)), Math.min(cw - 30, d.x + 8), top + 10);
      }
    }

    // The ruler: bar numbers and the loop.
    g.fillStyle = cssVar("--strip");
    g.fillRect(0, 0, cw, RULER_H);
    if (lx1 > this.keysW && lx0 < cw) {
      g.fillStyle = this.loop.on ? accent : cssVar("--muted");
      g.globalAlpha = this.loop.on ? 0.55 : 0.25;
      g.fillRect(Math.max(this.keysW, lx0), 3, Math.max(0, Math.min(cw, lx1) - Math.max(this.keysW, lx0)), RULER_H - 6);
      g.globalAlpha = 1;
    }
    g.fillStyle = cssVar("--muted");
    const barPx = this.beatsPerBar * this.pxPerBeat;
    const every = barPx >= 28 ? 1 : Math.ceil(28 / barPx);
    for (let bar = Math.floor(view0 / this.beatsPerBar); bar * this.beatsPerBar <= view1; bar++) {
      if (bar % every) continue;
      const x = this.xOf(bar * this.beatsPerBar);
      if (x < this.keysW - 1) continue;
      g.fillRect(Math.round(x), RULER_H - 8, 1, 8);
      g.fillText(String(bar + 1), x + 3, RULER_H / 2);
    }
    g.fillStyle = cssVar("--line");
    g.fillRect(0, RULER_H - 1, cw, 1);

    // The playhead.
    if (this.playhead !== null) {
      const x = this.xOf(this.playhead);
      if (x >= this.keysW && x <= cw) {
        g.fillStyle = text;
        g.fillRect(Math.round(x), 0, 2, ch);
      }
    }
  }
}
