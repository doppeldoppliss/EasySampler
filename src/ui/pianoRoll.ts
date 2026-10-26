// The piano roll (design.md 13, phase 1): notes on a beat grid, edited with a
// mouse or a finger.
//
// Mouse / pen: click on empty grid = a note there; drag on empty = select a
// box (Shift adds); drag a note = move the selection (Ctrl = a copy); drag a
// note's right end = change the length; double-click or right-click a note =
// delete. Finger: tap = a note, drag on empty = scroll (or select, with
// 範囲選択 on), drag a note or its right end as with a mouse.
// The ruler: tap = play from there, double-tap = start playing, drag = loop range.
// Keys (when the roll has the focus): Delete, Ctrl+A / C / X / V / D, arrows
// (Shift = an octave), Ctrl+Z / Y, Space = play / stop, Esc.

import { clampPitch, MIN_LENGTH, newId, shifted, snap, snapDown, sortNotes, type Note } from "../daw/model";
import { cssVar } from "./dom";

const KEYS_W = 44;
const RULER_H = 24;
const COARSE = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
const ROW_H = COARSE ? 20 : 13;
const EDGE_MOUSE = 6;
const EDGE_TOUCH = 14;
const TAP_PX = COARSE ? 10 : 4;
const DOUBLE_TAP_MS = 350;
const HISTORY = 200;
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const isBlack = (pitch: number) => [1, 3, 6, 8, 10].includes(((pitch % 12) + 12) % 12);

type Drag =
  | { kind: "pending"; x: number; y: number; shift: boolean; fine: boolean }
  | { kind: "pan"; x: number; y: number; beat: number; top: number }
  | { kind: "box"; x0: number; y0: number; x1: number; y1: number; add: Set<number> }
  | { kind: "move"; anchor: Note; x: number; y: number; orig: Map<number, Note>; moved: boolean; lastPitch: number }
  | { kind: "resize"; anchor: Note; orig: Map<number, Note> }
  | { kind: "ruler"; x: number; moved: boolean };

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

  /** Snap in beats (0 = off). */
  grid = 0.25;
  /** Finger drag on empty grid selects instead of scrolling. */
  selectMode = false;
  /** Length of the next note placed (follows the last one resized). */
  lastLength = 1;

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
    this.canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const hit = this.noteAt(e.offsetX, e.offsetY);
      if (hit) this.edit(() => this.removeIds(new Set([hit.note.id])));
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

  /** Replaces the notes (a load or an import); `keepHistory` makes it one undoable step. */
  setNotes(notes: Note[], keepHistory = false): void {
    if (keepHistory) this.pushUndo();
    else {
      this.undoStack = [];
      this.redoStack = [];
    }
    this.notesList = sortNotes(notes.map((n) => ({ ...n })));
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

  // ------------------------------------------------------------- commands

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
      for (const n of this.selection()) n.pitch = clampPitch(n.pitch + semitones);
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

  copy(cut = false): void {
    const sel = this.selection();
    if (!sel.length) return;
    this.clipboard = sel.map((n) => ({ ...n }));
    if (cut) this.deleteSelected();
  }

  /** Pastes at the playhead (or the start of the view). */
  paste(): void {
    if (!this.clipboard.length) return;
    const from = Math.min(...this.clipboard.map((n) => n.start));
    const at = snap(this.playhead ?? this.scrollBeat, this.grid);
    this.edit(() => {
      const copies = shifted(this.clipboard, at - from, 0);
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

  zoom(factor: number, atX = KEYS_W + (this.width() - KEYS_W) / 2): void {
    const beat = this.beatAt(atX);
    this.pxPerBeat = Math.max(6, Math.min(400, this.pxPerBeat * factor));
    this.scrollBeat = Math.max(0, beat - (atX - KEYS_W) / this.pxPerBeat);
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
    return Math.max(1, (this.canvas.clientHeight - RULER_H) / ROW_H);
  }

  private visibleBeats(): number {
    return Math.max(0.5, (this.width() - KEYS_W) / this.pxPerBeat);
  }

  private beatAt(x: number): number {
    return this.scrollBeat + (x - KEYS_W) / this.pxPerBeat;
  }

  private xOf(beat: number): number {
    return KEYS_W + (beat - this.scrollBeat) * this.pxPerBeat;
  }

  private pitchAt(y: number): number {
    return clampPitch(Math.ceil(this.topPitch - (y - RULER_H) / ROW_H));
  }

  private yOf(pitch: number): number {
    return RULER_H + (this.topPitch - pitch) * ROW_H;
  }

  private noteAt(x: number, y: number, edgeReach = EDGE_MOUSE): { note: Note; edge: boolean } | null {
    if (x < KEYS_W || y < RULER_H) return null;
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

  private clampView(): void {
    this.scrollBeat = Math.max(0, this.scrollBeat);
    const rows = this.visibleRows();
    this.topPitch = Math.max(Math.min(127, rows - 1), Math.min(127, this.topPitch));
  }

  // ------------------------------------------------------------- pointer

  private local(e: PointerEvent | MouseEvent): { x: number; y: number } {
    const box = this.canvas.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  }

  private down(e: PointerEvent): void {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    this.canvas.focus({ preventScroll: true });
    const { x, y } = this.local(e);
    const fine = e.pointerType === "mouse" || e.pointerType === "pen";
    this.canvas.setPointerCapture(e.pointerId);
    this.gestureStart = this.snapshot();
    if (y < RULER_H && x >= KEYS_W) {
      this.drag = { kind: "ruler", x, moved: false };
      return;
    }
    if (x < KEYS_W) {
      this.onPreview(this.pitchAt(y));
      this.drag = null;
      return;
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
        this.startMove(anchorCopy, x, y);
      } else if (hit.edge) {
        this.drag = { kind: "resize", anchor: hit.note, orig: this.origOfSelection() };
      } else this.startMove(hit.note, x, y);
      this.draw();
      this.onStateChange();
      return;
    }
    this.drag = { kind: "pending", x, y, shift: e.shiftKey, fine };
  }

  private startMove(anchor: Note, x: number, y: number): void {
    this.drag = { kind: "move", anchor, x, y, orig: this.origOfSelection(), moved: false, lastPitch: anchor.pitch };
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
        this.canvas.style.cursor = y < RULER_H ? "pointer" : hit?.edge ? "ew-resize" : hit ? "move" : "default";
      }
      return;
    }
    switch (d.kind) {
      case "pending": {
        if (Math.hypot(x - d.x, y - d.y) < TAP_PX) return;
        if (d.fine || this.selectMode) this.drag = { kind: "box", x0: d.x, y0: d.y, x1: x, y1: y, add: d.shift ? new Set(this.selected) : new Set() };
        else this.drag = { kind: "pan", x: d.x, y: d.y, beat: this.scrollBeat, top: this.topPitch };
        this.move(e);
        return;
      }
      case "pan":
        this.viewTouched = true;
        this.scrollBeat = d.beat - (x - d.x) / this.pxPerBeat;
        this.topPitch = d.top + (y - d.y) / ROW_H;
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
        const anchorOrig = d.orig.get(d.anchor.id)!;
        const raw = anchorOrig.start + (x - d.x) / this.pxPerBeat;
        let dBeat = (e.altKey ? raw : snap(raw, this.grid)) - anchorOrig.start;
        const earliest = Math.min(...[...d.orig.values()].map((n) => n.start));
        dBeat = Math.max(-earliest, dBeat);
        const dPitch = this.pitchAt(y) - this.pitchAt(d.y);
        for (const n of this.notesList) {
          const o = d.orig.get(n.id);
          if (!o) continue;
          n.start = o.start + dBeat;
          n.pitch = clampPitch(o.pitch + dPitch);
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
        const end = e.altKey ? rawEnd : snap(rawEnd, this.grid);
        const dLen = Math.max(minLen, end - anchorOrig.start) - anchorOrig.length;
        for (const n of this.notesList) {
          const o = d.orig.get(n.id);
          if (o) n.length = Math.max(minLen, o.length + dLen);
        }
        this.lastLength = d.anchor.length;
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
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const { x, y } = this.local(e);
    switch (d.kind) {
      case "pending": {
        // A tap on empty grid: a note there.
        const start = Math.max(0, snapDown(this.beatAt(x), this.grid));
        const note: Note = { id: newId(), start, length: this.lastLength, pitch: this.pitchAt(y), velocity: 0.8 };
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
        this.draw();
        this.onStateChange();
        return;
      case "move":
      case "resize":
        this.finishGesture();
        return;
    }
  }

  private cancel(): void {
    if (this.drag && this.drag.kind !== "pan" && this.drag.kind !== "pending") this.restore(this.gestureStart);
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
      this.zoom(Math.exp(-e.deltaY * 0.01), Math.max(KEYS_W, x));
      return;
    }
    const unit = e.deltaMode === 1 ? 16 : 1;
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const delta = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * unit;
      this.scrollBeat += delta / this.pxPerBeat;
    } else this.topPitch -= (e.deltaY * unit) / ROW_H / 2;
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

    const firstPitch = this.pitchAt(ch - 1);
    const lastPitch = this.pitchAt(RULER_H);
    // Rows: the black keys' rows shaded, a line under every C.
    for (let p = firstPitch; p <= lastPitch; p++) {
      const y = this.yOf(p);
      if (isBlack(p)) {
        g.fillStyle = cssVar("--outside");
        g.fillRect(KEYS_W, y, cw - KEYS_W, ROW_H);
      }
      if (p % 12 === 0) {
        g.fillStyle = cssVar("--grid-strong");
        g.fillRect(KEYS_W, y + ROW_H - 1, cw - KEYS_W, 1);
      }
    }
    // The loop range, under everything.
    const lx0 = this.xOf(this.loop.start);
    const lx1 = this.xOf(this.loop.end);
    if (this.loop.on) {
      g.globalAlpha = 0.08;
      g.fillStyle = cssVar("--accent");
      g.fillRect(Math.max(KEYS_W, lx0), RULER_H, Math.max(0, Math.min(cw, lx1) - Math.max(KEYS_W, lx0)), ch - RULER_H);
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
    g.font = `${Math.min(11, ROW_H - 3)}px system-ui, sans-serif`;
    g.textBaseline = "middle";
    for (const n of this.notesList) {
      if (n.pitch < firstPitch || n.pitch > lastPitch) continue;
      const x0 = this.xOf(n.start);
      const x1 = this.xOf(n.start + n.length);
      if (x1 < KEYS_W || x0 > cw) continue;
      const y = this.yOf(n.pitch);
      const sel = this.selected.has(n.id);
      g.globalAlpha = 0.45 + 0.55 * n.velocity;
      g.fillStyle = sel ? selectedColor : accent;
      g.fillRect(Math.max(KEYS_W, x0) + 0.5, y + 1, Math.max(2, x1 - Math.max(KEYS_W, x0) - 1), ROW_H - 2);
      g.globalAlpha = 1;
      if (sel) {
        g.strokeStyle = text;
        g.lineWidth = 1;
        g.strokeRect(Math.max(KEYS_W, x0) + 0.5, y + 1.5, Math.max(2, x1 - Math.max(KEYS_W, x0) - 1), ROW_H - 3);
      }
      if (x1 - x0 > 28 && ROW_H >= 12) {
        g.fillStyle = cssVar("--accent-text");
        g.fillText(NAMES[n.pitch % 12] + (Math.floor(n.pitch / 12) - 1), Math.max(KEYS_W, x0) + 3, y + ROW_H / 2);
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

    // The keys on the left.
    g.fillStyle = cssVar("--panel");
    g.fillRect(0, RULER_H, KEYS_W, ch - RULER_H);
    for (let p = firstPitch; p <= lastPitch; p++) {
      const y = this.yOf(p);
      g.fillStyle = cssVar(p === this.root ? "--key-root" : isBlack(p) ? "--key-black" : "--key-white");
      g.fillRect(0, y, isBlack(p) ? KEYS_W * 0.62 : KEYS_W - 1, ROW_H - (isBlack(p) ? 1 : 0));
      if (p % 12 === 0 || p === this.root) {
        g.fillStyle = p === this.root ? cssVar("--accent-text") : cssVar("--muted");
        g.fillText(`${NAMES[p % 12]}${Math.floor(p / 12) - 1}`, 3, y + ROW_H / 2);
      }
    }
    g.fillStyle = cssVar("--line");
    g.fillRect(KEYS_W - 1, RULER_H, 1, ch - RULER_H);

    // The ruler: bar numbers and the loop.
    g.fillStyle = cssVar("--strip");
    g.fillRect(0, 0, cw, RULER_H);
    if (lx1 > KEYS_W && lx0 < cw) {
      g.fillStyle = this.loop.on ? accent : cssVar("--muted");
      g.globalAlpha = this.loop.on ? 0.55 : 0.25;
      g.fillRect(Math.max(KEYS_W, lx0), 3, Math.max(0, Math.min(cw, lx1) - Math.max(KEYS_W, lx0)), RULER_H - 6);
      g.globalAlpha = 1;
    }
    g.fillStyle = cssVar("--muted");
    const barPx = this.beatsPerBar * this.pxPerBeat;
    const every = barPx >= 28 ? 1 : Math.ceil(28 / barPx);
    for (let bar = Math.floor(view0 / this.beatsPerBar); bar * this.beatsPerBar <= view1; bar++) {
      if (bar % every) continue;
      const x = this.xOf(bar * this.beatsPerBar);
      if (x < KEYS_W - 1) continue;
      g.fillRect(Math.round(x), RULER_H - 8, 1, 8);
      g.fillText(String(bar + 1), x + 3, RULER_H / 2);
    }
    g.fillStyle = cssVar("--line");
    g.fillRect(0, RULER_H - 1, cw, 1);

    // The playhead.
    if (this.playhead !== null) {
      const x = this.xOf(this.playhead);
      if (x >= KEYS_W && x <= cw) {
        g.fillStyle = text;
        g.fillRect(Math.round(x), 0, 2, ch);
      }
    }
  }
}
