import { describe, expect, it } from 'vitest';
import { authorizeIpcRequest } from '../../src/main/ipc-policy';
import type { InvokeChannel } from '../../src/shared';

const id = '01234567-89ab-4def-8123-456789abcdef';
const request = (channel: InvokeChannel, payload: unknown) => ({
  channel, envelope: { version: 1, payload }, senderUrl: 'deskpet://app/main_window/index.html',
  senderRole: 'console' as const, allowedRoles: ['console'] as const, development: false,
});

describe('chat interaction IPC', () => {
  const cases: Array<[InvokeChannel, Record<string, unknown>]> = [
    ['chat:get-interaction', { sessionId: id }],
    ['chat:followup', { runId: id, sessionId: id, operationId: id, content: 'Only read the files.' }],
    ['chat:resolve-approval', { runId: id, sessionId: id, approvalId: id, decision: 'allow-once' }],
  ];
  for (const [channel, payload] of cases) {
    it(`${channel} requires the console and an app origin`, () => {
      const valid = request(channel, payload);
      expect(authorizeIpcRequest(valid)).toEqual(payload);
      expect(() => authorizeIpcRequest({ ...valid, senderRole: 'overlay' })).toThrow('role');
      expect(() => authorizeIpcRequest({ ...valid, senderUrl: 'https://example.org/' })).toThrow('origin');
      expect(() => authorizeIpcRequest({ ...valid, envelope: { version: 1, payload: { ...payload, providerId: id, capabilityId: 'workspace.write', scope: 'always' } } })).toThrow();
    });
  }

  it('accepts only one-operation allow or deny for a host-issued approval', () => {
    const payload = { runId: id, sessionId: id, approvalId: id, decision: 'deny' };
    expect(authorizeIpcRequest(request('chat:resolve-approval', payload))).toEqual(payload);
    expect(authorizeIpcRequest(request('chat:resolve-approval', { ...payload, decision: 'allow-run' }))).toEqual({ ...payload, decision: 'allow-run' });
    for (const decision of ['always', 'allow-task', 'auto', true]) {
      expect(() => authorizeIpcRequest(request('chat:resolve-approval', { ...payload, decision }))).toThrow();
    }
    expect(() => authorizeIpcRequest(request('chat:resolve-approval', { ...payload, approvalId: '../stale' }))).toThrow();
  });

  it('bounds additions and requires the operation, run and session identities', () => {
    const payload = { runId: id, sessionId: id, operationId: id, content: 'Add citations.' };
    for (const content of ['', '   ', 'x'.repeat(8_001)]) expect(() => authorizeIpcRequest(request('chat:followup', { ...payload, content }))).toThrow();
    expect(() => authorizeIpcRequest(request('chat:followup', { runId: id, sessionId: id, content: 'missing operation' }))).toThrow();
    expect(() => authorizeIpcRequest(request('chat:followup', { ...payload, content: 'read only', grant: { capabilityId: 'workspace.write' } }))).toThrow();
  });
});
