// The material editor (素材エディタ, design.md 7.2): the waveform, the
// material's own pitch curve (orange, thin dashed) and the curve after
// flattening (yellow, thick solid — VocalShifter's colours, told apart by
// line as well as colour), the detected root (dotted) and the target note
// (solid), and the synthesis markers as labelled bands with draggable edges.
//
// Three gestures on the plot: drag a handle (the cut and the markers), drag
// the dotted root line up and down (semitones; Alt for cents; double-click
// snaps it to the nearest semitone), or drag across the plot to select a
// stretch of time for a hand correction (オクターブ, 有声 / 無声).

import { pitchLabel } from "../analysis/pitch";
import type { PitchTrack } from "../analysis/pyin";
import { normalizeRemoved, type OutputLayout } from "../instrument/layout";
import { clampMarkers } from "../instrument/markers";
import type { Markers } from "../instrument/types";
import { cssVar, el } from "./dom";

export interface EditorMaterial {
  mono: Float32Array;
  sampleRate: number;
  track: PitchTrack;
}

export interface TimeSelection {
  from: number;
  to: number;
}

export interface Vibrato {
  depthCents: number;
  rateHz: number;
  delaySec: number;
}

type Handle = Exclude<keyof Markers, "removed">;

const STRIP_HEIGHT = 36;
/** The "after" lane at the bottom: how the output lays out in time. */
const LANE_HEIGHT = 30;
const HANDLE_REACH_MOUSE = 8;
const HANDLE_REACH_TOUCH = 22;
/** A selection drag shorter than this (CSS px) is a tap: it clears the selection. */
const TAP_PX = 4;

const HANDLE_ORDER: Handle[] = ["rangeStart", "attack", "sustainStart", "sustainEnd", "tailStart", "rangeEnd"];

export class MaterialEditor {
  readonly element: HTMLElement;
  private canvas: HTMLCanvasElement;
  private material: EditorMaterial | null = null;
  private markers: Markers | null = null;
  private root = 60;
  /** The note the file is tuned to: where the edited curve is drawn. */
  private target = 60;
  private flatten = 0;
  private selection: TimeSelection | null = null;
  private layout: OutputLayout | null = null;
  private vibrato: Vibrato | null = null;
  private dragging: { handle: Handle; pointerId: number } | null = null;
  private rootDrag: { pointerId: number } | null = null;
  private selecting: { pointerId: number; anchor: number; anchorX: number; moved: boolean } | null = null;
  private hover: Handle | "root" | null = null;
  /** The pitch scale of the last draw (CSS px), for turning a pointer's y into a pitch. */
  private scale = { lo: 48, hi: 72, plotHeightCss: 1 };
  onMarkersChange: (markers: Markers, final: boolean) => void = () => {};
  onRootChange: (root: number, final: boolean) => void = () => {};
  onSelect: (selection: TimeSelection | null) => void = () => {};

  constructor() {
    this.canvas = el("canvas", { className: "editor-canvas", ariaLabel: "素材の波形とピッチカーブ" });
    this.element = el("div", { className: "editor" }, [this.canvas]);
    this.canvas.addEventListener("pointerdown", (event) => this.down(event));
    this.canvas.addEventListener("pointermove", (event) => this.move(event));
    this.canvas.addEventListener("pointerup", (event) => this.up(event));
    this.canvas.addEventListener("pointercancel", (event) => this.up(event));
    this.canvas.addEventListener("dblclick", (event) => {
      if (this.nearRoot(event.clientX, event.clientY, "mouse")) this.onRootChange(Math.round(this.root), true);
    });
    new ResizeObserver(() => this.draw()).observe(this.canvas);
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.draw());
  }

  setMaterial(material: EditorMaterial | null): void {
    this.material = material;
    this.selection = null;
    this.draw();
  }

  setState(markers: Markers, root: number, flatten: number, target = root): void {
    this.markers = markers;
    this.root = root;
    this.target = target;
    this.flatten = flatten;
    this.draw();
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

  private get duration(): number {
    return this.material ? this.material.mono.length / this.material.sampleRate : 1;
  }

  private timeAt(clientX: number): number {
    const box = this.canvas.getBoundingClientRect();
    return Math.max(0, Math.min(this.duration, ((clientX - box.left) / box.width) * this.duration));
  }

  private pitchAt(clientY: number): number {
    const box = this.canvas.getBoundingClientRect();
    const y = Math.max(0, Math.min(this.scale.plotHeightCss, clientY - box.top));
    return this.scale.lo + (1 - y / this.scale.plotHeightCss) * (this.scale.hi - this.scale.lo);
  }

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
      const hx = (this.markers[handle] / this.duration) * box.width;
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
    const handle = this.handleAt(event);
    if (handle) {
      this.capture(event);
      this.dragging = { handle, pointerId: event.pointerId };
      return;
    }
    if (!this.markers || !this.material) return;
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
    if (this.dragging?.pointerId === event.pointerId && this.markers) {
      const markers = this.moved(this.dragging.handle, this.timeAt(event.clientX));
      this.markers = markers;
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

  /** The markers with one moved; neighbours give way so the order holds. */
  private moved(handle: Handle, time: number): Markers {
    const m = { ...this.markers!, [handle]: time };
    // Moving the sustain end drags a tail start that sat on it along (the usual case).
    if (handle === "sustainEnd" && Math.abs(this.markers!.tailStart - this.markers!.sustainEnd) < 1e-6) m.tailStart = time;
    const index = HANDLE_ORDER.indexOf(handle);
    for (let i = index + 1; i < HANDLE_ORDER.length; i++) m[HANDLE_ORDER[i]] = Math.max(m[HANDLE_ORDER[i]], time);
    for (let i = index - 1; i >= 0; i--) m[HANDLE_ORDER[i]] = Math.min(m[HANDLE_ORDER[i]], time);
    return clampMarkers(m);
  }

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
    const x = (t: number) => (t / this.duration) * width;

    // Outside the range: shaded.
    g.fillStyle = cssVar("--outside");
    g.fillRect(0, 0, x(markers.rangeStart), stripBottom);
    g.fillRect(x(markers.rangeEnd), 0, width - x(markers.rangeEnd), stripBottom);

    // Removed stretches: shaded and hatched (they are skipped on playback).
    const removed = normalizeRemoved(markers.removed, markers.rangeStart, markers.rangeEnd);
    for (const r of removed) {
      const left = x(r.start);
      const right = x(r.end);
      g.fillStyle = cssVar("--outside");
      g.fillRect(left, 0, right - left, stripBottom);
      g.save();
      g.beginPath();
      g.rect(left, 0, right - left, stripBottom);
      g.clip();
      g.strokeStyle = cssVar("--handle");
      g.lineWidth = 1 * dpr;
      g.globalAlpha = 0.5;
      g.beginPath();
      for (let d = -stripBottom; d < right - left; d += 10 * dpr) {
        g.moveTo(left + d, stripBottom);
        g.lineTo(left + d + stripBottom, 0);
      }
      g.stroke();
      g.restore();
    }

    // Waveform (min/max per column).
    const samples = material.mono;
    const perColumn = samples.length / width;
    g.fillStyle = cssVar("--wave");
    const mid = plotHeight / 2;
    for (let col = 0; col < width; col++) {
      let lo = 0;
      let hi = 0;
      const from = Math.floor(col * perColumn);
      const to = Math.min(samples.length, Math.floor((col + 1) * perColumn) + 1);
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

    // The selection (for a hand correction).
    if (this.selection) {
      g.fillStyle = cssVar("--accent");
      g.globalAlpha = 0.18;
      g.fillRect(x(this.selection.from), 0, x(this.selection.to) - x(this.selection.from), plotHeight);
      g.globalAlpha = 1;
      g.fillRect(x(this.selection.from), 0, 1.5 * dpr, plotHeight);
      g.fillRect(x(this.selection.to) - 1.5 * dpr, 0, 1.5 * dpr, plotHeight);
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

    const curve = (value: (pitch: number) => number, from: number, to: number) => {
      g.beginPath();
      let drawing = false;
      for (let i = 0; i < track.f0.length; i++) {
        const t = i * track.hopSec;
        const pitch = track.f0[i];
        if (!Number.isFinite(pitch) || t < from || t > to) {
          drawing = false;
          continue;
        }
        if (drawing) g.lineTo(x(t), y(value(pitch)));
        else g.moveTo(x(t), y(value(pitch)));
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
      [markers.rangeStart, markers.attack, "--band-head", "頭部"],
      [markers.sustainStart, markers.sustainEnd, "--band-sustain", "持続区間"],
      [markers.tailStart, markers.rangeEnd, "--band-tail", "語尾"],
    ];
    g.fillStyle = cssVar("--strip");
    g.fillRect(0, plotHeight, width, strip);
    g.font = `${11 * dpr}px system-ui, sans-serif`;
    for (const [from, to, color, text] of bands) {
      if (to <= from) continue;
      g.fillStyle = cssVar(color);
      g.fillRect(x(from), plotHeight + 4 * dpr, x(to) - x(from), strip - 8 * dpr);
      g.globalAlpha = 0.14;
      g.fillRect(x(from), 0, x(to) - x(from), plotHeight);
      g.globalAlpha = 1;
      const textWidth = g.measureText(text).width;
      if (x(to) - x(from) > textWidth + 6 * dpr) {
        g.fillStyle = cssVar("--band-text");
        g.fillText(text, x(from) + 4 * dpr, plotHeight + strip / 2 + 4 * dpr);
      }
    }

    // The "after" lane: the output's parts laid out in time, the sustain's stretch written on it, the vibrato over it.
    g.fillStyle = cssVar("--strip");
    g.fillRect(0, stripBottom, width, lane);
    g.fillStyle = cssVar("--line");
    g.fillRect(0, stripBottom, width, 1 * dpr);
    const layout = this.layout;
    if (layout && layout.totalSec > 0) {
      g.font = `${10 * dpr}px system-ui, sans-serif`;
      const labelW = g.measureText("書き出し後").width + 10 * dpr;
      const laneX = labelW;
      const laneW = width - laneX - 4 * dpr;
      const px = (sec: number) => laneX + (sec / layout.totalSec) * laneW;
      g.fillStyle = cssVar("--muted");
      g.fillText("書き出し後", 4 * dpr, stripBottom + lane / 2 + 4 * dpr);
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
        const textWidth = g.measureText(text).width;
        if (px(to) - px(from) > textWidth + 6 * dpr) {
          g.fillStyle = cssVar("--band-text");
          g.fillText(text, px(from) + 4 * dpr, stripBottom + lane / 2 + 4 * dpr);
        }
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
          const mid = stripBottom + lane / 2;
          const amp = Math.min(lane * 0.4, (vib.depthCents / 100) * lane * 0.4);
          const steps = Math.max(2, Math.round(px(to) - px(from)));
          for (let i = 0; i <= steps; i++) {
            const t = from + ((to - from) * i) / steps;
            const fadeIn = Math.min(1, (t - from) / 0.15);
            const yy = mid - amp * fadeIn * Math.sin(2 * Math.PI * vib.rateHz * (t - from));
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
      const hx = Math.round(x(markers[handle]));
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
  }
}
