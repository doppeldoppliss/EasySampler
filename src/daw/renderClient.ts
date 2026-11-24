// The page's side of the render worker (design.md 38): a job in, its progress
// and its result (the samples, or the measurements) back; a few workers take
// the jobs side by side.
// Where a worker cannot be made, the render runs here as before (the page
// pauses, but the result is the same).

import type { RenderJob, RenderMeasure, RenderReply, RoundingAsk } from "../workers/render.worker";
import { renderSong, type RenderedSong, type SongRenderInput } from "./songRender";
import { integratedLoudness, stereoImage, truePeak } from "../audio/loudness";
import { bandSpectrum } from "../fx/balance";
import { roundingFor } from "../fx/clip";

export type { RenderMeasure };

type Job = { id: number; message: RenderJob; progress?: (share: number) => void; resolve: (value: RenderedSong | RenderMeasure) => void; reject: (error: Error) => void };

/**
 * A few workers, each on one job at a time: the automatic mixing measures every track alone, and those renders do
 * not depend on each other — side by side they take a fraction of the time. (Half the cores, four at most: every
 * job carries its own copy of the materials.)
 */
const POOL = Math.max(1, Math.min(4, Math.floor((typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 2 : 2) / 2)));
type Slot = { worker: Worker; job: Job | null };
let slots: Slot[] | null | undefined;
let nextId = 1;
const queue: Job[] = [];

function pool(): Slot[] | null {
  if (slots !== undefined) return slots;
  try {
    slots = Array.from({ length: POOL }, () => ({ worker: new Worker(new URL("../workers/render.worker.ts", import.meta.url), { type: "module" }), job: null }));
  } catch {
    slots = null;
    return null;
  }
  for (const slot of slots) {
    slot.worker.onmessage = (event: MessageEvent<RenderReply>) => {
      const reply = event.data;
      const job = slot.job;
      if (!job || job.id !== reply.id) return;
      if ("progress" in reply) job.progress?.(reply.progress);
      else {
        slot.job = null;
        if ("error" in reply) job.reject(new Error(reply.error));
        else job.resolve("song" in reply ? reply.song : reply.measure);
        pump();
      }
    };
    // (A worker itself failed — a script that would not load: every job fails, the next one starts afresh.)
    slot.worker.onerror = (event) => {
      const error = new Error(event.message || "書き出しの処理を始められませんでした");
      for (const other of slots ?? []) {
        other.job?.reject(error);
        other.worker.terminate();
      }
      for (const job of queue.splice(0)) job.reject(error);
      slots = undefined;
    };
  }
  return slots;
}

/** Jobs waiting go to the workers that are free. */
function pump(): void {
  for (const slot of slots ?? []) {
    if (slot.job || !queue.length) continue;
    slot.job = queue.shift()!;
    slot.worker.postMessage(slot.job.message);
  }
}

const dB = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

/** The measurements of a rendered song (as the worker takes them). */
function measure(song: RenderedSong, rounding?: RoundingAsk): RenderMeasure {
  const [l, r] = song.channels;
  let peak = 0;
  for (const c of song.channels) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
  return { lufs: integratedLoudness(l, r, song.sampleRate), peakDb: dB(peak), truePeakDb: dB(truePeak(l, r)), bands: bandSpectrum(song.channels, song.sampleRate), ...stereoImage(l, r, song.sampleRate), ...(rounding ? { rounding: roundingFor(l, r, song.sampleRate, rounding.targetPlr, rounding.maxUnderPeakDb) } : {}) };
}

/** Renders a song off the page: its samples. */
export function renderOff(input: SongRenderInput, want: "song", progress?: (share: number) => void): Promise<RenderedSong>;
/** Renders a song off the page: only its loudness, peaks and bands. */
export function renderOff(input: SongRenderInput, want: "measure", progress?: (share: number) => void, rounding?: RoundingAsk): Promise<RenderMeasure>;
export async function renderOff(input: SongRenderInput, want: "song" | "measure", progress?: (share: number) => void, rounding?: RoundingAsk): Promise<RenderedSong | RenderMeasure> {
  if (!pool()) {
    const song = await renderSong(input, async (share) => {
      progress?.(share);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return want === "song" ? song : measure(song, rounding);
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    queue.push({ id, message: { id, want, input, rounding }, progress, resolve, reject });
    pump();
  });
}
