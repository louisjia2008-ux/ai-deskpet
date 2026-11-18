import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { authorizeIpcRequest } from '../../src/main/ipc-policy';
const valid = {
  channel: 'jobs:submit' as const,
  envelope: { version: 1, payload: { operationId: randomUUID(), instruction: 'Explicit task', material: 'Explicit material', privacy: 'local-only', providerId: randomUUID(), model: 'synthetic' } },
  senderUrl: 'deskpet://app/main_window/index.html', senderRole: 'console' as const, allowedRoles: ['console'] as const, development: false,
};
describe('background job IPC host ownership', () => {
  it('allows exact console submission and rejects self-reported authority and execution fields', () => {
    expect(authorizeIpcRequest(valid)).toEqual(valid.envelope.payload);
    for (const field of ['profileId', 'owner', 'attemptId', 'executionOwner', 'result', 'status', 'tools', 'credentialRef', 'origin', 'source']) {
      expect(() => authorizeIpcRequest({ ...valid, envelope: { version: 1, payload: { ...valid.envelope.payload, [field]: 'forged' } } })).toThrow();
    }
  });
  it('rejects foreign origin, overlay role and alternate protocol versions', () => {
    expect(() => authorizeIpcRequest({ ...valid, senderRole: 'overlay' })).toThrow('role');
    expect(() => authorizeIpcRequest({ ...valid, senderUrl: 'https://untrusted.example' })).toThrow('origin');
    expect(() => authorizeIpcRequest({ ...valid, envelope: { ...valid.envelope, version: 2 } })).toThrow();
  });
  it('only accepts a locating id for reads/cancel, never an authority override', () => {
    for (const channel of ['jobs:get', 'jobs:cancel'] as const) {
      const request = { ...valid, channel, envelope: { version: 1, payload: { id: randomUUID() } } };
      expect(authorizeIpcRequest(request)).toEqual(request.envelope.payload);
      expect(() => authorizeIpcRequest({ ...request, envelope: { version: 1, payload: { ...request.envelope.payload, all: true, owner: 'forged' } } })).toThrow();
    }
  });
});
