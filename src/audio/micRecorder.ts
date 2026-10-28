// Recording a material from the microphone (design.md 13): the browser's own
// recorder, with its voice processing turned off (a material wants the voice
// as it is). What it gives is a compressed file the page opens like any other.

const TYPES = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"];

export class MicRecorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;

  static get supported(): boolean {
    return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
  }

  get recording(): boolean {
    return this.recorder !== null;
  }

  /** Seconds since it started (0 when not recording). */
  get elapsed(): number {
    return this.recorder ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  /** Asks for the microphone (the browser may ask the user) and starts recording. */
  async start(): Promise<void> {
    if (this.recorder) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const type = TYPES.find((t) => MediaRecorder.isTypeSupported?.(t));
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 256_000 } : undefined);
    } catch {
      recorder = new MediaRecorder(stream);
    }
    this.chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this.stream = stream;
    this.recorder = recorder;
    this.startedAt = performance.now();
    recorder.start();
  }

  /** Stops, lets the microphone go, and gives the recording as a file named \`baseName\` (with the right extension). */
  stop(baseName: string): Promise<File> {
    const recorder = this.recorder;
    if (!recorder) return Promise.reject(new Error("録音していません"));
    return new Promise((resolve, reject) => {
      recorder.onstop = () => {
        const type = recorder.mimeType || this.chunks[0]?.type || "audio/webm";
        const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
        const blob = new Blob(this.chunks, { type });
        this.release();
        if (!blob.size) reject(new Error("音が録れませんでした"));
        else resolve(new File([blob], `${baseName}.${ext}`, { type }));
      };
      recorder.stop();
    });
  }

  /** Stops without keeping anything. */
  cancel(): void {
    if (!this.recorder) return;
    this.recorder.onstop = null;
    if (this.recorder.state !== "inactive") this.recorder.stop();
    this.release();
  }

  private release(): void {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
  }
}
