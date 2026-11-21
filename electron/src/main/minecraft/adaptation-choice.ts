import { z } from 'zod';
import type { ProviderStreamEvent } from '../providers/types';

const label = z.string().regex(/^[a-z_]{1,60}$/);
const reason = z.string().regex(/^[a-z_0-9-]{1,80}$/);

export const adaptationHelpSchema = z.object({
  requestId: z.uuid(),
  task: label,
  trigger: z.enum(['ladder_exhausted', 'no_progress']),
  current: label,
  choices: z.array(label).min(1).max(8).refine(value => new Set(value).size === value.length),
  summary: z.object({ reason, failures: z.number().int().min(0).max(3), tried: z.array(label).max(8) }).strict(),
  deadline: z.number().int().positive(),
});
export type MinecraftAdaptationHelp = z.infer<typeof adaptationHelpSchema>;

export async function chooseMinecraftAdaptation(
  request: MinecraftAdaptationHelp,
  stream: (prompt: string, signal: AbortSignal) => AsyncIterable<ProviderStreamEvent>,
  now = Date.now,
): Promise<string | null> {
  const remaining = Math.min(18_000, request.deadline - now() - 500);
  if (remaining < 1) return null;
  const signal = AbortSignal.timeout(remaining);
  // Game data only. No chat history, owner identity, coordinates or tools.
  const prompt = JSON.stringify({ task: request.task, trigger: request.trigger, current: request.current,
    choices: request.choices, failure: request.summary });
  let text = '', finished = false;
  try {
    for await (const event of stream(prompt, signal)) {
      signal.throwIfAborted();
      if (event.type === 'tool-call') return null;
      if (event.type === 'text') text += event.text ?? '';
      if (text.length > 100) return null;
      if (event.type === 'done') finished = ['stop', 'end_turn', 'completed'].includes(event.finishReason ?? '');
    }
  } catch { return null; }
  const id = text.trim();
  return finished && now() < request.deadline && request.choices.includes(id) ? id : null;
}
