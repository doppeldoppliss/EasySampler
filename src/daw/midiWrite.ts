// The song as a standard MIDI file (design.md 13, phase 3), for taking the
// notes to another DAW: format 1, a tempo track, then one track per song
// track. A drum track's notes (on GM drum keys already) go out on channel 10.

import type { Project } from "./model";

const PPQ = 480;

function vlq(value: number): number[] {
  const out = [value & 0x7f];
  let v = value >>> 7;
  while (v > 0) {
    out.unshift((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  return out;
}

function text(type: number, s: string): number[] {
  const bytes = [...new TextEncoder().encode(s)];
  return [0, 0xff, type, ...vlq(bytes.length), ...bytes];
}

function chunk(events: number[]): number[] {
  const n = events.length;
  return [0x4d, 0x54, 0x72, 0x6b, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255, ...events];
}

export function writeMidi(project: Project): Uint8Array<ArrayBuffer> {
  const tempoEvent = (bpm: number) => {
    const us = Math.round(60e6 / bpm);
    return [0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255];
  };
  const conductor = [...text(0x03, "EasySampler"), 0, ...tempoEvent(project.bpm), 0, 0xff, 0x58, 4, project.beatsPerBar, 2, 24, 8];
  // The tempo changes, each at its tick.
  let lastTick = 0;
  for (const c of project.tempos) {
    const tick = Math.round(c.beat * PPQ);
    conductor.push(...vlq(tick - lastTick), ...tempoEvent(c.bpm));
    lastTick = tick;
  }
  conductor.push(0, 0xff, 0x2f, 0);
  const chunks = [chunk(conductor)];
  let channel = 0;
  for (const track of project.tracks) {
    const drum = track.kind === "drum";
    const ch = drum ? 9 : channel;
    if (!drum) channel = channel + 1 === 9 ? 10 : (channel + 1) % 16;
    const events: { tick: number; on: boolean; key: number; velocity: number }[] = [];
    for (const n of track.notes) {
      const key = n.pitch;
      if (key < 0 || key > 127) continue;
      const start = Math.round(n.start * PPQ);
      const end = Math.max(start + 1, Math.round((n.start + n.length) * PPQ));
      const velocity = Math.max(1, Math.min(127, Math.round(n.velocity * 127)));
      events.push({ tick: start, on: true, key, velocity }, { tick: end, on: false, key, velocity: 0 });
    }
    // Note-offs before note-ons at the same tick (a repeated note re-strikes).
    events.sort((a, b) => a.tick - b.tick || Number(a.on) - Number(b.on));
    const body = [...text(0x03, track.name)];
    let last = 0;
    for (const e of events) {
      body.push(...vlq(e.tick - last), (e.on ? 0x90 : 0x80) | ch, e.key, e.on ? e.velocity : 0);
      last = e.tick;
    }
    body.push(0, 0xff, 0x2f, 0);
    chunks.push(chunk(body));
  }
  const count = chunks.length;
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, (count >> 8) & 255, count & 255, (PPQ >> 8) & 255, PPQ & 255];
  return new Uint8Array([...header, ...chunks.flat()]);
}
