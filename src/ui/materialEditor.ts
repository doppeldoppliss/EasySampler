// The material editor (素材エディタ, design.md 7.2): the waveform, the
// material's own pitch curve (orange, thin dashed) and the curve after
// flattening (yellow, thick solid — VocalShifter's colours, told apart by
// line as well as colour), the detected root (dotted) and the target note
// (solid), and the synthesis markers as labelled bands with draggable edges.
//
// Time on screen is the material as it will play: removed stretches are
// closed up, with a seam mark where a cut was made. The view can be zoomed
// (Ctrl + wheel, pinch, the +/− buttons) and panned (wheel, two fingers).
//
// Gestures on the plot: drag a handle (the cut and the markers), drag the
// dotted root line up and down (semitones; Alt for cents; double-click
// snaps it to the nearest semitone), or drag across the plot to select a
// stretch of time for a hand correction or a removal.

import { pitchLabel } from "../analysis/pitch";
import type { PitchTrack } from "../analysis/pyin";
import { collapsedTime, expandedTime, hiddenParts, normalizeRemoved, type OutputLayout } from "../instrument/layout";
import { clampMarkers } from "../instrument/markers";
import type { Markers, TimeRange } from "../instrument/types";
import { cssVar, el } from "./dom";

export interface EditorMaterial {
  mono: Float32Array;
  sampleRate: number;
  track: PitchTrack;
}

/** Seconds of source time. */
export interface TimeSelection {
  from: number;
  to: number;
}

export interface Vibrato {
  depthCents: number;
  rateHz: number;
  delaySec: number;
}

/** Where playback is: in display time (the material as shown) or in output time (the "after" lane). */
export type Playhead = { kind: "display"; sec: number } | { kind: "output"; sec: number } | null;

type Handle = Exclude<keyof Markers, "removed">;

const STRIP_HEIGHT = 36;
/** The "after" lane at the bottom: how the output lays out in time. */
const LANE_HEIGHT = 30;
const HANDLE_REACH_MOUSE = 8;
const HANDLE_REACH_TOUCH = 22;
/** A selection drag shorter than this (CSS px) is a tap: it clears the selection. */
const TAP_PX = 4;
/** The closest zoom: this many seconds across the plot. */
const MIN_VIEW_SEC = 0.05;

const HANDLE_ORDER: Handle[] = ["rangeStart", "attack", "sustainStart", "sustainEnd", "tailStart", "rangeEnd"];

export class MaterialEditor {
  readonly element: HTMLElement;
  private canvas: HTMLCanvasElement;
  private material: EditorMaterial | null = null;
  private markers: Markers | null = null;
  private removed: TimeRange[] = [];
  /** Which parts play (鳴らす部分); a part switched off is not shown. */
  private parts = { sustain: true, tail: true };
  /** What is closed up on screen: the removed stretches and the hidden parts. */
  private collapsed: TimeRange[] = [];
  private root = 60;
  /** The note the file is tuned to: where the edited curve is drawn. */
  private target = 60;
  private flatten = 0;
  private selection: TimeSelection | null = null;
  private layout: OutputLayout | null = null;
  private vibrato: Vibrato | null = null;
  private playhead: Playhead = null;
  /** The visible window, in display seconds. */
  private view = { start: 0, end: 1 };
  private dragging: { handle: Handle; pointerId: number } | null = null;
  private rootDrag: { pointerId: number } | null = null;
  private selecting: { pointerId: number; anchor: number; anchorX: number; moved: boolean } | null = null;
  /** Two fingers: pinch to zoom, move to pan. */
  private pointers = new Map<number, number>();
  private pinch: { span: number; start: number; distance: number; centerX: number } | null = null;
  private hover: Handle | "root" | null = null;
  /** The pitch scale of the last draw (CSS px), for turning a pointer's y into a pitch. */
  private scale = { lo: 48, hi: 72, plotHeightCss: 1 };
  /** The "after" lane's horizontal mapping from the last draw (device px). */
  private laneMap = { x: 0, width: 1, totalSec: 1 };
  onMarkersChange: (markers: Markers, final: boolean) => void = () => {};
  onRootChange: (root: number, final: boolean) => void = () => {};
  onSelect: (selection: TimeSelection | null) => void = () => {};
  onViewChange: (view: { start: number; end: number; total: number }) => void = () => {};

  constructor() {
    this.canvas = el("canvas", { className: "editor-canvas", ariaLabel: "素材の波形とピッチカーブ" });
    this.element = el("div", { className: "editor" }, [this.canvas]);
    this.canvas.addEventListener("pointerdown", (event) => this.down(event));
    this.canvas.addEventListener("pointermove", (event) => this.move(event));
    this.canvas.addEventListener("pointerup", (event) => this.up(event));
    this.canvas.addEventListener("pointercancel", (event) => this.up(event));
    this.canvas.addEventListener("wheel", (event) => this.wheel(event), { passive: false });
    this.canvas.addEventListener("dblclick", (event) => {
      if (this.nearRoot(event.clientX, event.clientY, "mouse")) this.onRootChange(Math.round(this.root), true);
    });
    new ResizeObserver(() => this.draw()).observe(this.canvas);
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.draw());
  }

  // ------------------------------------------------------------- state in

  setMaterial(material: EditorMaterial | null): void {
    this.material = material;
    this.selection = null;
    this.removed = [];
    this.collapsed = [];
    this.view = { start: 0, end: this.displayDuration };
    this.playhead = null;
    this.draw();
    this.announceView();
  }

  setState(markers: Markers, root: number, flatten: number, target = root): void {
    this.markers = markers;
    this.removed = normalizeRemoved(markers.removed, markers.rangeStart, markers.rangeEnd);
    this.refreshCollapsed();
    this.root = root;
    this.target = target;
    this.flatten = flatten;
    this.clampView();
    this.draw();
  }

  /** Which parts play: the ones switched off disappear from the plot. */
  setParts(parts: { sustain: boolean; tail: boolean }): void {
    if (parts.sustain === this.parts.sustain && parts.tail === this.parts.tail) return;
    this.parts = { ...parts };
    this.refreshCollapsed();
    // What plays just got longer or shorter: show exactly that.
    if (this.markers) this.zoomToRange(this.markers.rangeStart, this.markers.rangeEnd);
    else {
      this.view = { start: 0, end: this.displayDuration };
      this.draw();
      this.announceView();
    }
  }

  private refreshCollapsed(): void {
    const m = this.markers;
    this.collapsed = m ? normalizeRemoved([...this.removed, ...hiddenParts(m, this.parts)], m.rangeStart, m.rangeEnd) : [];
  }

  /** A handle of a part that isn't shown can't be seen or grabbed. */
  private hiddenHandle(handle: Handle): boolean {
    return (!this.parts.sustain && handle === "sustainEnd") || (!this.parts.tail && (handle === "tailStart" || handle === "rangeEnd"));
  }

  setSelection(selection: TimeSelection | null): void {
    this.selection = selection;
    this.draw();
  }

  /** What the output will look like (the lane at the bottom), and the vibrato drawn over its sustain. */
  setLayout(layout: OutputLayout | null, vibrato: Vibrato | null): void {
    this.layout = layout;
    this.vibrato = vibrato;
    this.draw();
  }

  setPlayhead(playhead: Playhead): void {
    this.playhead = playhead;
    this.draw();
  }

  // ------------------------------------------------------------- time

  private get duration(): number {
    return this.material ? this.material.mono.length / this.material.sampleRate : 1;
  }

  /** The material's length as shown (removed stretches closed up). */
  get displayDuration(): number {
    return collapsedTime(this.duration, this.collapsed);
  }

  /** Source time → display time. */
  disp(t: number): number {
    return collapsedTime(t, this.collapsed);
  }

  /** Display time → source time. */
  src(d: number): number {
    return expandedTime(d, this.collapsed);
  }

  /** The source time at a pointer's x (never inside a removed stretch, clamped to the material). */
  private timeAt(clientX: number): number {
    const box = this.canvas.getBoundingClientRect();
    const d = this.view.start + ((clientX - box.left) / box.width) * (this.view.end - this.view.start);
    return Math.max(0, Math.min(this.duration, this.src(Math.max(0, Math.min(this.displayDuration, d)))));
  }

  private displayAt(clientX: number): number {
    const box = this.canvas.getBoundingClientRect();
    return this.view.start + ((clientX - box.left) / box.width) * (this.view.end - this.view.start);
  }

  private pitchAt(clientY: number): number {
    const box = this.canvas.getBoundingClientRect();
    const y = Math.max(0, Math.min(this.scale.plotHeightCss, clientY - box.top));
    return this.scale.lo + (1 - y / this.scale.plotHeightCss) * (this.scale.hi - this.scale.lo);
  }

  // ------------------------------------------------------------- view (zoom / pan)

  /** Zooms by `factor` (> 1 closer) around a display time; the buttons use the middle of the view. */
  zoom(factor: number, aroundDisplaySec = (this.view.start + this.view.end) / 2): void {
    const span = this.view.end - this.view.start;
    const next = Math.max(MIN_VIEW_SEC, Math.min(this.displayDuration, span / factor));
    const share = (aroundDisplaySec - this.view.start) / span;
    this.view = { start: aroundDisplaySec - share * next, end: aroundDisplaySec + (1 - share) * next };
    this.clampView();
    this.draw();
    this.announceView();
  }

  zoomAll(): void {
    this.view = { start: 0, end: this.displayDuration };
    this.draw();
    this.announceView();
  }

  /** Shows the selection, or the used range, filling the plot. */
  zoomToRange(from: number, to: number): void {
    const a = this.disp(from);
    const b = this.disp(to);
    const pad = Math.max(0.01, (b - a) * 0.05);
    this.view = { start: a - pad, end: b + pad };
    this.clampView();
    this.draw();
    this.announceView();
  }

  panBy(displaySec: number): void {
    const span = this.view.end - this.view.start;
    this.view = { start: this.view.start + displaySec, end: this.view.end + displaySec };
    this.clampView();
    if (this.view.end - this.view.start !== span) this.view.end = this.view.start + span;
    this.draw();
    this.announceView();
  }

  private clampView(): void {
    const total = this.displayDuration;
    let span = Math.max(MIN_VIEW_SEC, Math.min(total, this.view.end - this.view.start));
    if (!Number.isFinite(span) || span <= 0) span = total;
    let start = this.view.start;
    if (start + span > total) start = total - span;
    if (start < 0) start = 0;
    this.view = { start, end: start + span };
  }

  private announceView(): void {
    this.onViewChange({ ...this.view, total: this.displayDuration });
  }

  private wheel(event: WheelEvent): void {
    if (!this.material) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      // Pinch on a trackpad arrives as Ctrl + wheel too.
      this.zoom(Math.exp(-event.deltaY * 0.01), this.displayAt(event.clientX));
    } else {
      const span = this.view.end - this.view.start;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      this.panBy((delta / this.canvas.clientWidth) * span * (event.deltaMode === 1 ? 20 : 1));
    }
  }

  // ------------------------------------------------------------- pointer

  private handleAt(event: PointerEvent): Handle | null {
    if (!this.markers) return null;
    const box = this.canvas.getBoundingClientRect();
    const reach = event.pointerType === "mouse" ? HANDLE_REACH_MOUSE : HANDLE_REACH_TOUCH;
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    if (y > box.height - LANE_HEIGHT) return null; // the "after" lane has nothing to grab
    const inStripLower = y > box.height - LANE_HEIGHT - STRIP_HEIGHT / 2;
    let best: Handle | null = null;
    let bestDistance = reach;
    for (const handle of HANDLE_ORDER) {
      if (this.hiddenHandle(handle)) continue;
      const hx = this.xCss(this.markers[handle], box.width);
      let distance = Math.abs(hx - x);
      // Sustain end and tail start often coincide: the lower half of the strip grabs the tail.
      if (handle === "tailStart") distance += inStripLower ? -0.5 : 0.5;
      if (handle === "sustainEnd") distance += inStripLower ? 0.5 : -0.5;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = handle;
      }
    }
    return best;
  }

  /** Source time → CSS px within a width. */
  private xCss(t: number, width: number): number {
    return ((this.disp(t) - this.view.start) / (this.view.end - this.view.start)) * width;
  }

  private nearRoot(clientX: number, clientY: number, pointerType: string): boolean {
    if (!this.material) return false;
    const box = this.canvas.getBoundingClientRect();
    const y = clientY - box.top;
    if (y > this.scale.plotHeightCss) return false;
    const rootY = (1 - (this.root - this.scale.lo) / (this.scale.hi - this.scale.lo)) * this.scale.plotHeightCss;
    const reach = pointerType === "mouse" ? HANDLE_REACH_MOUSE : HANDLE_REACH_TOUCH;
    return Math.abs(rootY - y) < reach && clientX >= box.left && clientX <= box.right;
  }

  private capture(event: PointerEvent): void {
    event.preventDefault();
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      // (a pointer that is already gone)
    }
  }

  private down(event: PointerEvent): void {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    if (!this.markers || !this.material) return;
    this.pointers.set(event.pointerId, event.clientX);
    if (this.pointers.size === 2) {
      // A second finger: whatever the first was doing becomes a pinch / pan.
      this.capture(event);
      this.dragging = null;
      this.rootDrag = null;
      this.selecting = null;
      const [a, b] = [...this.pointers.values()];
      this.pinch = { span: this.view.end - this.view.start, start: this.view.start, distance: Math.max(1, Math.abs(a - b)), centerX: (a + b) / 2 };
      return;
    }
    const handle = this.handleAt(event);
    if (handle) {
      this.capture(event);
      this.dragging = { handle, pointerId: event.pointerId };
      return;
    }
    this.capture(event);
    if (this.nearRoot(event.clientX, event.clientY, event.pointerType)) {
      this.rootDrag = { pointerId: event.pointerId };
      return;
    }
    const box = this.canvas.getBoundingClientRect();
    if (event.clientY - box.top > this.scale.plotHeightCss) return; // the strip: nothing to select there
    this.selecting = { pointerId: event.pointerId, anchor: this.timeAt(event.clientX), anchorX: event.clientX, moved: false };
  }

  private move(event: PointerEvent): void {
    if (this.pointers.has(event.pointerId)) this.pointers.set(event.pointerId, event.clientX);
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const distance = Math.max(1, Math.abs(a - b));
      const centerX = (a + b) / 2;
      const box = this.canvas.getBoundingClientRect();
      const span = Math.max(MIN_VIEW_SEC, Math.min(this.displayDuration, (this.pinch.span * this.pinch.distance) / distance));
      // Keep the display time under the original centre under the fingers' centre.
      const centerTime = this.pinch.start + ((this.pinch.centerX - box.left) / box.width) * this.pinch.span;
      const start = centerTime - ((centerX - box.left) / box.width) * span;
      this.view = { start, end: start + span };
      this.clampView();
      this.draw();
      this.announceView();
      return;
    }
    if (this.dragging?.pointerId === event.pointerId && this.markers) {
      const markers = this.moved(this.dragging.handle, this.timeAt(event.clientX));
      this.markers = markers;
      this.refreshCollapsed();
      this.draw();
      this.onMarkersChange(markers, false);
      return;
    }
    if (this.rootDrag?.pointerId === event.pointerId) {
      const pitch = this.pitchAt(event.clientY);
      // Semitones by default; Alt for cents (design.md 3).
      this.root = event.altKey ? Math.round(pitch * 100) / 100 : Math.round(pitch);
      this.draw();
      this.onRootChange(this.root, false);
      return;
    }
    if (this.selecting?.pointerId === event.pointerId) {
      if (Math.abs(event.clientX - this.selecting.anchorX) >= TAP_PX) this.selecting.moved = true;
      if (this.selecting.moved) {
        const t = this.timeAt(event.clientX);
        this.selection = { from: Math.min(this.selecting.anchor, t), to: Math.max(this.selecting.anchor, t) };
        this.draw();
      }
      return;
    }
    // Hovering: show what a press would grab.
    const hover: Handle | "root" | null = this.handleAt(event) ?? (this.nearRoot(event.clientX, event.clientY, event.pointerType) ? "root" : null);
    if (hover !== this.hover) {
      this.hover = hover;
      this.canvas.style.cursor = hover === "root" ? "ns-resize" : hover ? "ew-resize" : this.material ? "crosshair" : "default";
      this.draw();
    }
  }

  private up(event: PointerEvent): void {
    this.pointers.delete(event.pointerId);
    if (this.pinch) {
      if (this.pointers.size < 2) this.pinch = null;
      return;
    }
    if (this.dragging?.pointerId === event.pointerId && this.markers) {
      this.dragging = null;
      this.onMarkersChange(this.markers, true);
      return;
    }
    if (this.rootDrag?.pointerId === event.pointerId) {
      this.rootDrag = null;
      this.onRootChange(this.root, true);
      return;
    }
    if (this.selecting?.pointerId === event.pointerId) {
      const moved = this.selecting.moved;
      this.selecting = null;
      if (!moved) this.selection = null; // a tap clears
      this.draw();
      this.onSelect(this.selection);
    }
  }

  /**
   * The markers with one moved; neighbours give way so the order holds —
   * except a hidden part's markers (鳴らす部分), which stay put: the handle
   * stops as far as it can go without moving them (minimum gaps included).
   */
  private moved(handle: Handle, time: number): Markers {
    const original = this.markers!;
    // What is hidden must come out exactly as it was: the same stretches (a visible handle on their edge
    // can't move into them) and the same markers inside them.
    const hiddenBefore = hiddenParts(original, this.parts);
    const hidden = HANDLE_ORDER.filter((h) => h !== handle && this.hiddenHandle(h));
    const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;
    const keepsHidden = (m: Markers) => {
      const after = hiddenParts(m, this.parts);
      return after.length === hiddenBefore.length && after.every((r, i) => same(r.start, hiddenBefore[i].start) && same(r.end, hiddenBefore[i].end)) && hidden.every((h) => same(m[h], original[h]));
    };
    const wanted = this.placed(handle, time);
    if (hiddenBefore.length === 0 || keepsHidden(wanted)) return wanted;
    // Between where the handle was (fine) and where it was asked to go (not): the farthest that still is.
    let ok = original[handle];
    let bad = time;
    for (let i = 0; i < 30 && Math.abs(bad - ok) > 1e-6; i++) {
      const mid = (ok + bad) / 2;
      if (keepsHidden(this.placed(handle, mid))) ok = mid;
      else bad = mid;
    }
    return keepsHidden(this.placed(handle, ok)) ? this.placed(handle, ok) : original;
  }

  private placed(handle: Handle, time: number): Markers {
    const index = HANDLE_ORDER.indexOf(handle);
    const m = { ...this.markers!, [handle]: time };
    // Moving the sustain end drags a tail start that sat on it along (the usual case).
    if (handle === "sustainEnd" && Math.abs(this.markers!.tailStart - this.markers!.sustainEnd) < 1e-6) m.tailStart = time;
    for (let i = index + 1; i < HANDLE_ORDER.length; i++) m[HANDLE_ORDER[i]] = Math.max(m[HANDLE_ORDER[i]], time);
    for (let i = index - 1; i >= 0; i--) m[HANDLE_ORDER[i]] = Math.min(m[HANDLE_ORDER[i]], time);
    return clampMarkers(m);
  }

  // ------------------------------------------------------------- drawing

  draw(): void {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    const g = this.canvas.getContext("2d")!;
    g.clearRect(0, 0, width, height);
    const material = this.material;
    const markers = this.markers;
    if (!material || !markers) return;

    const strip = STRIP_HEIGHT * dpr;
    const lane = LANE_HEIGHT * dpr;
    const plotHeight = height - strip - lane;
    const stripBottom = plotHeight + strip;
    const view = this.view;
    const span = view.end - view.start;
    /** Source time → device px. */
    const x = (t: number) => ((this.disp(t) - view.start) / span) * width;
    /** Display time → device px. */
    const xd = (d: number) => ((d - view.start) / span) * width;

    // Outside the range: shaded.
    g.fillStyle = cssVar("--outside");
    g.fillRect(0, 0, Math.max(0, x(markers.rangeStart)), stripBottom);
    g.fillRect(Math.min(width, x(markers.rangeEnd)), 0, width, stripBottom);

    // Waveform (min/max per column), reading the source through the display mapping.
    const samples = material.mono;
    const rate = material.sampleRate;
    g.fillStyle = cssVar("--wave");
    const mid = plotHeight / 2;
    for (let col = 0; col < width; col++) {
      const d0 = view.start + (col / width) * span;
      const d1 = view.start + ((col + 1) / width) * span;
      if (d1 < 0 || d0 > this.displayDuration) continue;
      const from = Math.max(0, Math.floor(this.src(d0) * rate));
      const to = Math.min(samples.length, Math.max(from + 1, Math.floor(this.src(d1) * rate) + 1));
      let lo = 0;
      let hi = 0;
      for (let i = from; i < to; i++) {
        const v = samples[i];
        if (v < lo) lo = v;
        else if (v > hi) hi = v;
      }
      g.fillRect(col, mid - hi * mid * 0.9, 1, Math.max(1, (hi - lo) * mid * 0.9));
    }

    // Pitch scale: the voiced curve, the root and the target, with some room.
    const track = material.track;
    let minPitch = Math.min(this.root, this.target);
    let maxPitch = Math.max(this.root, this.target);
    for (const v of track.f0) {
      if (!Number.isFinite(v)) continue;
      minPitch = Math.min(minPitch, v);
      maxPitch = Math.max(maxPitch, v);
    }
    let lo = Math.floor(minPitch) - 1;
    let hi = Math.ceil(maxPitch) + 1;
    if (hi - lo < 8) {
      const centre = (hi + lo) / 2;
      lo = Math.floor(centre - 4);
      hi = Math.ceil(centre + 4);
    }
    this.scale = { lo, hi, plotHeightCss: plotHeight / dpr };
    const y = (midi: number) => plotHeight - ((midi - lo) / (hi - lo)) * plotHeight;

    // Semitone grid, C labelled.
    g.font = `${11 * dpr}px system-ui, sans-serif`;
    for (let m = lo; m <= hi; m++) {
      g.fillStyle = m % 12 === 0 ? cssVar("--grid-strong") : cssVar("--grid");
      g.fillRect(0, Math.round(y(m)), width, 1);
      if (m % 12 === 0 || hi - lo <= 12) {
        g.fillStyle = cssVar("--muted");
        g.fillText(pitchLabel(m), 4 * dpr, y(m) - 3 * dpr);
      }
    }

    // The selection (for a hand correction or a removal), in display time.
    if (this.selection) {
      const a = x(this.selection.from);
      const b = x(this.selection.to);
      g.fillStyle = cssVar("--accent");
      g.globalAlpha = 0.18;
      g.fillRect(a, 0, b - a, plotHeight);
      g.globalAlpha = 1;
      g.fillRect(a, 0, 1.5 * dpr, plotHeight);
      g.fillRect(b - 1.5 * dpr, 0, 1.5 * dpr, plotHeight);
    }

    // The detected root: dotted, labelled at the left (draggable). The target note (the file's pitch): solid accent, labelled at the right.
    g.font = `600 ${12 * dpr}px system-ui, sans-serif`;
    const line = (midi: number, label: string, color: string, dash: number[], side: "left" | "right", bold: boolean) => {
      g.strokeStyle = color;
      g.lineWidth = (bold ? 2.5 : 1.5) * dpr;
      g.setLineDash(dash);
      g.beginPath();
      g.moveTo(0, y(midi));
      g.lineTo(width, y(midi));
      g.stroke();
      g.setLineDash([]);
      const labelWidth = g.measureText(label).width;
      const lx = side === "right" ? width - labelWidth - 8 * dpr : 36 * dpr;
      g.fillStyle = cssVar("--panel");
      g.fillRect(lx - 4 * dpr, y(midi) - 16 * dpr, labelWidth + 8 * dpr, 15 * dpr);
      g.fillStyle = color;
      g.fillText(label, lx, y(midi) - 4 * dpr);
    };
    const rootActive = this.hover === "root" || this.rootDrag !== null;
    line(this.root, `判定 ${pitchLabel(this.root)} ↕`, rootActive ? cssVar("--accent") : cssVar("--muted"), [2 * dpr, 4 * dpr], "left", rootActive);
    line(this.target, pitchLabel(this.target), cssVar("--accent"), [], "right", false);

    // The pitch curves, broken at removed stretches and outside the window.
    const inRemoved = (t: number) => this.collapsed.some((r) => t >= r.start && t < r.end);
    const curve = (value: (pitch: number) => number, from: number, to: number) => {
      g.beginPath();
      let drawing = false;
      for (let i = 0; i < track.f0.length; i++) {
        const t = i * track.hopSec;
        const pitch = track.f0[i];
        if (!Number.isFinite(pitch) || t < from || t > to || inRemoved(t)) {
          drawing = false;
          continue;
        }
        const px = x(t);
        if (px < -2 || px > width + 2) {
          drawing = false;
          continue;
        }
        if (drawing) g.lineTo(px, y(value(pitch)));
        else g.moveTo(px, y(value(pitch)));
        drawing = true;
      }
      g.stroke();
    };
    // The material's own pitch: orange, thin, dashed.
    g.strokeStyle = cssVar("--pitch-original");
    g.lineWidth = 1.5 * dpr;
    g.setLineDash([5 * dpr, 3 * dpr]);
    curve((p) => p, 0, this.duration);
    g.setLineDash([]);
    // After flattening, as it will be written (on the target note): yellow, thick, solid — within the range.
    g.strokeStyle = cssVar("--pitch-edited");
    g.lineWidth = 3 * dpr;
    curve((p) => this.target + (1 - this.flatten) * (p - this.root), markers.rangeStart, markers.rangeEnd);

    // Marker strip: head / sustain / tail bands with labels.
    const bands: [number, number, string, string][] = [
      [markers.rangeStart, markers.sustainStart, "--band-head", "頭部"],
      [markers.sustainStart, markers.sustainEnd, "--band-sustain", "持続区間"],
      [markers.tailStart, markers.rangeEnd, "--band-tail", "語尾"],
    ].filter(([, , color]) => (color !== "--band-sustain" || this.parts.sustain) && (color !== "--band-tail" || this.parts.tail)) as [number, number, string, string][];
    g.fillStyle = cssVar("--strip");
    g.fillRect(0, plotHeight, width, strip);
    g.font = `${11 * dpr}px system-ui, sans-serif`;
    for (const [from, to, color, text] of bands) {
      if (to <= from) continue;
      const a = x(from);
      const b = x(to);
      g.fillStyle = cssVar(color);
      g.fillRect(a, plotHeight + 4 * dpr, b - a, strip - 8 * dpr);
      g.globalAlpha = 0.14;
      g.fillRect(a, 0, b - a, plotHeight);
      g.globalAlpha = 1;
      const textWidth = g.measureText(text).width;
      if (b - a > textWidth + 6 * dpr) {
        g.fillStyle = cssVar("--band-text");
        g.fillText(text, Math.max(a, 0) + 4 * dpr, plotHeight + strip / 2 + 4 * dpr);
      }
    }

    // Seams: where a stretch was cut out (a dashed line and scissors at the top).
    g.font = `${12 * dpr}px system-ui, sans-serif`;
    for (const r of this.removed) {
      const sx = Math.round(x(r.start));
      if (sx < -10 * dpr || sx > width + 10 * dpr) continue;
      g.strokeStyle = cssVar("--warn");
      g.lineWidth = 1.5 * dpr;
      g.setLineDash([3 * dpr, 3 * dpr]);
      g.beginPath();
      g.moveTo(sx, 0);
      g.lineTo(sx, stripBottom);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = cssVar("--warn");
      g.fillText("✂", sx - 6 * dpr, 12 * dpr);
    }

    // The "after" lane: the output's parts laid out in time, the sustain's stretch written on it, the vibrato over it.
    g.fillStyle = cssVar("--strip");
    g.fillRect(0, stripBottom, width, lane);
    g.fillStyle = cssVar("--line");
    g.fillRect(0, stripBottom, width, 1 * dpr);
    const layout = this.layout;
    if (layout && layout.totalSec > 0) {
      // Same seconds-per-pixel as the plot, starting under the range start: a part played at its
      // own speed lines up with its band above; a stretched one runs on past it.
      const pxPerSec = width / span;
      const laneX = x(markers.rangeStart);
      const laneW = layout.totalSec * pxPerSec;
      this.laneMap = { x: laneX, width: laneW, totalSec: layout.totalSec };
      const px = (sec: number) => laneX + (sec / layout.totalSec) * laneW;
      g.font = `${10 * dpr}px system-ui, sans-serif`;
      /** Where the lane's name ends (it is drawn over the start of the lane). */
      const laneNameReserve = g.measureText("書き出し後").width + 8 * dpr;
      const ratio = (out: number, src: number) => (src > 0 ? `×${(out / src).toFixed(out / src >= 10 ? 0 : 1)}` : "");
      const parts: [number, number, string, string][] = [
        [0, layout.headSec, "--band-head", `頭部 ${ratio(layout.headSec, layout.headSrcSec)}`],
        [layout.headSec, layout.headSec + layout.sustainSec, "--band-sustain", `持続区間 ${layout.elastic ? `${ratio(layout.sustainSec, layout.sustainSrcSec)}(音の長さまで伸ばす)` : ratio(layout.sustainSec, layout.sustainSrcSec)}`],
        [layout.headSec + layout.sustainSec, layout.totalSec, "--band-tail", `語尾 ${ratio(layout.tailSec, layout.tailSrcSec)}`],
      ];
      g.font = `${11 * dpr}px system-ui, sans-serif`;
      for (const [from, to, color, text] of parts) {
        if (to - from <= 1e-6) continue;
        g.fillStyle = cssVar(color);
        g.fillRect(px(from), stripBottom + 4 * dpr, px(to) - px(from), lane - 8 * dpr);
        // The text starts where the part is visible: right of the lane's name, inside the plot.
        const textX = Math.max(px(from), laneNameReserve, 0) + 4 * dpr;
        const textWidth = g.measureText(text).width;
        if (Math.min(px(to), width) - textX > textWidth + 2 * dpr) {
          g.fillStyle = cssVar("--band-text");
          g.fillText(text, textX, stripBottom + lane / 2 + 4 * dpr);
        }
      }
      // The lane's name, over whatever is under it; and how much runs on past the right edge.
      g.font = `${10 * dpr}px system-ui, sans-serif`;
      const name = "書き出し後";
      const nameW = g.measureText(name).width + 8 * dpr;
      g.fillStyle = cssVar("--strip");
      g.fillRect(0, stripBottom + 1 * dpr, nameW, lane - 1 * dpr);
      g.fillStyle = cssVar("--muted");
      g.fillText(name, 4 * dpr, stripBottom + lane / 2 + 4 * dpr);
      const beyond = layout.totalSec - (width - laneX) / pxPerSec;
      if (beyond > 0.005) {
        const text = `→ あと ${beyond.toFixed(beyond < 10 ? 2 : 1)} 秒`;
        const tw = g.measureText(text).width + 10 * dpr;
        g.fillStyle = cssVar("--panel");
        g.fillRect(width - tw, stripBottom + 4 * dpr, tw, lane - 8 * dpr);
        g.fillStyle = cssVar("--text");
        g.fillText(text, width - tw + 5 * dpr, stripBottom + lane / 2 + 4 * dpr);
      }
      // The vibrato, as it will sound: from its delay, over the sustain (and the tail), at its rate and depth.
      const vib = this.vibrato;
      if (vib && vib.depthCents > 0 && layout.sustainSec > 0) {
        const from = Math.max(layout.headSec, vib.delaySec);
        const to = layout.headSec + layout.sustainSec + layout.tailSec;
        if (to > from) {
          g.strokeStyle = cssVar("--pitch-edited");
          g.lineWidth = 1.5 * dpr;
          g.beginPath();
          const midY = stripBottom + lane / 2;
          const amp = Math.min(lane * 0.4, (vib.depthCents / 100) * lane * 0.4);
          const steps = Math.max(2, Math.round(px(to) - px(from)));
          for (let i = 0; i <= steps; i++) {
            const t = from + ((to - from) * i) / steps;
            const fadeIn = Math.min(1, (t - from) / 0.15);
            const yy = midY - amp * fadeIn * Math.sin(2 * Math.PI * vib.rateHz * (t - from));
            if (i === 0) g.moveTo(px(t), yy);
            else g.lineTo(px(t), yy);
          }
          g.stroke();
        }
      }
    }

    // Handles: a line through the plot and the strip, a grip in the strip.
    // The range handles (the cut) are bigger, with a bracket at the top,
    // since they are the first thing to reach for.
    for (const handle of HANDLE_ORDER) {
      if (this.hiddenHandle(handle)) continue;
      const hx = Math.round(x(markers[handle]));
      if (hx < -12 * dpr || hx > width + 12 * dpr) continue;
      const active = this.dragging?.handle === handle || this.hover === handle;
      const isRange = handle === "rangeStart" || handle === "rangeEnd";
      g.fillStyle = active ? cssVar("--accent") : cssVar("--handle");
      g.fillRect(hx - (active || isRange ? 1 : 0.5) * dpr, 0, (active || isRange ? 2 : 1) * dpr, stripBottom);
      if (isRange) {
        const dir = handle === "rangeStart" ? 1 : -1;
        g.fillRect(hx - (dir > 0 ? 1 : 9) * dpr, 0, 10 * dpr, 3 * dpr);
        g.fillRect(hx - (dir > 0 ? 1 : 9) * dpr, plotHeight - 3 * dpr, 10 * dpr, 3 * dpr);
        g.fillRect(hx - 5 * dpr, plotHeight + 2 * dpr, 10 * dpr, strip - 4 * dpr);
      } else {
        const gripTop = handle === "tailStart" ? plotHeight + strip / 2 : plotHeight;
        g.fillRect(hx - 3 * dpr, gripTop + 2 * dpr, 6 * dpr, strip / 2 - 4 * dpr);
      }
    }

    // The playhead.
    if (this.playhead) {
      g.fillStyle = cssVar("--accent");
      if (this.playhead.kind === "display") {
        const px = Math.round(xd(this.playhead.sec));
        if (px >= 0 && px <= width) {
          g.fillRect(px - 1 * dpr, 0, 2 * dpr, stripBottom);
          g.beginPath();
          g.moveTo(px - 6 * dpr, 0);
          g.lineTo(px + 6 * dpr, 0);
          g.lineTo(px, 8 * dpr);
          g.fill();
        }
      } else if (layout) {
        const px = Math.round(this.laneMap.x + (this.playhead.sec / this.laneMap.totalSec) * this.laneMap.width);
        g.fillRect(px - 1 * dpr, stripBottom, 2 * dpr, lane);
      }
    }

    // Zoomed in: a thin bar at the very top shows where the window sits in the whole.
    if (span < this.displayDuration - 1e-6) {
      const total = this.displayDuration;
      g.fillStyle = cssVar("--line");
      g.fillRect(0, 0, width, 3 * dpr);
      g.fillStyle = cssVar("--accent");
      g.fillRect((view.start / total) * width, 0, Math.max(4 * dpr, (span / total) * width), 3 * dpr);
    }
  }
}
