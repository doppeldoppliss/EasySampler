// Renders a song off the page's thread (design.md 38): the WAV export, the
// stems, and the automatic mixing's measurements (each track alone, the whole
// song) render the full engine for seconds to minutes; done here, the page
// keeps answering — the progress bar moves, the buttons work — instead of
// freezing (on an iPhone for long). A job asks for the samples ("song") or
// only what is measured from them ("measure": loudness, peaks, the
// third-octave bands), so a long render need not come back whole.

import { integratedLoudness, stereoImage, truePeak } from "../audio/loudness";
import { renderSong, type RenderedSong, type SongRenderInput } from "../daw/songRender";
import { bandSpectrum } from "../fx/balance";

export interface RenderMeasure {
  /** Integrated loudness (LUFS; −Infinity when silent). */
  lufs: number;
  /** The highest sample and the true peak (dBFS / dBTP). */
  peakDb: number;
  truePeakDb: number;
  /** Third-octave band levels (BAND_HZ), null when silent. */
  bands: number[] | null;
  /** How wide it is (stereoImage). */
  correlation: number;
  sideDb: number;
}

export type RenderJob = { id: number; want: "song" | "measure"; input: SongRenderInput };
export type RenderReply = { id: number; progress: number } | { id: number; song: RenderedSong } | { id: number; measure: RenderMeasure } | { id: number; error: string };

const post = (reply: RenderReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(reply, transfer);
const dB = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

self.onmessage = async (event: MessageEvent<RenderJob>) => {
  const { id, want, input } = event.data;
  try {
    let last = -1;
    const song = await renderSong(input, async (share) => {
      // (A progress message per percent: enough for the bar, not a flood.)
      const pct = Math.floor(share * 100);
      if (pct !== last) {
        last = pct;
        post({ id, progress: share });
      }
    });
    if (want === "song") {
      post({ id, song }, song.channels.map((c) => c.buffer));
      return;
    }
    const [l, r] = song.channels;
    let peak = 0;
    for (const c of song.channels) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
    post({ id, measure: { lufs: integratedLoudness(l, r, song.sampleRate), peakDb: dB(peak), truePeakDb: dB(truePeak(l, r)), bands: bandSpectrum(song.channels, song.sampleRate), ...stereoImage(l, r) } });
  } catch (error) {
    post({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
