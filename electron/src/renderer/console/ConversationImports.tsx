import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { ActiveSpeakingStyle, ImportPreview, ImportState, ProviderConfig, SpeakingStyle } from '../../shared';

type Translate = (key: string) => string;
const errorKey = (error: unknown): string => error instanceof Error ? error.message.match(/(?:imports\.[A-Za-z]+|repository\.commitUncertain)/u)?.[0] ?? 'imports.failed' : 'imports.failed';
const styleFields = { tone: ['warm', 'neutral', 'playful', 'direct'], length: ['brief', 'balanced', 'detailed'], sentences: ['short', 'mixed'], emoji: ['none', 'light'] } as const;

const StyleSummary = ({ value, t }: { value: SpeakingStyle; t: Translate }): JSX.Element => <div className="import-style-summary">
  {Object.entries(styleFields).map(([key]) => <span className="tag" key={key}>{t(`imports.${key}`)}：{t(`imports.${value[key as keyof typeof styleFields]}`)}</span>)}
  {value.phrases.length > 0 && <p>{t('imports.phrases')}：{value.phrases.join(' / ')}</p>}
</div>;

const VoiceSettings = ({ value, t, saved }: { value: ActiveSpeakingStyle; t: Translate; saved(): Promise<void> }): JSX.Element => {
  const [style, setStyle] = useState(value.style); const [phrases, setPhrases] = useState(value.style.phrases.join('\n'));
  const [enabled, setEnabled] = useState(value.enabled); const [busy, setBusy] = useState(false); const [feedback, setFeedback] = useState('');
  const save = async (): Promise<void> => {
    if (busy) return; setBusy(true); setFeedback('');
    try {
      await window.deskpet.imports.setStyle({ enabled, style: { ...style, phrases: phrases.split('\n').map((phrase) => phrase.trim()).filter(Boolean) } });
      setFeedback('imports.styleSaved'); await saved();
    } catch (error) { setFeedback(errorKey(error)); } finally { setBusy(false); }
  };
  return <section className="panel import-voice"><h2>{t('imports.styleTitle')} · {value.name}</h2><p className="muted">{t('imports.styleNote')}</p>
    <label className="import-check"><input type="checkbox" checked={enabled} disabled={busy} onChange={(event) => setEnabled(event.target.checked)} />{t('imports.styleEnabled')}</label>
    <div className="import-style-fields">{Object.entries(styleFields).map(([key, values]) => <label key={key}>{t(`imports.${key}`)}<select value={style[key as keyof typeof styleFields]} disabled={busy} onChange={(event) => setStyle({ ...style, [key]: event.target.value })}>{values.map((option) => <option value={option} key={option}>{t(`imports.${option}`)}</option>)}</select></label>)}</div>
    <label>{t('imports.phrases')}<textarea value={phrases} disabled={busy} onChange={(event) => setPhrases(event.target.value)} /></label><p className="muted">{t('imports.phrasesHelp')}</p>
    <button type="button" disabled={busy || phrases.split('\n').filter((phrase) => phrase.trim()).length > 3 || phrases.split('\n').some((phrase) => phrase.trim().length > 16)} onClick={() => void save()}>{t('imports.styleSave')}</button>
    {feedback && <p role="status">{t(feedback)}</p>}
  </section>;
};

export const ConversationImports = ({ t, providers, activeProviderId, refresh }: {
  t: Translate; providers: ProviderConfig[]; activeProviderId: string | null; refresh(): Promise<void>;
}): JSX.Element => {
  const [state, setState] = useState<ImportState>({ records: [], activeStyle: null });
  const [preview, setPreview] = useState<ImportPreview | null>(null); const [name, setName] = useState('WeChat'); const [text, setText] = useState('');
  const [selectedRecord, setSelectedRecord] = useState(''); const [speakerId, setSpeakerId] = useState(''); const [isUser, setIsUser] = useState(false);
  const [messageIds, setMessageIds] = useState<string[]>([]); const [providerId, setProviderId] = useState(activeProviderId ?? providers.find((provider) => provider.enabled)?.id ?? '');
  const [checkedFacts, setCheckedFacts] = useState<string[]>([]); const [factText, setFactText] = useState<Record<string, string>>({}); const [applyStyle, setApplyStyle] = useState(false);
  const [busy, setBusy] = useState(false); const [distilling, setDistilling] = useState(false); const pending = useRef(false);
  const [error, setError] = useState(''); const [feedback, setFeedback] = useState('');
  const record = state.records.find((item) => item.id === selectedRecord); const draft = record?.draft;
  const provider = providers.find((item) => item.id === providerId && item.enabled);
  const speakers = [...new Map(record?.messages.map((message) => [message.speakerId, message.speaker]) ?? []).entries()];
  const samples = record?.messages.filter((message) => message.speakerId === speakerId) ?? [];
  const selectedCharacters = samples.filter((sample) => messageIds.includes(sample.id)).reduce((count, sample) => count + sample.text.length, 0);
  const load = async (): Promise<void> => { setState(await window.deskpet.imports.getState()); };
  useEffect(() => { void window.deskpet.imports.getState().then(setState).catch((reason: unknown) => setError(errorKey(reason))); }, []);
  useEffect(() => { setCheckedFacts([]); setFactText({}); setApplyStyle(false); }, [selectedRecord, draft?.id]);
  const act = async (operation: () => Promise<void>): Promise<void> => {
    if (pending.current) return; pending.current = true; setBusy(true); setError(''); setFeedback('');
    try { await operation(); } catch (reason) { setError(errorKey(reason)); }
    finally { pending.current = false; setBusy(false); }
  };
  const chooseRecord = (id: string): void => { setSelectedRecord(id); setSpeakerId(''); setMessageIds([]); setIsUser(false); setFeedback(''); setError(''); };
  const chooseSpeaker = (id: string): void => { setSpeakerId(id); setIsUser(false); setMessageIds(record?.messages.filter((message) => message.speakerId === id).slice(-50).map((message) => message.id) ?? []); };
  const distill = async (): Promise<void> => {
    if (!record || !provider) return; setDistilling(true);
    try { const result = await window.deskpet.imports.distill({ id: record.id, speakerId, isUser, messageIds, providerId: provider.id }); setState((value) => ({ ...value, records: value.records.map((item) => item.id === result.id ? result : item) })); }
    finally { setDistilling(false); }
  };
  const apply = async (): Promise<void> => {
    if (!record || !draft) return;
    setState(await window.deskpet.imports.apply({ id: record.id, draftId: draft.id, applyStyle, memories: draft.memories.filter((memory) => checkedFacts.includes(memory.id) && memory.savedMemoryId === null).map((memory) => ({ id: memory.id, text: (factText[memory.id] ?? memory.text).trim() })) }));
    setCheckedFacts([]); setApplyStyle(false); setFeedback('imports.applied'); await refresh();
  };
  return <div className="conversation-imports">
    <p>{t('imports.intro')}</p><p className="muted">{t('imports.formatHelp')}</p>
    {error && <p role="alert" className="error-banner">{t(error)}</p>}{feedback && <p role="status">{t(feedback)}</p>}
    <details className="panel import-input" open={state.records.length === 0 || preview !== null}><summary>{t('imports.title')}</summary>
      <div className="stack-form"><label>{t('imports.name')}<input maxLength={240} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
        <label>{t('imports.text')}<textarea rows={6} maxLength={60_000} value={text} disabled={busy} placeholder={t('imports.placeholder')} onChange={(event) => setText(event.target.value)} /></label>
        <div className="import-actions"><button type="button" disabled={busy || !name.trim() || !text.trim()} onClick={() => void act(async () => { setPreview(await window.deskpet.imports.preview({ name: name.trim(), text })); })}>{t('imports.preview')}</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => void act(async () => { const result = await window.deskpet.imports.pickFile(); if (result) setPreview(result); })}>{t('imports.pickFile')}</button></div>
      </div>
    </details>
    {preview && <section className="panel import-preview"><h2>{t('imports.previewTitle')} · {preview.name}</h2><p>{preview.format} · {t('imports.textCount')} {preview.messages.length} · {t('imports.skippedCount')} {preview.skipped}</p>
      <ol className="import-message-list">{preview.messages.slice(0, 20).map((message) => <li key={message.id}><strong>{message.speaker}</strong>{message.time && <small>{message.time}</small>}<p>{message.text}</p></li>)}</ol>
      {preview.messages.length > 20 && <p>{t('imports.previewLimit')}</p>}
      <button type="button" disabled={busy} onClick={() => void act(async () => { const result = await window.deskpet.imports.savePreview(preview.id); await load(); chooseRecord(result.id); setPreview(null); setText(''); setFeedback('imports.saved'); })}>{t('imports.savePreview')}</button>
      <button type="button" className="secondary" disabled={busy} onClick={() => setPreview(null)}>{t('common.cancel')}</button>
    </section>}
    <section className="panel"><label>{t('imports.records')}<select value={selectedRecord} disabled={busy} onChange={(event) => chooseRecord(event.target.value)}><option value="">{t('imports.records')}</option>{state.records.map((item) => <option value={item.id} key={item.id}>{item.name} · {item.messages.length}</option>)}</select></label>
      {state.records.length === 0 && <p>{t('imports.empty')}</p>}
      {record && <><div className="import-source-heading"><span>{record.format} · {t('imports.textCount')} {record.messages.length} · {t('imports.skippedCount')} {record.skipped}</span><button type="button" className="text-button" disabled={busy} onClick={() => { if (window.confirm(t('imports.removeConfirm'))) void act(async () => { await window.deskpet.imports.remove(record.id); await load(); chooseRecord(''); }); }}>{t('imports.remove')}</button></div>
        <label>{t('imports.speaker')}<select value={speakerId} disabled={busy} onChange={(event) => chooseSpeaker(event.target.value)}><option value="">{t('imports.chooseSpeaker')}</option>{speakers.map(([id, speaker]) => <option value={id} key={id}>{speaker}{speakers.filter(([, name]) => name === speaker).length > 1 ? ` · ${id}` : ''} ({record.messages.filter((message) => message.speakerId === id).length})</option>)}</select></label>
        {speakerId && <><label className="import-check"><input type="checkbox" checked={isUser} disabled={busy} onChange={(event) => setIsUser(event.target.checked)} />{t('imports.isUser')}</label><p className="muted">{t('imports.subjectHelp')}</p>
          <div className="import-actions"><button type="button" className="secondary" disabled={busy} onClick={() => setMessageIds(samples.slice(-50).map((message) => message.id))}>{t('imports.selectRecent')}</button><button type="button" className="secondary" disabled={busy} onClick={() => setMessageIds([])}>{t('imports.clearSelection')}</button></div>
          <ol className="import-message-list import-source-messages">{samples.map((message) => <li key={message.id}><label className="import-check"><input type="checkbox" checked={messageIds.includes(message.id)} disabled={busy || (!messageIds.includes(message.id) && messageIds.length >= 100)} onChange={(event) => setMessageIds((ids) => event.target.checked ? [...ids, message.id] : ids.filter((id) => id !== message.id))} /><span><strong>{message.speaker}</strong>{message.time && <small>{message.time}</small>}<span className="import-message-text">{message.text}</span></span></label></li>)}</ol>
          <p>{t('imports.selected')} {messageIds.length} · {selectedCharacters} {t('imports.characters')}</p><p className="muted">{t('imports.selectionHelp')}</p>
          <label>{t('imports.provider')}<select value={providerId} disabled={busy} onChange={(event) => setProviderId(event.target.value)}>{providers.filter((item) => item.enabled).map((item) => <option value={item.id} key={item.id}>{item.name} · {item.model}</option>)}</select></label>
          <p className="import-destination">{provider ? `${t('imports.destination')} ${provider.name} · ${new URL(provider.baseUrl).host}` : t('imports.noProvider')}</p>
          <button type="button" disabled={busy || !provider || messageIds.length === 0 || selectedCharacters > 16_000} onClick={() => void act(distill)}>{t(distilling ? 'imports.distilling' : 'imports.distill')}</button>
          {distilling && <button type="button" className="secondary" onClick={() => void window.deskpet.imports.cancel(record.id).catch((reason: unknown) => setError(errorKey(reason)))}>{t('imports.cancel')}</button>}
        </>}
      </>}
    </section>
    {record && draft && <section className="panel import-draft"><h2>{t('imports.draftTitle')} · {draft.speaker}</h2><p className="muted">{t('imports.draftNote')}</p><p>{draft.providerName} · {draft.sourceMessageIds.length} {t('imports.textCount')}</p>
      <StyleSummary value={draft.style} t={t} /><label className="import-check"><input type="checkbox" checked={applyStyle} disabled={busy || draft.styleApplied} onChange={(event) => setApplyStyle(event.target.checked)} />{t(draft.styleApplied ? 'imports.factSaved' : 'imports.applyStyle')}</label>
      {draft.memories.length === 0 && <p>{t('imports.noFacts')}</p>}
      <div className="import-facts">{draft.memories.map((memory) => <article className="import-fact" key={memory.id}><label className="import-check"><input type="checkbox" checked={checkedFacts.includes(memory.id)} disabled={busy || memory.savedMemoryId !== null} onChange={(event) => setCheckedFacts((ids) => event.target.checked ? [...ids, memory.id] : ids.filter((id) => id !== memory.id))} />{t(memory.savedMemoryId ? 'imports.factSaved' : 'imports.saveFact')}</label>
        <textarea aria-label={t('imports.fact')} maxLength={2000} value={factText[memory.id] ?? memory.text} disabled={busy || memory.savedMemoryId !== null} onChange={(event) => setFactText((values) => ({ ...values, [memory.id]: event.target.value }))} />
        <details><summary>{t('imports.evidence')}</summary>{memory.evidenceIds.map((id) => { const source = record.messages.find((message) => message.id === id); return source && <blockquote key={id}><strong>{source.speaker}</strong><p>{source.text}</p></blockquote>; })}</details>
      </article>)}</div>
      <button type="button" disabled={busy || (!applyStyle && checkedFacts.length === 0) || draft.memories.some((memory) => checkedFacts.includes(memory.id) && !(factText[memory.id] ?? memory.text).trim())} onClick={() => void act(apply)}>{t('imports.apply')}</button>
    </section>}
    {state.activeStyle && <VoiceSettings key={`${state.activeStyle.importId}:${state.activeStyle.draftId}`} value={state.activeStyle} t={t} saved={load} />}
  </div>;
};
