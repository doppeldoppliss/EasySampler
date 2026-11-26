// Renders a song off the page's thread (design.md 38): the WAV export, the
// stems, and the automatic mixing's measurements (each track alone, the whole
// song) render the full engine for seconds to minutes; done here, the page
// keeps answering — the progress bar moves, the buttons work — instead of
// freezing (on an iPhone for long). A job asks for the samples ("song") or
// only what is measured from them ("measure": loudness, peaks, the
// third-octave bands), so a long render need not come back whole.

import { renderSong, type RenderedSong, type SongRenderInput } from "../daw/songRender";
import { measureSong, type MeasureAsk, type RenderMeasure } from "../daw/measureSong";

export type RenderJob = { id: number; want: "song" | "measure"; input: SongRenderInput; ask?: MeasureAsk };
export type RenderReply = { id: number; progress: number } | { id: number; song: RenderedSong } | { id: number; measure: RenderMeasure } | { id: number; error: string };

const post = (reply: RenderReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(reply, transfer);

self.onmessage = async (event: MessageEvent<RenderJob>) => {
  const { id, want, input, ask } = event.data;
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
    const measure = measureSong(song, ask);
    post({ id, measure }, measure.ear ? [measure.ear.left.buffer, measure.ear.right.buffer] : []);
  } catch (error) {
    post({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
