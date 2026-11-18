// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { ProviderConfig, ProviderRequestObservation } from '../../shared';
import type { ProviderStreamEvent } from './types';
import { OpenAICompatibleAdapter } from './openai-compatible';
import { providerBindingFingerprint } from './request-budget';
import { providerUtilityResponseSchema } from '../../utility/provider-protocol';

const servers: Array<ReturnType<typeof createServer>> = [];
const evidence: Array<Record<string, unknown>> = [];
const cases = [
  { label: 'finite explicit USD', suffix: ',"cost":0.031,"cost_currency":"USD"', expected: 0.031 },
  { label: 'explicit USD zero', suffix: ',"cost":0,"cost_currency":"USD"', expected: 0 },
  { label: 'upper supported bound', suffix: ',"cost":1000000000000,"cost_currency":"USD"', expected: 1e12 },
  { label: 'negative amount', suffix: ',"cost":-1,"cost_currency":"USD"', expected: null },
  { label: 'above supported bound', suffix: ',"cost":1000000000001,"cost_currency":"USD"', expected: null },
  { label: 'nonfinite parsed JSON number', suffix: ',"cost":1e309,"cost_currency":"USD"', expected: null },
  { label: 'string amount', suffix: ',"cost":"0.031","cost_currency":"USD"', expected: null },
  { label: 'other currency', suffix: ',"cost":0.031,"cost_currency":"EUR"', expected: null },
  { label: 'missing currency', suffix: ',"cost":0.031', expected: null },
  { label: 'ambiguous lowercase currency', suffix: ',"cost":0.031,"cost_currency":"usd"', expected: null },
  { label: 'missing cost', suffix: ',"cost_currency":"USD"', expected: null },
] as const;

afterEach(async () => {
  await Promise.all(servers.splice(0).filter((server) => server.listening).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});
afterAll(async () => {
  const directory = process.env.DESKPET_USAGE_COST_EVIDENCE ?? join(tmpdir(), 'deskpet-usage-cost');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `integration-cost-http-${randomUUID()}.json`), JSON.stringify({
    scope: 'Production OpenAI-compatible adapter with actual loopback HTTP; utility response schema in-process only. No Electron utility process, IPC, GUI or OS keychain claim.',
    realModelCalls: 0, observedHTTPCount: evidence.length, listenersClosed: servers.length === 0, cases: evidence,
  }, null, 2), { mode: 0o600 });
});

const receive = async (label: string, usageJSON: string): Promise<ProviderRequestObservation> => {
  const calls: Array<{ method: string | undefined; url: string | undefined; bodySHA256: string; at: string }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      calls.push({ method: request.method, url: request.url, at: new Date().toISOString(),
        bodySHA256: createHash('sha256').update(Buffer.concat(chunks)).digest('hex') });
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: {"choices":[{"delta":{"content":"SYNTHETIC_COST_RESPONSE"},"finish_reason":"stop"}],"usage":${usageJSON}}\n\ndata: [DONE]\n\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture.noListener');
  const config: ProviderConfig = { id: randomUUID(), kind: 'lm-studio', name: 'SYNTHETIC_COST_HTTP',
    baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'synthetic-cost', enabled: true, supportsTools: false, secretState: 'missing' };
  const adapter = new OpenAICompatibleAdapter({ config, apiKey: null });
  const requestId = randomUUID(), events: ProviderStreamEvent[] = [];
  for await (const event of adapter.streamChat({ model: config.model, executionMode: 'background-text',
    messages: [{ role: 'user', content: 'SYNTHETIC_COST_TEST_ONLY' }],
    maxOutputTokens: 64, contextBudget: { contextWindowTokens: 4096, safetyMarginTokens: 256, capacitySource: 'configured' },
    identity: { requestId, bindingDigest: providerBindingFingerprint(config, config.model) } })) events.push(event);
  expect(calls).toHaveLength(1);
  expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  const observations = events.filter((event) => event.type === 'request-observation').map((event) => event.observation);
  const terminal = observations.find((event) => event.phase === 'terminal');
  expect(terminal).toBeDefined();
  expect(terminal?.requestId).toBe(requestId);
  expect(terminal?.bodySHA256).toBe(calls[0]?.bodySHA256);
  // This is the actual serialized protocol envelope check, not a worker run.
  const parsed = providerUtilityResponseSchema.parse({ version: 1, kind: 'provider:event', requestId: randomUUID(),
    event: { type: 'request-observation', observation: terminal } });
  expect(parsed.kind === 'provider:event' && parsed.event.type === 'request-observation' && parsed.event.observation).toEqual(terminal);
  evidence.push({ label, requestId, http: calls[0], usage: terminal!.usage, outcome: terminal!.outcome,
    wireDigestMatches: terminal!.bodySHA256 === calls[0]?.bodySHA256, utilityEnvelopeAccepted: true });
  return terminal!;
};

describe('reported USD extension at the actual HTTP adapter boundary', () => {
  it.each(cases)('$label keeps valid token counters and treats invalid or unspecified money as unknown', async (entry) => {
    const terminal = await receive(entry.label, `{"prompt_tokens":31,"completion_tokens":7${entry.suffix}}`);
    expect(terminal.usage).toEqual({ inputTokens: 31, outputTokens: 7, source: 'provider-reported', reportedCostUSD: entry.expected });
    expect(terminal.outcome).toBe('completed');
  });

  it('keeps explicitly reported USD even when token usage remains unknown', async () => {
    const terminal = await receive('USD with unknown tokens', '{"cost":0.04,"cost_currency":"USD"}');
    expect(terminal.usage).toEqual({ inputTokens: null, outputTokens: null, source: 'unknown', reportedCostUSD: 0.04 });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.01])('rejects invalid money at the utility response schema: %s', (reportedCostUSD) => {
    expect(providerUtilityResponseSchema.safeParse({ version: 1, kind: 'provider:event', requestId: randomUUID(), event: {
      type: 'request-observation', observation: { requestId: randomUUID(), bindingDigest: 'a'.repeat(64), bodySHA256: 'b'.repeat(64), inputEstimate: 12,
        phase: 'terminal', httpStatus: 200, outcome: 'completed', finishReason: 'stop',
        usage: { inputTokens: 31, outputTokens: 7, source: 'provider-reported', reportedCostUSD } },
    } }).success).toBe(false);
  });
});
