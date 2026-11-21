import type { CapturedProviderBinding } from './provider-service';
import type { ProviderChatRequest } from './types';
import { APPLICATION_CONTEXT_CEILING, ProviderRequestBudgetError, providerWireProtocol } from './request-budget';
import { DEFAULT_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS } from '../../shared/output-limits';
import type { ContextTrace, ProviderConfig } from '../../shared';
import { earliestWeChatDigestExpiry } from '../domain/context-provenance';

export interface ChatRequestLimits {
  ollamaNumCtx?: number;
  wireProtocol?: 'responses';
  reasoningEffort?: 'none';
  maxOutputTokens: number;
  outputTokenParameter: 'max_tokens' | 'max_completion_tokens';
  contextBudget: NonNullable<ProviderChatRequest['contextBudget']>;
}

// An unset limit must not crowd the input out of a small confirmed window.
const defaultOutputTokens = (contextWindowTokens: number): number =>
  Math.min(DEFAULT_OUTPUT_TOKENS, Math.max(512, Math.floor(contextWindowTokens / 4)));

export const chatRequestLimits = (binding: CapturedProviderBinding, smallerOutputLimit?: number): ChatRequestLimits => {
  const configured = binding.provider.contextWindowTokens;
  const allocation = binding.provider.kind === 'ollama' ? binding.provider.ollamaNumCtx : undefined;
  let contextWindowTokens = Math.min(configured ?? APPLICATION_CONTEXT_CEILING, allocation ?? APPLICATION_CONTEXT_CEILING);
  const metadataCeiling = binding.inspection.contextWindowTokens;
  // Metadata can lower a confirmed limit or the application resource ceiling.
  // An absent setting is unknown capacity, not a confirmed 4096-token server.
  // Leave actual allocation enforcement to the provider instead of inventing it.
  if (metadataCeiling !== null) contextWindowTokens = Math.min(contextWindowTokens, metadataCeiling);
  const maxOutputTokens = Math.min(binding.provider.maxOutputTokens ?? defaultOutputTokens(contextWindowTokens), smallerOutputLimit ?? MAX_OUTPUT_TOKENS);
  if (contextWindowTokens - maxOutputTokens - 256 < 1) throw new ProviderRequestBudgetError('provider.invalidRequestBudget');
  return {
    ...(allocation === undefined ? {} : { ollamaNumCtx: allocation }),
    ...(providerWireProtocol(binding.provider) === 'responses' ? { wireProtocol: 'responses' as const } : {}),
    ...(providerWireProtocol(binding.provider) === 'responses' && /^gpt-6\.1-terra(?:-|$)/u.test(binding.model) ? { reasoningEffort: 'none' as const } : {}),
    maxOutputTokens,
    outputTokenParameter: binding.provider.outputTokenParameter ?? (binding.provider.kind === 'openai' ? 'max_completion_tokens' : 'max_tokens'),
    contextBudget: { contextWindowTokens, safetyMarginTokens: 256, capacitySource: configured === undefined && allocation === undefined ? 'application-limit' : 'configured' },
  };
};

/** Deterministic settings for background JSON reads. OpenAI's Responses API
 * rejects both on reasoning models (HTTP 400), so there the binding's own
 * defaults from `chatRequestLimits` apply instead. */
export const backgroundTextSampling = (provider: ProviderConfig): Pick<ProviderChatRequest, 'temperature' | 'reasoningEffort'> =>
  providerWireProtocol(provider) === 'responses' ? {} : { temperature: 0, reasoningEffort: 'none' };

/** A later tool round still depends on the context that produced its arguments. */
export const mergeTurnContextTrace = (previous: ContextTrace | null, current: ContextTrace): ContextTrace => {
  if (previous === null) return structuredClone(current);
  if (previous.lineage !== 'complete' || current.lineage !== 'complete') throw new Error('chat.contextStale');
  if (previous.scope.kind === 'session' && current.scope.kind === 'session' && previous.scope.sessionId !== current.scope.sessionId) throw new Error('chat.contextStale');
  const references = new Map(previous.memoryReferences.map((reference) => [reference.id, { ...reference }]));
  for (const reference of current.memoryReferences) {
    const prior = references.get(reference.id);
    if (prior !== undefined && prior.revision !== reference.revision) throw new Error('chat.contextStale');
    references.set(reference.id, { ...reference });
  }
  const lookups = new Map((previous.historyLookupReferences ?? []).map((reference) => [reference.messageId, { ...reference }]));
  for (const reference of current.historyLookupReferences ?? []) {
    const prior = lookups.get(reference.messageId);
    if (prior && (prior.sessionId !== reference.sessionId || prior.contentSHA256 !== reference.contentSHA256)) throw new Error('chat.contextStale');
    lookups.set(reference.messageId, { ...reference });
  }
  const summaries = new Map((previous.summaryReferences ?? []).map(reference => [reference.messageId,reference]));
  for (const reference of current.summaryReferences ?? []) {
    const prior = summaries.get(reference.messageId);
    if (prior && prior.contentSHA256 !== reference.contentSHA256) throw new Error('chat.contextStale');
    summaries.set(reference.messageId,reference);
  }
  if (lookups.size > 256) throw new Error('chat.contextStale');
  const diaries = new Map((previous.diaryReferences ?? []).map(reference => [reference.date, reference]));
  for (const reference of current.diaryReferences ?? []) {
    const prior = diaries.get(reference.date);
    if (prior && (prior.revision !== reference.revision || prior.summarySHA256 !== reference.summarySHA256)) throw new Error('chat.contextStale');
    diaries.set(reference.date, reference);
  }
  const wechatDigestUntil = earliestWeChatDigestExpiry(previous.wechatDigestUntil, current.wechatDigestUntil);
  const recentRevision = previous.recentRevision ?? current.recentRevision;
  if (current.recentRevision !== undefined && current.recentRevision !== recentRevision) throw new Error('chat.contextStale');
  const knowledgePolicyToken = previous.knowledgePolicyToken ?? current.knowledgePolicyToken;
  if (current.knowledgePolicyToken !== undefined && current.knowledgePolicyToken !== knowledgePolicyToken) throw new Error('chat.contextStale');
  return {
    ...(recentRevision === undefined ? {} : { recentRevision }),
    ...(wechatDigestUntil === undefined ? {} : { wechatDigestUntil }),
    ...(knowledgePolicyToken === undefined ? {} : { knowledgePolicyToken }),
    ...(diaries.size ? { diaryReferences: [...diaries.values()] } : {}),
    ...(summaries.size ? { summaryReferences:[...summaries.values()] } : {}),
    ...(lookups.size > 0 ? { historyLookupReferences: [...lookups.values()] } : {}),
    ...((previous.representationReferences || current.representationReferences) ? {
      representationReferences: [...new Map([...(previous.representationReferences ?? []), ...(current.representationReferences ?? [])].map((item) => [item.batchId, item])).values()],
      representationDecisions: [...(previous.representationDecisions ?? []), ...(current.representationDecisions ?? [])].slice(-300),
    } : {}),
    version: 1, memoryReferences: [...references.values()],
    historyMessageIds: [...new Set([...previous.historyMessageIds, ...current.historyMessageIds])],
    privacy: previous.privacy === 'local-only' || current.privacy === 'local-only' ? 'local-only' : 'cloud-allowed',
    scope: structuredClone(previous.scope.kind === 'session' ? previous.scope : current.scope), lineage: 'complete',
  };
};
