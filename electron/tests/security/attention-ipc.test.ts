import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { authorizeIpcRequest } from '../../src/main/ipc-policy';

describe('attention reads and acknowledgement authority', () => {
  const base = { senderUrl: 'deskpet://app/main_window/index.html', senderRole: 'console' as const, allowedRoles: ['console'] as const, development: false };
  it('accepts one exact source revision and rejects forged state or foreign callers', () => {
    const payload = { id: `background-job:${randomUUID()}`, fingerprint: 'a'.repeat(64) };
    const request = { ...base, channel: 'attention:acknowledge' as const, envelope: { version: 1, payload } };
    expect(authorizeIpcRequest(request)).toEqual(payload);
    for (const extra of [{ profileId: randomUUID() }, { acknowledgedAt: new Date().toISOString() }, { result: 'forged' }, { retry: true }]) {
      expect(() => authorizeIpcRequest({ ...request, envelope: { version: 1, payload: { ...payload, ...extra } } })).toThrow();
    }
    expect(() => authorizeIpcRequest({ ...request, senderRole: 'overlay' })).toThrow('role');
    expect(() => authorizeIpcRequest({ ...request, senderUrl: 'https://untrusted.example' })).toThrow('origin');
    expect(() => authorizeIpcRequest({ ...request, envelope: { version: 2, payload } })).toThrow();
    expect(() => authorizeIpcRequest({ ...request, envelope: { version: 1, payload: { ...payload, id: '../../profile.enc.json' } } })).toThrow();
  });
  it('requires a clean read payload and keeps observation records host-owned', () => {
    const request = { ...base, channel: 'attention:snapshot' as const, envelope: { version: 1, payload: {} } };
    expect(authorizeIpcRequest(request)).toEqual({});
    expect(() => authorizeIpcRequest({ ...request, envelope: { version: 1, payload: { allProfiles: true } } })).toThrow();
    expect(() => authorizeIpcRequest({ ...request, senderRole: 'overlay' })).toThrow('role');
  });
  it('accepts her sheet only from the console and only in its exact shape', () => {
    const profile = { bible: 'x', likes: ['a'], dislikes: [], pet: '', age: 16, ageSince: '2026-11-15' };
    const request = { ...base, channel: 'persona:character-update' as const, envelope: { version: 1, payload: profile } };
    expect(authorizeIpcRequest(request)).toEqual(profile);
    for (const forged of [{ ...profile, state: { mood: null } }, { ...profile, age: 0 }, { ...profile, ageSince: 'tomorrow' }, { ...profile, bible: 'x'.repeat(6_001) }]) {
      expect(() => authorizeIpcRequest({ ...request, envelope: { version: 1, payload: forged } })).toThrow();
    }
    expect(() => authorizeIpcRequest({ ...request, senderRole: 'overlay' })).toThrow('role');
  });
  it('reads background health only from the console, with nothing to choose', () => {
    const request = { ...base, channel: 'attention:health' as const, envelope: { version: 1, payload: {} } };
    expect(authorizeIpcRequest(request)).toEqual({});
    expect(() => authorizeIpcRequest({ ...request, envelope: { version: 1, payload: { feature: 'wechat' } } })).toThrow();
    expect(() => authorizeIpcRequest({ ...request, senderRole: 'overlay' })).toThrow('role');
    expect(() => authorizeIpcRequest({ ...request, senderUrl: 'https://untrusted.example' })).toThrow('origin');
  });
});
