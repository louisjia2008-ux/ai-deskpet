import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { authorizeIpcRequest } from '../../src/main/ipc-policy';
import type { InvokeChannel } from '../../src/shared';

const candidate = () => { const memoryId = randomUUID(); return { segments: [{ text: 'Source-grounded synthetic representation', sourceIds: [memoryId] }], coveredMemoryIds: [memoryId], uncoveredMemoryIds: [], conflicts: [] }; };
const preview = () => ({ operationId: randomUUID(), sessionId: randomUUID(), memoryIds: [randomUUID()], providerId: randomUUID(), model: 'synthetic' });
const request = (channel: InvokeChannel, payload: unknown) => ({ channel, envelope: { version: 1, payload }, senderUrl: 'deskpet://app/main_window/index.html', senderRole: 'console' as const, allowedRoles: ['console'] as const, development: false });

describe('manual consolidation IPC authority', () => {
  it('accepts exact console preview and rejects renderer-supplied source, owner, binding or job authority', () => {
    const payload = preview(); expect(authorizeIpcRequest(request('consolidation:preview', payload))).toEqual(payload);
    for (const key of ['id', 'profileId', 'owner', 'sources', 'sourceReferences', 'fingerprint', 'revision', 'binding', 'credentialRef', 'jobId', 'status', 'tools', 'autoApply']) {
      expect(() => authorizeIpcRequest(request('consolidation:preview', { ...payload, [key]: 'forged' }))).toThrow();
    }
    expect(() => authorizeIpcRequest(request('consolidation:preview', { ...payload, memoryIds: [payload.memoryIds[0], payload.memoryIds[0]] }))).toThrow();
    expect(() => authorizeIpcRequest(request('consolidation:preview', { ...payload, memoryIds: Array.from({ length: 21 }, () => randomUUID()) }))).toThrow();
  });
  it('requires an exact reviewed candidate version and explicit fidelity acknowledgement without accepting new fact authority', () => {
    const payload = { id: randomUUID(), operationId: randomUUID(), expectedVersion: 1, fidelityReviewed: true, enableRepresentation: true };
    expect(authorizeIpcRequest(request('consolidation:apply', payload))).toEqual(payload);
    for (const change of [{ fidelityReviewed: false }, { expectedVersion: 0 }, { candidate: candidate() }, { sourceTrust: 'host-confirmed' }, { evidenceCount: 9 }, { owner: 'forged' }]) {
      expect(() => authorizeIpcRequest(request('consolidation:apply', { ...payload, ...change }))).toThrow();
    }
    const { fidelityReviewed: _omitted, ...withoutReview } = payload; void _omitted;
    expect(() => authorizeIpcRequest(request('consolidation:apply', withoutReview))).toThrow();
  });
  it('validates structured edits but accepts no executable, auto-confirm or provenance override fields', () => {
    const payload = { id: randomUUID(), operationId: randomUUID(), expectedVersion: 1, candidate: candidate() };
    expect(authorizeIpcRequest(request('consolidation:edit', payload))).toEqual(payload);
    for (const extra of [{ active: true }, { jobId: randomUUID() }, { tools: ['workspace.write'] }, { sourceCursor: 42 }]) expect(() => authorizeIpcRequest(request('consolidation:edit', { ...payload, ...extra }))).toThrow();
    for (const extra of [{ trust: 'host-confirmed' }, { independentEvidence: true }, { owner: 'self' }]) {
      expect(() => authorizeIpcRequest(request('consolidation:edit', { ...payload, candidate: { ...payload.candidate, ...extra } }))).toThrow();
    }
  });
  it('rejects wrong origins, overlay role, forged envelope versions and unknown fields on every new operation', () => {
    const id = randomUUID(); const operations: Array<[InvokeChannel, unknown]> = [
      ['consolidation:sources', { sessionId: id }], ['consolidation:preview', preview()], ['consolidation:generate', { id, operationId: randomUUID() }],
      ['consolidation:list', { sessionId: id }], ['consolidation:get', { id }], ['consolidation:edit', { id, operationId: randomUUID(), expectedVersion: 1, candidate: candidate() }],
      ['consolidation:apply', { id, operationId: randomUUID(), expectedVersion: 1, fidelityReviewed: true, enableRepresentation: false }],
      ['consolidation:disable', { id, operationId: randomUUID() }], ['consolidation:cancel', { id, operationId: randomUUID() }],
    ];
    for (const [channel, payload] of operations) {
      const r = request(channel, payload); expect(authorizeIpcRequest(r)).toEqual(payload);
      expect(() => authorizeIpcRequest({ ...r, senderRole: 'overlay' })).toThrow('role');
      expect(() => authorizeIpcRequest({ ...r, senderUrl: 'https://untrusted.example/' })).toThrow('origin');
      expect(() => authorizeIpcRequest({ ...r, envelope: { version: 999, payload } })).toThrow();
      expect(() => authorizeIpcRequest({ ...r, envelope: { version: 1, payload: { ...(payload as object), owner: 'renderer' } } })).toThrow();
    }
  });
});
