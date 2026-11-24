import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, JSX } from 'react';
import { defaultPersona, personaDraftFromFile } from '../../shared/persona';
import type { Persona } from '../../shared/persona';
import './persona-settings.css';

const copy = {
  en: {
    title: 'Character', intro: 'Who your companion is and how it talks. Used in chat, check-ins and QQ.',
    privacy: 'This text is sent to whichever model is answering, including cloud models.',
    name: 'Name', addressUser: 'What it calls you', identity: 'Background', personality: 'Personality', speakingStyle: 'How it talks',
    examples: 'Example dialogue', boundaries: 'Things to avoid', catchphrases: 'Catchphrases (one per line)', tapLines: 'What it says when tapped (one per line)',
    shareStyle: 'Also use imported tone on cloud models', shareStyleHelp: 'Imported tone is kept to local models unless you allow this.',
    importFile: 'Import character card or notes', importHelp: 'A character card (.json) or notes (.md, .txt). Review it below, then save.', imported: 'Imported into the form. Not saved yet.', importFailed: 'That file could not be read.',
    save: 'Save character', saved: 'Saved. New replies use this character.', nicknameFailed: 'The character was saved, but the sidebar name was not updated. Save again to retry.', failed: 'Not saved. Check the length of each field and try again.',
  },
  'zh-CN': {
    title: '人格设定', intro: '她是谁、怎么说话。聊天、主动问候和 QQ 都会用到。',
    privacy: '这些内容会发给当前回答的模型，包括云端模型。',
    name: '名字', addressUser: '怎么称呼你', identity: '背景设定', personality: '性格', speakingStyle: '说话方式',
    examples: '示例对话', boundaries: '不要做的事', catchphrases: '口头禅（一行一个）', tapLines: '被点击时说的话（一行一个）',
    shareStyle: '导入的语气也用于云端模型', shareStyleHelp: '不勾选时，导入的语气只在本地模型上生效。',
    importFile: '导入角色卡或笔记', importHelp: '支持角色卡（.json）和笔记（.md、.txt）。导入后请在下方核对，再保存。', imported: '已填入表单，还没有保存。', importFailed: '这个文件读取失败。',
    save: '保存人设', saved: '已保存，新的回复会用这个人设。', nicknameFailed: '人设已保存，但侧边栏昵称没更新。再按一次保存重试。', failed: '保存失败。请检查各项长度后重试。',
  },
} as const;

const toLines = (value: readonly string[]): string => value.join('\n');
const fromLines = (value: string): string[] => value.split('\n').map((line) => line.trim()).filter(Boolean);

export const PersonaSettings = ({ locale, nickname = '' }: { locale: 'en' | 'zh-CN'; nickname?: string }): JSX.Element => {
  const t = copy[locale];
  const [persona, setPersona] = useState<Persona>(defaultPersona);
  const [catchphrases, setCatchphrases] = useState('');
  const [tapLines, setTapLines] = useState('');
  const [status, setStatus] = useState<'saved' | 'failed' | 'imported' | 'importFailed' | 'nicknameFailed' | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<globalThis.HTMLInputElement>(null);
  const show = (value: Persona): void => { setPersona(value); setCatchphrases(toLines(value.catchphrases)); setTapLines(toLines(value.tapLines)); };
  // The name given before this form existed fills the field until the owner saves one.
  useEffect(() => { void window.deskpet.persona.get().then((saved) => show(saved.name ? saved : { ...saved, name: nickname.slice(0, 40) })).catch(() => setStatus('failed')); }, [nickname]);
  const field = (key: 'name' | 'addressUser' | 'identity' | 'personality' | 'speakingStyle' | 'examples' | 'boundaries') => ({
    value: persona[key], disabled: busy,
    onChange: (event: ChangeEvent<globalThis.HTMLInputElement | globalThis.HTMLTextAreaElement>) => { setStatus(null); setPersona((current) => ({ ...current, [key]: event.target.value })); },
  });
  const importFile = async (event: ChangeEvent<globalThis.HTMLInputElement>): Promise<void> => {
    const chosen = event.target.files?.[0];
    event.target.value = '';
    if (!chosen) return;
    try { show(personaDraftFromFile(await chosen.text(), persona)); setStatus('imported'); }
    catch { setStatus('importFailed'); }
  };
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setBusy(true); setStatus(null);
    try {
      const saved = await window.deskpet.persona.update({ ...persona, catchphrases: fromLines(catchphrases), tapLines: fromLines(tapLines) });
      show(saved);
      // The sidebar name is part of this save: report success only once both are stored.
      if (saved.name && saved.name !== nickname) {
        try { await window.deskpet.relationship.setNickname(saved.name); setStatus('saved'); }
        catch { setStatus('nicknameFailed'); }
      } else setStatus('saved');
    }
    catch { setStatus('failed'); }
    finally { setBusy(false); }
  };
  return <section className="panel persona-settings" aria-label={t.title}>
    <header><div><h2>{t.title}</h2><p>{t.intro}</p></div>
      <button type="button" className="secondary" disabled={busy} onClick={() => file.current?.click()}>{t.importFile}</button>
      <input ref={file} type="file" hidden aria-label={t.importFile} accept=".json,.md,.txt,application/json,text/markdown,text/plain" onChange={(event) => void importFile(event)} /></header>
    <p className="muted">{t.importHelp}</p>
    <form onSubmit={(event) => void save(event)}>
      <div className="persona-row">
        <label>{t.name}<input maxLength={40} {...field('name')} /></label>
        <label>{t.addressUser}<input maxLength={40} {...field('addressUser')} /></label>
      </div>
      <label>{t.identity}<textarea rows={4} maxLength={2_000} {...field('identity')} /></label>
      <label>{t.personality}<textarea rows={3} maxLength={2_000} {...field('personality')} /></label>
      <label>{t.speakingStyle}<textarea rows={3} maxLength={2_000} {...field('speakingStyle')} /></label>
      <label>{t.examples}<textarea rows={4} maxLength={3_000} {...field('examples')} /></label>
      <label>{t.boundaries}<textarea rows={2} maxLength={1_000} {...field('boundaries')} /></label>
      <div className="persona-row">
        <label>{t.catchphrases}<textarea rows={3} disabled={busy} value={catchphrases} onChange={(event) => setCatchphrases(event.target.value)} /></label>
        <label>{t.tapLines}<textarea rows={3} disabled={busy} value={tapLines} onChange={(event) => setTapLines(event.target.value)} /></label>
      </div>
      <label className="check-row"><input type="checkbox" checked={persona.shareStyleWithCloud} disabled={busy} onChange={(event) => setPersona((current) => ({ ...current, shareStyleWithCloud: event.target.checked }))} />{t.shareStyle}</label>
      <small>{t.shareStyleHelp}</small>
      <p className="muted">{t.privacy}</p>
      <div className="persona-actions"><button type="submit" disabled={busy}>{t.save}</button>
        {status && <span role={status === 'failed' || status === 'importFailed' || status === 'nicknameFailed' ? 'alert' : 'status'}>{t[status]}</span>}</div>
    </form>
  </section>;
};
