import { expect, it } from 'vitest';
import { authorizeIpcRequest } from '../../src/main/ipc-policy';
import { providerUtilityResponseSchema } from '../../src/utility/provider-protocol';

it('limits ephemeral model discovery to a bounded console payload', () => {
  const input = { kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'synthetic-only' };
  const request = { channel: 'providers:discover-models' as const, envelope: { version: 1, payload: input }, senderUrl: 'deskpet://app/main_window/index.html', senderRole: 'console' as const, allowedRoles: ['console'] as const, development: false };
  expect(authorizeIpcRequest(request)).toEqual(input);
  expect(() => authorizeIpcRequest({ ...request, senderRole: 'overlay' })).toThrow('role');
  expect(() => authorizeIpcRequest({ ...request, senderUrl: 'https://attacker.example/' })).toThrow('origin');
  for (const extra of [{ headers: { authorization: '*' } }, { method: 'POST' }, { model: 'generate' }, { existingProviderId: '../secret' }]) {
    expect(() => authorizeIpcRequest({ ...request, envelope: { version: 1, payload: { ...input, ...extra } } })).toThrow();
  }
  for (const apiKey of ['', 'x'.repeat(16385), 'key\r\nextra-header']) expect(() => authorizeIpcRequest({ ...request, envelope: { version: 1, payload: { ...input, apiKey } } })).toThrow();
});

it('validates catalog price currency, units, provenance and explicit unknowns across the utility boundary', () => {
  const model = { id: 'synthetic/model', displayName: 'Synthetic model', contextWindow: 32768, supportsTools: false,
    availability: 'provider-listed', pricing: { currency: 'USD', inputPerMillion: 0, outputPerMillion: null, source: 'provider-api', sourceUrl: 'https://openrouter.ai/api/v1/models/user', checkedAt: '2026-10-30T00:00:00.000Z' } };
  const response = { version: 1, kind: 'provider:models-result', requestId: '01234567-89ab-4def-8123-456789abcdef', models: [model] };
  expect(providerUtilityResponseSchema.parse(response)).toEqual(response);
  for (const patch of [{ currency: 'JPY' }, { inputPerMillion: -1 }, { outputPerMillion: Number.NaN }, { source: 'bill' }, { checkedAt: 'yesterday' }, { apiKey: 'not-allowed' }]) {
    expect(() => providerUtilityResponseSchema.parse({ ...response, models: [{ ...model, pricing: { ...model.pricing, ...patch } }] })).toThrow();
  }
});
