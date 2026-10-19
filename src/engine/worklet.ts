// The engine inside an AudioWorklet: messages in, stereo out. Everything
// heavy (analysis, resampling) happened before the material got here; this
// only renders.

import { Engine } from "./engine";
import type { FromEngine, ToEngine } from "./messages";

// The AudioWorklet globals (the project is typed against the DOM library).
declare const sampleRate: number;
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessorLike): void;
declare class AudioWorkletProcessorLike {
  readonly port: MessagePort;
}
declare const AudioWorkletProcessor: typeof AudioWorkletProcessorLike;

/** How often the voice count is reported (render quanta ≈ 0.1 s). */
const STATUS_EVERY = 32;

class EngineProcessor extends AudioWorkletProcessor {
  private engine = new Engine(sampleRate);
  private quanta = 0;
  private lastVoices = -1;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<ToEngine>) => this.handle(event.data);
  }

  private handle(message: ToEngine): void {
    switch (message.type) {
      case "source":
        this.engine.setSource(message.source);
        break;
      case "instrument":
        this.engine.setInstrument(message.markers, message.params);
        break;
      case "noteOn":
        this.engine.noteOn(message.note, message.velocity);
        break;
      case "noteOff":
        this.engine.noteOff(message.note);
        break;
      case "allOff":
        this.engine.allOff();
        break;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    const left = output[0];
    if (!left) return true;
    const right = output[1] ?? left;
    this.engine.render(left, right, left.length);
    if (++this.quanta >= STATUS_EVERY) {
      this.quanta = 0;
      const voices = this.engine.activeVoices();
      if (voices !== this.lastVoices) {
        this.lastVoices = voices;
        this.port.postMessage({ type: "status", voices } satisfies FromEngine);
      }
    }
    return true;
  }
}

registerProcessor("maddaw-engine", EngineProcessor);
