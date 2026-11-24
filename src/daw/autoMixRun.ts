// The automatic mixing as the page runs it (design.md 36–38): the steps that render and measure — the master EQ
// toward a target, the volumes, the clean-up EQ, the one-shot run of all of them, the diagnosis — wired to the
// song panel's buttons. What they decide from the measurements is in autoMix.ts and fx/balance.ts; this file
// gathers the measurements (off the page, side by side) and applies the results through the panel.

import { DEFAULT_FX, type FxSettings } from "../instrument/types";
import { fitBalance, nearestStyle, type BalanceChoice } from "../fx/balance";
import type { AutoPoint } from "../song/player";
import type { RollPanel } from "../ui/rollPanel";
import { balanceGains, cleanEq, lowCutFor, madeByAuto, maskingDip } from "./autoMix";
import { BACKING, MAX_TRACK_GAIN, roomOf, tempoMapSec, withHarmony, type Tempo } from "./model";
import { renderOff, type RenderMeasure } from "./renderClient";
import { ROLE_NAMES } from "./roles";
import type { RenderTrack } from "./songRender";

type Snapshot = ReturnType<RollPanel["snapshot"]>;

/**
 * 広がりを寄せる: the side against the mid over 400 Hz it aims for (dB), the most the side is raised (×), the side
 * under which a mix is taken for mono (nothing to raise), and from where up the master's ステレオ幅 works (the lows
 * keep to the middle, as finished songs have them). And how wide the whole may end (the side against the mid over
 * all of it, dB): −8.5 dB is a correlation of about 0.75, the low end of finished mixes (0.66–0.92 measured) — past it
 * a song begins to thin on one speaker. (At 150% at most, a real song whose six melodies sit in the middle stopped
 * 3 dB short; 180% reaches it.)
 */
const WIDTH_SIDE_DB = -6.5;
const WIDTH_MOST = 1.8;
const WIDTH_MONO_DB = -20;
const WIDTH_WHOLE_MOST_DB = -8.5;
export const WIDTH_FROM_HZ = 400;

/**
 * The master's ステレオ幅 (the side's gain) for a mix with this much side over 400 Hz (`sideUpDb`) and over all of it
 * (`sideDb`; the raise is taken as all of it, the side under 400 Hz being little): null when it is wide enough, 0
 * when it is as good as mono.
 */
export function widthFor(sideUpDb: number, sideDb = -Infinity): number | null {
  if (!(sideUpDb > WIDTH_MONO_DB)) return 0;
  const gain = Math.min(10 ** ((WIDTH_SIDE_DB - sideUpDb) / 20), 10 ** ((WIDTH_WHOLE_MOST_DB - sideDb) / 20));
  if (gain < 1.05) return null;
  return Math.round(Math.min(WIDTH_MOST, gain) * 20) / 20;
}

/** 密度を上げる: the peak over the loudness it aims for (dB), and how far under the highest peak the rounding may start at most. */
const DENSITY_PLR = 12;
const DENSITY_MAX_DB = 5;

export interface AutoMixDeps {
  rollPanel: RollPanel;
  /** The rate the song is rendered at (the engine's). */
  sampleRate: () => number;
  /** The song's tracks as a render takes them (all, or one alone with what its sidechain needs). */
  songTracks: (project: Snapshot, only: string | null, range: { startSec: number; lengthSec: number } | null) => RenderTrack[];
  renderLine: (points: Snapshot["masterAuto"], tempo: Tempo, range: { startSec: number; lengthSec: number } | null) => AutoPoint[];
  /** One render-heavy job at a time, shared with the export. */
  lock: { busy: boolean };
}

/** Wires the panel's automatic-mixing buttons. */
export function installAutoMix(deps: AutoMixDeps): void {
  const { rollPanel, songTracks, renderLine, lock } = deps;

  /**
   * 音域のバランス: the song rendered without the master (offline, as the WAV would be), its long-term spectrum
   * measured, and the master EQ set toward the style's target (design.md 35).
   */
  async function balanceMaster(style: BalanceChoice): Promise<void> {
    if (lock.busy) return;
    const project = rollPanel.snapshot();
    if (!project.tracks.some((t) => t.notes.length)) {
      rollPanel.balanceSays("測る音符がありません。");
      return;
    }
    lock.busy = true;
    try {
      const rate = deps.sampleRate();
      const song = await renderOff({ sampleRate: rate, bpm: project.bpm, tracks: songTracks(project, null, null), masterFx: null, room: roomOf(project), tempoMap: tempoMapSec(project), raw: true }, "measure", (share) =>
        rollPanel.balanceSays(share >= 1 ? "周波数の分布を調べています…" : `曲を測っています… ${Math.round(share * 100)}%`),
      );
      const measured = song.bands;
      if (!measured) {
        rollPanel.balanceSays("曲に音がありませんでした(ミュートやソロも確かめてください)。");
        return;
      }
      // (参照曲: its own bands are the target; without one loaded, the standard style.)
      const reference = style === "reference" ? rollPanel.reference : null;
      const toward = style === "reference" ? (reference ? reference.bands : "standard") : style;
      rollPanel.applyBalance(fitBalance(measured, toward, rate, project.masterFx.eq), reference ? "reference" : style === "reference" ? "standard" : style, nearestStyle(measured));
    } finally {
      lock.busy = false;
    }
  }
  rollPanel.onBalance = (style) => void balanceMaster(style);
  // The lows-short notice's refit: the volumes, then the master EQ, then what came of it under the notice.
  rollPanel.onRefitLows = () =>
    void (async () => {
      await autoLevels();
      await balanceMaster(rollPanel.balanceStyle());
      rollPanel.refitDone();
    })();

  /**
   * 広がりを寄せる (design.md 46): the song through the master without its ステレオ幅, how much side it has
   * measured, and the master's ステレオ幅 set to bring it toward WIDTH_SIDE_DB — no more than WIDTH_MOST, and only
   * for a mix that has some width to bring up (panning is what makes it; this only raises what is there).
   */
  async function autoWidth(): Promise<void> {
    if (lock.busy) return;
    const project = rollPanel.snapshot();
    if (!heardTracks(project).length) {
      rollPanel.info.textContent = "測れるトラック(音符があり、ミュートしていないもの)がありません。";
      return;
    }
    // (A width set by hand — its middle moved too — is kept.)
    if (project.masterFx.width.on && project.masterFx.width.midDb !== 0) {
      rollPanel.info.textContent = "マスターのステレオ幅は自分で入れてあるので、そのままにしました。";
      return;
    }
    lock.busy = true;
    try {
      const masterFx = structuredClone(project.masterFx);
      masterFx.width = { ...masterFx.width, on: false };
      const song = await renderOff({ sampleRate: deps.sampleRate(), bpm: project.bpm, tracks: songTracks(project, null, null), masterFx, room: roomOf(project), tempoMap: tempoMapSec(project), raw: true }, "measure", (share) => (rollPanel.info.textContent = `広がりを測っています… ${Math.round(share * 100)}%`));
      rollPanel.applyWidth(widthFor(song.sideUpDb, song.sideDb), song.sideUpDb, WIDTH_SIDE_DB, WIDTH_FROM_HZ);
    } finally {
      lock.busy = false;
    }
  }
  rollPanel.onAutoWidth = () => void autoWidth();

  /**
   * 密度を上げる (design.md 45): the song rendered through the master as it is but for the rounding itself and the
   * limiter after it, and the master's ピークを丸める set where the peak comes down to DENSITY_PLR over the loudness.
   */
  async function densify(): Promise<void> {
    if (lock.busy) return;
    const project = rollPanel.snapshot();
    if (!heardTracks(project).length) {
      rollPanel.info.textContent = "測れるトラック(音符があり、ミュートしていないもの)がありません。";
      return;
    }
    lock.busy = true;
    try {
      const masterFx = structuredClone(project.masterFx);
      masterFx.clip = { ...masterFx.clip, on: false };
      masterFx.limiter = { ...masterFx.limiter, on: false };
      const song = await renderOff(
        { sampleRate: deps.sampleRate(), bpm: project.bpm, tracks: songTracks(project, null, null), masterFx, room: roomOf(project), tempoMap: tempoMapSec(project), raw: true },
        "measure",
        (share) => (rollPanel.info.textContent = share >= 1 ? "ピークの出方を調べています…" : `曲を測っています… ${Math.round(share * 100)}%`),
        { targetPlr: DENSITY_PLR, maxUnderPeakDb: DENSITY_MAX_DB },
      );
      rollPanel.applyDensity(song.rounding ?? null, Number.isFinite(song.lufs) ? song.peakDb - song.lufs : null, DENSITY_PLR);
    } finally {
      lock.busy = false;
    }
  }
  rollPanel.onDensify = () => void densify();

  /** One track as the song plays it (its effects, its volume; no master), offline: what the automatic mixing measures. */
  async function renderTrackAlone(project: Snapshot, id: string, say: (share: number) => void): Promise<RenderMeasure> {
    return renderOff({ sampleRate: deps.sampleRate(), bpm: project.bpm, tracks: songTracks(project, id, null), masterFx: null, room: roomOf(project), tempoMap: tempoMapSec(project), raw: true }, "measure", say);
  }

  /**
   * These tracks each measured alone, side by side (the render workers share them out): `says` is the line shown
   * with how many are done.
   */
  async function measureTracks(project: Snapshot, indices: readonly number[], says: string): Promise<Map<number, RenderMeasure>> {
    const out = new Map<number, RenderMeasure>();
    let done = 0;
    const show = () => (rollPanel.info.textContent = `${says}… ${done} / ${indices.length} 本`);
    show();
    await Promise.all(
      indices.map(async (i) => {
        out.set(i, await renderTrackAlone(project, project.tracks[i].id, () => {}));
        done++;
        show();
      }),
    );
    return out;
  }

  /** The tracks the mix lets through (not muted, not outside a solo) that have notes: what the automatic mixing works on. */
  function heardTracks(project: Snapshot): number[] {
    const soloing = project.tracks.some((t) => t.solo);
    return project.tracks.flatMap((t, i) => (t.notes.length && !t.mute && (!soloing || t.solo) ? [i] : []));
  }

  /** 音量を合わせる (design.md 36): each heard track measured alone (LUFS), then brought to its part's level. */
  async function autoLevels(): Promise<void> {
    if (lock.busy) return;
    const project = rollPanel.snapshot();
    const roles = rollPanel.roles();
    const heard = heardTracks(project);
    if (!heard.length) {
      rollPanel.info.textContent = "測れるトラック(音符があり、ミュートしていないもの)がありません。";
      return;
    }
    lock.busy = true;
    try {
      const lufs: (number | null)[] = project.tracks.map(() => null);
      const measured = await measureTracks(project, heard, "音量を測っています");
      for (const i of heard) {
        const l = measured.get(i)!.lufs;
        lufs[i] = Number.isFinite(l) && l > -70 ? l : null;
      }
      const { gains, reference, loweredDb } = balanceGains(
        // (The bass set as the main one takes three times a plain voice bass's share; a bass on the 簡易シンセ, the
        // floor of the lows, twice.)
        project.tracks.map((t, i) => ({ role: roles[i], lufs: lufs[i], gain: t.gain, notes: t.notes, weight: roles[i] !== "bass" ? 1 : t.main ? 3 : t.instrument === BACKING ? 2 : 1 })),
        MAX_TRACK_GAIN,
        { bass: project.bassLevelDb, chords: project.chordsLevelDb, backing: project.chordsLevelDb, harmony: project.chordsLevelDb },
      );
      rollPanel.applyGains(gains, reference, loweredDb);
    } finally {
      lock.busy = false;
    }
  }
  rollPanel.onAutoLevels = () => void autoLevels();

  /**
   * トラックの EQ (design.md 36): on the leads, the chords, the accompaniment and the harmonies, a low cut a little
   * under their notes; on all but the leads, a dip where the leads (measured together: a melody passed between tracks
   * by section) are strong and so are they. An EQ set by hand is kept; one the automatic mixing put in before is
   * replaced, or taken out where the track's part no longer wants one.
   */
  async function autoEq(tidy = false): Promise<void> {
    if (lock.busy) return;
    const project = rollPanel.snapshot();
    const roles = rollPanel.roles();
    const heard = new Set(heardTracks(project));
    const wanted = new Set(["lead", "chords", "backing", "harmony"]);
    const mine = (i: number) => madeByAuto(project.tracks[i].fx, "eq", project.bpm);
    const targets = project.tracks.flatMap((t, i) => (heard.has(i) && t.kind === "melodic" && wanted.has(roles[i]) ? [i] : []));
    // (Tidying: an EQ set by hand keeps its knobs and gets a low cut where it has none; a bass's cut over its lowest
    // note comes down under it.)
    const handTidy: (FxSettings | null)[] = project.tracks.map((t, i) => {
      if (!tidy || !t.fx.eq.on) return null;
      const notes = withHarmony(t.notes, t.harmony, t.glide);
      if (targets.includes(i)) return !mine(i) && t.fx.eq.lowCutHz === 0 && notes.length ? { ...structuredClone(t.fx), eq: { ...t.fx.eq, lowCutHz: lowCutFor(notes) } } : null;
      // (A bass's cut, set by hand or taken for an old automatic one, never over its lowest note.)
      if (roles[i] === "bass" && notes.length) {
        const lowest = 440 * 2 ** ((Math.min(...notes.map((n) => n.pitch)) - 69) / 12);
        if (t.fx.eq.lowCutHz > lowest) return { ...structuredClone(t.fx), eq: { ...t.fx.eq, lowCutHz: Math.round(lowest * 0.7) } };
      }
      return null;
    });
    const tidiedEq = handTidy.filter(Boolean).length;
    const kept = targets.filter((i) => !mine(i) && !handTidy[i]);
    const work = targets.filter(mine);
    // (An automatic EQ on a track whose part wants none now — the bass, say: taken out.)
    const off = project.tracks.flatMap((t, i) => (!targets.includes(i) && t.fx.eq.on && t.fx.eq.auto ? [i] : []));
    if (!work.length && !off.length && !tidiedEq) {
      rollPanel.info.textContent = targets.length
        ? `EQ を入れるトラックはありませんでした(対象の ${targets.length} 本はどれも EQ を自分で入れてあります)。`
        : "EQ を入れるトラック(メロディ・和音・伴奏・ハモリ)がありませんでした。";
      return;
    }
    lock.busy = true;
    try {
      const leads = roles.flatMap((r, i) => (r === "lead" && heard.has(i) ? [i] : []));
      const dipped = work.filter((i) => roles[i] !== "lead");
      // (All measured side by side first: the leads, and the tracks that may be dipped under them.)
      const measured = dipped.length ? await measureTracks(project, [...leads, ...dipped], "周波数の分布を測っています") : new Map<number, RenderMeasure>();
      const measure = async (i: number, _k: number, _n: number) => measured.get(i)?.bands ?? null;
      const total = dipped.length ? dipped.length + leads.length : 0;
      let step = 0;
      // The leads together: their band powers added.
      let leadSpectrum: number[] | null = null;
      if (dipped.length) {
        for (const i of leads) {
          const s = await measure(i, ++step, total);
          if (!s) continue;
          leadSpectrum = leadSpectrum ? leadSpectrum.map((x, j) => 10 * Math.log10(10 ** (x / 10) + 10 ** (s[j] / 10))) : s;
        }
      }
      const fxs: (FxSettings | null)[] = project.tracks.map(() => null);
      const said: string[] = [];
      const hz = (v: number) => (v >= 1000 ? `${+(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`);
      for (const i of work) {
        const t = project.tracks[i];
        const notes = withHarmony(t.notes, t.harmony, t.glide);
        const spectrum = roles[i] !== "lead" && leadSpectrum ? await measure(i, ++step, total) : null;
        const dip = leadSpectrum && spectrum ? maskingDip(leadSpectrum, spectrum) : null;
        const fx = structuredClone(t.fx);
        fx.eq = cleanEq(lowCutFor(notes), dip);
        fxs[i] = fx;
        said.push(`「${t.name}」ローカット ${hz(fx.eq.lowCutHz)}${dip ? `・${hz(dip.hz)} ${dip.db} dB` : ""}`);
      }
      for (const i of off) {
        const fx = structuredClone(project.tracks[i].fx);
        fx.eq = { ...DEFAULT_FX.eq };
        fxs[i] = fx;
      }
      handTidy.forEach((fx, i) => {
        if (fx) fxs[i] = fx;
      });
      rollPanel.applyTrackFx(
        fxs,
        `${said.length ? `トラックの EQ を入れました: ${said.join("、")}。` : ""}${off.length ? `前に自動で入れた EQ を ${off.length} 本から外しました。` : ""}${!leads.length && dipped.length ? "メロディのトラックがないので、ぶつかりを削る EQ は入れていません。" : ""}${tidiedEq ? `自分で入れていた EQ ${tidiedEq} 本のローカットを整えました(つまみはそのまま)。` : ""}${kept.length ? `EQ を自分で入れていた ${kept.length} 本はそのままです。` : ""}「元に戻す」で戻せます。`,
      );
    } finally {
      lock.busy = false;
    }
  }
  rollPanel.onAutoEq = () => void autoEq();

  /**
   * まとめて自動ミックス (design.md 37): the automatic steps in the order they build on — the clean-up EQ, the ducking,
   * the rooms (what the volumes are then measured through), the volumes, and the master EQ (on the mix as it now
   * is), the width, and 密度を上げる last (its height is in dBFS: everything before it changes it). Each stays its
   * own step to undo. 場面の強弱 is not in it: it changes what the song is, not how it is mixed.
   */
  async function autoMixAll(): Promise<void> {
    if (lock.busy) return;
    const said: string[] = [];
    const note = (label: string) => said.push(`${label}: ${rollPanel.info.textContent}`);
    rollPanel.nameTracks();
    note("トラック名");
    rollPanel.spreadPans(true);
    note("パン(真ん中のトラックだけ)");
    const tidy = rollPanel.tidyOwn();
    await autoEq(tidy);
    note("EQ");
    rollPanel.autoDuck(tidy);
    note("沈め");
    rollPanel.autoRooms(tidy);
    note("残響");
    if (tidy) {
      rollPanel.tidyOwnEffects();
      note("エフェクトの整理");
      // (A compressor on the master widens the gap between the peak and the loudness that 密度を上げる narrows.)
      if (rollPanel.masterCompressorOff()) said.push("マスターのコンプ: 自分で入れていたマスターのコンプを外しました(ドラムの頭を通してほかを下げ、ピークと聞こえの大きさの差を広げるため。密度は最後の「密度を上げる」で詰めます)。");
    }
    await autoLevels();
    note("音量");
    await balanceMaster(rollPanel.balanceStyle());
    said.push("マスター EQ: 下の「音域のバランス」に結果があります。");
    await autoWidth();
    note("広がり");
    await densify();
    note("密度");
    // Last, the diagnosis of what came out (it changes nothing).
    await diagnoseMix();
    said.push(`診断: ${rollPanel.info.textContent}`);
    rollPanel.info.textContent = `まとめて自動ミックスをしました。${said.map((s, k) => `${k + 1}. ${s}`).join(" ")}`;
  }
  rollPanel.onAutoMixAll = () => void autoMixAll();

  /**
   * ミックスを診断する (design.md 37): each heard track alone and the whole song (through the master, before the
   * playback's safety limiter) rendered and measured, and what stands out listed. Changes nothing.
   */
  async function diagnoseMix(): Promise<void> {
    if (lock.busy) return;
    const project = rollPanel.snapshot();
    const roles = rollPanel.roles();
    const heard = new Set(heardTracks(project));
    if (!heard.size) {
      rollPanel.info.textContent = "診断するトラック(音符があり、ミュートしていないもの)がありません。";
      return;
    }
    lock.busy = true;
    try {
      const rows: { name: string; role: string; lufs: number | null; peakDb: number | null; notes: string[] }[] = [];
      const lufsOf = new Map<number, number>();
      // The whole song and every heard track alone, side by side.
      const wholeJob = renderOff(
        { sampleRate: deps.sampleRate(), bpm: project.bpm, tracks: songTracks(project, null, null), masterFx: project.masterFx, masterAuto: renderLine(project.masterAuto, project, null), room: roomOf(project), tempoMap: tempoMapSec(project), raw: true },
        "measure",
      );
      const measured = await measureTracks(project, [...heard], "診断しています");
      for (const [i, t] of project.tracks.entries()) {
        if (!t.notes.length) continue;
        const notes = rollPanel.trackWarnings(i);
        if (!heard.has(i)) {
          rows.push({ name: t.name, role: ROLE_NAMES[roles[i]], lufs: null, peakDb: null, notes: [t.mute ? "ミュート中" : "ソロの外", ...notes] });
          continue;
        }
        const song = measured.get(i)!;
        const l = song.lufs;
        if (Number.isFinite(l) && l > -70) lufsOf.set(i, l);
        rows.push({ name: t.name, role: ROLE_NAMES[roles[i]], lufs: lufsOf.get(i) ?? null, peakDb: song.peakDb, notes });
      }
      rollPanel.info.textContent = "診断しています…(曲全体)";
      const whole = await wholeJob;
      const song = { lufs: whole.lufs, peakDb: whole.truePeakDb, correlation: whole.correlation, sideDb: whole.sideDb, balanceDb: whole.balanceDb };
      // How wide: nearly mono, or so wide it falls apart on one speaker.
      const wide = `左右の相関 ${whole.correlation.toFixed(2)}・横の成分 ${whole.sideDb.toFixed(1)} dB`;
      // What stands out.
      const points: string[] = [];
      if (whole.correlation > 0.95) points.push(`左右の広がりがほとんどありません(${wide})。和音・伴奏を左右に振るか、リバーブを少し足すと広がります。目安は相関 0.7〜0.9。`);
      else if (whole.correlation < 0.5) points.push(`左右が広がりすぎています(${wide})。スマホのスピーカーなど 1 つで鳴らすと音が痩せます。ステレオ幅のエフェクトやパンを控えめにしてください。`);
      // Leaning to one side (over 400 Hz, where the ear places a sound): the panned tracks are not shared out.
      if (Math.abs(whole.balanceDb) > 1.5) {
        const to = whole.balanceDb > 0 ? "左" : "右";
        const other = whole.balanceDb > 0 ? "右" : "左";
        points.push(`音が${to}に寄っています(中高域で${to}が ${Math.abs(whole.balanceDb).toFixed(1)} dB 大きい)。${to}に振ったトラックのうち大きいものを${other}へ移すと釣り合います。目安は 1 dB 以内。`);
      }
      // A compressor on the master (the automatic mixing never puts one there).
      if (project.masterFx.compressor.on) points.push(`マスターにコンプが入っています(レシオ ${project.masterFx.compressor.ratio}:1)。マスターのコンプはドラムの頭を通してほかを下げるので、ピークと聞こえの大きさの差を広げがちです(2 曲で測って 0.1〜1.0 dB 広がりました)。音を詰めたいなら、外して「密度を上げる」を使ってください(「自分で入れたエフェクトも整える」をオンにした「まとめて自動ミックス」は外します)。`);
      if (song.peakDb > 0) points.push(`曲全体が 0 dB を超えます(トゥルーピーク +${song.peakDb.toFixed(1)} dB)。再生と書き出しでは抑えますが、そのぶん潰れます。全体の音量(フェーダー)かマスターのコンプのメイクアップを下げると素直な音になります。`);
      const leads = [...lufsOf].filter(([i]) => roles[i] === "lead" || roles[i] === "audio").map(([, l]) => l);
      const lead = leads.length ? Math.max(...leads) : null;
      if (lead !== null) {
        for (const [i, l] of lufsOf) {
          const t = project.tracks[i];
          // (The bass may sit over the lead by what ベースの強さ asks for.)
          const allowed = lead + 1 + (roles[i] === "bass" ? project.bassLevelDb : roles[i] === "chords" || roles[i] === "backing" || roles[i] === "harmony" ? project.chordsLevelDb : 0);
          if (roles[i] !== "lead" && roles[i] !== "audio" && roles[i] !== "drum" && l > allowed) points.push(`「${t.name}」(${ROLE_NAMES[roles[i]]})がメロディより ${(l - lead).toFixed(1)} dB 大きく、メロディを隠しがちです。`);
          if (l < lead - 24) points.push(`「${t.name}」はメロディより ${(lead - l).toFixed(0)} dB 小さく、ほとんど聞こえません(要らなければミュート、要るなら音量を上げる)。`);
        }
      } else points.push("メロディのトラックがありません。ミックスの列で役割を「メロディ」にすると、自動の音量・EQ の基準になります。");
      const wet = project.tracks.filter((t, i) => heard.has(i) && t.fx.reverb.on);
      // (Many rooms at a little each are fine: counted only when they are also heavy on average.)
      const meanWet = wet.reduce((x, t) => x + t.fx.reverb.mix, 0) / Math.max(1, wet.length);
      if (wet.length >= 3 && wet.length > (heard.size * 2) / 3 && meanWet >= 0.15) points.push(`${heard.size} 本中 ${wet.length} 本にリバーブがかかっていて、量も平均 ${Math.round(meanWet * 100)}% と多めです。全体がぼやけやすいので、速いパートや低いパートからは外すか、「自分で入れたエフェクトも整える」をオンにして「まとめて自動ミックス」を試してください。`);
      // (Only when the lows were still short after the fit: a shelf at its top that got there is fine.)
      if (project.masterFx.eq.on && project.masterFx.eq.lowDb >= 6 && (rollPanel.lowsShortDb ?? -Infinity) < -6) points.push("マスター EQ の低音が上限(+6 dB)です。低音が足りない曲は、EQ よりシンセベースを重ねるほうが効果的です(「マスター EQ を目安に寄せる」のあと、足りなければ下にボタンが出ます)。");
      // The bass's lows worked against (a low cut over them, a swaying pan), and names given twice: said up top too.
      for (const r of rows) for (const n of r.notes) if (/ローカット|左右に揺れる|低音が削れて/.test(n)) points.push(`「${r.name}」: ${n}。ベースは低い音が仕事なので、エフェクトの EQ のローカット・オートパン・フィルターを外すのが目安です。`);
      const names = rows.map((r) => r.name);
      const twice = [...new Set(names.filter((n, k) => names.indexOf(n) !== k))];
      if (twice.length) points.push(`同じ名前のトラックがあります(${twice.map((n) => `「${n}」`).join("、")})。見分けやすいように名前を変えてください。`);
      for (const r of rows) if (r.peakDb !== null && r.peakDb > 0) points.push(`「${r.name}」だけで 0 dB を超えています(+${r.peakDb.toFixed(1)} dB)。トラックの音量かエフェクト(コンプのメイクアップなど)を下げてください。`);
      rollPanel.showDiagnosis(rows, song, points);
      rollPanel.info.textContent = `診断しました: 曲全体 ${song.lufs.toFixed(1)} LUFS・ピーク ${song.peakDb.toFixed(1)} dBTP、気になる点 ${points.length} 件(下の「診断の結果」)。`;
    } finally {
      lock.busy = false;
    }
  }
  rollPanel.onDiagnose = () => void diagnoseMix();
}
