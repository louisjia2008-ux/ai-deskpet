import { describe, expect, it } from 'vitest';
import { authorizeIpcRequest } from '../../src/main/ipc-policy';

const input = { providerId: '00000000-0000-4000-8000-000000000001', model: 'synthetic-model', currency: 'USD', inputPerMillion: 2, outputPerMillion: 10, cachedInputPerMillion: 0.2, cacheWriteInputPerMillion: null };
const request = { channel: 'usage:rate-upsert' as const, envelope: { version: 1, payload: input }, senderUrl: 'deskpet://app/main_window/index.html', senderRole: 'console' as const, allowedRoles: ['console'] as const, development: false };

describe('usage price edits stay in the bounded host-owned console contract', () => {
  it('accepts explicit prices but refuses caller-controlled provenance, endpoint and unsupported billing controls', () => {
    expect(authorizeIpcRequest(request)).toEqual(input);
    for (const patch of [{ endpoint: 'https://other.example' }, { source: 'reference' }, { sourceUrl: 'https://fake.example/prices' }, { checkedAt: '2026-11-02T00:00:00Z' }, { budget: 0 }, { apiKey: 'SYNTHETIC' }])
      expect(() => authorizeIpcRequest({ ...request, envelope: { version: 1, payload: { ...input, ...patch } } })).toThrow();
    for (const patch of [{ inputPerMillion: -1 }, { outputPerMillion: Number.NaN }, { inputPerMillion: Number.POSITIVE_INFINITY }, { currency: 'EUR' }, { model: '' }, { model: 'x'.repeat(241) }, { providerId: '../other' }])
      expect(() => authorizeIpcRequest({ ...request, envelope: { version: 1, payload: { ...input, ...patch } } })).toThrow();
  });
  it('denies remote origins and overlay edits for both save and remove', () => {
    expect(() => authorizeIpcRequest({ ...request, senderRole: 'overlay' })).toThrow('role');
    expect(() => authorizeIpcRequest({ ...request, senderUrl: 'https://untrusted.example/' })).toThrow('origin');
    const remove = { ...request, channel: 'usage:rate-remove' as const, envelope: { version: 1, payload: { providerId: input.providerId, model: input.model } } };
    expect(authorizeIpcRequest(remove)).toEqual({ providerId: input.providerId, model: input.model });
    expect(() => authorizeIpcRequest({ ...remove, senderRole: 'overlay' })).toThrow('role');
    expect(() => authorizeIpcRequest({ ...remove, envelope: { version: 1, payload: { ...remove.envelope.payload, all: true } } })).toThrow();
  });
});
