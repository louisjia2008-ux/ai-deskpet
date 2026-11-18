// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '../../shared';
import {
  modelFallbackBeforeOutput, modelFallbackConfigurationCurrent,
  modelFallbackDestinationAllowed, modelFallbackPlan, recoverableModelFallbackFailure,
} from './model-fallback';

const provider = (patch: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: randomUUID(), name: 'Synthetic fallback', kind: 'ollama', model: 'fixture',
  baseUrl: 'http://127.0.0.1:11434/v1', enabled: true, supportsTools: true,
  secretState: 'missing', localExecutionConfirmed: true, ...patch,
});

describe('host model fallback policy', () => {
  it('freezes an enabled, bounded order without the primary or duplicate providers', () => {
    const primary = provider(), first = provider(), second = provider(), disabled = provider({ enabled: false });
    expect(modelFallbackPlan(undefined, primary, [primary, first]).candidates).toEqual([]);
    expect(modelFallbackPlan({ enabled: false, providerIds: [first.id] }, primary, [first]).candidates).toEqual([]);
    const ids = [primary.id, first.id, second.id];
    const plan = modelFallbackPlan({ enabled: true, providerIds: ids }, primary, [primary, first, second]);
    ids.reverse(); first.model = 'changed-after-start';
    expect(plan.configuration.providerIds).toEqual([primary.id, first.id, second.id]);
    expect(plan.candidates.map(item => [item.id, item.model])).toEqual([[first.id, 'fixture'], [second.id, 'fixture']]);
    expect(modelFallbackPlan({ enabled: true, providerIds: [first.id, first.id, disabled.id] }, primary, [first, disabled]).candidates).toHaveLength(1);
  });

  it('treats disabling, removal and reordering as loss of the frozen fallback authority', () => {
    const configuration = { enabled: true, providerIds: [randomUUID(), randomUUID()] };
    expect(modelFallbackConfigurationCurrent(configuration, structuredClone(configuration))).toBe(true);
    expect(modelFallbackConfigurationCurrent(configuration, undefined)).toBe(false);
    expect(modelFallbackConfigurationCurrent(configuration, { ...configuration, enabled: false })).toBe(false);
    expect(modelFallbackConfigurationCurrent(configuration, { ...configuration, providerIds: configuration.providerIds.slice().reverse() })).toBe(false);
    expect(modelFallbackConfigurationCurrent(configuration, { ...configuration, providerIds: configuration.providerIds.slice(0, 1) })).toBe(false);
  });

  it.each(['provider.network', 'provider.timeout', 'provider.unavailable', 'provider.rateLimit', 'provider.streamInterrupted', 'provider.modelUnavailable', 'provider.authentication', 'provider.quota'])('allows the known availability failure %s only for host eligibility checks', code => {
    expect(recoverableModelFallbackFailure(new Error(code))).toBe(true);
    expect(recoverableModelFallbackFailure({ code, message: 'PRIVATE_UPSTREAM_BODY' })).toBe(true);
  });

  it.each(['provider.cancelled', 'provider.contextPrivacyBlocked', 'provider.bindingMismatch', 'provider.budgetExceeded', 'provider.requestRecordFailed', 'provider.contextBudgetExceeded', 'provider.invalidRequestBudget', 'provider.permissionDenied', 'provider.request', 'chat.contextStale', 'repository.commitUncertain', 'tool.permission', 'PRIVATE_UNKNOWN_FAILURE'])('does not turn %s into permission to use another provider', code => {
    expect(recoverableModelFallbackFailure(new Error(code))).toBe(false);
  });

  it('requires the first model turn with no output, prior tools or opaque continuation', () => {
    const input = [{ role: 'user' as const, content: 'Synthetic request' }];
    expect(modelFallbackBeforeOutput(true, false, input)).toBe(true);
    expect(modelFallbackBeforeOutput(false, false, input)).toBe(false);
    expect(modelFallbackBeforeOutput(true, true, input)).toBe(false);
    expect(modelFallbackBeforeOutput(true, false, [...input, { role: 'assistant', content: 'Already visible' }])).toBe(false);
    expect(modelFallbackBeforeOutput(true, false, [...input, { role: 'tool', content: '{"written":true}', toolCallId: 'executed' }])).toBe(false);
    expect(modelFallbackBeforeOutput(true, false, [{ ...input[0]!, responseItems: [] }])).toBe(false);
    expect(modelFallbackBeforeOutput(true, false, [{ ...input[0]!, hostToolResult: 'safe-error' }])).toBe(false);
  });

  it('allows remote to local, never local or private to remote, and never unknown execution', () => {
    expect(modelFallbackDestinationAllowed('remote', 'remote', false)).toBe(true);
    expect(modelFallbackDestinationAllowed('remote', 'local', false)).toBe(true);
    expect(modelFallbackDestinationAllowed('remote', 'local', true)).toBe(true);
    expect(modelFallbackDestinationAllowed('local', 'local', true)).toBe(true);
    expect(modelFallbackDestinationAllowed('local', 'remote', false)).toBe(false);
    expect(modelFallbackDestinationAllowed('remote', 'remote', true)).toBe(false);
    for (const destination of ['local', 'remote', 'unknown'] as const) {
      expect(modelFallbackDestinationAllowed('unknown', destination, false)).toBe(false);
      expect(modelFallbackDestinationAllowed(destination, 'unknown', false)).toBe(false);
    }
  });
});
