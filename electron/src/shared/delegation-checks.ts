import { z } from 'zod';

const id = z.string().uuid();
export const requirementSchema = z.discriminatedUnion('kind', [
  z.object({ id, kind: z.literal('exact-text'), expected: z.string().max(4000) }).strict(),
  z.object({ id, kind: z.literal('english-word-count'), min: z.number().int().min(0).max(50_000), max: z.number().int().min(0).max(50_000) })
    .strict().refine((value) => value.min <= value.max, 'The minimum word count cannot exceed the maximum.'),
  z.object({ id, kind: z.literal('unimplemented'), description: z.string().min(1).max(2000) }).strict(),
]);
export const requirementsSchema = z.array(requirementSchema).max(10)
  .refine((items) => new Set(items.map((item) => item.id)).size === items.length, 'Requirement IDs must be unique.');
export type Requirement = z.infer<typeof requirementSchema>;

export const checkResultSchema = z.object({
  id,
  kind: z.enum(['exact-text', 'english-word-count', 'unimplemented']),
  status: z.enum(['passed', 'failed', 'unchecked']),
  actualWordCount: z.number().int().nonnegative().optional(),
  policy: z.enum(['nfc-crlf-full-body-v1', 'ascii-words-v1', 'unsupported']),
}).strict();
export type CheckResult = z.infer<typeof checkResultSchema>;

/** Normalize only Unicode composition and CRLF. Whitespace and case remain significant. */
export const normalizeExactText = (text: string): string => text.replaceAll('\r\n', '\n').normalize('NFC');

/** Count ASCII letter runs, retaining internal apostrophes or hyphens as one word.
 * Digits and other characters separate words. This counts the entire stored body,
 * including text inside code or markup; it is not a tokenizer or language detector.
 */
export const englishWordCount = (body: string): number => (body.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/gu) ?? []).length;

/** Mechanical checks never produce a factual verdict or echo matched output. */
export const evaluateRequirements = (body: string, rawRequirements: readonly Requirement[]): CheckResult[] =>
  requirementsSchema.parse(rawRequirements).map((requirement): CheckResult => {
    if (requirement.kind === 'exact-text') return {
      id: requirement.id, kind: requirement.kind,
      status: normalizeExactText(body) === normalizeExactText(requirement.expected) ? 'passed' : 'failed',
      policy: 'nfc-crlf-full-body-v1',
    };
    if (requirement.kind === 'english-word-count') {
      const actualWordCount = englishWordCount(body);
      return { id: requirement.id, kind: requirement.kind,
        status: actualWordCount >= requirement.min && actualWordCount <= requirement.max ? 'passed' : 'failed',
        actualWordCount, policy: 'ascii-words-v1' };
    }
    return { id: requirement.id, kind: requirement.kind, status: 'unchecked', policy: 'unsupported' };
  });

/** The exact confirmed rules may be included in that child's explicit instruction. */
export const describeRequirements = (rawRequirements: readonly Requirement[]): string =>
  requirementsSchema.parse(rawRequirements).map((requirement) => {
    if (requirement.kind === 'exact-text') return `Exact full-body text: ${JSON.stringify(requirement.expected)}. Compare after NFC and CRLF-to-LF normalization only; preserve case and all other whitespace.`;
    if (requirement.kind === 'english-word-count') return `English word count of the entire body: ${requirement.min}–${requirement.max} inclusive. Count ASCII letter runs, keeping internal apostrophes and hyphens as one word; digits and other characters are separators. Include code/markup text. This is not output token count.`;
    return `User requirement (not mechanically checked): ${requirement.description}`;
  }).join('\n');
