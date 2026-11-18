import { z } from 'zod';

import { assertProviderRequestBinding, normalizedProviderBaseUrl, prepareProviderChatRequest, providerBindingFingerprint, providerChatEndpoint, providerEndpoint, providerWireProtocol } from './request-budget';
import { parseProviderModels, providerModelListPath } from './model-catalog';
import { readOllamaChat } from './ollama-chat';
import { readResponsesStream } from './responses-stream';
import { providerSilenceLimitMs } from './silence-limits';
import { safeProviderHttpErrorCode } from './http-errors';
import { inputTokenDetailsSchema, mergeProviderUsageTokenDetails, outputTokenDetailsSchema, providerReportedCostUSD, providerUsageTokenDetails } from './usage-accounting';

import type { ProviderModel, ProviderRequestObservation } from '../../shared';
import type {
  ProviderAdapter,
  ProviderChatRequest,
  ProviderCredentials,
  ProviderModelInspection,
  ProviderStreamEvent,
} from './types';

const streamUsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative().nullish(), completion_tokens: z.number().int().nonnegative().nullish(),
  prompt_tokens_details: inputTokenDetailsSchema, completion_tokens_details: outputTokenDetailsSchema,
  cost: z.unknown().optional(), cost_currency: z.unknown().optional(),
});

const streamChunkSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            delta: z
              .object({
                content: z.string().max(256_000).nullish(),
                tool_calls: z
                  .array(
                    z
                      .object({
                        index: z.number().int().nonnegative(),
                        id: z.string().max(240).optional(),
                        function: z
                          .object({ name: z.string().max(128).optional(), arguments: z.string().max(256_000).optional() })
                          .optional(),
                      })
                      .passthrough(),
                  )
                  .max(128)
                  .optional(),
              })
              .passthrough(),
            finish_reason: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .max(16),
    usage: streamUsageSchema.nullish(),
  })
  .passthrough();

/** Inspect the untrusted envelope before schema projection can discard legacy or
 * alternate response forms. No function/tool structure is meaningful to a text job. */
const containsExecutionRequest = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.tool_calls != null || record.function_call != null) return true;
  if (record.finish_reason === 'tool_calls' || record.finish_reason === 'function_call') return true;
  if (containsExecutionRequest(record.delta) || containsExecutionRequest(record.message)) return true;
  return Array.isArray(record.choices) && record.choices.some(containsExecutionRequest);
};

export class ProviderHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`Provider request failed with HTTP ${status} (${code}).`);
    this.name = 'ProviderHttpError';
    this.status = status;
    this.code = code;
  }
}

const errorCodeForStatus = (status: number): string => {
  if (status === 401 || status === 403) return 'provider.authentication';
  if (status === 402) return 'provider.quota';
  if (status === 408 || status === 504) return 'provider.timeout';
  if (status === 429) return 'provider.rateLimit';
  if (status >= 500) return 'provider.unavailable';
  return 'provider.request';
};

const combineSignals = (caller: AbortSignal | undefined, timeoutMs: number, idleMs = timeoutMs): { signal: AbortSignal; activity: () => void; dispose: () => void } => {
  const controller = new AbortController();
  let timeout = setTimeout(() => controller.abort(new DOMException('Provider request timed out.', 'TimeoutError')), timeoutMs);
  const abort = () => controller.abort(caller?.reason);
  if (caller?.aborted) abort();
  caller?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    activity: () => { clearTimeout(timeout); timeout = setTimeout(() => controller.abort(new DOMException('Provider request timed out.', 'TimeoutError')), idleMs); },
    dispose: () => {
      clearTimeout(timeout);
      caller?.removeEventListener('abort', abort);
      controller.abort();
    },
  };
};

const headers = (credentials: ProviderCredentials): Record<string, string> => {
  const result: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (credentials.apiKey !== null && credentials.apiKey.length > 0) {
    result.authorization = `Bearer ${credentials.apiKey}`;
  }
  return result;
};

const assertOk = async (response: Response): Promise<void> => {
  if (!response.ok) {
    let detail: unknown;
    try { detail = JSON.parse(await readBoundedText(response, 8192)); }
    catch { /* A malformed/large body does not expose text or replace the HTTP status. */ }
    throw new ProviderHttpError(response.status, safeProviderHttpErrorCode(response.status, detail));
  }
};

interface ToolAccumulator {
  id: string;
  name: string;
  argumentsJson: string;
}

const MAX_SSE_LINE_BYTES = 1024 * 1024;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_MODEL_LIST_BYTES = 4 * 1024 * 1024;

const readBoundedText = async (response: Response, maximum: number): Promise<string> => {
  if (response.body === null) throw new Error('Provider returned an empty response body.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      throw new Error('Provider response exceeded its size limit.');
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(result);
};

/** Catalog diagnostics expose only a status category. A bounded billing code
 * can refine 429, while arbitrary server messages never leave this process. */
const assertCatalogOk = async (response: Response): Promise<void> => {
  if (response.ok) return;
  let code = response.status === 403 ? 'provider.permissionDenied' : errorCodeForStatus(response.status);
  if (response.status === 429) {
    code = 'provider.limitUnknown';
    try {
      const value: unknown = JSON.parse(await readBoundedText(response, 8_192));
      const detail = value !== null && typeof value === 'object' && 'error' in value ? value.error : null;
      if (detail !== null && typeof detail === 'object') {
        const reason = 'code' in detail ? detail.code : undefined;
        const type = 'type' in detail ? detail.type : undefined;
        if (typeof reason === 'string' && ['insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded',
          'project_spend_limit_exceeded', 'organization_usage_limit_exceeded'].includes(reason)) code = 'provider.quota';
        else if (reason === 'rate_limit_exceeded' || reason === 'slow_down') code = 'provider.rateLimit';
        else if (type === 'insufficient_quota') code = 'provider.quota';
      }
    } catch { /* Keep an unclassified 429; do not reflect body or parse details. */ }
  } else await response.body?.cancel();
  throw new ProviderHttpError(response.status, code);
};

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly #credentials: ProviderCredentials;
  readonly #baseUrl: URL;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #firstResponseMs: number;
  readonly #onActivity: () => void;

  constructor(credentials: ProviderCredentials, fetchImplementation: typeof fetch = fetch, timeoutMs?: number, onActivity: () => void = () => undefined) {
    this.#credentials = { config: { ...credentials.config }, apiKey: credentials.apiKey };
    this.#baseUrl = normalizedProviderBaseUrl(this.#credentials.config);
    this.#fetch = fetchImplementation;
    this.#timeoutMs = timeoutMs ?? providerSilenceLimitMs(credentials.config.kind);
    this.#firstResponseMs = this.#timeoutMs;
    this.#onActivity = onActivity;
  }

  async *streamChat(request: ProviderChatRequest, callerSignal?: AbortSignal): AsyncGenerator<ProviderStreamEvent> {
    if (callerSignal?.aborted) throw new DOMException('Provider request cancelled.', 'AbortError');
    // Unbound diagnostic callers have no frozen wire receipt. Bound host requests
    // must already select their exact protocol before budgeting and journaling.
    if (request.identity === undefined && request.wireProtocol === undefined && providerWireProtocol(this.#credentials.config) === 'responses') request = { ...request, wireProtocol: 'responses' };
    if (!request.identity && request.ollamaNumCtx === undefined && this.#credentials.config.ollamaNumCtx !== undefined) {
      request = { ...request, ollamaNumCtx: this.#credentials.config.ollamaNumCtx };
    }
    assertProviderRequestBinding(this.#credentials.config, request);
    const prepared = prepareProviderChatRequest(request);
    const { toolNames } = prepared;
    const identity = request.identity === undefined ? undefined : { ...request.identity };
    const { signal, activity, dispose } = combineSignals(callerSignal, this.#firstResponseMs, this.#timeoutMs);
    let reader: globalThis.ReadableStreamDefaultReader<Uint8Array> | undefined;
    let invoked = false;
    let httpStatus: number | null = null;
    let finishReason: string | null = null;
    let usage: ProviderRequestObservation['usage'] = { inputTokens: null, outputTokens: null, source: 'unknown' };
    const implicitCostUSD = this.#credentials.config.kind === 'openrouter' && normalizedProviderBaseUrl(this.#credentials.config).toString() === 'https://openrouter.ai/api/v1';
    const observe = (phase: ProviderRequestObservation['phase'], outcome: ProviderRequestObservation['outcome'] = null): ProviderStreamEvent => ({
      type: 'request-observation',
      observation: {
        requestId: identity!.requestId, bindingDigest: identity!.bindingDigest,
        bodySHA256: prepared.bodySHA256, inputEstimate: prepared.inputEstimate,
        phase, httpStatus, outcome, usage: { ...usage }, finishReason,
      },
    });
    try {
      // Attach both promise handlers before yielding, so an immediate network
      // rejection cannot become unhandled while the consumer journals the event.
      const responsePending = this.#fetch(providerChatEndpoint(this.#credentials.config), {
        method: 'POST',
        headers: headers(this.#credentials),
        signal,
        redirect: 'error',
        body: prepared.bodyText,
      }).then((response) => ({ ok: true as const, response }), (error: unknown) => ({ ok: false as const, error }));
      invoked = true;
      if (identity !== undefined) yield observe('fetch-invoked');
      const settled = await responsePending;
      if (!settled.ok) throw settled.error;
      const response = settled.response;
      httpStatus = response.status;
      if (identity !== undefined) yield observe('response-received');
      await assertOk(response);
      if (response.body === null) {
        throw new Error('Provider returned an empty streaming body.');
      }

      if (request.ollamaNumCtx !== undefined) {
        const digest = providerBindingFingerprint(this.#credentials.config, request.model);
        for await (const event of readOllamaChat(response.body, toolNames, digest, signal, () => { activity(); this.#onActivity(); }, request.executionMode === 'background-text')) {
          if (event.type === 'done') finishReason = event.finishReason;
          else {
            if (event.type === 'usage') usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens, source: 'provider-reported' };
            yield event;
          }
        }
        if (identity !== undefined) yield observe('terminal', 'completed');
        yield { type: 'done', finishReason }; return;
      }
      if (request.wireProtocol === 'responses') {
        for await (const event of readResponsesStream(response.body, toolNames, { signal, backgroundText: request.executionMode === 'background-text',
          activity: () => { activity(); this.#onActivity(); }, finishReason: (reason) => { finishReason = reason; }, implicitCostUSD })) {
          if (event.type === 'usage') usage = { ...usage,
            ...mergeProviderUsageTokenDetails(usage, event),
            inputTokens: event.inputTokens ?? usage.inputTokens, outputTokens: event.outputTokens ?? usage.outputTokens,
            source: event.inputTokens !== null || event.outputTokens !== null ? 'provider-reported' : usage.source,
            ...(event.reportedCostUSD === undefined ? {} : { reportedCostUSD: event.reportedCostUSD ?? usage.reportedCostUSD ?? null }),
          };
          if (event.type !== 'done') yield event;
        }
        if (identity !== undefined) yield observe('terminal', 'completed');
        yield { type: 'done', finishReason }; return;
      }

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      const tools = new Map<number, ToolAccumulator>();
      let buffer = '';
      let receivedBytes = 0;
      let receivedDone = false;
      let thinking: string | undefined;
      while (true) {
        const { done, value } = await reader.read().catch(() => {
          if (signal.aborted) throw signal.reason;
          throw new Error('provider.streamInterrupted');
        });
        if (value !== undefined && value.byteLength > 0) { activity(); this.#onActivity(); }
        receivedBytes += value?.byteLength ?? 0;
        if (receivedBytes > MAX_STREAM_BYTES) {
          await reader.cancel();
          throw new Error('Provider stream exceeded its size limit.');
        }
        buffer += decoder.decode(value, { stream: !done });
        if (Buffer.byteLength(buffer, 'utf8') > MAX_SSE_LINE_BYTES) {
          await reader.cancel();
          throw new Error('Provider stream line exceeded its size limit.');
        }
        const lines = buffer.split(/\r?\n/);
        buffer = done ? '' : (lines.pop() ?? '');
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { receivedDone = true; break; }
          if (data.length === 0) continue;
          const envelope: unknown = JSON.parse(data);
          if (request.executionMode === 'background-text' && containsExecutionRequest(envelope)) {
            const completion = z.object({ choices: z.array(z.object({ finish_reason: z.string().max(128).nullable().optional() }).passthrough()).max(256).optional() }).passthrough().safeParse(envelope);
            if (completion.success) finishReason = completion.data.choices?.find((choice) => choice.finish_reason != null)?.finish_reason ?? finishReason;
            // A protocol violation does not turn an already reported usage into
            // zero. Preserve only schema-validated counters, never tool payloads.
            const reported = z.object({ usage: streamUsageSchema }).passthrough().safeParse(envelope);
            if (reported.success) {
              const details = providerUsageTokenDetails(reported.data.usage.prompt_tokens_details, reported.data.usage.completion_tokens_details);
              usage = {
                ...mergeProviderUsageTokenDetails(usage, details),
                reportedCostUSD: providerReportedCostUSD(reported.data.usage, implicitCostUSD) ?? usage.reportedCostUSD ?? null,
                inputTokens: reported.data.usage.prompt_tokens ?? usage.inputTokens,
                outputTokens: reported.data.usage.completion_tokens ?? usage.outputTokens,
                source: reported.data.usage.prompt_tokens != null || reported.data.usage.completion_tokens != null ? 'provider-reported' : usage.source,
              };
              yield { type: 'usage', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, ...details,
                ...(usage.reportedCostUSD == null ? {} : { reportedCostUSD: usage.reportedCostUSD }),
              };
            }
            throw new Error('job.toolsForbidden');
          }
          const chunk = streamChunkSchema.parse(envelope);
          if (chunk.usage !== undefined && chunk.usage !== null) {
            const details = providerUsageTokenDetails(chunk.usage.prompt_tokens_details, chunk.usage.completion_tokens_details);
            const reportedCostUSD = providerReportedCostUSD(chunk.usage, implicitCostUSD);
            usage = {
              ...mergeProviderUsageTokenDetails(usage, details),
              reportedCostUSD: reportedCostUSD ?? usage.reportedCostUSD ?? null,
              inputTokens: chunk.usage.prompt_tokens ?? usage.inputTokens,
              outputTokens: chunk.usage.completion_tokens ?? usage.outputTokens,
              source: chunk.usage.prompt_tokens != null || chunk.usage.completion_tokens != null ? 'provider-reported' : usage.source,
            };
            yield {
              type: 'usage',
              inputTokens: chunk.usage.prompt_tokens ?? null,
              outputTokens: chunk.usage.completion_tokens ?? null,
              ...details,
              ...(reportedCostUSD === null ? {} : { reportedCostUSD }),
            };
          }
          const choice = chunk.choices[0];
          if (choice === undefined) continue;
          if (this.#credentials.config.kind === 'deepseek' && request.executionMode !== 'background-text' && choice.delta.reasoning_content != null) {
            if (typeof choice.delta.reasoning_content !== 'string') throw new Error('provider.streamInterrupted');
            thinking = (thinking ?? '') + choice.delta.reasoning_content;
            if (thinking.length > 256_000) throw new Error('provider.contextBudgetExceeded');
          }
          if (choice.delta.content !== undefined && choice.delta.content !== null && choice.delta.content.length > 0) {
            yield { type: 'text', text: choice.delta.content };
          }
          for (const delta of choice.delta.tool_calls ?? []) {
            const accumulator = tools.get(delta.index) ?? { id: '', name: '', argumentsJson: '' };
            accumulator.id += delta.id ?? '';
            accumulator.name += delta.function?.name ?? '';
            accumulator.argumentsJson += delta.function?.arguments ?? '';
            if (accumulator.argumentsJson.length > MAX_SSE_LINE_BYTES || accumulator.name.length > 128 || accumulator.id.length > 240) {
              throw new Error('Provider tool call exceeded its size limit.');
            }
            tools.set(delta.index, accumulator);
          }
          finishReason = choice.finish_reason ?? finishReason;
        }
        if (done || receivedDone) break;
      }
      // EOF is a transport event, not proof that the model finished. In
      // particular, never execute a partially streamed side-effect tool call.
      if (finishReason === 'length' || finishReason === 'content_filter') throw new Error('provider.truncated');
      if (!receivedDone && finishReason !== 'stop' && finishReason !== 'tool_calls' && finishReason !== 'function_call') {
        throw new Error('provider.streamInterrupted');
      }
      if (tools.size && thinking !== undefined) yield { type: 'tool-thought', thought: {
        protocol: 'deepseek', content: thinking, bindingDigest: providerBindingFingerprint(this.#credentials.config, request.model),
      } };
      for (const tool of [...tools.entries()].sort(([left], [right]) => left - right).map(([, value]) => value)) {
        yield { type: 'tool-call', ...tool, name: toolNames.get(tool.name) ?? tool.name };
      }
      if (identity !== undefined) yield observe('terminal', 'completed');
      yield { type: 'done', finishReason };
    } catch (error) {
      if (identity !== undefined && invoked) yield observe('terminal', callerSignal?.aborted ? 'aborted' : 'failed');
      throw error;
    } finally {
      dispose();
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
    }
  }

  async listModels(callerSignal?: AbortSignal): Promise<ProviderModel[]> {
    const { signal, dispose } = combineSignals(callerSignal, Math.min(this.#timeoutMs, 20_000));
    try {
      const response = await this.#fetch(providerEndpoint(this.#baseUrl, providerModelListPath(this.#credentials.config)), {
        method: 'GET',
        headers: headers(this.#credentials),
        signal,
        redirect: 'error',
      }).catch(() => {
        if (signal.aborted) throw signal.reason;
        // No Response exists. Do not guess authentication, policy or quota.
        throw new Error('provider.network');
      });
      await assertCatalogOk(response);
      const body = await readBoundedText(response, MAX_MODEL_LIST_BYTES);
      try { return parseProviderModels(JSON.parse(body), this.#credentials.config); }
      catch { throw new Error('provider.catalogInvalid'); }
    } finally {
      dispose();
    }
  }

  async inspectModel(model: string, callerSignal?: AbortSignal): Promise<ProviderModelInspection> {
    const unknown: ProviderModelInspection = { contextWindowTokens: null, executionDestination: 'unknown', source: 'unknown' };
    if (callerSignal?.aborted) throw new DOMException('Provider request cancelled.', 'AbortError');
    if (this.#credentials.config.kind !== 'ollama') return unknown;
    if (model.length < 1 || model.length > 240) throw new Error('provider.request');
    const { signal, dispose } = combineSignals(callerSignal, Math.min(this.#timeoutMs, 20_000));
    try {
      const base = new URL(this.#baseUrl);
      base.pathname = base.pathname.replace(/\/v1$/u, '');
      const response = await this.#fetch(providerEndpoint(base, '/api/show'), {
        method: 'POST', headers: headers(this.#credentials), signal, redirect: 'error',
        body: JSON.stringify({ model, verbose: false }),
      });
      await assertOk(response);
      const parsed = z.record(z.string(), z.unknown()).parse(JSON.parse(await readBoundedText(response, MAX_MODEL_LIST_BYTES)));
      // Read each remote indicator independently. A malformed sibling field or
      // model_info must never erase a recognized remote execution declaration.
      const isRemoteIndicator = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0;
      const remote = isRemoteIndicator(parsed.remote_host) || isRemoteIndicator(parsed.remote_model);
      const metadata = z.record(z.string(), z.unknown()).safeParse(parsed.model_info);
      const info = metadata.success ? metadata.data : {};
      const architecture = info['general.architecture'];
      const candidate = typeof architecture === 'string' ? info[`${architecture}.context_length`] : undefined;
      const contextWindowTokens = typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0 ? candidate : null;
      // Absence of remote metadata is not an attestation that inference stays
      // local; the caller also requires the user's explicit local declaration.
      const details = z.object({ format: z.literal('gguf') }).safeParse(parsed.details);
      const localGguf = !remote && (parsed.remote_host == null || parsed.remote_host === '') &&
        (parsed.remote_model == null || parsed.remote_model === '') && details.success && typeof architecture === 'string' && !!architecture.trim();
      return { contextWindowTokens, executionDestination: remote ? 'remote' : 'unknown', source: 'ollama-show', ...(localGguf ? {localGguf: true as const} : {}) };
    } finally {
      dispose();
    }
  }
}
