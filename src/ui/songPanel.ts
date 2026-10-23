// "曲で試す": open a MIDI file, pick the part the material plays, and hear
// it in the song before writing the file — the other parts as a plain
// backing. Nothing here is saved or exported; it's a listening check.

import { pitchLabel } from "../analysis/pitch";
import type { EngineClient } from "../audio/engineClient";
import { MidiParseError, parseMidi, type Song } from "../song/midi";
import { backingNotes, materialNotes, songParts, type SongPart } from "../song/parts";
import { el } from "./dom";
import { clock } from "./rangePicker";

/** How far past the last note the song keeps running before it stops on its own. */
const END_PAD_SEC = 1;

export function isMidiFile(file: File): boolean {
  return /\.(mid|midi|smf)$/i.test(file.name) || file.type === "audio/midi" || file.type === "audio/x-midi";
}

function button(text: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", { className: `button ${className}`, textContent: text });
  b.addEventListener("click", onClick);
  return b;
}

export class SongPanel {
  readonly element: HTMLElement;
  /** Fired when playback starts or stops (the page stops its own previews). */
  onPlayingChange: (playing: boolean) => void = () => {};

  private song: Song | null = null;
  private parts: SongPart[] = [];
  private partId = "";
  private transpose = 0;
  private backingOn = true;
  private backingVolume = 0.5;
  /** Where playback starts (song seconds), and the context time it started at while playing. */
  private from = 0;
  private startedAt: number | null = null;
  private frame = 0;

  private readonly fileInput = el("input", { type: "file", accept: ".mid,.midi,audio/midi,audio/x-midi", className: "visually-hidden" });
  private readonly info = el("p", { className: "fine", role: "status" });
  private readonly body = el("div", { className: "song-body", hidden: true });
  private readonly partSelect = el("select", { ariaLabel: "素材で鳴らすパート" });
  private readonly partNote = el("p", { className: "fine help" });
  private readonly transposeLabel = el("output", { className: "num" });
  private readonly backingCheck = el("input", { type: "checkbox", checked: true });
  private readonly backingRange = el("input", { type: "range", min: "0", max: "1", step: "0.01", value: "0.5", ariaLabel: "伴奏の音量" });
  private readonly playButton = button("▶ 再生", "big primary", () => this.toggle());
  private readonly seek = el("input", { type: "range", min: "0", max: "1", step: "0.01", value: "0", className: "song-seek", ariaLabel: "再生位置" });
  private readonly position = el("span", { className: "num" });

  private readonly client: EngineClient;
  /** The note the current cut is made for (a drum part plays every hit on it). */
  private readonly currentNote: () => number;
  /** The tempo the engine counts the tail limit in when no song is playing (the export BPM). */
  private readonly restingBpm: () => number;

  constructor(client: EngineClient, currentNote: () => number, restingBpm: () => number) {
    this.client = client;
    this.currentNote = currentNote;
    this.restingBpm = restingBpm;
    this.fileInput.addEventListener("change", () => {
      const file = this.fileInput.files?.[0];
      this.fileInput.value = "";
      if (file) void this.open(file);
    });
    this.partSelect.addEventListener("change", () => {
      this.partId = this.partSelect.value;
      this.refreshPartNote();
      this.reload();
    });
    this.backingCheck.addEventListener("change", () => {
      this.backingOn = this.backingCheck.checked;
      this.backingRange.disabled = !this.backingOn;
      this.reload();
    });
    this.backingRange.addEventListener("input", () => {
      this.backingVolume = Number(this.backingRange.value);
      this.client.setSongGain(this.backingVolume, 1);
    });
    this.seek.addEventListener("input", () => this.showPosition(Number(this.seek.value)));
    this.seek.addEventListener("change", () => {
      this.from = Number(this.seek.value);
      if (this.startedAt !== null) this.start();
    });

    const step = (text: string, delta: number) =>
      button(text, "small", () => {
        this.transpose = Math.max(-36, Math.min(36, this.transpose + delta));
        this.refreshTranspose();
        this.reload();
      });

    this.body.append(
      el("label", { className: "control destination" }, [el("span", { className: "control-label", textContent: "素材で鳴らすパート" }), this.partSelect]),
      this.partNote,
      el("div", { className: "row" }, [
        el("span", { className: "control-label", textContent: "素材パートの移調" }),
        step("−12", -12),
        step("−1", -1),
        this.transposeLabel,
        step("+1", 1),
        step("+12", 12),
      ]),
      el("div", { className: "row" }, [
        el("label", { className: "control check" }, [this.backingCheck, el("span", { textContent: "ほかのパートを伴奏(簡易音)で鳴らす" })]),
        this.backingRange,
      ]),
      el("div", { className: "song-transport" }, [this.playButton, this.seek, this.position]),
      el("p", { className: "fine", textContent: "素材は今の設定のまま鳴ります。つまみやマーカーを変えると、次に鳴る音から変わります。" }),
    );

    this.element = el("section", { className: "panel song-panel" }, [
      el("div", { className: "row" }, [
        el("span", { className: "control-label", textContent: "曲で試す" }),
        button("MIDI を開く", "small", () => this.fileInput.click()),
        this.fileInput,
      ]),
      this.info,
      this.body,
    ]);
    this.info.textContent = "MIDI ファイル(.mid)を開くと、素材をその曲のメロディで鳴らして確かめられます。ページにドロップしても開けます。";
    this.refreshTranspose();
  }

  get playing(): boolean {
    return this.startedAt !== null;
  }

  async open(file: File): Promise<void> {
    this.stop();
    let song: Song;
    try {
      song = parseMidi(new Uint8Array(await file.arrayBuffer()));
    } catch (error) {
      this.info.textContent = error instanceof MidiParseError ? `MIDI を読めませんでした: ${error.message}` : `MIDI を読めませんでした: ${String(error)}`;
      return;
    }
    if (song.tracks.length === 0) {
      this.info.textContent = `${file.name}: 音符のある MIDI トラックがありません。`;
      return;
    }
    this.song = song;
    this.parts = songParts(song);
    // The busiest melodic part is usually the melody (or close to it).
    const melodic = this.parts.filter((p) => !p.drum && p.duplicateOf === null);
    const pick = (melodic.length > 0 ? melodic : this.parts).reduce((a, b) => (b.notes.length > a.notes.length ? b : a));
    this.partId = pick.id;
    this.transpose = 0;
    this.from = 0;
    this.partSelect.replaceChildren(...this.parts.map((p) => el("option", { value: p.id, textContent: p.label })));
    this.partSelect.value = this.partId;
    this.seek.max = String(Math.max(0.01, song.durationSec));
    this.seek.value = "0";
    const bars = song.bars.length - 1;
    this.info.textContent = `${file.name}: ${Math.round(song.bpm * 10) / 10} BPM${song.hasTempoChanges ? "(途中でテンポが変わります)" : ""}・${bars} 小節・${clock(song.durationSec)}・パート ${this.parts.filter((p) => p.drumPitch === null).length}`;
    this.body.hidden = false;
    this.refreshTranspose();
    this.refreshPartNote();
    this.showPosition(0);
    this.reload();
  }

  private part(): SongPart | null {
    return this.parts.find((p) => p.id === this.partId) ?? null;
  }

  private refreshTranspose(): void {
    this.transposeLabel.textContent = `${this.transpose > 0 ? "+" : ""}${this.transpose}`;
  }

  private refreshPartNote(): void {
    const part = this.part();
    if (!part) {
      this.partNote.textContent = "";
      return;
    }
    this.partNote.textContent = part.drum
      ? `ドラムのパートでは、どの打撃も素材を今の音名(${pitchLabel(this.currentNote())})で鳴らします。移調は使いません。`
      : part.duplicateOf
        ? part.shiftSec === 0
          ? "このパートは別のパートとまったく同じ音符です(重ねて厚くするための複製)。伴奏ではどちらか片方だけ鳴らします。"
          : "このパートは別のパートを少し遅らせた重ね(エコー)です。元のパートを素材で鳴らすときは、伴奏から外します。"
        : this.parts.some((p) => p.duplicateOf === part.id && p.shiftSec !== 0)
          ? "このパートには少し遅らせた重ね(エコー)のパートがあります。素材の音が隠れないよう、伴奏からは外しています。"
          : "";
  }

  /** Sends the notes again (after a change); a song playing goes on from where it is. */
  private reload(): void {
    if (!this.song) return;
    const part = this.part();
    const material = part ? materialNotes(part, part.drum ? 0 : this.transpose, part.drum ? Math.round(this.currentNote()) : null) : [];
    const backing = this.backingOn ? backingNotes(this.parts, part) : [];
    const position = this.currentPosition();
    this.client.loadSong(material, backing);
    this.client.setSongGain(this.backingVolume, 1);
    if (this.startedAt !== null) {
      this.from = position;
      this.start();
    }
  }

  private currentPosition(): number {
    const now = this.client.currentTime;
    if (this.startedAt === null || now === null) return this.from;
    return this.from + Math.max(0, now - this.startedAt);
  }

  private toggle(): void {
    if (this.startedAt !== null) {
      this.from = this.currentPosition();
      this.stop();
      return;
    }
    if (!this.song) return;
    if (this.from >= this.song.durationSec) this.from = 0;
    // A drum part follows the cut's note as it is now.
    if (this.part()?.drum) this.reload();
    this.start();
  }

  private start(): void {
    if (this.song) this.client.setTempo(this.song.bpm);
    this.startedAt = this.client.playSong(this.from);
    this.playButton.textContent = "■ 停止";
    this.onPlayingChange(true);
    cancelAnimationFrame(this.frame);
    const tick = () => {
      if (this.startedAt === null || !this.song) return;
      const pos = this.currentPosition();
      if (pos > this.song.durationSec + END_PAD_SEC) {
        this.from = 0;
        this.stop();
        return;
      }
      this.seek.value = String(Math.min(pos, this.song.durationSec));
      this.showPosition(pos);
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  /** Stops playback (the position stays where it was set). */
  stop(): void {
    cancelAnimationFrame(this.frame);
    if (this.startedAt === null) return;
    this.startedAt = null;
    this.client.stopSong();
    this.client.setTempo(this.restingBpm());
    this.playButton.textContent = "▶ 再生";
    this.seek.value = String(this.from);
    this.showPosition(this.from);
    this.onPlayingChange(false);
  }

  /** The cut's note changed: a drum part plays on it, so its hint and notes follow. */
  noteChanged(): void {
    if (this.part()?.drum) {
      this.refreshPartNote();
      this.reload();
    }
  }

  private showPosition(sec: number): void {
    if (!this.song) return;
    const bars = this.song.bars;
    let bar = 0;
    while (bar + 1 < bars.length && bars[bar + 1] <= sec + 1e-6) bar++;
    const total = Math.max(1, bars.length - 1);
    this.position.textContent = `${Math.min(bar + 1, total)} / ${total} 小節・${clock(Math.min(sec, this.song.durationSec))}`;
  }
}
