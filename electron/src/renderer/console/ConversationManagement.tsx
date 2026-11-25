import { createPortal } from 'react-dom';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePresence } from './use-presence';
import type { ComponentRef, FormEvent, JSX, KeyboardEvent } from 'react';
import { Archive, ArrowCounterClockwise, DotsThree, MagnifyingGlass, PencilSimple, PushPin, Trash, X } from '@phosphor-icons/react';

import type { ChatSession, ChatSessionListOptions, ResolvedLocale } from '../../shared';

type Translator = (key: string) => string;
export type ConversationAction = 'rename' | 'pin' | 'unpin' | 'archive' | 'unarchive' | 'delete' | 'restore';
// Each opening is its own dialog, so reopening one that is still leaving starts fresh instead of reusing the closing node.
type DialogRequest = { action: 'rename' | 'delete'; session: ChatSession; opening: number };

const actionKeys: Record<ConversationAction, string> = {
  rename: 'conversation.rename', pin: 'conversation.pin', unpin: 'conversation.unpin',
  archive: 'conversation.archive', unarchive: 'conversation.unarchive', delete: 'common.delete', restore: 'conversation.restore',
};

export const useConversationActions = (t: Translator, onChanged: (session: ChatSession) => Promise<void>) => {
  const [request, setRequest] = useState<DialogRequest | null>(null);
  const openings = useRef(0);
  const [pending, setPending] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const perform = useCallback(async (action: ConversationAction, session: ChatSession, title?: string): Promise<void> => {
    if (pendingRef.current) return;
    pendingRef.current = true; setPending(session.id); setError(null); setNotice(null);
    try {
      let updated: ChatSession;
      switch (action) {
        case 'rename': updated = await window.deskpet.chat.renameSession(session.id, title ?? session.title); break;
        case 'pin': case 'unpin': updated = await window.deskpet.chat.setPinned(session.id, action === 'pin'); break;
        case 'archive': case 'unarchive': updated = await window.deskpet.chat.setArchived(session.id, action === 'archive'); break;
        case 'delete': updated = await window.deskpet.chat.removeSession(session.id); break;
        case 'restore': updated = await window.deskpet.chat.restoreSession(session.id); break;
      }
      await onChanged(updated);
      setRequest(null);
      setNotice(action === 'delete' ? 'conversation.deletedNotice' : 'conversation.saved');
    } catch (caught) {
      setError(caught instanceof Error && caught.message.includes('chat.sessionBusy') ? 'conversation.busy' : 'conversation.failed');
    } finally { pendingRef.current = false; setPending(null); }
  }, [onChanged]);
  const act = (action: ConversationAction, session: ChatSession): void => {
    if (pendingRef.current) return;
    setError(null); setNotice(null);
    if (action === 'rename' || action === 'delete') setRequest({ action, session, opening: ++openings.current });
    else void perform(action, session);
  };
  const shown = usePresence(request);
  return {
    act, pending,
    feedback: error !== null && request === null ? <div className="conversation-feedback error-banner" role="alert">{t(error)}<button type="button" className="icon-button" aria-label={t('conversation.dismiss')} onClick={() => setError(null)}><X size={16} /></button></div>
      : notice !== null ? <div className="conversation-feedback" role="status">{t(notice)}<button type="button" className="icon-button" aria-label={t('conversation.dismiss')} onClick={() => setNotice(null)}><X size={16} /></button></div> : null,
    dialog: shown.value === null ? null : <ConversationDialog key={shown.value.opening} request={shown.value} leaving={shown.leaving} pending={pending !== null} error={error} t={t} close={() => { if (!pendingRef.current) { setRequest(null); setError(null); } }} submit={(title) => perform(shown.value!.action, shown.value!.session, title)} />,
  };
};

const ConversationDialog = ({ request, leaving, pending, error, t, close, submit }: {
  request: DialogRequest; leaving: boolean; pending: boolean; error: string | null; t: Translator; close(): void; submit(title: string): Promise<void>;
}): JSX.Element => {
  const dialog = useRef<ComponentRef<'dialog'>>(null);
  const titleInput = useRef<ComponentRef<'input'>>(null);
  const [title, setTitle] = useState(request.session.title);
  useLayoutEffect(() => {
    dialog.current?.showModal();
    if (request.action === 'rename') titleInput.current?.select();
  }, [request.action]);
  // Closing hands focus back at once; the dialog then leaves before it unmounts.
  useLayoutEffect(() => { if (leaving && dialog.current?.open) dialog.current.close(); }, [leaving]);
  const save = (event: FormEvent): void => { event.preventDefault(); if (!pending && (request.action === 'delete' || title.trim().length > 0)) void submit(title.trim()); };
  return <dialog className="conversation-dialog" ref={dialog} inert={leaving} aria-labelledby="conversation-dialog-title" aria-describedby="conversation-dialog-detail" onCancel={(event) => { event.preventDefault(); if (!pending) close(); }}>
    <form onSubmit={save} aria-busy={pending}>
      <h2 id="conversation-dialog-title">{t(request.action === 'rename' ? 'conversation.rename' : 'conversation.deleteTitle')}</h2>
      <p id="conversation-dialog-detail">{t(request.action === 'rename' ? 'conversation.renameDetail' : 'conversation.deleteDetail')}</p>
      {request.action === 'rename' ? <label>{t('form.title')}<input ref={titleInput} value={title} maxLength={240} disabled={pending} onChange={(event) => setTitle(event.target.value)} /></label> : <p className="conversation-delete-name">{request.session.title}</p>}
      {error !== null && <p className="inline-error" role="alert">{t(error)}</p>}
      <div className="button-row"><button type="button" className="secondary" disabled={pending} onClick={close}>{t('common.cancel')}</button><button type="submit" className={request.action === 'delete' ? 'danger' : ''} disabled={pending || (request.action === 'rename' && title.trim().length === 0)}>{t(pending ? 'common.loading' : request.action === 'rename' ? 'common.save' : 'common.delete')}</button></div>
    </form>
  </dialog>;
};

export const ConversationMenu = ({ session, disabled, t, onAction }: {
  session: ChatSession; disabled: boolean; t: Translator; onAction(action: ConversationAction, session: ChatSession): void;
}): JSX.Element => {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const root = useRef<ComponentRef<'div'>>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<ComponentRef<'div'>>(null);
  const actions: ConversationAction[] = session.deletedAt ? ['restore'] : ['rename',
    ...(!session.archivedAt ? [session.pinnedAt ? 'unpin' as const : 'pin' as const] : []),
    session.archivedAt ? 'unarchive' : 'archive', 'delete'];
  const open = (): void => {
    const rect = trigger.current?.getBoundingClientRect();
    if (disabled || rect === undefined) return;
    setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 200)), top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - actions.length * 40 - 24)) });
  };
  useLayoutEffect(() => { if (position !== null) menu.current?.querySelector('button')?.focus(); }, [position]);
  useEffect(() => { if (disabled) setPosition(null); }, [disabled]);
  useEffect(() => {
    if (position === null) return;
    const outside = (event: globalThis.PointerEvent): void => { if (event.target instanceof window.Node && !root.current?.contains(event.target) && !menu.current?.contains(event.target)) setPosition(null); };
    const reposition = (): void => setPosition(null);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', reposition);
    document.addEventListener('scroll', reposition, true);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', reposition); document.removeEventListener('scroll', reposition, true); };
  }, [position]);
  const keyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setPosition(null); trigger.current?.focus(); return; }
    if (event.key === 'Tab') { setPosition(null); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = Array.from(menu.current?.querySelectorAll('button') ?? []);
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[index]?.focus();
  };
  const icons: Record<ConversationAction, JSX.Element> = { rename: <PencilSimple size={16} />, pin: <PushPin size={16} />, unpin: <PushPin size={16} weight="fill" />, archive: <Archive size={16} />, unarchive: <ArrowCounterClockwise size={16} />, delete: <Trash size={16} />, restore: <ArrowCounterClockwise size={16} /> };
  return <div className="conversation-menu" ref={root}>
    <button ref={trigger} type="button" className="icon-button conversation-menu-trigger" disabled={disabled} aria-label={`${t('conversation.actions')}: ${session.title}`} title={t('conversation.actions')} aria-haspopup="menu" aria-expanded={position !== null && !disabled} onClick={() => position === null ? open() : setPosition(null)} onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(); } }}><DotsThree size={20} weight="bold" /></button>
    {position !== null && !disabled && createPortal(<div ref={menu} className="conversation-popup" style={position} role="menu" aria-label={`${t('conversation.actions')}: ${session.title}`} onKeyDown={keyDown}>{actions.map((action) => <button key={action} type="button" role="menuitem" className={action === 'delete' ? 'destructive' : ''} onClick={() => { setPosition(null); trigger.current?.focus(); onAction(action, session); }}>{icons[action]}{t(actionKeys[action])}</button>)}</div>, document.querySelector('.app-shell') ?? document.body)}
  </div>;
};

export const ConversationManager = ({ t, locale, busy, onSelect, onAction }: {
  t: Translator; locale: ResolvedLocale; busy: boolean; onSelect(id: string): void; onAction(action: ConversationAction, session: ChatSession): void;
}): JSX.Element => {
  const [scope, setScope] = useState<NonNullable<ChatSessionListOptions['scope']>>('active');
  const [query, setQuery] = useState('');
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ key: string; items: ChatSession[] } | null>(null);
  const [error, setError] = useState(false);
  const key = JSON.stringify([scope, query.trim(), revision]);
  const reload = useCallback(() => setRevision((current) => current + 1), []);
  useEffect(() => window.deskpet.chat.onSessionsChanged(reload), [reload]);
  useEffect(() => {
    let cancelled = false;
    setError(false);
    const timer = setTimeout(() => {
      void window.deskpet.chat.listSessions({ scope, query: query.trim() }).then((items) => {
        if (!cancelled) setResult({ key, items });
      }).catch(() => { if (!cancelled) setError(true); });
    }, query.trim().length > 0 ? 160 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [scope, query, key]);
  const loading = result?.key !== key;
  const items = loading ? [] : result.items;
  return <section className="conversation-manager">
    <header className="page-header"><span>{t('nav.chat')}</span><h1>{t('conversation.manage')}</h1><p>{t('conversation.detail')}</p></header>
    <div className="conversation-search"><MagnifyingGlass size={18} /><input type="search" aria-label={t('conversation.search')} placeholder={t('conversation.search')} value={query} maxLength={240} onChange={(event) => setQuery(event.target.value)} /></div>
    <div className="conversation-tabs" role="tablist" aria-label={t('conversation.scope')}>{(['active', 'archived', 'deleted'] as const).map((value) => <button type="button" role="tab" aria-selected={scope === value} aria-controls="conversation-list" key={value} onClick={() => setScope(value)}>{t(`conversation.${value}`)}</button>)}</div>
    {scope !== 'active' && <p className="conversation-scope-note">{t(scope === 'archived' ? 'conversation.archivedDetail' : 'conversation.deletedDetail')}</p>}
    {busy && <p className="muted">{t('conversation.busy')}</p>}
    <div id="conversation-list" role="tabpanel" aria-label={t(`conversation.${scope}`)} aria-busy={loading && !error}>
      {error ? <p role="alert">{t('conversation.loadFailed')} <button type="button" onClick={reload}>{t('common.retry')}</button></p> : loading ? <p role="status">{t('common.loading')}</p> : items.length === 0 ? <div className="empty-state">{t(query.trim() ? 'conversation.noMatches' : 'conversation.empty')}</div> : <ul className="conversation-list">{items.map((session) => <li key={session.id} className="conversation-row" aria-label={session.title}>
        <div className="conversation-row-main">{session.deletedAt ? <strong>{session.title}</strong> : <button type="button" className="conversation-open" disabled={busy} onClick={() => onSelect(session.id)}>{session.pinnedAt && <PushPin size={14} weight="fill" aria-label={t('conversation.pinned')} />}<span>{session.title}</span></button>}
          <time dateTime={session.deletedAt ?? session.archivedAt ?? session.updatedAt}>{new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(session.deletedAt ?? session.archivedAt ?? session.updatedAt))}</time>
        </div>
        {session.deletedAt && <button type="button" className="secondary" disabled={busy} onClick={() => onAction('restore', session)}>{t('conversation.restore')}</button>}
        <ConversationMenu session={session} disabled={busy} t={t} onAction={onAction} />
      </li>)}</ul>}
    </div>
  </section>;
};
