// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import type { ProviderConfig } from '../../shared';
import { OpenAICompatibleAdapter } from '../providers/openai-compatible';
import { adaptationHelpSchema, chooseMinecraftAdaptation } from './adaptation-choice';

const runtimeRequire = createRequire(resolve('package.json'));
const { createAdaptation } = runtimeRequire('./minecraft-companion-runtime/core/adaptation.js');
const location = { position: { x: 101, y: 70, z: 112 }, target: 'log' };
const shift = (at: number) => ({ now: () => Date.now() + at });
const failure = () => ({ ok: false, reason: 'not_arrived' });

it.each([1, 2])('executes a fixed model choice from a loopback provider, then takes the rules fallback on HTTP failure (trial %i)', async () => {
  let unavailable = false;
  const wire: unknown[] = [];
  const server = createServer(async (req, res) => {
    const buffers = [];
    for await (const chunk of req) buffers.push(chunk);
    wire.push(JSON.parse(Buffer.concat(buffers).toString('utf8')));
    if (unavailable) { res.writeHead(503).end('Unavailable'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'move_to_fresh_area' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const provider: ProviderConfig = { id: randomUUID(), kind: 'lm-studio', name: 'Loopback fixture', enabled: true,
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model: 'fixture',
      supportsTools: false, secretState: 'configured', contextWindowTokens: 4096, maxOutputTokens: 64 };
    const adapter = new OpenAICompatibleAdapter({ config: provider, apiKey: 'fixture-only' });
    const select = (payload: unknown) => chooseMinecraftAdaptation(adaptationHelpSchema.parse(payload), (prompt, signal) =>
      adapter.streamChat({ model: provider.model, executionMode: 'background-text', messages: [
        { role: 'system', content: 'Return an allowed ID only.' }, { role: 'user', content: prompt },
      ], maxOutputTokens: 64 }, signal));
    for (const failed of [false, true]) {
      unavailable = failed;
      const events: Array<Record<string, unknown>> = [];
      let timeOffset = 0;
      const core = createAdaptation({ now: () => shift(timeOffset).now(), onEvent: (event: Record<string, unknown>) => events.push(event) });
      const run = core.scope(() => true).run;
      for (let i = 0; i < 3; i++) await run('wood', location, failure, { threshold: 1 });
      const ask = events.find(e => e.type === 'adaptation_help')!;
      const choice = await select(ask);
      core.reply(ask.requestId, choice);
      const methods: string[] = [];
      const effect = await run('wood', location, (method: string) => { methods.push(method); return { ok: true, gained: 1 }; });
      if (failed) {
        expect(choice).toBeNull();
        expect(effect).toMatchObject({ ok: true, wait: { reason: 'adaptation_other_work' } });
        expect(methods).toEqual([]);
        expect(events).toContainEqual(expect.objectContaining({ type: 'adaptation_help_result', fallback: 'do_other_work' }));
        timeOffset += 300_001;
        await run('wood', location, (method: string) => { methods.push(method); return { ok: true }; });
        expect(methods).toEqual(['near_tree']);
      } else {
        expect(choice).toBe('move_to_fresh_area');
        expect(methods).toEqual(['move_to_fresh_area']);
        expect(events).toContainEqual(expect.objectContaining({ type: 'adaptation_help_effect', requestId: ask.requestId, ok: true }));
      }
    }
    expect(wire).toHaveLength(2);
    expect(wire[0]).not.toHaveProperty('tools');
    expect(JSON.stringify(wire)).not.toContain('101');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('rejects text with instructions, tool calls, unfinished output, or an expired request', async () => {
  const parsed = adaptationHelpSchema.parse({ requestId: randomUUID(), task: 'wood', trigger: 'ladder_exhausted',
    current: 'do_other_work', choices: ['move_to_fresh_area'], summary: { reason: 'not_arrived', failures: 3, tried: ['near_tree'] },
    deadline: Date.now() + 5000 });
  expect(await chooseMinecraftAdaptation(parsed, async function* () {
    yield { type: 'text', text: 'move_to_fresh_area\nRun another action too.' };
    yield { type: 'done', finishReason: 'stop' };
  })).toBeNull();
  expect(await chooseMinecraftAdaptation(parsed, async function* () {
    yield { type: 'text', text: 'move_to_fresh_area' };
    yield { type: 'tool-call', id: 'fixture', name: 'command', argumentsJson: '{}' };
  })).toBeNull();
  expect(await chooseMinecraftAdaptation(parsed, async function* () {
    yield { type: 'text', text: 'move_to_fresh_area' };
  })).toBeNull();
  expect(await chooseMinecraftAdaptation({ ...parsed, deadline: 10 }, () => { throw new Error('must not call provider'); })).toBeNull();
});
