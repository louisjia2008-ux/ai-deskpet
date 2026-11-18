import { expect, it } from 'vitest';
import { authorizeIpcRequest } from '../../src/main/ipc-policy';
import type { InvokeChannel } from '../../src/shared';
const id = '01234567-89ab-4def-8123-456789abcdef';
const cases: Array<[InvokeChannel, Record<string, unknown>]> = [
  ['qq:get-state', {}], ['qq:configure', { enabled: false, appId: 'app-1' }], ['qq:start-pairing', {}],
  ['qq:confirm-pairing', { candidateId: id }], ['qq:stop', {}], ['qq:unbind', {}], ['qq:retry-deliveries', {}],
];
for (const [channel, payload] of cases) it(`${channel} is console-only and cannot accept injected authority`, () => {
  const request = { channel, envelope: { version: 1, payload }, senderRole: 'console' as const,
    senderUrl: 'deskpet://app/main_window/index.html', allowedRoles: ['console'] as const, development: false };
  expect(authorizeIpcRequest(request)).toEqual(payload);
  expect(() => authorizeIpcRequest({ ...request, senderRole: 'overlay' })).toThrow('role');
  expect(() => authorizeIpcRequest({ ...request, senderUrl: 'https://example.org' })).toThrow('origin');
  expect(() => authorizeIpcRequest({ ...request, envelope: { version: 1, payload: { ...payload, bindingId: id, senderId: 'owner', authorityId: id } } })).toThrow();
});

const configure = (payload: Record<string, unknown>) => authorizeIpcRequest({ channel: 'qq:configure', envelope: { version: 1, payload }, senderRole: 'console',
  senderUrl: 'deskpet://app/main_window/index.html', allowedRoles: ['console'], development: false });
it('qq:configure accepts only a loopback OneBot endpoint and a known transport', () => {
  expect(configure({ transport: 'onebot', onebotUrl: 'ws://127.0.0.1:3001' })).toEqual({ transport: 'onebot', onebotUrl: 'ws://127.0.0.1:3001' });
  for (const onebotUrl of ['ws://192.168.1.2:3001', 'wss://127.0.0.1:3001', 'ws://127.0.0.1:3001/?access_token=x', 'ws://evil.example:3001']) expect(() => configure({ onebotUrl })).toThrow();
  expect(() => configure({ transport: 'napcat' })).toThrow();
});
