import type { VoiceChunk } from '../../shared/voice';

const FRAME_SECONDS = 1 / 50;
// Speech RMS rarely passes 0.25; this maps a normal voice to a mostly open mouth.
const MOUTH_GAIN = 4;

type Scheduled = { start: number; levels: Float32Array };

const decode = (base64: string): Float32Array<ArrayBuffer> => {
  const bytes = Uint8Array.from(globalThis.atob(base64), (char) => char.charCodeAt(0));
  const samples = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
  return Float32Array.from(samples, (value) => value / 32_768);
};

/** Mouth openness for each 20 ms of a chunk, so the mouth follows the voice rather than a timer. */
export const mouthLevels = (samples: Float32Array, rate: number): Float32Array => {
  const frame = Math.max(1, Math.round(rate * FRAME_SECONDS));
  const levels = new Float32Array(Math.ceil(samples.length / frame));
  for (let index = 0; index < levels.length; index += 1) {
    let sum = 0, count = 0;
    for (let at = index * frame; at < Math.min(samples.length, (index + 1) * frame); at += 1) { sum += samples[at]! ** 2; count += 1; }
    levels[index] = Math.min(1, Math.sqrt(sum / Math.max(1, count)) * MOUTH_GAIN);
  }
  return levels;
};

/** Plays streamed speech back to back, and tells the model how open her mouth is right now. */
export class VoicePlayer {
  #context: globalThis.AudioContext | null = null;
  #id: string | null = null;
  #next = 0;
  #sources: globalThis.AudioBufferSourceNode[] = [];
  #scheduled: Scheduled[] = [];

  constructor(private readonly createContext: () => globalThis.AudioContext = () => new globalThis.AudioContext()) {}

  receive(chunk: VoiceChunk): void {
    if ('stop' in chunk) { this.stop(); return; }
    if ('done' in chunk) return;
    if (chunk.id !== this.#id) { this.stop(); this.#id = chunk.id; }
    const context = this.#context ??= this.createContext();
    const samples = decode(chunk.pcm);
    if (samples.length === 0) return;
    const buffer = context.createBuffer(1, samples.length, chunk.rate);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    // A little lead keeps the first chunk from clipping; later chunks join without a gap.
    const start = Math.max(this.#next, context.currentTime + 0.05);
    source.start(start);
    this.#next = start + buffer.duration;
    this.#sources.push(source);
    this.#scheduled.push({ start, levels: mouthLevels(samples, chunk.rate) });
    source.onended = () => { this.#sources = this.#sources.filter((item) => item !== source); };
  }

  /** Null when she is not talking, so the model keeps its own mouth. */
  mouth(): number | null {
    const context = this.#context;
    if (context === null || this.#scheduled.length === 0) return null;
    const now = context.currentTime;
    this.#scheduled = this.#scheduled.filter((item) => now < item.start + item.levels.length * FRAME_SECONDS);
    const current = this.#scheduled.find((item) => now >= item.start);
    if (current === undefined) return this.#scheduled.length > 0 ? 0 : null;
    return current.levels[Math.floor((now - current.start) / FRAME_SECONDS)] ?? 0;
  }

  stop(): void {
    for (const source of this.#sources) { try { source.stop(); } catch { /* already ended */ } }
    this.#sources = [];
    this.#scheduled = [];
    this.#next = 0;
    this.#id = null;
  }

  dispose(): void {
    this.stop();
    void this.#context?.close().catch(() => undefined);
    this.#context = null;
  }
}
