// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '../../shared';
import { ChatCommands, parseChatCommand } from './chat-commands';
import type { ChatCommandTarget } from './chat-commands';

const provider = (id: string, name: string, model: string): ProviderConfig => ({ id, name, model, enabled: true } as ProviderConfig);
const local = provider('local', 'Ollama', 'kitty-qwen-27b'), cloud = provider('cloud', 'OpenAI', 'gpt-6.1-sol');
const catalog: Record<string, string[]> = { local: ['kitty-qwen-27b', 'qwen3.5:0.8b'], cloud: ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6.1-terra-mini'] };

const setup = (failing = false) => {
  const state: { providerId: string | null; model: string | null } = { providerId: null, model: null };
  const target: ChatCommandTarget = { key: 'qq', locale: 'zh-CN', selection: () => ({ ...state }),
    select: async (providerId, model) => { state.providerId = providerId; state.model = model; } };
  const commands = new ChatCommands({ providers: () => [local, cloud], activeProvider: () => local,
    models: async id => { if (failing) throw new Error('offline'); return catalog[id]!; } });
  const run = (text: string, where = target) => commands.run(parseChatCommand(text)!, where);
  return { state, target, run };
};

describe('chat command parsing', () => {
  it('recognises only the owner commands and leaves other text alone', () => {
    expect(parseChatCommand('/model')).toEqual({ name: 'model', argument: '' });
    expect(parseChatCommand(' /Model  gpt-6.1-sol ')).toEqual({ name: 'model', argument: 'gpt-6.1-sol' });
    expect(parseChatCommand('/models')).toEqual({ name: 'models', argument: '' });
    expect(parseChatCommand('/models terra')).toEqual({ name: 'model', argument: 'terra' });
    expect(parseChatCommand('/providers')).toEqual({ name: 'provider', argument: '' });
    expect(parseChatCommand('/provider 2')).toEqual({ name: 'provider', argument: '2' });
    expect(parseChatCommand('/help')).toEqual({ name: 'help', argument: '' });
    for (const text of ['/modelx', '/help me', 'use /model', '/stop', '/queue', '/model\nx', '请帮我 /model']) expect(parseChatCommand(text)).toBeNull();
  });
});

describe('chat commands', () => {
  it('follows the desktop selection until this place chooses its own', async () => {
    const { state, run } = setup();
    expect(await run('/model')).toBe('当前：Ollama · kitty-qwen-27b');
    expect(await run('/provider')).toBe('当前：Ollama · kitty-qwen-27b\n1. Ollama · kitty-qwen-27b（当前）\n2. OpenAI · gpt-6.1-sol');
    expect(await run('/provider 2')).toBe('已切换：OpenAI · gpt-6.1-sol');
    expect(state).toEqual({ providerId: 'cloud', model: 'gpt-6.1-sol' });
    expect(await run('/model')).toBe('当前：OpenAI · gpt-6.1-sol');
  });

  it('switches model by number, exact name or a part that matches one model', async () => {
    const { state, run } = setup();
    await run('/provider openai');
    expect(await run('/models')).toBe('当前：OpenAI · gpt-6.1-sol\n1. gpt-6.1-sol（当前）\n2. gpt-6.1-terra\n3. gpt-6.1-terra-mini');
    expect(await run('/model 3')).toBe('已切换：OpenAI · gpt-6.1-terra-mini');
    expect(await run('/model gpt-6.1-terra')).toBe('已切换：OpenAI · gpt-6.1-terra');
    expect(await run('/model SOL')).toBe('已切换：OpenAI · gpt-6.1-sol');
    expect(state.model).toBe('gpt-6.1-sol');
  });

  it('changes nothing when the name is ambiguous, unknown or the list cannot be read', async () => {
    const { state, run } = setup();
    await run('/provider 2');
    expect(await run('/model terra')).toBe('有多个匹配，请写得更完整：\ngpt-6.1-terra\ngpt-6.1-terra-mini');
    expect(await run('/model claude')).toContain('没有这个模型');
    expect(await run('/model 9')).toContain('没有这个模型');
    expect(await run('/provider nobody')).toContain('没有这个模型服务');
    expect(state).toEqual({ providerId: 'cloud', model: 'gpt-6.1-sol' });
    const offline = setup(true);
    expect(await offline.run('/model qwen3.5:0.8b')).toContain('没有切换');
    expect(offline.state).toEqual({ providerId: null, model: null });
  });

  it('keeps a number from one place from choosing in another', async () => {
    const { run, target } = setup();
    const other: ChatCommandTarget = { ...target, key: 'telegram', locale: 'en' };
    await run('/provider 2');
    await run('/models');
    // The other place shares the selection here but has not listed anything itself.
    expect(await run('/model 2', other)).toBe('Switched: OpenAI · gpt-6.1-terra');
    expect(await run('/help', other)).toContain('/provider');
  });
});
