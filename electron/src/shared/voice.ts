import { z } from 'zod';

/** Kept in its own file so an older build reading settings.json never meets an unknown key. */
export const voiceSettingsSchema = z.object({
  enabled: z.boolean(),
  /** A folder the owner chose holding the Python environment, the model cache and her reference voice. */
  runtimeDir: z.string().min(1).max(1_024).nullable(),
}).strict();
export type VoiceSettings = z.infer<typeof voiceSettingsSchema>;
export const defaultVoiceSettings = (): VoiceSettings => ({ enabled: false, runtimeDir: null });

export const VOICE_MODEL = 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16';

export type VoiceProblem = 'folder' | 'python' | 'model' | 'reference' | 'worker';
export type VoiceStatus = VoiceSettings & {
  /** off: disabled; idle: ready, model not loaded; loading: starting the worker; ready: loaded; speaking: playing a reply. */
  state: 'off' | 'missing' | 'idle' | 'loading' | 'ready' | 'speaking' | 'error';
  problem: VoiceProblem | null;
};

/** One streamed piece of speech for the overlay; `pcm` is base64 16-bit little-endian mono. */
export type VoiceChunk =
  | { id: string; pcm: string; rate: number }
  | { id: string; done: true }
  | { id: null; stop: true };

const MAX_SPOKEN = 400;

/** What of a reply is worth saying aloud: no code, links, markdown or emoji, and not too long. */
export const speakableText = (text: string): string => {
  const plain = text
    .replace(/```[\s\S]*?(```|$)/gu, ' ')
    .replace(/`[^`\n]*`/gu, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/https?:\/\/\S+/gu, ' ')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gmu, '')
    .replace(/[*_~|#>]+/gu, '')
    .replace(/\p{Extended_Pictographic}\uFE0F?/gu, '')
    .split('\n').map((line) => line.replace(/[ \t]+/gu, ' ').trim()).filter(Boolean).join('\n');
  if (plain.length <= MAX_SPOKEN) return plain;
  // Stop at the last sentence end that fits, so she never trails off mid-word.
  const head = plain.slice(0, MAX_SPOKEN);
  const end = Math.max(...['。', '！', '？', '!', '?', '.', '\n', '～'].map((mark) => head.lastIndexOf(mark)));
  return (end > MAX_SPOKEN / 3 ? head.slice(0, end + 1) : head).trim();
};
