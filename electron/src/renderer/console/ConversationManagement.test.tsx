import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentRef } from 'react';

import type { ChatSession, ChatSessionListOptions, DeskPetApi } from '../../shared';
import { messages } from '../../shared';
import { ConversationManager, ConversationMenu, useConversationActions } from './ConversationManagement';
import { consoleCopy } from './console-copy';

const session: ChatSession = { id: '01234567-89ab-4def-8123-456789abcdef', title: 'Memory check', kind: 'normal', createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z' };
const t = (key: string): string => consoleCopy.en[key] ?? (messages.en as Record<string, string>)[key] ?? key;
let api: DeskPetApi['chat'];
const changed = vi.fn(async () => undefined);
const originalShowModal = Object.getOwnPropertyDescriptor(window.HTMLDialogElement.prototype, 'showModal');

beforeEach(() => {
  Object.defineProperty(window.HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: ComponentRef<'dialog'>) { this.open = true; } });
  api = {
    openSession: vi.fn(), onOpenRequested: () => () => undefined,
    getInteraction: vi.fn(async () => null), followup: vi.fn(), resolveApproval: vi.fn(),
    listSessions: vi.fn(async () => [session]), createSession: vi.fn(), setModelSelection: vi.fn(), listMessages: vi.fn(), send: vi.fn(), retry: vi.fn(), forgetMemory: vi.fn(), editMemory: vi.fn(), cancel: vi.fn(),
    renameSession: vi.fn(async (id, title) => ({ ...session, id, title })),
    setPinned: vi.fn(), setArchived: vi.fn(), removeSession: vi.fn(async () => ({ ...session, deletedAt: '2026-10-23T00:00:00Z' })), restoreSession: vi.fn(),
    onEvent: () => () => undefined, onSessionsChanged: () => () => undefined,
  };
  Object.defineProperty(window, 'deskpet', { value: { chat: api }, configurable: true });
  changed.mockClear();
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks();
  if (originalShowModal) Object.defineProperty(window.HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(window.HTMLDialogElement.prototype, 'showModal');
});

const Harness = ({ disabled = false }: { disabled?: boolean }) => {
  const actions = useConversationActions(t, changed);
  return <><ConversationMenu session={session} t={t} disabled={disabled || actions.pending !== null} onAction={actions.act} />{actions.dialog}{actions.feedback}</>;
};
const openMenu = (): void => { fireEvent.click(screen.getByRole('button', { name: 'Conversation actions: Memory check' })); };

describe('conversation actions', () => {
  it('supports keyboard navigation and validates and trims a renamed title', async () => {
    render(<Harness />);
    fireEvent.keyDown(screen.getByRole('button'), { key: 'ArrowDown' });
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Rename conversation' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'End' });
    expect(within(menu).getByRole('menuitem', { name: 'Delete' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename conversation' }));
    const dialog = screen.getByRole('dialog');
    const title = within(dialog).getByRole('textbox', { name: 'Title' });
    fireEvent.change(title, { target: { value: '  ' } });
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(title, { target: { value: '  记忆与会话验收  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.renameSession).toHaveBeenCalledWith(session.id, '记忆与会话验收'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ title: '记忆与会话验收' }));
  });

  it('requires the delete confirmation, preserves it on failure, and only reports a completed save', async () => {
    render(<Harness />);
    openMenu(); fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Recently deleted');
    expect(screen.getByRole('dialog')).toHaveTextContent('Saved memories');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.removeSession).not.toHaveBeenCalled();
    openMenu(); fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    vi.mocked(api.removeSession).mockRejectedValueOnce(new Error('Fixture disk failure'));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not update');
    expect(changed).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.removeSession).toHaveBeenLastCalledWith(session.id);
    expect(changed).toHaveBeenCalledOnce();
    expect(screen.getByRole('status')).toHaveTextContent('Moved to Recently deleted');
  });

  it('blocks duplicate pending changes and disables actions during a reply', async () => {
    let resolve!: (value: ChatSession) => void;
    vi.mocked(api.setPinned).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const view = render(<Harness />);
    openMenu(); fireEvent.click(screen.getByRole('menuitem', { name: 'Pin conversation' }));
    expect(screen.getByRole('button', { name: 'Conversation actions: Memory check' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Conversation actions: Memory check' }));
    expect(api.setPinned).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalled();
    await act(async () => resolve({ ...session, pinnedAt: '2026-10-23T00:00:00Z' }));
    view.rerender(<Harness disabled />);
    expect(screen.getByRole('button', { name: 'Conversation actions: Memory check' })).toBeDisabled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('ignores stale search responses when switching to deleted conversations and offers restoration', async () => {
    let finishOldSearch!: (value: ChatSession[]) => void;
    vi.mocked(api.listSessions).mockImplementation(async (options: ChatSessionListOptions = {}) => {
      if (options.scope === 'deleted') return [{ ...session, title: 'Deleted test chat', deletedAt: '2026-10-23T00:00:00Z' }];
      if (options.query === 'older search') return new Promise((resolve) => { finishOldSearch = resolve; });
      return [session];
    });
    const onAction = vi.fn(); const onSelect = vi.fn();
    render(<ConversationManager t={t} locale="en" busy={false} onAction={onAction} onSelect={onSelect} />);
    await screen.findByRole('button', { name: 'Memory check' });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'older search' } });
    await waitFor(() => expect(api.listSessions).toHaveBeenCalledWith({ scope: 'active', query: 'older search' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Recently deleted' }));
    await screen.findByText('Deleted test chat');
    await act(async () => finishOldSearch([{ ...session, title: 'Stale result' }]));
    expect(screen.queryByText('Stale result')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deleted test chat' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restore conversation' }));
    expect(onAction).toHaveBeenCalledWith('restore', expect.objectContaining({ id: session.id }));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
