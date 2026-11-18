// @vitest-environment node
import { EventEmitter } from 'node:events';
import type { UtilityProcess } from 'electron';
import { utilityProcess } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderUtilityClient } from './utility-client';
import { InferenceAdmission } from './inference-admission';
import type { ProviderChatRequest, ProviderCredentials } from './types';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
class Child extends EventEmitter {
  postMessage = vi.fn();
  kill = vi.fn(() => true);
}
const credentials: ProviderCredentials = { apiKey: null, config: {
  id: '7ec6ad46-59ab-42d7-8410-feae2a2e5550', kind: 'ollama', name: 'Synthetic utility', model: 'synthetic',
  baseUrl: 'http://127.0.0.1:11991/v1', enabled: true, supportsTools: false, secretState: 'missing',
} };
const request: ProviderChatRequest = { model: 'synthetic', executionMode: 'background-text', messages: [{ role: 'user', content: 'synthetic' }] };
const clients: ProviderUtilityClient[] = [];
const fixture = () => {
  const children: Child[] = [];
  vi.mocked(utilityProcess.fork).mockImplementation(() => { const child = new Child(); children.push(child); return child as unknown as UtilityProcess; });
  const client = new ProviderUtilityClient('/synthetic/utility.js', 1000, 50); clients.push(client);
  return { client, children };
};
const chatId = (child: Child): string => (child.postMessage.mock.calls.find(([message]) => message.kind === 'provider:chat')?.[0] as { requestId: string }).requestId;
const acknowledge = (child: Child, id: string, kind: 'provider:complete' | 'provider:error' = 'provider:complete'): void => {
  child.emit('message', { version: 1, kind, requestId: id, ...(kind === 'provider:error' ? { errorCode: 'provider.cancelled' } : {}) });
};
const flush = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
afterEach(() => { for (const client of clients.splice(0)) client.dispose(); vi.useRealTimers(); vi.clearAllMocks(); });

describe('utility local transport drain acknowledgement', () => {
  it('holds shared inference capacity after local cancel until the owned worker acknowledges cleanup', async () => {
    const { client, children } = fixture(); const gate = new InferenceAdmission(); const controller = new AbortController();
    let backgroundDone = false; let foregroundAdmitted = false;
    const release = await gate.acquire('background');
    const stream = client.stream(credentials, request, controller.signal);
    const background = (async () => { try { await stream.next(); } finally { backgroundDone = true; release(); } })();
    const rejected = expect(background).rejects.toMatchObject({ name: 'AbortError' });
    const child = children[0]!; const id = chatId(child);
    const foreground = gate.acquire('foreground').then((finish) => { foregroundAdmitted = true; finish(); });
    controller.abort(); await flush();
    child.emit('message', { version: 1, kind: 'provider:event', requestId: id, event: { type: 'request-observation', observation: {
      requestId: id, bindingDigest: 'a'.repeat(64), bodySHA256: 'b'.repeat(64), inputEstimate: 1, phase: 'terminal',
      httpStatus: 200, outcome: 'aborted', usage: { inputTokens: null, outputTokens: null, source: 'unknown' }, finishReason: null,
    } } });
    await flush();
    expect(backgroundDone).toBe(false); expect(foregroundAdmitted).toBe(false); expect(child.kill).not.toHaveBeenCalled();
    expect(child.postMessage.mock.calls.filter(([message]) => message.kind === 'provider:cancel').every(([message]) => message.requestId === id)).toBe(true);
    acknowledge(child, id, 'provider:error'); await rejected; await foreground;
    expect(backgroundDone).toBe(true); expect(foregroundAdmitted).toBe(true); expect(child.kill).not.toHaveBeenCalled();
  });

  it('waits for transport acknowledgement when a consumer returns early, rather than treating text as terminal', async () => {
    const { client, children } = fixture(); const stream = client.stream(credentials, request);
    const first = stream.next(); const child = children[0]!; const id = chatId(child);
    child.emit('message', { version: 1, kind: 'provider:event', requestId: id, event: { type: 'text', text: 'partial' } }); await first;
    let completed = false; const returning = stream.return(undefined).then(() => { completed = true; }); await flush();
    expect(completed).toBe(false); expect(child.kill).not.toHaveBeenCalled();
    acknowledge(child, id); await returning; expect(completed).toBe(true);
    const next = client.stream(credentials, request); const nextValue = next.next();
    const nextId = (child.postMessage.mock.calls.filter(([message]) => message.kind === 'provider:chat').at(-1)?.[0] as { requestId: string }).requestId;
    acknowledge(child, nextId); await expect(nextValue).resolves.toMatchObject({ done: true });
  });

  it('fails closed after missing cleanup acknowledgement and only a real worker exit reopens generation', async () => {
    vi.useFakeTimers(); const { client, children } = fixture(); const controller = new AbortController();
    const stream = client.stream(credentials, request, controller.signal); const pending = stream.next();
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const child = children[0]!; const id = chatId(child); controller.abort(); await flush();
    await vi.advanceTimersByTimeAsync(51); await rejected;
    const chatsBefore = child.postMessage.mock.calls.filter(([message]) => message.kind === 'provider:chat').length;
    await expect(client.stream(credentials, request).next()).rejects.toThrow('provider.transportUncertain');
    expect(child.postMessage.mock.calls.filter(([message]) => message.kind === 'provider:chat')).toHaveLength(chatsBefore);
    acknowledge(child, id); // A late envelope is not used to reopen a timed-out worker.
    await expect(client.stream(credentials, request).next()).rejects.toThrow('provider.transportUncertain');
    expect(child.kill).not.toHaveBeenCalled(); child.emit('exit', 1);
    const next = client.stream(credentials, request); const nextValue = next.next(); const replacement = children[1]!;
    acknowledge(replacement, chatId(replacement)); await expect(nextValue).resolves.toMatchObject({ done: true });
    expect(children).toHaveLength(2);
  });

  it('records late usage through the accounting callback without yielding business output, and waits for its commit', async () => {
    const { client, children } = fixture(); const controller = new AbortController(); const gate = new InferenceAdmission();
    let commit: (() => void) | undefined; let foregroundAdmitted = false;
    const recorded: unknown[] = [];
    const observer = vi.fn(async (observation) => { recorded.push(observation); await new Promise<void>((resolve) => { commit = resolve; }); });
    const release = await gate.acquire('background');
    const stream = client.adapter(credentials, observer).streamChat(request, controller.signal);
    const background = (async () => { try { return await stream.next(); } finally { release(); } })();
    const rejected = expect(background).rejects.toMatchObject({ name: 'AbortError' });
    const child = children[0]!; const id = chatId(child); controller.abort(); await flush();
    const foreground = gate.acquire('foreground').then((finish) => { foregroundAdmitted = true; finish(); });
    const observation = { requestId: id, bindingDigest: 'a'.repeat(64), bodySHA256: 'b'.repeat(64), inputEstimate: 1,
      phase: 'terminal', httpStatus: 200, outcome: 'aborted', usage: { inputTokens: 17, outputTokens: 9, source: 'provider-reported' }, finishReason: null };
    child.emit('message', { version: 1, kind: 'provider:event', requestId: id, event: { type: 'text', text: 'LATE_BUSINESS_TEXT' } });
    child.emit('message', { version: 1, kind: 'provider:event', requestId: id, event: { type: 'request-observation', observation } });
    acknowledge(child, id, 'provider:error'); await flush();
    expect(observer).toHaveBeenCalledOnce(); expect(recorded).toEqual([observation]); expect(foregroundAdmitted).toBe(false);
    commit?.(); await rejected; await foreground; expect(foregroundAdmitted).toBe(true); expect(child.kill).not.toHaveBeenCalled();
  });

  it('propagates an uncertain late accounting commit instead of hiding the authority failure', async () => {
    const { client, children } = fixture(); const controller = new AbortController();
    const observer = vi.fn(async () => { throw new Error('repository.commitUncertain'); });
    const stream = client.adapter(credentials, observer).streamChat(request, controller.signal); const next = stream.next();
    const rejected = expect(next).rejects.toThrow('repository.commitUncertain');
    const child = children[0]!; const id = chatId(child); controller.abort(); await flush();
    child.emit('message', { version: 1, kind: 'provider:event', requestId: id, event: { type: 'request-observation', observation: {
      requestId: id, bindingDigest: 'a'.repeat(64), bodySHA256: 'b'.repeat(64), inputEstimate: 1, phase: 'terminal', httpStatus: null,
      outcome: 'aborted', usage: { inputTokens: null, outputTokens: null, source: 'unknown' }, finishReason: null,
    } } });
    acknowledge(child, id, 'provider:error'); await rejected; expect(observer).toHaveBeenCalledOnce();
  });

  it('treats observed worker exit as local transport completion without inventing a server outcome', async () => {
    const { client, children } = fixture(); const controller = new AbortController();
    const stream = client.stream(credentials, request, controller.signal); const pending = stream.next();
    const failure = expect(pending).rejects.toThrow('provider.unavailable');
    children[0]!.emit('exit', 1); await failure;
    expect(children[0]!.kill).not.toHaveBeenCalled();
  });
});
