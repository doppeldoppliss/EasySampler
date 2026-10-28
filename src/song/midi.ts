// Reading a Standard MIDI File (.mid) for "曲で試す": every note with its
// start and end in seconds (the tempo map applied), per track, plus where
// the bars fall. Controllers, pitch bends, sysex and the like are skipped —
// the material plays the notes, nothing more.

export interface SongNote {
  /** Seconds from the start of the file. */
  start: number;
  end: number;
  /** 0–127; 60 = C4. */
  pitch: number;
  /** 1–127. */
  velocity: number;
  /** 0–15 (the GM drum channel, "channel 10", is 9). */
  channel: number;
  /** The same start and end in beats (quarter notes) from the start, whatever the tempo. */
  startBeat: number;
  endBeat: number;
}

export interface SongTrack {
  /** Position in the file, from 0. */
  index: number;
  name: string;
  /** The first program change (GM instrument), or null when there's none. */
  program: number | null;
  /** Sorted by start. */
  notes: SongNote[];
}

export interface Song {
  /** Only the tracks with notes, in file order. */
  tracks: SongTrack[];
  /** Where each bar starts (seconds), the last entry being the end of the last bar. */
  bars: number[];
  /** When the last note ends. */
  durationSec: number;
  /** The tempo at the start. */
  bpm: number;
  hasTempoChanges: boolean;
  /** The tempo changes after the start (beats from the start, sorted). */
  tempos: { beat: number; bpm: number }[];
}

export class MidiParseError extends Error {}

const DEFAULT_TEMPO_US = 500_000; // 120 BPM

interface TempoPoint {
  tick: number;
  usPerBeat: number;
}

/** Ticks → seconds through the tempo map (sorted by tick, starting at tick 0). */
function tickClock(tempos: TempoPoint[], ppq: number): (tick: number) => number {
  const starts: number[] = [];
  let sec = 0;
  for (let i = 0; i < tempos.length; i++) {
    if (i > 0) sec += ((tempos[i].tick - tempos[i - 1].tick) * tempos[i - 1].usPerBeat) / ppq / 1e6;
    starts.push(sec);
  }
  return (tick) => {
    let i = tempos.length - 1;
    while (i > 0 && tempos[i].tick > tick) i--;
    return starts[i] + ((tick - tempos[i].tick) * tempos[i].usPerBeat) / ppq / 1e6;
  };
}

export function parseMidi(data: ArrayBuffer | Uint8Array): Song {
  const b = data instanceof Uint8Array ? data : new Uint8Array(data);
  let p = 0;
  const need = (n: number) => {
    if (p + n > b.length) throw new MidiParseError("ファイルが途中で終わっています。");
  };
  const u8 = () => (need(1), b[p++]);
  const u16 = () => (need(2), (b[p++] << 8) | b[p++]);
  const u32 = () => (need(4), ((b[p++] << 24) | (b[p++] << 16) | (b[p++] << 8) | b[p++]) >>> 0);
  const vlq = () => {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const c = u8();
      v = v * 128 + (c & 0x7f);
      if (!(c & 0x80)) return v;
    }
    throw new MidiParseError("MIDI の可変長の値が壊れています。");
  };
  const tag = () => (need(4), String.fromCharCode(b[p++], b[p++], b[p++], b[p++]));

  if (b.length < 14 || tag() !== "MThd") throw new MidiParseError("MIDI ファイル(.mid)ではないようです。");
  const headerLength = u32();
  const headerEnd = p + headerLength;
  u16(); // format: 0 and 1 read the same way; 2 (rare) is read as if it were 1
  const trackCount = u16();
  const division = u16();
  if (division & 0x8000) throw new MidiParseError("SMPTE 形式の時間単位の MIDI には対応していません。");
  const ppq = division || 96;
  p = headerEnd;

  interface RawNote {
    startTick: number;
    endTick: number;
    pitch: number;
    velocity: number;
    channel: number;
  }
  const tempos: TempoPoint[] = [];
  const signatures: { tick: number; numerator: number; denominator: number }[] = [];
  const raw: { index: number; name: string; program: number | null; notes: RawNote[] }[] = [];
  let lastTick = 0;

  for (let t = 0; t < trackCount && p + 8 <= b.length; t++) {
    const id = tag();
    const length = u32();
    if (p + length > b.length) throw new MidiParseError("ファイルが途中で終わっています。");
    const end = p + length;
    if (id !== "MTrk") {
      p = end;
      continue;
    }
    let tick = 0;
    let running = 0;
    let name = "";
    let program: number | null = null;
    const notes: RawNote[] = [];
    // Notes still held, by channel × pitch (a stack, for overlapping same-pitch notes).
    const open = new Map<number, RawNote[]>();
    while (p < end) {
      tick += vlq();
      let status = b[p];
      if (status & 0x80) p++;
      else if (running) status = running;
      else throw new MidiParseError("MIDI のイベントが壊れています。");
      if (status === 0xff) {
        const type = u8();
        const len = vlq();
        need(len);
        const d = b.subarray(p, p + len);
        p += len;
        if (type === 0x03 && !name) name = new TextDecoder().decode(d).trim();
        else if (type === 0x51 && len >= 3) tempos.push({ tick, usPerBeat: (d[0] << 16) | (d[1] << 8) | d[2] || DEFAULT_TEMPO_US });
        else if (type === 0x58 && len >= 2) signatures.push({ tick, numerator: d[0] || 4, denominator: 2 ** d[1] });
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        p += vlq();
        continue;
      }
      running = status;
      const kind = status & 0xf0;
      const channel = status & 0x0f;
      const a = u8();
      const c = kind === 0xc0 || kind === 0xd0 ? 0 : u8();
      const key = channel * 128 + a;
      if (kind === 0x90 && c > 0) {
        const n: RawNote = { startTick: tick, endTick: -1, pitch: a, velocity: c, channel };
        notes.push(n);
        const stack = open.get(key);
        if (stack) stack.push(n);
        else open.set(key, [n]);
      } else if (kind === 0x80 || (kind === 0x90 && c === 0)) {
        const n = open.get(key)?.shift();
        if (n) n.endTick = tick;
      } else if (kind === 0xc0 && program === null) {
        program = a;
      }
    }
    p = end;
    lastTick = Math.max(lastTick, tick);
    for (const n of notes) if (n.endTick < 0) n.endTick = tick;
    if (notes.length > 0) raw.push({ index: t, name, program, notes });
  }

  tempos.sort((x, y) => x.tick - y.tick);
  if (tempos.length === 0 || tempos[0].tick > 0) tempos.unshift({ tick: 0, usPerBeat: DEFAULT_TEMPO_US });
  const toSec = tickClock(tempos, ppq);

  const tracks: SongTrack[] = raw.map((r) => ({
    index: r.index,
    name: r.name,
    program: r.program,
    notes: r.notes
      .map((n) => ({ start: toSec(n.startTick), end: toSec(Math.max(n.endTick, n.startTick)), pitch: n.pitch, velocity: n.velocity, channel: n.channel, startBeat: n.startTick / ppq, endBeat: Math.max(n.endTick, n.startTick) / ppq }))
      .sort((x, y) => x.start - y.start || x.pitch - y.pitch),
  }));

  const lastNoteTick = Math.max(0, ...raw.flatMap((r) => r.notes.map((n) => n.endTick)));
  const durationSec = toSec(lastNoteTick);

  // Bars: walk the time signatures (4/4 when there's none) up to the end.
  signatures.sort((x, y) => x.tick - y.tick);
  const bars: number[] = [];
  let tick = 0;
  let sig = 0;
  const endTick = Math.max(lastNoteTick, 1);
  while (bars.length < 10_000) {
    while (sig + 1 < signatures.length && signatures[sig + 1].tick <= tick) sig++;
    const s = signatures[sig] && signatures[sig].tick <= tick ? signatures[sig] : { numerator: 4, denominator: 4 };
    bars.push(toSec(tick));
    if (tick >= endTick) break;
    tick += Math.max(1, Math.round((s.numerator * 4 * ppq) / s.denominator));
  }

  return {
    tracks,
    bars,
    durationSec,
    bpm: 60e6 / tempos[0].usPerBeat,
    hasTempoChanges: tempos.some((x) => x.usPerBeat !== tempos[0].usPerBeat),
    tempos: tempos.filter((x) => x.tick > 0).map((x) => ({ beat: x.tick / ppq, bpm: 60e6 / x.usPerBeat })),
  };
}

/** Whether a file is a standard MIDI file (by its name or type). */
export function isMidiFile(file: File): boolean {
  return /\.(mid|midi|smf)$/i.test(file.name) || file.type === "audio/midi" || file.type === "audio/x-midi";
}
