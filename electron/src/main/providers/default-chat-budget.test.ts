// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '../../shared';
import { prepareChatContext } from '../domain/chat-context';
import { ToolRegistry } from '../runtime/tool-registry';
import { registerBuiltinTools } from '../tools/builtins';
import { chatRequestLimits } from './chat-request-policy';
import type { CapturedProviderBinding } from './provider-service';
import { OpenAICompatibleAdapter } from './openai-compatible';
import { prepareProviderChatRequest, providerBindingFingerprint, ProviderRequestBudgetError } from './request-budget';

const registry = new ToolRegistry();
registerBuiltinTools(registry, { workspace: {}, web: {}, notify: vi.fn(), createTimer: vi.fn() } as unknown as Parameters<typeof registerBuiltinTools>[1]);
const definitions = registry.describe();
const groups = [[], ['web.search'], ['workspace.read'], [...new Set(definitions.map(tool => tool.capabilityId))]];
const syntheticCompletion = (kind: string, text: string): Response => new Response(kind === 'openai'
  ? `data: ${JSON.stringify({ type:'response.completed', response:{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}]} })}\n\n`
  : `data: ${JSON.stringify({choices:[{delta:{content:text},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);

describe('Unconfigured context capacity must not become a 4096-token model limit', () => {
  it('continues to enforce explicit limits, application resource bounds and legacy frozen budgets', () => {
    const provider: ProviderConfig = { id: 'synthetic', kind: 'ollama', name: 'Synthetic bounds', baseUrl: 'http://127.0.0.1:1234/v1', model: 'synthetic-model', enabled: true, supportsTools: true, secretState: 'missing' };
    const binding = { provider, inspection: { contextWindowTokens: null } } as CapturedProviderBinding;
    const request = { model: provider.model, messages: [{ role: 'user' as const, content: '保留完整资料。'.repeat(2000) }], ...chatRequestLimits(binding) };
    expect(() => prepareProviderChatRequest(request)).not.toThrow();
    for (const capacitySource of ['configured', 'conservative-fallback'] as const) {
      expect(() => prepareProviderChatRequest({ ...request, contextBudget: { contextWindowTokens: 4096, safetyMarginTokens: 256, capacitySource } })).toThrow(ProviderRequestBudgetError);
    }
    expect(() => prepareProviderChatRequest({ ...request, messages: [{ role: 'user', content: 'x'.repeat(1_048_577) }] })).toThrow(ProviderRequestBudgetError);
  });
  for (const kind of ['openai', 'ollama', 'lm-studio'] as const) for (const toolName of ['web.search', 'web.read', 'workspace.read']) {
    it(`${kind} retains the complete ${toolName} result through a later model round`, async () => {
      const provider: ProviderConfig = { id: 'synthetic', kind, name: 'Synthetic tool continuation', baseUrl: kind === 'openai' ? 'https://api.openai.com/v1' : 'http://127.0.0.1:1234/v1', model: 'synthetic-model', enabled: true, supportsTools: true, secretState: 'missing' };
      const tools = definitions.map(tool => ({ name: tool.id, description: `${tool.title}. ${tool.description ?? ''}`, parameters: tool.parameters }));
      const limits = chatRequestLimits({ provider, inspection: { contextWindowTokens: null } } as CapturedProviderBinding);
      const output = JSON.stringify({ source: 'https://example.com/synthetic-reference', text: '合成参考资料，包含应完整保留的检索结果。'.repeat(500), lastFact: 'SYNTHETIC_LAST_FACT_MUST_REACH_MODEL' });
      const requiredMessages = [
        { role: 'user' as const, content: '查询一下上海的天气' },
        { role: 'assistant' as const, content: '', toolCalls: [{ id: 'synthetic-call', name: toolName, argumentsJson: '{"query":"synthetic"}' }] },
        { role: 'tool' as const, toolCallId: 'synthetic-call', content: output },
      ];
      const prepared = prepareChatContext({ sessionId: 'synthetic-session', history: [], memories: [], query: requiredMessages[0]!.content, locale: 'zh-CN', requiredMessages, binding: { providerId: provider.id, kind, baseUrl: provider.baseUrl, model: provider.model }, tools, ...limits });
      const fetcher = vi.fn<typeof fetch>(async () => syntheticCompletion(kind, 'SYNTHETIC complete continuation'));
      const adapter = new OpenAICompatibleAdapter({ config: provider, apiKey: null }, fetcher);
      for await (const event of adapter.streamChat({ model: provider.model, messages: prepared.messages, tools, ...limits, identity: { requestId: 'synthetic-request', bindingDigest: providerBindingFingerprint(provider, provider.model) } })) void event;
      expect(fetcher).toHaveBeenCalledOnce();
      const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
      if (kind === 'openai') {
        expect(body.input.at(-1)).toMatchObject({type:'function_call_output',output});
        expect(body.input.some((item: {type?:string})=>item.type==='function_call')).toBe(true);
      } else {
        expect(body.messages.at(-1).content).toBe(output);
        expect(body.messages.slice(-3)).toMatchObject(requiredMessages.map(({ role, content }) => ({ role, content })));
      }
      expect(body.tools).toHaveLength(11);
      expect(prepared.budget.inputEstimate).toBeGreaterThan(3328);
    });
  }
});

describe('P0 short chat with default capacity and real granted tool declarations', () => {
  for (const kind of ['openai', 'ollama', 'lm-studio'] as const) for (const grants of groups) for (const content of ['哈咯啊', '你好呀，陪我说说话吧。']) {
    it(`${kind}, ${grants.length} capabilities, ${content.length} characters retains required input and schemas`, () => {
      const provider: ProviderConfig = { id: 'synthetic', kind, name: 'Synthetic default', baseUrl: kind === 'openai' ? 'https://api.openai.com/v1' : 'http://127.0.0.1:1234/v1', model: 'synthetic-model', enabled: true, supportsTools: true, secretState: 'missing' };
      const tools = definitions.filter(tool => grants.includes(tool.capabilityId)).map(tool => ({ name: tool.id, description: `${tool.title}. ${tool.description ? `${tool.description} ` : ''}Capability: ${tool.capabilityId}. Risk: ${tool.risk}.`, parameters: tool.parameters }));
      const limits = chatRequestLimits({ provider, inspection: { contextWindowTokens: null } } as CapturedProviderBinding);
      const result = prepareChatContext({ sessionId: 'synthetic-session', history: [], memories: [], query: content, locale: 'zh-CN', requiredMessages: [{ role: 'user', content }], binding: { providerId: provider.id, kind, baseUrl: provider.baseUrl, model: provider.model }, tools, ...limits });
      const wire = prepareProviderChatRequest({ model: provider.model, messages: result.messages, tools, ...limits });
      expect(wire.maxInputTokens).toBe(131072 - 4096 - 256);
      expect(wire.inputEstimate).toBeLessThanOrEqual(3328);
      const body = JSON.parse(wire.bodyText);
      expect((body.messages ?? body.input).at(-1)?.content).toBe(content);
      expect(wire.body.tools).toHaveLength(tools.length);
      expect(tools).toEqual(definitions.filter(tool => grants.includes(tool.capabilityId)).map(tool => ({ name: tool.id, description: `${tool.title}. ${tool.description ? `${tool.description} ` : ''}Capability: ${tool.capabilityId}. Risk: ${tool.risk}.`, parameters: tool.parameters })));
    });
  }
  it.each(['openai', 'ollama'] as const)('dispatches %s once through the production adapter without altering its output protocol', async kind => {
    const provider: ProviderConfig = { id: 'synthetic', kind, name: 'Synthetic default', baseUrl: kind === 'openai' ? 'https://api.openai.com/v1' : 'http://127.0.0.1:1234/v1', model: 'synthetic-model', enabled: true, supportsTools: true, secretState: 'missing' };
    const limits = chatRequestLimits({ provider, inspection: { contextWindowTokens: null } } as CapturedProviderBinding);
    const tools = definitions.map(tool => ({ name: tool.id, description: `${tool.title}. ${tool.description ?? ''}`, parameters: tool.parameters }));
    const result = prepareChatContext({ sessionId: 'synthetic-session', history: [], memories: [], query: '哈咯啊', locale: 'zh-CN', requiredMessages: [{ role: 'user', content: '哈咯啊' }], binding: { providerId: provider.id, kind, baseUrl: provider.baseUrl, model: provider.model }, tools, ...limits });
    const fetcher = vi.fn<typeof fetch>(async () => syntheticCompletion(kind, 'SYNTHETIC reply'));
    const adapter = new OpenAICompatibleAdapter({ config: provider, apiKey: null }, fetcher);
    for await (const _event of adapter.streamChat({ model: provider.model, messages: result.messages, tools, ...limits, identity: { requestId: 'synthetic-request', bindingDigest: providerBindingFingerprint(provider, provider.model) } })) void _event;
    expect(fetcher).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.tools).toHaveLength(11);
    expect(body[kind === 'openai' ? 'max_output_tokens' : 'max_tokens']).toBe(4096);
  });
});
