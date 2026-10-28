// A MIDI keyboard (Web MIDI): its keys play like the on-screen keyboard's (and
// go into step input and recordings the same way). Every input connected is
// heard, also ones plugged in later. Not every browser has Web MIDI (Safari).

export interface MidiSink {
  noteOn(note: number, velocity: number): void;
  noteOff(note: number): void;
}

export class MidiInput {
  private access: MIDIAccess | null = null;
  /** The inputs' names changed (one plugged in or out). */
  onChange: (names: string[]) => void = () => {};

  private readonly sink: MidiSink;

  constructor(sink: MidiSink) {
    this.sink = sink;
  }

  static get supported(): boolean {
    return typeof navigator !== "undefined" && typeof navigator.requestMIDIAccess === "function";
  }

  get connected(): boolean {
    return this.access !== null;
  }

  /** Asks for MIDI (the browser may ask the user) and listens to every input. */
  async connect(): Promise<string[]> {
    if (!this.access) {
      this.access = await navigator.requestMIDIAccess();
      this.access.onstatechange = () => this.onChange(this.attach());
    }
    return this.attach();
  }

  private attach(): string[] {
    const names: string[] = [];
    for (const input of this.access?.inputs.values() ?? []) {
      input.onmidimessage = (e) => this.message(e.data);
      if (input.state === "connected") names.push(input.name || "MIDI 入力");
    }
    return names;
  }

  private message(data: Uint8Array | null): void {
    if (!data || data.length < 3) return;
    const kind = data[0] & 0xf0;
    const note = data[1];
    const velocity = data[2];
    if (kind === 0x90 && velocity > 0) this.sink.noteOn(note, velocity / 127);
    else if (kind === 0x80 || (kind === 0x90 && velocity === 0)) this.sink.noteOff(note);
  }
}
