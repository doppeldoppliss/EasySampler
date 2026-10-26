// 打ち込み (design.md 13): the song. Tracks, each playing one cut of a material
// (design.md 13.1), with their own notes, effects, volume, pan, mute and solo;
// the piano roll edits the selected track. The project (tracks, the list of
// materials, tempo, loop) is kept in the browser and comes back on the next
// visit; a part of the MIDI file opened in 曲で試す can be taken over as a start.

import type { EngineClient } from "../audio/engineClient";
import { keep, kept } from "../audio/store";
import type { TrackSpec } from "../engine/messages";
import {
  beatsToSec,
  emptyProject,
  fromSongNotes,
  newDrumTrack,
  newTrack,
  removePad,
  sanitizeProject,
  secToBeats,
  shifted,
  songEnd,
  toSeqNotes,
  type Note,
  type Project,
  type ProjectMaterial,
  type Track,
} from "../daw/model";
import type { FxSettings } from "../instrument/types";
import type { SongPart } from "../song/parts";
import { el } from "./dom";
import { PianoRoll } from "./pianoRoll";

const STORE_KEY = "project";
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

/** A cut a track can play: its instrument id, how it reads in the list, and the note it is made for (marked on the keys). */
export interface InstrumentOption {
  id: string;
  label: string;
  note: number;
}

export class RollPanel {
  readonly element: HTMLElement;
  readonly roll = new PianoRoll();
  /** Playback started or stopped (the page stops its other players). */
  onPlayingChange: (playing: boolean) => void = () => {};
  /** The selected track changed, or the project was replaced: the page shows that track's effects. */
  onTrackChange: () => void = () => {};
  /** Drum rows: the page renders these cuts' one-shots (once per change of their settings) and hands them to the engine. */
  ensureSamples: (instruments: string[]) => void = () => {};

  private project: Project = emptyProject();
  private selected = 0;
  private options: InstrumentOption[] = [];
  /** The cut being edited on the sampling side: what a new track plays. */
  private editedInstrument: string | null = null;
  private readonly client: EngineClient;
  private readonly restingBpm: () => number;
  private readonly importPart: () => { part: SongPart; bpm: number; transpose: number } | null;

  private startedAt: number | null = null;
  /** Where playback starts (song seconds). */
  private from = 0;
  private frame = 0;
  private saveTimer = 0;

  private readonly trackList = el("div", { className: "track-list" });
  /** A drum track's rows: the cut each plays. */
  private readonly padList = el("div", { className: "pad-list" });
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
  private readonly clearButton = button("このトラックの音符をすべて消す", "small", () => {
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
      el("div", { className: "row" }, [el("span", { className: "control-label", textContent: "打ち込み" }), this.importButton]),
      el("div", { className: "row roll-transport" }, [
        this.playButton,
        this.loopButton,
        el("label", { className: "inline" }, ["BPM ", this.bpmInput]),
        el("label", { className: "inline" }, ["吸着 ", this.gridSelect]),
        this.position,
      ]),
      this.trackList,
      el("div", { className: "row" }, [button("＋ トラックを追加", "small", () => this.addTrack()), button("＋ ドラムトラックを追加", "small", () => this.addTrack(true))]),
      this.padList,
      el("div", { className: "row roll-tools" }, [this.undoButton, this.redoButton, this.deleteButton, this.duplicateButton, ...this.transposeButtons, this.selectToggle, button("−", "small", () => this.roll.zoom(1 / 1.5), "縮小"), button("+", "small", () => this.roll.zoom(1.5), "拡大")]),
      this.roll.element,
      el("p", {
        className: "fine help",
        textContent: COARSE
          ? "空いたところをタップで音符、音符をドラッグで移動、右端をドラッグで長さ。上の目盛りはタップで位置、2 回タップで再生、ドラッグでループ範囲。"
          : "クリックで音符、ドラッグで範囲選択、音符のドラッグで移動(Ctrl で複製・Alt で吸着なし)、右端で長さ、ダブルクリックか右クリックで削除。上の目盛りはクリックで位置、ダブルクリックで再生、ドラッグでループ範囲。Space で再生 / 停止。",
      }),
      el("div", { className: "row" }, [this.clearButton]),
      this.info,
    ]);
    this.applyProject();
  }

  get playing(): boolean {
    return this.startedAt !== null;
  }

  private get track(): Track {
    return this.project.tracks[this.selected];
  }

  // ------------------------------------------------------------- the project

  /** Reads the kept project (call once at start); the page then opens its materials. */
  async restore(): Promise<Project> {
    const stored = await kept(STORE_KEY);
    if (stored !== undefined) {
      this.project = sanitizeProject(stored);
      this.selected = 0;
      this.applyProject();
    }
    return this.project;
  }

  get materials(): readonly ProjectMaterial[] {
    return this.project.materials;
  }

  get editing(): string | null {
    return this.project.editing;
  }

  addMaterial(material: ProjectMaterial): void {
    if (!this.project.materials.some((m) => m.id === material.id)) this.project.materials.push(material);
    this.project.editing = material.id;
    this.scheduleSave();
  }

  /** A material leaves the project: tracks that played one of its cuts play nothing until another is chosen. */
  removeMaterial(id: string): void {
    this.project.materials = this.project.materials.filter((m) => m.id !== id);
    for (const t of this.project.tracks) {
      if (t.instrument?.startsWith(`${id}/`)) t.instrument = null;
      for (const p of t.pads) if (p.instrument?.startsWith(`${id}/`)) p.instrument = null;
    }
    if (this.project.editing === id) this.project.editing = this.project.materials.at(-1)?.id ?? null;
    this.renderTracks();
    this.reload();
    this.scheduleSave();
  }

  /** Whether a track plays a cut of this material. */
  usesMaterial(id: string): boolean {
    return this.project.tracks.some((t) => t.instrument?.startsWith(`${id}/`) || t.pads.some((p) => p.instrument?.startsWith(`${id}/`)));
  }

  setEditing(id: string): void {
    this.project.editing = id;
    this.scheduleSave();
  }

  /** The cuts tracks can play (all materials' cuts), and the one being edited (what a new track plays). */
  setInstruments(options: InstrumentOption[], edited: string | null): void {
    const same = JSON.stringify(options) === JSON.stringify(this.options) && edited === this.editedInstrument;
    if (same) return; // (called on every change of the cut: the list is only rebuilt when it differs)
    this.options = options;
    this.editedInstrument = edited;
    // A project of one track that plays nothing yet: it plays the cut being edited.
    const only = this.project.tracks.length === 1 ? this.project.tracks[0] : null;
    if (only && only.instrument === null && edited) {
      only.instrument = edited;
      this.scheduleSave();
    }
    // A cut that is gone (removed on the sampling side): the track plays nothing.
    for (const t of this.project.tracks) {
      if (t.instrument && !options.some((o) => o.id === t.instrument)) t.instrument = null;
      for (const p of t.pads) if (p.instrument && !options.some((o) => o.id === p.instrument)) p.instrument = null;
    }
    this.renderTracks();
    this.showRoot();
    if (this.track.kind === "drum") this.roll.setRows(this.track.pads.map((p, i) => this.padLabel(p.instrument, i)));
  }

  private applyProject(): void {
    this.selected = Math.min(this.selected, this.project.tracks.length - 1);
    this.bpmInput.value = String(this.project.bpm);
    this.roll.setBeatsPerBar(this.project.beatsPerBar);
    this.roll.setLoop(this.project.loop);
    this.showTrackInRoll();
    if (this.track.kind !== "drum") this.roll.frame(60);
    this.sendLoop();
    this.client.setMasterFx(this.project.masterFx);
    this.renderTracks();
    this.refreshButtons();
    this.showPosition(this.from);
    this.onTrackChange();
  }

  private changed(notes: Note[]): void {
    this.track.notes = notes;
    this.info.textContent = "";
    this.reload();
    this.scheduleSave();
    this.renderTracks();
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void keep(STORE_KEY, this.project), 400);
  }

  /** The part chosen in 曲で試す, as notes on the selected track (one undoable step), with its tempo. */
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
    this.info.textContent = `「${picked.part.label}」の音符 ${notes.length} 個を「${this.track.name}」に取り込みました(${this.project.bpm} BPM)。取り消しで戻せます。`;
  }

  // ------------------------------------------------------------- tracks

  /** The roll shows the selected track: keys for a melodic one, its rows for a drum track. */
  private showTrackInRoll(): void {
    const t = this.track;
    this.roll.setRows(t.kind === "drum" ? t.pads.map((p, i) => this.padLabel(p.instrument, i)) : null);
    this.roll.setNotes(t.notes);
    if (t.kind === "drum") this.roll.frame(0);
  }

  private padLabel(instrument: string | null, index: number): string {
    const label = this.options.find((o) => o.id === instrument)?.label;
    return label ? `${index + 1}. ${label}` : `${index + 1}. (なし)`;
  }

  private selectTrack(index: number): void {
    if (index === this.selected || !this.project.tracks[index]) return;
    this.selected = index;
    this.showTrackInRoll();
    this.renderTracks();
    this.showRoot();
    this.refreshButtons();
    this.onTrackChange();
  }

  private addTrack(drum = false): void {
    const name = drum ? `ドラム ${this.project.tracks.filter((x) => x.kind === "drum").length + 1}` : `トラック ${this.project.tracks.length + 1}`;
    const t = drum ? newDrumTrack(name, this.editedInstrument) : newTrack(name, this.editedInstrument);
    this.project.tracks.push(t);
    this.selected = this.project.tracks.length - 1;
    this.showTrackInRoll();
    this.reload();
    this.renderTracks();
    this.showRoot();
    this.refreshButtons();
    this.onTrackChange();
    this.scheduleSave();
  }

  private removeTrack(index: number): void {
    if (this.project.tracks.length < 2) return;
    const t = this.project.tracks[index];
    if (t.notes.length && !window.confirm(`「${t.name}」と音符 ${t.notes.length} 個を消しますか?`)) return;
    this.project.tracks.splice(index, 1);
    this.selected = Math.min(this.selected > index ? this.selected - 1 : this.selected, this.project.tracks.length - 1);
    this.showTrackInRoll();
    this.reload();
    this.renderTracks();
    this.showRoot();
    this.onTrackChange();
    this.scheduleSave();
  }

  /** Volume, pan, mute, solo of a track: heard at once, kept. */
  private mix(t: Track, change: (t: Track) => void): void {
    change(t);
    this.client.setTrackMix(t.id, { gain: t.gain, pan: t.pan, mute: t.mute, solo: t.solo, fx: t.fx });
    this.scheduleSave();
  }

  private renderTracks(): void {
    const rows = this.project.tracks.map((t, i) => {
      const selected = i === this.selected;
      const name = el("input", { type: "text", value: t.name, className: "track-name", ariaLabel: "トラックの名前", maxLength: 30 });
      name.addEventListener("focus", () => this.selectTrack(i));
      name.addEventListener("change", () => {
        t.name = name.value.trim() || `トラック ${i + 1}`;
        this.scheduleSave();
      });
      const instrument: HTMLElement = t.kind === "drum" ? el("span", { className: "fine track-drum", textContent: `ドラム(${t.pads.length} 行)` }) : el("select", { ariaLabel: "鳴らす区間" }, [
        el("option", { value: "", textContent: "(区間を選ぶ)" }),
        ...this.options.map((o) => el("option", { value: o.id, textContent: o.label })),
      ]);
      if (instrument instanceof HTMLSelectElement) {
        instrument.value = t.instrument ?? "";
        instrument.addEventListener("change", () => {
          t.instrument = instrument.value || null;
          this.reload();
          this.showRoot();
          this.scheduleSave();
        });
      }
      const mute = button("M", `small toggle${t.mute ? " on" : ""}`, () => {
        this.mix(t, (x) => (x.mute = !x.mute));
        mute.classList.toggle("on", t.mute);
      }, "ミュート");
      const solo = button("S", `small toggle${t.solo ? " on" : ""}`, () => {
        this.mix(t, (x) => (x.solo = !x.solo));
        solo.classList.toggle("on", t.solo);
      }, "ソロ");
      const volume = el("input", { type: "range", min: "0", max: "1.5", step: "0.01", value: String(t.gain), ariaLabel: "音量" });
      volume.addEventListener("input", () => this.mix(t, (x) => (x.gain = Number(volume.value))));
      volume.addEventListener("dblclick", () => {
        volume.value = "1";
        this.mix(t, (x) => (x.gain = 1));
      });
      const pan = el("input", { type: "range", min: "-1", max: "1", step: "0.05", value: String(t.pan), ariaLabel: "パン" });
      pan.addEventListener("input", () => this.mix(t, (x) => (x.pan = Number(pan.value))));
      pan.addEventListener("dblclick", () => {
        pan.value = "0";
        this.mix(t, (x) => (x.pan = 0));
      });
      const remove = button("×", "small", () => this.removeTrack(i), "このトラックを消す");
      remove.hidden = this.project.tracks.length < 2;
      const row = el("div", { className: `track-row${selected ? " selected" : ""}` }, [
        el("span", { className: "track-count fine num", textContent: `${t.notes.length}` }),
        name,
        instrument,
        mute,
        solo,
        el("label", { className: "inline fine" }, ["音量 ", volume]),
        el("label", { className: "inline fine" }, ["パン ", pan]),
        remove,
      ]);
      row.addEventListener("pointerdown", (e) => {
        if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLButtonElement)) this.selectTrack(i);
      });
      instrument.addEventListener("focus", () => this.selectTrack(i));
      return row;
    });
    this.trackList.replaceChildren(...rows);
    this.renderPads();
  }

  /** The selected drum track's rows: one per cut it plays (a row is added, its cut chosen, or removed). */
  private renderPads(): void {
    const t = this.track;
    this.padList.hidden = t.kind !== "drum";
    if (t.kind !== "drum") {
      this.padList.replaceChildren();
      return;
    }
    const rows = t.pads.map((pad, i) => {
      const select = el("select", { ariaLabel: `${i + 1} 行目の区間` }, [el("option", { value: "", textContent: "(区間を選ぶ)" }), ...this.options.map((o) => el("option", { value: o.id, textContent: o.label }))]);
      select.value = pad.instrument ?? "";
      select.addEventListener("change", () => {
        pad.instrument = select.value || null;
        this.padsChanged();
        if (pad.instrument) this.previewRow(i);
      });
      const remove = button("×", "small", () => {
        if (t.notes.some((n) => n.pitch === i) && !window.confirm(`${i + 1} 行目と、その行の音符を消しますか?`)) return;
        removePad(t, i);
        this.padsChanged();
      }, "この行を消す");
      return el("div", { className: "pad-row" }, [el("span", { className: "fine num", textContent: `${i + 1}.` }), select, button("▶", "small", () => this.previewRow(i), "この行の音を聴く"), remove]);
    });
    this.padList.replaceChildren(
      el("p", { className: "fine", textContent: "ドラムの行(上から順に)。割り当てた区間の数だけピアノロールに行ができ、各行は区間を録音どおりの高さで 1 回鳴らします。" }),
      ...rows,
      el("div", { className: "row" }, [
        button("＋ 行を追加", "small", () => {
          t.pads.push({ instrument: this.editedInstrument });
          this.padsChanged();
        }),
      ]),
    );
  }

  private padsChanged(): void {
    this.showTrackInRoll();
    this.renderTracks();
    this.reload();
    this.scheduleSave();
  }

  /** Every cut a drum row plays (for the page to keep their one-shots up to date). */
  padInstruments(): string[] {
    const set = new Set<string>();
    for (const t of this.project.tracks) if (t.kind === "drum") for (const p of t.pads) if (p.instrument) set.add(p.instrument);
    return [...set];
  }

  private previewRow(row: number): void {
    const instrument = this.track.pads[row]?.instrument;
    if (!instrument || this.playing) return;
    this.ensureSamples([instrument]);
    this.client.previewSample(instrument);
  }

  /** The keys mark the note the selected track's cut is made for. */
  private showRoot(): void {
    if (this.track.kind === "drum") return;
    const option = this.options.find((o) => o.id === this.track.instrument);
    this.roll.setRoot(option ? option.note : null);
  }

  // ------------------------------------------------------------- the selected track's effects

  /** The effects of the selected track. */
  trackFx(): FxSettings {
    return this.track.fx;
  }

  get trackName(): string {
    return this.track.name;
  }

  /** Changes the selected track's effects (heard at once, kept). */
  updateTrackFx(change: (fx: FxSettings) => void): void {
    const t = this.track;
    const fx = structuredClone(t.fx);
    change(fx);
    t.fx = fx;
    this.client.setTrackMix(t.id, { gain: t.gain, pan: t.pan, mute: t.mute, solo: t.solo, fx });
    this.scheduleSave();
  }

  /** The effects on the whole mix. */
  masterFx(): FxSettings {
    return this.project.masterFx;
  }

  updateMasterFx(change: (fx: FxSettings) => void): void {
    const fx = structuredClone(this.project.masterFx);
    change(fx);
    this.project.masterFx = fx;
    this.client.setMasterFx(fx);
    this.scheduleSave();
  }

  private trackSpecs(): TrackSpec[] {
    this.ensureSamples(this.padInstruments());
    return this.project.tracks
      .filter((t) => (t.kind === "drum" ? t.pads.length > 0 : t.instrument !== null))
      .map((t) => ({
        id: t.id,
        instrument: t.kind === "drum" ? "drum" : t.instrument!,
        samples: t.kind === "drum" ? t.pads.map((p) => p.instrument) : undefined,
        notes: toSeqNotes(t.notes, this.project.bpm),
        fx: t.fx,
        gain: t.gain,
        pan: t.pan,
        mute: t.mute,
        solo: t.solo,
      }));
  }

  // ------------------------------------------------------------- playback

  private preview(pitch: number): void {
    if (this.playing) return;
    if (this.track.kind === "drum") {
      this.previewRow(pitch);
      return;
    }
    if (this.track.instrument) this.client.previewNote(this.track.instrument, pitch);
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

  /** The tracks to the engine again; a song playing goes on from where it is. */
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

  private lastBeat(): number {
    return Math.max(0, ...this.project.tracks.map((t) => songEnd(t.notes)));
  }

  toggle(): void {
    if (this.playing) {
      this.from = this.currentSec();
      this.stop();
      return;
    }
    const endSec = beatsToSec(this.lastBeat(), this.project.bpm);
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
      if (!this.project.loop.on && beat > this.lastBeat() + END_PAD_BEATS) {
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
