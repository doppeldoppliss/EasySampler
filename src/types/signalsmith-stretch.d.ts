// The parts of signalsmith-stretch's API this app uses (the package ships no types).
declare module "signalsmith-stretch" {
  export interface StretchSchedule {
    active?: boolean;
    /** Context time of the change. (The package reads `outputTime`; `output` is what it stores.) */
    outputTime?: number;
    output?: number;
    /** Position in the input buffer (seconds). */
    input?: number;
    rate?: number;
    semitones?: number;
    tonalityHz?: number;
    formantSemitones?: number;
    formantCompensation?: boolean;
    formantBaseHz?: number;
    loopStart?: number;
    loopEnd?: number;
  }

  export interface StretchNode extends AudioWorkletNode {
    schedule(change: StretchSchedule, adjustPrevious?: boolean): Promise<StretchSchedule>;
    addBuffers(channels: Float32Array[]): Promise<number>;
    dropBuffers(toSeconds?: number): Promise<{ start: number; end: number }>;
    latency(): Promise<number>;
    configure(config: { blockMs?: number | null; intervalMs?: number; splitComputation?: boolean; preset?: "default" | "cheaper" }): Promise<void>;
    start(when?: number): Promise<StretchSchedule>;
    stop(when?: number): Promise<StretchSchedule>;
  }

  export default function SignalsmithStretch(context: BaseAudioContext, options?: AudioWorkletNodeOptions): Promise<StretchNode>;
}
