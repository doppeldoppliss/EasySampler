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
  MAX_TRACK_GAIN,
  clampPitch,
  newTrackId,
  setTimeSig,
  TIME_SIG_DENS,
  beatsToSec,
  DEFAULT_VELOCITY,
  emptyProject,
  fromSongNotes,
  newAudioTrack,
  newId,
  sortNotes,
  newDrumTrack,
  clipsToSeq,
  newTrack,
  sanitizeProject,
  secToBeats,
  setTempoList,
  songEnd,
  tempoAt,
  tempoMapSec,
  trimClips,
  estimateKey,
  withHarmony,
  type Harmony,
  dbToGain,
  FADER_FLOOR_DB,
  gainToDb,
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
import { DEFAULT_FX, type FxSettings } from "../instrument/types";
import { MidiParseError, parseMidi } from "../song/midi";
import { songParts } from "../song/parts";
import { drumRows, keyLabel, soundKey, type Kit } from "../daw/kit";
import { arrange, type ArrangeKind } from "../daw/arrange";
import { armOnce, el } from "./dom";
import { autoNames, FAR_ABOVE, FAR_BELOW, rangeFromRoot, ROLE_NAMES, spreadPans, trackRoles, type Role } from "../daw/roles";
import { kickDuck, madeByAuto, medianLength, octaveFit, roomFor } from "../daw/autoMix";
import { KICK_KEYS } from "../song/player";
import { PianoRoll } from "./pianoRoll";
import { isSynthPreset, SYNTH_PRESETS } from "../song/backing";
import { BALANCE_STYLES, BAND_HZ, type BalanceResult, type BalanceStyle } from "../fx/balance";

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

/** The ハモリ's voices offered: scale steps from the note, and what they are called. */
const HARMONY_VOICES: [number, string][] = [
  [2, "3度上"],
  [-2, "3度下"],
  [4, "5度上"],
  [-3, "4度下"],
  [7, "オクターブ上"],
  [-7, "オクターブ下"],
];

/** Where 書き出す音量 is kept (this browser). */
const LOUDNESS_KEY = "easysampler.exportLoudness";
/** A fader's dB in words (−∞ at the bottom). */
const dbText = (db: number) => (db <= FADER_FLOOR_DB ? "−∞ dB" : `${db > 0 ? "+" : db < 0 ? "−" : ""}${Math.abs(db).toFixed(1)} dB`);

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
const METRONOME_KEY = "easysampler.roll.metronome";
/** The metronome's lane id (a lane starting with "__" is not muted by a solo). */
const METRONOME = "__metronome";

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

/** A cut a track can play: its instrument id, how it reads in the list, and its detected pitch (the key it plays at as it is, marked on the keys). */
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
  /** A track's 「音源を編集」: the page opens that cut on the 素材 side. */
  onEditCut: (instrument: string) => void = () => {};
  /** A drum track's rows as the roll shows them: the GM key of each (top to bottom). */
  private rowKeys: number[] = [];
  /** 書き出し: the whole song as a WAV, each track as its own WAV (zip), or the notes as MIDI. */
  onExport: (kind: "wav" | "stems" | "mid") => void = () => {};
  /** マスター EQ を目安に寄せる: the page renders and measures the song, then calls applyBalance. */
  onBalance: (style: BalanceStyle) => void = () => {};
  /** 音量を合わせる / トラックの EQ (自動): the page renders and measures, then calls applyGains / applyTrackFx. */
  onAutoLevels: () => void = () => {};
  onAutoEq: () => void = () => {};
  /** まとめて自動ミックス / ミックスを診断する: the page runs them (they render). */
  onAutoMixAll: () => void = () => {};
  onDiagnose: () => void = () => {};
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

  private startedAt: number | null = null;
  /** Where playback starts (song seconds). */
  private from = 0;
  private frame = 0;
  private saveTimer = 0;

  private readonly trackList = el("div", { className: "track-list" });
  /** A drum track: where its rows come from (the kit), and the way to it. */
  private readonly padList = el("div", { className: "pad-list" });
  private readonly playButton = button("▶ 再生", "big", () => this.toggle());
  /** Clicks on every beat while the song plays (always while recording, with a bar of count-in). */
  private metronome = remembered(METRONOME_KEY) === "on";
  private readonly metronomeToggle = button("メトロノーム", "small toggle", () => {
    this.metronome = !this.metronome;
    remember(METRONOME_KEY, this.metronome ? "on" : "off");
    this.metronomeToggle.classList.toggle("on", this.metronome);
    if (this.playing && !this.recording) this.reload();
  }, "再生中、拍ごとにクリックを鳴らします(録音中は常に鳴ります)");
  private readonly recordButton = button("● 録音", "small", () => this.toggleRecording(), "選んでいるトラックに、鍵盤(画面・PC キーボード・MIDI キーボード)で弾いた音符をそのまま入れます。1 小節のカウントのあと、再生位置から始まります");
  /** A recording under way: where it starts (beats), the keys held (their start and strength), and the notes so far. */
  private recording: { startBeat: number; held: Map<number, { start: number; velocity: number }>; notes: Note[] } | null = null;
  private readonly loopButton = button("", "small", () => this.setLoopOn(!this.project.loop.on));
  /** Whole stretches on every track (the loop range): a blank before it, deleted, or played twice. */
  private readonly arrangeLabel = el("span", { className: "fine" });
  private readonly insertButton = button("前に空白を挿入", "small", () => this.arrange("insert"), "ループ範囲と同じ長さの空白を、範囲の始まりに入れます(全トラック。後ろはずれます)");
  private readonly removeRangeButton = button("削除して詰める", "small", () => this.arrange("delete"), "ループ範囲を全トラックから消し、後ろを詰めます");
  private readonly duplicateRangeButton = button("複製(後ろに続ける)", "small", () => this.arrange("duplicate"), "ループ範囲を全トラックで、範囲のすぐ後ろにもう一度入れます。ループ範囲は複製した側へ移ります(続けて押すと、さらに後ろへ)");
  /** The song before the last stretch operation (until a note is edited again). */
  /**
   * The song's undo (design.md 13): every change — notes, lines, tracks, the mixer, effects, tempo, signature,
   * markers, bar operations — is a step; the kit, the materials and the loop range are left as they are.
   */
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  /** The song as it was after the last step (what the next step's undo goes back to). */
  private lastState = "";
  private commitTimer = 0;
  // 選んだトラック: the whole track up or down, and a copy of it.
  private readonly trackOpButtons = {
    down: button("半音下げる", "small", () => this.transposeTrack(-1), "選んだトラックの音符を全部、半音下げます"),
    up: button("半音上げる", "small", () => this.transposeTrack(1), "選んだトラックの音符を全部、半音上げます"),
    octDown: button("1 オクターブ下げる", "small", () => this.transposeTrack(-12)),
    octUp: button("1 オクターブ上げる", "small", () => this.transposeTrack(12)),
    dup: button("トラックを複製", "small", () => this.duplicateTrack(), "選んだトラックを、音符・エフェクト・音量ごと複製します"),
  };
  private readonly markerList = el("div", { className: "row tempo-list marker-list" });
  // 原曲・伴奏: a long recording on an audio track of its own (the page decodes and keeps it).
  private readonly longInput = el("input", { type: "file", accept: "audio/*,video/*", className: "visually-hidden" });
  private readonly longList = el("div", { className: "row long-list" });
  /** A long recording chosen: the page decodes and keeps it, then calls addLongAudio. */
  onPickLongAudio: (file: File) => void = () => {};
  /** A long recording taken out of the project (the page forgets its samples). */
  onRemoveLongAudio: (id: string) => void = () => {};
  // 拍子: one for the whole song.
  private readonly sigNum = el("select", { ariaLabel: "拍子(分子)" }, [...Array(16).keys()].map((i) => el("option", { value: String(i + 1), textContent: String(i + 1) })));
  private readonly sigDen = el("select", { ariaLabel: "拍子(分母)" }, TIME_SIG_DENS.map((d) => el("option", { value: String(d), textContent: String(d) })));
  private readonly bpmInput = el("input", { type: "number", min: "20", max: "400", step: "any", inputMode: "decimal", ariaLabel: "BPM" });
  private readonly gridSelect = el("select", { ariaLabel: "吸着" }, GRIDS.map(([v, label]) => el("option", { value: String(v), textContent: label })));
  private readonly selectToggle = button("", "small", () => {
    this.roll.selectMode = !this.roll.selectMode;
    this.refreshButtons();
  });
  private readonly undoButton = button("元に戻す", "small", () => this.undo(), "Ctrl+Z(曲・ミックスの画面) — 音符・トラック・ミキサー・エフェクト・テンポなど、曲の変更を 1 つ戻します");
  private readonly redoButton = button("やり直す", "small", () => this.redo(), "Ctrl+Y");
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
    this.roll.setNotes([]);
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
  // ハモリ (a melodic track): on, the key, which voices, how strong.
  private readonly harmonyOn = el("input", { type: "checkbox" });
  private readonly harmonyKey = el("select", { ariaLabel: "ハモリのキー" }, ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"].map((name, i) => el("option", { value: String(i), textContent: name })));
  private readonly harmonyMode = el("select", { ariaLabel: "長調 / 短調" }, [el("option", { value: "major", textContent: "長調" }), el("option", { value: "minor", textContent: "短調" })]);
  private readonly harmonyVoiceButtons = HARMONY_VOICES.map(([steps, label]) => {
    const b = button(label, "small toggle", () => this.changeHarmony((h) => (h.voices = h.voices.includes(steps) ? h.voices.filter((v) => v !== steps) : [...h.voices, steps])));
    b.dataset.steps = String(steps);
    return b;
  });
  private readonly harmonyLevel = el("input", { type: "range", min: "0", max: "1", step: "0.05", ariaLabel: "ハモリの強さ" });
  private readonly harmonyNote = el("span", { className: "fine" });
  private readonly glideRow = el("div", { className: "track-options" }, [
    el("div", { className: "row" }, [
      el("label", { className: "inline" }, ["ポルタメント ", this.glideSelect]),
      el("span", { className: "fine", textContent: "つながった(重なった)音符を、前の高さから滑らせてつなぎます。このトラックは単音になります。" }),
    ]),
    el("div", { className: "row harmony-row" }, [
      el("label", { className: "inline" }, [this.harmonyOn, " ハモリを足す"]),
      el("span", { className: "inline" }, ["キー ", this.harmonyKey, this.harmonyMode]),
      button("曲から推定", "small", () => this.estimateHarmonyKey(), "曲の全部の音符から、いちばん合いそうなキーを選びます"),
      ...this.harmonyVoiceButtons,
      el("label", { className: "inline fine" }, ["強さ ", this.harmonyLevel]),
      this.harmonyNote,
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
  /** Export only the loop range (WAV / stems), seamless. */
  private readonly loopOnlyBox = el("input", { type: "checkbox", ariaLabel: "ループ範囲だけ書き出す" });
  private readonly position = el("span", { className: "fine num" });
  // ループ範囲 in bars, and the quick ways to set it (the ruler's drag still works too).
  private readonly loopFrom = el("input", { type: "number", min: "1", step: "1", inputMode: "decimal", ariaLabel: "ループの始まり(小節)", className: "bar-input" });
  private readonly loopTo = el("input", { type: "number", min: "1", step: "1", inputMode: "decimal", ariaLabel: "ループの終わり(小節)", className: "bar-input" });
  private readonly loopBarButton = button("この小節", "small", () => this.loopAround("bar"), "再生位置のある小節をループします");
  private readonly loopSelectionButton = button("選んだ音符", "small", () => this.loopAround("selection"), "選んでいる音符を含む小節をループします");
  private readonly loopMarkerButton = button("マーカーの間", "small", () => this.loopAround("marker"), "再生位置の前のマーカーから次のマーカーまで(Aメロ、サビ…)をループします");
  /** What follows the page's scroll: play, record, the metronome, the loop switch, the position and the seek bar (placed by the page). */
  readonly transport: HTMLElement;
  /** The tempo changes after the start: each its bar and beat, its tempo, and ×. */
  private readonly tempoList = el("div", { className: "row tempo-list" });
  /** The seek bar: the song from its start to a little past its last note (or the loop's end), in beats. */
  private readonly seekBar = el("input", { type: "range", min: "0", max: "16", step: "any", value: "0", className: "song-seek", ariaLabel: "再生位置" });
  // The loop range drawn on the seek bar, its two ends grabbed to set it (bars; Alt: beats). Off, it is drawn faint.
  private readonly loopStartGrip = el("div", { className: "seek-loop-grip start", title: "ループの始まり(ドラッグで動かす。小節単位、Alt で拍単位)" });
  private readonly loopEndGrip = el("div", { className: "seek-loop-grip end", title: "ループの終わり(ドラッグで動かす。小節単位、Alt で拍単位)" });
  private readonly loopBand = el("div", { className: "seek-loop" });
  /** Where the selected track has notes, roughly, under the seek bar. */
  private readonly seekActivity = el("canvas", { className: "seek-activity", ariaHidden: "true" });
  private readonly seekWrap = el("div", { className: "seek-wrap" }, [this.loopBand, this.loopStartGrip, this.loopEndGrip, this.seekBar, this.seekActivity]);
  /** Each track row's lamp: lit while that track sounds (a note under the playhead, the track heard). */
  private trackLamps: HTMLElement[] = [];
  /** Each track's meters (its 曲 row's and its ミックス strip's), by track id, and the level they show (dB, falling back slowly). */
  private readonly trackMeters = new Map<string, { fills: HTMLElement[]; db: number }>();
  /** A track's mix controls in both places (the 曲 row, the ミックス strip), by track id: a change in one shows in the other. */
  private readonly mixLinks = new Map<string, { mutes: HTMLElement[]; solos: HTMLElement[]; volumes: HTMLInputElement[]; texts: HTMLElement[]; pans: HTMLInputElement[] }>();
  // The master meter (in the bar that follows the scroll): the output's level, its loudness, and a clip mark.
  // (Twice over: the bar that follows the scroll, and the ミックス view's master strip.)
  private readonly masterFills = [0, 1].map(() => el("span", { className: "meter-fill" }));
  private readonly masterTexts = [0, 1].map(() => el("span", { className: "fine num master-meter-text" }));
  private readonly clipMarks = [0, 1].map(() => el("button", { type: "button", className: "clip-mark", textContent: "0 dB 超え", title: "この再生のどこかでミックスが 0 dB を超えました。聞こえる音はリミッターで -1 dB に抑え、書き出す WAV も割れないよう調整しますが、そのぶん潰れたり全体が小さくなったりします。音量を下げると素直な音になります。押すと消えます(再生を始めるたびにも消えます)" }));
  /** The ミックス view: a strip per track and the master's (placed by the page), with the song's export under them. */
  readonly mixElement: HTMLElement;
  private readonly mixStrips = el("div", { className: "mix-strips" });
  /** The 曲 view's messages, shown in the ミックス view too (spreading the pans, undo, effects reset…). */
  private readonly mixInfo = el("p", { className: "fine", role: "status" });
  // 音域のバランス: the target style, the button, what it did, and a chart of the song against the target.
  private readonly balanceSelect = el(
    "select",
    { ariaLabel: "目安にする音域のバランス" },
    (Object.entries(BALANCE_STYLES) as [BalanceStyle, string][]).map(([id, label]) => el("option", { value: id, textContent: label })),
  );
  private readonly balanceStatus = el("p", { className: "fine", role: "status" });
  /** Shown when the master EQ cannot make up for missing lows: a synth bass under the bass line. */
  private readonly bassFill = el("div", { className: "row tight", hidden: true }, [
    el("span", { className: "warn fine", textContent: "低音(30〜80 Hz)が目安よりかなり足りません。EQ では補えないので、ベースの音符をシンセベースで重ねるのが効果的です。" }),
    button("シンセベースを重ねる", "small", () => this.layerSynthBass(), "ベースのトラックを複製して、簡易シンセの「シンセベース」で鳴らすトラックを足します(元に戻すで戻せます)"),
  ]);
  /** ベースの強さ: what 音量を合わせる aims the bass at (kept with the project). */
  private readonly bassLevelSelect = el("select", { ariaLabel: "ベースの強さ", title: "「音量を合わせる」がベースをどのくらいの大きさにするか。標準はメロディと同じ聞こえの大きさ。ノート PC やスマホのスピーカーでは低音が聞こえにくいので、強めが合うこともあります" }, [
    el("option", { value: "0", textContent: "ベース: 標準" }),
    el("option", { value: "3", textContent: "ベース: 強め(+3 dB)" }),
    el("option", { value: "6", textContent: "ベース: かなり強め(+6 dB)" }),
  ]);
  /** ミックスを診断する: its table (empty until run). */
  private readonly diagnosis = el("div", { className: "diagnosis" });
  private readonly balanceCanvas = el("canvas", { className: "balance-chart", ariaLabel: "目安との差(変える前と後)" });
  private balanceShown: { result: BalanceResult; style: BalanceStyle } | null = null;
  // The spectrum of what plays (the ミックス view), drawn while that view is on screen.
  private readonly spectrumCanvas = el("canvas", { className: "spectrum", ariaLabel: "周波数の分布" });
  private spectrumFrame = 0;
  private spectrumHold: Float32Array | null = null;
  /** The master strip's FX button: the page opens the master's effects. */
  onOpenMasterFx: () => void = () => {};
  private masterDb = -Infinity;
  /** The loudest the output has been lately (dB), held a while so it can be read. */
  private masterHold = { db: -Infinity, at: 0 };
  // 書き出す音量: the song WAV brought to a platform's loudness (or left as it is), kept in this browser.
  private readonly loudnessSelect = el("select", { ariaLabel: "書き出す音量" }, [
    el("option", { value: "none", textContent: "音量: そのまま(音割れだけ防ぐ)" }),
    el("option", { value: "niconico", textContent: "音量: ニコニコ動画向け(-15 LUFS)" }),
    el("option", { value: "youtube", textContent: "音量: YouTube・配信向け(-14 LUFS)" }),
  ]);
  private seeking = false;
  private seekTimer = 0;
  readonly info = el("p", { className: "fine", role: "status" });

  constructor(client: EngineClient) {
    this.client = client;
    this.midiInput.addEventListener("change", () => {
      const file = this.midiInput.files?.[0];
      this.midiInput.value = "";
      if (file) void this.openMidi(file);
    });

    this.roll.onChange = (notes) => this.changed(notes);
    this.roll.onUndoKey = (redo) => (redo ? this.redo() : this.undo());
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

    for (const s of [this.sigNum, this.sigDen]) s.addEventListener("change", () => this.setTimeSignature(Number(this.sigNum.value), Number(this.sigDen.value)));
    this.longInput.addEventListener("change", () => {
      const file = this.longInput.files?.[0];
      this.longInput.value = "";
      if (file) this.onPickLongAudio(file);
    });
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
    this.harmonyOn.addEventListener("change", () => this.changeHarmony((h) => (h.on = this.harmonyOn.checked)));
    this.harmonyKey.addEventListener("change", () => this.changeHarmony((h) => (h.key = Number(this.harmonyKey.value))));
    this.harmonyMode.addEventListener("change", () => this.changeHarmony((h) => (h.minor = this.harmonyMode.value === "minor")));
    this.harmonyLevel.addEventListener("input", () => {
      this.track.harmony.level = Number(this.harmonyLevel.value);
      this.reload();
      this.scheduleSave();
      this.commitSoon();
    });
    this.glideSelect.addEventListener("change", () => {
      const t = this.track;
      t.glide = Number(this.glideSelect.value) || 0;
      this.showHarmony();
      this.reload();
      this.scheduleSave();
      this.commit();
    });

    this.transport = el("div", { className: "sticky-transport song-transport axis-play" }, [
      el("div", { className: "row roll-transport" }, [
        this.playButton,
        this.recordButton,
        this.metronomeToggle,
        this.loopButton,
        this.position,
        el("span", { className: "master-meter", title: "マスター(曲全体)の音の大きさ。バーと「ピーク」は瞬間の最大、「LUFS」は直近 3 秒の聞こえの大きさ(配信サイトが揃える基準と同じ物差し)" }, [
          el("span", { className: "fine", textContent: "マスター" }),
          el("span", { className: "meter" }, [this.masterFills[0]]),
          this.masterTexts[0],
          this.clipMarks[0],
        ]),
      ]),
      el("div", { className: "row song-seek-row" }, [this.seekWrap]),
    ]);
    for (const input of [this.loopFrom, this.loopTo]) input.addEventListener("change", () => this.loopFromInputs());
    this.element = el("section", { className: "panel roll-panel" }, [
      el("div", { className: "row" }, [el("span", { className: "control-label", textContent: "打ち込み" })]),
      el("div", { className: "row" }, [this.midiButton, this.midiInput]),
      el("div", { className: "row roll-settings" }, [
        el("label", { className: "inline" }, ["BPM ", this.bpmInput]),
        el("span", { className: "inline time-sig" }, ["拍子 ", this.sigNum, "/", this.sigDen]),
        el("label", { className: "inline" }, ["吸着 ", this.gridSelect]),
      ]),
      el("div", { className: "row loop-range-row" }, [
        el("span", { className: "fine", textContent: "ループ範囲:" }),
        el("label", { className: "inline" }, [this.loopFrom, " 小節目から"]),
        el("label", { className: "inline" }, [this.loopTo, " 小節目まで"]),
        this.loopBarButton,
        this.loopSelectionButton,
        this.loopMarkerButton,
      ]),
      this.tempoList,
      this.markerList,
      this.trackList,
      el("div", { className: "row track-ops" }, [el("span", { className: "fine", textContent: "選んだトラックを:" }), ...Object.values(this.trackOpButtons)]),
      el("div", { className: "row" }, [button("＋ トラックを追加", "small", () => this.addTrack("melodic")), button("＋ ドラムトラックを追加", "small", () => this.addTrack("drum")), button("＋ 音声トラックを追加", "small", () => this.addTrack("audio"), "素材の録音を、高さも速さも変えずにそのまま並べるトラック(声ネタ・効果音・ループ素材)"), button("＋ 原曲・伴奏を置く", "small", () => this.longInput.click(), "長い音声(原曲・オフボーカルなど)を、曲の頭から鳴る音声トラックとして置きます(音程の解析はしません)"), this.longInput]),
      this.longList,
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
      el("div", { className: "row roll-tools arrange-row" }, [this.arrangeLabel, this.insertButton, this.removeRangeButton, this.duplicateRangeButton]),
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
    ]);
    this.mixElement = el("section", { className: "panel mix-panel" }, [
      el("div", { className: "row" }, [el("span", { className: "control-label", textContent: "ミックス" })]),
      el("details", { className: "fine hint" }, [
        el("summary", { textContent: "バランスの取り方(目安)" }),
        el("p", { textContent: "1. 基準を 1 本決める(原曲・伴奏か主旋律)。そのメーターが -10 dB 前後になるよう合わせ、以後は動かさない。 2. ほかのトラックを基準より小さく足していく。マスターのピークは -6〜-3 dB に収め、「0 dB 超え」を出さない。 3. 主役・ベース・キックは中央、伴奏・ハモリ・シンバル・効果音は左右へ(パン)。 4. 中域(声の帯域)が混むときはトラックのエフェクトの EQ で少し削る。奥へ下げたい音は高域を削るかリバーブ。 5. マスターのエフェクトは控えめに(ローカット、軽いコンプ程度)。投稿先の音量合わせは書き出しの「音量」で。" }),
      ]),
      el("div", { className: "row tight mix-tools" }, [
        button("パンを自動で広げる", "small", () => this.spreadPans(), "ドラム・ベース・メロディは中央のまま、和音と伴奏を高さの順に左右へ振り分けます(元に戻すで戻せます)"),
        button("トラック名を自動で付ける", "small", () => this.nameTracks(), "「MIDI Out #3」のような名前のトラックに、音符から「ベース」「メロディ」「和音」などの名前を付けます(名前のあるトラックはそのまま)"),
      ]),
      el("div", { className: "row tight mix-tools" }, [
        button("まとめて自動ミックス", "small primary", () => this.onAutoMixAll(), "トラック名(名前のないものだけ)→ パン(真ん中のままのトラックだけ)→ トラックの EQ → キックに合わせて沈める → 残響 → 音量 → マスター EQ(下で選んだ目安)を、この順で続けて行い、最後に診断を出します。それぞれ「元に戻す」で 1 段ずつ戻せます"),
        button("ミックスを診断する", "small", () => this.onDiagnose(), "トラックを 1 本ずつと曲全体を書き出して、聞こえの大きさ・ピーク・気になる点を一覧にします(設定は変えません)"),
      ]),
      this.diagnosis,
      el("div", { className: "row tight mix-tools" }, [
        el("span", { className: "fine", textContent: "役割から自動で:" }),
        this.bassLevelSelect,
        button("音量を合わせる", "small", () => this.onAutoLevels(), "トラックを 1 本ずつ書き出して聞こえの大きさ(LUFS)を測り、役割ごとの目安(原曲・伴奏かメロディを基準に、ベース ±0・ドラム −1・和音 −5・伴奏 −6・ハモリ −8 dB。同じ役割が複数なら分け合う)に音量を合わせます"),
        button("トラックの EQ", "small", () => this.onAutoEq(), "メロディ・和音・伴奏・ハモリのトラックに、低い音符の少し下からのローカットと、メロディとぶつかる帯を 2〜3 dB 削る EQ を入れます(EQ を自分で入れたトラックはそのまま)"),
        button("キックに合わせて沈める", "small", () => this.autoDuck(), "ベース(−3 dB、16 分音符で戻る)と、1 拍以上伸ばす音が中心の和音・伴奏・ハモリ(−2 dB)に、ドラムトラックのキック(35・36 番)で沈むサイドチェーンを入れます(サイドチェーンを自分で入れたトラックはそのまま)"),
        button("残響を付ける", "small", () => this.autoRooms(), "メロディは少し(6%)、和音・伴奏・ハモリはやや多め(11〜14%)に、テンポに合った長さのリバーブを入れます。ベース・ドラム・原曲と、16 分音符以下の短い音が中心の速いパートにはなし(リバーブを自分で入れたトラックはそのまま)"),
      ]),
      this.mixInfo,
      this.mixStrips,
      el("div", { className: "balance-box" }, [
        el("div", { className: "row tight" }, [
          el("span", { className: "control-label", textContent: "音域のバランス(マスター EQ)" }),
          this.balanceSelect,
          button("マスター EQ を目安に寄せる", "small", () => this.onBalance(this.balanceSelect.value as BalanceStyle), "曲をマスターなしで書き出して周波数の分布を測り、選んだ目安の形へ半分ほど近づくよう、マスターの EQ(ローカット・低音・中音・高音)を設定します。元に戻すで戻せます"),
        ]),
        el("p", { className: "fine", textContent: "仕上がった曲の平均は、低音から高音へなだらかに下がる形になります。その目安(標準 / 電子音・ボカロ系は低音と高音が多め / 生楽器系はなだらか)との差を測って、マスター EQ で半分ほど寄せます(各 ±6 dB まで)。直せるのは全体の傾きだけで、トラック同士のぶつかりは各トラックの EQ で。最後は耳で調整してください。" }),
        this.balanceStatus,
        this.bassFill,
        this.balanceCanvas,
      ]),
      el("div", { className: "spectrum-box" }, [
        el("div", { className: "row tight" }, [
          el("span", { className: "control-label", textContent: "周波数の分布(いま鳴っている音)" }),
          el("span", { className: "fine", textContent: "左が低い音、右が高い音。山が 250 Hz〜1 kHz に固まっていればこもり気味、4 kHz より右が極端に低ければ抜けが悪い目安です。" }),
        ]),
        this.spectrumCanvas,
      ]),
      el("div", { className: "row song-export" }, [
        el("span", { className: "control-label", textContent: "曲の書き出し" }),
        button("曲を WAV で", "small primary", () => this.onExport("wav"), "全トラックをミックスし、マスターのエフェクトをかけた 1 本の WAV"),
        button("トラック別の WAV(zip)", "small", () => this.onExport("stems"), "トラックごとに 1 本ずつ(各トラックのエフェクト込み、マスターなし)"),
        button("MIDI(.mid)", "small", () => this.onExport("mid"), "音符だけを MIDI ファイルに(別の DAW へ持っていく用)"),
        el("label", { className: "inline fine", title: "ループ範囲だけを、つなぎ目なくループできる長さで書き出します(WAV・トラック別)" }, [this.loopOnlyBox, " ループ範囲だけ"]),
        el("label", { className: "inline", title: "曲の WAV を、投稿先がそろえる聞こえの大きさ(LUFS)に合わせて書き出します。上限はトゥルーピーク -1 dB(リミッター)。トラック別の WAV はそのままです" }, [this.loudnessSelect]),
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
    // (The strip is drawn in pixels: again when the bar changes width.)
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => this.drawSeekActivity()).observe(this.seekActivity);
    this.grabLoopEnd(this.loopStartGrip, "start");
    for (const mark of this.clipMarks) {
      mark.hidden = true;
      mark.addEventListener("click", () => this.clipMarks.forEach((m) => (m.hidden = true)));
    }
    try {
      const kept = localStorage.getItem(LOUDNESS_KEY);
      if (kept && [...this.loudnessSelect.options].some((o) => o.value === kept)) this.loudnessSelect.value = kept;
    } catch {
      // (private window: the default)
    }
    this.loudnessSelect.addEventListener("change", () => {
      try {
        localStorage.setItem(LOUDNESS_KEY, this.loudnessSelect.value);
      } catch {
        // (not kept)
      }
    });
    this.grabLoopEnd(this.loopEndGrip, "end");
    // (One message line for the song, seen in whichever of its two views is on screen.)
    new MutationObserver(() => (this.mixInfo.textContent = this.info.textContent)).observe(this.info, { childList: true, characterData: true, subtree: true });
    this.bassLevelSelect.addEventListener("change", () => {
      this.project.bassLevelDb = Number(this.bassLevelSelect.value) || 0;
      this.scheduleSave();
      this.commit();
      this.info.textContent = "ベースの強さを変えました。「音量を合わせる」(または「まとめて自動ミックス」)を押すと反映されます。";
    });
    this.applyProject();
  }

  /** The selected track's ハモリ changed: kept, heard, one undo step. */
  private changeHarmony(change: (h: Harmony) => void): void {
    const t = this.track;
    change(t.harmony);
    this.showHarmony();
    this.reload();
    this.scheduleSave();
    this.commit();
  }

  /** The key the whole song's melodic notes suggest, for the ハモリ. */
  private estimateHarmonyKey(): void {
    const notes = this.project.tracks.filter((t) => t.kind === "melodic").flatMap((t) => t.notes);
    if (!notes.length) return;
    const found = estimateKey(notes);
    this.changeHarmony((h) => {
      h.key = found.key;
      h.minor = found.minor;
    });
    this.info.textContent = `曲の音符から、キーを ${this.harmonyKey.selectedOptions[0]?.textContent ?? ""}${found.minor ? "短調" : "長調"}と推定しました。`;
  }

  /** The selected track's ハモリ on screen. */
  private showHarmony(): void {
    const h = this.track.harmony;
    this.harmonyOn.checked = h.on;
    this.harmonyKey.value = String(h.key);
    this.harmonyMode.value = h.minor ? "minor" : "major";
    for (const b of this.harmonyVoiceButtons) b.classList.toggle("on", h.voices.includes(Number(b.dataset.steps)));
    this.harmonyLevel.value = String(h.level);
    for (const x of [this.harmonyKey, this.harmonyMode, this.harmonyLevel, ...this.harmonyVoiceButtons]) x.disabled = !h.on;
    this.harmonyNote.textContent = h.on && this.track.glide > 0 ? "ポルタメント中は単音なので、ハモリは鳴りません" : h.on && !h.voices.length ? "足す声を選んでください" : "";
  }

  /** The song's tempo (the sampling side can take it for its export length). */
  /** The keyboard in the 曲 view: the selected track — its cut (or the kit, for a drum track) and its effects. */
  liveTarget(): { instrument: string | null; drum: boolean; fx: FxSettings } {
    const t = this.track;
    const own = t.kind === "melodic" && t.instrument && t.instrument !== BACKING ? t.instrument : null;
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

/**
   * A long recording joins the project, on a new audio track of its own: one clip from the song's start, as long as it is.
   * (The material list keeps it; the 素材 side never shows it.)
   */
  addLongAudio(material: { id: string; name: string }, seconds: number): void {
    if (!this.project.materials.some((m) => m.id === material.id)) this.project.materials.push({ ...material, long: true });
    const t = newAudioTrack(material.name.replace(/\.[^.]+$/, "").slice(0, 30) || "原曲", material.id);
    t.notes = [{ id: newId(), start: 0, length: Math.max(1 / 16, secToBeats(seconds, this.project)), pitch: 0, velocity: 1, clip: { material: material.id, offset: 0 } }];
    this.project.tracks.push(t);
    this.selected = this.project.tracks.length - 1;
    this.showTrackInRoll();
    this.reload();
    this.renderTracks();
    this.showRoot();
    this.refreshButtons();
    this.onTrackChange();
    this.scheduleSave();
    this.commit();
    this.info.textContent = `「${material.name}」を音声トラック「${t.name}」に置きました(曲の頭から)。ずれていればクリップをドラッグで動かします。書き出す曲にも入ります(入れないならミュート)。`;
  }

  /** The long recordings, each with a way out. */
  private renderLongList(): void {
    const long = this.project.materials.filter((m) => m.long);
    this.longList.hidden = long.length === 0;
    this.longList.replaceChildren(
      el("span", { className: "fine", textContent: "原曲・伴奏:" }),
      ...long.map((m) => el("span", { className: "tempo-item" }, [el("span", { className: "fine", textContent: m.name }), armOnce(button("外す", "small", () => {}, "この長い音声をプロジェクトから外します(置いたクリップは鳴らなくなり、元に戻せません)"), "もう一度押すと外す", () => this.onRemoveLongAudio(m.id))])),
    );
  }

  /** The names of the tracks that play a cut (shown with it; a warning before it goes). */
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
    this.resetUndo();
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

  /** A material leaves the project: tracks that played one of its cuts play nothing until another is chosen (an audio track's clips of it go silent). */
  removeMaterial(id: string): void {
    this.project.materials = this.project.materials.filter((m) => m.id !== id);
    for (const t of this.project.tracks) {
      if (t.instrument?.startsWith(`${id}/`) || (t.kind === "audio" && t.instrument === id)) t.instrument = null;
    }
    if (this.project.editing === id) this.project.editing = this.project.materials.at(-1)?.id ?? null;
    this.renderTracks();
    this.reload();
    this.scheduleSave();
  }

  /** Another material in a material's place (「このプロジェクト用に分ける」): the list, the one edited, and every track and clip that played it. */
  replaceMaterial(from: string, to: ProjectMaterial): void {
    this.project.materials = this.project.materials.map((m) => (m.id === from ? { ...m, ...to } : m));
    if (this.project.editing === from) this.project.editing = to.id;
    for (const t of this.project.tracks) {
      if (t.instrument?.startsWith(`${from}/`)) t.instrument = `${to.id}/${t.instrument.slice(from.length + 1)}`;
      else if (t.kind === "audio" && t.instrument === from) t.instrument = to.id;
      for (const n of t.notes) if (n.clip?.material === from) n.clip = { ...n.clip, material: to.id };
    }
    this.scheduleSave();
  }

  /** 素材を切り詰める: the material's clips read `from` seconds earlier in its (shorter) recording. */
  trimMaterialClips(material: string, from: number): number {
    const moved = trimClips(this.project.tracks, material, from, this.project);
    // (The undo history too: a step back must not bring clips back to where the cut-away audio was.)
    const shift = (json: string) => {
      const state = JSON.parse(json) as { tracks?: unknown };
      return trimClips(state.tracks, material, from, this.project) ? JSON.stringify(state) : json;
    };
    this.undoStack = this.undoStack.map(shift);
    this.redoStack = this.redoStack.map(shift);
    this.lastState = shift(this.lastState);
    if (moved) {
      this.reload();
      this.scheduleSave();
    }
    return moved;
  }

  /** A material renamed: the song's list of them (the tracks' choices and the clips' labels follow). */
  renameMaterial(id: string, name: string): void {
    const m = this.project.materials.find((x) => x.id === id);
    if (!m) return;
    m.name = name;
    this.renderTracks();
    this.roll.draw();
    this.scheduleSave();
  }

  /** Whether a track plays a cut of this material, or has a clip of it. */
  usesMaterial(id: string): boolean {
    return this.project.tracks.some((t) => t.instrument?.startsWith(`${id}/`) || t.notes.some((n) => n.clip?.material === id));
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
    if (only && only.kind === "melodic" && only.instrument === null && edited) {
      only.instrument = edited;
      this.scheduleSave();
    }
    // A cut that is gone (removed on the sampling side): the track plays nothing. (An audio track names a material, not a cut.)
    for (const t of this.project.tracks) {
      if (t.kind === "melodic" && t.instrument && t.instrument !== BACKING && !options.some((o) => o.id === t.instrument)) t.instrument = null;
    }
    this.renderTracks();
    this.showRoot();
    if (this.track.kind === "drum") this.roll.setRows(this.rowKeys.map((k) => keyLabel(this.project.kit, k)));
  }

  private applyProject(): void {
    // (The tempo the keyboard's and the master's synced effects follow while stopped.)
    this.client.setTempo(this.project.bpm);
    this.selected = Math.min(this.selected, this.project.tracks.length - 1);
    this.bpmInput.value = String(this.project.bpm);
    this.showTimeSig();
    this.renderTempos();
    this.roll.setLoop(this.project.loop);
    this.showTrackInRoll();
    if (this.track.kind === "melodic") this.roll.frame(60);
    this.sendLoop();
    this.client.setMasterFx(this.project.masterFx);
    this.renderTracks();
    this.refreshButtons();
    this.showPosition(this.from);
    this.onTrackChange();
  }

  private changed(notes: Note[]): void {
    this.track.notes = this.track.kind === "drum" ? notes.map((n) => ({ ...n, pitch: this.rowKeys[n.pitch] ?? n.pitch })) : notes;
    this.closeMenu();
    this.info.textContent = "";
    this.reload();
    this.scheduleSave();
    this.renderTracks();
    this.commit();
  }

  // ------------------------------------------------------------- undo

  /** The song as an undo step keeps it (the kit, the materials and the loop are not part of it). */
  private state(): string {
    const { kit: _kit, materials: _materials, editing: _editing, loop: _loop, ...song } = this.project;
    return JSON.stringify(song);
  }

  /** A change is done: the song before it becomes a step to undo. */
  private commit(): void {
    clearTimeout(this.commitTimer);
    this.commitTimer = 0;
    const now = this.state();
    if (now === this.lastState) return;
    if (this.lastState) {
      this.undoStack.push(this.lastState);
      if (this.undoStack.length > 200) this.undoStack.shift();
    }
    this.redoStack = [];
    this.lastState = now;
    this.refreshUndo();
  }

  /** A slider being dragged (volume, pan, an effect): one step once it has settled. */
  private commitSoon(): void {
    clearTimeout(this.commitTimer);
    this.commitTimer = window.setTimeout(() => this.commit(), 600);
  }

  /** A fresh song (opened or switched to): nothing to undo. */
  private resetUndo(): void {
    clearTimeout(this.commitTimer);
    this.commitTimer = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.lastState = this.state();
    this.refreshUndo();
  }

  undo(): void {
    if (this.commitTimer) this.commit();
    const prev = this.undoStack.pop();
    if (prev === undefined) return;
    this.redoStack.push(this.lastState);
    this.restoreState(prev);
    this.info.textContent = "元に戻しました。";
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (next === undefined) return;
    this.undoStack.push(this.lastState);
    this.restoreState(next);
    this.info.textContent = "やり直しました。";
  }

  private restoreState(json: string): void {
    this.stop();
    const { kit, materials, editing, loop } = this.project;
    this.project = { ...sanitizeProject({ ...JSON.parse(json), kit, materials, editing, loop }), kit, materials, editing, loop };
    // (A material taken out of the song since: its tracks play nothing, as they did when it went.)
    const present = new Set(materials.map((m) => m.id));
    for (const t of this.project.tracks) {
      if (t.instrument?.includes("/") && !present.has(t.instrument.split("/")[0])) t.instrument = null;
      else if (t.kind === "audio" && t.instrument && !present.has(t.instrument)) t.instrument = null;
    }
    this.lastState = this.state();
    this.applyProject();
    this.reload();
    for (const t of this.project.tracks) this.client.setTrackMix(t.id, this.mixOf(t));
    this.onLiveChange();
    this.scheduleSave();
    this.refreshUndo();
  }

  private refreshUndo(): void {
    this.undoButton.disabled = this.undoStack.length === 0 && !this.commitTimer;
    this.redoButton.disabled = this.redoStack.length === 0;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0 || this.commitTimer !== 0;
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
    const all = songParts(song).filter((p) => p.drumPitch === null);
    // A part that is another's exact copy (the same notes at the same time) is left out, and said so.
    const parts = all.filter((p) => p.duplicateOf === null || p.shiftSec !== 0);
    const copies = all.length - parts.length;
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
    // Parts the file left nameless ("MIDI Out #3"): named by what they play (their GM instrument, or their role).
    const programs = parts.map((part) => song.tracks.find((t) => part.id === `t${t.index}` || part.id.startsWith(`t${t.index}c`) || part.id === `t${t.index}d`)?.program ?? null);
    autoNames(added, programs).forEach((name, i) => {
      if (name) added[i].name = name;
    });
    this.project.tracks = [...this.project.tracks.filter((t) => t.notes.length > 0), ...added];
    // (Kept to 0.001 BPM: a rounded tempo drifts from the file over a song — a video timed to the MIDI would too.)
    const exact = (bpm: number) => Math.round(bpm * 1000) / 1000;
    setTimeSig(this.project, song.timeSig?.num ?? 4, song.timeSig?.den ?? 4);
    this.showTimeSig();
    setTempoList(this.project, [{ beat: 0, bpm: exact(song.bpm) }, ...song.tempos.map((c) => ({ beat: c.beat, bpm: exact(c.bpm) }))]);
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
    this.commit();
    const tempo = this.project.tempos.length ? `、途中のテンポ変更 ${this.project.tempos.length} か所` : "";
    this.info.textContent = `「${file.name}」のパート ${added.length} 本をトラックにしました(${this.project.bpm} BPM${tempo})。${leadTrack && this.editedInstrument ? `いちばん音符の多い「${leadTrack.name}」は編集中の音源で、` : ""}ほかは簡易シンセで鳴ります。素材で鳴らすには、トラックの音源を選び直してください。${copies ? `(ほかのパートとまったく同じ中身のパート ${copies} 本は省きました。)` : ""}`;
  }

  // ------------------------------------------------------------- tracks

  /** The roll shows the selected track: keys for a melodic one, its rows for a drum track. */
  private showTrackInRoll(): void {
    const t = this.track;
    this.glideRow.hidden = t.kind !== "melodic";
    const audio = t.kind === "audio";
    this.roll.noteFactory = audio ? (start) => this.newClip(start) : null;
    this.roll.splitNote = audio ? (n, at) => (n.clip ? { clip: { ...n.clip, offset: n.clip.offset + beatsToSec(at, this.project) - beatsToSec(n.start, this.project) } } : {}) : null;
    this.roll.noteLabel = audio ? (n) => (n.clip ? (this.project.materials.find((x) => x.id === n.clip!.material)?.name ?? "(なくなった素材)") : "") : null;
    this.glideSelect.value = String(GLIDES.some(([v]) => v === t.glide) ? t.glide : 0);
    this.showHarmony();
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
    } else if (audio) {
      // One row: the clips side by side.
      this.rowKeys = [];
      this.roll.pitchToKey = null;
      this.roll.keyToPitch = null;
      this.roll.setRows(["音声"]);
      this.roll.setNotes(t.notes.map((n) => ({ ...n, pitch: 0 })));
    } else {
      this.roll.pitchToKey = null;
      this.roll.keyToPitch = null;
      this.roll.setRows(null);
      this.roll.setNotes(t.notes);
    }
    if (t.kind !== "melodic") this.roll.frame(0);
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
    this.commit();
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
      const input = el("input", { type: "number", min: "20", max: "400", step: "any", inputMode: "decimal", value: String(c.bpm), ariaLabel: `${where(c.beat)}からの BPM`, className: "tempo-bpm" });
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
    this.renderMarkers();
  }

  /** The markers: each a jump, its name, ×; and one more at the position. */
  private renderMarkers(): void {
    const bpb = this.project.beatsPerBar;
    const where = (beat: number) => {
      const bar = Math.floor(beat / bpb + 1e-9);
      const inBar = +(beat - bar * bpb + 1).toFixed(2);
      return inBar === 1 ? `${bar + 1} 小節` : `${bar + 1} 小節 ${inBar} 拍`;
    };
    const items = this.project.markers.map((m, i) => {
      const jump = button(`▸ ${where(m.beat)}`, "small", () => this.seekTo(m.beat), "ここへ再生位置を動かします");
      const name = el("input", { type: "text", value: m.name, maxLength: 40, ariaLabel: `${where(m.beat)}のマーカーの名前`, className: "marker-name" });
      name.addEventListener("change", () => {
        m.name = name.value.trim() || "マーカー";
        this.roll.setMarkers(this.project.markers);
        this.scheduleSave();
        this.commit();
      });
      return el("span", { className: "tempo-item" }, [
        jump,
        name,
        button("×", "small", () => {
          this.project.markers.splice(i, 1);
          this.renderMarkers();
          this.scheduleSave();
          this.commit();
        }, "このマーカーを消す"),
      ]);
    });
    this.markerList.replaceChildren(
      el("span", { className: "fine", textContent: this.project.markers.length ? "マーカー:" : "マーカーなし" }),
      ...items,
      button("＋ 再生位置にマーカー", "small", () => this.addMarker(), "再生位置のある拍に、名前の付いた目印(Aメロ・サビなど)を置きます"),
    );
    this.roll.setMarkers(this.project.markers);
  }

  private addMarker(): void {
    const beat = Math.max(0, Math.round(this.currentBeat() * 4) / 4);
    if (this.project.markers.some((m) => Math.abs(m.beat - beat) < 1e-9)) return;
    const names = ["イントロ", "Aメロ", "Bメロ", "サビ", "間奏", "Cメロ", "ラスサビ", "アウトロ"];
    const name = names[this.project.markers.length] ?? `マーカー ${this.project.markers.length + 1}`;
    this.project.markers = [...this.project.markers, { beat, name }].sort((a, b) => a.beat - b.beat);
    this.renderMarkers();
    this.scheduleSave();
    this.commit();
  }

  /** The playing position moved to a beat (a marker's). */
  private seekTo(beat: number): void {
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    this.from = beatsToSec(beat, this.project);
    this.showPosition(this.from);
    this.roll.setPlayhead(beat);
    if (wasPlaying) this.toggle();
  }

  private showTimeSig(): void {
    this.sigNum.value = String(this.project.timeSig.num);
    this.sigDen.value = String(this.project.timeSig.den);
    this.roll.setBeatsPerBar(this.project.beatsPerBar);
  }

  /** A new time signature: the bar lines, the metronome and the bar operations follow (the notes stay where they are). */
  private setTimeSignature(num: number, den: number): void {
    setTimeSig(this.project, num, den);
    this.showTimeSig();
    this.renderTempos();
    this.refreshSeekRange(this.currentBeat());
    this.showPosition(this.from);
    if (this.playing) this.reload();
    this.scheduleSave();
    this.commit();
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
    if (!this.playing) this.client.setTempo(this.project.bpm);
    this.from = beatsToSec(position, this.project);
    this.renderTempos();
    this.reload();
    this.showPosition(this.from);
    this.scheduleSave();
    this.commit();
  }

  /** How long a material's recording is (seconds), when the page has it. */
  materialSeconds: (id: string) => number | null = () => null;

  /** A clip tapped onto an audio track: the track's material, whole, from its start. */
  private newClip(start: number): Partial<Note> | null {
    const material = this.track.instrument;
    if (!material || !this.project.materials.some((m) => m.id === material)) {
      this.info.textContent = "トラック一覧で、置く素材を選んでください。";
      return null;
    }
    const sec = this.materialSeconds(material) ?? 2;
    const from = beatsToSec(start, this.project);
    return { pitch: 0, velocity: 1, length: Math.max(1 / 16, secToBeats(from + sec, this.project) - start), clip: { material, offset: 0 } };
  }

  /** Inserts, deletes or duplicates the loop range on every track (notes and lines). */
  private arrange(kind: ArrangeKind): void {
    const { start, end } = this.project.loop;
    // (No question first: it is one step to undo, and the message says so.)
    const range = this.rangeText();
    arrange(this.project, kind, start, end);
    this.afterArrange();
    this.commit();
    this.refreshButtons();
    this.info.textContent = kind === "insert" ? "空白を入れました。" : kind === "delete" ? `${range}を全トラックから削除して詰めました。「元に戻す」(Ctrl + Z)で戻せます。` : "複製しました(ループ範囲は複製した側へ移りました)。";
  }

  /** Every track changed at once: the roll shows the track afresh. */
  private afterArrange(): void {
    this.renderTempos();
    this.bpmInput.value = String(this.project.bpm);
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
    [...this.mixStrips.children].forEach((strip, i) => strip.classList.toggle("selected", i === index));
    this.renderPads();
    this.showRoot();
    this.refreshButtons();
    this.onTrackChange();
  }

  /** A new track playing a cut (the 素材 side's 「この音源でトラックを作る」), selected. */
  addTrackWith(instrument: string, name: string): void {
    this.addTrack("melodic", instrument, name);
  }

  private addTrack(kind: Track["kind"] = "melodic", instrument: string | null = this.editedInstrument, trackName?: string): void {
    const count = (k: Track["kind"]) => this.project.tracks.filter((x) => x.kind === k).length + 1;
    const name = trackName ?? (kind === "drum" ? `ドラム ${count("drum")}` : kind === "audio" ? `音声 ${count("audio")}` : `トラック ${this.project.tracks.length + 1}`);
    const t =
      kind === "drum"
        ? newDrumTrack(name)
        : kind === "audio"
          ? newAudioTrack(name, this.project.editing ?? this.project.materials[0]?.id ?? null)
          : newTrack(name, instrument);
    this.project.tracks.push(t);
    this.selected = this.project.tracks.length - 1;
    this.showTrackInRoll();
    this.reload();
    this.renderTracks();
    this.showRoot();
    this.refreshButtons();
    this.onTrackChange();
    this.scheduleSave();
    this.commit();
  }

  /** The selected track's notes all moved up or down (a melodic track: its key, or an octave). */
  private transposeTrack(semitones: number): void {
    const t = this.track;
    if (t.kind !== "melodic" || !t.notes.length) return;
    const out = t.notes.some((n) => n.pitch + semitones < 0 || n.pitch + semitones > 127);
    t.notes = t.notes.map((n) => ({ ...n, pitch: clampPitch(n.pitch + semitones) }));
    this.showTrackInRoll();
    this.reload();
    this.renderTracks();
    this.scheduleSave();
    this.commit();
    const what = Math.abs(semitones) === 12 ? "1 オクターブ" : `${Math.abs(semitones)} 半音`;
    this.info.textContent = `「${t.name}」を${what}${semitones > 0 ? "上げ" : "下げ"}ました。${out ? "(鍵盤の端を超える音は端で止めました)" : ""}`;
  }

  /** A copy of the selected track (notes, effects, mixer, lines), right after it. */
  private duplicateTrack(): void {
    const t = this.track;
    const copy: Track = { ...structuredClone(t), id: newTrackId(), name: `${t.name} のコピー`.slice(0, 30), notes: t.notes.map((n) => ({ ...structuredClone(n), id: newId() })), solo: false };
    this.project.tracks.splice(this.selected + 1, 0, copy);
    this.selected++;
    this.showTrackInRoll();
    this.reload();
    this.renderTracks();
    this.showRoot();
    this.refreshButtons();
    this.onTrackChange();
    this.scheduleSave();
    this.commit();
  }

  private removeTrack(index: number): void {
    if (this.project.tracks.length < 2) return;
    const t = this.project.tracks[index];
    this.project.tracks.splice(index, 1);
    this.selected = Math.min(this.selected > index ? this.selected - 1 : this.selected, this.project.tracks.length - 1);
    this.showTrackInRoll();
    this.reload();
    this.renderTracks();
    this.showRoot();
    this.onTrackChange();
    this.scheduleSave();
    this.commit();
    // (No question first: it is one step to undo, and the message says so.)
    this.info.textContent = `トラック「${t.name}」${t.notes.length ? `(音符 ${t.notes.length} 個)` : ""}を消しました。「元に戻す」(Ctrl + Z)で戻せます。`;
  }

  /** Volume, pan, mute, solo of a track: heard at once, kept. */
  private mix(t: Track, change: (t: Track) => void): void {
    change(t);
    this.syncMix(t);
    this.client.setTrackMix(t.id, this.mixOf(t));
    this.scheduleSave();
    this.commitSoon();
    this.refreshUndo();
  }

  /**
   * A track's mute, solo, volume (dB, with its meter) and pan, for one place — its 曲 row, or (vertical) its ミックス
   * strip — linked with the other place's (syncMix).
   */
  private mixControlsFor(t: Track, vertical = false) {
    const mute = button("M", `small toggle${t.mute ? " on" : ""}`, () => this.mix(t, (x) => (x.mute = !x.mute)), "ミュート");
    const solo = button("S", `small toggle${t.solo ? " on" : ""}`, () => this.mix(t, (x) => (x.solo = !x.solo)), "ソロ");
    // The volume in dB (0 dB = as it is, up to +6, the bottom = silent).
    const volume = el("input", { type: "range", min: String(FADER_FLOOR_DB), max: "6", step: "0.1", value: String(gainToDb(t.gain)), ariaLabel: `${t.name}の音量(dB)`, className: vertical ? "vertical-fader" : "" });
    volume.addEventListener("input", () => this.mix(t, (x) => (x.gain = dbToGain(Number(volume.value)))));
    volume.addEventListener("dblclick", () => this.mix(t, (x) => (x.gain = 1)));
    const volumeText = el("span", { className: "fine num fader-db", textContent: dbText(gainToDb(t.gain)) });
    const meterFill = el("span", { className: "meter-fill" });
    const pan = el("input", { type: "range", min: "-1", max: "1", step: "0.05", value: String(t.pan), ariaLabel: `${t.name}のパン` });
    pan.addEventListener("input", () => this.mix(t, (x) => (x.pan = Number(pan.value))));
    pan.addEventListener("dblclick", () => this.mix(t, (x) => (x.pan = 0)));
    const meter = this.trackMeters.get(t.id) ?? { fills: [], db: -Infinity };
    meter.fills.push(meterFill);
    this.trackMeters.set(t.id, meter);
    const links = this.mixLinks.get(t.id) ?? { mutes: [], solos: [], volumes: [], texts: [], pans: [] };
    links.mutes.push(mute);
    links.solos.push(solo);
    links.volumes.push(volume);
    links.texts.push(volumeText);
    links.pans.push(pan);
    this.mixLinks.set(t.id, links);
    return { mute, solo, volume, volumeText, meterFill, pan };
  }

  /** A track's mix as it now is, in every place it is shown (the one being dragged is left alone). */
  private syncMix(t: Track): void {
    const links = this.mixLinks.get(t.id);
    if (!links) return;
    for (const b of links.mutes) b.classList.toggle("on", t.mute);
    for (const b of links.solos) b.classList.toggle("on", t.solo);
    const db = gainToDb(t.gain);
    for (const v of links.volumes) if (document.activeElement !== v || Math.abs(Number(v.value) - db) > 0.05) v.value = String(db);
    for (const x of links.texts) x.textContent = dbText(db);
    for (const p of links.pans) if (document.activeElement !== p || Math.abs(Number(p.value) - t.pan) > 0.01) p.value = String(t.pan);
  }

  /** What a track plays, in a few words (under its name in the ミックス view). */
  private playsLabel(t: Track): string {
    if (t.kind === "drum") return "ドラムキット";
    if (t.kind === "audio") return "音声";
    if (t.instrument === BACKING) return "簡易シンセ";
    return this.options.find((o) => o.id === t.instrument)?.label ?? "(音源なし)";
  }

  /**
   * A track playing a cut far from where it was recorded (崩れ・こもり): what to say, or null. Far down a voice turns
   * muddy and breaks up, far up it turns thin; a lower material, the plain synth, or the track an octave over helps.
   */
  private farWarning(t: Track): string | null {
    if (t.kind !== "melodic" || !t.instrument || t.instrument === BACKING || !t.notes.length) return null;
    const root = this.options.find((o) => o.id === t.instrument)?.note;
    if (root === undefined) return null;
    const { below, above } = rangeFromRoot(t.notes, root);
    if (below >= FAR_BELOW) return `音符が音源の録音した高さより最大 ${below} 半音(約 ${(below / 12).toFixed(1)} オクターブ)下まであります。声などをここまで下げると、こもったり崩れたりします。低い声・音の素材にするか、音源を「簡易シンセ」にするか、曲(打ち込み)の画面の「選んだトラックを: 1 オクターブ上げる」を試してください。`;
    if (above >= FAR_ABOVE) return `音符が音源の録音した高さより最大 ${above} 半音(約 ${(above / 12).toFixed(1)} オクターブ)上まであります。ここまで上げると細く、キンキンしやすくなります。高い声・音の素材にするか、曲(打ち込み)の画面の「選んだトラックを: 1 オクターブ下げる」を試してください。`;
    return null;
  }

  /** Each track's role: set by hand (the ミックス strip) or worked out from its notes. */
  roles(): Role[] {
    return trackRoles(this.project.tracks).map((r) => r.role);
  }

  /** A melodic track's role, chosen by hand: 自動 (what it would be worked out as, shown) or one of the parts. */
  private roleSelect(t: Track, now: Role): HTMLElement {
    if (t.kind !== "melodic") return el("span", { className: "fine mix-role", textContent: ROLE_NAMES[now] });
    const i = this.project.tracks.indexOf(t);
    const worked = t.role ? trackRoles(this.project.tracks.map((x) => (x === t ? { ...x, role: null } : x)))[i].role : now;
    const parts: Role[] = ["lead", "bass", "chords", "backing", "harmony"];
    const select = el("select", { className: "mix-role", ariaLabel: "トラックの役割", title: "自動の音量・EQ・サイドチェーン・残響が使う役割。「自動」は音符から判定します" }, [
      el("option", { value: "", textContent: `自動(${ROLE_NAMES[worked]})` }),
      ...parts.map((r) => el("option", { value: r, textContent: ROLE_NAMES[r] })),
      el("option", { value: "bass-main", textContent: "ベース(メイン)" }),
    ]);
    select.value = t.main && t.role === "bass" ? "bass-main" : (t.role ?? "");
    select.addEventListener("change", () => {
      // ベース(メイン): the bass, and the one that takes the largest share of the bass's level.
      t.main = select.value === "bass-main";
      t.role = (t.main ? "bass" : select.value || null) as Role | null;
      this.scheduleSave();
      this.commit();
      // (Another track's worked-out role may change with it: a lead set by hand.)
      this.renderMix();
    });
    return select;
  }

  /** How many octaves would bring a track's notes nearest its cut's recorded pitch (0: none, or not on a cut). */
  private octaveFitOf(t: Track): number {
    if (t.kind !== "melodic" || !t.instrument || t.instrument === BACKING) return 0;
    const root = this.options.find((o) => o.id === t.instrument)?.note;
    return root === undefined ? 0 : octaveFit(t.notes, root);
  }

  /** The track row's button for it (none when no octave would help). */
  private octaveFitButton(i: number): HTMLElement[] {
    const k = this.octaveFitOf(this.project.tracks[i]);
    if (!k) return [];
    return [button(`${Math.abs(k)} オクターブ${k > 0 ? "上げ" : "下げ"}て合わせる`, "small", () => this.fitOctave(i), "音符をまとめてオクターブ移動し、音源の録音した高さに近づけます(曲で鳴る高さも変わります。元に戻すで戻せます)")];
  }

  /** 音域を合わせる: the track's notes moved by those octaves (one step to undo). */
  private fitOctave(i: number): void {
    const t = this.project.tracks[i];
    if (!t) return;
    const k = this.octaveFitOf(t);
    if (!k) return;
    t.notes = t.notes.map((n) => ({ ...n, pitch: clampPitch(n.pitch + 12 * k) }));
    if (i === this.selected) this.showTrackInRoll();
    this.reload();
    this.renderTracks();
    this.renderMix();
    this.scheduleSave();
    this.commit();
    this.info.textContent = `「${t.name}」の音符を ${Math.abs(k)} オクターブ${k > 0 ? "上げ" : "下げ"}て、音源の録音した高さに近づけました。「元に戻す」で戻せます。`;
  }

  /** New gains from 音量を合わせる (null: left), applied as one step to undo. */
  applyGains(gains: readonly (number | null)[], reference: number, loweredDb = 0): void {
    let moved = 0;
    this.project.tracks.forEach((t, i) => {
      const g = gains[i];
      if (g === null || g === undefined || Math.abs(20 * Math.log10(Math.max(1e-6, g) / Math.max(1e-6, t.gain))) < 0.1) return;
      t.gain = g;
      this.syncMix(t);
      this.client.setTrackMix(t.id, this.mixOf(t));
      moved++;
    });
    this.scheduleSave();
    this.commit();
    const ref = this.project.tracks[reference];
    this.info.textContent = moved
      ? `${moved} 本のトラックの音量を、「${ref?.name ?? "?"}」(基準)に対する役割ごとの目安に合わせました。${loweredDb > 0.05 ? `音量の上限まで上げても届かないトラックがあったので、基準も含めて全体を ${loweredDb.toFixed(1)} dB 下げてあります(足りない分はマスターや書き出しの音量で)。` : "基準は動かしていません。"}「元に戻す」で戻せます。`
      : "音量を動かすトラックはありませんでした(測れる音のあるトラックがないか、すでに目安どおりです)。";
  }

  /** New effects for some tracks (null: left), applied as one step to undo, and what was done said. */
  applyTrackFx(fxs: readonly (FxSettings | null)[], message: string): void {
    this.project.tracks.forEach((t, i) => {
      const fx = fxs[i];
      if (!fx) return;
      t.fx = fx;
      this.client.setTrackMix(t.id, this.mixOf(t));
    });
    this.renderTracks();
    this.renderMix();
    this.onTrackChange();
    this.onLiveChange();
    this.scheduleSave();
    this.commit();
    this.info.textContent = message;
  }

  /**
   * One kind of automatic effect over the tracks: where `want` gives one, it goes in (over an earlier automatic one,
   * or where there was none); where it gives none, an earlier automatic one comes out; one set by hand is kept.
   * The new effects (null: left), and the counts.
   */
  private autoEffect<K extends "duck" | "reverb">(kind: K, want: (t: Track, i: number) => FxSettings[K] | null, label: (t: Track, fx: FxSettings[K]) => string) {
    const bpm = this.project.bpm;
    let kept = 0;
    let removed = 0;
    const done: string[] = [];
    const fxs = this.project.tracks.map((t, i) => {
      const next = t.notes.length ? want(t, i) : null;
      const mine = madeByAuto(t.fx, kind, bpm);
      if (!mine) {
        if (next) kept++;
        return null;
      }
      const fx = structuredClone(t.fx);
      if (next) {
        fx[kind] = next;
        done.push(label(t, next));
        return fx;
      }
      if (!t.fx[kind].on) return null;
      fx[kind] = { ...fx[kind], on: false };
      delete fx[kind].auto;
      removed++;
      return fx;
    });
    return { fxs, done, kept, removed };
  }

  /** キックに合わせて沈める: the bass and the held accompaniment duck to the drum tracks' kick. */
  autoDuck(): void {
    const hasKick = this.project.tracks.some((t) => t.kind === "drum" && t.notes.some((n) => KICK_KEYS.includes(n.pitch)));
    if (!hasKick) {
      this.info.textContent = "キック(ドラムトラックの 35・36 番の音符)がないので、沈めるきっかけがありません。";
      return;
    }
    const roles = this.roles();
    const { fxs, done, kept, removed } = this.autoEffect(
      "duck",
      (t, i) => kickDuck(roles[i], this.project.bpm, t.fx.duck, medianLength(t.notes)),
      (t, d) => `「${t.name}」${d.depthDb} dB・${d.releaseMs} ms で戻る`,
    );
    const notes = `${removed ? `前に自動で入れたサイドチェーンを ${removed} 本から外しました。` : ""}${kept ? `サイドチェーンを自分で入れていた ${kept} 本はそのままです。` : ""}`;
    this.applyTrackFx(
      fxs,
      done.length
        ? `キックで沈むサイドチェーンを入れました: ${done.join("、")}。${notes}「元に戻す」で戻せます。`
        : `沈めるトラック(ベースと、音を伸ばす和音・伴奏・ハモリ)がありませんでした。${notes}`,
    );
  }

  /** 残響を付ける: a room on each track by its part and the tempo. */
  autoRooms(): void {
    const roles = this.roles();
    const { fxs, done, kept, removed } = this.autoEffect(
      "reverb",
      (t, i) => roomFor(roles[i], this.project.bpm, t.fx.reverb, medianLength(t.notes)),
      (t, r) => `「${t.name}」${Math.round(r.mix * 100)}%`,
    );
    const notes = `${removed ? `前に自動で入れたリバーブを ${removed} 本から外しました。` : ""}${kept ? `リバーブを自分で入れていた ${kept} 本はそのままです。` : ""}`;
    this.applyTrackFx(
      fxs,
      done.length
        ? `リバーブを入れました(かかる量): ${done.join("、")}。長さはテンポに合わせました。${notes}「元に戻す」で戻せます。`
        : `残響を付けるトラック(メロディ・和音・伴奏・ハモリのうち、16 分音符より長い音が中心のもの)がありませんでした。${notes}`,
    );
  }

  /** パンを自動で広げる: the chords and accompaniment out to the sides, the rest in the middle (tracks with a pan line left alone). */
  /** (`centredOnly`: まとめて自動ミックス — only the tracks still in the middle move, a pan set by hand stays.) */
  spreadPans(centredOnly = false): void {
    const pans = spreadPans(this.project.tracks);
    let moved = 0;
    this.project.tracks.forEach((t, i) => {
      const p = pans[i];
      if (p === null || t.panAuto.length || Math.abs(t.pan - p) < 1e-6 || (centredOnly && Math.abs(t.pan) > 1e-6)) return;
      t.pan = p;
      this.syncMix(t);
      this.client.setTrackMix(t.id, this.mixOf(t));
      moved++;
    });
    this.scheduleSave();
    this.commit();
    this.info.textContent = moved
      ? `${moved} 本のトラックのパンを動かしました(ドラム・ベース・メロディは中央、和音と伴奏を左右へ)。「元に戻す」(Ctrl + Z)で戻せます。`
      : "動かすトラックはありませんでした(左右に振る和音・伴奏のトラックがないか、すでにその位置です)。";
  }

  /** トラック名を自動で付ける: the nameless tracks named by what they play. */
  nameTracks(): void {
    const names = autoNames(this.project.tracks);
    let named = 0;
    this.project.tracks.forEach((t, i) => {
      const n = names[i];
      if (!n) return;
      t.name = n;
      named++;
    });
    this.renderTracks();
    this.onTrackChange();
    this.scheduleSave();
    this.commit();
    this.info.textContent = named ? `${named} 本のトラックに名前を付けました。「元に戻す」で戻せます。` : "名前のないトラック(「MIDI Out #3」のような名前)はありませんでした。";
  }

  /** A line under the 音域のバランス button (progress, or why nothing was done). */
  balanceSays(text: string): void {
    this.balanceStatus.textContent = text;
  }

  /** The fitted master EQ applied (one step to undo), what it did said, and the chart drawn. */
  applyBalance(result: BalanceResult, style: BalanceStyle): void {
    this.updateMasterFx((fx) => {
      fx.eq = result.eq;
    });
    this.onTrackChange();
    const e = result.eq;
    const signed = (db: number) => (db === 0 ? "±0" : `${db > 0 ? "+" : "−"}${Math.abs(db).toFixed(1)}`);
    const hz = (v: number) => (v >= 1000 ? `${+(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`);
    this.balanceStatus.textContent = `「${BALANCE_STYLES[style]}」に寄せて、マスター EQ を ローカット ${hz(e.lowCutHz)}・低音(${hz(e.lowHz)} 以下)${signed(e.lowDb)} dB・中音(${hz(e.midHz)})${signed(e.midDb)} dB・高音(${hz(e.highHz)} 以上)${signed(e.highDb)} dB にしました。「元に戻す」で戻せます。`;
    this.balanceShown = { result, style };
    this.drawBalance();
    // The lows still well short after the EQ (30–80 Hz, 6 dB and more under the target): the EQ cannot do it.
    const lows = BAND_HZ.map((hz, j) => (hz >= 30 && hz <= 80 ? result.after[j] : null)).filter((x): x is number => x !== null);
    const short = lows.reduce((a, b) => a + b, 0) / Math.max(1, lows.length);
    this.lowsShortDb = short;
    this.bassFill.hidden = !(short < -6);
  }

  /** What stands out on a track for the diagnosis: its range, a fader at the top, a heavy room set by hand. */
  trackWarnings(i: number): string[] {
    const t = this.project.tracks[i];
    if (!t) return [];
    const out: string[] = [];
    if (this.roles()[i] === "bass" && t.notes.length) {
      // The lows are the bass's job: a low cut over its lowest notes, or a swaying pan, works against it.
      const lowest = 440 * 2 ** ((Math.min(...t.notes.map((n) => n.pitch)) - 69) / 12);
      // (Only a cut over the lowest note itself: one a little under it barely touches it.)
      if (t.fx.eq.on && t.fx.eq.lowCutHz > lowest) out.push(`ローカット(${Math.round(t.fx.eq.lowCutHz)} Hz)が低い音(${Math.round(lowest)} Hz)を削っている`);
      if (t.fx.pan.on) out.push("オートパンで低音が左右に揺れる");
      if (t.fx.filter.on && t.fx.filter.type !== "lowpass") out.push("フィルターで低音が削れている");
    }
    if (this.project.tracks.some((x, j) => j !== i && x.name === t.name)) out.push("同じ名前のトラックがある");
    if (this.farWarning(t)) out.push("音源の高さから離れすぎ");
    if (t.gain >= MAX_TRACK_GAIN - 1e-6) out.push("音量が上限");
    if (t.fx.reverb.on && t.fx.reverb.mix >= 0.35) out.push(`残響が多め(${Math.round(t.fx.reverb.mix * 100)}%)`);
    if (t.fx.compressor.on && t.fx.compressor.makeupDb >= 6) out.push(`コンプのメイクアップが大きめ(+${t.fx.compressor.makeupDb} dB)`);
    return out;
  }

  /** A track name not taken yet ("シンセベース", else "シンセベース 2"…). */
  private freeName(base: string): string {
    const taken = new Set(this.project.tracks.map((t) => t.name));
    if (!taken.has(base)) return base;
    let k = 2;
    while (taken.has(`${base} ${k}`)) k++;
    return `${base} ${k}`;
  }

  /** How far 30–80 Hz stayed under the target after the last master EQ fit (dB, mean; null before any). */
  lowsShortDb: number | null = null;

  /** The style chosen for the master EQ (まとめて自動ミックス uses it too). */
  balanceStyle(): BalanceStyle {
    return this.balanceSelect.value as BalanceStyle;
  }

  /**
   * シンセベースを重ねる: the bass track (the one with the most notes among the bass parts on a material) copied onto
   * the 簡易シンセ's synth bass, right after it, with its effects and volume.
   */
  private layerSynthBass(): void {
    const roles = this.roles();
    if (this.project.tracks.some((t, i) => roles[i] === "bass" && t.instrument === BACKING && t.synth === "bass")) {
      this.info.textContent = "シンセベースのトラックはもうあります。音量を上げるか、「マスター EQ を目安に寄せる」をもう一度試してください。";
      return;
    }
    const candidates = this.project.tracks.map((t, i) => ({ t, i })).filter(({ t, i }) => roles[i] === "bass" && t.kind === "melodic" && t.notes.length);
    if (!candidates.length) {
      this.info.textContent = "ベースのトラックが見つかりません(ミックスの列で役割を「ベース」にすると選べます)。";
      return;
    }
    const { t, i } = candidates.reduce((a, b) => (b.t.notes.length > a.t.notes.length ? b : a));
    // (Down by octaves until its middle is at A2 or under: a bass line written high would add nothing under 80 Hz.)
    const pitches = t.notes.map((n) => n.pitch).sort((x, y) => x - y);
    let down = 0;
    while (pitches[pitches.length >> 1] - 12 * down > 45 && pitches[0] - 12 * (down + 1) >= 24) down++;
    // (Its effects start clean — the bass's low cut, a swept filter or an auto-pan would take away the very lows it is
    // there for — but it ducks to the kick as the bass does. In the middle.)
    const fx = structuredClone(DEFAULT_FX);
    if (t.fx.duck.on) fx.duck = structuredClone(t.fx.duck);
    const copy: Track = { ...structuredClone(t), id: newTrackId(), name: this.freeName("シンセベース"), instrument: BACKING, synth: "bass", role: "bass", solo: false, pan: 0, panAuto: [], fx, notes: t.notes.map((n) => ({ ...structuredClone(n), id: newId(), pitch: n.pitch - 12 * down })) };
    this.project.tracks.splice(i + 1, 0, copy);
    if (this.selected > i) this.selected++;
    this.reload();
    this.renderTracks();
    this.renderMix();
    this.onTrackChange();
    this.scheduleSave();
    this.commit();
    this.bassFill.hidden = true;
    this.info.textContent = `「${t.name}」の音符をシンセベースで重ねたトラックを足しました${down ? `(低音が出るよう ${down} オクターブ下)` : ""}。「音量を合わせる」と「マスター EQ を目安に寄せる」をもう一度押すと、足した分も含めて整います。「元に戻す」で戻せます。`;
  }

  /** ミックスを診断する: the table of what was measured, and what stands out. */
  showDiagnosis(rows: { name: string; role: string; lufs: number | null; peakDb: number | null; notes: string[] }[], song: { lufs: number; peakDb: number } | null, points: string[]): void {
    const f = (x: number | null, unit: string) => (x === null || !Number.isFinite(x) ? "—" : `${x.toFixed(1)} ${unit}`);
    const table = el("table", { className: "diagnosis-table fine" }, [
      el("tr", {}, ["トラック", "役割", "大きさ", "ピーク", "気になる点"].map((h) => el("th", { textContent: h }))),
      ...rows.map((r) => el("tr", {}, [r.name, r.role, f(r.lufs, "LUFS"), f(r.peakDb, "dB"), r.notes.join("・") || "—"].map((c) => el("td", { textContent: c })))),
    ]);
    this.diagnosis.replaceChildren(
      el("details", { open: true }, [
        el("summary", { textContent: `診断の結果${song ? `(曲全体 ${f(song.lufs, "LUFS")}・ピーク ${f(song.peakDb, "dBTP")})` : ""}` }),
        ...(points.length ? [el("ul", { className: "fine" }, points.map((p) => el("li", { textContent: p })))] : [el("p", { className: "fine", textContent: "目立った問題は見つかりませんでした。" })]),
        el("div", { className: "diagnosis-scroll" }, [table]),
      ]),
    );
  }
  /** The song against the target, band by band: the band around the target (±3 dB), before (thin) and after (thick). */
  private drawBalance(): void {
    const shown = this.balanceShown;
    const canvas = this.balanceCanvas;
    canvas.classList.toggle("on", !!shown);
    if (!shown) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const g = canvas.getContext("2d");
    if (!g) return;
    const css = getComputedStyle(canvas);
    const { before, after } = shown.result;
    const range = 15;
    const x = (j: number) => ((j + 0.5) / BAND_HZ.length) * canvas.width;
    const y = (db: number) => canvas.height * (0.5 - Math.max(-range, Math.min(range, db)) / (2 * range));
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = css.getPropertyValue("--line");
    g.globalAlpha = 0.35;
    g.fillRect(0, y(3), canvas.width, y(-3) - y(3));
    g.globalAlpha = 1;
    g.fillStyle = css.color;
    g.font = `${10 * dpr}px system-ui, sans-serif`;
    g.fillText("目安(±3 dB)", 4 * dpr, y(3) - 3 * dpr);
    for (const [hz, label] of [[100, "100"], [1000, "1k"], [10000, "10k"]] as const) {
      const j = BAND_HZ.findIndex((b) => b >= hz * 0.99);
      g.fillText(label, x(j) - 6 * dpr, canvas.height - 3 * dpr);
    }
    const line = (values: readonly number[], color: string, w: number) => {
      g.strokeStyle = color;
      g.lineWidth = w * dpr;
      g.beginPath();
      values.forEach((v, j) => (j ? g.lineTo(x(j), y(v)) : g.moveTo(x(j), y(v))));
      g.stroke();
    };
    // (Under 30 Hz nothing is aimed at: the low cut is there.)
    const from = BAND_HZ.findIndex((hz) => hz >= 30);
    line(before.map((v, j) => (j < from ? before[from] : v)), css.color, 1);
    line(after.map((v, j) => (j < from ? after[from] : v)), css.getPropertyValue("--accent") || "#7c5cff", 2.5);
    g.fillStyle = css.color;
    g.fillText("細線: 変える前 / 太線: 変えた後(上 = 多すぎ、下 = 足りない)", 4 * dpr, 12 * dpr);
  }

  /** The ミックス view on screen or not: the spectrum is drawn only while it is. */
  setMixVisible(on: boolean): void {
    cancelAnimationFrame(this.spectrumFrame);
    if (!on) return;
    this.drawBalance();
    const tick = () => {
      this.drawSpectrum();
      this.spectrumFrame = requestAnimationFrame(tick);
    };
    this.spectrumFrame = requestAnimationFrame(tick);
  }

  /** Third-octave bands from 25 Hz to 16 kHz, as bars, with where each band was loudest lately (a falling line). */
  private drawSpectrum(): void {
    const canvas = this.spectrumCanvas;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr)) canvas.width = Math.round(width * dpr);
    if (canvas.height !== Math.round(height * dpr)) canvas.height = Math.round(height * dpr);
    const g = canvas.getContext("2d");
    if (!g) return;
    const css = getComputedStyle(canvas);
    g.clearRect(0, 0, canvas.width, canvas.height);
    const spectrum = this.client.spectrum();
    const centres: number[] = [];
    for (let c = 25; c <= 16000; c *= 2 ** (1 / 3)) centres.push(c);
    const levels = new Float32Array(centres.length).fill(-120);
    if (spectrum) {
      const binHz = spectrum.sampleRate / 2 / spectrum.db.length;
      centres.forEach((c, j) => {
        const lo = Math.max(1, Math.floor(c / 2 ** (1 / 6) / binHz));
        const hi = Math.max(lo + 1, Math.ceil((c * 2 ** (1 / 6)) / binHz));
        let p = 0;
        for (let b = lo; b < hi && b < spectrum.db.length; b++) p += 10 ** (spectrum.db[b] / 10);
        levels[j] = p > 0 ? 10 * Math.log10(p) : -120;
      });
    }
    if (!this.spectrumHold || this.spectrumHold.length !== levels.length) this.spectrumHold = new Float32Array(levels.length).fill(-120);
    const hold = this.spectrumHold;
    // (-90 dB at the bottom, -10 dB at the top.)
    const y = (db: number) => canvas.height * (1 - Math.max(0, Math.min(1, (db + 90) / 80)));
    const barW = canvas.width / levels.length;
    // The usual regions behind the bars: low / low-mid (where mud gathers) / mid / high.
    const region = (from: number, to: number, label: string) => {
      const a = (Math.log(from / 25) / Math.log(16000 / 25)) * canvas.width;
      const b = (Math.log(to / 25) / Math.log(16000 / 25)) * canvas.width;
      g.fillStyle = css.getPropertyValue("--line");
      g.globalAlpha = 0.25;
      g.fillRect(a, 0, 1 * dpr, canvas.height);
      g.globalAlpha = 1;
      g.fillStyle = css.color;
      g.font = `${10 * dpr}px system-ui, sans-serif`;
      g.fillText(label, a + 3 * dpr, 12 * dpr);
      return b;
    };
    region(25, 250, "低域");
    region(250, 1000, "中低域");
    region(1000, 4000, "中域");
    region(4000, 16000, "高域");
    levels.forEach((db, j) => {
      hold[j] = Math.max(db, hold[j] - 0.4);
      g.fillStyle = css.getPropertyValue("--accent") || "#7c5cff";
      g.fillRect(j * barW + 1 * dpr, y(db), barW - 2 * dpr, canvas.height - y(db));
      g.fillStyle = css.color;
      g.fillRect(j * barW + 1 * dpr, y(hold[j]), barW - 2 * dpr, 1.5 * dpr);
    });
  }

  /** The ミックス view's strips: per track its name, mute / solo, pan, fader with meter, dB and effects; then the master's. */
  private renderMix(): void {
    const roles = trackRoles(this.project.tracks);
    const strips = this.project.tracks.map((t, i) => {
      const c = this.mixControlsFor(t, true);
      const fxOn = Object.values(t.fx).some((g) => (g as { on?: boolean }).on);
      const fx = button("FX", `small toggle${fxOn ? " on" : ""}`, () => {
        this.selectTrack(i);
        this.onOpenFx();
      }, fxOn ? "このトラックにエフェクトがかかっています(押すとエフェクトを開きます)" : "このトラックのエフェクトを開きます");
      const plays = this.playsLabel(t);
      const far = this.farWarning(t);
      const shift = far ? this.octaveFitOf(t) : 0;
      // What the automatic mixing put in (its own, not hand-set): a mark that opens the effects.
      const autos = (["eq", "duck", "reverb"] as const).filter((k) => t.fx[k].on && madeByAuto(t.fx, k, this.project.bpm)).map((k) => ({ eq: "EQ", duck: "沈め", reverb: "残響" })[k]);
      const autoMark = autos.length
        ? button(`自動 ${autos.join("・")}`, "small mix-auto", () => {
            this.selectTrack(i);
            this.onOpenFx();
          }, `自動ミックスで入れた設定: ${autos.join("・")}。押すとエフェクトを開きます(手で変えると自分の設定になり、自動では触らなくなります)`)
        : el("span", { className: "mix-auto" });
      const strip = el("div", { className: `mix-strip${i === this.selected ? " selected" : ""}` }, [
        el("span", { className: "mix-name", textContent: t.name, title: t.name }),
        el("span", { className: "fine mix-plays", textContent: plays, title: plays }),
        far
          ? shift
            ? button(`⚠ ${shift > 0 ? "+" : "−"}${Math.abs(shift)} oct`, "small warn mix-far", () => this.fitOctave(i), `${far}\n\n押すと、音符を ${Math.abs(shift)} オクターブ${shift > 0 ? "上げ" : "下げ"}て、録音した高さに近づけます(元に戻すで戻せます)。`)
            : el("span", { className: "warn fine mix-far", textContent: "⚠ 音域", title: far })
          : el("span", { className: "mix-far" }),
        this.roleSelect(t, roles[i].role),
        autoMark,
        el("span", { className: "row tight mix-ms" }, [c.mute, c.solo]),
        el("label", { className: "mix-pan fine" }, ["パン", c.pan]),
        el("span", { className: "mix-fader" }, [c.volume, el("span", { className: "meter vertical" }, [c.meterFill])]),
        c.volumeText,
        fx,
      ]);
      strip.addEventListener("pointerdown", (e) => {
        if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLButtonElement)) this.selectTrack(i);
      });
      return strip;
    });
    const master = el("div", { className: "mix-strip master" }, [
      el("span", { className: "mix-name", textContent: "マスター" }),
      el("span", { className: "mix-fader" }, [el("span", { className: "meter vertical tall" }, [this.masterFills[1]])]),
      this.masterTexts[1],
      this.clipMarks[1],
      button("FX", "small", () => this.onOpenMasterFx(), "マスター(曲全体)のエフェクトを開きます"),
    ]);
    this.mixStrips.replaceChildren(...strips, master);
  }

  /** The folded panel's line: how big the song is, and whether it plays. */
  private summarize(): void {
    const notes = this.project.tracks.reduce((n, t) => n + t.notes.length, 0);
    this.summaryInfo.textContent = `トラック ${this.project.tracks.length}・音符 ${notes}${this.playing ? "・再生中" : ""}`;
  }

  /** 選んだトラックを: moving its notes up or down needs a melodic track with notes. */
  private refreshTrackOps(): void {
    const t = this.track;
    const melodic = t.kind === "melodic" && t.notes.length > 0;
    for (const x of [this.trackOpButtons.down, this.trackOpButtons.up, this.trackOpButtons.octDown, this.trackOpButtons.octUp]) x.disabled = !melodic;
  }

  private renderTracks(): void {
    this.summarize();
    // (The lamps, meters and linked mix controls come back with the rows and strips below.)
    this.trackLamps = [];
    this.trackMeters.clear();
    this.mixLinks.clear();
    this.drawSeekActivity();
    this.refreshTrackOps();
    this.renderLongList();
    this.refreshSeekRange(secToBeats(this.from, this.project));
    const rows = this.project.tracks.map((t, i) => {
      const selected = i === this.selected;
      const name = el("input", { type: "text", value: t.name, className: "track-name", ariaLabel: "トラックの名前", maxLength: 30 });
      name.addEventListener("focus", () => this.selectTrack(i));
      name.addEventListener("change", () => {
        t.name = name.value.trim() || `トラック ${i + 1}`;
        this.scheduleSave();
        this.commit();
        // (The ミックス strips, the effects panel's label and the sidechain's choices name it too.)
        this.renderMix();
        this.onTrackChange();
      });
      const instrument: HTMLElement =
        t.kind === "drum"
          ? el("span", { className: "fine track-drum", textContent: `ドラムキット(${this.project.kit.slots.filter((x) => x.sample).length} 音)` })
          : t.kind === "audio"
            ? el("select", { ariaLabel: "置く素材", title: "ピアノロールをタップしたとき置く素材(置いたクリップはそのまま)" }, [
                el("option", { value: "", textContent: "(置く素材を選ぶ)" }),
                ...this.project.materials.map((m) => el("option", { value: m.id, textContent: `置く素材: ${m.name}` })),
              ])
            : el("select", { ariaLabel: "鳴らす音源" }, [
                el("option", { value: "", textContent: "(音源を選ぶ)" }),
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
          this.commit();
          this.onLiveChange();
          // (Its row says whether it sounds.)
          this.renderTracks();
        });
      }
      const { mute, solo, volume, volumeText, meterFill, pan } = this.mixControlsFor(t);
      const remove = button("×", "small", () => this.removeTrack(i), "このトラックを消す");
      // A melodic track with no cut plays nothing: it says so. Effects on: an FX mark that opens them.
      const far = this.farWarning(t);
      const silent =
        t.kind === "melodic" && !t.instrument
          ? el("span", { className: "warn fine track-note", textContent: "音源を選ぶと鳴ります" })
          : t.kind === "audio" && !t.notes.length
            ? el("span", { className: "fine track-note", textContent: "ピアノロールをタップで素材を置きます" })
            : far
              ? el("span", { className: "warn fine track-note", title: far }, ["⚠ 音源の高さから離れすぎ ", ...this.octaveFitButton(i)])
              : null;
      const fxOn = Object.values(t.fx).some((g) => (g as { on?: boolean }).on);
      const fxMark = fxOn
        ? button("FX", "small toggle on fx-mark track-fx", () => {
            this.selectTrack(i);
            this.onOpenFx();
          }, "このトラックにエフェクトがかかっています(押すとエフェクトを開きます)")
        : null;
      remove.hidden = this.project.tracks.length < 2;
      // A track on a cut: straight to that cut's settings on the 素材 side.
      const editCut =
        t.kind === "melodic" && t.instrument && t.instrument !== BACKING
          ? button("音源を編集", "small track-edit", () => this.onEditCut(t.instrument!), "このトラックが鳴らしているサンプリング済音源を、素材の画面で開きます")
          : null;
      // A track on the 簡易シンセ: its 音色, in the same place (choosing one plays a note of it).
      const tone =
        t.kind === "melodic" && t.instrument === BACKING
          ? el(
              "select",
              { ariaLabel: "簡易シンセの音色", title: "簡易シンセの音色", className: "track-edit track-tone" },
              Object.entries(SYNTH_PRESETS).map(([id, p]) => el("option", { value: id, textContent: p.label })),
            )
          : null;
      if (tone) {
        tone.value = t.synth;
        tone.addEventListener("change", () => {
          if (!isSynthPreset(tone.value)) return;
          t.synth = tone.value;
          this.reload();
          this.scheduleSave();
          this.commit();
          if (!this.playing) this.client.previewSynth(t.synth, this.middleOf(t), 0.6);
        });
        tone.addEventListener("focus", () => this.selectTrack(i));
      }
      const lamp = el("span", { className: "track-lamp", title: "鳴っている間、点きます" });
      const row = el("div", { className: `track-row${selected ? " selected" : ""}` }, [
        el("span", { className: "track-count fine num" }, [lamp, `${t.notes.length}`]),
        name,
        instrument,
        // (A row without one keeps its place empty: the columns line up from row to row.)
        editCut ?? tone ?? el("span", { className: "track-slot track-edit" }),
        mute,
        solo,
        el("label", { className: "inline fine track-volume", title: "音量(dB)。ダブルクリックで 0 dB。下のバーはこのトラックの音の大きさ(赤 = 0 dB を超えている)" }, [
          "音量 ",
          el("span", { className: "fader" }, [volume, el("span", { className: "meter track-meter" }, [meterFill])]),
          volumeText,
        ]),
        el("label", { className: "inline fine" }, ["パン ", pan]),
        fxMark ?? el("span", { className: "track-slot track-fx" }),
        silent ?? el("span", { className: "track-slot track-note" }),
        remove,
      ]);
      row.addEventListener("pointerdown", (e) => {
        if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLButtonElement)) this.selectTrack(i);
      });
      instrument.addEventListener("focus", () => this.selectTrack(i));
      this.trackLamps.push(lamp);
      return row;
    });
    this.trackList.replaceChildren(...rows);
    this.renderMix();
    this.renderPads();
  }

  /** A drum track: its rows are the kit's sounds (and the keys its notes use); they are set up in the kit view. */
  private renderPads(): void {
    const t = this.track;
    this.padList.hidden = t.kind === "melodic";
    if (t.kind === "audio") {
      this.padList.replaceChildren(
        el("p", {
          className: "fine",
          textContent:
            "音声トラックは、素材の録音を高さも速さも変えずにそのまま並べます。空いたところをタップで「置く素材」をまるごと置き、ドラッグで動かす、右端で長さ、「スライス」で分ける(後ろ半分は続きから鳴る)、下の欄の「強弱」で音量。曲の途中から再生しても、クリップの途中から鳴ります。",
        }),
      );
      return;
    }
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

  /** How many notes the song's drum tracks have on each GM key. */
  drumKeyCounts(): Map<number, number> {
    const counts = new Map<number, number>();
    for (const t of this.project.tracks) if (t.kind === "drum") for (const n of t.notes) counts.set(n.pitch, (counts.get(n.pitch) ?? 0) + 1);
    return counts;
  }

  /** Whether the page has a kit key's sound ready (its recording loaded); a key without one plays the plain drum. */
  kitSoundReady: (key: number) => boolean = () => true;

  /** What the engine plays for each GM key: the kit's sound (by sample id), or the plain drum sound. */
  kitSpec(): { samples: (string | null)[]; keys: (number | null)[] } {
    const samples: (string | null)[] = [];
    const keys: (number | null)[] = [];
    for (let key = 0; key < 128; key++) {
      // (A key without its own sound plays its partner's: an electric snare the snare's.)
      const from = soundKey(this.project.kit, key, this.kitSoundReady);
      samples.push(from !== null ? `kit:${from}` : null);
      keys.push(from !== null ? null : key);
    }
    return { samples, keys };
  }

  /** The keys mark the note the selected track's cut is made for. */
  private showRoot(): void {
    if (this.track.kind === "drum") return;
    if (this.track.kind === "audio") {
      this.roll.setRoot(null);
      return;
    }
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
    this.roll.setGhosts(this.onion && t.kind === "melodic" ? this.project.tracks.filter((o) => o !== t && o.kind === "melodic").flatMap((o) => o.notes) : []);
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
      item("1 オクターブ上げる", () => this.roll.transposeSelected(12), sel > 0 && this.track.kind === "melodic"),
      item("1 オクターブ下げる", () => this.roll.transposeSelected(-12), sel > 0 && this.track.kind === "melodic"),
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
    if (!this.stepMode || !this.visible || this.playing || this.track.kind !== "melodic") return false;
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

  /** The selected track's id (what the effects panel edits when it shows a track). */
  get trackId(): string {
    return this.track.id;
  }

  /** Every track, by id and name (what a sidechain can listen to). */
  trackChoices(): { id: string; name: string }[] {
    return this.project.tracks.map((t) => ({ id: t.id, name: t.name }));
  }

  /** Changes the selected track's effects (heard at once, kept). */
  updateTrackFx(change: (fx: FxSettings) => void): void {
    const t = this.track;
    const fx = structuredClone(t.fx);
    change(fx);
    // (An effect the automatic mixing put in, once changed by hand, is the user's: it leaves it be from then on.)
    for (const k of ["eq", "duck", "reverb"] as const) {
      const { auto: _was, ...before } = t.fx[k];
      const { auto: _now, ...after } = fx[k];
      if (fx[k].auto && JSON.stringify(before) !== JSON.stringify(after)) delete fx[k].auto;
    }
    t.fx = fx;
    this.client.setTrackMix(t.id, this.mixOf(t, fx));
    this.scheduleSave();
    this.commitSoon();
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
    this.commitSoon();
  }

  /** The tracks as played: with the metronome when it sounds. */
  private playSpecs(): TrackSpec[] {
    const click = this.metronomeSpec();
    return click ? [...this.trackSpecs(), click] : this.trackSpecs();
  }

  private trackSpecs(): TrackSpec[] {
    const kit = this.kitSpec();
    return this.project.tracks
      .filter((t) => t.kind !== "melodic" || t.instrument !== null)
      .map((t) => {
        if (t.kind === "audio") {
          const seq = clipsToSeq(t.notes, this.project);
          return { id: t.id, instrument: "audio", notes: seq.notes, clips: seq.clips, ...this.mixOf(t) };
        }
        return {
        id: t.id,
        instrument: t.kind === "drum" ? "drum" : t.instrument!,
        samples: t.kind === "drum" ? kit.samples : undefined,
        drumKeys: t.kind === "drum" ? kit.keys : undefined,
        notes: toSeqNotes(t.kind === "melodic" ? withHarmony(t.notes, t.harmony, t.glide) : t.notes, this.project, t.kind !== "drum" && t.glide > 0),
        glide: t.kind === "drum" ? 0 : t.glide,
        synth: t.instrument === BACKING ? t.synth : undefined,
        ...this.mixOf(t),
        };
      });
  }

  // ------------------------------------------------------------- playback

  private preview(pitch: number): void {
    if (this.playing || this.track.kind === "audio") return;
    if (this.track.kind === "drum") {
      const key = this.rowKeys[pitch];
      if (key !== undefined) this.onKitHit(key);
      return;
    }
    if (this.track.instrument === BACKING) this.client.previewSynth(this.track.synth, pitch);
    else if (this.track.instrument) this.client.previewNote(this.track.instrument, pitch);
  }

  /** The loop range in song seconds, null while it is off. */
  private loopSecs(): { a: number; b: number } | null {
    const { loop } = this.project;
    if (!loop.on) return null;
    const a = beatsToSec(loop.start, this.project);
    const b = beatsToSec(loop.end, this.project);
    return b > a ? { a, b } : null;
  }

  /** The loop the playhead's clock wraps at: the one the engine was last given (not the one being dragged). */
  private clockLoop: { a: number; b: number } | null = null;

  /**
   * The loop to the engine. While playing, the playhead's clock starts again from where the song is, so it follows
   * the new loop from here as the engine does; a song already past the new loop's end goes to the loop's start.
   */
  private sendLoop(): void {
    // (The master line's seconds follow the tempo too: it goes wherever the loop does.)
    this.sendMasterAuto();
    const next = this.loopSecs();
    if (this.startedAt !== null) {
      const pos = this.currentSec();
      if (next && pos >= next.b && !this.recording) {
        this.from = next.a;
        this.start();
        return;
      }
      const now = this.client.currentTime;
      this.from = pos;
      if (now !== null) this.startedAt = Math.max(now, this.startedAt);
    }
    this.postLoop(next);
  }

  private postLoop(loop: { a: number; b: number } | null): void {
    this.clockLoop = loop;
    this.client.setSongLoop(loop ? { startSec: loop.a, endSec: loop.b } : null);
  }

  /** A new loop range (beats), switched on. */
  private setLoopRange(start: number, end: number): void {
    const s = Math.max(0, start);
    this.project.loop = { start: s, end: Math.max(end, s + 1 / 16), on: true };
    this.roll.setLoop(this.project.loop);
    this.sendLoop();
    this.refreshButtons();
    this.scheduleSave();
  }

  /** The loop from the bar inputs: from the start of one bar to the end of another (the end at least one bar on). */
  private loopFromInputs(): void {
    const bpb = this.project.beatsPerBar;
    const from = Math.max(1, Number(this.loopFrom.value) || 1);
    const to = Math.max(from, Number(this.loopTo.value) || from);
    this.setLoopRange((from - 1) * bpb, to * bpb);
  }

  /** The quick loop buttons: this bar, the selected notes' bars, between markers. */
  private loopAround(kind: "bar" | "selection" | "marker"): void {
    const bpb = this.project.beatsPerBar;
    // (Playing: the bar the playhead is in now.)
    const beat = secToBeats(this.currentSec(), this.project);
    const barStart = (b: number) => Math.floor(b / bpb + 1e-9) * bpb;
    const barEnd = (b: number) => Math.max(bpb, Math.ceil(b / bpb - 1e-9) * bpb);
    if (kind === "bar") this.setLoopRange(barStart(beat), barStart(beat) + bpb);
    else if (kind === "selection") {
      const span = this.roll.selectionSpan;
      if (span) this.setLoopRange(barStart(span.start), Math.max(barEnd(span.end), barStart(span.start) + bpb));
    } else if (kind === "marker") {
      const marks = this.project.markers;
      const before = [...marks].reverse().find((m) => m.beat <= beat + 1e-9);
      const after = marks.find((m) => m.beat > beat + 1e-9);
      const start = before?.beat ?? 0;
      this.setLoopRange(start, after?.beat ?? Math.max(barEnd(this.lastBeat()), start + bpb));
    }
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
    this.client.loadTracks(this.startedAt !== null ? this.playSpecs() : this.trackSpecs());
    if (this.startedAt !== null) {
      this.from = position;
      this.start();
    } else this.sendLoop();
  }

  /** The playing position (song seconds), or where playback would start. */
  currentSec(): number {
    const now = this.client.currentTime;
    if (this.startedAt === null || now === null) return this.from;
    let pos = this.from + Math.max(0, now - this.startedAt);
    const loop = this.clockLoop;
    if (loop && this.from < loop.b && pos >= loop.b) pos = loop.a + ((pos - loop.b) % (loop.b - loop.a));
    return pos;
  }

  private currentBeat(): number {
    return secToBeats(this.currentSec(), this.project);
  }

  /** A note in the middle of a track's notes (C4 without any): what a 音色 is tried on. */
  private middleOf(t: Track): number {
    if (!t.notes.length) return 60;
    const pitches = t.notes.map((n) => n.pitch).sort((a, b) => a - b);
    return pitches[pitches.length >> 1];
  }

  private lastBeat(): number {
    return Math.max(0, ...this.project.tracks.map((t) => songEnd(t.notes)));
  }

  toggle(): void {
    if (this.playing) {
      const rec = this.recording;
      if (rec) {
        // Back to where the recording started, to hear it.
        this.stop();
        this.from = beatsToSec(rec.startBeat, this.project);
        this.showPosition(this.from);
        this.roll.setPlayhead(rec.startBeat);
        return;
      }
      this.from = this.currentSec();
      this.stop();
      return;
    }
    const endSec = beatsToSec(this.lastBeat(), this.project);
    if (!this.project.loop.on && this.from >= endSec) this.from = 0;
    // (With the loop on, a start past its end begins at its start: the loop is what is to be heard.)
    const loop = this.loopSecs();
    if (loop && this.from >= loop.b) this.from = loop.a;
    this.start();
  }

  private start(): void {
    this.client.setTempo(this.project.bpm);
    this.client.loadTracks(this.playSpecs());
    this.sendMasterAuto();
    this.postLoop(this.loopSecs());
    this.startedAt = this.client.playSong(this.from);
    // (A new playback: the 0 dB 超え mark says what this one does, not a playback before.)
    for (const mark of this.clipMarks) mark.hidden = true;
    this.playButton.textContent = "■ 停止";
    this.summarize();
    this.onPlayingChange(true);
    cancelAnimationFrame(this.frame);
    const tick = () => {
      if (this.startedAt === null) return;
      const beat = this.currentBeat();
      // (A recording goes on past the last note.)
      if (!this.recording && !this.project.loop.on && beat > this.lastBeat() + END_PAD_BEATS) {
        this.from = 0;
        this.stop();
        return;
      }
      this.roll.setPlayhead(beat, true);
      this.showPosition(beatsToSec(beat, this.project));
      this.lightLamps(beat);
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  /**
   * The lamps at a beat (null: all off): a track is lit where a note is under the playhead and the track is heard
   * (not muted; with a solo on, only the soloed ones). A short note (a drum hit) stays lit a quarter beat, so it is seen.
   */
  private lightLamps(beat: number | null): void {
    const tracks = this.project.tracks;
    const soloing = tracks.some((t) => t.solo);
    tracks.forEach((t, i) => {
      const lamp = this.trackLamps[i];
      if (!lamp) return;
      let on = false;
      if (beat !== null && !t.mute && (!soloing || t.solo) && (t.kind === "audio" || t.instrument)) {
        for (const n of t.notes) {
          if (n.start > beat) break;
          if (beat < n.start + Math.max(n.length, 0.25)) {
            on = true;
            break;
          }
        }
      }
      lamp.classList.toggle("on", on);
    });
  }

  /** The selected track's notes along the seek bar, merged into stretches: where in the song it plays. */
  private drawSeekActivity(): void {
    const canvas = this.seekActivity;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const g = canvas.getContext("2d");
    if (!g) return;
    g.clearRect(0, 0, canvas.width, canvas.height);
    const max = Number(this.seekBar.max) || 1;
    // (Everything shorter than a pixel still shows: a drum hit is a tick.)
    const x = (beat: number) => (Math.min(max, Math.max(0, beat)) / max) * canvas.width;
    g.fillStyle = getComputedStyle(canvas).color;
    let from = -1;
    let to = -1;
    const flush = () => {
      if (from >= 0) g.fillRect(x(from), 0, Math.max(dpr, x(to) - x(from)), canvas.height);
    };
    for (const n of this.track?.notes ?? []) {
      if (n.start <= to + 1e-9) to = Math.max(to, n.start + n.length);
      else {
        flush();
        from = n.start;
        to = n.start + n.length;
      }
    }
    flush();
  }

  // ------------------------------------------------------------- recording (design.md 13)

  get isRecording(): boolean {
    return this.recording !== null;
  }

  private toggleRecording(): void {
    if (this.recording) {
      this.toggle();
      return;
    }
    if (this.track.kind === "audio") {
      this.info.textContent = "音声トラックには録音できません。音符を入れるトラック(音源のトラックかドラムトラック)を選んでください。";
      return;
    }
    if (this.playing) this.stop();
    const startBeat = Math.max(0, secToBeats(this.from, this.project));
    this.recording = { startBeat, held: new Map(), notes: [] };
    // One bar of count-in before it.
    this.from = beatsToSec(startBeat - this.project.beatsPerBar, this.project);
    this.recordButton.textContent = "■ 録音を止める";
    this.recordButton.classList.add("recording");
    this.info.textContent = `録音: 1 小節のカウントのあと、「${this.track.name}」に入ります。`;
    this.start();
  }

  /** A key pressed or let go while recording: kept as a note where the song is (as heard). Whether it was taken. */
  recordNote(pitch: number, down: boolean, velocity = DEFAULT_VELOCITY): boolean {
    const rec = this.recording;
    if (!rec || this.startedAt === null) return false;
    // Where the player was when what is heard now was made.
    const beat = secToBeats(this.currentSec() - this.client.outputLatency, this.project);
    if (down) {
      // (A little early on the first beat counts as on it; earlier is the count-in.)
      if (beat < rec.startBeat - 0.5) return true;
      rec.held.set(pitch, { start: Math.max(rec.startBeat, beat), velocity });
      return true;
    }
    const held = rec.held.get(pitch);
    if (!held) return false;
    rec.held.delete(pitch);
    this.keepRecorded(rec, pitch, held, beat);
    return true;
  }

  private keepRecorded(rec: { notes: Note[] }, pitch: number, held: { start: number; velocity: number }, end: number): void {
    const { loop } = this.project;
    // Let go after the loop wrapped: it ends at the loop's end.
    if (end <= held.start) end = loop.on && held.start < loop.end ? loop.end : held.start + 1 / 16;
    rec.notes.push({ id: newId(), start: held.start, length: Math.max(1 / 64, end - held.start), pitch, velocity: Math.max(0.05, Math.min(1, held.velocity)) });
    this.info.textContent = `録音中… ${rec.notes.length} 音`;
  }

  /** The recording has ended (playback stopped, keys still held let go at `end`): its notes join the track, as one step to undo. */
  private finishRecording(rec: NonNullable<RollPanel["recording"]>, end: number): void {
    this.recordButton.textContent = "● 録音";
    this.recordButton.classList.remove("recording");
    for (const [pitch, held] of rec.held) this.keepRecorded(rec, pitch, held, end);
    if (!rec.notes.length) {
      this.info.textContent = "録音した音符はありません。";
      return;
    }
    const t = this.track;
    if (t.kind === "drum") {
      const merged = [...t.notes, ...rec.notes];
      const rows = drumRows(this.project.kit, merged);
      if (rows.join() === this.rowKeys.join()) {
        this.roll.setNotes(merged.map((n) => ({ ...n, pitch: rows.indexOf(n.pitch) })));
        this.changed(this.roll.notes);
      } else {
        // New rows: the roll is drawn again (its undo starts afresh).
        t.notes = sortNotes(merged);
        this.showTrackInRoll();
        this.reload();
        this.renderTracks();
        this.scheduleSave();
        this.commit();
      }
    } else {
      this.roll.setNotes([...this.roll.notes, ...rec.notes]);
      this.changed(this.roll.notes);
    }
    this.refreshButtons();
    this.info.textContent = `${rec.notes.length} 音を録音しました(「元に戻す」で取り消せます。ずれはクオンタイズで整えられます)。`;
  }

  /** The metronome's clicks (beats from a bar before `fromBeat` to past the song), when it sounds. */
  private metronomeSpec(): TrackSpec | null {
    if (!(this.metronome || this.recording)) return null;
    const bpb = this.project.beatsPerBar;
    const { num, den } = this.project.timeSig;
    const unit = 4 / den;
    const fromBar = Math.floor(secToBeats(this.from, this.project) / bpb) - 1;
    const last = Math.max(this.lastBeat(), this.project.loop.on ? this.project.loop.end : 0, secToBeats(this.from, this.project)) + bpb * 64;
    const notes = [];
    for (let k = Math.max(-1, fromBar) * num; k * unit < last; k++) {
      const start = beatsToSec(k * unit, this.project);
      const down = ((k % num) + num) % num === 0;
      notes.push({ start, end: start + 0.03, note: down ? 76 : 77, velocity: down ? 1 : 0.55, drum: true });
    }
    return { id: METRONOME, instrument: "backing", notes, gain: 2, pan: 0, mute: false, solo: false, fx: null };
  }

  /** Stops playback keeping the position where it is now. */
  pause(): void {
    if (!this.playing) return;
    this.from = this.currentSec();
    this.stop();
  }

  /** Stops playback (the position stays where it was). */
  stop(): void {
    cancelAnimationFrame(this.frame);
    this.lightLamps(null);
    if (this.startedAt === null) return;
    // A recording ends here: where the keys still held are let go, before the clock stops.
    const rec = this.recording;
    const recEnd = rec ? secToBeats(this.currentSec() - this.client.outputLatency, this.project) : 0;
    this.recording = null;
    this.startedAt = null;
    this.client.stopSong();
    this.client.setTempo(this.project.bpm);
    this.playButton.textContent = "▶ 再生";
    this.summarize();
    this.roll.setPlayhead(secToBeats(this.from, this.project));
    this.showPosition(this.from);
    this.onPlayingChange(false);
    // (After playback has stopped: adding the notes reloads the tracks, which must not start it again.)
    if (rec) this.finishRecording(rec, recEnd);
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
    const unit = 4 / this.project.timeSig.den;
    this.position.textContent = this.recording && beat < this.recording.startBeat ? `カウント ${Math.ceil((this.recording.startBeat - beat) / unit)}` : `${bar + 1} 小節 ${Math.floor((beat - bar * bpb) / unit + 1e-9) + 1} 拍`;
    if (!this.playing) this.roll.setPlayhead(beat);
  }

  /** The seek bar reaches a bar past the last note (at least 4 bars, and past the loop and the position). */
  private refreshSeekRange(at = 0): void {
    const bpb = this.project.beatsPerBar;
    const end = Math.max(this.lastBeat() + bpb, this.project.loop.end, at, bpb * 4);
    const max = String(Math.ceil(end / bpb) * bpb);
    if (this.seekBar.max !== max) {
      this.seekBar.max = max;
      this.drawSeekLoop();
    }
  }

  /** The song WAV's loudness target (LUFS), or null to leave it as it is. */
  get exportLoudness(): { targetLufs: number; label: string } | null {
    const v = this.loudnessSelect.value;
    return v === "niconico" ? { targetLufs: -15, label: "ニコニコ動画向け" } : v === "youtube" ? { targetLufs: -14, label: "YouTube・配信向け" } : null;
  }

  /**
   * The engine's meter readings: each track's bar (it rises at once and falls back about 25 dB a second), the
   * master's bar, peak (held two seconds) and loudness, and the clip mark once the output passes 0 dB.
   */
  showMeters(m: { tracks: [string, number][]; peakL: number; peakR: number; shortTerm: number }): void {
    const fall = 1.3;
    const toDb = (p: number) => (p > 1e-6 ? 20 * Math.log10(p) : -Infinity);
    const bar = (fills: HTMLElement[], db: number) => {
      // (−48 dB at the bottom / left to 0 dB at the top / right; red past 0. The CSS takes the level as a width or a height.)
      for (const fill of fills) {
        fill.style.setProperty("--level", String(Math.max(0, Math.min(1, (db + 48) / 48))));
        fill.classList.toggle("over", db > 0);
      }
    };
    const seen = new Set<string>();
    for (const [id, peak] of m.tracks) {
      const meter = this.trackMeters.get(id);
      if (!meter) continue;
      seen.add(id);
      meter.db = Math.max(toDb(peak), meter.db - fall);
      bar(meter.fills, meter.db);
    }
    for (const [id, meter] of this.trackMeters) {
      if (seen.has(id)) continue;
      meter.db -= fall;
      bar(meter.fills, meter.db);
    }
    const peakDb = toDb(Math.max(m.peakL, m.peakR));
    this.masterDb = Math.max(peakDb, this.masterDb - fall);
    bar(this.masterFills, this.masterDb);
    const now = performance.now();
    if (peakDb >= this.masterHold.db || now - this.masterHold.at > 2000) this.masterHold = { db: peakDb, at: now };
    if (peakDb > 0) for (const mark of this.clipMarks) mark.hidden = false;
    const lufs = Number.isFinite(m.shortTerm) && m.shortTerm > -70 ? `${m.shortTerm.toFixed(1)} LUFS` : "— LUFS";
    for (const text of this.masterTexts) text.textContent = `ピーク ${Number.isFinite(this.masterHold.db) ? this.masterHold.db.toFixed(1) : "−∞"} dB・${lufs}`;
  }

  /** The seek bar's thumb is this wide: its track runs from half of it in to half of it short of the end. */
  private static readonly SEEK_INSET_PX = 8;

  /** The loop range over the seek bar (where the thumb's centre would stand at each end). */
  private drawSeekLoop(): void {
    const { loop } = this.project;
    const max = Number(this.seekBar.max) || 1;
    const at = (beat: number) => `calc(${RollPanel.SEEK_INSET_PX}px + (100% - ${2 * RollPanel.SEEK_INSET_PX}px) * ${Math.min(1, Math.max(0, beat / max))})`;
    this.loopBand.style.left = at(loop.start);
    this.loopBand.style.width = `calc(${at(loop.end)} - ${at(loop.start)})`;
    this.loopStartGrip.style.left = at(loop.start);
    this.loopEndGrip.style.left = at(loop.end);
    this.seekWrap.classList.toggle("loop-on", loop.on);
    this.drawSeekActivity();
  }

  /** One end of the loop dragged along the seek bar: to whole bars (beats with Alt), the loop switched on, kept at least a beat long. */
  private grabLoopEnd(grip: HTMLElement, end: "start" | "end"): void {
    let dragging = false;
    const beatAt = (event: PointerEvent) => {
      const box = this.seekBar.getBoundingClientRect();
      const inset = RollPanel.SEEK_INSET_PX;
      const share = Math.min(1, Math.max(0, (event.clientX - box.left - inset) / Math.max(1, box.width - 2 * inset)));
      const step = event.altKey ? 1 : this.project.beatsPerBar;
      return Math.round((share * Number(this.seekBar.max)) / step) * step;
    };
    grip.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      dragging = true;
      grip.setPointerCapture?.(event.pointerId);
      grip.classList.add("dragging");
    });
    grip.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const beat = beatAt(event);
      const { loop } = this.project;
      const start = end === "start" ? Math.min(beat, loop.end - 1) : loop.start;
      const stop = end === "end" ? Math.max(beat, loop.start + 1) : loop.end;
      if (start === loop.start && stop === loop.end && loop.on) return;
      this.project.loop = { start: Math.max(0, start), end: stop, on: true };
      this.roll.setLoop(this.project.loop);
      this.drawSeekLoop();
      this.refreshButtons();
    });
    const finish = () => {
      if (!dragging) return;
      dragging = false;
      grip.classList.remove("dragging");
      this.sendLoop();
      this.scheduleSave();
    };
    grip.addEventListener("pointerup", finish);
    grip.addEventListener("pointercancel", finish);
  }

  private refreshButtons(): void {
    const none = this.roll.selectionSize === 0;
    this.deleteButton.disabled = none;
    this.duplicateButton.disabled = none;
    for (const b of this.transposeButtons) b.disabled = none;
    this.refreshUndo();
    this.refreshTrackOps();
    const { loop } = this.project;
    const range = this.rangeText();
    this.arrangeLabel.textContent = `範囲(${range}、目盛りをドラッグで選ぶ):`;
    this.loopButton.textContent = `ループ: ${loop.on ? `オン(${range})` : "オフ"}`;
    this.loopButton.classList.toggle("on", loop.on);
    this.bassLevelSelect.value = String(this.project.bassLevelDb);
    this.drawSeekLoop();
    // (Bars shown as numbers: a range off the bar lines shows its fraction.)
    const bars = (beats: number) => String(+(beats / this.project.beatsPerBar).toFixed(2));
    if (document.activeElement !== this.loopFrom) this.loopFrom.value = bars(loop.start + this.project.beatsPerBar);
    if (document.activeElement !== this.loopTo) this.loopTo.value = bars(loop.end);
    this.loopSelectionButton.disabled = none;
    this.loopMarkerButton.disabled = this.project.markers.length === 0;
    this.selectToggle.textContent = `範囲選択: ${this.roll.selectMode ? "オン" : "オフ"}`;
    this.clearButton.disabled = this.roll.notes.length === 0;
    this.quantizeButton.disabled = this.roll.notes.length === 0;
    this.copyButton.disabled = none;
    this.pasteButton.disabled = !this.roll.hasClipboard;
    this.selectAllButton.disabled = this.roll.notes.length === 0;
    for (const b of this.nudgeButtons) b.disabled = none;
    this.sliceButton.disabled = this.roll.notes.length === 0;
    this.onionToggle.classList.toggle("on", this.onion);
    this.metronomeToggle.classList.toggle("on", this.metronome);
    this.onionToggle.hidden = this.track.kind !== "melodic";
    const drum = this.track.kind !== "melodic";
    this.stepToggle.textContent = `ステップ入力: ${this.stepMode && !drum ? "オン" : "オフ"}`;
    this.stepToggle.classList.toggle("on", this.stepMode && !drum);
    this.stepToggle.disabled = drum;
    this.stepToggle.title = drum ? "ドラム・音声のトラックでは使えません" : "鍵盤で弾いた音が、再生位置に音符として入ります";
    this.stepRestButton.hidden = this.stepBackButton.hidden = this.stepHelp.hidden = this.stepTieButton.hidden = !this.stepMode || drum;
  }
}
