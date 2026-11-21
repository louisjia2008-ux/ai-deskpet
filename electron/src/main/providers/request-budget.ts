import { createHash } from 'node:crypto';

import { ollamaChatBody } from './ollama-chat';
import { providerToolNames } from './tool-names';
import { estimateSerializedInputTokens } from './input-token-estimate';
import { providerResponseItemsSchema } from './response-items';

import { DEFAULT_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS } from '../../shared/output-limits';
import type { ProviderConfig } from '../../shared';
import type { ProviderChatRequest, ProviderToolDefinition } from './types';

/** Application resource ceiling, never an assertion of server context allocation. */
export const APPLICATION_CONTEXT_CEILING = 131_072;

export class ProviderRequestBudgetError extends Error {
  readonly code: 'provider.contextBudgetExceeded' | 'provider.invalidRequestBudget';

  constructor(code: 'provider.contextBudgetExceeded' | 'provider.invalidRequestBudget' = 'provider.contextBudgetExceeded') {
    super(code);
    this.name = 'ProviderRequestBudgetError';
    this.code = code;
  }
}

export const normalizedProviderBaseUrl = (config: ProviderConfig): URL => {
  const url = new URL(config.baseUrl);
  const hostname = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  const loopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  if (config.ollamaNumCtx !== undefined && config.kind !== 'ollama') throw new Error('provider.invalidRequestBudget');
  const localKind = config.kind === 'ollama' || config.kind === 'lm-studio';
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') throw new Error('provider.request');
  if (localKind && (!loopback || !['http:', 'https:'].includes(url.protocol))) throw new Error(`${config.kind} must use an HTTP(S) loopback endpoint.`);
  if (!localKind && url.protocol !== 'https:') throw new Error(`${config.kind} requires an HTTPS endpoint.`);
  url.pathname = url.pathname.replace(/\/+$/u, '');
  return url;
};

export const providerEndpoint = (base: URL, path: string): string => {
  const url = new URL(base.toString());
  url.pathname = `${url.pathname}${path}`.replace(/\/{2,}/gu, '/');
  return url.toString();
};

export const providerWireProtocol = (config: ProviderConfig): 'responses' | undefined => {
  const url = normalizedProviderBaseUrl(config);
  return config.kind === 'openai' && url.hostname === 'api.openai.com' && url.port === '' ? 'responses' : undefined;
};
export const providerChatEndpoint = (config: ProviderConfig): string => {
  const base = normalizedProviderBaseUrl(config);
  if (config.kind === 'ollama' && config.ollamaNumCtx !== undefined) {
    base.pathname = base.pathname.replace(/\/v1$/u, '');
    return providerEndpoint(base, '/api/chat');
  }
  return providerEndpoint(base, providerWireProtocol(config) === 'responses' ? '/responses' : '/chat/completions');
};

export function canReleaseOllamaForVaultTools(config: ProviderConfig, tools: ProviderToolDefinition[] | undefined): boolean {
  if (config.kind !== 'ollama' || !tools?.some(tool => tool.name === 'notes.search' || tool.name === 'notes.save')) return false;
  const base = normalizedProviderBaseUrl(config);
  return base.protocol === 'http:' && base.port === '11434' && (base.pathname === '/' || base.pathname === '/v1');
}

/** Binds the provider configuration to an exact model or a persisted follow selection. Wire requests use an exact model. */
export const providerBindingFingerprint = (config: ProviderConfig, model: string | null): string => createHash('sha256').update(JSON.stringify({
  version: 1,
  providerId: config.id,
  kind: config.kind,
  endpoint: providerChatEndpoint(config),
  model,
  enabled: config.enabled,
  supportsTools: config.supportsTools,
  localExecutionConfirmed: config.localExecutionConfirmed === true,
  ...(config.ollamaNumCtx === undefined ? {} : { ollamaNumCtx: config.ollamaNumCtx }),
  contextWindowTokens: config.contextWindowTokens ?? null,
  maxOutputTokens: config.maxOutputTokens ?? null,
  outputTokenParameter: config.outputTokenParameter ?? null,
})).digest('hex');

const wireRequest = (request: ProviderChatRequest) => {
  if (request.executionMode === 'background-text' && ((request.tools?.length ?? 0) > 0
    || request.messages.some((message) => message.role === 'tool' || message.toolCallId !== undefined || message.toolCalls !== undefined
      || message.responseItems?.some((item) => item.type === 'function_call')))) {
    throw new Error('job.toolsForbidden');
  }
  if (request.messages.some(message => message.toolThought &&
    (!message.toolCalls?.length || message.role !== 'assistant' || request.wireProtocol === 'responses' ||
      message.toolThought.protocol !== (request.ollamaNumCtx === undefined ? 'deepseek' : 'ollama')))) throw new Error('provider.bindingMismatch');
  const toolNames = providerToolNames([
    ...(request.tools ?? []).map((tool) => tool.name),
    ...request.messages.flatMap((message) => (message.toolCalls ?? []).map((call) => call.name)),
  ]);
  const wireNames = new Map([...toolNames].map(([wire, internal]) => [internal, wire]));
  if (request.wireProtocol === 'responses') {
    const input: Array<Record<string, unknown>> = [];
    for (const message of request.messages) {
      if (message.role === 'tool') {
        if (!message.toolCallId || message.responseItems !== undefined) throw new Error('provider.request');
        input.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content });
      } else if (message.responseItems !== undefined) {
        if (message.role !== 'assistant') throw new Error('provider.request');
        const items = providerResponseItemsSchema.parse(message.responseItems);
        const calls = items.filter((item) => item.type === 'function_call');
        if (calls.length !== (message.toolCalls?.length ?? 0) || calls.some((item) => !message.toolCalls?.some((call) => call.id === item.call_id && wireNames.get(call.name) === item.name))) throw new Error('provider.request');
        input.push(...items);
      } else {
        if (message.content || !message.toolCalls?.length) input.push({ role: message.role, content: message.content });
        for (const call of message.toolCalls ?? []) input.push({ type: 'function_call', call_id: call.id, name: wireNames.get(call.name), arguments: call.argumentsJson });
      }
    }
    return { body: {
      model: request.model, input, stream: true, store: false, include: ['reasoning.encrypted_content'],
      ...(request.executionMode === 'background-text' ? { tool_choice: 'none' } : {}),
      ...(request.reasoningEffort === undefined ? {} : { reasoning: { effort: request.reasoningEffort } }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.maxOutputTokens === undefined ? {} : { max_output_tokens: request.maxOutputTokens }),
      ...(request.executionMode === 'background-text' || request.tools === undefined ? {} : { tools: request.tools.map((tool) => ({
        type: 'function', name: wireNames.get(tool.name), description: tool.description, parameters: tool.parameters, strict: false,
      })) }),
    }, toolNames };
  }
  if (request.messages.some((message) => message.responseItems !== undefined)) throw new Error('provider.request');
  if (request.ollamaNumCtx !== undefined) return { body: ollamaChatBody(request, wireNames), toolNames };
  const body = {
    model: request.model,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.toolThought === undefined ? {} : { reasoning_content: message.toolThought.content }),
      ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
      ...(message.toolCalls === undefined ? {} : { tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: wireNames.get(call.name), arguments: call.argumentsJson },
      })) }),
    })),
    stream: true,
    stream_options: { include_usage: true },
    ...(request.ollamaReleaseAfterTurn ? { keep_alive: 0 } : {}),
    ...(request.executionMode === 'background-text' ? { tool_choice: 'none' } : {}),
    ...(request.reasoningEffort === undefined ? {} : { reasoning_effort: request.reasoningEffort }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.maxOutputTokens === undefined ? {} : { [request.outputTokenParameter ?? 'max_tokens']: request.maxOutputTokens }),
    ...(request.executionMode === 'background-text' || request.tools === undefined ? {} : { tools: request.tools.map((tool) => ({
      type: 'function',
      function: { name: wireNames.get(tool.name), description: tool.description, parameters: tool.parameters },
    })) }),
  };
  return { body, toolNames };
};

const validateBudget = (request: ProviderChatRequest): number | null => {
  const output = request.maxOutputTokens;
  const budget = request.contextBudget;
  if ((request.ollamaNumCtx !== undefined && (!Number.isSafeInteger(request.ollamaNumCtx) || request.ollamaNumCtx < 512
      || request.ollamaNumCtx > APPLICATION_CONTEXT_CEILING || request.wireProtocol !== undefined))
    || (output !== undefined && (!Number.isSafeInteger(output) || output < 1 || output > MAX_OUTPUT_TOKENS))
    || (request.wireProtocol !== undefined && request.wireProtocol !== 'responses')
    || (request.outputTokenParameter !== undefined && !['max_tokens', 'max_completion_tokens'].includes(request.outputTokenParameter))
    || (request.outputTokenParameter !== undefined && output === undefined)
    || (request.identity !== undefined && budget === undefined)) throw new ProviderRequestBudgetError('provider.invalidRequestBudget');
  if (budget === undefined) return null;
  if (output === undefined
    || (request.ollamaNumCtx !== undefined && budget.contextWindowTokens > request.ollamaNumCtx)
    || !Number.isSafeInteger(budget.contextWindowTokens) || budget.contextWindowTokens < 512 || budget.contextWindowTokens > 131_072
    || !Number.isSafeInteger(budget.safetyMarginTokens) || budget.safetyMarginTokens < 0
    || !['configured', 'provider-reported', 'conservative-fallback', 'application-limit'].includes(budget.capacitySource)) {
    throw new ProviderRequestBudgetError('provider.invalidRequestBudget');
  }
  const maximum = budget.contextWindowTokens - output - budget.safetyMarginTokens;
  if (maximum < 1) throw new ProviderRequestBudgetError('provider.invalidRequestBudget');
  return maximum;
};

/** Recheck host-selected limits against the frozen adapter configuration. */
export const assertProviderRequestBinding = (config: ProviderConfig, request: ProviderChatRequest): void => {
  if (request.ollamaReleaseAfterTurn !== undefined && (request.ollamaReleaseAfterTurn !== true
    || request.executionMode === 'background-text' || !canReleaseOllamaForVaultTools(config, request.tools)))
    throw new Error('provider.bindingMismatch');
  if (request.wireProtocol !== providerWireProtocol(config) || request.ollamaNumCtx !== config.ollamaNumCtx) throw new Error('provider.bindingMismatch');
  for (const message of request.messages) {
    if (message.toolThought && (message.toolThought.protocol !== config.kind ||
      message.toolThought.bindingDigest !== providerBindingFingerprint(config, request.model))) throw new Error('provider.bindingMismatch');
  }
  if (request.identity === undefined) return;
  if (!config.enabled || request.identity.bindingDigest !== providerBindingFingerprint(config, request.model)) throw new Error('provider.bindingMismatch');
  validateBudget(request);
  if (request.contextBudget === undefined || request.maxOutputTokens === undefined
    || request.contextBudget.contextWindowTokens > (config.contextWindowTokens ?? APPLICATION_CONTEXT_CEILING)
    || (request.contextBudget.capacitySource === 'application-limit' && (config.contextWindowTokens !== undefined || config.ollamaNumCtx !== undefined))
    || request.maxOutputTokens > (config.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS)
    || request.contextBudget.safetyMarginTokens < 256) throw new ProviderRequestBudgetError('provider.invalidRequestBudget');
  const selectedParameter = config.outputTokenParameter ?? (config.kind === 'openai' ? 'max_completion_tokens' : 'max_tokens');
  // This is the field wireRequest actually sends; omitted means max_tokens.
  if ((request.outputTokenParameter ?? 'max_tokens') !== selectedParameter) throw new Error('provider.bindingMismatch');
};

// Use token units for token capacity. The complete wire JSON is locally BPE
// counted; it remains an estimate for unknown model tokenizers. Server
// templates keep the separate safety margin and framing.
const estimate = (bodyText: string, request: ProviderChatRequest): number => estimateSerializedInputTokens(bodyText)
  + 64 + request.messages.length * 16 + (request.tools?.length ?? 0) * 32;

export const estimateProviderRequestInputTokens = (request: ProviderChatRequest): number => estimate(JSON.stringify(wireRequest(request).body), request);

export const prepareProviderChatRequest = (request: ProviderChatRequest) => {
  const maxInputTokens = validateBudget(request);
  const { body, toolNames } = wireRequest(request);
  const bodyText = JSON.stringify(body);
  const inputEstimate = estimate(bodyText, request);
  if (maxInputTokens !== null && inputEstimate > maxInputTokens) throw new ProviderRequestBudgetError();
  return { body, bodyText, bodySHA256: createHash('sha256').update(bodyText).digest('hex'), toolNames, inputEstimate, maxInputTokens };
};

export const assertProviderRequestBudget = (request: ProviderChatRequest): { inputEstimate: number; maxInputTokens: number | null } => {
  const { inputEstimate, maxInputTokens } = prepareProviderChatRequest(request);
  return { inputEstimate, maxInputTokens };
};
