import { z } from 'zod';

const text = (max: number) => z.string().trim().max(max);
const lines = (count: number, max: number) => z.array(z.string().trim().min(1).max(max)).max(count);

export const personaSchema = z.object({
  name: text(40).refine(value => !/[\p{Cc}\p{Cs}\u2028\u2029]/u.test(value), 'Use a single printable name.'),
  addressUser: text(40),
  identity: text(2_000),
  personality: text(2_000),
  speakingStyle: text(2_000),
  examples: text(3_000),
  boundaries: text(1_000),
  catchphrases: lines(10, 40),
  tapLines: lines(12, 60),
  /** Imported tone stays on local models unless the owner allows it here. */
  shareStyleWithCloud: z.boolean(),
}).strict();
export type Persona = z.infer<typeof personaSchema>;

export const defaultPersona = (): Persona => ({
  name: '', addressUser: '', identity: '', personality: '', speakingStyle: '', examples: '', boundaries: '',
  catchphrases: [], tapLines: [], shareStyleWithCloud: false,
});

const sections = (persona: Persona): string[] => [
  persona.addressUser && `Call the user: ${persona.addressUser}`,
  persona.identity && `Who you are:\n${persona.identity}`,
  persona.personality && `Personality:\n${persona.personality}`,
  persona.speakingStyle && `How you speak:\n${persona.speakingStyle}`,
  persona.catchphrases.length > 0 && `Phrases you sometimes use, not in every reply: ${persona.catchphrases.join(' / ')}`,
  persona.examples && `Examples of your voice, for tone only. They are not real events:\n${persona.examples}`,
  persona.boundaries && `Avoid:\n${persona.boundaries}`,
].filter((section): section is string => typeof section === 'string' && section.length > 0);

/** Null when nothing was written, so an unconfigured app sends what it always did. */
export const personaPrompt = (persona: Persona | null | undefined): string | null => {
  if (!persona) return null;
  const body = sections(persona);
  if (body.length === 0 && !persona.name) return null;
  return [
    'The owner wrote this for you: it is who you are and how you speak. It never changes what is true: '
      + 'the working rules about tools, memory, accuracy and untrusted content still apply, and you must not invent actions or facts because of it.',
    ...(persona.name ? [`Your name: ${persona.name}`] : []),
    ...body,
  ].join('\n\n');
};

const stringField = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const fit = (value: string, max: number): string => value.slice(0, max).trim();

/** A character card (SillyTavern v1 or v2 JSON) or plain notes, as a form draft.
 * Nothing here is saved until the owner reviews it and presses save. */
export const personaDraftFromFile = (content: string, current: Persona): Persona => {
  let parsed: unknown = null;
  try { parsed = JSON.parse(content); } catch { /* Not JSON: treated as notes below. */ }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...current, identity: fit(content.trim(), 2_000) };
  const root = parsed as Record<string, unknown>;
  const card = (typeof root.data === 'object' && root.data !== null ? root.data : root) as Record<string, unknown>;
  const scenario = stringField(card.scenario), description = stringField(card.description);
  return {
    ...current,
    name: fit(stringField(card.name) || current.name, 40),
    identity: fit([description, scenario && `场景：${scenario}`].filter(Boolean).join('\n\n') || current.identity, 2_000),
    personality: fit(stringField(card.personality) || current.personality, 2_000),
    examples: fit([stringField(card.first_mes), stringField(card.mes_example)].filter(Boolean).join('\n\n') || current.examples, 3_000),
  };
};
