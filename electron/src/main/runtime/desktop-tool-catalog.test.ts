// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { log } from 'node:console';
import { registerBuiltinTools } from '../tools/builtins';
import { registerChatCronTools } from '../tools/chat-cron-tools';
import { registerSandboxShell } from '../tools/sandbox-shell';
import { WorkspaceAccess } from '../tools/workspace';
import { registerChatWorkTools } from '../tools/chat-work-tools';
import { prepareProviderChatRequest } from '../providers/request-budget';
import { ToolRegistry } from './tool-registry';
import { DesktopToolCatalog, desktopProviderTool } from './desktop-tool-catalog';

const registry = new ToolRegistry();
// Only the production declarations are serialized. These services never run.
registerSandboxShell(registry, new WorkspaceAccess('/synthetic/unused'));
registerBuiltinTools(registry, { workspace: {}, web: {}, notify: vi.fn(), createTimer: vi.fn() } as unknown as Parameters<typeof registerBuiltinTools>[1]);
registerChatCronTools(registry, { service: {}, context: () => null } as unknown as Parameters<typeof registerChatCronTools>[1]);
registerChatWorkTools(registry, { service: {}, context: () => null } as unknown as Parameters<typeof registerChatWorkTools>[1]);

it('loads the five Minecraft tools only on request and preserves the other discovery groups', async () => {
  const minecraftIds = ['minecraft.connect', 'minecraft.start', 'minecraft.status', 'minecraft.cancel', 'minecraft.disconnect'];
  const definitions = [...registry.describe(), ...minecraftIds.map(id => ({
    id, title: id, capabilityId: 'minecraft.control', risk: 'medium' as const, sideEffect: true,
    parameters: { type: 'object', additionalProperties: false },
  }))];
  const catalog = new DesktopToolCatalog();
  const context = { runId: 'fixture', taskId: 'discovery', signal: new AbortController().signal };
  expect(catalog.discovery.inputSchema.safeParse({ group: 'minecraft' }).success).toBe(true);
  for (const group of ['schedules', 'records', 'skills']) {
    expect(catalog.discovery.inputSchema.safeParse({ group }).success).toBe(true);
  }
  expect(catalog.describe(definitions).some(tool => minecraftIds.includes(tool.id))).toBe(false);
  await catalog.discovery.execute({ group: 'records' }, context);
  expect(catalog.describe(definitions).some(tool => tool.id === 'task.get')).toBe(true);
  expect(catalog.describe(definitions).some(tool => minecraftIds.includes(tool.id))).toBe(false);
  expect(await catalog.discovery.execute({ group: 'minecraft' }, context)).toEqual({ loaded: 'minecraft' });
  expect(catalog.describe(definitions).filter(tool => minecraftIds.includes(tool.id)))
    .toEqual(definitions.filter(tool => minecraftIds.includes(tool.id)));
  expect(catalog.describe(definitions).some(tool => tool.id === 'cron.update')).toBe(false);
  expect(new DesktopToolCatalog().describe(definitions).some(tool => minecraftIds.includes(tool.id))).toBe(false);
});

it.each([
  ['local-native-ollama', { ollamaNumCtx: 16384 }],
  ['cloud-chat-completions', {}],
  ['cloud-responses', { wireProtocol: 'responses' as const }],
] as const)('%s reduces initial serialized input with the same user text and preserves full schemas across discovery rounds', async (protocol, options) => {
  const definitions = registry.describe().filter(tool => tool.id !== 'shell.run' || protocol === 'local-native-ollama');
  const catalog = new DesktopToolCatalog();
  const messages = [{ role: 'user' as const, content: '你好，今天星期几？' }];
  const request = { model: 'fixture', messages, ...options };
  // The baseline is the former desktop wire projection with no standing grants.
  const baseline = prepareProviderChatRequest({ ...request, tools: definitions.map(tool => ({
    name: tool.id, parameters: tool.parameters,
    description: tool.title + '. ' + (tool.description ? tool.description + ' ' : '') + 'Capability: ' + tool.capabilityId + '. Risk: ' + tool.risk + '. The app must obtain user approval before this operation executes.',
  })) });
  const initial = catalog.describe(definitions);
  for (const tool of ['cron.create', 'history.search', 'history.read', 'task.update', 'web.search', 'workspace.write']) {
    expect(initial.find(item => item.id === tool)).toEqual(definitions.find(item => item.id === tool));
  }
  const compact = prepareProviderChatRequest({ ...request, tools: initial.map(desktopProviderTool) });
  expect(compact.inputEstimate).toBeLessThan(baseline.inputEstimate * 0.85);
  log(JSON.stringify({ protocol, fullInputEstimate: baseline.inputEstimate, compactInputEstimate: compact.inputEstimate,
    fullBytes: Buffer.byteLength(baseline.bodyText), compactBytes: Buffer.byteLength(compact.bodyText), fullTools: definitions.length, compactTools: initial.length }));

  const input = { group: 'records' };
  const output = await catalog.discovery.execute(input, { runId: 'fixture', taskId: 'lookup', signal: new AbortController().signal });
  const expanded = catalog.describe(definitions);
  expect(expanded.find(tool => tool.id === 'task.get')).toEqual(definitions.find(tool => tool.id === 'task.get'));
  expect(expanded.some(tool => tool.id === 'cron.update')).toBe(false);
  const continuation = prepareProviderChatRequest({ ...request, tools: expanded.map(desktopProviderTool),
    messages: [...messages, { role: 'assistant', content: '', toolCalls: [{ id: 'lookup', name: 'tools.discover', argumentsJson: JSON.stringify(input) }] },
      { role: 'tool', content: JSON.stringify(output), toolCallId: 'lookup' }] });
  expect(continuation.toolNames.get('task_get')).toBe('task.get');
  expect(continuation.bodyText).toContain('tools_discover');
  expect(continuation.bodyText).toContain('loaded');
  await catalog.discovery.execute({ group: 'schedules' }, { runId: 'fixture', taskId: 'load-schedules', signal: new AbortController().signal });
  const fullyDiscovered = catalog.describe(definitions).filter(tool => tool.id !== 'tools.discover');
  expect(fullyDiscovered).toEqual(definitions);
  for (const tool of fullyDiscovered) {
    const wireTool = desktopProviderTool(tool);
    expect(wireTool.parameters).toEqual(tool.parameters);
    expect(wireTool.description).toBe(tool.title + '.' + (tool.description ? ' ' + tool.description : ''));
  }
});
