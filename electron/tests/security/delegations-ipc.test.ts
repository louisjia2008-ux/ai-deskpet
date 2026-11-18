import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { authorizeIpcRequest } from '../../src/main/ipc-policy';
import { parseDelegationCommand } from '../../src/shared/delegations';
const input = () => ({ operationId: randomUUID(), sessionId: randomUUID(), intentVersion: 1, goal: 'Explicit goal', deadlineAt: new Date(Date.now() + 60000).toISOString(),
  budget: { maxEstimatedTokens: 30000, maxRequests: 3 }, children: [{ instruction: 'Only this task', material: 'Explicit user paste', privacy: 'local-only', providerId: randomUUID(), model: 'synthetic', requirements: [] }] });
const request = () => ({ channel: 'delegations:submit' as const, envelope: { version: 1, payload: input() }, senderUrl: 'deskpet://app/main_window/index.html', senderRole: 'console' as const, allowedRoles: ['console'] as const, development: false });
describe('controlled delegation IPC', () => {
  it('accepts only exact console submission and rejects self-reported parent or child authority', () => {
    const r = request(); expect(authorizeIpcRequest(r)).toEqual(r.envelope.payload);
    for (const key of ['id', 'profileId', 'owner', 'parentId', 'childrenBypass', 'status', 'tools']) expect(() => authorizeIpcRequest({ ...r, envelope: { version: 1, payload: { ...r.envelope.payload, [key]: 'forged' } } })).toThrow();
    for (const key of ['id', 'jobId', 'sessionId', 'owner', 'source', 'scope', 'trust', 'attemptId', 'deadlineAt', 'tools']) expect(() => authorizeIpcRequest({ ...r, envelope: { version: 1, payload: { ...r.envelope.payload, children: [{ ...r.envelope.payload.children[0], [key]: 'forged' }] } } })).toThrow();
  });
  it('enforces three slots and accepts budget-free submissions without caller authority', () => {
    const r = request();
    const { budget: _legacy, ...withoutBudget } = r.envelope.payload; void _legacy;
    expect(authorizeIpcRequest({ ...r, envelope: { version: 1, payload: withoutBudget } })).toEqual(withoutBudget);
    expect(() => authorizeIpcRequest({ ...r, envelope: { version: 1, payload: { ...r.envelope.payload, children: Array(4).fill(r.envelope.payload.children[0]) } } })).toThrow();
    expect(() => authorizeIpcRequest({ ...r, envelope: { version: 1, payload: { ...r.envelope.payload, budget: { maxEstimatedTokens: 0, maxRequests: 0 } } } })).toThrow();
  });
  it('rejects wrong origins and roles on all delegation operations', () => {
    for (const [channel, payload] of [ ['delegations:open-draft', { sessionId: randomUUID() }], ['delegations:list', { sessionId: randomUUID() }],
      ['delegations:get-result', { batchId: randomUUID(), childId: randomUUID() }], ['delegations:cancel-batch', { id: randomUUID() }],
      ['delegations:cancel-child', { batchId: randomUUID(), childId: randomUUID() }], ['delegations:replace', { batchId: randomUUID(), operationId: randomUUID(), goal: 'Replacement' }] ] as const) {
      const r = { ...request(), channel, envelope: { version: 1, payload } };
      expect(() => authorizeIpcRequest({ ...r, senderRole: 'overlay' })).toThrow('role');
      expect(() => authorizeIpcRequest({ ...r, senderUrl: 'https://untrusted.example/' })).toThrow('origin');
    }
  });
  it('recognizes only the documented explicit command, never ordinary prose or embedded quoted commands', () => {
    expect(parseDelegationCommand('委派文本任务：draft goal')).toBe('draft goal');
    expect(parseDelegationCommand('委派文本任务: draft goal')).toBe('draft goal');
    for (const text of ['请帮我委派任务', 'Question about 委派文本任务：x', '> 委派文本任务：quoted', '委派文本任务：']) expect(parseDelegationCommand(text)).toBeNull();
  });
});
