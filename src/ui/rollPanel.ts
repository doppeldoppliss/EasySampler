// 打ち込み (design.md 13): the song. Tracks, each playing one cut of a material
// (design.md 13.1), with their own notes, effects, volume, pan, mute and solo;
// the piano roll edits the selected track. The project (tracks, the list of
// materials, tempo, loop) is kept in the browser and comes back on the next
// visit. A MIDI file opens here too: each of its parts becomes a track (on the
// plain backing synth until a cut is chosen), so the song is heard at once.

import type { EngineClient } from "../audio/engineClient";
import { keep, kept } from "../audio/store";
import type { TrackSpec } from "../engine/messages";
import {
  autoToSec,
  BACKING,
  beatsToSec,
  DEFAULT_VELOCITY,
  emptyProject,
  fromSongNotes,
  newDrumTrack,
  newTrack,
  sanitizeProject,
  secToBeats,
  setTempoList,
  songEnd,
  tempoAt,
  tempoMapSec,
  type TempoChange,
  toSeqNotes,
  type Note,
  type Project,
  type ProjectMaterial,
  type Track,
  VOLUME_AUTO_MAX,
  type BeatPoint,
} from "../daw/model";
import type { MixSettings } from "../song/player";
import type { FxSettings } from "../instrument/types";
import { MidiParseError, parseMidi } from "../song/midi";
import { songParts } from "../song/parts";
import { drumRows, keyLabel, slotFor, type Kit } from "../daw/kit";
import { arrange, type ArrangeKind } from "../daw/arrange";
import { el } from "./dom";
import { PianoRoll } from "./pianoRoll";

/** Where the song is kept until the page says which project is open (useStore). */
const DEFAULT_STORE_KEY = "project";

function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // (private mode: not kept)
  }
}
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

/** Lengths offered for new notes (beats). */
const NOTE_LENGTHS: [number, string][] = [
  [0.125, "1/8 拍(32 分)"],
  [0.25, "1/4 拍(16 分)"],
  [1 / 3, "1/3 拍(3 連)"],
  [0.5, "1/2 拍(8 分)"],
  [1, "1 拍(4 分)"],
  [2, "2 拍(2 分)"],
  [4, "4 拍(全音符)"],
];
const ONION_KEY = "easysampler.roll.onion";

/**
 * 一括変更: "240"-style input after Domino, in this app's units. A plain
 * number sets the value, "*2" multiplies, "+0.5" / "-10" adds. Empty = no change.
 */
export function applyExpression(text: string, current: number): number | null {
  const t = text.normalize("NFKC").trim().replace(/[＊×]/g, "*").replace(/[＋]/g, "+").replace(/[－−ー]/g, "-").replace(/[／÷]/g, "/");
  if (!t) return null;
  const m = /^([*/+-]?)\s*(\d+(?:\.\d+)?|\.\d+)$/.exec(t);
  if (!m) return Number.NaN;
  const v = Number(m[2]);
  switch (m[1]) {
    case "*":
      return current * v;
    case "/":
      return v === 0 ? Number.NaN : current / v;
    case "+":
      return current + v;
    case "-":
      return current - v;
    default:
      return v;
  }
}

/** Portamento times offered (seconds; 0 = off). */
const GLIDES: [number, string][] = [
  [0, "オフ"],
  [0.03, "とても速く(0.03 秒)"],
  [0.08, "速く(0.08 秒)"],
  [0.15, "ふつう(0.15 秒)"],
  [0.3, "ゆっくり(0.3 秒)"],
  [0.6, "とてもゆっくり(0.6 秒)"],
];

/** A cut a track can play: its instrument id, how it reads in the list, and the note it is made for (marked on the keys). */
export interface InstrumentOption {
  id: string;
  label: string;
  note: number;
}

export class RollPanel {
  readonly element: HTMLElement;
  /** A line about the song (tracks, notes, playing), for the 曲 tab. */
  readonly summaryInfo = el("span", { className: "fine view-tab-info" });
  /** Whether the 曲 view is on screen (step input takes keys only then). */
  private visible = true;
  /** The page shows or hides the 曲 view. */
  setVisible(on: boolean): void {
    this.visible = on;
    if (on) this.roll.draw();
    else {
      this.setStepMode(false);
      this.closeMenu();
    }
  }
  readonly roll = new PianoRoll();
  /** Playback started or stopped (the page stops its other players). */
  onPlayingChange: (playing: boolean) => void = () => {};
  /** The selected track changed, or the project was replaced: the page shows that track's effects. */
  onTrackChange: () => void = () => {};
  /** A drum row's name tapped (or a drum note placed): one hit of the kit's key. */
  onKitHit: (key: number) => void = () => {};
  /** The kit changed (a sound added, cut, removed): the page rebuilds what the engine plays. */
  onKitChange: () => void = () => {};
  /** What the keyboard plays in the 曲 view changed (another track, its cut or its effects). */
  onLiveChange: () => void = () => {};
  /** A track's FX mark: the page shows (and opens) the effects. */
  onOpenFx: () => void = () => {};
  /** 「ドラムキットを開く」: the page shows the kit view. */
  onOpenKit: () => void = () => {};
  /** A drum track's rows as the roll shows them: the GM key of each (top to bottom). */
  private rowKeys: number[] = [];
  /** 書き出し: the whole song as a WAV, each track as its own WAV (zip), or the notes as MIDI. */
  onExport: (kind: "wav" | "stems" | "mid") => void = () => {};
  readonly exportStatus = el("p", { className: "fine", role: "status" });

  private project: Project = emptyProject();
  private storeKey = DEFAULT_STORE_KEY;
  /** The song was written to the store (the page notes the project's time). */
  onSaved: () => void = () => {};

  /** The key the open project's song is kept under (set before restore()). */
  useStore(key: string): void {
    this.storeKey = key;
  }

  /** A save waiting for its moment goes out now. */
  async flush(): Promise<void> {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    if (await keep(this.storeKey, this.project)) this.onSaved();
  }
  private selected = 0;
  private options: InstrumentOption[] = [];
  /** The cut being edited on the sampling side: what a new track plays. */
  private editedInstrument: string | null = null;
  private readonly client: EngineClient;
  private readonly restingBpm: () => number;

  private startedAt: number | null = null;
  /** Where playback starts (song seconds). */
  private from = 0;
  private frame = 0;
  private saveTimer = 0;

  private readonly trackList = el("div", { className: "track-list" });
  /** A drum track: where its rows come from (the kit), and the way to it. */
  private readonly padList = el("div", { className: "pad-list" });
  private readonly playButton = button("▶ 再生", "big", () => this.toggle());
  private readonly loopButton = button("", "small", () => this.setLoopOn(!this.project.loop.on));
  /** Whole stretches on every track (the loop range): a blank before it, deleted, or played twice. */
  private readonly arrangeLabel = el("span", { className: "fine" });
  private readonly insertButton = button("前に空白を挿入", "small", () => this.arrange("insert"), "ループ範囲と同じ長さの空白を、範囲の始まりに入れます(全トラック。後ろはずれます)");
  private readonly removeRangeButton = button("削除して詰める", "small", () => this.arrange("delete"), "ループ範囲を全トラックから消し、後ろを詰めます");
  private readonly duplicateRangeButton = button("複製(後ろに続ける)", "small", () => this.arrange("duplicate"), "ループ範囲を全トラックで、範囲のすぐ後ろにもう一度入れます。ループ範囲は複製した側へ移ります(続けて押すと、さらに後ろへ)");
  private readonly arrangeUndoButton = button("小節の操作を取り消す", "small", () => this.undoArrange(), "直前の挿入・削除・複製の前に戻します(そのあと音符を編集すると戻せなくなります)");
  /** The song before the last stretch operation (until a note is edited again). */
  private arrangeUndo: string | null = null;
  private readonly bpmInput = el("input", { type: "number", min: "20", max: "400", step: "1", inputMode: "decimal", ariaLabel: "BPM" });
  private readonly gridSelect = el("select", { ariaLabel: "吸着" }, GRIDS.map(([v, label]) => el("option", { value: String(v), textContent: label })));
  private readonly selectToggle = button("", "small", () => {
    this.roll.selectMode = !this.roll.selectMode;
    this.refreshButtons();
  });
  private readonly undoButton = button("元に戻す", "small", () => this.roll.undo(), "Ctrl+Z");
  private readonly redoButton = button("やり直す", "small", () => this.roll.redo(), "Ctrl+Y");
  private readonly deleteButton = button("削除", "small", () => this.roll.deleteSelected());
  private readonly duplicateButton = button("複製", "small", () => this.roll.duplicateSelected(), "選んだ音符の直後にコピーを置きます(Ctrl+D)");
  private readonly transposeButtons = [
    button("−12", "small", () => this.roll.transposeSelected(-12), "選んだ音符を 1 オクターブ下げる(Shift+↓)"),
    button("−1", "small", () => this.roll.transposeSelected(-1), "半音下げる(↓)"),
    button("+1", "small", () => this.roll.transposeSelected(1), "半音上げる(↑)"),
    button("+12", "small", () => this.roll.transposeSelected(12), "1 オクターブ上げる(Shift+↑)"),
  ];
  private readonly midiInput = el("input", { type: "file", accept: ".mid,.midi,.smf,audio/midi,audio/x-midi", className: "visually-hidden" });
  private readonly midiButton = button("MIDI を開く", "small", () => this.midiInput.click(), "MIDI ファイルのパートを、それぞれトラックとして加えます");
  private readonly clearButton = button("このトラックの音符をすべて消す", "small", () => {
    if (!this.roll.notes.length) return;
    this.roll.setNotes([], true);
    this.changed(this.roll.notes);
    this.info.textContent = "すべて消しました。「元に戻す」で戻せます。";
  });
  private readonly quantizeButton = button("クオンタイズ", "small", () => this.quantize(), "選んだ音符(選んでいなければ全部)の始まりと終わりを吸着の線に合わせます");
  /** What the lane under the roll shows: nothing, the velocities, or a line (automation). */
  private readonly laneSelect = el("select", { ariaLabel: "ピアノロールの下の欄", title: "ピアノロールの下に出す欄。強弱 = 音符ごとのベロシティ。音量・パン・マスター音量 = 曲の進みに合わせて動かす線(オートメーション)" }, [
    el("option", { value: "none", textContent: "下の欄: なし" }),
    el("option", { value: "velocity", textContent: "強弱" }),
    el("option", { value: "volume", textContent: "音量の線" }),
    el("option", { value: "pan", textContent: "パンの線" }),
    el("option", { value: "master", textContent: "マスター音量の線" }),
  ]);
  private readonly glideSelect = el("select", { ariaLabel: "ポルタメント" }, GLIDES.map(([v, label]) => el("option", { value: String(v), textContent: label })));
  private readonly glideRow = el("div", { className: "track-options" }, [
    el("div", { className: "row" }, [
      el("label", { className: "inline" }, ["ポルタメント ", this.glideSelect]),
      el("span", { className: "fine", textContent: "つながった(重なった)音符を、前の高さから滑らせてつなぎます。このトラックは単音になります。" }),
    ]),
  ]);
  // Step input: notes played on the keyboard go in at the position, which then moves on by one grid step.
  private stepMode = false;
  private readonly stepHeld = new Set<number>();
  private stepChordStart = 0;
  private readonly stepHistory: { start: number; pitch: number }[] = [];
  private readonly stepToggle = button("", "small toggle", () => this.setStepMode(!this.stepMode), "鍵盤で弾いた音が、再生位置に音符として入ります");
  /** The last chord put in by step input (for タイ). */
  private stepLastChord: { start: number; pitches: number[] } | null = null;
  private readonly stepRestButton = button("休符", "small", () => this.stepRest(), "音符を入れずに 1 つ進めます");
  private readonly stepBackButton = button("1 つ戻す", "small", () => this.stepBack(), "最後に入れた音符を消して、位置を戻します");
  private readonly stepHelp = el("span", { className: "fine", textContent: "画面の鍵盤か PC キーボードで弾くと、再生位置に音符が入り、吸着の幅だけ進みます。和音は同時に押します。" });
  private readonly lengthSelect = el("select", { ariaLabel: "置く音符の長さ" });
  private readonly velocityInput = el("input", { type: "number", min: "1", max: "127", step: "1", inputMode: "numeric", ariaLabel: "置く音符の強さ", className: "velocity-input" });
  private readonly copyButton = button("コピー", "small", () => this.roll.copy(), "選んだ音符をコピー(Ctrl+C)");
  private readonly pasteButton = button("貼り付け", "small", () => this.roll.paste(), "コピーした音符を再生位置に貼り付け(Ctrl+V)");
  private readonly selectAllButton = button("すべて選択", "small", () => this.roll.selectAll(), "Ctrl+A");
  private readonly nudgeButtons = [
    button("◀", "small", () => this.roll.nudgeSelected(-(this.roll.grid || 0.25)), "選んだ音符を吸着の幅だけ前へ(←)"),
    button("▶", "small", () => this.roll.nudgeSelected(this.roll.grid || 0.25), "選んだ音符を吸着の幅だけ後ろへ(→)"),
  ];
  private readonly sliceButton = button("スライス", "small", () => this.slice(), "再生位置で、選んだ音符(選んでいなければ全部)を 2 つに分けます");
  private onion = remembered(ONION_KEY) === "on";
  private readonly onionToggle = button("他のトラックを表示", "small toggle", () => {
    this.onion = !this.onion;
    remember(ONION_KEY, this.onion ? "on" : "off");
    this.refreshGhosts();
    this.refreshButtons();
  }, "ほかのトラックの音符を薄く表示します(オニオンスキン)");
  private readonly stepTieButton = button("タイ", "small", () => this.stepTie(), "最後に入れた音符を 1 つぶん伸ばします");
  /** The menu (a right-click or a long press on the roll), while open. */
  private menu: HTMLElement | null = null;
  /** Each track's undo history while another is shown (with the drum rows it was made on). */
  private readonly histories = new Map<string, { undo: string[]; redo: string[]; rows: string }>();
  private shownTrack: string | null = null;
  /** Export only the loop range (WAV / stems), seamless. */
  private readonly loopOnlyBox = el("input", { type: "checkbox", ariaLabel: "ループ範囲だけ書き出す" });
  private readonly position = el("span", { className: "fine num" });
  /** The tempo changes after the start: each its bar and beat, its tempo, and ×. */
  private readonly tempoList = el("div", { className: "row tempo-list" });
  /** The seek bar: the song from its start to a little past its last note (or the loop's end), in beats. */
  private readonly seekBar = el("input", { type: "range", min: "0", max: "16", step: "any", value: "0", className: "song-seek", ariaLabel: "再生位置" });
  private seeking = false;
  private seekTimer = 0;
  private readonly info = el("p", { className: "fine", role: "status" });

  constructor(client: EngineClient, restingBpm: () => number) {
    this.client = client;
    this.restingBpm = restingBpm;
    this.midiInput.addEventListener("change", () => {
      const file = this.midiInput.files?.[0];
      this.midiInput.value = "";
      if (file) void this.openMidi(file);
    });

    this.roll.onChange = (notes) => this.changed(notes);
    this.roll.onMenu = (x, y, note) => this.openMenu(x, y, note);
    this.roll.onDefaultsChange = () => {
      this.track.noteLength = this.roll.lastLength;
      this.track.noteVelocity = this.roll.defaultVelocity;
      this.showDefaults();
      this.scheduleSave();
    };
    this.roll.onTrackStep = (delta) => this.selectTrack(Math.max(0, Math.min(this.project.tracks.length - 1, this.selected + delta)));
    this.lengthSelect.addEventListener("change", () => {
      this.roll.lastLength = Number(this.lengthSelect.value);
      this.roll.onDefaultsChange();
    });
    this.velocityInput.addEventListener("change", () => {
      const v = Math.max(1, Math.min(127, Math.round(Number(this.velocityInput.value) || 100)));
      this.roll.defaultVelocity = v / 127;
      this.roll.onDefaultsChange();
    });
    this.roll.onStateChange = () => this.refreshButtons();
    this.roll.onPreview = (pitch) => this.preview(pitch);
    this.roll.onTogglePlay = () => this.toggle();
    this.roll.onSeek = (beat, play) => {
      this.from = beatsToSec(beat, this.project);
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
      this.setTempos([{ beat: 0, bpm }, ...this.project.tempos]);
    });
    this.laneSelect.addEventListener("change", () => this.showLane());
    this.roll.onLineChange = (points) => this.lineChanged(points);
    this.gridSelect.value = String(this.roll.grid);
    this.gridSelect.addEventListener("change", () => {
      this.roll.grid = Number(this.gridSelect.value);
      this.roll.draw();
    });
    this.selectToggle.hidden = !COARSE;
    this.glideSelect.addEventListener("change", () => {
      const t = this.track;
      t.glide = Number(this.glideSelect.value) || 0;
      this.reload();
      this.scheduleSave();
    });

    this.element = el("section", { className: "panel roll-panel" }, [
      el("div", { className: "row" }, [el("span", { className: "control-label", textContent: "打ち込み" })]),
      el("div", { className: "row" }, [this.midiButton, this.midiInput]),
      el("div", { className: "row roll-transport" }, [
        this.playButton,
        this.loopButton,
        el("label", { className: "inline" }, ["BPM ", this.bpmInput]),
        el("label", { className: "inline" }, ["吸着 ", this.gridSelect]),
        this.position,
      ]),
      el("div", { className: "row song-seek-row" }, [this.seekBar]),
      this.tempoList,
      this.trackList,
      el("div", { className: "row" }, [button("＋ トラックを追加", "small", () => this.addTrack()), button("＋ ドラムトラックを追加", "small", () => this.addTrack(true))]),
      this.padList,
      this.glideRow,
      el("div", { className: "row roll-defaults" }, [
        el("span", { className: "fine", textContent: "置く音符:" }),
        el("label", { className: "inline" }, ["長さ ", this.lengthSelect]),
        el("label", { className: "inline" }, ["強さ ", this.velocityInput]),
        el("span", { className: "fine", textContent: "(音符を右クリック / 長押しで、その音符の値を拾えます)" }),
      ]),
      el("div", { className: "row roll-tools" }, [this.undoButton, this.redoButton, this.selectAllButton, this.copyButton, this.pasteButton, this.deleteButton, this.duplicateButton, ...this.nudgeButtons, ...this.transposeButtons, this.quantizeButton, this.sliceButton]),
      el("div", { className: "row roll-tools" }, [this.laneSelect, this.onionToggle, this.selectToggle, button("−", "small", () => this.roll.zoom(1 / 1.5), "縮小"), button("+", "small", () => this.roll.zoom(1.5), "拡大")]),
      el("div", { className: "row roll-tools arrange-row" }, [this.arrangeLabel, this.insertButton, this.removeRangeButton, this.duplicateRangeButton, this.arrangeUndoButton]),
      el("div", { className: "row step-input" }, [this.stepToggle, this.stepRestButton, this.stepTieButton, this.stepBackButton, this.stepHelp]),
      this.roll.element,
      el("p", {
        className: "fine help",
        textContent: COARSE
          ? "空いたところをタップで音符、音符をドラッグで移動、右端をドラッグで長さ、長押しでメニュー(コピー・貼り付け・一括変更など)。上の目盛りはタップで位置、2 回タップで再生、ドラッグでループ範囲。空いたところを指でドラッグするか、右端・下端のバーでスクロール。"
          : "クリックで音符、ドラッグで範囲選択(Shift で追加)、音符のドラッグで移動(Ctrl を押してから始めると複製、ドラッグ中の Ctrl か Alt で吸着なし、ドラッグ中の右クリックでやめる)、右端で長さ、ダブルクリックで削除、右クリックでメニュー(音符の上ならその長さと強さを拾うスポイト)。上の目盛りはクリックで位置、ダブルクリックで再生、ドラッグでループ範囲。スクロールは右端・下端のバー、ホイール(Shift で左右)、ホイールを押し込んでドラッグ。Space で再生 / 停止、Ctrl+PageUp / PageDown でトラック切り替え。",
      }),
      el("div", { className: "row" }, [this.clearButton]),
      this.info,
      el("div", { className: "row song-export" }, [
        el("span", { className: "control-label", textContent: "曲の書き出し" }),
        button("曲を WAV で", "small primary", () => this.onExport("wav"), "全トラックをミックスし、マスターのエフェクトをかけた 1 本の WAV"),
        button("トラック別の WAV(zip)", "small", () => this.onExport("stems"), "トラックごとに 1 本ずつ(各トラックのエフェクト込み、マスターなし)"),
        button("MIDI(.mid)", "small", () => this.onExport("mid"), "音符だけを MIDI ファイルに(別の DAW へ持っていく用)"),
        el("label", { className: "inline fine", title: "ループ範囲だけを、つなぎ目なくループできる長さで書き出します(WAV・トラック別)" }, [this.loopOnlyBox, " ループ範囲だけ"]),
      ]),
      this.exportStatus,
    ]);
    // The seek bar moves the position (and the roll's playhead, scrolling to it); while playing, the song jumps there.
    this.seekBar.addEventListener("input", () => {
      this.seeking = true;
      const beat = Number(this.seekBar.value);
      this.from = beatsToSec(beat, this.project);
      this.roll.setPlayhead(beat, true);
      this.showPosition(this.from);
      if (this.playing) {
        clearTimeout(this.seekTimer);
        this.seekTimer = window.setTimeout(() => this.start(), 120);
      }
    });
    this.seekBar.addEventListener("change", () => {
      this.seeking = false;
      clearTimeout(this.seekTimer);
      if (this.playing) this.start();
    });
    this.applyProject();
  }

  /** The song's tempo (the sampling side can take it for its export length). */
  /** The keyboard in the 曲 view: the selected track — its cut (or the kit, for a drum track) and its effects. */
  liveTarget(): { instrument: string | null; drum: boolean; fx: FxSettings } {
    const t = this.track;
    const own = t.kind !== "drum" && t.instrument && t.instrument !== BACKING ? t.instrument : null;
    return { instrument: own, drum: t.kind === "drum", fx: t.fx };
  }

  get bpm(): number {
    return this.project.bpm;
  }

  get playing(): boolean {
    return this.startedAt !== null;
  }

  /** The loop range to export alone (beats), when 「ループ範囲だけ」 is ticked and the loop is on. */
  get exportRange(): { start: number; end: number } | null {
    const { loop } = this.project;
    return this.loopOnlyBox.checked && loop.on && loop.end > loop.start ? { start: loop.start, end: loop.end } : null;
  }

  /** The names of the tracks that play a cut (to warn before the cut goes). */
  tracksUsing(instrument: string): string[] {
    return this.project.tracks.filter((t) => t.instrument === instrument).map((t) => t.name);
  }

  /** The song as it is now (a copy), for the export. */
  snapshot(): Project {
    return structuredClone(this.project);
  }

  private get track(): Track {
    return this.project.tracks[this.selected];
  }

  // ------------------------------------------------------------- the project

  /** Reads the kept project (call once at start); the page then opens its materials. */
  async restore(): Promise<Project> {
    const stored = await kept(this.storeKey);
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
    }
    if (this.project.editing === id) this.project.editing = this.project.materials.at(-1)?.id ?? null;
    this.renderTracks();
    this.reload();
    this.scheduleSave();
  }

  /** Whether a track plays a cut of this material. */
  usesMaterial(id: string): boolean {
    return this.project.tracks.some((t) => t.instrument?.startsWith(`${id}/`));
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
      if (t.instrument && t.instrument !== BACKING && !options.some((o) => o.id === t.instrument)) t.instrument = null;
    }
    this.renderTracks();
    this.showRoot();
    if (this.track.kind === "drum") this.roll.setRows(this.rowKeys.map((k) => keyLabel(this.project.kit, k)));
  }

  private applyProject(): void {
    this.selected = Math.min(this.selected, this.project.tracks.length - 1);
    this.bpmInput.value = String(this.project.bpm);
    this.renderTempos();
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
    this.arrangeUndo = null;
    this.track.notes = this.track.kind === "drum" ? notes.map((n) => ({ ...n, pitch: this.rowKeys[n.pitch] ?? n.pitch })) : notes;
    this.closeMenu();
    this.info.textContent = "";
    this.reload();
    this.scheduleSave();
    this.renderTracks();
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = 0;
      void keep(this.storeKey, this.project).then((ok) => ok && this.onSaved());
    }, 400);
  }

  /**
   * A MIDI file into the song: each part becomes a track (a drum channel a
   * drum track, one row per drum sound), on the plain backing synth so the
   * whole song is heard at once; the busiest melodic part plays the cut being
   * edited. The tracks are added to the song (empty ones go), and the tempo
   * becomes the file's (its first; the notes keep their beats).
   */
  async openMidi(file: File): Promise<void> {
    let song;
    try {
      song = parseMidi(new Uint8Array(await file.arrayBuffer()));
    } catch (error) {
      this.info.textContent = `MIDI を読めませんでした: ${error instanceof MidiParseError ? error.message : String(error)}`;
      return;
    }
    const parts = songParts(song).filter((p) => p.drumPitch === null && (p.duplicateOf === null || p.shiftSec !== 0));
    if (!parts.length) {
      this.info.textContent = `${file.name}: 音符のある MIDI トラックがありません。`;
      return;
    }
    this.stop();
    const melodic = parts.filter((p) => !p.drum);
    const lead = melodic.length ? melodic.reduce((x, y) => (y.notes.length > x.notes.length ? y : x)) : null;
    const added: Track[] = [];
    let leadTrack: Track | null = null;
    for (const part of parts) {
      // "#3 Drums ドラム全部(8 音)" → "Drums": the file's own track name, without the list's numbering and notes.
      const name = part.label.split("(")[0].replace(/^#\d+\s*/, "").replace(/\s*ドラム全部$/, "").trim();
      if (part.drum) {
        // The notes stay on their GM keys: the kit plays them (its own sounds, or the plain drum sounds).
        const t = newDrumTrack(name || "ドラム");
        t.notes = fromSongNotes(part.notes);
        added.push(t);
        continue;
      }
      const t = newTrack(name || `パート ${added.length + 1}`, part === lead && this.editedInstrument ? this.editedInstrument : BACKING);
      t.notes = fromSongNotes(part.notes);
      if (part === lead) leadTrack = t;
      added.push(t);
    }
    this.project.tracks = [...this.project.tracks.filter((t) => t.notes.length > 0), ...added];
    setTempoList(this.project, [{ beat: 0, bpm: Math.round(song.bpm * 10) / 10 }, ...song.tempos.map((c) => ({ beat: c.beat, bpm: Math.round(c.bpm * 10) / 10 }))]);
    this.bpmInput.value = String(this.project.bpm);
    this.renderTempos();
    this.from = 0;
    this.selected = this.project.tracks.indexOf(leadTrack ?? added[0]);
    this.showTrackInRoll();
    if (this.track.kind !== "drum") this.roll.frame(60);
    this.reload();
    this.renderTracks();
    this.showRoot();
    this.refreshButtons();
    this.onTrackChange();
    this.scheduleSave();
    const tempo = this.project.tempos.length ? `、途中のテンポ変更 ${this.project.tempos.length} か所` : "";
    this.info.textContent = `「${file.name}」のパート ${added.length} 本をトラックにしました(${this.project.bpm} BPM${tempo})。${leadTrack && this.editedInstrument ? `いちばん音符の多い「${leadTrack.name}」は編集中の区間で、` : ""}ほかは簡易シンセで鳴ります。素材で鳴らすには、トラックの区間を選び直してください。`;
  }

  // ------------------------------------------------------------- tracks

  /** The roll shows the selected track: keys for a melodic one, its rows for a drum track. */
  private showTrackInRoll(): void {
    const t = this.track;
    // The track being left keeps its undo history (unless it is the same track shown again).
    if (this.shownTrack && this.shownTrack !== t.id) {
      this.histories.set(this.shownTrack, { ...this.roll.takeHistory(), rows: this.rowKeys.join() });
    }
    this.glideRow.hidden = t.kind === "drum";
    this.glideSelect.value = String(GLIDES.some(([v]) => v === t.glide) ? t.glide : 0);
    this.stepHeld.clear();
    this.stepHistory.length = 0;
    this.stepLastChord = null;
    this.roll.lastLength = t.noteLength;
    this.roll.defaultVelocity = t.noteVelocity;
    this.showDefaults();
    this.refreshGhosts();
    if (t.kind === "drum") {
      // The roll works in rows; the song keeps GM keys (changed() maps them back).
      this.rowKeys = drumRows(this.project.kit, t.notes);
      this.roll.setRows(this.rowKeys.map((k) => keyLabel(this.project.kit, k)));
      this.roll.pitchToKey = (row) => this.rowKeys[row] ?? row;
      this.roll.keyToPitch = (key) => {
        const row = this.rowKeys.indexOf(key);
        return row < 0 ? null : row;
      };
      this.roll.setNotes(t.notes.map((n) => ({ ...n, pitch: this.rowKeys.indexOf(n.pitch) })));
    } else {
      this.roll.pitchToKey = null;
      this.roll.keyToPitch = null;
      this.roll.setRows(null);
      this.roll.setNotes(t.notes);
    }
    // Back on a track: its history comes back (for a drum track, only if its rows are the same).
    if (this.shownTrack !== t.id) {
      const kept = this.histories.get(t.id);
      if (kept && (t.kind !== "drum" || kept.rows === this.rowKeys.join())) this.roll.giveHistory(kept);
      this.histories.delete(t.id);
      this.shownTrack = t.id;
    }
    if (t.kind === "drum") this.roll.frame(0);
    this.showLane();
  }

  /** The lane under the roll, as chosen: the velocities, or the selected track's (or the master's) line. */
  private showLane(): void {
    const mode = this.laneSelect.value;
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const pan = (v: number) => (Math.abs(v) < 0.005 ? "中央" : `${v < 0 ? "左" : "右"} ${Math.round(Math.abs(v) * 100)}`);
    if (mode === "volume") this.roll.setLine({ label: "音量", points: this.track.volumeAuto, min: 0, max: VOLUME_AUTO_MAX, guide: 1, format: pct });
    else if (mode === "pan") this.roll.setLine({ label: "パン", points: this.track.panAuto, min: -1, max: 1, guide: 0, format: pan });
    else if (mode === "master") this.roll.setLine({ label: "マスター", points: this.project.masterAuto, min: 0, max: VOLUME_AUTO_MAX, guide: 1, format: pct });
    else {
      this.roll.setLine(null);
      this.roll.showVelocity = mode === "velocity";
    }
  }

  /** A line in the lane was edited: kept, and heard at once. */
  private lineChanged(points: BeatPoint[]): void {
    const mode = this.laneSelect.value;
    if (mode === "master") {
      this.project.masterAuto = points;
      this.sendMasterAuto();
    } else if (mode === "volume" || mode === "pan") {
      const t = this.track;
      if (mode === "volume") t.volumeAuto = points;
      else t.panAuto = points;
      this.client.setTrackMix(t.id, this.mixOf(t));
    }
    this.scheduleSave();
  }

  /** What the mixer gets for a track: volume, pan, mute, solo, effects and its lines (in seconds). */
  private mixOf(t: Track, fx: FxSettings = t.fx): MixSettings {
    const tempo = this.project;
    return { gain: t.gain, pan: t.pan, mute: t.mute, solo: t.solo, fx, volumeAuto: autoToSec(t.volumeAuto, tempo), panAuto: autoToSec(t.panAuto, tempo) };
  }

  private sendMasterAuto(): void {
    this.client.setMasterAuto(autoToSec(this.project.masterAuto, this.project));
    this.client.setTempoMap(tempoMapSec(this.project));
  }

  /** The tempo changes: the list under the seek bar and the marks on the ruler. */
  private renderTempos(): void {
    const bpb = this.project.beatsPerBar;
    const where = (beat: number) => {
      const bar = Math.floor(beat / bpb + 1e-9);
      const inBar = +(beat - bar * bpb + 1).toFixed(2);
      return inBar === 1 ? `${bar + 1} 小節` : `${bar + 1} 小節 ${inBar} 拍`;
    };
    const items = this.project.tempos.map((c, i) => {
      const input = el("input", { type: "number", min: "20", max: "400", step: "1", inputMode: "decimal", value: String(c.bpm), ariaLabel: `${where(c.beat)}からの BPM`, className: "tempo-bpm" });
      input.addEventListener("change", () => {
        const list = this.project.tempos.map((x) => ({ ...x }));
        list[i].bpm = Number(input.value) || c.bpm;
        this.setTempos([{ beat: 0, bpm: this.project.bpm }, ...list]);
      });
      return el("span", { className: "tempo-item" }, [
        el("span", { className: "fine", textContent: `${where(c.beat)}〜 ` }),
        input,
        button("×", "small", () => this.setTempos([{ beat: 0, bpm: this.project.bpm }, ...this.project.tempos.filter((_, j) => j !== i)]), "このテンポ変更を消す"),
      ]);
    });
    this.tempoList.replaceChildren(
      el("span", { className: "fine", textContent: this.project.tempos.length ? "テンポ変更:" : "途中のテンポ変更なし" }),
      ...items,
      button("＋ 再生位置の小節からテンポを変える", "small", () => this.addTempo(), "再生位置のある小節の頭から、別のテンポにします(曲の頭のテンポは BPM 欄)"),
    );
    this.roll.setTempoMarks(this.project.tempos);
  }

  private addTempo(): void {
    const bpb = this.project.beatsPerBar;
    const beat = Math.floor(this.currentBeat() / bpb + 1e-9) * bpb;
    if (beat <= 0) {
      this.info.textContent = "曲の頭のテンポは BPM 欄で変えます。テンポを変えたい小節へ再生位置を動かしてから押してください(目盛りをタップ)。";
      return;
    }
    if (this.project.tempos.some((c) => Math.abs(c.beat - beat) < 1e-9)) {
      this.info.textContent = "この小節にはもうテンポ変更があります。数字を書き換えてください。";
      return;
    }
    this.setTempos([{ beat: 0, bpm: this.project.bpm }, ...this.project.tempos, { beat, bpm: tempoAt(beat, this.project) + 10 }]);
  }

  /** A new tempo list (the start's first): the playing position stays on its beat. */
  private setTempos(list: TempoChange[]): void {
    const position = this.currentBeat();
    setTempoList(this.project, list);
    this.bpmInput.value = String(this.project.bpm);
    this.from = beatsToSec(position, this.project);
    this.renderTempos();
    this.reload();
    this.showPosition(this.from);
    this.scheduleSave();
  }

  /** Inserts, deletes or duplicates the loop range on every track (notes and lines). */
  private arrange(kind: ArrangeKind): void {
    const { start, end } = this.project.loop;
    if (kind === "delete" && !window.confirm(`${this.rangeText()}を全トラックから削除して、後ろを詰めますか?(「小節の操作を取り消す」で戻せます)`)) return;
    const before = JSON.stringify({ tracks: this.project.tracks.map((t) => ({ id: t.id, notes: t.notes, volumeAuto: t.volumeAuto, panAuto: t.panAuto })), masterAuto: this.project.masterAuto, loop: this.project.loop, bpm: this.project.bpm, tempos: this.project.tempos });
    arrange(this.project, kind, start, end);
    this.afterArrange();
    this.arrangeUndo = before;
    this.refreshButtons();
    this.info.textContent = kind === "insert" ? "空白を入れました。" : kind === "delete" ? "削除して詰めました。" : "複製しました(ループ範囲は複製した側へ移りました)。";
  }

  private undoArrange(): void {
    if (!this.arrangeUndo) return;
    const before = JSON.parse(this.arrangeUndo) as { tracks: Pick<Track, "id" | "notes" | "volumeAuto" | "panAuto">[]; masterAuto: BeatPoint[]; loop: Project["loop"]; bpm: number; tempos: TempoChange[] };
    for (const t of this.project.tracks) {
      const was = before.tracks.find((b) => b.id === t.id);
      if (!was) continue;
      t.notes = was.notes;
      t.volumeAuto = was.volumeAuto;
      t.panAuto = was.panAuto;
    }
    this.project.masterAuto = before.masterAuto;
    this.project.loop = before.loop;
    this.project.bpm = before.bpm;
    this.project.tempos = before.tempos;
    this.afterArrange();
    this.arrangeUndo = null;
    this.refreshButtons();
    this.info.textContent = "小節の操作を取り消しました。";
  }

  /** Every track changed at once: the roll shows the track afresh (the tracks' undo histories no longer fit). */
  private afterArrange(): void {
    this.renderTempos();
    this.bpmInput.value = String(this.project.bpm);
    this.histories.clear();
    this.shownTrack = null;
    this.roll.setLoop(this.project.loop);
    this.showTrackInRoll();
    this.renderTracks();
    this.reload();
    this.scheduleSave();
  }

  /** The loop range in words (bars when it is on bar lines). */
  private rangeText(): string {
    const { loop } = this.project;
    const bpb = this.project.beatsPerBar;
    const onBars = loop.start % bpb === 0 && loop.end % bpb === 0;
    return onBars ? (loop.end - loop.start === bpb ? `${loop.end / bpb} 小節目` : `${loop.start / bpb + 1}〜${loop.end / bpb} 小節`) : `${+(loop.start + 1).toFixed(2)}〜${+loop.end.toFixed(2)} 拍目`;
  }

  private selectTrack(index: number): void {
    if (index === this.selected || !this.project.tracks[index]) return;
    this.selected = index;
    this.showTrackInRoll();
    [...this.trackList.children].forEach((row, i) => row.classList.toggle("selected", i === index));
    this.renderPads();
    this.showRoot();
    this.refreshButtons();
    this.onTrackChange();
  }

  private addTrack(drum = false): void {
    const name = drum ? `ドラム ${this.project.tracks.filter((x) => x.kind === "drum").length + 1}` : `トラック ${this.project.tracks.length + 1}`;
    const t = drum ? newDrumTrack(name) : newTrack(name, this.editedInstrument);
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
    if (!window.confirm(`トラック「${t.name}」${t.notes.length ? `と音符 ${t.notes.length} 個` : ""}を消しますか?(元に戻せません)`)) return;
    this.histories.delete(t.id);
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
    this.client.setTrackMix(t.id, this.mixOf(t));
    this.scheduleSave();
  }

  /** The folded panel's line: how big the song is, and whether it plays. */
  private summarize(): void {
    const notes = this.project.tracks.reduce((n, t) => n + t.notes.length, 0);
    this.summaryInfo.textContent = `トラック ${this.project.tracks.length}・音符 ${notes}${this.playing ? "・再生中" : ""}`;
  }

  private renderTracks(): void {
    this.summarize();
    this.refreshSeekRange(secToBeats(this.from, this.project));
    const rows = this.project.tracks.map((t, i) => {
      const selected = i === this.selected;
      const name = el("input", { type: "text", value: t.name, className: "track-name", ariaLabel: "トラックの名前", maxLength: 30 });
      name.addEventListener("focus", () => this.selectTrack(i));
      name.addEventListener("change", () => {
        t.name = name.value.trim() || `トラック ${i + 1}`;
        this.scheduleSave();
      });
      const instrument: HTMLElement = t.kind === "drum" ? el("span", { className: "fine track-drum", textContent: `ドラムキット(${this.project.kit.slots.filter((x) => x.sample).length} 音)` }) : el("select", { ariaLabel: "鳴らす区間" }, [
        el("option", { value: "", textContent: "(区間を選ぶ)" }),
        ...this.options.map((o) => el("option", { value: o.id, textContent: o.label })),
        el("option", { value: BACKING, textContent: "簡易シンセ(伴奏)" }),
      ]);
      if (instrument instanceof HTMLSelectElement) {
        instrument.value = t.instrument ?? "";
        instrument.addEventListener("change", () => {
          t.instrument = instrument.value || null;
          this.reload();
          this.showRoot();
          this.scheduleSave();
          this.onLiveChange();
          // (Its row says whether it sounds.)
          this.renderTracks();
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
      // A melodic track with no cut plays nothing: it says so. Effects on: an FX mark that opens them.
      const silent = t.kind !== "drum" && !t.instrument ? el("span", { className: "warn fine", textContent: "区間を選ぶと鳴ります" }) : null;
      const fxOn = Object.values(t.fx).some((g) => (g as { on?: boolean }).on);
      const fxMark = fxOn
        ? button("FX", "small toggle on fx-mark", () => {
            this.selectTrack(i);
            this.onOpenFx();
          }, "このトラックにエフェクトがかかっています(押すとエフェクトを開きます)")
        : null;
      remove.hidden = this.project.tracks.length < 2;
      const row = el("div", { className: `track-row${selected ? " selected" : ""}` }, [
        el("span", { className: "track-count fine num", textContent: `${t.notes.length}` }),
        name,
        instrument,
        mute,
        solo,
        el("label", { className: "inline fine" }, ["音量 ", volume]),
        el("label", { className: "inline fine" }, ["パン ", pan]),
        ...(fxMark ? [fxMark] : []),
        ...(silent ? [silent] : []),
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

  /** A drum track: its rows are the kit's sounds (and the keys its notes use); they are set up in the kit view. */
  private renderPads(): void {
    const t = this.track;
    this.padList.hidden = t.kind !== "drum";
    if (t.kind !== "drum") {
      this.padList.replaceChildren();
      return;
    }
    const sounds = this.project.kit.slots.filter((x) => x.sample).length;
    this.padList.replaceChildren(
      el("div", { className: "row" }, [
        el("span", { className: "fine", textContent: `ドラムトラックはプロジェクトのドラムキット(自分の音 ${sounds} 個、ほかは簡易ドラム)を鳴らします。行の名前を押すと音が鳴り、その行の音符を選びます。` }),
        button("ドラムキットを開く", "small", () => this.onOpenKit(), "キットの音を割り当てたり、行(鍵)を増やしたりします"),
      ]),
    );
  }

  // ------------------------------------------------------------- the kit (design.md 13.2)

  get kit(): Kit {
    return this.project.kit;
  }

  /** Changes the kit (heard at once, kept); a drum track on screen gets its rows again. */
  updateKit(change: (kit: Kit) => void): void {
    change(this.project.kit);
    this.project.kit.slots.sort((a, b) => a.key - b.key);
    if (this.track.kind === "drum") {
      const rows = drumRows(this.project.kit, this.track.notes);
      // Same rows: only their names change (the roll keeps its history and selection); others: shown again.
      if (rows.join() === this.rowKeys.join()) this.roll.setRows(rows.map((k) => keyLabel(this.project.kit, k)));
      else this.showTrackInRoll();
    }
    this.onKitChange();
    this.reload();
    this.renderTracks();
    this.scheduleSave();
  }

  /** Whether the page has a kit key's sound ready (its recording loaded); a key without one plays the plain drum. */
  kitSoundReady: (key: number) => boolean = () => true;

  /** What the engine plays for each GM key: the kit's sound (by sample id), or the plain drum sound. */
  kitSpec(): { samples: (string | null)[]; keys: (number | null)[] } {
    const samples: (string | null)[] = [];
    const keys: (number | null)[] = [];
    for (let key = 0; key < 128; key++) {
      const slot = slotFor(this.project.kit, key);
      const own = !!slot?.sample && this.kitSoundReady(key);
      samples.push(own ? `kit:${key}` : null);
      keys.push(own ? null : key);
    }
    return { samples, keys };
  }

  /** The keys mark the note the selected track's cut is made for. */
  private showRoot(): void {
    if (this.track.kind === "drum") return;
    const option = this.options.find((o) => o.id === this.track.instrument);
    this.roll.setRoot(option ? option.note : null);
  }

  // ------------------------------------------------------------- new notes' values, other tracks, the menu

  /** The length and velocity a new note gets, as the fields show them. */
  private showDefaults(): void {
    const len = this.roll.lastLength;
    const known = NOTE_LENGTHS.some(([v]) => Math.abs(v - len) < 1e-6);
    this.lengthSelect.replaceChildren(
      ...NOTE_LENGTHS.map(([v, label]) => el("option", { value: String(v), textContent: label })),
      ...(known ? [] : [el("option", { value: String(len), textContent: `${+len.toFixed(3)} 拍` })]),
    );
    this.lengthSelect.value = String(known ? NOTE_LENGTHS.find(([v]) => Math.abs(v - len) < 1e-6)![0] : len);
    this.velocityInput.value = String(Math.round(this.roll.defaultVelocity * 127));
  }

  /** オニオンスキン: the other melodic tracks' notes behind this one's. */
  private refreshGhosts(): void {
    const t = this.track;
    this.roll.setGhosts(this.onion && t.kind !== "drum" ? this.project.tracks.filter((o) => o !== t && o.kind !== "drum").flatMap((o) => o.notes) : []);
  }

  private slice(): void {
    const at = this.roll.position ?? secToBeats(this.from, this.project);
    const n = this.roll.sliceAt(at);
    this.info.textContent = n ? `${n} 個の音符を再生位置で分けました。` : "再生位置をまたぐ音符がありません。目盛りで分けたい位置を選んでから押してください。";
  }

  /** The menu at a page position (a right-click, a long press): what can be done with the selection, or here. */
  private openMenu(clientX: number, clientY: number, note: Note | null): void {
    this.closeMenu();
    const sel = this.roll.selectionSize;
    const item = (label: string, run: () => void, enabled = true) => {
      const b = button(label, "menu-item", () => {
        this.closeMenu();
        run();
      });
      b.disabled = !enabled;
      return b;
    };
    const items: HTMLElement[] = [];
    if (note) items.push(el("p", { className: "menu-note fine", textContent: `スポイト: 次に置く音符を 長さ ${+note.length.toFixed(3)} 拍・強さ ${Math.round(note.velocity * 127)} にしました` }));
    items.push(
      item("コピー", () => this.roll.copy(), sel > 0),
      item("切り取り", () => this.roll.copy(true), sel > 0),
      item("貼り付け(再生位置に)", () => this.roll.paste(), this.roll.hasClipboard),
      item("複製(直後に)", () => this.roll.duplicateSelected(), sel > 0),
      item("削除", () => this.roll.deleteSelected(), sel > 0),
      el("hr"),
      item("すべて選択", () => this.roll.selectAll(), this.roll.notes.length > 0),
      item("選択を解除", () => this.roll.selectNone(), sel > 0),
      el("hr"),
      item("1 オクターブ上げる", () => this.roll.transposeSelected(12), sel > 0 && this.track.kind !== "drum"),
      item("1 オクターブ下げる", () => this.roll.transposeSelected(-12), sel > 0 && this.track.kind !== "drum"),
      item("クオンタイズ", () => this.quantize(), this.roll.notes.length > 0),
      item("再生位置でスライス", () => this.slice(), this.roll.notes.length > 0),
      item(`一括変更…(${sel ? `選んだ ${sel} 個` : "すべて"})`, () => this.openBatch(clientX, clientY), this.roll.notes.length > 0),
    );
    this.showMenu(clientX, clientY, items);
  }

  /** 一括変更: the length (beats) and velocity (1–127) of the selection, set / ×  / ± (Domino's 一括変更). */
  private openBatch(clientX: number, clientY: number): void {
    const lengthField = el("input", { type: "text", placeholder: "例: 0.5 / *2 / +0.25", ariaLabel: "長さ(拍)", inputMode: "decimal" });
    const velocityField = el("input", { type: "text", placeholder: "例: 100 / *0.8 / -10", ariaLabel: "強さ(1〜127)", inputMode: "decimal" });
    const error = el("p", { className: "warn", hidden: true });
    const apply = () => {
      const lenText = lengthField.value;
      const velText = velocityField.value;
      const bad = (text: string) => text.trim() !== "" && Number.isNaN(applyExpression(text, 1) ?? 0);
      if (bad(lenText) || bad(velText)) {
        error.textContent = "数(0.5)、倍率(*2)、足し引き(+10 / -10)のどれかで書いてください。";
        error.hidden = false;
        return;
      }
      const n = this.roll.changeNotes((note) => {
        const len = applyExpression(lenText, note.length);
        if (len !== null) note.length = len;
        const vel = applyExpression(velText, note.velocity * 127);
        if (vel !== null) note.velocity = Math.max(1, Math.min(127, Math.round(vel))) / 127;
      });
      this.closeMenu();
      this.info.textContent = `${n} 個の音符を一括変更しました。「元に戻す」で戻せます。`;
    };
    const form = el("form", { className: "batch-form" }, [
      el("p", { className: "control-label", textContent: `一括変更(${this.roll.selectionSize ? `選んだ ${this.roll.selectionSize} 個` : "すべての音符"})` }),
      el("label", { className: "control" }, [el("span", { className: "fine", textContent: "長さ(拍)" }), lengthField]),
      el("label", { className: "control" }, [el("span", { className: "fine", textContent: "強さ(1〜127)" }), velocityField]),
      el("p", { className: "fine", textContent: "数で指定、*2 で 2 倍、+10 / -10 で足し引き。空欄は変えません。" }),
      error,
      el("div", { className: "row" }, [el("button", { type: "submit", className: "button small primary", textContent: "変更する" }), button("やめる", "small", () => this.closeMenu())]),
    ]);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      apply();
    });
    this.showMenu(clientX, clientY, [form]);
    lengthField.focus();
  }

  private showMenu(clientX: number, clientY: number, items: HTMLElement[]): void {
    this.closeMenu();
    const menu = el("div", { className: "roll-menu", role: "menu" }, items);
    document.body.append(menu);
    // Inside the window, next to the pointer.
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, clientX))}px`;
    menu.style.top = `${Math.max(8, Math.min(window.innerHeight - h - 8, clientY))}px`;
    this.menu = menu;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !menu.contains(e.target as Node)) this.closeMenu();
    };
    // A scroll elsewhere (the page) closes it; scrolling the menu itself does not.
    const onScroll = (e: Event) => {
      if (!(e.target instanceof Node && menu.contains(e.target))) this.closeMenu();
    };
    setTimeout(() => {
      if (this.menu !== menu) return;
      document.addEventListener("pointerdown", close, true);
      document.addEventListener("keydown", close, true);
      window.addEventListener("scroll", onScroll, true);
    });
    this.menuCleanup = () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", close, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }

  private menuCleanup: () => void = () => {};

  private closeMenu(): void {
    if (!this.menu) return;
    this.menu.remove();
    this.menu = null;
    this.menuCleanup();
  }

  // ------------------------------------------------------------- quantize, step input

  private quantize(): void {
    if (!(this.roll.grid > 0)) {
      this.info.textContent = "吸着が「吸着なし」のときはクオンタイズできません。吸着の幅を選んでください。";
      return;
    }
    const all = this.roll.selectionSize === 0;
    const changed = this.roll.quantize();
    this.info.textContent = changed ? `${all ? "すべての" : "選んだ"}音符のうち ${changed} 個を吸着の線に合わせました。「元に戻す」で戻せます。` : "どの音符もすでに吸着の線の上にあります。";
  }

  /** The step position (beats), without the rounding a trip through seconds leaves. */
  private get stepAt(): number {
    return Math.round(secToBeats(this.from, this.project) * 1e6) / 1e6;
  }

  /** One step of step input (beats): the grid, or the last note length with no grid. */
  private get stepBeats(): number {
    return this.roll.grid > 0 ? this.roll.grid : this.roll.lastLength;
  }

  private setStepMode(on: boolean): void {
    this.stepMode = on;
    this.stepHeld.clear();
    if (on && this.playing) {
      this.from = this.currentSec();
      this.stop();
    }
    this.refreshButtons();
  }

  /** Moves the step position (beats) and shows it. */
  private stepTo(beat: number): void {
    this.from = beatsToSec(Math.max(0, beat), this.project);
    this.showPosition(this.from);
    this.roll.setPlayhead(Math.max(0, beat), true);
  }

  /**
   * A key of the keyboard, while step input is on: down puts a note in at the
   * position (keys held together make a chord) and moves on one step. Returns
   * whether the key was taken (then it is not played on the keyboard's sound).
   */
  stepNote(pitch: number, down: boolean): boolean {
    if (!down) return this.stepHeld.delete(pitch);
    if (!this.stepMode || !this.visible || this.playing || this.track.kind === "drum") return false;
    const chord = this.stepHeld.size > 0;
    if (!chord) this.stepChordStart = this.stepAt;
    this.stepHeld.add(pitch);
    const step = this.stepBeats;
    this.roll.insertNote(this.stepChordStart, step, pitch, this.roll.defaultVelocity || DEFAULT_VELOCITY, chord);
    this.stepHistory.push({ start: this.stepChordStart, pitch });
    // (It sounds through the keyboard itself: the page plays every key, through the track's effects in this view.)
    if (!chord || !this.stepLastChord) this.stepLastChord = { start: this.stepChordStart, pitches: [] };
    this.stepLastChord.pitches.push(pitch);
    this.stepTo(this.stepChordStart + step);
    return true;
  }

  /** タイ: the last chord put in is held one step longer, and the position moves on with it. */
  private stepTie(): void {
    const chord = this.stepLastChord;
    if (!chord) {
      this.info.textContent = "タイは、ステップ入力で音符を入れた直後に使います。";
      return;
    }
    const step = this.stepBeats;
    this.roll.lengthenAt(chord.start, chord.pitches, step);
    this.stepTo(this.stepAt + step);
  }

  private stepRest(): void {
    this.stepTo(this.stepAt + this.stepBeats);
  }

  private stepBack(): void {
    const last = this.stepHistory.pop();
    if (!last) {
      this.stepTo(this.stepAt - this.stepBeats);
      return;
    }
    this.roll.removeNoteAt(last.start, last.pitch);
    this.stepTo(last.start);
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
    this.client.setTrackMix(t.id, this.mixOf(t, fx));
    this.scheduleSave();
    this.onLiveChange();
    const on = Object.values(fx).some((g) => (g as { on?: boolean }).on);
    if (on !== !!this.trackList.children[this.selected]?.querySelector(".fx-mark")) this.renderTracks();
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
    const kit = this.kitSpec();
    return this.project.tracks
      .filter((t) => t.kind === "drum" || t.instrument !== null)
      .map((t) => ({
        id: t.id,
        instrument: t.kind === "drum" ? "drum" : t.instrument!,
        samples: t.kind === "drum" ? kit.samples : undefined,
        drumKeys: t.kind === "drum" ? kit.keys : undefined,
        notes: toSeqNotes(t.notes, this.project, t.kind !== "drum" && t.glide > 0),
        glide: t.kind === "drum" ? 0 : t.glide,
        ...this.mixOf(t),
      }));
  }

  // ------------------------------------------------------------- playback

  private preview(pitch: number): void {
    if (this.playing) return;
    if (this.track.kind === "drum") {
      const key = this.rowKeys[pitch];
      if (key !== undefined) this.onKitHit(key);
      return;
    }
    if (this.track.instrument && this.track.instrument !== BACKING) this.client.previewNote(this.track.instrument, pitch);
  }

  private sendLoop(): void {
    // (The master line's seconds follow the tempo too: it goes wherever the loop does.)
    this.sendMasterAuto();
    const { loop } = this.project;
    this.client.setSongLoop(loop.on ? { startSec: beatsToSec(loop.start, this.project), endSec: beatsToSec(loop.end, this.project) } : null);
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
    const { loop } = this.project;
    if (loop.on) {
      const a = beatsToSec(loop.start, this.project);
      const b = beatsToSec(loop.end, this.project);
      if (this.from < b && pos >= b && b > a) pos = a + ((pos - b) % (b - a));
    }
    return pos;
  }

  private currentBeat(): number {
    return secToBeats(this.currentSec(), this.project);
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
    const endSec = beatsToSec(this.lastBeat(), this.project);
    if (!this.project.loop.on && this.from >= endSec) this.from = 0;
    this.start();
  }

  private start(): void {
    this.client.setTempo(this.project.bpm);
    this.client.loadTracks(this.trackSpecs());
    this.sendLoop();
    this.startedAt = this.client.playSong(this.from);
    this.playButton.textContent = "■ 停止";
    this.summarize();
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
      this.showPosition(beatsToSec(beat, this.project));
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  /** Stops playback keeping the position where it is now (leaving the 曲 view). */
  pause(): void {
    if (!this.playing) return;
    this.from = this.currentSec();
    this.stop();
  }

  /** Stops playback (the position stays where it was). */
  stop(): void {
    cancelAnimationFrame(this.frame);
    if (this.startedAt === null) return;
    this.startedAt = null;
    this.client.stopSong();
    this.client.setTempo(this.restingBpm());
    this.playButton.textContent = "▶ 再生";
    this.summarize();
    this.roll.setPlayhead(secToBeats(this.from, this.project));
    this.showPosition(this.from);
    this.onPlayingChange(false);
  }

  // ------------------------------------------------------------- the screen

  private showPosition(sec: number): void {
    const beat = secToBeats(sec, this.project);
    if (!this.seeking) {
      this.refreshSeekRange(beat);
      this.seekBar.value = String(beat);
    }
    const bpb = this.project.beatsPerBar;
    const bar = Math.floor(beat / bpb + 1e-9);
    this.position.textContent = `${bar + 1} 小節 ${Math.floor(beat - bar * bpb + 1e-9) + 1} 拍`;
    if (!this.playing) this.roll.setPlayhead(beat);
  }

  /** The seek bar reaches a bar past the last note (at least 4 bars, and past the loop and the position). */
  private refreshSeekRange(at = 0): void {
    const bpb = this.project.beatsPerBar;
    const end = Math.max(this.lastBeat() + bpb, this.project.loop.on ? this.project.loop.end : 0, at, bpb * 4);
    this.seekBar.max = String(Math.ceil(end / bpb) * bpb);
  }

  private refreshButtons(): void {
    const none = this.roll.selectionSize === 0;
    this.deleteButton.disabled = none;
    this.duplicateButton.disabled = none;
    for (const b of this.transposeButtons) b.disabled = none;
    this.undoButton.disabled = !this.roll.canUndo;
    this.redoButton.disabled = !this.roll.canRedo;
    const { loop } = this.project;
    const range = this.rangeText();
    this.arrangeLabel.textContent = `範囲(${range}、目盛りをドラッグで選ぶ):`;
    this.arrangeUndoButton.disabled = this.arrangeUndo === null;
    this.loopButton.textContent = `ループ: ${loop.on ? `オン(${range})` : "オフ"}`;
    this.loopButton.classList.toggle("on", loop.on);
    this.selectToggle.textContent = `範囲選択: ${this.roll.selectMode ? "オン" : "オフ"}`;
    this.clearButton.disabled = this.roll.notes.length === 0;
    this.quantizeButton.disabled = this.roll.notes.length === 0;
    this.copyButton.disabled = none;
    this.pasteButton.disabled = !this.roll.hasClipboard;
    this.selectAllButton.disabled = this.roll.notes.length === 0;
    for (const b of this.nudgeButtons) b.disabled = none;
    this.sliceButton.disabled = this.roll.notes.length === 0;
    this.onionToggle.classList.toggle("on", this.onion);
    this.onionToggle.hidden = this.track.kind === "drum";
    const drum = this.track.kind === "drum";
    this.stepToggle.textContent = `ステップ入力: ${this.stepMode && !drum ? "オン" : "オフ"}`;
    this.stepToggle.classList.toggle("on", this.stepMode && !drum);
    this.stepToggle.disabled = drum;
    this.stepToggle.title = drum ? "ドラムトラックでは使えません(行をタップして入れてください)" : "鍵盤で弾いた音が、再生位置に音符として入ります";
    this.stepRestButton.hidden = this.stepBackButton.hidden = this.stepHelp.hidden = this.stepTieButton.hidden = !this.stepMode || drum;
  }
}
