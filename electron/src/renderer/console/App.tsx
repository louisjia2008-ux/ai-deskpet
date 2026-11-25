import type { ResolvedLocale } from '../../shared';
import { MemorySleepPanel } from './MemorySleepPanel';
import { MicrophoneButton } from './MicrophoneButton';
import { CompanionJournalSettings } from './CompanionJournalSettings';
import { MinecraftCompanionChatStatus } from './MinecraftCompanionPanel';
import { MemoryConsolidation } from './MemoryConsolidation';
import { Delegations } from './Delegations';
import { parseDelegationCommand } from '../../shared/delegations';
import type { DelegationDraft } from '../../shared/delegations';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ComponentRef, FormEvent, JSX, ReactNode } from 'react';

import type {
  AppState,
  CharacterState,
  ChatMessage,
  ChatProgress,
  ChatInteractionState,
  ChatApprovalDecision,
  ChatApprovalRequest,
  ChatSession,
  DeskTask,
  DiagnosticSnapshot,
  MemoryItem,
  MigrationPreview,
  MigrationResult,
  ImportProgress,
  PlatformCapability,
  ProviderConfig,
  StartupRecoveryState,
} from '../../shared';
import { messages } from '../../shared';
import type { MessageKey } from '../../shared';
import { MemoryRecallPanel } from './MemoryRecallPanel';
import { ResearchTasks } from './ResearchTasks';
import { BackgroundJobs } from './BackgroundJobs';
import { CodingTasks } from './CodingTasks';
import { MinecraftPage } from './MinecraftPage';
import { MinecraftDedicatedSettings, MinecraftDedicatedStatus } from './MinecraftDedicatedPanel';
import { ArrowUp, Bell, BookOpen, CalendarDots, CaretRight, Check, TreeStructure, ChatCircleDots, ClockCounterClockwise, Copy, GearSix, ListChecks, MagnifyingGlass, PushPin, SidebarSimple, Plus, Sparkle, Square, Toolbox } from '@phosphor-icons/react';
import { ChatReply } from './ChatReply';
import { MediaLibraryPage } from './MediaLibraryPage';
import { ChatImages } from './ChatImages';
import { PluginsSettings } from './PluginsSettings';
import { DesktopExtensionsPanel } from './DesktopExtensionsPanel';
import { routingDestination } from '../../shared/model-routing';
import { KnowledgeSettings } from './KnowledgeSettings';
import { CompanionRecentPanel } from './CompanionRecentPanel';
import { AutoMemoryToggle } from './AutoMemoryToggle';
import { SandboxSettings } from './SandboxSettings';
import { TelegramSettings } from './TelegramSettings';
import { QqSettings } from './QqSettings';
import { WeChatSettings } from './WeChatSettings';
import { WeChatInboxPanel } from './WeChatInboxPanel';
import { WeChatGroupDigestResults } from './WeChatGroupDigests';
import { WeChatFollowupList } from './WeChatFollowup';
import { ChatModelPicker } from './ChatModelPicker';
import { ChatCapabilitySummary } from './ChatCapabilitySummary';
import { ChatMemoryForget } from './ChatMemoryForget';
import { ChatMemoryEdit } from './ChatMemoryEdit';
import { MemoryContextControls } from './MemoryContextControls';
import { ChatWorkPanel } from './ChatWorkPanel';
import { ArtifactsPanel, artifactContinuationPrompt } from './ArtifactsPanel';
import type { ChatArtifactReference } from '../../shared/chat-work';
import { PersonaSettings } from './PersonaSettings';
import { CharacterSheetSettings } from './CharacterSheetSettings';
import { VoiceSettings } from './VoiceSettings';
import { QuickSetup } from './QuickSetup';
import { CareSettings } from './CareSettings';
import { ConfirmButton } from './ConfirmButton';
import { HotkeyRecorder } from './HotkeyRecorder';
import { ChatContextReceipts } from './ChatContextReceipts';
import { ConversationImports } from './ConversationImports';
import { CharacterPreviewProvider, CompanionAvatar, CompanionPanel, LiveCompanion } from './CompanionPreview';
import { consoleCopy } from './console-copy';
import { chatInteractionCopy } from './chat-interaction-copy';
import { DataSettings, StartupSettings } from './DataSettings';
import { StartupRecovery } from './StartupRecovery';
import { EventProactiveSettings } from './EventProactiveSettings';
import { UsagePage } from './UsagePage';
import { AttentionCenter } from './AttentionCenter';
import { HealthPanel, useHealthIssues } from './HealthPanel';
import { DoctorPanel } from './DoctorPanel';
import type { HealthFeature } from '../../shared/attention';
import type { AttentionTarget } from '../../shared/attention';
import { ProviderSettings } from './ProviderSettings';
import { PermissionSettings } from './PermissionSettings';
import { PersistentSchedules } from './PersistentSchedules';
import { ScheduleOverview } from './ScheduleOverview';
import { TimerList } from './TimerList';
import { ConversationManager, ConversationMenu, useConversationActions } from './ConversationManagement';
import type { ConversationAction } from './ConversationManagement';
import { TOOL_FAILURE_KEYS } from '../../shared/tool-failures';
import { formatTimerDeadline } from '../../shared/timer-time';
import { useConsoleSnapshot } from './use-console-snapshot';
import type { ConsoleSnapshot as Snapshot } from './use-console-snapshot';
import { ActivityPage } from './ActivityPage';

type View = 'artifacts' | 'media' | 'attention' | 'health' | 'doctor' | 'usage' | 'jobs' | 'coding' | 'chat' | 'conversations' | 'companion' | 'minecraft' | 'focus' | 'memory' | 'schedules' | 'activity' | 'wechat-digests' | 'wechat-followup' | 'settings';
interface NavEntry { id: View; key?: MessageKey; label?: string; icon: JSX.Element; count?: number; group?: readonly View[] }
// Pages that share one sidebar entry and switch by tabs at the top of the page.
const GROUPS = {
  schedules: ['schedules', 'focus'],
  updates: ['attention', 'health', 'doctor', 'activity', 'wechat-digests', 'wechat-followup'],
  tools: ['jobs', 'coding', 'artifacts', 'media', 'usage', 'minecraft'],
} as const satisfies Record<string, readonly View[]>;
type Group = keyof typeof GROUPS;
const groupOf = (view: View): Group | undefined => (Object.keys(GROUPS) as Group[]).find(group => (GROUPS[group] as readonly View[]).includes(view));
type CompanionTab = 'look' | 'persona' | 'voice' | 'diary' | 'care';
// Conversations that arrive from elsewhere: kept out of the owner's own recent list.
const CHECK_IN_TITLES = new Set(['Event check-ins', '主动问候']);
const isChannelSession = (session: ChatSession): boolean => Boolean(session.wechatTranscript || session.channelBindingId) || CHECK_IN_TITLES.has(session.title);

export const ConsoleApp = (): JSX.Element => {
  const [recovery, setRecovery] = useState<StartupRecoveryState | null | undefined>();
  const [failed, setFailed] = useState(false);
  const check = useCallback(() => {
    setFailed(false);
    void window.deskpet.recovery.getState().then(setRecovery).catch(() => setFailed(true));
  }, []);
  useEffect(check, [check]);
  if (failed) return <main className="loading-state" role="alert">DeskPet <button type="button" onClick={check}>重试 / Retry</button></main>;
  if (recovery === undefined) return <main className="loading-state" aria-live="polite">DeskPet…</main>;
  return recovery === null ? <MainConsoleApp /> : <StartupRecovery state={recovery} />;
};

const MainConsoleApp = (): JSX.Element => {
  const { snapshot, error: snapshotError, refresh } = useConsoleSnapshot();
  const [view, setView] = useState<View>('chat');
  const [channelsOpen, setChannelsOpen] = useState(false);
  // Each group reopens on the tab last used there.
  const [lastTab, setLastTab] = useState<Record<Group, View>>({ schedules: 'schedules', updates: 'attention', tools: 'jobs' });
  useEffect(() => {
    const group = groupOf(view);
    if (group) setLastTab(current => ({ ...current, [group]: view }));
  }, [view]);
  const [companionTab, setCompanionTab] = useState<CompanionTab>('look');
  const [attentionTarget, setAttentionTarget] = useState<AttentionTarget | null>(null);
  const [attentionNavigationRevision, setAttentionNavigationRevision] = useState(0);
  const [attentionNavigationBlocked, setAttentionNavigationBlocked] = useState(false);
  useEffect(() => window.deskpet.attention.onOpenRequested(() => setView('attention')), []);
  const [settingsTab, setSettingsTab] = useState<SettingsEntry>('general');
  const [healthIssues, setHealthIssues] = useHealthIssues(window.deskpet.attention);
  const [selectedChat, setSelectedChat] = useState<string | null>(null);
  const [artifactDraftRequest, setArtifactDraftRequest] = useState<{ reference: ChatArtifactReference; revision: number } | null>(null);
  const [memoryDraftRequest, setMemoryDraftRequest] = useState<{ sessionId: string; query: string; revision: number } | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const [narrow, setNarrow] = useState(() => window.matchMedia?.('(max-width: 1100px)').matches ?? false);
  const [companionOpen, setCompanionOpen] = useState(() => !(window.matchMedia?.('(max-width: 1100px)').matches ?? false));
  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 1100px)');
    if (media === undefined) return;
    const change = (): void => { setNarrow(media.matches); setCompanionOpen(!media.matches); };
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  const [error, setError] = useState(false);
  // A restore prepared before this window opened keeps its cancel/restart decision available.
  const [restorePending, setRestorePending] = useState(false);
  useEffect(() => { if (snapshot === null && (error || snapshotError)) void window.deskpet.backup.getState?.().then(state => setRestorePending(state.restorePrepared)).catch(() => undefined); }, [snapshot, error, snapshotError]);
  // WeChat-only pages (digests, follow-ups) appear once the WeChat channel is set up.
  const [wechatConfigured, setWechatConfigured] = useState(false);
  useEffect(() => {
    let live = true;
    // Once seen as set up it stays shown this session: a failed probe must not make the WeChat pages vanish.
    const read = (): void => { void window.deskpet.wechat?.getState().then(state => { if (live && state.configured) setWechatConfigured(true); }).catch(() => undefined); };
    read(); window.addEventListener('focus', read);
    return () => { live = false; window.removeEventListener('focus', read); };
  }, []);

  const locale = snapshot?.app.resolvedLocale ?? (/^zh/iu.test(window.navigator.language) ? 'zh-CN' : 'en');
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  const t = useCallback((key: string): string => chatInteractionCopy[locale][key] ?? consoleCopy[locale][key] ?? messages[locale][key as MessageKey] ?? key, [locale]);
  const activeSessions = snapshot?.sessions.filter((session) => !session.archivedAt && !session.deletedAt) ?? [];
  const ownSessions = activeSessions.filter(session => !isChannelSession(session));
  const channelSessions = activeSessions.filter(isChannelSession);
  // Open on the owner's own latest chat; a channel conversation opens only when chosen.
  const activeSessionId = selectedChat ?? ownSessions[0]?.id ?? '';
  // Opening a channel conversation by other means reveals where it lives; the toggle stays free after that.
  const activeIsChannel = channelSessions.some(session => session.id === activeSessionId);
  useEffect(() => { if (activeIsChannel) setChannelsOpen(true); }, [activeIsChannel, activeSessionId]);
  const memorySession = activeSessions.find(session => session.id === activeSessionId && !session.channelBindingId && !session.analysisSource);
  useEffect(() => { if (selectedChat === null && activeSessionId) setSelectedChat(activeSessionId); }, [selectedChat, activeSessionId]);
  useEffect(() => window.deskpet.chat.onOpenRequested?.((sessionId) => {
    if (!chatBusy) { setSelectedChat(sessionId); setView('chat'); }
  }), [chatBusy]);
  const onConversationChanged = useCallback(async (session: ChatSession): Promise<void> => {
    if (session.id === activeSessionId && (session.deletedAt || session.archivedAt)) setSelectedChat('');
    await refresh();
  }, [activeSessionId, refresh]);
  const conversations = useConversationActions(t, onConversationChanged);
  const conversationBusy = chatBusy || conversations.pending !== null;
  const openAttentionTarget = (target: AttentionTarget): void => {
    if (target.sessionId && target.sessionId !== activeSessionId && conversationBusy) { setAttentionNavigationBlocked(true); return; }
    setAttentionNavigationBlocked(false); setAttentionTarget(target); setAttentionNavigationRevision(value => value + 1);
    if (target.sessionId) setSelectedChat(target.sessionId);
    setView(target.kind === 'background-job' ? 'jobs' : target.kind === 'delegation' ? 'chat' : 'memory');
  };

  if (snapshot === null && restorePending) {
    // The console was reopened while a restore waits; its page data is locked, but the decision is still here.
    const zhRestore = locale === 'zh-CN';
    return <main className="loading-state" role="alertdialog" aria-label={zhRestore ? '备份恢复已准备好' : 'Backup restore is ready'}>
      <p>{zhRestore ? '备份恢复已准备好。重启后生效；取消则保持当前数据。' : 'A backup restore is ready. It applies on restart; cancelling keeps your current data.'}</p>
      <div className="button-row"><button type="button" className="secondary" autoFocus onClick={() => void window.deskpet.backup.cancelRestore()}>{zhRestore ? '取消恢复' : 'Cancel restore'}</button>
        <button type="button" onClick={() => void window.deskpet.backup.restart()}>{zhRestore ? '重启并恢复' : 'Restart and restore'}</button></div>
    </main>;
  }
  if (snapshot === null) {
    return <main className="loading-state" aria-live="polite">{error || snapshotError ? <>{t('common.error')} <button type="button" onClick={() => { setError(false); void refresh(); }}>{t('common.retry')}</button></> : t('common.loading')}</main>;
  }

  const name = snapshot.relationship.nickname.trim() || snapshot.character.modelName || t('nav.companion');
  const selectChat = (id: string): void => { if (!conversationBusy) { setSelectedChat(id); setView('chat'); } };
  const continueArtifact = (reference: ChatArtifactReference): void => {
    if (conversationBusy) return;
    setSelectedChat(reference.sessionId); setView('chat');
    setArtifactDraftRequest(current => ({ reference, revision: (current?.revision ?? 0) + 1 }));
  };
  const continueMemoryQuery = (query: string): void => {
    if (conversationBusy || !memorySession) return;
    setMemoryDraftRequest(current => ({ sessionId: memorySession.id, query, revision: (current?.revision ?? 0) + 1 }));
    setView('chat');
  };
  const zh = locale === 'zh-CN', attentionCount = (snapshot.attention?.items.filter(item => item.kind !== 'notice').length ?? 0) + healthIssues;
  const digests = wechatConfigured ? window.deskpet.wechatDigests : undefined;
  const followup = wechatConfigured ? window.deskpet.wechatFollowup : undefined;
  const primary: NavEntry[] = [
    { id: 'chat', key: 'nav.chat', icon: <ChatCircleDots size={18} /> },
    { id: 'companion', label: snapshot.relationship.nickname.trim() || t('nav.companion'), icon: <Sparkle size={18} /> },
    { id: lastTab.schedules, label: zh ? '日程' : 'Schedules', icon: <CalendarDots size={18} />, group: GROUPS.schedules },
    { id: 'memory', key: 'nav.memory', icon: <BookOpen size={18} /> },
  ];
  const openMedia = (): void => {
    // Browsing images never creates a chat; one is created only when an image is put into a new conversation.
    setView('media');
  };
  const go = (next: View): void => {
    // A shortcut into one settings or companion tab applies once; the sidebar opens the first tab.
    if (next === 'settings') setSettingsTab('general');
    if (next === 'companion') setCompanionTab('look');
    if (next === 'media') openMedia(); else setView(next);
  };
  const openCompanion = (tab: CompanionTab): void => { setCompanionTab(tab); setView('companion'); };
  const openDedicatedSettings = (): void => { setSettingsTab('minecraft'); setView('settings'); };
  const openHealthFeature = (feature: HealthFeature): void => {
    if (feature === 'asr') openCompanion('voice');
    else if (feature === 'diary') openCompanion('diary');
    else if (feature === 'proactive') openCompanion('care');
    else if (feature === 'auto-memory' || feature === 'companion-recent' || feature === 'memory-sleep') setView('memory');
    else if (feature === 'schedules') setView('schedules');
    else if (feature === 'wechat-moments' || feature === 'wechat-cron' || feature === 'wechat-group-digest' || feature === 'wechat-official-brief' || feature === 'wechat-friends-moments' || feature === 'wechat-friend-reply' || feature === 'wechat-followup') { setSettingsTab('wechat'); setView('settings'); }
    else { setSettingsTab(feature); setView('settings'); }
  };
  const secondary: NavEntry[] = [
    { id: lastTab.updates, label: zh ? '动态' : 'Updates', icon: <Bell size={18} />, count: attentionCount, group: GROUPS.updates },
    { id: lastTab.tools, label: zh ? '工具' : 'Tools', icon: <Toolbox size={18} />, group: GROUPS.tools },
  ];
  const group = groupOf(view);
  const tabs: Array<{ id: View; label: string }> | null = group === 'schedules' ? [
    { id: 'schedules', label: t('nav.schedules') },
    { id: 'focus', label: t('nav.focus') },
  ] : group === 'updates' ? [
    { id: 'attention', label: zh ? '待处理' : 'To do' },
    { id: 'health', label: `${zh ? '运行状态' : 'Background status'}${healthIssues ? ` · ${healthIssues}` : ''}` },
    ...(window.deskpet.attention.doctor ? [{ id: 'doctor' as const, label: zh ? '医生' : 'Doctor' }] : []),
    { id: 'activity', label: t('nav.activity') },
    ...(digests ? [{ id: 'wechat-digests' as const, label: zh ? '群聊每日精华' : 'Daily group digests' }] : []),
    ...(followup ? [{ id: 'wechat-followup' as const, label: zh ? '群里 @ 你' : 'Group mentions' }] : []),
  ] : group === 'tools' ? [
    { id: 'jobs', label: zh ? '后台任务' : 'Background tasks' },
    ...(window.deskpet.coding ? [{ id: 'coding' as const, label: zh ? '代码任务' : 'Coding tasks' }] : []),
    { id: 'artifacts', label: zh ? '成果' : 'Artifacts' },
    { id: 'media', label: zh ? '表情图库' : 'Image library' },
    { id: 'usage', label: zh ? 'Token 与费用' : 'Tokens and cost' },
    { id: 'minecraft', label: t('nav.minecraft') },
  ] : null;
  const sessionRow = (session: ChatSession): JSX.Element => <div className="sidebar-session-row" key={session.id} data-session-id={session.id}>
    <button type="button" disabled={conversationBusy} className={activeSessionId === session.id && view === 'chat' ? 'session-item current' : 'session-item'} onClick={() => selectChat(session.id)} title={session.title}><span className="session-mark">{session.pinnedAt ? <PushPin size={12} weight="fill" aria-label={t('conversation.pinned')} /> : <span className="session-indicator" />}</span><span>{session.title}</span></button>
    <ConversationMenu session={session} disabled={conversationBusy} t={t} onAction={conversations.act} />
  </div>;
  const navButton = (item: NavEntry): JSX.Element => {
    const label = item.label ?? t(item.key!);
    const current = item.group ? item.group.includes(view) : view === item.id;
    return <button key={item.label ?? item.id} type="button" className={current ? 'nav-item active' : 'nav-item'} aria-label={label} title={label} aria-current={current ? 'page' : undefined} onClick={() => { if (!current) go(item.id); }}>{item.icon}<span>{label}</span>{item.count ? <strong>{item.count}</strong> : null}</button>;
  };
  return (
    <CharacterPreviewProvider state={snapshot.character} enabled={view === 'companion' || view === 'chat'}>
    <div className="app-shell" data-theme={snapshot.app.theme} data-frameless={/Macintosh/u.test(window.navigator.userAgent)}>
      <aside className="sidebar" aria-label="Primary navigation">
        <button type="button" className="brand" aria-label="DeskPet" onClick={() => setView('chat')}><CompanionAvatar name={name} /><strong>DeskPet</strong></button>
        <nav>
          <button type="button" className="new-chat-button" disabled={conversationBusy} aria-label={t('ui.newSession')} title={t('ui.newSession')} onClick={() => selectChat('')}><Plus size={15} weight="bold" /><span>{t('ui.newSession')}</span></button>
          <div className="primary-navigation">{primary.map(navButton)}</div>
          <div className="sidebar-session-heading"><span>{t('ui.recent')}</span><button type="button" className={view === 'conversations' ? 'icon-button active' : 'icon-button'} aria-label={t('conversation.manage')} title={t('conversation.manage')} aria-current={view === 'conversations' ? 'page' : undefined} onClick={() => setView('conversations')}><MagnifyingGlass size={14} /></button></div>
          <div className="sidebar-sessions">{ownSessions.slice(0, 8).map(sessionRow)}
            {channelSessions.length > 0 && <>
              <button type="button" className="channel-toggle" aria-expanded={channelsOpen} onClick={() => setChannelsOpen(!channelsOpen)}><span className="session-mark"><CaretRight className="channel-caret" size={12} /></span><span>{zh ? '渠道' : 'Channels'}</span><small>{channelSessions.length}</small></button>
              {channelsOpen && channelSessions.map(sessionRow)}
            </>}
          </div>
          <div className="sidebar-bottom">
            {secondary.map(navButton)}
            {navButton({ id: 'settings', key: 'nav.settings', icon: <GearSix size={18} /> })}
          </div>
        </nav>
      </aside>
      <main className="content" id="main-content">
        {(error || snapshotError) && <div className="error-banner app-error" role="alert">{t('common.error')} <button type="button" onClick={() => { setError(false); void refresh(); }}>{t('common.retry')}</button></div>}
        <div className="chat-view" hidden={view !== 'chat'}><MinecraftCompanionChatStatus locale={locale} onOpenConfiguration={() => setView('minecraft')} /><ChatPage memoryDraftRequest={memoryDraftRequest} artifactDraftRequest={artifactDraftRequest} onContinueArtifact={continueArtifact} snapshot={snapshot} t={t} refresh={refresh} sessionId={activeSessionId} selectSession={setSelectedChat} onBusyChange={setChatBusy} name={name} companionOpen={companionOpen} setCompanionOpen={setCompanionOpen} narrow={narrow} focusDelegationRevision={attentionNavigationRevision} focusDelegationId={attentionTarget?.kind === 'delegation' && attentionTarget.sessionId === activeSessionId ? attentionTarget.id : undefined} conversationBusy={conversationBusy} onConversationAction={conversations.act} managePermissions={() => { setSettingsTab('permissions'); setView('settings'); }} manageMemory={() => setView('memory')} manageMedia={openMedia} manageCompanion={() => { setCompanionOpen(!narrow); openCompanion('look'); }} /></div>
        {view !== 'chat' && <div className={tabs ? 'page-scroll grouped' : 'page-scroll'}>
        {group && <header className="page-header"><h1>{[...primary, ...secondary].find(item => item.group === GROUPS[group])?.label}</h1></header>}
        {tabs && <div className="memory-tabs page-tabs" role="tablist">{tabs.map(tab => <button key={tab.id} type="button" role="tab" aria-selected={view === tab.id} onClick={() => go(tab.id)}>{tab.label}</button>)}</div>}
        {view === 'artifacts' && <ArtifactsPanel api={window.deskpet.chatWork} locale={locale} navigationBusy={conversationBusy} onOpenSession={selectChat} onContinue={continueArtifact} />}
        {view === 'media' && <MediaLibraryPage api={window.deskpet.media} wechat={window.deskpet.wechat} providers={snapshot.providers} locale={locale} sessionId={activeSessionId} onAttached={() => setView(current => current === 'media' ? 'chat' : current)} createSession={conversationBusy ? undefined : async () => { const session = await window.deskpet.chat.createSession({ title: zh ? '图片对话' : 'Image conversation', kind: 'normal' }); setSelectedChat(session.id); await refresh(); return session.id; }}
          discardSession={async id => { await window.deskpet.chat.removeSession(id); setSelectedChat(''); await refresh(); }} />}
        {view === 'conversations' && <ConversationManager t={t} locale={locale} busy={conversationBusy} onSelect={selectChat} onAction={conversations.act} />}
        {view === 'companion' && <CompanionPage initialTab={companionTab} snapshot={snapshot} name={name} t={t} refresh={refresh} />}
        {view === 'minecraft' && <MinecraftPage locale={locale} t={t} onDedicatedSettings={openDedicatedSettings} />}
        {view === 'focus' && <FocusPage snapshot={snapshot} t={t} refresh={refresh} />}
        {view === 'memory' && <MemoryPage conversationBusy={conversationBusy} onUseQuery={continueMemoryQuery} currentSessionTitle={memorySession?.title ?? ''} items={snapshot.memories} t={t} refresh={refresh} providers={snapshot.providers} activeProviderId={snapshot.app.activeProviderId ?? null} openBatchId={attentionTarget?.kind === 'consolidation' && attentionTarget.sessionId === activeSessionId ? attentionTarget.id : undefined} currentSessionId={memorySession?.id ?? ''} locale={snapshot.app.resolvedLocale} onStartSession={async () => { if (conversationBusy) throw new Error('chat.busy'); const session = await window.deskpet.chat.createSession({ title: snapshot.app.resolvedLocale === 'zh-CN' ? '记忆审阅' : 'Memory review', kind: 'normal' }); setSelectedChat(session.id); await refresh(); }} />}
        {view === 'schedules' && <ScheduleOverview api={window.deskpet.chatWork} telegram={window.deskpet.telegram} qq={window.deskpet.qq} sessions={snapshot.sessions} locale={snapshot.app.resolvedLocale} onOpenSession={selectChat} timers={<TimerList t={t} />}><PersistentSchedules api={window.deskpet.automation} providers={snapshot.providers} locale={snapshot.app.resolvedLocale} /></ScheduleOverview>}
        {view === 'attention' && <>{attentionNavigationBlocked && <p role="alert">{locale === 'zh-CN' ? '请等待当前对话完成后再打开其他会话的结果。' : 'Wait for the current conversation to finish before opening another session.'}</p>}<AttentionCenter api={window.deskpet.attention} locale={locale} onOpen={openAttentionTarget} /></>}
        {view === 'usage' && <UsagePage api={window.deskpet.usage} providers={snapshot.providers} providerApi={window.deskpet.providers} locale={snapshot.app.resolvedLocale} />}
        {view === 'jobs' && <>{window.deskpet.research && <ResearchTasks api={window.deskpet.research} providers={snapshot.providers} locale={locale} onOpenSession={selectChat} />}<BackgroundJobs openJobId={attentionTarget?.kind === 'background-job' ? attentionTarget.id : undefined} providers={snapshot.providers} locale={snapshot.app.resolvedLocale} /></>}
        {view === 'coding' && window.deskpet.coding && <CodingTasks api={window.deskpet.coding} locale={locale} />}
        {view === 'activity' && <ActivityPage t={t} locale={locale} />}
        {view === 'wechat-digests' && digests && <WeChatGroupDigestResults api={digests} locale={locale} />}
        {view === 'wechat-followup' && followup && <WeChatFollowupList api={followup} locale={locale} />}
        {view === 'health' && <HealthPanel api={window.deskpet.attention} locale={locale} onOpen={openHealthFeature} onIssues={setHealthIssues}>
          {window.deskpet.minecraftDedicated && <MinecraftDedicatedStatus api={window.deskpet.minecraftDedicated} locale={locale} onSettings={openDedicatedSettings} />}
        </HealthPanel>}
        {view === 'doctor' && <DoctorPanel api={window.deskpet.attention} locale={locale} />}
        {view === 'settings' && <SettingsPage snapshot={snapshot} t={t} refresh={refresh} initialTab={settingsTab} onOpenSession={selectChat} />}
        </div>}
      </main>
      {conversations.feedback}
      {conversations.dialog}
    </div>
    </CharacterPreviewProvider>
  );
};

type Translator = (key: string) => string;

const Header = ({ eyebrow, title, detail }: { eyebrow: string; title: string; detail?: string }): JSX.Element => (
  <header className="page-header"><span>{eyebrow}</span><h1>{title}</h1>{detail === undefined ? null : <p>{detail}</p>}</header>
);

const orderChatFollowups = (items: ChatMessage[]): ChatMessage[] => {
  const ordered = [...items];
  for (const message of items) {
    if (message.role !== 'user' || !message.followupToMessageId) continue;
    const target = ordered.findIndex(item => item.id === message.followupToMessageId);
    const index = ordered.findIndex(item => item.id === message.id);
    if (target >= 0 && index > target) { ordered.splice(index, 1); ordered.splice(target, 0, message); }
  }
  return ordered;
};

const insertChatFollowup = (items: ChatMessage[], message: ChatMessage, messageId: string): ChatMessage[] => {
  const incoming = { ...message, followupToMessageId: message.followupToMessageId ?? messageId };
  return orderChatFollowups(items.some(item => item.id === incoming.id)
    ? items.map(item => item.id === incoming.id ? incoming : item) : [...items, incoming]);
};

const reconcileChatMessages = (loaded: ChatMessage[], current: ChatMessage[]): ChatMessage[] => {
  const byId = new Map(current.map((message) => [message.id, message]));
  const loadedIds = new Set(loaded.map((message) => message.id));
  return orderChatFollowups([
    ...loaded.map((message) => {
      const live = byId.get(message.id);
      return message.status === 'streaming' && live !== undefined
        && (live.status !== 'streaming' || live.content.length > message.content.length || (live.timerReceipts?.length ?? 0) > (message.timerReceipts?.length ?? 0)) ? live : message;
    }),
    ...current.filter((message) => !loadedIds.has(message.id)),
  ]);
};

const CHAT_ERROR_KEYS: Readonly<Record<string, MessageKey>> = {
  ...TOOL_FAILURE_KEYS,
  'provider.authentication': 'chat.error.authentication',
  'provider.quota': 'chat.error.quota',
  'provider.rateLimit': 'chat.error.rateLimit',
  'provider.timeout': 'chat.error.timeout',
  'provider.streamInterrupted': 'chat.error.streamInterrupted',
  'provider.truncated': 'chat.error.truncated',
  'provider.contextBudgetExceeded': 'chat.error.contextBudget',
  'provider.invalidRequestBudget': 'chat.error.invalidRequestBudget',
  'provider.budgetExceeded': 'chat.error.usageBudget',
  'provider.bindingMismatch': 'chat.error.bindingChanged',
  'provider.contextPrivacyBlocked': 'chat.error.contextPrivacy',
  'provider.requestRecordFailed': 'chat.error.contextPersistence',
  'chat.contextStale': 'chat.error.contextStale',
  'chat.contextReceiptConflict': 'chat.error.contextPersistence',
  'chat.contextPersistenceFailed': 'chat.error.contextPersistence',
  'provider.unavailable': 'chat.error.unavailable',
  'provider.request': 'chat.error.request',
  'provider.unsupportedParameter': 'chat.error.unsupportedParameter',
  'provider.modelUnavailable': 'chat.error.modelUnavailable',
  'provider.regionRestricted': 'chat.error.regionRestricted',
  'chat.interrupted': 'chat.interrupted',
  'chat.persistenceFailed': 'chat.persistenceFailed',
  'chat.approvalDenied': 'chat.approvalDenied',
  'chat.approvalExpired': 'chat.approvalExpired',
  'memory.saveFailed': 'memory.saveFailed',
  'repository.commitUncertain': 'repository.commitUncertain',
  'memory.removed': 'memory.removed',
  'memory.forgetFailed': 'memory.forgetFailed',
  'memory.forgetPending': 'memory.forgetPending',
  'memory.editFailed': 'memory.editFailed',
};

const ChatApprovalCard = ({ approval, disabled, t, decide }: {
  approval: ChatApprovalRequest; disabled: boolean; t: Translator;
  decide(approval: ChatApprovalRequest, decision: ChatApprovalDecision): Promise<void>;
}): JSX.Element => {
  const [expired, setExpired] = useState(() => !Number.isFinite(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt) <= Date.now());
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    const remaining = Date.parse(approval.expiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) { setExpired(true); return; }
    const timer = setTimeout(() => setExpired(true), Math.min(remaining, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [approval.expiresAt]);
  const respond = async (decision: ChatApprovalDecision): Promise<void> => {
    if (disabled || expired || submitted || inFlight.current) return;
    if (Date.parse(approval.expiresAt) <= Date.now()) { setExpired(true); return; }
    inFlight.current = true; setPending(true); setError(null);
    try { await decide(approval, decision); setSubmitted(true); }
    catch (failure) {
      if (failure instanceof Error && /chat\.(approvalExpired|interrupted)/u.test(failure.message)) setExpired(true);
      else setError('chat.interaction.approvalFailed');
    } finally { inFlight.current = false; setPending(false); }
  };
  return <section className="chat-approval" aria-label={t('chat.interaction.approval')} aria-busy={pending}>
    <div className="chat-approval-heading"><h3>{t('chat.interaction.approval')}</h3><small>{t(`chat.interaction.risk.${approval.risk}`)}</small></div>
    <strong>{t(approval.titleCode)}</strong><p>{t(approval.detailCode)}</p>
    <details open><summary>{t('chat.interaction.inputPreview')}</summary><pre>{approval.inputPreview}</pre></details>
    {approval.inputTruncated && <p className="chat-approval-truncated">{t('chat.interaction.inputTruncated')}</p>}
    {approval.disclosure && <p className="chat-approval-disclosure" role="note">{t(`chat.interaction.disclosure.${approval.disclosure.destination}`).replace('{provider}', approval.disclosure.providerName).replace('{model}', approval.disclosure.model)}</p>}
    <p className="chat-approval-scope">{t(approval.capabilityId==='chat.cron'?'chat.interaction.cronScope':approval.allowRun?'chat.interaction.runScope':'chat.interaction.approvalScope')}</p>
    {expired ? <p role="status">{t('chat.interaction.approvalExpired')}</p> : submitted ? <p role="status">{t('chat.interaction.approvalSubmitted')}</p> : <div className="button-row">
      <button type="button" disabled={disabled || pending} onClick={() => void respond('allow-once')}>{t(approval.capabilityId==='chat.cron'?'chat.interaction.confirmCron':'chat.interaction.allowOnce')}</button>
      {approval.allowRun && <button type="button" className="secondary" disabled={disabled || pending} onClick={() => void respond('allow-run')}>{t('chat.interaction.allowRun')}</button>}
      <button type="button" className="secondary" disabled={disabled || pending} onClick={() => void respond('deny')}>{t('chat.interaction.deny')}</button>
    </div>}
    {pending && <p role="status">{t('chat.interaction.approvalSubmitting')}</p>}
    {error && <p className="inline-error" role="alert">{t(error)}</p>}
  </section>;
};

const ChatPage = ({ memoryDraftRequest, artifactDraftRequest, onContinueArtifact, snapshot, t, refresh, sessionId, selectSession, onBusyChange, name, companionOpen, setCompanionOpen, narrow, manageCompanion, managePermissions, manageMemory, manageMedia, conversationBusy, onConversationAction, focusDelegationId, focusDelegationRevision }: {
  memoryDraftRequest: { sessionId: string; query: string; revision: number } | null;
  artifactDraftRequest: { reference: ChatArtifactReference; revision: number } | null; onContinueArtifact(reference: ChatArtifactReference): void;
  snapshot: Snapshot; t: Translator; refresh(): Promise<void>; sessionId: string; selectSession(id: string): void; onBusyChange(busy: boolean): void;
  name: string; companionOpen: boolean; setCompanionOpen(open: boolean): void; narrow: boolean; manageCompanion(): void; managePermissions(): void; manageMemory(): void; manageMedia(): void;
  focusDelegationRevision: number; focusDelegationId?: string | undefined; conversationBusy: boolean; onConversationAction(action: ConversationAction, session: ChatSession): void;
}): JSX.Element => {
  const [delegationDraft, setDelegationDraft] = useState<DelegationDraft | null>(null);
  const [delegationsOpen, setDelegationsOpen] = useState(false);
  useEffect(() => { if (focusDelegationId) setDelegationsOpen(true); }, [focusDelegationId, focusDelegationRevision, sessionId]);
  const [messagesState, setMessages] = useState<ChatMessage[]>([]);
  // The session whose history has been read. Until then an empty list means "still loading", not "nothing here".
  const [loadedSession, setLoadedSession] = useState<string | null>(null);
  // Messages that arrived while this conversation is open come in; its history, as first read, is simply there.
  const seenMessages = useRef<{ sessionId: string; ids: Set<string> } | null>(null);
  const [arriving, setArriving] = useState<ReadonlySet<string>>(() => new Set());
  const [progressByMessage, setProgress] = useState<Record<string, ChatProgress>>({});
  const [liveMessageId, setLiveMessageId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // Each conversation keeps its own unsent draft, so switching never carries text into another chat.
  const drafts = useRef(new Map<string, string>());
  const draftSession = useRef(sessionId);
  const createdFromDraft = useRef<string | null>(null);
  useEffect(() => {
    if (draftSession.current === sessionId) return;
    const previous = draftSession.current;
    draftSession.current = sessionId;
    if (previous === '' && createdFromDraft.current === sessionId) { createdFromDraft.current = null; return; }
    setDraft(current => {
      if (current.trim()) drafts.current.set(previous, current); else drafts.current.delete(previous);
      const restored = drafts.current.get(sessionId) ?? '';
      drafts.current.delete(sessionId);
      return restored;
    });
  }, [sessionId]);
  const composerForm = useRef<ComponentRef<'form'>>(null);
  const spokenDraft = useRef<string | null>(null);
  useEffect(() => { if (spokenDraft.current !== null && spokenDraft.current === draft) { spokenDraft.current = null; composerForm.current?.requestSubmit(); } }, [draft]);
  const [pendingMemoryQuery, setPendingMemoryQuery] = useState<{ sessionId: string; query: string } | null>(null);
  const appliedMemoryDraft = useRef(0);
  useEffect(() => {
    if (!memoryDraftRequest || memoryDraftRequest.sessionId !== sessionId || appliedMemoryDraft.current === memoryDraftRequest.revision) return;
    appliedMemoryDraft.current = memoryDraftRequest.revision;
    if (!draft.trim() || draft === memoryDraftRequest.query) {
      setDraft(memoryDraftRequest.query); setPendingMemoryQuery(null);
    } else setPendingMemoryQuery({ sessionId, query: memoryDraftRequest.query });
  }, [memoryDraftRequest, sessionId, draft]);
  const appliedArtifactDraft = useRef(0);
  useEffect(() => {
    if (!artifactDraftRequest || artifactDraftRequest.reference.sessionId !== sessionId || appliedArtifactDraft.current === artifactDraftRequest.revision) return;
    appliedArtifactDraft.current = artifactDraftRequest.revision;
    const prompt = artifactContinuationPrompt(artifactDraftRequest.reference, snapshot.app.resolvedLocale === 'zh-CN');
    setDraft(current => current.trim() ? `${current}\n\n${prompt}` : prompt);
  }, [artifactDraftRequest, sessionId, snapshot.app.resolvedLocale]);
  const [running, setRunning] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sendError, setSendError] = useState(false);
  const [reloadFailed, setReloadFailed] = useState<string | null>(null);
  const [interaction, setInteraction] = useState<ChatInteractionState | null>(null);
  const [restoringInteraction, setRestoringInteraction] = useState(false);
  const [interactionLoadFailed, setInteractionLoadFailed] = useState(false);
  const [followupPending, setFollowupPending] = useState(false);
  const [followupError, setFollowupError] = useState<string | null>(null);
  const [cancellingRun, setCancellingRun] = useState<string | null>(null);
  const interactionRef = useRef<ChatInteractionState | null>(null);
  const interactionRevision = useRef(0);
  const interactionReadSequence = useRef(0);
  const pendingFollowup = useRef<{ runId: string; sessionId: string; operationId: string; content: string } | null>(null);
  const sendingFollowup = useRef(false);
  const [modelSaving, setModelSaving] = useState(false);
  const selectedSession = useRef(sessionId);
  const lastTypingSignal = useRef(0);
  const drawer = useRef<ComponentRef<'dialog'>>(null);
  // Copy feedback stays on the message that was copied and clears itself; the latest copy wins.
  const [copied, setCopied] = useState<{ id: string; failed: boolean } | null>(null);
  const copyReset = useRef<number | null>(null);
  const latestCopy = useRef<symbol | null>(null);
  useEffect(() => () => { if (copyReset.current !== null) window.clearTimeout(copyReset.current); }, []);
  useEffect(() => {
    const dialog = drawer.current;
    if (dialog === null) return;
    if (narrow && companionOpen && !dialog.open) dialog.showModal();
    else if (dialog.open) dialog.close();
  }, [narrow, companionOpen]);
  const activeRun = useRef<string | null>(null);
  // Plugin workspaces can start an analysis reply before its chat is opened.
  const sessionRuns = useRef(new Map<string, { runId: string; messageId: string }>());
  const sending = useRef(false);
  const messageList = useRef<ComponentRef<'div'> | null>(null);
  const followOutput = useRef(true);
  const completedRuns = useRef(new Set<string>());
  const selectedConversation = snapshot.sessions.find((session) => session.id === sessionId);
  const modelSelection = selectedConversation?.modelSelection;
  const activeProvider = snapshot.providers.find(item => item.id === snapshot.app.activeProviderId && item.enabled) ?? snapshot.providers.find(item => item.enabled);
  const provider = modelSelection ? snapshot.providers.find(item => item.id === modelSelection.providerId && item.enabled) : activeProvider;
  const effectiveChatProvider = provider && modelSelection?.model ? { ...provider, model: modelSelection.model } : provider;
  const archived = Boolean(selectedConversation?.archivedAt);
  const wechatTranscript = selectedConversation?.wechatTranscript;
  useEffect(() => { onBusyChange(submitting || running !== null || restoringInteraction); }, [submitting, running, restoringInteraction, onBusyChange]);
  useLayoutEffect(() => {
    if (selectedSession.current !== sessionId) {
      selectedSession.current = sessionId;
      followOutput.current = true;
      setMessages([]); setLoadedSession(null); setArriving(new Set());
      const externalRun = sessionRuns.current.get(sessionId);
      activeRun.current = externalRun?.runId ?? null;
      setRunning(externalRun?.runId ?? null);
      setProgress(externalRun ? { [externalRun.messageId]: { phase: 'thinking' } } : {});
      setLiveMessageId(externalRun?.messageId ?? null);
      setSendError(false);
      interactionRevision.current++;
      interactionRef.current = null; setInteraction(null);
      setFollowupError(null); setCancellingRun(null); setInteractionLoadFailed(false);
    }
  }, [sessionId]);
  const followLatest = useCallback(() => {
    const list = messageList.current;
    if (!followOutput.current || list === null) return;
    list.scrollTop = list.scrollHeight;
    const approval = list.querySelector<HTMLElement>('.chat-approval');
    if (approval !== null) {
      const viewport = list.getBoundingClientRect(), card = approval.getBoundingClientRect();
      // A restored receipt can appear below the pending card. Keep the whole
      // decision visible instead of following that secondary footer offscreen.
      if (card.height <= viewport.height && card.top < viewport.top) list.scrollTop += card.top - viewport.top;
    }
  }, []);
  useLayoutEffect(() => { followLatest(); }, [messagesState, interaction?.approval?.id, followLatest]);
  useLayoutEffect(() => {
    if (loadedSession !== sessionId) return;
    const seen = seenMessages.current;
    if (seen === null || seen.sessionId !== sessionId) { seenMessages.current = { sessionId, ids: new Set(messagesState.map((message) => message.id)) }; return; }
    const fresh = messagesState.filter((message) => !seen.ids.has(message.id)).map((message) => message.id);
    if (fresh.length === 0) return;
    for (const id of fresh) seen.ids.add(id);
    setArriving((current) => new Set([...current, ...fresh]));
  }, [messagesState, sessionId, loadedSession]);
  const arrived = useCallback((id: string) => setArriving((current) => { if (!current.has(id)) return current; const next = new Set(current); next.delete(id); return next; }), []);
  useEffect(() => {
    const list = messageList.current;
    if (list === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      followLatest();
      // Resizing can move a previously visible decision below the composer,
      // even when transcript following was paused by an earlier scroll. Fit
      // that visible card without jumping from history to an offscreen card.
      const approval = list.querySelector<HTMLElement>('.chat-approval');
      if (approval === null) return;
      const viewport = list.getBoundingClientRect(), card = approval.getBoundingClientRect();
      if (card.height <= viewport.height && card.top >= viewport.top - 1 && card.top < viewport.bottom && card.bottom > viewport.bottom) {
        list.scrollTop += card.bottom - viewport.bottom;
      }
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [followLatest]);
  const applyInteraction = useCallback((state: ChatInteractionState): void => {
    if (state.sessionId !== selectedSession.current || completedRuns.current.has(state.runId)) return;
    setInteractionLoadFailed(false); setRestoringInteraction(false);
    interactionRef.current = state; setInteraction(state);
    activeRun.current = state.runId; setRunning(state.runId); setLiveMessageId(state.messageId);
    sessionRuns.current.set(state.sessionId, { runId: state.runId, messageId: state.messageId });
    setProgress(current => ({ ...current, [state.messageId]: state.progress }));
    setMessages(items => items.some(item => item.id === state.messageId) ? items : [...items, {
      id: state.messageId, sessionId: state.sessionId, role: 'assistant', content: '',
      createdAt: new Date().toISOString(), status: 'streaming', errorCode: null,
    }]);
  }, []);
  const restoreInteraction = useCallback(async (): Promise<void> => {
    const selected = selectedSession.current;
    if (!selected || wechatTranscript || !window.deskpet.chat.getInteraction) return;
    const sequence = ++interactionReadSequence.current;
    const revision = interactionRevision.current;
    setRestoringInteraction(true); setInteractionLoadFailed(false);
    try {
      const state = await window.deskpet.chat.getInteraction(selected);
      if (sequence !== interactionReadSequence.current || selected !== selectedSession.current || revision !== interactionRevision.current) return;
      if (state) applyInteraction(state);
      else {
        sessionRuns.current.delete(selected);
        interactionRef.current = null; setInteraction(null);
        activeRun.current = null; setRunning(null); setCancellingRun(null);
      }
    } catch {
      if (sequence === interactionReadSequence.current && selected === selectedSession.current && revision === interactionRevision.current) setInteractionLoadFailed(true);
    } finally {
      if (sequence === interactionReadSequence.current && selected === selectedSession.current) setRestoringInteraction(false);
    }
  }, [applyInteraction, wechatTranscript]);
  const invalidateInteractionRead = useCallback(() => { interactionReadSequence.current++; }, []);
  useEffect(() => {
    void restoreInteraction();
    return invalidateInteractionRead;
  }, [sessionId, restoreInteraction, invalidateInteractionRead]);
  useEffect(() => {
    let cancelled = false;
    let sequence = 0;
    const load = (): void => {
      if (!sessionId) return;
      const currentRead = ++sequence;
      void window.deskpet.chat.listMessages(sessionId).then((loaded) => {
        if (!cancelled && currentRead === sequence && selectedSession.current === sessionId) {
          setMessages((current) => wechatTranscript ? loaded : reconcileChatMessages(loaded, current));
          setLoadedSession(sessionId);
        }
      }).catch(() => { if (!cancelled && currentRead === sequence) { setSendError(true); setLoadedSession(sessionId); } });
    };
    load();
    const unsubscribe = wechatTranscript ? window.deskpet.chat.onSessionsChanged(load) : undefined;
    return () => { cancelled = true; unsubscribe?.(); };
  }, [sessionId, wechatTranscript]);
  useEffect(() => window.deskpet.chat.onEvent((event) => {
    if (event.type === 'started' && !completedRuns.current.has(event.runId)) sessionRuns.current.set(event.sessionId, { runId: event.runId, messageId: event.messageId });
    if (event.type === 'started' && event.sessionId === selectedSession.current && !completedRuns.current.has(event.runId)) {
      interactionRevision.current++;
      interactionRef.current = null; setInteraction(null); setFollowupError(null); setCancellingRun(null);
      activeRun.current = event.runId;
      setRunning(event.runId);
      setLiveMessageId(event.messageId);
      setProgress((current) => ({ ...current, [event.messageId]: { phase: 'thinking' } }));
      setMessages((items) => items.some((item) => item.id === event.messageId) ? items.map((item) => item.id === event.messageId ? { ...item, content: '', status: 'streaming', errorCode: null } : item) : [...items, {
        id: event.messageId, sessionId: event.sessionId, role: 'assistant', content: '',
        createdAt: new Date().toISOString(), status: 'streaming', errorCode: null,
      }]);
    }
    if (event.type === 'interaction' && event.state.sessionId === selectedSession.current && !completedRuns.current.has(event.state.runId)) {
      interactionRevision.current++;
      applyInteraction(event.state);
    }
    if (event.type === 'followup' && event.sessionId === selectedSession.current) {
      setMessages(items => insertChatFollowup(items, event.message, event.messageId));
    }
    if (event.type === 'progress' && activeRun.current === event.runId && !completedRuns.current.has(event.runId)) {
      setProgress((current) => ({ ...current, [event.messageId]: event.progress }));
    }
    if (event.type === 'delta' && !completedRuns.current.has(event.runId)) {
      if (event.text.length > 0) setProgress((current) => ({ ...current, [event.messageId]: { phase: 'responding' } }));
      setMessages((items) => items.map((item) => item.id === event.messageId ? { ...item, content: item.content + event.text } : item));
    }
    if (event.type === 'timer-created') {
      setMessages((items) => items.map((item) => item.id === event.messageId ? {
        ...item, timerReceipts: [...(item.timerReceipts ?? []).filter((receipt) => receipt.timerId !== event.receipt.timerId), event.receipt],
      } : item));
    }
    if (event.type === 'memory-saved') {
      setMessages((items) => items.map((item) => item.id === event.messageId ? { ...item, memoryReceipts: [event.receipt] } : item));
    }
    if (event.type === 'finished' || event.type === 'failed') {
      for (const [id, pending] of sessionRuns.current) if (pending.runId === event.runId) sessionRuns.current.delete(id);
      completedRuns.current.add(event.runId);
      const completedId = event.type === 'finished' ? event.message.id : event.messageId;
      setProgress((current) => {
        const next = { ...current }; delete next[completedId]; return next;
      });
      if (activeRun.current === event.runId) {
        interactionRevision.current++;
        activeRun.current = null; setRunning(null); setCancellingRun(null);
        interactionRef.current = null; setInteraction(null);
      }
      if (event.type === 'finished' && event.message.sessionId === selectedSession.current) {
        setMessages((items) => items.some((item) => item.id === event.message.id)
          ? items.map((item) => item.id === event.message.id ? event.message : item) : [...items, event.message]);
      } else if (event.type === 'failed') {
        setMessages((items) => items.map((item) => item.id === event.messageId ? { ...item, status: 'failed', errorCode: event.errorCode } : item));
      }
      void refresh();
    }
  }), [refresh, applyInteraction]);
  const ensureSession = async (content: string): Promise<string> => {
    if (selectedSession.current.length > 0) return selectedSession.current;
    const session = await window.deskpet.chat.createSession({ title: content.replace(/\s+/gu, ' ').slice(0, 40), kind: 'normal' });
    // The new chat's unsent draft moves with it when it gets its real id.
    createdFromDraft.current = session.id;
    selectedSession.current = session.id;
    selectSession(session.id);
    void refresh();
    return session.id;
  };
  const sendFollowup = async (content: string): Promise<void> => {
    const state = interactionRef.current;
    if (!content || archived || sendingFollowup.current || cancellingRun !== null || restoringInteraction || interactionLoadFailed) return;
    if (!state || state.runId !== activeRun.current || !state.acceptingFollowups || !state.canFollowup || !window.deskpet.chat.followup) {
      setFollowupError('chat.interaction.followupPaused'); return;
    }
    if (content.length > 8_000) { setFollowupError('chat.interaction.followupLimit'); return; }
    const prior = pendingFollowup.current;
    const operation = prior?.runId === state.runId && prior.sessionId === state.sessionId && prior.content === content
      ? prior : { runId: state.runId, sessionId: state.sessionId, operationId: crypto.randomUUID(), content };
    pendingFollowup.current = operation;
    sendingFollowup.current = true; setFollowupPending(true); setFollowupError(null);
    followOutput.current = true;
    try {
      const message = await window.deskpet.chat.followup(operation);
      if (selectedSession.current === operation.sessionId) {
        setMessages(items => insertChatFollowup(items, message, state.messageId));
        setDraft(current => current.trim() === content ? '' : current);
      }
      if (pendingFollowup.current === operation) pendingFollowup.current = null;
    } catch (failure) {
      if (selectedSession.current !== operation.sessionId) return;
      const code = failure instanceof Error ? failure.message : '';
      setFollowupError(/chat\.followupLimit/u.test(code) ? 'chat.interaction.followupLimit'
        : /chat\.followupConflict/u.test(code) ? 'chat.interaction.followupConflict'
          : /chat\.(followupUnavailable|interrupted)/u.test(code) ? 'chat.interaction.followupUnavailable' : 'chat.interaction.followupFailed');
      await restoreInteraction();
    } finally { sendingFollowup.current = false; setFollowupPending(false); }
  };
  const decideApproval = async (approval: ChatApprovalRequest, decision: ChatApprovalDecision): Promise<void> => {
    const state = interactionRef.current;
    if (!state || state.runId !== approval.runId || activeRun.current !== approval.runId || state.approval?.id !== approval.id
      || state.sessionId !== approval.sessionId || cancellingRun !== null || Date.parse(approval.expiresAt) <= Date.now()
      || !window.deskpet.chat.resolveApproval) throw new Error('chat.approvalExpired');
    await window.deskpet.chat.resolveApproval({ runId: approval.runId, sessionId: approval.sessionId, approvalId: approval.id, decision });
    if (interactionRef.current?.approval?.id === approval.id) await restoreInteraction();
  };
  const stop = async (): Promise<void> => {
    const runId = activeRun.current;
    if (!runId || cancellingRun !== null) return;
    setCancellingRun(runId);
    try { await window.deskpet.chat.cancel(runId); }
    catch { setSendError(true); setCancellingRun(null); }
  };
  const send = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (wechatTranscript) return;
    if (activeRun.current !== null) { await sendFollowup(draft.trim()); return; }
    if (archived || conversationBusy || restoringInteraction || interactionLoadFailed || draft.trim().length === 0 || (provider === undefined && parseDelegationCommand(draft) === null) || modelSaving || sending.current) return;
    const content = draft.trim();
    followOutput.current = true;
    sending.current = true;
    setSubmitting(true);
    setSendError(false);
    setDraft('');
    let submitted = false;
    try {
      const activeSession = await ensureSession(content);
      if (parseDelegationCommand(content) !== null) {
        const review = await window.deskpet.delegations.openDraft({ sessionId: activeSession, command: content });
        setDelegationDraft(review); setDelegationsOpen(true); return;
      }
      const result = await window.deskpet.chat.send({ sessionId: activeSession, content });
      submitted = true;
      // A fast provider can finish before the IPC send promise resolves.
      if (!completedRuns.current.has(result.runId)) { activeRun.current = result.runId; setRunning(result.runId); }
      const reload = async (): Promise<void> => {
        const loaded = await window.deskpet.chat.listMessages(activeSession);
        if (selectedSession.current === activeSession) setMessages((current) => reconcileChatMessages(loaded, current));
      };
      // The message is already accepted; a failed reload is retried quietly, then offered as a reload, never as a resend.
      await reload().catch(() => new Promise<void>(resolve => window.setTimeout(resolve, 1_000)).then(reload)).catch(() => setReloadFailed(activeSession));
    } catch {
      if (!submitted) {
        setSendError(true);
        setDraft((current) => current.length === 0 ? content : current);
      }
    } finally {
      sending.current = false;
      setSubmitting(false);
    }
  };
  const retry = async (messageId: string): Promise<void> => {
    if (archived || conversationBusy || sending.current || activeRun.current !== null || provider === undefined || modelSaving) return;
    sending.current = true; setSubmitting(true); setSendError(false); followOutput.current = true;
    try {
      const result = await window.deskpet.chat.retry(messageId);
      if (!completedRuns.current.has(result.runId)) { activeRun.current = result.runId; setRunning(result.runId); }
      const loaded = await window.deskpet.chat.listMessages(selectedSession.current);
      setMessages((current) => reconcileChatMessages(loaded, current));
    } catch { setSendError(true); }
    finally { sending.current = false; setSubmitting(false); }
  };
  const forgetMemory = async (message: ChatMessage, memoryId: string): Promise<void> => {
    if (archived || conversationBusy || sending.current || activeRun.current !== null) throw new Error('memory.forgetFailed');
    sending.current = true; setSubmitting(true);
    try {
      const updated = await window.deskpet.chat.forgetMemory(message.id, memoryId);
      if (selectedSession.current === updated.sessionId) setMessages((items) => items.map((item) => item.id === updated.id ? updated : item));
    } finally { sending.current = false; setSubmitting(false); }
  };
  const editMemory = async (message: ChatMessage, memoryId: string): Promise<void> => {
    if (archived || conversationBusy || sending.current || activeRun.current !== null) throw new Error('memory.editFailed');
    sending.current = true; setSubmitting(true);
    try {
      const updated = await window.deskpet.chat.editMemory(message.id, memoryId);
      if (selectedSession.current === updated.sessionId) setMessages((items) => items.map((item) => item.id === updated.id ? updated : item));
    } finally { sending.current = false; setSubmitting(false); }
  };
  const openDelegation = async (): Promise<void> => {
    if (wechatTranscript) return;
    try { const activeSession = await ensureSession('Text delegation'); setDelegationDraft(await window.deskpet.delegations.openDraft({ sessionId: activeSession })); setDelegationsOpen(true); }
    catch { setSendError(true); }
  };
  const selectedTitle = snapshot.sessions.find((session) => session.id === sessionId)?.title ?? t('chat.new');
  const copy = async (message: ChatMessage): Promise<void> => {
    const attempt = Symbol('copy'); latestCopy.current = attempt;
    let failed = false;
    try { await navigator.clipboard.writeText(message.content); } catch { failed = true; }
    if (latestCopy.current !== attempt) return;
    setCopied({ id: message.id, failed });
    if (copyReset.current !== null) window.clearTimeout(copyReset.current);
    copyReset.current = window.setTimeout(() => { copyReset.current = null; setCopied(null); }, failed ? 4_000 : 1_600);
  };
  const panel = <CompanionPanel state={snapshot.character} name={name} t={t} close={() => setCompanionOpen(false)} manage={manageCompanion} refresh={refresh} />;
  const showCompanion = companionOpen && !narrow && snapshot.character.modelState === 'ready';
  return <section className={showCompanion ? 'chat-layout with-companion' : 'chat-layout'}>
    <div className="chat-pane">
      <header className="chat-header"><div className="conversation-heading"><span className="eyebrow">{t('ui.chatWith')}</span><h1>{selectedTitle}</h1></div><div className="header-actions"><button type="button" className="icon-button" disabled={archived || Boolean(wechatTranscript)} aria-label={snapshot.app.resolvedLocale === 'zh-CN' ? '委派文本任务' : 'Delegate text task'} title={snapshot.app.resolvedLocale === 'zh-CN' ? '委派文本任务' : 'Delegate text task'} onClick={() => void openDelegation()}><TreeStructure size={17} /></button><button type="button" className="icon-button" aria-expanded={delegationsOpen} aria-label={snapshot.app.resolvedLocale === 'zh-CN' ? '委派状态' : 'Delegation status'} title={snapshot.app.resolvedLocale === 'zh-CN' ? '委派状态' : 'Delegation status'} onClick={() => setDelegationsOpen(!delegationsOpen)}><ListChecks size={17} /></button><div className="session-control"><ClockCounterClockwise size={18} /><select aria-label={t('chat.new')} title={t('ui.recent')} value={sessionId} disabled={conversationBusy} onChange={(event) => selectSession(event.target.value)}><option value="">{t('chat.new')}</option>{snapshot.sessions.filter((session) => !session.deletedAt && (!session.archivedAt || session.id === sessionId)).map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}</select></div>{selectedConversation && <ConversationMenu session={selectedConversation} disabled={conversationBusy} t={t} onAction={onConversationAction} />}<button type="button" className="icon-button" aria-label={t(companionOpen ? 'ui.hideCompanion' : 'ui.showCompanion')} title={t(companionOpen ? 'ui.hideCompanion' : 'ui.showCompanion')} aria-expanded={companionOpen} onClick={() => setCompanionOpen(!companionOpen)}><SidebarSimple size={18} /></button><button type="button" className="icon-button" disabled={conversationBusy} aria-label={t('ui.newSession')} title={t('ui.newSession')} onClick={() => selectSession('')}><Plus size={18} /></button></div></header>
      {delegationsOpen && !wechatTranscript && <div className="delegation-chat-panel"><Delegations focusRevision={focusDelegationRevision} focusBatchId={focusDelegationId} key={sessionId} sessionId={sessionId} providers={snapshot.providers} locale={snapshot.app.resolvedLocale} draft={delegationDraft?.sessionId === sessionId ? delegationDraft : null} onDraftChange={setDelegationDraft} /></div>}
      <div className="message-list" ref={messageList} aria-live="polite" onScroll={(event) => {
        const list = event.currentTarget;
        followOutput.current = list.scrollHeight - list.scrollTop - list.clientHeight <= 40;
      }}><div className="transcript-inner">{messagesState.length === 0 && sessionId && loadedSession !== sessionId ? <p className="chat-loading muted" role="status">{t('chat.loadingHistory')}</p> : messagesState.length === 0 ? wechatTranscript ? <p className="muted">{t('conversation.wechatEmpty')}</p> : !snapshot.providers.some((provider) => provider.enabled) ? <QuickSetup locale={snapshot.app.resolvedLocale} refresh={refresh} /> : <div className="chat-welcome"><CompanionAvatar name={name} large /><h2>{t('ui.emptyTitle')}</h2><p>{t('ui.emptyDetail')}</p>{!draft.trim() && <div className="prompt-list">{['ui.promptHello', 'ui.promptDay', 'ui.promptFocus'].map((key) => <button type="button" key={key} onClick={() => setDraft(t(key))}>{t(key)}<ArrowUp size={14} /></button>)}</div>}</div> : messagesState.map((message) => <article key={message.id} className={`message ${message.role}${arriving.has(message.id) ? ' is-arriving' : ''}`} data-status={message.status} data-followup-to={message.followupToMessageId}
          onAnimationEnd={(event) => { if (event.target === event.currentTarget) arrived(message.id); }}>
        {message.role === 'assistant' ? <CompanionAvatar name={name} /> : null}<div className="message-body">{message.role !== 'user' ? <small className="speaker-name">{message.role === 'assistant' ? name : message.role}</small> : null}{wechatTranscript ? <>{message.role === 'user' && <small className="speaker-name">{message.wechatSender ?? t(wechatTranscript === 'private' ? 'conversation.wechatPrivate' : wechatTranscript === 'friend' ? 'conversation.wechatFriend' : 'conversation.wechatGroup')}</small>}<p className="wechat-message-text">{message.content}</p></> : message.role === 'assistant' ? <ChatReply message={message} progress={progressByMessage[message.id]} animate={message.id === liveMessageId} t={t} onReveal={followLatest} /> : <>{message.followupToMessageId && <small className="chat-followup-label">{t('chat.interaction.followup')}</small>}<p>{message.content}</p></>}<ChatImages attachments={message.attachments} />{interaction?.approval?.messageId === message.id && <ChatApprovalCard key={interaction.approval.id} approval={interaction.approval} disabled={cancellingRun !== null || running !== interaction.runId} t={t} decide={decideApproval} />}{message.timerReceipts?.map((receipt) => <div className="timer-receipt" role="status" key={receipt.timerId}><strong>{t('timer.created')}: {receipt.label || t('timer.title')}</strong><time dateTime={receipt.dueAt}>{formatTimerDeadline(receipt.dueAt, receipt.timeZone)}</time></div>)}{message.memoryReceipts?.map((receipt) => <div className="memory-receipt" role="status" key={receipt.memoryId}><strong>{t(receipt.expiresAt ? 'memory.temporarySaved' : receipt.scope?.kind === 'session' ? 'memory.sessionSaved' : receipt.reused ? 'memory.alreadySaved' : 'memory.saved')}</strong><p>{receipt.text}</p><button type="button" className="secondary" onClick={manageMemory}>{t('memory.view')}</button></div>)}{message.memoryForget && <ChatMemoryForget message={message} disabled={archived || conversationBusy || submitting || running !== null} t={t} select={(memoryId) => forgetMemory(message, memoryId)} view={manageMemory} />}{message.memoryEdit && <ChatMemoryEdit message={message} disabled={archived || conversationBusy || submitting || running !== null} t={t} select={(memoryId) => editMemory(message, memoryId)} view={manageMemory} />}{message.role === 'assistant' && <ChatContextReceipts message={message} t={t} />}{message.status === 'failed' ? <small className="message-error" role="alert">{t(CHAT_ERROR_KEYS[message.errorCode ?? ''] ?? 'chat.runFailed')}</small> : null}{message.status === 'failed' && message.errorCode?.startsWith('tool.permission') ? <button type="button" className="secondary" onClick={managePermissions}>{t('tool.openPermissions')}</button> : null}{message.status === 'cancelled' ? <small className="message-note">{t('ui.stopped')}</small> : null}{message.role === 'assistant' && (message.status === 'failed' || message.status === 'cancelled') ? <button type="button" className="secondary" disabled={archived || conversationBusy || submitting || running !== null || modelSaving || provider === undefined} onClick={() => void retry(message.id)}>{t('chat.retry')}</button> : null}{message.role === 'assistant' && message.status === 'complete' && message.content.length > 0 ? <><button type="button" className={copied?.id === message.id && !copied.failed ? 'copy-message is-copied' : 'copy-message'} onClick={() => void copy(message)}>{copied?.id === message.id && !copied.failed ? <Check key="done" size={12} className="copy-icon" /> : <Copy key="copy" size={12} className="copy-icon" />}{t(copied?.id === message.id && !copied.failed ? 'ui.copied' : 'ui.copy')}</button>{copied?.id === message.id && copied.failed ? <small className="message-error copy-error" role="alert">{t('ui.copyFailed')}</small> : null}</> : null}</div>
      </article>)}{sessionId && !wechatTranscript && window.deskpet.chatWork && <ChatWorkPanel sessionId={sessionId} api={window.deskpet.chatWork} locale={snapshot.app.resolvedLocale} onOpenSession={selectSession} onContinueArtifact={onContinueArtifact} continuationDisabled={conversationBusy || archived} />}</div></div>
      <div className="composer-region">
        {pendingMemoryQuery?.sessionId === sessionId && <div className="chat-interaction-note" role="status">
          <p>{snapshot.app.resolvedLocale === 'zh-CN' ? '已保留未发送的草稿。清空输入框后，可以放入刚才的检索问题。' : 'Your unsent draft is preserved. Clear the composer to insert the memory search question.'}</p>
          <p>{pendingMemoryQuery.query}</p>
          <button type="button" className="secondary" disabled={draft.trim().length > 0 || conversationBusy || archived} onClick={() => { setDraft(pendingMemoryQuery.query); setPendingMemoryQuery(null); }}>{snapshot.app.resolvedLocale === 'zh-CN' ? '放入检索问题' : 'Insert search question'}</button>
          <button type="button" className="text-button" onClick={() => setPendingMemoryQuery(null)}>{snapshot.app.resolvedLocale === 'zh-CN' ? '保留当前草稿' : 'Keep current draft'}</button>
        </div>}
        {archived && selectedConversation && !wechatTranscript && <div className="archived-conversation-note"><p>{t('conversation.archivedReadOnly')}</p><button type="button" className="secondary" disabled={conversationBusy} onClick={() => onConversationAction('unarchive', selectedConversation)}>{t('conversation.unarchive')}</button></div>}
        {sendError && <p className="inline-error" role="alert">{t('common.error')}</p>}
        {reloadFailed === sessionId && <p className="inline-error" role="status">{snapshot.app.resolvedLocale === 'zh-CN' ? '消息已发出，但对话记录暂时没加载出来。' : 'Your message was sent, but the conversation did not reload.'} <button type="button" className="secondary" onClick={() => void window.deskpet.chat.listMessages(sessionId).then(loaded => { if (selectedSession.current === sessionId) setMessages(current => reconcileChatMessages(loaded, current)); setReloadFailed(null); }).catch(() => undefined)}>{snapshot.app.resolvedLocale === 'zh-CN' ? '重新加载对话' : 'Reload conversation'}</button></p>}
        {followupError && <p className="inline-error" role="alert">{t(followupError)}</p>}
        {restoringInteraction && <p className="chat-interaction-note" role="status">{t('chat.interaction.restoring')}</p>}
        {interactionLoadFailed && <div className="inline-error" role="alert">{t('chat.interaction.restoreFailed')} <button type="button" className="secondary" onClick={() => void restoreInteraction()}>{t('common.retry')}</button></div>}
        {interaction && interaction.queuedFollowups > 0 && <p className="chat-interaction-note" role="status">{t('chat.interaction.followupWaiting')} ({interaction.queuedFollowups})</p>}
        {interaction && (!interaction.canFollowup || !interaction.acceptingFollowups) && <p className="chat-interaction-note">{t('chat.interaction.followupPaused')}</p>}
        {wechatTranscript ? <p className="chat-interaction-note">{t('conversation.wechatReadOnly')}</p> : <>
        <form ref={composerForm} className="composer" onSubmit={(event) => void send(event)}>
          <textarea disabled={archived} aria-label={t('chat.placeholder')} aria-describedby="chat-composer-hint"
            placeholder={t(running === null ? 'chat.placeholder' : 'chat.interaction.followup')}
            maxLength={running === null ? undefined : 8_000} value={draft} onChange={(event) => {
              setDraft(event.target.value);
              if (Date.now() - lastTypingSignal.current > 5_000) { lastTypingSignal.current = Date.now(); void window.deskpet.proactive?.noteInteraction().catch(() => undefined); }
            }} onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) void send(event);
            }} />
          <div className="composer-tools"><small id="chat-composer-hint" className="composer-hint">{t(running === null ? 'chat.composerHint' : 'chat.interaction.followupHint')}</small>
            <div className="composer-actions">
              {!wechatTranscript && <MicrophoneButton key={sessionId} zh={snapshot.app.resolvedLocale === 'zh-CN'} disabled={archived || running !== null} onResult={(text, autoSend) => {
                setDraft(current => { if (!current.trim() && autoSend) spokenDraft.current = text; return current.trim() ? `${current}\n${text}` : text; });
              }} />}
              {window.deskpet.media && <button className="secondary" type="button" disabled={archived || conversationBusy || submitting || running !== null} onClick={manageMedia}>{snapshot.app.resolvedLocale === 'zh-CN' ? '图片 / 表情' : 'Images'}</button>}
              {running !== null && <button className="stop-button secondary" type="button" disabled={cancellingRun === running} onClick={() => void stop()}>{t('chat.cancel')}<Square size={12} weight="fill" /></button>}
              <button className="send-button" type="submit" disabled={archived || restoringInteraction || interactionLoadFailed || draft.trim().length === 0 || (running === null
                ? (provider === undefined && parseDelegationCommand(draft) === null) || modelSaving || conversationBusy || submitting
                : !interaction?.canFollowup || !interaction.acceptingFollowups || interaction.runId !== running || followupPending || cancellingRun !== null)}>
                {running === null ? submitting ? t('common.loading') : t('chat.send') : followupPending ? t('common.loading') : t('chat.interaction.followup')}<ArrowUp size={16} />
              </button>
            </div>
          </div>
        </form>
        {!archived && !selectedConversation?.analysisSource && !selectedConversation?.channelBindingId &&
          <ChatModelPicker providers={snapshot.providers} provider={provider} selection={modelSelection}
            onSelect={async selection => window.deskpet.chat.setModelSelection(await ensureSession(snapshot.app.resolvedLocale === 'zh-CN' ? '新对话' : 'New conversation'), selection)}
            running={submitting || running !== null || restoringInteraction} t={t} refresh={refresh} onSavingChange={setModelSaving} />}
        <ChatCapabilitySummary key={`${sessionId}:${effectiveChatProvider?.id}:${effectiveChatProvider?.model}`} provider={effectiveChatProvider} privateConversation={selectedConversation?.historyPrivacy === 'local-only'} locale={snapshot.app.resolvedLocale} refresh={refresh} />
        </>}
      </div>
    </div>
    {narrow ? <dialog className="companion-drawer" ref={drawer} aria-label={name} onCancel={() => setCompanionOpen(false)} onClose={() => setCompanionOpen(false)}>{panel}</dialog> : showCompanion ? panel : null}
  </section>;
};

/** Everything about her in one place: look, persona, voice, diary and check-ins. */
const CompanionPage = ({ initialTab, snapshot, name, t, refresh }: { initialTab: CompanionTab; snapshot: Snapshot; name: string; t: Translator; refresh: () => Promise<void> }): JSX.Element => {
  const [tab, setTab] = useState<CompanionTab>(initialTab);
  // The check-in card and its advanced rules edit one policy; a save in either reloads the other.
  const [careRevision, setCareRevision] = useState({ card: 0, advanced: 0 });
  const locale = snapshot.app.resolvedLocale, zh = locale === 'zh-CN';
  const tabs: Array<[CompanionTab, string]> = [['look', zh ? '形象' : 'Look'], ['persona', zh ? '人设' : 'Persona'], ['voice', zh ? '声音' : 'Voice'], ['diary', zh ? '日记' : 'Diary'], ['care', zh ? '主动关心' : 'Check-ins']];
  return <section><Header eyebrow={t('nav.companion')} title={name} />
    <div className="memory-tabs" role="tablist">{tabs.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}</div>
    {tab === 'look' && <CompanionLook state={snapshot.character} name={name} t={t} refresh={refresh} />}
    {tab === 'persona' && <><PersonaSettings locale={locale} nickname={snapshot.relationship.nickname} /><CharacterSheetSettings locale={locale} /></>}
    {tab === 'voice' && <VoiceSettings locale={locale} />}
    {tab === 'diary' && <CompanionJournalSettings zh={zh} part="diary" />}
    {tab === 'care' && <>
      <CareSettings api={window.deskpet.automation} providers={snapshot.providers} activeProviderId={snapshot.app.activeProviderId ?? null} locale={locale} requestPermission={() => window.deskpet.permissions.request({ capabilityId: 'automation.text', duration: 'always' })}
        refreshKey={careRevision.advanced} onSaved={() => setCareRevision(current => ({ ...current, card: current.card + 1 }))} />
      <CompanionJournalSettings zh={zh} part="delivery" />
      <details className="settings-more"><summary>{zh ? '高级：问候规则与记录' : 'Advanced: check-in rules and records'}</summary><EventProactiveSettings api={window.deskpet.automation} providers={snapshot.providers} locale={locale}
        refreshKey={careRevision.card} onSaved={() => setCareRevision(current => ({ ...current, advanced: current.advanced + 1 }))} /></details>
    </>}
  </section>;
};

const CompanionLook = ({ state, name, t, refresh }: { state: CharacterState; name: string; t: Translator; refresh: () => Promise<void> }): JSX.Element => {
  const missingCore = state.coreState !== 'ready';
  const missingModel = state.modelState === 'missing' || state.modelState === 'invalid';
  const [error, setError] = useState(false);
  const perform = async (operation: () => Promise<unknown>): Promise<void> => {
    try { setError(false); await operation(); await refresh(); }
    catch { setError(true); }
  };
  return <div>{missingCore || missingModel ? <><h2>{t('setup.title')}</h2><p className="muted">{t('setup.security')}</p></> : <p className="muted">{t('ui.companionDetail')}</p>}
    {error ?<p role="alert" className="error-banner">{t('common.error')}</p> : null}
    {state.importError && <p role="alert" className="error-banner">{t(state.importError)}</p>}
    {state.pendingImportId !== null && <div role="status" className="panel"><p>{t('setup.loading')}</p><button type="button" className="secondary" onClick={() => void perform(() => window.deskpet.character.cancelImport())}>{t('setup.cancel')}</button></div>}
    {(missingCore || missingModel) ? <div className="setup-grid"><SetupStep number="1" title={t('setup.coreTitle')} detail={t('setup.coreDetail')} ready={!missingCore}><button type="button" onClick={() => void perform(() => window.deskpet.character.importCore())}>{t('setup.chooseCore')}</button></SetupStep><SetupStep number="2" title={t('setup.modelTitle')} detail={t('setup.modelDetail')} ready={!missingModel}><button type="button" disabled={missingCore} onClick={() => void perform(() => window.deskpet.character.importModel())}>{t('setup.chooseModel')}</button></SetupStep></div> : <div className="companion-page-grid"><div className="companion-preview-card"><LiveCompanion name={name} ready={state.modelState === 'ready'} t={t} /><small>{t('ui.livePreview')}</small></div><div className="panel companion-settings"><h2>{t('ui.modelDetails')}</h2><div className="setting-row"><label htmlFor="model-scale">{t('companion.scale')} · {Math.round(state.scale * 100)}%</label><input id="model-scale" type="range" min="0.2" max="3" step="0.1" value={state.scale} onChange={(event) => void perform(() => window.deskpet.character.setScale(Number(event.target.value)))} /></div><div className="setting-row"><label htmlFor="model-expression">{t('companion.expression')}</label><select id="model-expression" value={state.expression ?? ''} onChange={(event) => void perform(() => window.deskpet.character.setExpression(event.target.value || null))}><option value="">{t('companion.defaultExpression')}</option>{state.expressions.map((expression) => <option key={expression} value={expression}>{expression === 'Watermark' ? t('ui.watermark') : expression}</option>)}</select></div><p className="muted model-name">{state.modelName}</p><div className="button-row"><button type="button" onClick={() => void perform(() => window.deskpet.character.playAction('interact'))}>{t('companion.action')}</button><button type="button" className="secondary" onClick={() => void perform(() => window.deskpet.character.setScale(1))}>{t('ui.resetScale')}</button><button type="button" className="secondary" onClick={() => void perform(() => window.deskpet.character.importModel())}>{t('setup.changeModel')}</button></div></div></div>}
  </div>;
};

const SetupStep = ({ number, title, detail, ready, children }: { number: string; title: string; detail: string; ready: boolean; children: ReactNode }): JSX.Element => <article className={ready ? 'setup-step ready' : 'setup-step'}><span className="step-number">{ready ? '✓' : number}</span><div><h2>{title}</h2><p>{detail}</p>{children}</div></article>;

const FocusPage = ({ snapshot, t, refresh }: { snapshot: Snapshot; t: Translator; refresh: () => Promise<void> }): JSX.Element => {
  const [title, setTitle] = useState('');
  const [minutes, setMinutes] = useState(25);
  const [focus, setFocus] = useState(snapshot.focus);
  const [error, setError] = useState(false);
  const [pendingTaskStates, setPendingTaskStates] = useState<Record<string, DeskTask['status']>>({});
  useEffect(() => { setFocus(snapshot.focus); }, [snapshot.focus]);
  useEffect(() => {
    if (focus?.status !== 'running') return;
    let cancelled = false;
    const timer = setInterval(() => {
      void window.deskpet.tasks.getFocus().then((current) => { if (!cancelled) setFocus(current); })
        .catch(() => { if (!cancelled) setError(true); });
    }, 1_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [focus?.status]);
  const perform = async (operation: () => Promise<unknown>): Promise<void> => {
    setError(false);
    try { await operation(); setFocus(await window.deskpet.tasks.getFocus()); await refresh(); }
    catch { setError(true); }
  };
  const addTask = async (event: FormEvent) => {
    event.preventDefault();
    if (title.trim().length === 0) return;
    await perform(async () => {
      await window.deskpet.tasks.upsert({ id: crypto.randomUUID(), title: title.trim(), notes: '', status: 'todo', dueAt: null });
      setTitle('');
    });
  };
  const toggleTask = async (task: DeskTask): Promise<void> => {
    const status = task.status === 'done' ? 'todo' : 'done';
    setPendingTaskStates((current) => ({ ...current, [task.id]: status }));
    try {
      await perform(() => window.deskpet.tasks.upsert({ id: task.id, title: task.title, notes: task.notes, dueAt: task.dueAt, status }));
    } finally {
      setPendingTaskStates((current) => {
        const next = { ...current };
        delete next[task.id];
        return next;
      });
    }
  };
  const active = focus?.status === 'running' || focus?.status === 'paused';
  const remaining = focus === null ? minutes * 60 : Math.max(0, focus.plannedSeconds - focus.elapsedSeconds);
  const time = `${Math.floor(remaining / 60).toString().padStart(2, '0')}:${(remaining % 60).toString().padStart(2, '0')}`;
  return <section><Header eyebrow={t('nav.focus')} title={t('focus.title')} />
    {error ? <p role="alert">{t('common.error')}</p> : null}
    <div className="two-column"><div className="panel focus-panel">
      <div className="focus-time" aria-label={t('focus.remaining')}>{time}</div>
      {focus?.status === 'completed' ? <p role="status">{t('focus.finished')}</p> : null}
      <label>{t('form.duration')}<input type="number" min="1" max="1440" disabled={active} value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} /></label>
      <div className="button-row">
        {!active ? <button type="button" onClick={() => void perform(() => window.deskpet.tasks.startFocus({ taskId: null, plannedSeconds: minutes * 60 }))}>{t('focus.start')}</button>
          : focus?.status === 'running' ? <button type="button" onClick={() => void perform(() => window.deskpet.tasks.pauseFocus())}>{t('focus.pause')}</button>
            : <button type="button" onClick={() => void perform(() => window.deskpet.tasks.resumeFocus())}>{t('focus.resume')}</button>}
        <button type="button" className="secondary" disabled={!active} onClick={() => void perform(() => window.deskpet.tasks.stopFocus('completed'))}>{t('focus.complete')}</button>
      </div>
    </div><div className="panel"><h2>{t('tasks.title')}</h2><form className="inline-form" onSubmit={(event) => void addTask(event)}><input aria-label={t('form.title')} value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t('form.title')} /><button type="submit">{t('tasks.add')}</button></form>
      <ul className="simple-list">{snapshot.tasks.map((task) => <li key={task.id}><input type="checkbox" aria-label={task.title} disabled={pendingTaskStates[task.id] !== undefined} checked={(pendingTaskStates[task.id] ?? task.status) === 'done'} onChange={() => void toggleTask(task)} /><strong>{task.title}</strong></li>)}</ul>
    </div></div>
  </section>;
};

const MemoryPage = ({ onUseQuery, conversationBusy, currentSessionTitle, items, t, refresh, providers, activeProviderId, currentSessionId, locale, onStartSession, openBatchId }: { onUseQuery(query: string): void; conversationBusy: boolean; currentSessionTitle: string; openBatchId?: string | undefined; onStartSession(): Promise<void>; locale: ResolvedLocale; items: MemoryItem[]; t: Translator; refresh: () => Promise<void>; providers: ProviderConfig[]; activeProviderId: string | null; currentSessionId: string }): JSX.Element => {
  const inbox = window.deskpet.wechatInbox;
  const [tab, setTab] = useState<'memories' | 'inbox' | 'imports' | 'consolidation' | 'nightly'>('memories');
  useEffect(() => { if (openBatchId) setTab('consolidation'); }, [openBatchId, currentSessionId]);
  const [text, setText] = useState(''); const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const pending = useRef<{ signature: string; id: string; operationId: string } | null>(null);
  const deletionOperations = useRef(new Map<string, string>());
  const startSession = async (): Promise<void> => {
    if (busy || conversationBusy) return;
    setBusy(true); setError('');
    try { await onStartSession(); }
    catch { setError('memory.saveFailed'); }
    finally { setBusy(false); }
  };
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); if (!text.trim() || busy) return;
    const values = { text: text.trim(), tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean) };
    const signature = JSON.stringify(values);
    if (pending.current?.signature !== signature) pending.current = { signature, id: crypto.randomUUID(), operationId: crypto.randomUUID() };
    setBusy(true); setError('');
    try {
      await window.deskpet.memory.upsert({ ...values, id: pending.current.id, operationId: pending.current.operationId, expectedRevision: 0 });
      pending.current = null; setText(''); setTags(''); await refresh();
    } catch (cause) { setError(cause instanceof Error && cause.message.includes('repository.commitUncertain') ? 'repository.commitUncertain' : 'memory.saveFailed'); }
    finally { setBusy(false); }
  };
  const localOnly = items.filter((item) => item.contextMetadata?.privacy === 'local-only').length;
  const [confirmShare, setConfirmShare] = useState(false);
  const shareAll = async (): Promise<void> => {
    if (busy) return;
    if (!confirmShare) { setConfirmShare(true); return; }
    setBusy(true); setError('');
    try { await window.deskpet.memory.shareAllWithCloud(); await refresh(); }
    catch (cause) { setError(cause instanceof Error && cause.message.includes('repository.commitUncertain') ? 'repository.commitUncertain' : 'memory.saveFailed'); }
    finally { setConfirmShare(false); setBusy(false); }
  };
  const remove = async (item: MemoryItem): Promise<void> => {
    if (busy) return; setBusy(true); setError('');
    const key = `${item.id}:${item.contextMetadata?.revision ?? 0}`;
    let operationId = deletionOperations.current.get(key);
    if (!operationId) { operationId = crypto.randomUUID(); deletionOperations.current.set(key, operationId); }
    try { await window.deskpet.memory.remove(item.id, { expectedRevision: item.contextMetadata?.revision ?? 0, operationId }); await refresh(); }
    catch (cause) { setError(cause instanceof Error && cause.message.includes('repository.commitUncertain') ? 'repository.commitUncertain' : cause instanceof Error && cause.message.includes('memory.forgetPending') ? 'memory.forgetPending' : cause instanceof Error && cause.message.includes('memory.forgetStale') ? 'memory.forgetStale' : 'memory.forgetFailed'); }
    finally { setBusy(false); }
  };
  return <section><Header eyebrow={t('nav.memory')} title={t('memory.title')} /><div className="memory-tabs" role="tablist"><button type="button" role="tab" aria-selected={tab === 'memories'} onClick={() => setTab('memories')}>{t('memory.title')}</button>{inbox && <button type="button" role="tab" aria-selected={tab === 'inbox'} onClick={() => setTab('inbox')}>{locale === 'zh-CN' ? '收件箱' : 'Inbox'}</button>}<button type="button" role="tab" aria-selected={tab === 'imports'} onClick={() => setTab('imports')}>{t('imports.tab')}</button><button type="button" role="tab" aria-selected={tab === 'consolidation'} onClick={() => setTab('consolidation')}>{locale === 'zh-CN' ? '手动整理' : 'Manual consolidation'}</button><button type="button" role="tab" aria-selected={tab === 'nightly'} onClick={() => setTab('nightly')}>{locale === 'zh-CN' ? '夜间整理' : 'Nightly tidy-up'}</button></div>{tab === 'inbox' && inbox ? <WeChatInboxPanel api={inbox} locale={locale} /> : tab === 'nightly' ? <MemorySleepPanel api={window.deskpet.memorySleep} locale={locale} onMemoryChanged={refresh}/> : tab === 'consolidation' ? <>{!currentSessionId && <button type="button" disabled={busy || conversationBusy} onClick={() => void startSession()}>{locale === 'zh-CN' ? '开始整理审阅' : 'Start consolidation review'}</button>}{error && <p role="alert">{t(error)}</p>}<MemoryConsolidation openBatchId={openBatchId} providers={providers} sessionId={currentSessionId} locale={locale} /></> : tab === 'imports' ? <ConversationImports t={t} providers={providers} activeProviderId={activeProviderId} refresh={refresh} /> : <>{window.deskpet.autoMemory && <AutoMemoryToggle api={window.deskpet.autoMemory} locale={locale} />}{localOnly > 0 && <div className="panel"><p>{locale === 'zh-CN' ? `有 ${localOnly} 条记忆标为仅本地，云端模型看不到。已经标为仅本地的旧对话不会因此改变。` : `${localOnly} memories are local-only, so cloud models cannot see them. Earlier conversations already marked local-only stay that way.`}</p><button type="button" disabled={busy} onClick={() => void shareAll()}>{confirmShare ? (locale === 'zh-CN' ? `确认：${localOnly} 条全部改为可发云端` : `Confirm: allow all ${localOnly} for cloud models`) : (locale === 'zh-CN' ? '全部改为可发云端' : 'Allow all for cloud models')}</button>{confirmShare && <button type="button" disabled={busy} onClick={() => setConfirmShare(false)}>{locale === 'zh-CN' ? '取消' : 'Cancel'}</button>}</div>}<div className="card-grid">{items.length === 0 ? <Empty text={t('memory.empty')} /> : items.map((item) => <article className="memory-card" key={item.id} data-memory-id={item.id}><p>{item.text}</p><div>{item.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}</div><MemoryContextControls key={`${item.id}:${item.contextMetadata?.revision ?? 0}:${currentSessionId}`} item={item} currentSessionId={currentSessionId} t={t} refresh={refresh} /><ConfirmButton label={t('common.delete')} confirmLabel={locale === 'zh-CN' ? '确认删除' : 'Delete'} cancelLabel={t('common.cancel')} disabled={busy} onConfirm={() => void remove(item)} /></article>)}</div><details className="settings-more memory-add"><summary>{locale === 'zh-CN' ? '手动添加一条记忆' : 'Add a memory yourself'}</summary><div className="panel"><form className="stack-form" onSubmit={(event) => void save(event)}><textarea aria-label={t('form.text')} value={text} onChange={(event) => setText(event.target.value)} placeholder={t('form.text')} /><input aria-label={t('form.tags')} value={tags} onChange={(event) => setTags(event.target.value)} placeholder={t('form.tags')} /><button type="submit" disabled={busy}>{t('memory.add')}</button>{error && <p role="alert">{t(error)}</p>}</form></div></details>{window.deskpet.companionRecent && <CompanionRecentPanel api={window.deskpet.companionRecent} locale={locale} />}{window.deskpet.memoryRecall && <MemoryRecallPanel api={window.deskpet.memoryRecall} sessionId={currentSessionId || undefined} sessionTitle={currentSessionTitle} memoryVersion={items.map(item => `${item.id}:${item.contextMetadata?.revision ?? 0}`).sort().join('|')} locale={locale} onUseQuery={onUseQuery} continuationDisabled={conversationBusy} />}</>}</section>;
};


type SettingsEntry = 'general' | 'permissions' | 'qq' | 'telegram' | 'wechat' | 'knowledge' | 'minecraft';
type SettingsTab = SettingsEntry | 'providers' | 'plugins' | 'skills' | 'mcp' | 'sandbox' | 'privacy' | 'migration' | 'advanced';
// Single-entry groups need no heading; her own settings live on the companion page.
const SETTINGS_GROUPS: ReadonlyArray<{ zh: string; en: string; tabs: readonly SettingsTab[] }> = [
  { zh: '基础', en: 'Basics', tabs: ['general', 'providers'] },
  { zh: '聊天渠道', en: 'Channels', tabs: ['wechat', 'qq', 'telegram'] },
  { zh: '扩展', en: 'Extensions', tabs: ['plugins', 'skills', 'mcp', 'knowledge', 'sandbox', 'minecraft'] },
  { zh: '隐私与安全', en: 'Privacy and security', tabs: ['permissions', 'privacy'] },
  { zh: '系统', en: 'System', tabs: ['migration', 'advanced'] },
];
const SettingsPage = ({ snapshot, t, refresh, initialTab, onOpenSession }: { snapshot: Snapshot; t: Translator; refresh: () => Promise<void>; initialTab: SettingsEntry; onOpenSession(id: string): void }): JSX.Element => {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [diagnostics, setDiagnostics] = useState<DiagnosticSnapshot | null>(null);
  // Opening the diagnostics tab runs the check; the button only repeats it.
  useEffect(() => { if (tab === 'advanced') void window.deskpet.app.getDiagnostics().then(setDiagnostics).catch(() => undefined); }, [tab]);
  const zh = snapshot.app.resolvedLocale === 'zh-CN';
  const dedicated = window.deskpet.minecraftDedicated;
  return <section><Header eyebrow={t('nav.settings')} title={t('nav.settings')} /><div className="settings-layout"><div className="settings-tabs" role="tablist">{SETTINGS_GROUPS.map(group => <div className="settings-tab-group" key={group.tabs[0]}>
    <span className="settings-tab-heading">{zh ? group.zh : group.en}</span>
    {group.tabs.filter(id => id !== 'minecraft' || dedicated).map(id => <button type="button" role="tab" aria-selected={tab === id} key={id} onClick={() => setTab(id)}>{id === 'minecraft' ? 'Minecraft' : t(`settings.${id}`)}</button>)}
  </div>)}</div><div className="settings-panel">
    {tab === 'general' && <GeneralSettings snapshot={snapshot} t={t} refresh={refresh} />}
    {tab === 'providers' && <ProviderSettings providers={snapshot.providers} activeId={snapshot.app.activeProviderId ?? snapshot.providers.find((item) => item.enabled)?.id ?? null} t={t} refresh={refresh} />}
    {tab === 'plugins' && <PluginsSettings providers={snapshot.providers} locale={snapshot.app.resolvedLocale} onPermissions={() => setTab('permissions')} onOpenSession={onOpenSession} refresh={refresh} />}
    {(tab === 'skills' || tab === 'mcp') && <DesktopExtensionsPanel key={tab} section={tab} api={window.deskpet.plugins.extensions} providers={snapshot.providers.filter(provider => provider.kind === 'ollama' && routingDestination(provider) === 'local')} zh={snapshot.app.resolvedLocale === 'zh-CN'} />}
    {tab === 'knowledge' && <KnowledgeSettings locale={snapshot.app.resolvedLocale} />}
    {tab === 'sandbox' && <SandboxSettings api={window.deskpet.vmSandbox} locale={snapshot.app.resolvedLocale} />}
    {tab === 'minecraft' && dedicated && <MinecraftDedicatedSettings api={dedicated} locale={snapshot.app.resolvedLocale} />}
    {tab === 'telegram' && <TelegramSettings providers={snapshot.providers} locale={snapshot.app.resolvedLocale} />}
    {tab === 'qq' && <QqSettings providers={snapshot.providers} locale={snapshot.app.resolvedLocale} />}
    {tab === 'wechat' && <WeChatSettings api={window.deskpet.wechat} locale={snapshot.app.resolvedLocale} />}
    {tab === 'permissions' && <PermissionSettings permissions={snapshot.permissions} t={t} refresh={refresh} />}
    {tab === 'privacy' && <DataSettings directory={snapshot.app.dataDirectory} t={t} />}
    {tab === 'migration' && <MigrationSettings t={t} refresh={refresh} />}
    {tab === 'advanced' && <div><h2>{t('diagnostics.title')}</h2><button type="button" className="secondary" onClick={() => void window.deskpet.app.getDiagnostics().then(setDiagnostics)}>{t('diagnostics.refresh')}</button>{diagnostics === null ? null : <details className="settings-more"><summary>{snapshot.app.resolvedLocale === 'zh-CN' ? '诊断详情（技术信息）' : 'Diagnostic details (technical)'}</summary><pre>{JSON.stringify(diagnostics, null, 2)}</pre></details>}</div>}
  </div></div></section>;
};

const MigrationSettings = ({ t, refresh }: { t: Translator; refresh: () => Promise<void> }): JSX.Element => {
  const [preview, setPreview] = useState<MigrationPreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [result, setResult] = useState<MigrationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => window.deskpet.migration.onProgress(setProgress), []);
  const review = async (): Promise<void> => {
    setError(null);
    try {
      const value = await window.deskpet.migration.preview();
      setPreview(value);
      setSelected(value.categories.filter((item) => item.count > 0).map((item) => item.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('common.error'));
    }
  };
  const start = async (): Promise<void> => {
    if (selected.length === 0 || preview?.available !== true) return;
    if (includeSecrets && !window.confirm(t('migration.secretsPrompt'))) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const value = await window.deskpet.migration.start({ categories: selected, confirmProviderSecrets: includeSecrets });
      setResult(value);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  };
  return <div><h2>{t('migration.title')}</h2><p>{t('migration.sourceReadOnly')}</p><p>{t('migration.emptyProfile')}</p>
    <button type="button" disabled={busy} onClick={() => void review()}>{t('migration.preview')}</button>
    {preview === null ? null : <div className="migration-preview"><code className="path-block">{preview.sourcePath ?? t('migration.notFound')}</code>
      {!preview.available && <p className="notice">{preview.warnings.map((warning) => t(`migration.warning.${warning}`)).join(' · ')}</p>}
      <div className="migration-categories">{preview.categories.map((category) => <label className="check-row" key={category.id}><input type="checkbox" checked={selected.includes(category.id)} disabled={busy || category.count === 0 || !preview.available} onChange={(event) => setSelected((items) => event.target.checked ? [...items, category.id] : items.filter((item) => item !== category.id))} /><span>{t(`migration.category.${category.id}`)}</span><strong>{category.count}</strong></label>)}</div>
      {preview.requiresKeychainConfirmation && selected.includes('providers') && <label className="check-row warning-check"><input type="checkbox" checked={includeSecrets} disabled={busy} onChange={(event) => setIncludeSecrets(event.target.checked)} />{t('migration.secretsConfirm')}</label>}
      <div className="button-row"><button type="button" disabled={busy || !preview.available || selected.length === 0} onClick={() => void start()}>{t('migration.start')}</button>{busy && <button type="button" className="secondary" onClick={() => void window.deskpet.migration.cancel()}>{t('migration.cancel')}</button>}</div>
    </div>}
    {progress === null ? null : <div className="migration-progress" aria-live="polite"><progress max={progress.total} value={progress.completed} /><span>{t(progress.messageCode)} · {progress.completed}/{progress.total}</span></div>}
    {result === null ? null : <div className="success-card" role="status"><strong>{t('migration.complete')}</strong><p>{Object.entries(result.imported).map(([key, count]) => `${t(`migration.category.${key}`)}: ${count}`).join(' · ')}</p></div>}
    {error === null ? null : <p className="error-banner" role="alert">{error}</p>}
  </div>;
};

const GeneralSettings = ({ snapshot, t, refresh }: { snapshot: Snapshot; t: Translator; refresh: () => Promise<void> }): JSX.Element => <div><h2>{t('settings.general')}</h2><div className="setting-row"><label htmlFor="language">{t('settings.language')}</label><select id="language" value={snapshot.app.locale} onChange={(event) => void window.deskpet.app.setLocale(event.target.value as AppState['locale']).then(refresh)}><option value="system">{t('settings.system')}</option><option value="en">{t('settings.english')}</option><option value="zh-CN">{t('settings.chinese')}</option></select></div><div className="setting-row"><label htmlFor="theme">{t('settings.theme')}</label><select id="theme" value={snapshot.app.theme} onChange={(event) => void window.deskpet.app.setTheme(event.target.value as AppState['theme']).then(refresh)}><option value="system">{t('settings.system')}</option><option value="light">{t('settings.light')}</option><option value="dark">{t('settings.dark')}</option></select></div><div className="setting-row"><label htmlFor="hotkey">{t('settings.hotkey')}</label><div className="setting-control"><HotkeyRecorder value={snapshot.app.hotkey} zh={snapshot.app.resolvedLocale === 'zh-CN'} onChange={async (next) => { await window.deskpet.app.setHotkey(next); await refresh(); }} /><span className={`status-pill ${snapshot.app.hotkeyRegistered ? 'succeeded' : 'failed'}`}>{snapshot.app.hotkeyRegistered ? t('capability.state.available') : t('capability.state.unavailable')}</span></div></div><StartupSettings app={snapshot.app} t={t} refresh={refresh} /><details className="settings-more"><summary>{t('settings.capabilities')}</summary><div className="capability-list">{snapshot.app.capabilities.map((item) => <CapabilityRow key={item.id} item={item} t={t} />)}</div></details></div>;

const CapabilityRow = ({ item, t }: { item: PlatformCapability; t: Translator }): JSX.Element => <div className="capability-row"><div><strong>{item.id}</strong><small>{t(item.reasonCode)}</small></div><span className={`status-pill ${item.state}`}>{t(`capability.state.${item.state}`)}</span></div>;

const Empty = ({ text }: { text: string }): JSX.Element => <div className="empty-state"><span aria-hidden="true">✦</span><p>{text}</p></div>;
