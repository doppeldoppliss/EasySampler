// The material editor (素材エディタ, design.md 7.2): the waveform, the
// material's own pitch curve (orange, thin dashed) and the curve after
// flattening (yellow, thick solid — VocalShifter's colours, told apart by
// line as well as colour), the root pitch line, and the synthesis markers as
// labelled bands with draggable edges.

import { pitchLabel } from "../analysis/pitch";
import type { PitchTrack } from "../analysis/pyin";
import { clampMarkers } from "../instrument/markers";
import type { Markers } from "../instrument/types";
import { cssVar, el } from "./dom";

export interface EditorMaterial {
  mono: Float32Array;
  sampleRate: number;
  track: PitchTrack;
}

type Handle = keyof Markers;

const STRIP_HEIGHT = 36;
const HANDLE_REACH_MOUSE = 8;
const HANDLE_REACH_TOUCH = 22;

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
  private dragging: { handle: Handle; pointerId: number } | null = null;
  private hover: Handle | null = null;
  onMarkersChange: (markers: Markers, final: boolean) => void = () => {};

  constructor() {
    this.canvas = el("canvas", { className: "editor-canvas", ariaLabel: "素材の波形とピッチカーブ" });
    this.element = el("div", { className: "editor" }, [this.canvas]);
    this.canvas.addEventListener("pointerdown", (event) => this.down(event));
    this.canvas.addEventListener("pointermove", (event) => this.move(event));
    this.canvas.addEventListener("pointerup", (event) => this.up(event));
    this.canvas.addEventListener("pointercancel", (event) => this.up(event));
    new ResizeObserver(() => this.draw()).observe(this.canvas);
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.draw());
  }

  setMaterial(material: EditorMaterial | null): void {
    this.material = material;
    this.draw();
  }

  setState(markers: Markers, root: number, flatten: number, target = root): void {
    this.markers = markers;
    this.root = root;
    this.target = target;
    this.flatten = flatten;
    this.draw();
  }

  private get duration(): number {
    return this.material ? this.material.mono.length / this.material.sampleRate : 1;
  }

  private timeAt(clientX: number): number {
    const box = this.canvas.getBoundingClientRect();
    return Math.max(0, Math.min(this.duration, ((clientX - box.left) / box.width) * this.duration));
  }

  private handleAt(event: PointerEvent): Handle | null {
    if (!this.markers) return null;
    const box = this.canvas.getBoundingClientRect();
    const reach = event.pointerType === "mouse" ? HANDLE_REACH_MOUSE : HANDLE_REACH_TOUCH;
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const inStripLower = y > box.height - STRIP_HEIGHT / 2;
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

  private down(event: PointerEvent): void {
    const handle = this.handleAt(event);
    if (!handle) return;
    event.preventDefault();
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      // (a pointer that is already gone)
    }
    this.dragging = { handle, pointerId: event.pointerId };
  }

  private move(event: PointerEvent): void {
    if (!this.dragging || this.dragging.pointerId !== event.pointerId || !this.markers) {
      const hover = this.handleAt(event);
      if (hover !== this.hover) {
        this.hover = hover;
        this.canvas.style.cursor = hover ? "ew-resize" : "default";
        this.draw();
      }
      return;
    }
    const markers = this.moved(this.dragging.handle, this.timeAt(event.clientX));
    this.markers = markers;
    this.draw();
    this.onMarkersChange(markers, false);
  }

  private up(event: PointerEvent): void {
    if (!this.dragging || this.dragging.pointerId !== event.pointerId || !this.markers) return;
    this.dragging = null;
    this.onMarkersChange(this.markers, true);
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
    const plotHeight = height - strip;
    const x = (t: number) => (t / this.duration) * width;

    // Outside the range: shaded.
    g.fillStyle = cssVar("--outside");
    g.fillRect(0, 0, x(markers.rangeStart), height);
    g.fillRect(x(markers.rangeEnd), 0, width - x(markers.rangeEnd), height);

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

    // Pitch scale: the voiced curve and the root, with some room.
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

    // The detected root: dotted line. The target note (the file's pitch): solid accent line, labelled at the right.
    g.font = `600 ${12 * dpr}px system-ui, sans-serif`;
    const line = (midi: number, label: string, color: string, dash: number[]) => {
      g.strokeStyle = color;
      g.lineWidth = 1.5 * dpr;
      g.setLineDash(dash);
      g.beginPath();
      g.moveTo(0, y(midi));
      g.lineTo(width, y(midi));
      g.stroke();
      g.setLineDash([]);
      const labelWidth = g.measureText(label).width;
      g.fillStyle = cssVar("--panel");
      g.fillRect(width - labelWidth - 12 * dpr, y(midi) - 16 * dpr, labelWidth + 8 * dpr, 15 * dpr);
      g.fillStyle = color;
      g.fillText(label, width - labelWidth - 8 * dpr, y(midi) - 4 * dpr);
    };
    // (within a quarter tone the two lines sit on top of each other: the root's label would only overlap)
    if (Math.abs(this.target - this.root) > 0.5) line(this.root, `判定 ${pitchLabel(this.root)}`, cssVar("--muted"), [2 * dpr, 4 * dpr]);
    line(this.target, pitchLabel(this.target), cssVar("--accent"), []);

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

    // Handles: a line through everything, a grip in the strip. The range
    // handles (the cut) are bigger, with a bracket at the top, since they are
    // the first thing to reach for.
    for (const handle of HANDLE_ORDER) {
      const hx = Math.round(x(markers[handle]));
      const active = this.dragging?.handle === handle || this.hover === handle;
      const isRange = handle === "rangeStart" || handle === "rangeEnd";
      g.fillStyle = active ? cssVar("--accent") : cssVar("--handle");
      g.fillRect(hx - (active || isRange ? 1 : 0.5) * dpr, 0, (active || isRange ? 2 : 1) * dpr, height);
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
