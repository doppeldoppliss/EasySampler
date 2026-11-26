// 埋もれ diagnosis (design.md 50): which tracks the others cover, said in the words of ミックスを診断する. The
// figures come from audio/ear.ts (each track alone and the rest as the others added); this file only decides what
// is worth saying.

import type { Audibility } from "../audio/ear";
import { ROLE_NAMES, type Role } from "./roles";

/**
 * Under this share of the mix's loudness while it plays, a track is as good as not heard (a melody: under the
 * second). Set on a real song of 16 tracks: its hand mix had a bass at 0.1%, chords and a pad at 0.8–1.6% and a
 * melody at 1.8% that listening to it alone shows are there but in the mix are not; after the automatic mixing the
 * least was 2.3% and every melody 6.8% or more.
 */
export const BURIED_SHARE = 0.015;
export const LEAD_BURIED_SHARE = 0.04;
/** Played for less of the song than this, it is not judged (a fill, an ending). */
const MIN_PLAYING = 0.05;

export interface HeardTrack {
  name: string;
  role: Role;
  heard: Audibility | null;
}

export const hzText = (hz: number) => (hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${Math.round(hz / 10) * 10} Hz`);
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
const isLead = (role: Role) => role === "lead" || role === "audio";

/** The table's cell: its share, and what covers it where. */
export function heardCell(t: HeardTrack, all: readonly HeardTrack[]): string {
  const a = t.heard;
  if (!a || a.playing < MIN_PLAYING) return "—";
  const by = a.coveredBy !== null ? all[a.coveredBy]?.name : undefined;
  return `${(a.share * 100).toFixed(1)}%${by ? `(「${by}」・${hzText(a.worstHz)})` : ""}`;
}

/** What stands out: tracks as good as unheard, and two tracks of one part covering each other. */
export function buriedPoints(tracks: readonly HeardTrack[]): string[] {
  const points: string[] = [];
  const said = new Set<number>();
  tracks.forEach((t, i) => {
    const a = t.heard;
    if (!a || a.playing < MIN_PLAYING) return;
    const lead = isLead(t.role);
    if (a.share >= (lead ? LEAD_BURIED_SHARE : BURIED_SHARE)) return;
    said.add(i);
    const by = a.coveredBy !== null ? tracks[a.coveredBy] : undefined;
    const when = `鳴っている間の聞こえの ${(a.share * 100).toFixed(1)}%${a.leastFrom !== null ? `、特に ${mmss(a.leastFrom)} から` : ""}`;
    const who = lead ? `メロディ「${t.name}」がほかの音に隠れています` : `「${t.name}」(${ROLE_NAMES[t.role]})はほかの音に隠れて、ほとんど聞こえていません`;
    // (The lows stay in the middle: no panning a bass or a drum away from what covers it.)
    const pan = by && t.role !== "bass" && t.role !== "drum" && by.role !== "bass" && by.role !== "drum" ? "パンを反対に振る、" : "";
    const fix = by
      ? `主に「${by.name}」が ${hzText(a.worstHz)} あたりで隠しています。「${by.name}」の EQ でその辺りを少し下げる、${pan}${lead ? "メロディ" : "このトラック"}の音量を上げる${lead ? "" : "、要らなければミュートする"}、のどれかで聞こえるようになります。`
      : `音量を上げるか、要らなければミュートしてください。`;
    points.push(`${who}(${when})。${fix}`);
  });
  // Two tracks of one part, each the other's cover: the same notes' range twice.
  tracks.forEach((t, i) => {
    const a = t.heard;
    const j = a?.coveredBy;
    if (!a || j === null || j === undefined || j <= i || a.playing < MIN_PLAYING) return;
    const o = tracks[j];
    if (!o?.heard || o.heard.coveredBy !== i || o.role !== t.role || t.role === "drum" || (said.has(i) && said.has(j))) return;
    points.push(`「${t.name}」と「${o.name}」(どちらも${ROLE_NAMES[t.role]})が同じ音域(${hzText(a.worstHz)} あたり)で同時に鳴り、互いを隠しています。片方の EQ でその辺りを下げるか、オクターブや鳴らす場所を分けると、両方はっきりします。`);
  });
  return points;
}
