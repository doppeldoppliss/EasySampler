// 打ち込み (design.md 13, phase 1): a song of one track, written on the piano
// roll and played by the material open now. The song is kept in the browser
// and comes back on the next visit; a part of the MIDI file opened in 曲で試す
// can be taken over as a start.

import { CURRENT_INSTRUMENT, type EngineClient } from "../audio/engineClient";
import type { FxSettings } from "../instrument/types";
import { keep, kept } from "../audio/lastMaterial";
import { beatsToSec, emptyProject, fromSongNotes, sanitizeProject, secToBeats, shifted, songEnd, toSeqNotes, type Note, type Project } from "../daw/model";
import type { SongPart } from "../song/parts";
import { el } from "./dom";
import { PianoRoll } from "./pianoRoll";

const STORE_KEY = "project";
const TRACK_ID = "track-0";
const COARSE = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
/** How far past the last note playback runs before it stops on its own (beats). */
const END_PAD_BEATS = 2;

function button(text: string, className: string, onClick: () => void, title = ""): HTMLButtonElement {
  const b = el("button", { type: "button", className: `button ${className}`.trim(), textContent: text, title });
  b.addEventListener("click", onClick);
  return b;
}

const GRIDS: [number, string][] = [
  [1, "1 拍"],
  [0.5, "1/2 拍(8 分)"],
  [0.25, "1/4 拍(16 分)"],
  [1 / 3, "1/3 拍(3 連)"],
  [0.125, "1/8 拍(32 分)"],
  [0, "吸着なし"],
];

export class RollPanel {
  readonly element: HTMLElement;
  readonly roll = new PianoRoll();
  /** Playback started or stopped (the page stops its other players). */
  onPlayingChange: (playing: boolean) => void = () => {};
  /** The project was replaced (restored): the page shows the track's effects again. */
  onProjectChange: () => void = () => {};

  private project: Project = emptyProject();
  private readonly client: EngineClient;
  private readonly restingBpm: () => number;
  private readonly importPart: () => { part: SongPart; bpm: number; transpose: number } | null;

  private startedAt: number | null = null;
  /** Where playback starts (song seconds). */
  private from = 0;
  private frame = 0;
  private saveTimer = 0;

  private readonly playButton = button("▶ 再生", "big", () => this.toggle());
  private readonly loopButton = button("", "small", () => this.setLoopOn(!this.project.loop.on));
  private readonly bpmInput = el("input", { type: "number", min: "20", max: "400", step: "1", inputMode: "decimal", ariaLabel: "BPM" });
  private readonly gridSelect = el("select", { ariaLabel: "吸着" }, GRIDS.map(([v, label]) => el("option", { value: String(v), textContent: label })));
  private readonly selectToggle = button("", "small", () => {
    this.roll.selectMode = !this.roll.selectMode;
    this.refreshButtons();
  });
  private readonly undoButton = button("取り消し", "small", () => this.roll.undo());
  private readonly redoButton = button("やり直し", "small", () => this.roll.redo());
  private readonly deleteButton = button("削除", "small", () => this.roll.deleteSelected());
  private readonly duplicateButton = button("複製", "small", () => this.roll.duplicateSelected(), "選んだ音符の直後にコピーを置きます(Ctrl+D)");
  private readonly transposeButtons = [
    button("−12", "small", () => this.roll.transposeSelected(-12), "選んだ音符を 1 オクターブ下げる(Shift+↓)"),
    button("−1", "small", () => this.roll.transposeSelected(-1), "半音下げる(↓)"),
    button("+1", "small", () => this.roll.transposeSelected(1), "半音上げる(↑)"),
    button("+12", "small", () => this.roll.transposeSelected(12), "1 オクターブ上げる(Shift+↑)"),
  ];
  private readonly importButton = button("曲で試すのパートを取り込む", "small", () => this.takePart());
  private readonly clearButton = button("すべて消す", "small", () => {
    if (!this.roll.notes.length) return;
    this.roll.setNotes([], true);
    this.changed(this.roll.notes);
    this.info.textContent = "すべて消しました。取り消しで戻せます。";
  });
  private readonly position = el("span", { className: "fine num" });
  private readonly info = el("p", { className: "fine", role: "status" });

  constructor(client: EngineClient, restingBpm: () => number, importPart: () => { part: SongPart; bpm: number; transpose: number } | null) {
    this.client = client;
    this.restingBpm = restingBpm;
    this.importPart = importPart;

    this.roll.onChange = (notes) => this.changed(notes);
    this.roll.onStateChange = () => this.refreshButtons();
    this.roll.onPreview = (pitch) => this.preview(pitch);
    this.roll.onTogglePlay = () => this.toggle();
    this.roll.onSeek = (beat, play) => {
      this.from = beatsToSec(beat, this.project.bpm);
      if (this.playing || play) this.start();
      else this.showPosition(this.from);
    };
    this.roll.onLoopChange = (loop) => {
      this.project.loop = loop;
      this.sendLoop();
      this.refreshButtons();
      this.scheduleSave();
    };

    this.bpmInput.addEventListener("change", () => {
      const bpm = Math.max(20, Math.min(400, Number(this.bpmInput.value) || this.project.bpm));
      const position = this.currentBeat();
      this.project.bpm = bpm;
      this.bpmInput.value = String(bpm);
      this.from = beatsToSec(position, bpm);
      this.reload();
      this.scheduleSave();
    });
    this.gridSelect.value = String(this.roll.grid);
    this.gridSelect.addEventListener("change", () => {
      this.roll.grid = Number(this.gridSelect.value);
      if (this.roll.grid > 0) this.roll.lastLength = Math.max(this.roll.grid, this.roll.lastLength);
      this.roll.draw();
    });
    this.selectToggle.hidden = !COARSE;

    this.element = el("section", { className: "panel roll-panel" }, [
      el("div", { className: "row" }, [el("span", { className: "control-label", textContent: "打ち込み" }), this.importButton, this.clearButton]),
      el("div", { className: "row roll-transport" }, [
        this.playButton,
        this.loopButton,
        el("label", { className: "inline" }, ["BPM ", this.bpmInput]),
        el("label", { className: "inline" }, ["吸着 ", this.gridSelect]),
        this.position,
      ]),
      el("div", { className: "row roll-tools" }, [this.undoButton, this.redoButton, this.deleteButton, this.duplicateButton, ...this.transposeButtons, this.selectToggle, button("−", "small", () => this.roll.zoom(1 / 1.5), "縮小"), button("+", "small", () => this.roll.zoom(1.5), "拡大")]),
      this.roll.element,
      el("p", {
        className: "fine help",
        textContent: COARSE
          ? "空いたところをタップで音符、音符をドラッグで移動、右端をドラッグで長さ。上の目盛りはタップで位置、2 回タップで再生、ドラッグでループ範囲。"
          : "クリックで音符、ドラッグで範囲選択、音符のドラッグで移動(Ctrl で複製・Alt で吸着なし)、右端で長さ、ダブルクリックか右クリックで削除。上の目盛りはクリックで位置、ダブルクリックで再生、ドラッグでループ範囲。Space で再生 / 停止。",
      }),
      this.info,
    ]);
    this.applyProject();
    void this.restore();
  }

  get playing(): boolean {
    return this.startedAt !== null;
  }

  // ------------------------------------------------------------- the track's effects

  /** The effects of the track being edited. */
  trackFx(): FxSettings {
    return this.project.tracks[0].fx;
  }

  /** Changes the track's effects (heard at once, kept). */
  updateTrackFx(change: (fx: FxSettings) => void): void {
    const track = this.project.tracks[0];
    const fx = structuredClone(track.fx);
    change(fx);
    track.fx = fx;
    this.client.setTrackMix(TRACK_ID, { gain: track.gain, pan: track.pan, mute: track.mute, solo: track.solo, fx });
    this.scheduleSave();
  }

  private trackSpecs() {
    const t = this.project.tracks[0];
    return [{ id: TRACK_ID, instrument: CURRENT_INSTRUMENT, notes: toSeqNotes(this.roll.notes, this.project.bpm), fx: t.fx, gain: t.gain, pan: t.pan, mute: t.mute, solo: t.solo }];
  }

  /** The material's note (marked on the keys) — where an empty roll opens. */
  setRoot(pitch: number): void {
    this.roll.setRoot(pitch);
  }

  // ------------------------------------------------------------- the project

  private async restore(): Promise<void> {
    const stored = await kept(STORE_KEY);
    if (stored === undefined || this.roll.notes.length) return;
    this.project = sanitizeProject(stored);
    this.applyProject();
    if (this.roll.notes.length) this.info.textContent = `前回の打ち込み(音符 ${this.roll.notes.length} 個)を開きました。`;
  }

  private applyProject(): void {
    this.bpmInput.value = String(this.project.bpm);
    this.roll.setBeatsPerBar(this.project.beatsPerBar);
    this.roll.setLoop(this.project.loop);
    this.roll.setNotes(this.project.tracks[0].notes);
    this.roll.frame(60);
    this.sendLoop();
    this.refreshButtons();
    this.showPosition(this.from);
    this.onProjectChange();
  }

  private changed(notes: Note[]): void {
    this.project.tracks[0].notes = notes;
    this.info.textContent = "";
    this.reload();
    this.scheduleSave();
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void keep(STORE_KEY, this.project), 400);
  }

  /** The part chosen in 曲で試す, as notes on the roll (one undoable step), with its tempo. */
  private takePart(): void {
    const picked = this.importPart();
    if (!picked) {
      this.info.textContent = "先に「曲で試す」で MIDI を開き、素材で鳴らすパートを選んでください。";
      return;
    }
    const notes = shifted(fromSongNotes(picked.part.notes), 0, picked.transpose);
    this.project.bpm = Math.round(picked.bpm * 10) / 10;
    this.bpmInput.value = String(this.project.bpm);
    this.roll.setNotes(notes, true);
    this.roll.frame(60);
    this.changed(this.roll.notes);
    this.info.textContent = `「${picked.part.label}」の音符 ${notes.length} 個を取り込みました(${this.project.bpm} BPM)。取り消しで戻せます。`;
  }

  // ------------------------------------------------------------- playback

  private preview(pitch: number): void {
    if (this.playing) return;
    this.client.unlock();
    this.client.noteOn(pitch, 0.8);
    window.setTimeout(() => this.client.noteOff(pitch), 220);
  }

  private sendLoop(): void {
    const { loop, bpm } = this.project;
    this.client.setSongLoop(loop.on ? { startSec: beatsToSec(loop.start, bpm), endSec: beatsToSec(loop.end, bpm) } : null);
  }

  private setLoopOn(on: boolean): void {
    this.project.loop.on = on;
    this.roll.setLoop(this.project.loop);
    this.sendLoop();
    this.refreshButtons();
    this.scheduleSave();
  }

  /** The notes to the engine again; a song playing goes on from where it is. */
  private reload(): void {
    const position = this.currentSec();
    this.client.loadTracks(this.trackSpecs());
    this.sendLoop();
    if (this.startedAt !== null) {
      this.from = position;
      this.start();
    }
  }

  /** The playing position (song seconds), or where playback would start. */
  currentSec(): number {
    const now = this.client.currentTime;
    if (this.startedAt === null || now === null) return this.from;
    let pos = this.from + Math.max(0, now - this.startedAt);
    const { loop, bpm } = this.project;
    if (loop.on) {
      const a = beatsToSec(loop.start, bpm);
      const b = beatsToSec(loop.end, bpm);
      if (this.from < b && pos >= b && b > a) pos = a + ((pos - b) % (b - a));
    }
    return pos;
  }

  private currentBeat(): number {
    return secToBeats(this.currentSec(), this.project.bpm);
  }

  toggle(): void {
    if (this.playing) {
      this.from = this.currentSec();
      this.stop();
      return;
    }
    const endSec = beatsToSec(songEnd(this.roll.notes), this.project.bpm);
    if (!this.project.loop.on && this.from >= endSec) this.from = 0;
    this.start();
  }

  private start(): void {
    this.client.setTempo(this.project.bpm);
    this.client.loadTracks(this.trackSpecs());
    this.sendLoop();
    this.startedAt = this.client.playSong(this.from);
    this.playButton.textContent = "■ 停止";
    this.onPlayingChange(true);
    cancelAnimationFrame(this.frame);
    const tick = () => {
      if (this.startedAt === null) return;
      const beat = this.currentBeat();
      if (!this.project.loop.on && beat > songEnd(this.roll.notes) + END_PAD_BEATS) {
        this.from = 0;
        this.stop();
        return;
      }
      this.roll.setPlayhead(beat, true);
      this.showPosition(beatsToSec(beat, this.project.bpm));
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  /** Stops playback (the position stays where it was). */
  stop(): void {
    cancelAnimationFrame(this.frame);
    if (this.startedAt === null) return;
    this.startedAt = null;
    this.client.stopSong();
    this.client.setTempo(this.restingBpm());
    this.playButton.textContent = "▶ 再生";
    this.roll.setPlayhead(secToBeats(this.from, this.project.bpm));
    this.showPosition(this.from);
    this.onPlayingChange(false);
  }

  // ------------------------------------------------------------- the screen

  private showPosition(sec: number): void {
    const beat = secToBeats(sec, this.project.bpm);
    const bpb = this.project.beatsPerBar;
    const bar = Math.floor(beat / bpb + 1e-9);
    this.position.textContent = `${bar + 1} 小節 ${Math.floor(beat - bar * bpb + 1e-9) + 1} 拍`;
    if (!this.playing) this.roll.setPlayhead(beat);
  }

  private refreshButtons(): void {
    const none = this.roll.selectionSize === 0;
    this.deleteButton.disabled = none;
    this.duplicateButton.disabled = none;
    for (const b of this.transposeButtons) b.disabled = none;
    this.undoButton.disabled = !this.roll.canUndo;
    this.redoButton.disabled = !this.roll.canRedo;
    const { loop } = this.project;
    const bpb = this.project.beatsPerBar;
    const onBars = loop.start % bpb === 0 && loop.end % bpb === 0;
    const range = onBars ? (loop.end - loop.start === bpb ? `${loop.end / bpb} 小節目` : `${loop.start / bpb + 1}〜${loop.end / bpb} 小節`) : `${+(loop.start + 1).toFixed(2)}〜${+loop.end.toFixed(2)} 拍目`;
    this.loopButton.textContent = `ループ: ${loop.on ? `オン(${range})` : "オフ"}`;
    this.loopButton.classList.toggle("on", loop.on);
    this.selectToggle.textContent = `範囲選択: ${this.roll.selectMode ? "オン" : "オフ"}`;
    this.clearButton.disabled = this.roll.notes.length === 0;
  }
}
