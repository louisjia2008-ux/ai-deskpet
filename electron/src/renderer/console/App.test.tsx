import { defaultPersona } from '../../shared/persona';
import { defaultCharacterProfile } from '../../shared/character';
import type { CharacterProfile } from '../../shared/character';
import type { Persona } from '../../shared/persona';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';

import type { AppState, CharacterState, ChatEvent, ChatMessage, ChatInteractionState, ChatApprovalRequest, DeskPetApi, DeskTask, ResolvedLocale } from '../../shared';
import { defaultPluginSettings } from '../../shared/plugins';
import { initialMinecraftCompanionSnapshot } from '../../shared/minecraft-companion';
import type { MinecraftCompanionSnapshot } from '../../shared/minecraft-companion';
import { defaultAutomationProactive } from '../../shared/automation-schemas';
import { taskInputSchema } from '../../shared';
import { ConsoleApp } from './App';

const appState = (locale: ResolvedLocale): AppState => ({
  version: '0.1.0',
  platform: 'darwin',
  locale,
  resolvedLocale: locale,
  theme: 'dark',
  hotkey: 'Alt+Space',
  hotkeyRegistered: true,
  autoLaunch: false,
  dataDirectory: '/tmp/DeskPet Electron',
  capabilities: [{ id: 'tray', state: 'available', reasonCode: 'capability.reason.ready', requiredPermission: null, canRequestPermission: false }],
});

const character: CharacterState = {
  coreState: 'missing', modelState: 'missing', coreUrl: null, modelUrl: null, pendingImportId: null,
  modelName: null, scale: 1, position: null, expression: null, expressions: [], action: null, actionRevision: 0, bubble: null,
};

const on = () => () => undefined;
const api = (locale: ResolvedLocale): DeskPetApi => ({
  companionRecent: {
    status: vi.fn(async () => ({ text: '', updatedAt: null, localOnly: false, containsLocal: false })),
    clear: vi.fn(),
    setLocalOnly: vi.fn(),
    onChanged: () => () => undefined,
  },
  autoMemory: { status: vi.fn(async () => ({ enabled: true })), configure: vi.fn(async () => ({ enabled: true })) },
  vmSandbox: { status: vi.fn(async () => ({ state: 'absent' as const, busy: null, failed: false, sharedFolder: '/Users/test/DeskPet Sandbox' })), setup: vi.fn(), stop: vi.fn(), remove: vi.fn(), openFolder: vi.fn(), onChanged: on },
  memorySleep: {status:vi.fn(), configure:vi.fn(), runNow:vi.fn(), undo:vi.fn()},
  chatWork: {searchArtifacts:vi.fn(async()=>({items:[],total:0,nextOffset:null})),previewArtifact:vi.fn(), exportArtifactPdf: vi.fn(),list:vi.fn(async()=>[]),get:vi.fn(async()=>null),openArtifact:vi.fn(async()=>undefined),searchHistory:vi.fn(async()=>[]),readHistory:vi.fn(async()=>null),listCron:vi.fn(async()=>[]),pauseCron:vi.fn(async()=>undefined),resumeCron:vi.fn(async()=>undefined),cancelCron:vi.fn(async()=>undefined),onChanged:on},
  plugins: { extensions: { configureToken:vi.fn(),askTool:vi.fn(),cancelQuestion:vi.fn(),previewBridge:vi.fn(), previewManifest: vi.fn(), inspectPreview: vi.fn(), importManifest: vi.fn(), state: vi.fn(async () => ({ skills: [], servers: [] })), installSkill: vi.fn(), updateSkill: vi.fn(), readSkill: vi.fn(), runSkill: vi.fn(), toggle: vi.fn(), remove: vi.fn(), addServer: vi.fn(), listTools: vi.fn(), callTool: vi.fn() }, getState: vi.fn(async () => ({ settings: defaultPluginSettings(), crawl4aiTokenConfigured: false })), configure: vi.fn(), test: vi.fn() },
  persona: { get: vi.fn(async () => defaultPersona()), update: vi.fn(async (value: Persona) => value), getCharacter: vi.fn(async () => defaultCharacterProfile()), updateCharacter: vi.fn(async (value: CharacterProfile) => value) },
  knowledge: { getState: vi.fn(), chooseVault: vi.fn(), detach: vi.fn(), reindex: vi.fn(), search: vi.fn(), ask: vi.fn(),
    listFolders: vi.fn(), setFolderSharing: vi.fn(), setWritableFolders: vi.fn(), setEmbeddingModel: vi.fn(), setAutoIndex: vi.fn(), setDiarySync: vi.fn() },
  telegram: {pendingResults:vi.fn(async()=>[]), getState: vi.fn(async () => { throw new Error('Not paired in test'); }), configure: vi.fn(), startPairing: vi.fn(), confirmPairing: vi.fn(), unbind: vi.fn(), retryDeliveries: vi.fn(), setCronDelivery: vi.fn() },
  wechat: {
    getState: vi.fn(async () => ({ configured: false, groupName: null, state: 'stopped' as const, stale: false, paused: false,
      privateStatus: null, groupStatus: null, pending: 0, uncertain: 0, groupPolicy: { mode: 'mentions' as const, sender: null },
      groups: [], groupBindingSupported: false, reply: { model: 'fixture', split: false, stickers: false } })),
    configureGroup: vi.fn(), listReplyGroups: vi.fn(async () => []), addReplyGroup: vi.fn(), bindSelectedGroup: vi.fn(), removeGroup: vi.fn(), getModels: vi.fn(async () => []),
    getReplyFriends: vi.fn(async () => []), listReplyFriends: vi.fn(async () => []), addReplyFriend: vi.fn(), removeReplyFriend: vi.fn(),
    configureReply: vi.fn(), getCloud: vi.fn(async () => ({ available: false, assistant: { enabled: true, memories: 'all' as const, moments: false }, groupRules: {}, providers: [], settings: { private: null, groups: {} } })),
    configureCloud: vi.fn(), configureFriendCloud: vi.fn(), configureAssistant: vi.fn(), configureGroupRule: vi.fn(), recoverWindow: vi.fn(), openVirtualMachine: vi.fn(), setPaused: vi.fn(),
  },
  qq: { setCronDelivery: vi.fn(), sendPrivateImageTest: vi.fn(), setPrivateCare: vi.fn(), sendPrivateCareNow: vi.fn(), setPrivateReminders: vi.fn(), getState: vi.fn(async () => { throw new Error('Not paired in test'); }), configure: vi.fn(), startPairing: vi.fn(), confirmPairing: vi.fn(), stop: vi.fn(), unbind: vi.fn(), startGroupPairing: vi.fn(), confirmGroupPairing: vi.fn(), setGroupOpen: vi.fn(), removeGroup: vi.fn(), retryDeliveries: vi.fn() },
  rea:{checkRuntime:vi.fn(async()=>({available:false,version:null,active:false})),status:vi.fn(async()=>({available:false,version:null,active:false})),chooseTarget:vi.fn(),analyze:vi.fn(),inspect:vi.fn(),cancel:vi.fn(),ask:vi.fn()},
  attention: { snapshot: vi.fn(async () => ({ items: [], counts: { action: 0, review: 0, result: 0 }, runningCount: 0, olderResults: 0, sourceCounts: { backgroundJobs: 0, delegations: 0, consolidations: 0 } })), acknowledge: vi.fn(), onChanged: on, onOpenRequested: on },
  usage: {snapshot:vi.fn(async()=>({events:[],rates:[]}))},
  automation: {snapshot:vi.fn(async()=>({automationSchedules:[],automationTriggers:[],proactivePolicy:defaultAutomationProactive(),proactiveEvents:[],jobs:[]})), triggerResult:vi.fn(),patchProactive:vi.fn(),scheduleUpsert:vi.fn(),schedulePause:vi.fn(),scheduleCancel:vi.fn(),scheduleRunNow:vi.fn(),schedulePreview:vi.fn(async()=>[]),configureProactive:vi.fn(),explicitCheckIn:vi.fn(),cancelTrigger:vi.fn()},
  consolidation: { sources: vi.fn(async () => []), preview: vi.fn(), generate: vi.fn(), list: vi.fn(async () => []), get: vi.fn(), edit: vi.fn(), apply: vi.fn(), disable: vi.fn(), cancel: vi.fn(), onChanged: on },
  delegations: { openDraft: vi.fn(), submit: vi.fn(), list: vi.fn(async () => []), getResult: vi.fn(), cancelBatch: vi.fn(), cancelChild: vi.fn(), replace: vi.fn(), onChanged: on },
  jobs: { submit: vi.fn(), list: vi.fn(async () => []), get: vi.fn(), cancel: vi.fn(), onChanged: on },
  proactive: { getState: vi.fn(async () => ({ enabled: false, frequency: 'occasional' as const, status: 'off' as const, nextAt: null, attemptsToday: 0, dailyLimit: 6, sessionId: null, lastMessageAt: null })), configure: vi.fn(), noteInteraction: vi.fn(async () => undefined), onChanged: on },
  app: {
    getState: vi.fn(async () => appState(locale)), setLocale: vi.fn(), setTheme: vi.fn(), setHotkey: vi.fn(), setAutoLaunch: vi.fn(),
    showConsole: vi.fn(), setOverlayVisible: vi.fn(), getDiagnostics: vi.fn(), openLoginSettings: vi.fn(), onChanged: on,
  },
  backup: { create: vi.fn(), restore: vi.fn(), restart: vi.fn(), cancelRestore: vi.fn(), getState: vi.fn(async () => ({ restorePrepared: false })) },
  recovery: { getState: vi.fn(async () => null), restoreSnapshot: vi.fn(), restoreBackup: vi.fn() },
  character: {
    modelLoadFailed: vi.fn(), tap: vi.fn(),
    getState: vi.fn(async () => character), getPreview: vi.fn(async () => null), onPointer: () => () => undefined, onReaction: () => () => undefined, importCore: vi.fn(), importModel: vi.fn(), cancelImport: vi.fn(), acknowledgeModelLoaded: vi.fn(),
    setScale: vi.fn(), setPosition: vi.fn(), playAction: vi.fn(), setExpression: vi.fn(), setBubble: vi.fn(), dismissBubble: vi.fn(), setInteractive: vi.fn(), onChanged: on, onImportProgress: on,
    getVoice: vi.fn(async () => ({ enabled: false, runtimeDir: null, state: 'off' as const, problem: 'folder' as const })), setVoiceEnabled: vi.fn(), chooseVoiceFolder: vi.fn(), testVoice: vi.fn(), stopVoice: vi.fn(), onVoice: () => () => undefined,
  },
  chat: {
    openSession: vi.fn(), onOpenRequested: () => () => undefined, listSessions: vi.fn(async () => []), createSession: vi.fn(), setModelSelection: vi.fn(), renameSession: vi.fn(), setPinned: vi.fn(), setArchived: vi.fn(), removeSession: vi.fn(), restoreSession: vi.fn(), listMessages: vi.fn(async () => []), getInteraction: vi.fn(async () => null), followup: vi.fn(), resolveApproval: vi.fn(), send: vi.fn(), cancel: vi.fn(), retry: vi.fn(), forgetMemory: vi.fn(), editMemory: vi.fn(), onEvent: on, onSessionsChanged: on },
  tasks: { list: vi.fn(async () => []), upsert: vi.fn(), remove: vi.fn(), getFocus: vi.fn(async () => null), startFocus: vi.fn(), pauseFocus: vi.fn(), resumeFocus: vi.fn(), stopFocus: vi.fn(), listRunEvents: vi.fn(async () => []), onChanged: on },
  imports: { getState: vi.fn(async () => ({ records: [], activeStyle: null })), preview: vi.fn(), pickFile: vi.fn(), savePreview: vi.fn(), remove: vi.fn(), distill: vi.fn(), cancel: vi.fn(), apply: vi.fn(), setStyle: vi.fn() },
  memory: { list: vi.fn(async () => []), upsert: vi.fn(), remove: vi.fn(), shareAllWithCloud: vi.fn(async () => 0), onChanged: on },
  relationship: { get: vi.fn(async () => ({ affinity: 0, level: 1, streakDays: 0, lastInteractionAt: null, nickname: '' })), setNickname: vi.fn(), onChanged: on },
  timers: { list: vi.fn(async () => []), cancel: vi.fn(), onChanged: on },
  providers: { getRouting: vi.fn(async () => ({enabled:false,localProviderId:null,cloudProviderId:null})), setRouting: vi.fn(), discoverModels: vi.fn(async () => []), setModel: vi.fn(), select: vi.fn(), list: vi.fn(async () => []), upsert: vi.fn(), remove: vi.fn(), clearSecret: vi.fn(), test: vi.fn(), listModels: vi.fn(async () => []), onChanged: on },
  permissions: { list: vi.fn(async () => []), request: vi.fn(), revoke: vi.fn(), onChanged: on },
  migration: { preview: vi.fn(), start: vi.fn(), cancel: vi.fn(), onProgress: on },
});

const installApi = (locale: ResolvedLocale): void => {
  Object.defineProperty(window, 'deskpet', { value: api(locale), configurable: true });
};

it('offers model expressions and a generic action for models with undeclared optional assets', async () => {
  installApi('en');
  vi.spyOn(window.deskpet.character, 'setExpression').mockResolvedValue(undefined);
  vi.spyOn(window.deskpet.character, 'getState').mockResolvedValue({ ...character, coreState: 'ready', modelState: 'ready', modelName: 'Kitty', expressions: ['Watermark'] });
  render(<ConsoleApp />);
  await screen.findByRole('navigation');
  fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Companion' }));
  fireEvent.change(screen.getByLabelText('Model expression'), { target: { value: 'Watermark' } });
  expect(window.deskpet.character.setExpression).toHaveBeenCalledWith('Watermark');
  fireEvent.click(screen.getByRole('button', { name: 'Play model action' }));
  expect(window.deskpet.character.playAction).toHaveBeenCalledWith('interact');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const sessionId = '01234567-89ab-4def-8123-456789abcdef';
const assistantId = '11234567-89ab-4def-8123-456789abcdef';
const runId = '21234567-89ab-4def-8123-456789abcdef';
const timestamp = '2026-10-20T00:00:00Z';
const chatMessage = (role: ChatMessage['role'], content: string): ChatMessage => ({
  id: role === 'assistant' ? assistantId : crypto.randomUUID(), sessionId, role, content,
  createdAt: timestamp, status: role === 'assistant' ? 'streaming' : 'complete', errorCode: null,
});
const chatFixture = (locale: ResolvedLocale = 'en') => {
  installApi(locale);
  const api = window.deskpet;
  let listener: ((event: ChatEvent) => void) | undefined;
  const persisted: ChatMessage[] = [];
  vi.spyOn(api.providers, 'list').mockResolvedValue([{
    id: crypto.randomUUID(), kind: 'ollama', name: 'Fixture', baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'fixture', enabled: true, supportsTools: true, secretState: 'missing',
  }]);
  vi.spyOn(api.chat, 'listSessions').mockResolvedValue([{ id: sessionId, title: 'Existing chat', kind: 'normal', createdAt: timestamp, updatedAt: timestamp }]);
  vi.spyOn(api.chat, 'listMessages').mockImplementation(async () => structuredClone(persisted));
  vi.spyOn(api.chat, 'onEvent').mockImplementation((callback) => { listener = callback; return () => { listener = undefined; }; });
  const emit = (event: ChatEvent): void => { listener?.(event); };
  vi.spyOn(api.chat, 'send').mockImplementation(async ({ content }) => {
    persisted.push(chatMessage('user', content), chatMessage('assistant', ''));
    emit({ type: 'started', runId, sessionId, messageId: assistantId });
    return { runId };
  });
  return { api, emit, persisted };
};

const openChat = async (locale: ResolvedLocale = 'en'): Promise<void> => {
  render(<ConsoleApp />);
  await screen.findByRole('navigation');
  fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: locale === 'en' ? 'Chat' : '聊天' }));
  await act(async () => undefined);
};

it('shows an active WeChat transcript as plain text and refreshes it without a desktop composer', async () => {
  const f = chatFixture();
  vi.mocked(f.api.chat.listSessions).mockResolvedValue([{
    id: sessionId, title: 'WeChat group · Fixture group', kind: 'normal', createdAt: timestamp, updatedAt: timestamp,
    channelBindingId: crypto.randomUUID(), wechatTranscript: 'group', historyPrivacy: 'local-only',
  }]);
  const listeners = new Set<() => void>();
  vi.spyOn(f.api.chat, 'onSessionsChanged').mockImplementation(listener => {
    listeners.add(listener); return () => { listeners.delete(listener); };
  });
  f.persisted.push({ ...chatMessage('user', 'Message from WeChat'), wechatSender: 'Fixture member' });
  await openChat();
  // Channel conversations open only when chosen; they never become the default chat.
  expect(screen.queryByRole('heading', { name: 'WeChat group · Fixture group' })).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: /Channels/u }));
  fireEvent.click(await screen.findByRole('button', { name: 'WeChat group · Fixture group' }));
  await screen.findByRole('heading', { name: 'WeChat group · Fixture group' });
  expect(await screen.findByText('Fixture member')).toBeVisible();
  expect(screen.getByText('This is a read-only copy of the WeChat conversation.')).toBeVisible();
  expect(screen.queryByRole('textbox', { name: 'Message your companion…' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Delegate text task' })).toBeDisabled();
  await act(async () => {
    f.persisted.push({ ...chatMessage('assistant', '[visible](https://example.com)'), status: 'complete' });
    listeners.forEach(listener => listener());
  });
  expect(await screen.findByText('[visible](https://example.com)')).toBeVisible();
  expect(screen.queryByRole('link', { name: 'visible' })).toBeNull();
});

describe('memory search conversation bridge', () => {
  const withRecall = () => {
    const f = chatFixture();
    f.api.memoryRecall = { search: vi.fn<NonNullable<DeskPetApi['memoryRecall']>['search']>(async input => ({ query: input.query, mode: 'semantic', reason: 'ready', consideredCount: 1, eligibleCount: 1,
      matches: [{ id: crypto.randomUUID(), revision: 1, text: 'PRIVATE_MATCH_NOT_A_USER_PROMPT', tags: [], privacy: 'local-only', sourceCount: 1, similarity: 0.95 }] })),
    cancel: vi.fn(async () => undefined) };
    return f;
  };
  const searchMemory = async () => {
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Memory' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'What you remember' }), { target: { value: 'Which walking route suits me?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search on this device' }));
    await screen.findByText('PRIVATE_MATCH_NOT_A_USER_PROMPT');
  };

  it('fills the same conversation with the exact question while preserving memory privacy and manual sending', async () => {
    const f = withRecall(); await openChat(); await searchMemory();
    expect(screen.getByText(/specific to “Existing chat”/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue with this question' }));
    expect(screen.getByRole('textbox', { name: 'Message your companion…' })).toHaveValue('Which walking route suits me?');
    expect(f.api.chat.send).not.toHaveBeenCalled();
    expect(f.api.chat.createSession).not.toHaveBeenCalled();
    expect(screen.queryByText('PRIVATE_MATCH_NOT_A_USER_PROMPT')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(f.api.chat.send).toHaveBeenCalledWith(expect.objectContaining({ sessionId, content: 'Which walking route suits me?' })));
  });

  it('preserves an unsent draft until the user explicitly clears it and inserts the recalled question', async () => {
    const f = withRecall(); await openChat();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message your companion…' }), { target: { value: 'Keep this unfinished draft.' } });
    await searchMemory(); fireEvent.click(screen.getByRole('button', { name: 'Continue with this question' }));
    const composer = screen.getByRole('textbox', { name: 'Message your companion…' });
    expect(composer).toHaveValue('Keep this unfinished draft.');
    expect(screen.getByRole('button', { name: 'Insert search question' })).toBeDisabled();
    fireEvent.change(composer, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Insert search question' }));
    expect(composer).toHaveValue('Which walking route suits me?');
    expect(f.api.chat.send).not.toHaveBeenCalled();
  });

  it.each(['archived', 'channel', 'analysis'] as const)('searches only general memories from a selected %s session', async kind => {
    const f = withRecall();
    vi.mocked(f.api.chat.listSessions).mockResolvedValue([{ id: sessionId, title: 'Unsuitable session', kind: 'normal', createdAt: timestamp, updatedAt: timestamp,
      ...(kind === 'archived' ? { archivedAt: timestamp } : kind === 'channel' ? { channelBindingId: crypto.randomUUID() } : { analysisSource: 'rea-static' }) }]);
    await openChat();
    if (kind === 'channel') { fireEvent.click(await screen.findByRole('button', { name: /Channels/u })); fireEvent.click(await screen.findByRole('button', { name: 'Unsuitable session' })); }
    await searchMemory();
    expect(vi.mocked(f.api.memoryRecall!.search).mock.calls[0]![0]).not.toHaveProperty('sessionId');
    expect(screen.queryByRole('button', { name: 'Continue with this question' })).toBeNull();
  });

  it('searches without creating a conversation when none exists', async () => {
    const f = withRecall(); vi.mocked(f.api.chat.listSessions).mockResolvedValue([]);
    await openChat(); await searchMemory();
    expect(f.api.chat.createSession).not.toHaveBeenCalled();
    expect(vi.mocked(f.api.memoryRecall!.search).mock.calls[0]![0]).not.toHaveProperty('sessionId');
  });

  it('keeps the search-to-chat action disabled while a conversation is running', async () => {
    const f = withRecall(); await openChat(); sendQuestion();
    await screen.findByRole('button', { name: 'Stop' }); await searchMemory();
    expect(screen.getByRole('button', { name: 'Continue with this question' })).toBeDisabled();
    expect(f.api.chat.send).toHaveBeenCalledOnce();
  });
});
const sendQuestion = (): void => {
  fireEvent.change(screen.getByRole('textbox', { name: 'Message your companion…' }), { target: { value: 'Synthetic question' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
};

const interactionState = (patch: Partial<ChatInteractionState> = {}): ChatInteractionState => ({
  runId, sessionId, messageId: assistantId, acceptingFollowups: true, canFollowup: true, queuedFollowups: 0,
  approval: null, progress: { phase: 'thinking' }, ...patch,
});
const approvalRequest = (patch: Partial<ChatApprovalRequest> = {}): ChatApprovalRequest => ({
  id: crypto.randomUUID(), runId, sessionId, messageId: assistantId, toolId: 'workspace.write', capabilityId: 'workspace.write',
  titleCode: 'Synthetic file write', detailCode: 'Write the selected local output file.', risk: 'medium',
  inputPreview: '{"path":"synthetic-report.txt","content":"<script>not executable</script>"}', inputTruncated: true,
  expiresAt: new Date(Date.now() + 60_000).toISOString(), allowRun: false, ...patch,
});

describe('active chat instructions and one-time approval', () => {
  it('keeps Stop separate, sends Enter as an instruction, and inserts it once before the assistant', async () => {
    const { api, emit, persisted } = chatFixture(); await openChat(); sendQuestion();
    await screen.findByRole('button', { name: 'Stop' });
    const state = interactionState();
    act(() => emit({ type: 'interaction', state }));
    const followup = { ...chatMessage('user', 'Only use official sources'), followupToMessageId: assistantId };
    vi.spyOn(api.chat, 'followup').mockImplementation(async () => {
      emit({ type: 'followup', runId, sessionId, messageId: assistantId, message: followup });
      emit({ type: 'interaction', state: { ...state, queuedFollowups: 1 } });
      return followup;
    });
    const composer = screen.getByRole('textbox', { name: 'Message your companion…' });
    fireEvent.change(composer, { target: { value: followup.content } });
    expect(screen.getByRole('button', { name: 'Add instruction' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(composer).toHaveValue(''));
    expect(api.chat.send).toHaveBeenCalledOnce(); expect(api.chat.cancel).not.toHaveBeenCalled();
    expect(screen.getAllByText(followup.content)).toHaveLength(1);
    expect(screen.getByText('Synthetic question')).toBeInTheDocument();
    expect(screen.getByText(followup.content).closest('article')!.nextElementSibling).toHaveClass('assistant');
    expect(screen.getByText(/Received; will apply at the next step/u)).toBeInTheDocument();
    act(() => emit({ type: 'interaction', state: { ...state, queuedFollowups: 0 } }));
    expect(screen.queryByText(/Received; will apply at the next step/u)).not.toBeInTheDocument();
    act(() => emit({ type: 'finished', runId, message: { ...persisted[1]!, status: 'complete', content: 'Done' } }));
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
  });

  it('preserves a failed instruction draft and reuses the operation id when retrying', async () => {
    const { api, emit } = chatFixture(); await openChat(); sendQuestion();
    await screen.findByRole('button', { name: 'Stop' });
    const state = interactionState(); act(() => emit({ type: 'interaction', state }));
    vi.spyOn(api.chat, 'getInteraction').mockResolvedValue(state);
    vi.spyOn(api.chat, 'followup').mockRejectedValueOnce(new Error('Synthetic IPC failure')).mockResolvedValueOnce({ ...chatMessage('user', 'Keep the examples short'), followupToMessageId: assistantId });
    const composer = screen.getByRole('textbox', { name: 'Message your companion…' });
    fireEvent.change(composer, { target: { value: 'Keep the examples short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add instruction' }));
    await screen.findByText(/Receipt could not be confirmed/u);
    expect(composer).toHaveValue('Keep the examples short');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add instruction' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Add instruction' }));
    await waitFor(() => expect(composer).toHaveValue(''));
    const calls = vi.mocked(api.chat.followup).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]![0].operationId).toBe(calls[0]![0].operationId);
    expect(calls[0]![0]).toMatchObject({ runId, sessionId, content: 'Keep the examples short' });
    expect(api.chat.send).toHaveBeenCalledOnce();
  });

  it('preserves a late instruction without starting a new task when the active run has ended', async () => {
    const { api, emit } = chatFixture(); await openChat(); sendQuestion();
    await screen.findByRole('button', { name: 'Stop' });
    act(() => emit({ type: 'interaction', state: interactionState() }));
    vi.spyOn(api.chat, 'followup').mockRejectedValue(new Error('chat.followupUnavailable'));
    const composer = screen.getByRole('textbox', { name: 'Message your companion…' });
    fireEvent.change(composer, { target: { value: 'A late clarification' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add instruction' }));
    await screen.findByText(/This run has ended or cannot accept/u);
    await screen.findByRole('button', { name: 'Send' });
    expect(composer).toHaveValue('A late clarification');
    expect(api.chat.send).toHaveBeenCalledOnce();
    expect(api.chat.cancel).not.toHaveBeenCalled();
  });

  it('offers a task-long approval only when the host allows it, and names the disclosure recipient', async () => {
    const { api, persisted } = chatFixture();
    const approval = approvalRequest({ allowRun: true, toolId: 'workspace.read', capabilityId: 'workspace.read', disclosure: { providerName: 'Synthetic cloud', model: 'alpha-1', destination: 'remote' } });
    persisted.push(chatMessage('user', 'Summarize my file'), chatMessage('assistant', ''));
    vi.spyOn(api.chat, 'getInteraction').mockResolvedValue(interactionState({ approval, progress: { phase: 'awaiting-approval' } }));
    vi.spyOn(api.chat, 'resolveApproval').mockResolvedValue(undefined);
    await openChat();
    expect(await screen.findByRole('note')).toHaveTextContent('sent to alpha-1 on "Synthetic cloud"');
    fireEvent.click(screen.getByRole('button', { name: 'Allow for this task' }));
    await waitFor(() => expect(api.chat.resolveApproval).toHaveBeenCalledExactlyOnceWith({ runId, sessionId, approvalId: approval.id, decision: 'allow-run' }));
  });

  it('shows no task-long choice or disclosure on an ordinary once-only approval', async () => {
    const { api, persisted } = chatFixture();
    persisted.push(chatMessage('user', 'Set this up'), chatMessage('assistant', ''));
    vi.spyOn(api.chat, 'getInteraction').mockResolvedValue(interactionState({ approval: approvalRequest(), progress: { phase: 'awaiting-approval' } }));
    await openChat();
    expect(await screen.findByRole('button', { name: 'Allow once' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Allow for this task' })).not.toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it.each(['allow-once', 'deny'] as const)('restores an approval on reload and submits only the explicit %s decision', async decision => {
    const { api, emit, persisted } = chatFixture();
    const approval = approvalRequest();
    persisted.push(chatMessage('user', 'Save this report'), chatMessage('assistant', ''));
    const state = interactionState({ approval, progress: { phase: 'awaiting-approval' } });
    vi.spyOn(api.chat, 'getInteraction').mockResolvedValue(state);
    vi.spyOn(api.chat, 'resolveApproval').mockImplementation(async () => {
      emit({ type: 'interaction', state: { ...state, approval: null, progress: { phase: 'tool', toolId: 'workspace.write' } } });
    });
    await openChat();
    expect(await screen.findByRole('button', { name: 'Stop' })).toBeEnabled();
    expect(screen.getByText('The parameter preview is truncated.')).toBeInTheDocument();
    expect(screen.getByText(approval.inputPreview)).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    expect(api.chat.resolveApproval).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: decision === 'allow-once' ? 'Allow once' : 'Deny' }));
    await waitFor(() => expect(api.chat.resolveApproval).toHaveBeenCalledExactlyOnceWith({ runId, sessionId, approvalId: approval.id, decision }));
    expect(api.permissions.request).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'This step needs your approval' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
  });

  it('keeps a delayed restored approval in view after the saved messages load', async () => {
    const { api, persisted } = chatFixture();
    persisted.push(chatMessage('user', 'Save this report'), chatMessage('assistant', ''));
    let restore!: (value: ChatInteractionState) => void;
    vi.spyOn(api.chat, 'getInteraction').mockImplementation(() => new Promise(resolve => { restore = resolve; }));
    await openChat();
    const list = document.querySelector<HTMLElement>('.message-list')!;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => list.querySelector('.chat-approval') ? 1_000 : 600 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 300 });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('message-list')) return new window.DOMRect(0, 80, 600, 304);
      // Following a restored request receipt to the absolute bottom would
      // place this pending decision's heading above the transcript viewport.
      if (this.classList.contains('chat-approval')) return new window.DOMRect(0, 49, 600, 272);
      return new window.DOMRect();
    });
    list.scrollTop = 300;
    await act(async () => restore(interactionState({ approval: approvalRequest(), progress: { phase: 'awaiting-approval' } })));
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeEnabled();
    expect(list.scrollTop).toBe(969);
    expect(api.chat.resolveApproval).not.toHaveBeenCalled();
  });

  it.each([
    ['en', 'chat.approvalDenied', 'This operation was declined. You can change your request and try again.'],
    ['en', 'chat.approvalExpired', 'The approval request expired. You can retry the task.'],
    ['zh-CN', 'chat.approvalDenied', '已拒绝本次操作。可以修改要求后重试。'],
    ['zh-CN', 'chat.approvalExpired', '确认请求已过期，可以重试任务。'],
  ] as const)('explains %s %s without directing a one-time decision to saved permissions', async (locale, errorCode, copy) => {
    const { api, persisted } = chatFixture(locale);
    persisted.push(chatMessage('user', 'Save this report'), { ...chatMessage('assistant', ''), status: 'failed', errorCode });
    await openChat(locale);
    expect(await screen.findByRole('alert')).toHaveTextContent(copy);
    expect(screen.queryByRole('button', { name: locale === 'en' ? 'Open permissions' : '打开权限设置' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: locale === 'en' ? 'Retry' : '重试' })).toBeEnabled();
    expect(api.permissions.request).not.toHaveBeenCalled();
    expect(api.chat.retry).not.toHaveBeenCalled();
  });

  it('keeps the latest reply in view on resize without moving a reader who scrolled up', async () => {
    const callbacks: Array<() => void> = [];
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { callbacks.push(callback); }
      observe = vi.fn();
      disconnect = disconnect;
    });
    const { persisted } = chatFixture();
    persisted.push(chatMessage('user', 'Read this long reply'), { ...chatMessage('assistant', 'Saved long reply'), status: 'complete' });
    await openChat();
    const list = document.querySelector<HTMLElement>('.message-list')!;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1_000 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 300 });
    list.scrollTop = 700; fireEvent.scroll(list);
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 200 });
    act(() => callbacks.forEach(callback => callback()));
    expect(list.scrollTop).toBe(1_000);
    list.scrollTop = 250; fireEvent.scroll(list);
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 180 });
    act(() => callbacks.forEach(callback => callback()));
    expect(list.scrollTop).toBe(250);
    cleanup();
    expect(disconnect).toHaveBeenCalled();
  });

  it('does not approve an expired request or restore a finished run from a late snapshot', async () => {
    const { api, emit, persisted } = chatFixture();
    persisted.push(chatMessage('user', 'Synthetic question'), chatMessage('assistant', ''));
    let resolveSnapshot!: (value: ChatInteractionState) => void;
    vi.spyOn(api.chat, 'getInteraction').mockImplementation(() => new Promise(resolve => { resolveSnapshot = resolve; }));
    await openChat();
    const state = interactionState({ approval: approvalRequest({ expiresAt: new Date(Date.now() - 1_000).toISOString() }), progress: { phase: 'awaiting-approval' } });
    act(() => { emit({ type: 'started', runId, sessionId, messageId: assistantId }); emit({ type: 'interaction', state }); });
    expect(screen.getByText(/This request expired or its task ended/u)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow once' })).not.toBeInTheDocument();
    act(() => emit({ type: 'finished', runId, message: { ...persisted[1]!, status: 'cancelled' } }));
    await act(async () => { resolveSnapshot({ ...state, approval: approvalRequest() }); });
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow once' })).not.toBeInTheDocument();
    expect(api.chat.resolveApproval).not.toHaveBeenCalled();
  });

  it('blocks new sends while restoration failed and recovers after an explicit retry', async () => {
    const { api } = chatFixture();
    vi.spyOn(api.chat, 'getInteraction').mockRejectedValueOnce(new Error('Synthetic read failure')).mockResolvedValue(null);
    await openChat();
    await screen.findByText(/The current task could not be restored/u);
    fireEvent.change(screen.getByRole('textbox', { name: 'Message your companion…' }), { target: { value: 'Safe new request' } });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    expect(api.chat.send).not.toHaveBeenCalled();
  });
});

describe('chat interaction regressions', () => {
  it('shows actual search, reading and answer phases even after partial text, then clears on completion', async () => {
    const { emit, persisted } = chatFixture(); await openChat(); sendQuestion();
    await screen.findByRole('button', { name: 'Stop' });
    expect(screen.getByRole('status')).toHaveTextContent('Thinking');
    await act(async () => { emit({ type: 'progress', runId, messageId: assistantId, progress: { phase: 'tool', toolId: 'web.search' } }); });
    expect(screen.getByRole('status')).toHaveTextContent('Searching the web');
    await act(async () => { emit({ type: 'delta', runId, messageId: assistantId, text: 'Found it.' }); });
    await screen.findByText('Found it.');
    await act(async () => { emit({ type: 'progress', runId, messageId: assistantId, progress: { phase: 'tool', toolId: 'web.read' } }); });
    expect(screen.getByRole('status')).toHaveTextContent('Reading the webpage');
    expect(screen.getByText('Found it.')).toBeInTheDocument();
    await act(async () => { emit({ type: 'progress', runId, messageId: assistantId, progress: { phase: 'composing' } }); });
    expect(screen.getByRole('status')).toHaveTextContent('Preparing an answer');
    await act(async () => { emit({ type: 'finished', runId, message: { ...persisted[1] as ChatMessage, content: 'Found it.', status: 'complete' } }); });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await act(async () => { emit({ type: 'progress', runId, messageId: assistantId, progress: { phase: 'tool', toolId: 'web.search' } }); });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
  it('keeps a real chat subscribed while visiting another page and blocks session changes during a run', async () => {
    const { api, emit, persisted } = chatFixture();
    await openChat();
    sendQuestion();
    await screen.findByRole('button', { name: 'Stop' });
    expect(screen.getByRole('button', { name: 'Existing chat' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'New chat' })).toBeDisabled();
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Schedules' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Focus' }));
    await act(async () => {
      emit({ type: 'delta', runId, messageId: assistantId, text: 'A reply received while away' });
      emit({ type: 'finished', runId, message: { ...persisted[1] as ChatMessage, content: 'A reply received while away', status: 'complete' } });
    });
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Chat' }));
    expect(await screen.findByText('A reply received while away', {}, { timeout: 4_000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Existing chat' })).toBeEnabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message your companion…' }), { target: { value: 'Continue after returning' } });
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    expect(api.chat.onEvent).toHaveBeenCalledOnce();
  });

  it('shows text before completion in an existing session and preserves it when cancelled', async () => {
    const { api, emit, persisted } = chatFixture();
    vi.spyOn(api.chat, 'cancel').mockImplementation(async () => {
      emit({ type: 'finished', runId, message: { ...persisted[1] as ChatMessage, content: 'Partial answer', status: 'cancelled' } });
    });
    await openChat();
    sendQuestion();
    await screen.findByRole('button', { name: 'Stop' });
    expect(screen.getByRole('status')).toHaveTextContent('Thinking');
    await act(async () => { emit({ type: 'delta', runId, messageId: assistantId, text: 'Partial answer' }); });
    expect(await screen.findByText('Partial answer')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Writing a reply');
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await screen.findByRole('button', { name: 'Send' });
    expect(screen.getByText('Partial answer').closest('article')).toHaveAttribute('data-status', 'cancelled');
  });

  it('sends with Enter while preserving Shift+Enter and IME composition', async () => {
    const { api } = chatFixture();
    await openChat();
    const composer = screen.getByRole('textbox', { name: 'Message your companion…' });
    fireEvent.change(composer, { target: { value: '你好 Kitty' } });
    fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(composer, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(composer, { key: 'Enter', keyCode: 229 });
    expect(api.chat.send).not.toHaveBeenCalled();
    expect(composer).toHaveValue('你好 Kitty');
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(api.chat.send).toHaveBeenCalledOnce());
    expect(api.chat.send).toHaveBeenCalledWith(expect.objectContaining({ content: '你好 Kitty' }));
    expect(composer).toHaveValue('');
    fireEvent.change(composer, { target: { value: 'Wait for the current reply' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(api.chat.send).toHaveBeenCalledOnce();
    expect(api.chat.cancel).not.toHaveBeenCalled();
    expect(composer).toHaveValue('Wait for the current reply');
  });

  it('shows a trusted timer confirmation even when the model returns no text', async () => {
    const { emit, persisted } = chatFixture(); await openChat(); sendQuestion();
    await screen.findByRole('button', { name: 'Stop' });
    const receipt = { timerId: crypto.randomUUID(), label: 'Stretch', seconds: 180, dueAt: '2026-10-22T10:01:30Z', timeZone: 'Asia/Shanghai' };
    await act(async () => { emit({ type: 'timer-created', runId, messageId: assistantId, receipt }); });
    expect(screen.getByText('2026-10-22 18:01:30 (Asia/Shanghai, GMT+08:00)')).toBeInTheDocument();
    await act(async () => { emit({ type: 'finished', runId, message: { ...persisted[1] as ChatMessage, status: 'complete', content: '', timerReceipts: [receipt] } }); });
    expect(screen.getByText('Timer created: Stretch').closest('article')).toHaveAttribute('data-status', 'complete');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it.each([
    ['provider.budgetExceeded', 'An earlier version blocked this request'],
    ['provider.invalidRequestBudget', 'configured output allowance and safety margin'],
    ['provider.contextBudgetExceeded', 'complete tool results exceed'],
    ['tool.permission.timer.write', 'Creating timers is not allowed'],
    ['tool.invalidArguments', 'invalid tool parameters'],
    ['tool.unknown', 'unavailable tool'],
    ['tool.network', 'could not be reached'],
    ['tool.timeout', 'tool timed out'],
    ['tool.effectConflict', 'earlier attempt already performed'],
  ])('shows actionable tool error %s and keeps retry available', async (errorCode, detail) => {
    const { emit } = chatFixture(); await openChat(); sendQuestion();
    await screen.findByRole('button', { name: 'Stop' });
    await act(async () => { emit({ type: 'failed', runId, messageId: assistantId, errorCode }); });
    expect(screen.getByRole('alert')).toHaveTextContent(detail);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
    if (errorCode.startsWith('tool.permission')) {
      fireEvent.click(screen.getByRole('button', { name: 'Open permissions' }));
      expect(await screen.findByRole('heading', { name: 'Tool permissions' })).toBeInTheDocument();
    }
  });

  it('explains exhausted quota and releases the composer after a provider failure', async () => {
    const { api, emit } = chatFixture();
    await openChat();
    sendQuestion();
    await screen.findByRole('button', { name: 'Stop' });
    await act(async () => { emit({ type: 'failed', runId, messageId: assistantId, errorCode: 'provider.quota' }); });
    expect(screen.getByRole('alert')).toHaveTextContent('quota is exhausted');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await screen.findByRole('button', { name: 'Send' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Message your companion…' }), { target: { value: 'Try again' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message your companion…' }), { key: 'Enter' });
    await waitFor(() => expect(api.chat.send).toHaveBeenCalledTimes(2));
  });

  it('does not return to the running state when a provider finishes before send resolves', async () => {
    const { api, emit, persisted } = chatFixture();
    vi.spyOn(api.chat, 'send').mockImplementation(async ({ content }) => {
      const response = { ...chatMessage('assistant', 'Fast answer'), status: 'complete' as const };
      persisted.push(chatMessage('user', content), response);
      emit({ type: 'started', runId, sessionId, messageId: assistantId });
      emit({ type: 'delta', runId, messageId: assistantId, text: 'Fast answer' });
      emit({ type: 'finished', runId, message: response });
      return { runId };
    });
    await openChat();
    sendQuestion();
    await screen.findByText('Fast answer');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled());
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Fast answer')).toHaveLength(1);
  });

  it('keeps streamed text when an earlier history snapshot resolves late', async () => {
    const { api, emit } = chatFixture();
    let finishHistory: ((messages: ChatMessage[]) => void) | undefined;
    vi.spyOn(api.chat, 'listMessages').mockResolvedValueOnce([]).mockImplementationOnce(() => new Promise((resolve) => { finishHistory = resolve; }));
    await openChat();
    sendQuestion();
    await screen.findByRole('button', { name: 'Stop' });
    await act(async () => { emit({ type: 'delta', runId, messageId: assistantId, text: 'Visible stream' }); });
    await act(async () => { finishHistory?.([chatMessage('user', 'Synthetic question'), chatMessage('assistant', '')]); });
    expect(await screen.findByText('Visible stream')).toBeInTheDocument();
    await act(async () => { emit({ type: 'finished', runId, message: { ...chatMessage('assistant', 'Visible stream'), status: 'complete' } }); });
  });

  it('restores the draft and surfaces send failures instead of leaving an unhandled rejection', async () => {
    const { api } = chatFixture();
    vi.spyOn(api.chat, 'send').mockRejectedValue(new Error('Fixture request rejected'));
    await openChat();
    sendQuestion();
    await screen.findByRole('alert');
    expect(screen.getByRole('textbox', { name: 'Message your companion…' })).toHaveValue('Synthetic question');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
  });
});

describe('task and focus interaction regressions', () => {
  it('updates a task through the strict input contract without sending stored timestamps', async () => {
    installApi('en');
    let task: DeskTask = { id: crypto.randomUUID(), title: 'Ship the repair', notes: 'Keep this note', status: 'todo', dueAt: null, createdAt: timestamp, updatedAt: timestamp };
    vi.spyOn(window.deskpet.tasks, 'list').mockImplementation(async () => [task]);
    const upsert = vi.spyOn(window.deskpet.tasks, 'upsert').mockImplementation(async (input) => {
      const validated = taskInputSchema.parse(input);
      task = { ...task, ...validated };
      return task;
    });
    render(<ConsoleApp />);
    await screen.findByRole('navigation');
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Schedules' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Focus' }));
    fireEvent.click(screen.getByRole('checkbox', { name: task.title }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: task.title })).toBeChecked());
    await waitFor(() => expect(screen.getByRole('checkbox', { name: task.title })).toBeEnabled());
    expect(upsert).toHaveBeenCalledWith({ id: task.id, title: task.title, notes: task.notes, status: 'done', dueAt: null });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('rolls back optimistic task completion and reports a failed save', async () => {
    installApi('en');
    const task: DeskTask = { id: crypto.randomUUID(), title: 'Keep this task', notes: '', status: 'todo', dueAt: null, createdAt: timestamp, updatedAt: timestamp };
    vi.spyOn(window.deskpet.tasks, 'list').mockResolvedValue([task]);
    vi.spyOn(window.deskpet.tasks, 'upsert').mockRejectedValue(new Error('Synthetic write failure'));
    render(<ConsoleApp />);
    await screen.findByRole('navigation');
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Schedules' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Focus' }));
    fireEvent.click(screen.getByRole('checkbox', { name: task.title }));
    await screen.findByRole('alert');
    expect(screen.getByRole('checkbox', { name: task.title })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: task.title })).toBeEnabled();
  });

  it('refreshes the countdown while a focus is running', async () => {
    installApi('en');
    const focus = { id: crypto.randomUUID(), taskId: null, startedAt: timestamp, plannedSeconds: 60, elapsedSeconds: 0, status: 'running' as const };
    const getFocus = vi.spyOn(window.deskpet.tasks, 'getFocus').mockResolvedValue(focus);
    render(<ConsoleApp />);
    await screen.findByRole('navigation');
    vi.useFakeTimers();
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Schedules' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Focus' }));
    expect(screen.getByLabelText('Time remaining')).toHaveTextContent('01:00');
    getFocus.mockResolvedValue({ ...focus, elapsedSeconds: 7 });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByLabelText('Time remaining')).toHaveTextContent('00:53');
  });
});

describe('ConsoleApp', () => {
  it('renders English first-run setup and passes an automated accessibility scan', async () => {
    installApi('en');
    const { container } = render(<ConsoleApp />);
    expect(await screen.findByRole('navigation')).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Companion' }));
    expect(await screen.findByRole('heading', { name: 'Bring your companion to life' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose Cubism Core' })).toBeInTheDocument();
    expect((await axe(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  it('renders the same navigation and first-run flow in Simplified Chinese', async () => {
    installApi('zh-CN');
    render(<ConsoleApp />);
    expect(await screen.findByRole('navigation')).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: '陪伴' }));
    expect(await screen.findByRole('heading', { name: '让你的伙伴苏醒' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '选择 Cubism Core' })).toBeInTheDocument();
  });

  it('uses the resolved application locale for the Minecraft panel and chat status', async () => {
    installApi('zh-CN');
    window.deskpet.minecraftCompanion = {
      getState: vi.fn(async (): Promise<MinecraftCompanionSnapshot> => ({ ...initialMinecraftCompanionSnapshot(), connectionState: 'ready', runtimeState: 'ready' })),
      connect: vi.fn(), start: vi.fn(), cancel: vi.fn(), disconnect: vi.fn(), onChanged: on,
    };
    render(<ConsoleApp />);
    const navigation = await screen.findByRole('navigation');
    fireEvent.click(within(navigation).getByRole('button', { name: '聊天' }));
    const chatStatus = await screen.findByRole('complementary', { name: 'Minecraft 陪玩' });
    expect(chatStatus).toHaveTextContent('已就绪');
    fireEvent.click(within(chatStatus).getByRole('button', { name: '查看 Minecraft 配置' }));
    expect(await screen.findByRole('heading', { name: '一起玩 Minecraft' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Minecraft 陪玩' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '连接机器人' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '开始基础任务' })).toBeEnabled();
  });
});


it('moves REA out of ordinary chat into the Plugins settings tab', async () => {
  installApi('en');
  render(<ConsoleApp />);
  await screen.findByRole('navigation');
  expect(window.deskpet.plugins.getState).not.toHaveBeenCalled();
  expect(window.deskpet.rea.status).not.toHaveBeenCalled();
  expect(screen.queryByText('REA · Static app analysis')).not.toBeInTheDocument();
  fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Settings' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Plugins' }));
  await screen.findByRole('heading', { name: 'SearXNG + Crawl4AI' });
  expect(screen.getByRole('heading', { name: 'REA · Static app analysis' })).toBeInTheDocument();
  expect(window.deskpet.plugins.getState).toHaveBeenCalledOnce();
  expect(screen.queryByText('Skills and MCP servers')).not.toBeInTheDocument();
  expect(window.deskpet.plugins.extensions.state).not.toHaveBeenCalled();
});

it.each([
  { locale: 'en' as const, settings: 'Settings', skills: 'Skills', mcp: 'MCP servers', install: 'Install skill from folder', add: 'Add server' },
  { locale: 'zh-CN' as const, settings: '设置', skills: '技能', mcp: 'MCP 服务', install: '从目录安装技能', add: '添加服务' },
])('opens separate skill and MCP settings directly in $locale', async ({ locale, settings, skills, mcp, install, add }) => {
  installApi(locale);
  render(<ConsoleApp />);
  await screen.findByRole('navigation');
  fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: settings }));
  fireEvent.click(screen.getByRole('tab', { name: skills }));
  expect(await screen.findByRole('button', { name: install })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: add })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: mcp }));
  expect(await screen.findByRole('button', { name: add })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: install })).not.toBeInTheDocument();
  expect(window.deskpet.plugins.extensions.state).toHaveBeenCalledTimes(2);
  expect(window.deskpet.plugins.getState).not.toHaveBeenCalled();
  expect(window.deskpet.rea.status).not.toHaveBeenCalled();
});

it('restores the stop control when opening a reply started by an independent plugin workspace', async () => {
  const fixture = chatFixture();
  const analysisId = '00000000-0000-4000-8000-000000000099';
  vi.spyOn(fixture.api.chat, 'listSessions').mockResolvedValue([
    { id: sessionId, title: 'Existing chat', kind: 'normal', createdAt: timestamp, updatedAt: timestamp },
    { id: analysisId, title: 'REA workbench', kind: 'normal', createdAt: timestamp, updatedAt: timestamp },
  ]);
  vi.spyOn(fixture.api.chat, 'cancel').mockResolvedValue(undefined);
  vi.spyOn(fixture.api.chat, 'getInteraction').mockImplementation(async id => id === analysisId ? interactionState({ sessionId: analysisId }) : null);
  await openChat();
  fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Settings' }));
  act(() => fixture.emit({ type: 'started', sessionId: analysisId, runId, messageId: assistantId }));
  fireEvent.click(screen.getByRole('button', { name: /^REA workbench$/u }));
  const stop = await screen.findByRole('button', { name: 'Stop' });
  fireEvent.click(stop);
  expect(fixture.api.chat.cancel).toHaveBeenCalledExactlyOnceWith(runId);
});

describe('console layout', () => {
  it('keeps channel conversations out of the recent list until the channel group is opened', async () => {
    installApi('en');
    vi.spyOn(window.deskpet.chat, 'listSessions').mockResolvedValue([
      { id: crypto.randomUUID(), title: 'My own chat', kind: 'normal', createdAt: timestamp, updatedAt: timestamp },
      { id: crypto.randomUUID(), title: 'WeChat private', kind: 'normal', createdAt: timestamp, updatedAt: timestamp, wechatTranscript: 'private' },
      { id: crypto.randomUUID(), title: 'QQ chat', kind: 'normal', createdAt: timestamp, updatedAt: timestamp, channelBindingId: crypto.randomUUID() },
      { id: crypto.randomUUID(), title: 'Event check-ins', kind: 'normal', createdAt: timestamp, updatedAt: timestamp },
    ]);
    render(<ConsoleApp />);
    const navigation = await screen.findByRole('navigation');
    expect(await within(navigation).findByRole('button', { name: 'My own chat' })).toBeInTheDocument();
    expect(within(navigation).queryByRole('button', { name: 'WeChat private' })).not.toBeInTheDocument();
    const toggle = within(navigation).getByRole('button', { name: /Channels/u });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    for (const title of ['WeChat private', 'QQ chat', 'Event check-ins']) expect(within(navigation).getByRole('button', { name: title })).toBeInTheDocument();
  });

  it('gathers her settings on the companion page and groups the rest of settings', async () => {
    installApi('en');
    render(<ConsoleApp />);
    const navigation = await screen.findByRole('navigation');
    fireEvent.click(within(navigation).getByRole('button', { name: 'Settings' }));
    expect(screen.queryByRole('tab', { name: 'Persona' })).not.toBeInTheDocument();
    expect(screen.getByText('Channels', { selector: '.settings-tab-heading' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Permissions' })).toBeInTheDocument();
    expect(screen.queryByText(/check-in rules/u)).not.toBeInTheDocument();
    fireEvent.click(within(navigation).getByRole('button', { name: 'Companion' }));
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Look', 'Persona', 'Voice', 'Diary', 'Check-ins']);
    fireEvent.click(screen.getByRole('tab', { name: 'Check-ins' }));
    expect(screen.getAllByText('Advanced: check-in rules and records')).toHaveLength(1);
  });
});

it('offers cancel or restart when reopened while a prepared restore locks the page', async () => {
  const f = chatFixture();
  vi.mocked(f.api.app.getState).mockRejectedValue(new Error('backup.error.busy'));
  f.api.backup.getState = vi.fn(async () => ({ restorePrepared: true }));
  render(<ConsoleApp />);
  const cancel = await screen.findByRole('button', { name: 'Cancel restore' });
  expect(screen.getByRole('button', { name: 'Restart and restore' })).toBeVisible();
  fireEvent.click(cancel);
  expect(f.api.backup.cancelRestore).toHaveBeenCalledOnce();
});
