import { z } from 'zod';

const id = z.string().min(1).max(240);
const status = z.enum(['in_progress', 'completed', 'incomplete']);
// Only replayable text/reasoning/function items are admitted. Hosted tools,
// arbitrary server fields and hidden plaintext reasoning are not forwarded.
export const providerResponseItemSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('reasoning'), id,
    summary: z.array(z.object({ type: z.literal('summary_text'), text: z.string().max(256_000) }).strip()).max(128),
    encrypted_content: z.string().max(2 * 1024 * 1024).nullable().optional(), status: status.optional(),
  }).strip(),
  z.object({ type: z.literal('function_call'), id: id.optional(), call_id: id,
    name: z.string().min(1).max(128), arguments: z.string().max(1024 * 1024), status: status.optional(),
  }).strip(),
  z.object({ type: z.literal('message'), id: id.optional(), role: z.literal('assistant'), status: status.optional(),
    phase: z.enum(['commentary', 'final_answer']).nullable().optional(),
    content: z.array(z.discriminatedUnion('type', [
      z.object({ type: z.literal('output_text'), text: z.string().max(256_000) }).strip(),
      z.object({ type: z.literal('refusal'), refusal: z.string().max(256_000) }).strip(),
    ])).max(128),
  }).strip(),
]);
export const providerResponseItemsSchema = z.array(providerResponseItemSchema).max(128);
export type ProviderResponseItem = z.infer<typeof providerResponseItemSchema>;
