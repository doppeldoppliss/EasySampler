// The page's side of the render worker (design.md 38): a job in, its progress
// and its result (the samples, or the measurements) back, one job at a time.
// Where a worker cannot be made, the render runs here as before (the page
// pauses, but the result is the same).

import type { RenderJob, RenderMeasure, RenderReply } from "../workers/render.worker";
import { renderSong, type RenderedSong, type SongRenderInput } from "./songRender";
import { integratedLoudness, stereoImage, truePeak } from "../audio/loudness";
import { bandSpectrum } from "../fx/balance";

export type { RenderMeasure };

type Waiting = { progress?: (share: number) => void; resolve: (value: RenderedSong | RenderMeasure) => void; reject: (error: Error) => void };

let worker: Worker | null | undefined;
let nextId = 1;
const waiting = new Map<number, Waiting>();

function theWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL("../workers/render.worker.ts", import.meta.url), { type: "module" });
  } catch {
    worker = null;
    return null;
  }
  worker.onmessage = (event: MessageEvent<RenderReply>) => {
    const reply = event.data;
    const job = waiting.get(reply.id);
    if (!job) return;
    if ("progress" in reply) job.progress?.(reply.progress);
    else {
      waiting.delete(reply.id);
      if ("error" in reply) job.reject(new Error(reply.error));
      else job.resolve("song" in reply ? reply.song : reply.measure);
    }
  };
  // (The worker itself failed — a script that would not load: every job waiting fails, the next one starts afresh.)
  worker.onerror = (event) => {
    for (const job of waiting.values()) job.reject(new Error(event.message || "書き出しの処理を始められませんでした"));
    waiting.clear();
    worker?.terminate();
    worker = undefined;
  };
  return worker;
}

const dB = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

/** The measurements of a rendered song (as the worker takes them). */
function measure(song: RenderedSong): RenderMeasure {
  const [l, r] = song.channels;
  let peak = 0;
  for (const c of song.channels) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
  return { lufs: integratedLoudness(l, r, song.sampleRate), peakDb: dB(peak), truePeakDb: dB(truePeak(l, r)), bands: bandSpectrum(song.channels, song.sampleRate), ...stereoImage(l, r) };
}

/** Renders a song off the page: its samples. */
export function renderOff(input: SongRenderInput, want: "song", progress?: (share: number) => void): Promise<RenderedSong>;
/** Renders a song off the page: only its loudness, peaks and bands. */
export function renderOff(input: SongRenderInput, want: "measure", progress?: (share: number) => void): Promise<RenderMeasure>;
export async function renderOff(input: SongRenderInput, want: "song" | "measure", progress?: (share: number) => void): Promise<RenderedSong | RenderMeasure> {
  const w = theWorker();
  if (!w) {
    const song = await renderSong(input, async (share) => {
      progress?.(share);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return want === "song" ? song : measure(song);
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { progress, resolve, reject });
    w.postMessage({ id, want, input } satisfies RenderJob);
  });
}
