import { z } from 'zod';
import { MAX_OUTPUT_TOKENS } from '../shared/output-limits';
import { providerResponseItemsSchema } from '../main/providers/response-items';

const providerConfig = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(['openai', 'openrouter', 'openai-compatible', 'minimax', 'glm', 'deepseek', 'ollama', 'lm-studio']),
    name: z.string().max(240),
    baseUrl: z.url().max(2_048),
    model: z.string().max(240),
    enabled: z.boolean(),
    supportsTools: z.boolean(),
    localExecutionConfirmed: z.boolean().optional(),
    ollamaNumCtx: z.number().int().min(512).max(131_072).optional(),
    contextWindowTokens: z.number().int().min(512).max(131_072).optional(),
    maxOutputTokens: z.number().int().min(1).max(MAX_OUTPUT_TOKENS).optional(),
    outputTokenParameter: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
    secretState: z.enum(['configured', 'missing', 'unavailable']),
  })
  .strict();

const credentials = z.object({ config: providerConfig, apiKey: z.string().max(16_384).nullable() }).strict();
const model = z.object({
  id: z.string().trim().min(1).max(240), displayName: z.string().max(240),
  contextWindow: z.number().int().positive().nullable(), supportsTools: z.boolean(),
  availability: z.enum(['provider-listed', 'reference']).optional(),
  pricing: z.object({
    currency: z.enum(['USD', 'CNY']), inputPerMillion: z.number().finite().nonnegative().max(1e12).nullable(),
    outputPerMillion: z.number().finite().nonnegative().max(1e12).nullable(),
    cachedInputPerMillion: z.number().finite().nonnegative().max(1e12).nullable().optional(),
    cacheWriteInputPerMillion: z.number().finite().nonnegative().max(1e12).nullable().optional(),
    longContext: z.object({ inputThreshold: z.number().int().positive(), inputPerMillion: z.number().finite().nonnegative().max(1e12),
      outputPerMillion: z.number().finite().nonnegative().max(1e12), cachedInputPerMillion: z.number().finite().nonnegative().max(1e12).nullable().optional(),
      cacheWriteInputPerMillion: z.number().finite().nonnegative().max(1e12).nullable().optional() }).strict().optional(),
    source: z.enum(['provider-api', 'reference']), sourceUrl: z.url().max(2048), checkedAt: z.iso.datetime(),
    note: z.string().max(1000).optional(), unsupportedReason: z.string().max(1000).optional(),
  }).strict().optional(),
}).strict();
const toolThought = z.object({ protocol: z.enum(['deepseek','ollama']), content: z.string().max(256_000), bindingDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const message = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string().max(256_000),
    toolCallId: z.string().max(240).optional(),
    toolThought: toolThought.optional(),
    responseItems: providerResponseItemsSchema.optional(),
    toolCalls: z.array(z.object({
      id: z.string().min(1).max(240),
      name: z.string().min(1).max(128),
      argumentsJson: z.string().max(1024 * 1024),
    }).strict()).max(128).optional(),
  })
  .strict();
const request = z
  .object({
    model: z.string().min(1).max(240),
    ollamaNumCtx: z.number().int().min(512).max(131_072).optional(),
    wireProtocol: z.literal('responses').optional(),
    ollamaReleaseAfterTurn: z.literal(true).optional(),
    messages: z.array(message).min(1).max(512),
    executionMode: z.literal('background-text').optional(),
    tools: z
      .array(
        z.object({ name: z.string().min(1).max(128), description: z.string().max(2_048), parameters: z.record(z.string(), z.unknown()) }).strict(),
      )
      .max(128)
      .optional(),
    temperature: z.number().min(0).max(2).optional(),
    reasoningEffort: z.literal('none').optional(),
    maxOutputTokens: z.number().int().min(1).max(MAX_OUTPUT_TOKENS).optional(),
    outputTokenParameter: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
    contextBudget: z.object({
      contextWindowTokens: z.number().int().min(512).max(131_072),
      safetyMarginTokens: z.number().int().nonnegative().max(131_072),
      capacitySource: z.enum(['configured', 'provider-reported', 'conservative-fallback', 'application-limit']),
    }).strict().optional(),
    identity: z.object({ requestId: z.string().uuid(), bindingDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict().optional(),
  })
  .strict();

export const providerUtilityCommandSchema = z.discriminatedUnion('kind', [
  z.object({ version: z.literal(1), kind: z.literal('provider:chat'), requestId: z.string().uuid(), credentials, request }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('provider:models'), requestId: z.string().uuid(), credentials }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('provider:inspect-model'), requestId: z.string().uuid(), credentials, model: z.string().min(1).max(240) }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('provider:cancel'), requestId: z.string().uuid() }).strict(),
]);

const usageDetails = {
  cachedInputTokens: z.number().int().nonnegative().nullable().optional(),
  cacheWriteInputTokens: z.number().int().nonnegative().nullable().optional(),
  reasoningOutputTokens: z.number().int().nonnegative().nullable().optional(),
  tokenDetailsInvalid: z.boolean().optional(),
};
const streamEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z.object({ type: z.literal('tool-call'), id: z.string(), name: z.string(), argumentsJson: z.string() }).strict(),
  z.object({ type: z.literal('tool-thought'), thought: toolThought }).strict(),
  z.object({ type: z.literal('response-items'), items: providerResponseItemsSchema }).strict(),
  z.object({ type: z.literal('usage'), inputTokens: z.number().int().nonnegative().nullable(), outputTokens: z.number().int().nonnegative().nullable(),
    ...usageDetails, reportedCostUSD: z.number().finite().nonnegative().max(1e12).nullable().optional() }).strict(),
  z.object({ type: z.literal('done'), finishReason: z.string().nullable() }).strict(),
  z.object({ type: z.literal('request-observation'), observation: z.object({
    requestId: z.string().uuid(), bindingDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    bodySHA256: z.string().regex(/^[a-f0-9]{64}$/u), inputEstimate: z.number().int().nonnegative(),
    phase: z.enum(['fetch-invoked', 'response-received', 'terminal']),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    outcome: z.enum(['completed', 'failed', 'aborted']).nullable(),
    usage: z.object({ inputTokens: z.number().int().nonnegative().nullable(), outputTokens: z.number().int().nonnegative().nullable(),
      ...usageDetails, source: z.enum(['provider-reported', 'unknown']), reportedCostUSD: z.number().finite().nonnegative().max(1e12).nullable().optional() }).strict(),
    finishReason: z.string().nullable(),
  }).strict() }).strict(),
]);

export const providerUtilityResponseSchema = z.discriminatedUnion('kind', [
  z.object({ version: z.literal(1), kind: z.literal('provider:progress'), requestId: z.string().uuid() }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('provider:event'), requestId: z.string().uuid(), event: streamEvent }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('provider:models-result'), requestId: z.string().uuid(), models: z.array(model).max(10_000) }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('provider:inspect-model-result'), requestId: z.string().uuid(), inspection: z.object({
    contextWindowTokens: z.number().int().positive().nullable(),
    executionDestination: z.enum(['local', 'remote', 'unknown']),
    source: z.enum(['ollama-show', 'unknown']), localGguf: z.literal(true).optional(),
  }).strict() }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('provider:complete'), requestId: z.string().uuid() }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('provider:error'), requestId: z.string().uuid(), errorCode: z.string().max(128) }).strict(),
]);

export type ProviderUtilityCommand = z.infer<typeof providerUtilityCommandSchema>;
export type ProviderUtilityResponse = z.infer<typeof providerUtilityResponseSchema>;
