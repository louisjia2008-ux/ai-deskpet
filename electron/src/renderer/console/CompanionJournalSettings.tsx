import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { ConfirmButton } from './ConfirmButton';
import type { CompanionPreferences, DiaryEntry } from '../../shared/companion-journal';

/** One part per place it is shown: check-in delivery under check-ins, the diary on its own tab, the voice preference beside voice settings. */
export const CompanionJournalSettings = ({ zh, part }: { zh: boolean; part: 'delivery' | 'diary' | 'voice' }): JSX.Element | null => {
  const api = window.deskpet.journal;
  const [preferences, setPreferences] = useState<CompanionPreferences | null>(null), [entries, setEntries] = useState<DiaryEntry[]>([]);
  const [selected, setSelected] = useState<DiaryEntry | null>(null), [text, setText] = useState('');
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  useEffect(() => { if (api) void Promise.all([api.preferences().then(setPreferences), api.list().then(setEntries)]).catch(() => setFailed(true)); }, [api]);
  const act = async (work: () => Promise<unknown>): Promise<void> => { if (busy) return; setBusy(true); setFailed(false); try { await work(); setEntries(await api!.list()); } catch { setFailed(true); } finally { setBusy(false); } };
  const configure = (patch: Partial<CompanionPreferences>): void => { if (preferences) void act(async () => setPreferences(await api!.configure({ ...preferences, ...patch }))); };
  if (!api) return null;
  return <section className="panel persona-settings" aria-label={part === 'diary' ? (zh ? '日记' : 'Diary') : zh ? '主动消息投递' : 'Check-in delivery'}>
    {preferences && (part === 'voice' ? <label className="check-row"><input type="checkbox" disabled={busy} checked={preferences.wechatVoice} onChange={e => configure({ wechatVoice: e.target.checked })} />{zh ? '微信主动消息优先发语音（失败且尚未发送时退回文字）' : 'Prefer voice for WeChat check-ins (fall back to text only before any send attempt)'}</label>
      : part === 'delivery' ? <label>{zh ? '主动消息发到哪里' : 'Where to send check-ins'}<select disabled={busy} value={preferences.destination} onChange={e => configure({ destination: e.target.value as CompanionPreferences['destination'] })}>
        <option value="desktop">{zh ? '桌面' : 'Desktop'}</option><option value="wechat">{zh ? '已绑定的微信私聊' : 'Bound WeChat private chat'}</option><option value="both">{zh ? '桌面和微信' : 'Desktop and WeChat'}</option></select></label>
      : <><label className="check-row"><input type="checkbox" disabled={busy} checked={preferences.diaryEnabled} onChange={e => configure({ diaryEnabled: e.target.checked })} />{zh ? '每晚写日记' : 'Write a nightly diary'}</label>
        <p>{zh ? '只把允许云端处理的主人私聊和记忆交给当前云端模型。日记加密保存在本机。编辑后的日记只用于本地模型。' : 'Uses only cloud-allowed owner chats and memories with the current cloud model. Diaries are encrypted locally. Edited diaries are used only by local models.'}</p>
        <ul>{entries.map(entry => <li key={entry.date}><button type="button" disabled={busy} onClick={() => { setSelected(entry); setText(entry.text); }}>{entry.date}</button></li>)}</ul>
        {!entries.length && <p>{zh ? '还没有日记。夜间记忆整理后会写一篇，断档时最多补一篇。' : 'No diaries yet. Writes after nightly memory tidy-up; catches up at most one missed night.'}</p>}
        {selected && <article aria-label={zh ? '编辑日记' : 'Edit diary'}><h3>{selected.date}</h3><textarea aria-label={zh ? '日记正文' : 'Diary text'} value={text} maxLength={6000} disabled={busy} onChange={e => setText(e.target.value)} />
          <button type="button" disabled={busy || !text.trim()} onClick={() => void act(async () => { await api.edit({ date: selected.date, revision: selected.revision, text }); setSelected(null); })}>{zh ? '保存日记' : 'Save diary'}</button>
          <ConfirmButton key={`${selected.date}:${selected.revision}`} label={zh ? '删除日记' : 'Delete diary'} confirmLabel={zh ? `确认删除 ${selected.date} 的日记` : `Delete the ${selected.date} diary`} cancelLabel={zh ? '取消' : 'Cancel'} disabled={busy} onConfirm={() => void act(async () => { await api.remove({ date: selected.date, revision: selected.revision }); setSelected(null); })} /></article>}</>)}
    {failed && <p role="alert">{zh ? '操作失败，可能已在其他窗口修改。请重新打开后重试。' : 'Could not complete this operation. Reopen to refresh changes made elsewhere.'}</p>}
  </section>;
};
