import type { ProviderConfig } from '../../shared';
import { providerFailureCode } from '../../shared/provider-errors';
import { defaultModelFallback } from '../../shared/model-routing';
import type { ModelFallback } from '../../shared/model-routing';
import type { ContextDestination } from '../domain/chat-context-policy';
import type { ModelTurnMessage } from '../runtime/agent-runtime';

// Provider/account availability may differ across an explicitly configured
// chain. Host authority, persistence, privacy and budget failures never do.
const FALLBACK_FAILURES = new Set([
  'provider.network', 'provider.timeout', 'provider.unavailable',
  'provider.rateLimit', 'provider.streamInterrupted', 'provider.modelUnavailable',
  'provider.authentication', 'provider.quota',
]);

export const recoverableModelFallbackFailure = (error: unknown): boolean =>
  FALLBACK_FAILURES.has(providerFailureCode(error, ''));

export interface ModelFallbackPlan {
  configuration: ModelFallback;
  candidates: ProviderConfig[];
}

/** A run freezes both order and provider/model identity. Configuration changes
 * do not add recipients or models to an already running request. */
export function modelFallbackPlan(
  configuration: ModelFallback | undefined,
  primary: ProviderConfig,
  providers: readonly ProviderConfig[],
): ModelFallbackPlan {
  const frozen = structuredClone(configuration ?? defaultModelFallback);
  const seen = new Set([primary.id]);
  const candidates: ProviderConfig[] = [];
  for (const id of frozen.enabled ? frozen.providerIds.slice(0, 3) : []) {
    if (seen.has(id)) continue;
    seen.add(id);
    const provider = providers.find(item => item.id === id && item.enabled);
    if (provider) candidates.push(structuredClone(provider));
  }
  return { configuration: frozen, candidates };
}

export const modelFallbackConfigurationCurrent = (
  frozen: ModelFallback,
  current: ModelFallback | undefined,
): boolean => current?.enabled === true && frozen.enabled
  && frozen.providerIds.length === current.providerIds.length
  && frozen.providerIds.every((id, index) => id === current.providerIds[index]);

/** No retry of an agent run, no cross-model tool protocol or opaque reasoning.
 * A later failed model round keeps the existing same-provider retry policy. */
export const modelFallbackBeforeOutput = (
  firstModelTurn: boolean,
  hadOutput: boolean,
  messages: readonly ModelTurnMessage[],
): boolean => firstModelTurn && !hadOutput && messages.every(message =>
  (message.role === 'user' || message.role === 'system')
  && message.toolCallId === undefined && message.toolCalls === undefined
  && message.toolThought === undefined && message.responseItems === undefined
  && message.hostToolResult === undefined);

/** Remote to local is permitted. Once a local recipient or private lineage is
 * involved, this run can never return to a remote recipient automatically. */
export const modelFallbackDestinationAllowed = (
  current: ContextDestination,
  candidate: ContextDestination,
  privateContext: boolean,
): boolean => current !== 'unknown' && candidate !== 'unknown'
  && (candidate === 'local' || (current === 'remote' && !privateContext));
