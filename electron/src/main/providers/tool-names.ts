import { createHash } from 'node:crypto';

const FUNCTION_NAME = /^[A-Za-z0-9_-]{1,64}$/u;

const hashedToolName = (name: string): string => {
  if (name.length === 0) throw new Error('A tool name cannot be empty.');
  const readable = name.replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 40);
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 16);
  return `${readable}_${digest}`;
};

/** Readable declarations help models copy names exactly; registry IDs stay intact. */
export const providerToolName = (name: string): string => {
  const readable = name.replaceAll('.', '_');
  return FUNCTION_NAME.test(readable) ? readable : hashedToolName(name);
};

export const providerToolNames = (names: readonly string[]): Map<string, string> => {
  const uniqueNames = [...new Set(names)];
  const candidates = uniqueNames.map(providerToolName);
  const wireToInternal = new Map<string, string>();
  for (const name of uniqueNames) {
    const candidate = providerToolName(name);
    // An existing legal ID retains its name. A dotted ID uses a hash only
    // when the readable spelling would collide with another declared tool.
    const wireName = !FUNCTION_NAME.test(name) && candidates.filter((value) => value === candidate).length > 1
      ? hashedToolName(name) : candidate;
    const existing = wireToInternal.get(wireName);
    if (existing !== undefined && existing !== name) throw new Error('Provider tool names are ambiguous.');
    wireToInternal.set(wireName, name);
  }
  return wireToInternal;
};
