import { z } from 'zod';

export const ASR_MODEL = 'mlx-community/Qwen3-ASR-1.7B-8bit';
export const PCM_RATE = 16_000;
export const MAX_RECORDING_SECONDS = 60;
export const speechInputSettingsSchema = z.object({ mode: z.enum(['hold', 'toggle']), autoSend: z.boolean() }).strict();
export type SpeechInputSettings = z.infer<typeof speechInputSettingsSchema>;
export const defaultSpeechInputSettings = (): SpeechInputSettings => ({ mode: 'hold', autoSend: false });
export const speechPcmSchema = z.object({ pcm: z.string().min(4).max(2_560_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u) }).strict();
export interface SpeechInputStatus extends SpeechInputSettings {
  state: 'idle' | 'loading' | 'transcribing' | 'ready' | 'error';
  lastSuccessAt: string | null; lastFailureAt: string | null; errorCode: string | null;
}
export interface SpeechInputAPI {
  status(): Promise<SpeechInputStatus>;
  configure(settings: SpeechInputSettings): Promise<SpeechInputStatus>;
  prepare(): Promise<void>;
  transcribe(pcm: string): Promise<string>;
  cancel(): Promise<void>;
}
