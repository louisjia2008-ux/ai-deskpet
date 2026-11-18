// @vitest-environment node
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { utilityProcess } from 'electron';
import type { UtilityProcess } from 'electron';
import { ProviderUtilityClient } from './utility-client';
import { providerBindingFingerprint } from './request-budget';
import type { ProviderRequestObservation } from '../../shared';
import type { ProviderCredentials } from './types';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
class Child extends EventEmitter {
  postMessage = vi.fn();
  kill = vi.fn(() => true);
}
const children: Child[] = [];
const clients: ProviderUtilityClient[] = [];
const credentials: ProviderCredentials = { apiKey: null, config: {
  id: '12345678-1234-4234-8234-123456789012', kind: 'ollama', name: 'Fixture',
  baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', enabled: true, supportsTools: false, secretState: 'missing',
} };
const fixture = () => {
  vi.mocked(utilityProcess.fork).mockImplementation(() => {
    const child = new Child(); children.push(child); return child as unknown as UtilityProcess;
  });
  const client = new ProviderUtilityClient('/fixture/utility.js', 1_000); clients.push(client);
  return client;
};
const requestId = (child: Child): string => (child.postMessage.mock.calls[0]?.[0] as { requestId: string }).requestId;
afterEach(() => { for (const client of clients.splice(0)) client.dispose(); children.splice(0); vi.useRealTimers(); vi.clearAllMocks(); });

describe('Provider utility lifecycle', () => {
  it('forks on first use after keychain access and returns actual model results', async () => {
    const client = fixture(); expect(utilityProcess.fork).not.toHaveBeenCalled();
    const models = client.models(credentials); const child = children[0]!;
    child.emit('message', { version: 1, kind: 'provider:models-result', requestId: requestId(child), models: [] });
    await expect(models).resolves.toEqual([]);
  });

  it('rejects requests when the child exits and starts a fresh child on the next request', async () => {
    const client = fixture(); const first = client.models(credentials); const child = children[0]!;
    const rejected = expect(first).rejects.toThrow('provider.unavailable'); child.emit('exit', 1); await rejected;
    const next = client.models(credentials); const replacement = children[1]!;
    replacement.emit('message', { version: 1, kind: 'provider:models-result', requestId: requestId(replacement), models: [] });
    await expect(next).resolves.toEqual([]); expect(utilityProcess.fork).toHaveBeenCalledTimes(2);
  });

  it('bounds a dropped model response even if the worker sends an unrelated response', async () => {
    vi.useFakeTimers(); const client = fixture(); const result = client.models(credentials); const child = children[0]!;
    const failure = expect(result).rejects.toThrow('provider.timeout');
    child.emit('message', { version: 1, kind: 'provider:complete', requestId: requestId(child) });
    await vi.advanceTimersByTimeAsync(1_001); await failure;
    expect(child.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'provider:cancel' }));
  });

  it.each([
    { kind: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434/v1', stillOpenAfterMs: 14 * 60_000, abortedAfterMs: 16 * 60_000 },
    { kind: 'openai-compatible' as const, baseUrl: 'https://provider.invalid/v1', stillOpenAfterMs: 60_000, abortedAfterMs: 70_000 },
  ])('lets a silent $kind stream outlast the worker limit between events', async ({ kind, baseUrl, stillOpenAfterMs, abortedAfterMs }) => {
    vi.useFakeTimers();
    vi.mocked(utilityProcess.fork).mockImplementation(() => { const child = new Child(); children.push(child); return child as unknown as UtilityProcess; });
    const client = new ProviderUtilityClient('/fixture/utility.js'); clients.push(client);
    const stream = client.stream({ ...credentials, config: { ...credentials.config, kind, baseUrl } }, { model: 'fixture', messages: [] });
    let settled = false;
    const outcome = stream.next().catch((caught: unknown) => caught).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(stillOpenAfterMs);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(abortedAfterMs - stillOpenAfterMs);
    expect(await outcome).toMatchObject({ message: 'provider.timeout' });
    children[0]!.emit('message', { version: 1, kind: 'provider:error', requestId: requestId(children[0]!), errorCode: 'provider.cancelled' });
  });

  it('bounds a silent stream and fails an exited stream rather than waiting forever', async () => {
    vi.useFakeTimers(); const client = fixture();
    const stream = client.stream(credentials, { model: 'fixture', messages: [] });
    const failure = expect(stream.next()).rejects.toThrow('provider.timeout');
    await vi.advanceTimersByTimeAsync(1_001);
    const timedOutChild = children[0]!;
    timedOutChild.emit('message', { version: 1, kind: 'provider:error', requestId: requestId(timedOutChild), errorCode: 'provider.cancelled' });
    await failure;
    const second = client.stream(credentials, { model: 'fixture', messages: [] });
    const exited = expect(second.next()).rejects.toThrow('provider.unavailable');
    children[0]!.emit('exit', 1); await exited;
  });

  it('does not launch a child for a cancelled request or after disposal', async () => {
    const client = fixture(); const controller = new AbortController(); controller.abort();
    await expect(client.models(credentials, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(client.stream(credentials, { model: 'fixture', messages: [] }, controller.signal).next()).rejects.toMatchObject({ name: 'AbortError' });
    client.dispose(); await expect(client.models(credentials)).rejects.toThrow('provider.unavailable');
    expect(utilityProcess.fork).not.toHaveBeenCalled();
  });

  it('roundtrips a selected model inspection without dispatching a generation request', async () => {
    const client = fixture(); const result = client.adapter(credentials).inspectModel!('selected:model'); const child = children[0]!;
    expect(child.postMessage).toHaveBeenCalledOnce();
    expect(child.postMessage.mock.calls[0]?.[0]).toMatchObject({ kind: 'provider:inspect-model', model: 'selected:model' });
    const inspection = { contextWindowTokens: 32768, executionDestination: 'remote', source: 'ollama-show' };
    child.emit('message', { version: 1, kind: 'provider:inspect-model-result', requestId: requestId(child), inspection });
    await expect(result).resolves.toEqual(inspection);
  });

  it('rejects an inspection on worker exit and does not turn it into local evidence', async () => {
    const client = fixture(); const result = client.inspectModel(credentials, 'fixture');
    const failure = expect(result).rejects.toThrow('provider.unavailable');
    children[0]!.emit('exit', 1); await failure;
  });

  it('preserves an actual observation before worker exit without fabricating a terminal receipt', async () => {
    const client = fixture();
    const identity = { requestId: crypto.randomUUID(), bindingDigest: providerBindingFingerprint(credentials.config, 'fixture') };
    const stream = client.stream(credentials, {
      model: 'fixture', messages: [{ role: 'user', content: 'fixture' }], identity, maxOutputTokens: 512,
      contextBudget: { contextWindowTokens: 4096, safetyMarginTokens: 256, capacitySource: 'conservative-fallback' },
    });
    const first = stream.next(); const child = children[0]!;
    const observation: ProviderRequestObservation = { ...identity, bodySHA256: 'a'.repeat(64), inputEstimate: 300, phase: 'fetch-invoked', httpStatus: null, outcome: null, usage: { inputTokens: null, outputTokens: null, source: 'unknown' }, finishReason: null };
    child.emit('message', { version: 1, kind: 'provider:event', requestId: requestId(child), event: { type: 'request-observation', observation } });
    await expect(first).resolves.toEqual({ done: false, value: { type: 'request-observation', observation } });
    const failure = expect(stream.next()).rejects.toThrow('provider.unavailable'); child.emit('exit', 1); await failure;
  });

  it('cancels the owned utility stream when its consumer returns early', async () => {
    const client = fixture(); const stream = client.stream(credentials, { model: 'fixture', messages: [] });
    const first = stream.next(); const child = children[0]!; const id = requestId(child);
    child.emit('message', { version: 1, kind: 'provider:event', requestId: id, event: { type: 'text', text: 'partial' } });
    await first; const returning = stream.return(undefined);
    await Promise.resolve();
    child.emit('message', { version: 1, kind: 'provider:complete', requestId: id });
    await returning;
    expect(child.postMessage).toHaveBeenLastCalledWith({ version: 1, kind: 'provider:cancel', requestId: id });
  });
});
