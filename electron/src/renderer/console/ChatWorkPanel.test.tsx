import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatWorkPanelApi } from '../../shared/chat-work-api';
import type { ChatHistoryHit, ChatHistoryReadPage, ChatWorkTask } from '../../shared/chat-work';
import type { ChatCronSchedule } from '../../shared/chat-cron';
import { ChatWorkPanel } from './ChatWorkPanel';

const task: ChatWorkTask = {
  id: 'task-1', sessionId: 'session-a', runId: 'run-1', assistantMessageId: 'assistant-1', goal: 'Summarize fixture sources into a file',
  status: 'completed', privacy: 'local-only', plan: ['Read fixture source', 'Write summary'], notes: 'Only the source returned by the tool was used.', nextStep: '',
  summary: 'Saved the summary.', createdAt: '2026-11-02T01:00:00Z', updatedAt: '2026-11-02T01:01:00Z',
  sources: [{ title: 'Fixture source', url: 'https://fixture.example/article', sha256: 'a'.repeat(64) }],
  artifacts: [{ path: 'reports/fixture.md', bytes: 120, sha256: 'b'.repeat(64) }], evidenceTruncated: false, historyLookupReferences: [],
};
const schedule: ChatCronSchedule = {
  id: 'cron-1', sessionId: 'session-a', providerId: 'provider-1', model: 'fixture-model', title: 'Morning fixture summary', instruction: 'Read the fixture and summarize it.',
  expression: '0 9 * * 1-5', timezone: 'Asia/Shanghai', allowedCapabilities: ['web.search', 'web.read', 'workspace.write'], missedPolicy: 'skip',
  enabled: true, revision: 1, nextRunAt: '2026-11-03T01:00:00Z', createdAt: '2026-11-02T01:00:00Z', updatedAt: '2026-11-02T01:00:00Z', cancelledAt: null,
};
const hit: ChatHistoryHit = { sessionId: 'session-earlier', sessionTitle: 'Earlier fixture conversation', messageId: 'message-old', role: 'assistant', createdAt: '2026-11-01T01:00:00Z', snippet: 'A literal remembered fixture', offset: 12, totalCharacters: 6000, privacy: 'local-only', sourceSHA256: 'c'.repeat(64) };
const excerpt: ChatHistoryReadPage = { ...hit, text: 'FIRST_LITERAL_HISTORY_EXCERPT', offset: 12, nextOffset: 4012, truncated: true, sourceSHA256: 'c'.repeat(64) };
const fixture = () => {
  Object.defineProperty(window, 'deskpet', { configurable: true, value: { plugins: { extensions: { saveMethod: vi.fn() } } } });
  const state = { tasks: [structuredClone(task)], schedules: [structuredClone(schedule)] };
  let changed = (): void => undefined;
  const unsubscribe = vi.fn();
  const api: ChatWorkPanelApi = {
    list: vi.fn(async (sessionId) => structuredClone(state.tasks.filter((item) => item.sessionId === sessionId))),
    get: vi.fn(async () => structuredClone(task)), openArtifact: vi.fn(async () => undefined),
    searchArtifacts: vi.fn(async () => ({ items: [], total: 0, nextOffset: null })), previewArtifact: vi.fn(), exportArtifactPdf: vi.fn(),
    searchHistory: vi.fn(async () => [structuredClone(hit)]), readHistory: vi.fn(async () => structuredClone(excerpt)),
    listCron: vi.fn(async (sessionId) => structuredClone(state.schedules.filter((item) => item.sessionId === sessionId))),
    pauseCron: vi.fn(async () => { state.schedules[0]!.enabled = false; state.schedules[0]!.nextRunAt = null; }),
    resumeCron: vi.fn(async () => { state.schedules[0]!.enabled = true; state.schedules[0]!.nextRunAt = schedule.nextRunAt; }),
    cancelCron: vi.fn(async () => { state.schedules[0]!.enabled = false; state.schedules[0]!.cancelledAt = '2026-11-02T02:00:00Z'; state.schedules[0]!.nextRunAt = null; }),
    onChanged: vi.fn((listener) => { changed = listener; return unsubscribe; }),
  };
  return { api, state, unsubscribe, changed: () => changed() };
};
const openPanel = async (): Promise<void> => {
  fireEvent.click(screen.getByText('Tasks, history & schedules'));
  await screen.findByText(task.goal);
};
afterEach(cleanup);

describe('ChatWorkPanel', () => {
  it('previews a recorded file and prepares a continuation for that exact version without sending it', async () => {
    const f = fixture(), continuing = vi.fn();
    vi.mocked(f.api.previewArtifact).mockResolvedValue({ artifact: { ...task.artifacts[0]!, sessionId: task.sessionId, taskId: task.id,
      sessionTitle: 'Synthetic source chat', goal: task.goal, updatedAt: task.updatedAt, status: task.status, archived: false }, kind: 'markdown', text: '# Local fixture preview' });
    render(<ChatWorkPanel sessionId="session-a" api={f.api} locale="en" onOpenSession={vi.fn()} onContinueArtifact={continuing} />);
    await openPanel(); fireEvent.click(screen.getByText(task.goal));
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByRole('heading', { name: 'Local fixture preview' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue editing' }));
    await waitFor(() => expect(continuing).toHaveBeenCalledWith({ sessionId: task.sessionId, taskId: task.id, path: 'reports/fixture.md', sha256: 'b'.repeat(64) }));
    expect(f.api.openArtifact).not.toHaveBeenCalled();
  });

  it('edits a derived PDF through the verified source in the same task and refuses a stale source', async () => {
    const f = fixture(), continuing = vi.fn(), source = { ...task.artifacts[0]!, sessionId: task.sessionId, taskId: task.id,
      sessionTitle: 'Synthetic source chat', goal: task.goal, updatedAt: task.updatedAt, status: task.status, archived: false };
    const pdf = { ...source, path: 'exports/fixture.pdf', sha256: 'd'.repeat(64),
      derivedFrom: { path: source.path, sha256: source.sha256, format: 'pdf-export' as const } };
    f.state.tasks[0]!.artifacts.push({ path: pdf.path, sha256: pdf.sha256, bytes: pdf.bytes, derivedFrom: pdf.derivedFrom });
    vi.mocked(f.api.previewArtifact).mockResolvedValueOnce({ artifact: pdf, kind: 'pdf', dataBase64: 'JVBERg==' })
      .mockResolvedValueOnce({ artifact: source, kind: 'markdown', text: '# Synthetic source' });
    render(<ChatWorkPanel sessionId="session-a" api={f.api} locale="en" onOpenSession={vi.fn()} onContinueArtifact={continuing} />);
    await openPanel(); fireEvent.click(screen.getByText(task.goal));
    fireEvent.click(screen.getByRole('button', { name: 'Edit source' }));
    const sourceReference = { sessionId: task.sessionId, taskId: task.id, path: source.path, sha256: source.sha256 };
    await waitFor(() => expect(continuing).toHaveBeenCalledWith(sourceReference));
    expect(f.api.previewArtifact).toHaveBeenNthCalledWith(1, { ...sourceReference, path: pdf.path, sha256: pdf.sha256 });
    expect(f.api.previewArtifact).toHaveBeenNthCalledWith(2, sourceReference);
    expect(screen.getByText('Edit the source file, then export a new PDF.')).toBeVisible();
    continuing.mockClear();
    vi.mocked(f.api.previewArtifact).mockResolvedValueOnce({ artifact: pdf, kind: 'pdf', dataBase64: 'JVBERg==' }).mockRejectedValueOnce(new Error('chat.artifactChanged'));
    fireEvent.click(screen.getByRole('button', { name: 'Edit source' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('file has changed');
    expect(continuing).not.toHaveBeenCalled();
  });

  it('keeps a standalone PDF viewable but disables continuation without an editable source', async () => {
    const f = fixture(), continuing = vi.fn(); f.state.tasks[0]!.artifacts = [{ path: 'standalone.pdf', bytes: 100, sha256: 'e'.repeat(64) }];
    render(<ChatWorkPanel sessionId="session-a" api={f.api} locale="en" onOpenSession={vi.fn()} onContinueArtifact={continuing} />);
    await openPanel(); fireEvent.click(screen.getByText(task.goal));
    expect(screen.getByRole('button', { name: 'Continue editing' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Preview' })).toBeEnabled();
    expect(screen.getByText('This PDF has no recorded editable source file.')).toBeVisible();
    expect(continuing).not.toHaveBeenCalled();
  });

  it('starts collapsed and reveals the recorded artifact through its task and conversation identity', async () => {
    const f = fixture(); render(<ChatWorkPanel sessionId="session-a" api={f.api} locale="en" onOpenSession={vi.fn()} />);
    expect(screen.getByTestId('chat-work-panel')).not.toHaveAttribute('open');
    await openPanel(); fireEvent.click(screen.getByText(task.goal));
    expect(screen.getByText('https://fixture.example/article')).toBeVisible();
    expect(screen.getByText('reports/fixture.md')).toBeVisible();
    expect(screen.getByText('Only the source returned by the tool was used.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Show file' }));
    await waitFor(() => expect(f.api.openArtifact).toHaveBeenCalledWith({ sessionId: 'session-a', taskId: 'task-1', path: 'reports/fixture.md' }));
    expect(f.api.searchHistory).not.toHaveBeenCalled(); expect(f.api.pauseCron).not.toHaveBeenCalled();
  });

  it('searches and reads literal history pages with host offsets, then opens the originating conversation', async () => {
    const f = fixture(), open = vi.fn();
    vi.mocked(f.api.readHistory).mockResolvedValueOnce(excerpt).mockResolvedValueOnce({ ...excerpt, offset: 4012, text: 'SECOND_LITERAL_HISTORY_EXCERPT', nextOffset: null, truncated: false });
    render(<ChatWorkPanel sessionId="session-a" api={f.api} locale="en" onOpenSession={open} />); await openPanel();
    fireEvent.change(screen.getByLabelText('History query'), { target: { value: 'remembered' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText(hit.snippet);
    expect(f.api.searchHistory).toHaveBeenCalledWith({ sessionId: 'session-a', query: 'remembered', limit: 20 });
    fireEvent.click(screen.getByRole('button', { name: 'Read excerpt' }));
    await screen.findByText(excerpt.text);
    expect(f.api.readHistory).toHaveBeenCalledWith({ sessionId: 'session-a', messageId: 'message-old', offset: 12, maxCharacters: 4000 });
    fireEvent.click(screen.getByRole('button', { name: 'Next excerpt' }));
    await screen.findByText('SECOND_LITERAL_HISTORY_EXCERPT');
    expect(f.api.readHistory).toHaveBeenLastCalledWith({ sessionId: 'session-a', messageId: 'message-old', offset: 4012, maxCharacters: 4000 });
    expect(screen.queryByRole('button', { name: 'Next excerpt' })).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Open conversation' })[0]!);
    expect(open).toHaveBeenCalledWith('session-earlier');
    fireEvent.click(screen.getByLabelText('Only this conversation'));
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(f.api.searchHistory).toHaveBeenLastCalledWith({ sessionId: 'session-a', targetSessionId: 'session-a', query: 'remembered', limit: 20 }));
  });

  it('manages schedule state and confirms cancellation while keeping the saved record visible', async () => {
    const f = fixture(); render(<ChatWorkPanel sessionId="session-a" api={f.api} locale="en" onOpenSession={vi.fn()} />); await openPanel();
    expect(screen.getByText('0 9 * * 1-5')).toBeVisible(); expect(screen.getByText('Asia/Shanghai')).toBeVisible();
    expect(screen.getByText(/they do not run after the app exits/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await screen.findByRole('button', { name: 'Resume' });
    expect(f.api.pauseCron).toHaveBeenCalledWith({ sessionId: 'session-a', id: 'cron-1' });
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await screen.findByRole('button', { name: 'Pause' });
    expect(f.api.resumeCron).toHaveBeenCalledWith({ sessionId: 'session-a', id: 'cron-1', expectedRevision: schedule.revision, allowedCapabilities: schedule.allowedCapabilities });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel schedule' }));
    expect(f.api.cancelCron).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
    await screen.findByText('Cancelled');
    expect(f.api.cancelCron).toHaveBeenCalledWith({ sessionId: 'session-a', id: 'cron-1' });
    expect(screen.getByText(schedule.title)).toBeVisible(); expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
  });

  it('discards a late history result when the user switches conversations', async () => {
    const f = fixture(); let resolve!: (value: ChatHistoryHit[]) => void;
    vi.mocked(f.api.searchHistory).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const view = render(<ChatWorkPanel sessionId="session-a" api={f.api} locale="en" onOpenSession={vi.fn()} />); await openPanel();
    fireEvent.change(screen.getByLabelText('History query'), { target: { value: 'old secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    view.rerender(<ChatWorkPanel sessionId="session-b" api={f.api} locale="en" onOpenSession={vi.fn()} />);
    await act(async () => { resolve([{ ...hit, snippet: 'LATE_OLD_SESSION_TEXT' }]); });
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('LATE_OLD_SESSION_TEXT')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-work-panel')).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('Tasks, history & schedules'));
    await screen.findByText('No task records in this conversation yet.');
    expect(screen.getByLabelText('History query')).toHaveValue('');
  });

  it('refreshes from host notifications and reports failed file operations without making up success', async () => {
    const f = fixture(); vi.mocked(f.api.openArtifact).mockRejectedValueOnce(new Error('missing-file'));
    render(<ChatWorkPanel sessionId="session-a" api={f.api} locale="en" onOpenSession={vi.fn()} />); await openPanel();
    fireEvent.click(screen.getByText(task.goal)); fireEvent.click(screen.getByRole('button', { name: 'Show file' }));
    await screen.findByRole('alert');
    f.state.tasks[0]!.status = 'interrupted';
    await act(async () => { f.changed(); });
    const tasks = screen.getByRole('region', { name: 'Task records' });
    expect(within(tasks).getByText('Interrupted')).toBeVisible();
  });
});
