// Picking a stretch of a long material before it is analysed (design.md 6:
// 長い素材は切り出してから解析する). An overview of the whole clip, two
// handles, and a cap on how much may be taken at once: dragging one handle
// past the cap pushes the other along.

import { el, cssVar } from "./dom";

export interface PickedRange {
  /** Seconds within the clip. */
  from: number;
  to: number;
}

const HANDLE_REACH_MOUSE = 10;
const HANDLE_REACH_TOUCH = 24;

export class RangePicker {
  readonly element: HTMLElement;
  private canvas: HTMLCanvasElement;
  /** Min/max per overview column (pairs), built once per clip. */
  private overview: Float32Array | null = null;
  private durationSec = 1;
  private maxSec = 60;
  private range: PickedRange = { from: 0, to: 1 };
  private dragging: { which: "from" | "to" | "both"; pointerId: number; grabOffset: number } | null = null;
  onChange: (range: PickedRange, final: boolean) => void = () => {};

  constructor() {
    this.canvas = el("canvas", { className: "picker-canvas", ariaLabel: "素材全体の波形と、使う範囲" });
    this.element = el("div", { className: "picker" }, [this.canvas]);
    this.canvas.addEventListener("pointerdown", (e) => this.down(e));
    this.canvas.addEventListener("pointermove", (e) => this.move(e));
    this.canvas.addEventListener("pointerup", (e) => this.up(e));
    this.canvas.addEventListener("pointercancel", (e) => this.up(e));
    new ResizeObserver(() => this.draw()).observe(this.canvas);
  }

  /** A new clip: builds the overview from a mono signal, and starts with the first `maxSec` seconds selected. */
  setClip(mono: Float32Array, sampleRate: number, maxSec: number): void {
    this.durationSec = mono.length / sampleRate;
    this.maxSec = maxSec;
    const columns = 2000;
    const overview = new Float32Array(columns * 2);
    const perColumn = mono.length / columns;
    for (let c = 0; c < columns; c++) {
      let lo = 0;
      let hi = 0;
      const from = Math.floor(c * perColumn);
      const to = Math.min(mono.length, Math.floor((c + 1) * perColumn) + 1);
      for (let i = from; i < to; i++) {
        const v = mono[i];
        if (v < lo) lo = v;
        else if (v > hi) hi = v;
      }
      overview[c * 2] = lo;
      overview[c * 2 + 1] = hi;
    }
    this.overview = overview;
    this.range = { from: 0, to: Math.min(this.durationSec, maxSec) };
    this.draw();
  }

  get value(): PickedRange {
    return this.range;
  }

  setRange(range: PickedRange): void {
    this.range = this.clamp(range, "to");
    this.draw();
  }

  private clamp(range: PickedRange, moved: "from" | "to"): PickedRange {
    let from = Math.max(0, Math.min(this.durationSec, range.from));
    let to = Math.max(0, Math.min(this.durationSec, range.to));
    if (to < from) [from, to] = [to, from];
    if (to - from < 0.1) {
      if (moved === "from") from = Math.max(0, to - 0.1);
      else to = Math.min(this.durationSec, from + 0.1);
    }
    // Over the cap: the other handle follows.
    if (to - from > this.maxSec) {
      if (moved === "from") to = from + this.maxSec;
      else from = to - this.maxSec;
    }
    return { from, to };
  }

  private timeAt(clientX: number): number {
    const box = this.canvas.getBoundingClientRect();
    return Math.max(0, Math.min(this.durationSec, ((clientX - box.left) / box.width) * this.durationSec));
  }

  private down(e: PointerEvent): void {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const box = this.canvas.getBoundingClientRect();
    const reach = e.pointerType === "mouse" ? HANDLE_REACH_MOUSE : HANDLE_REACH_TOUCH;
    const px = (t: number) => (t / this.durationSec) * box.width;
    const x = e.clientX - box.left;
    const t = this.timeAt(e.clientX);
    let which: "from" | "to" | "both";
    if (Math.abs(px(this.range.from) - x) < reach) which = "from";
    else if (Math.abs(px(this.range.to) - x) < reach) which = "to";
    else if (t > this.range.from && t < this.range.to) which = "both";
    else {
      // A press outside: the selection jumps there, keeping its length.
      const length = this.range.to - this.range.from;
      const from = Math.max(0, Math.min(this.durationSec - length, t - length / 2));
      this.range = { from, to: from + length };
      which = "both";
    }
    e.preventDefault();
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // gone already
    }
    this.dragging = { which, pointerId: e.pointerId, grabOffset: t - this.range.from };
    this.draw();
    this.onChange(this.range, false);
  }

  private move(e: PointerEvent): void {
    if (!this.dragging || this.dragging.pointerId !== e.pointerId) {
      const box = this.canvas.getBoundingClientRect();
      const reach = e.pointerType === "mouse" ? HANDLE_REACH_MOUSE : HANDLE_REACH_TOUCH;
      const px = (t: number) => (t / this.durationSec) * box.width;
      const x = e.clientX - box.left;
      const nearHandle = Math.abs(px(this.range.from) - x) < reach || Math.abs(px(this.range.to) - x) < reach;
      this.canvas.style.cursor = nearHandle ? "ew-resize" : "grab";
      return;
    }
    const t = this.timeAt(e.clientX);
    const d = this.dragging;
    if (d.which === "both") {
      const length = this.range.to - this.range.from;
      const from = Math.max(0, Math.min(this.durationSec - length, t - d.grabOffset));
      this.range = { from, to: from + length };
    } else {
      this.range = this.clamp({ ...this.range, [d.which]: t }, d.which);
    }
    this.draw();
    this.onChange(this.range, false);
  }

  private up(e: PointerEvent): void {
    if (!this.dragging || this.dragging.pointerId !== e.pointerId) return;
    this.dragging = null;
    this.onChange(this.range, true);
  }

  draw(): void {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    const g = this.canvas.getContext("2d")!;
    g.clearRect(0, 0, width, height);
    const overview = this.overview;
    if (!overview) return;
    const columns = overview.length / 2;
    const x = (t: number) => (t / this.durationSec) * width;
    const mid = height / 2;

    // Waveform.
    g.fillStyle = cssVar("--wave");
    for (let col = 0; col < width; col++) {
      const c = Math.min(columns - 1, Math.floor((col / width) * columns));
      const lo = overview[c * 2];
      const hi = overview[c * 2 + 1];
      g.fillRect(col, mid - hi * mid * 0.9, 1, Math.max(1, (hi - lo) * mid * 0.9));
    }
    // Outside the selection: shaded.
    g.fillStyle = cssVar("--outside");
    g.fillRect(0, 0, x(this.range.from), height);
    g.fillRect(x(this.range.to), 0, width - x(this.range.to), height);
    // The selection: a tinted band, bracketed handles.
    g.fillStyle = cssVar("--accent");
    g.globalAlpha = 0.1;
    g.fillRect(x(this.range.from), 0, x(this.range.to) - x(this.range.from), height);
    g.globalAlpha = 1;
    for (const [t, dir] of [[this.range.from, 1], [this.range.to, -1]] as const) {
      const hx = Math.round(x(t));
      g.fillRect(hx - 1 * dpr, 0, 2 * dpr, height);
      g.fillRect(hx - (dir > 0 ? 1 : 11) * dpr, 0, 12 * dpr, 4 * dpr);
      g.fillRect(hx - (dir > 0 ? 1 : 11) * dpr, height - 4 * dpr, 12 * dpr, 4 * dpr);
    }
    // Time ticks every 10 s (every minute when long).
    const tick = this.durationSec > 600 ? 60 : 10;
    g.font = `${10 * dpr}px system-ui, sans-serif`;
    g.fillStyle = cssVar("--muted");
    for (let t = 0; t <= this.durationSec; t += tick) {
      g.fillRect(Math.round(x(t)), height - 10 * dpr, 1, 10 * dpr);
      g.fillText(clock(t), x(t) + 3 * dpr, height - 2 * dpr);
    }
  }
}

/** 1:23.4 */
export function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(seconds % 1 === 0 ? 0 : 1)}`;
}
