import { useEffect, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import { characterAge, characterDraft, defaultCharacterProfile, localDay } from '../../shared/character';
import type { CharacterProfile } from '../../shared/character';
import './persona-settings.css';

const copy = {
  en: {
    title: 'Who she is', intro: 'Her story, what she likes, her pet and her age. Used in your private chats on desktop, QQ and WeChat, never in groups.',
    privacy: 'This text is sent to whichever model is answering, including cloud models.',
    age: 'Age', ageSince: 'Counted from', ageNow: (age: number, next: string) => `Now ${age}; turns ${age + 1} on ${next}.`, ageNone: 'No age set: she does not grow up.',
    ownerBirthday: 'Your birthday (optional)', birthdayHelp: 'Month and day only (MM-DD). Leave blank to skip birthday hints.',
    bible: 'Character sheet', bibleHelp: 'Her background, personality, how she treats you and what she would never do. Write it like a description of a person, not a list of rules.',
    likes: 'Likes (one per line)', dislikes: 'Dislikes (one per line)', pet: 'Her pet',
    draft: 'Start from a draft', drafted: 'Draft loaded into the form. Not saved yet.',
    save: 'Save', saved: 'Saved. New replies use this.', failed: 'Not saved. Check the length of each field and try again.',
  },
  'zh-CN': {
    title: '她的设定', intro: '她的故事、喜好、宠物和年龄。用在你和她的私聊里（桌面、QQ、微信），不会用在群里。',
    privacy: '这些内容会发给当前回答的模型，包括云端模型。',
    age: '年龄', ageSince: '从哪天开始算', ageNow: (age: number, next: string) => `现在 ${age} 岁，${next} 满 ${age + 1} 岁。`, ageNone: '没有设置年龄，她不会长大。',
    ownerBirthday: '主人的生日（可选）', birthdayHelp: '只填月和日（MM-DD），留空则不提示。',
    bible: '设定书', bibleHelp: '她的来历、性格、怎么对你、绝对不会做的事。像描述一个人那样写，不用写成规则清单。',
    likes: '喜欢（一行一个）', dislikes: '讨厌（一行一个）', pet: '她的宠物',
    draft: '用草稿开始', drafted: '已填入草稿，还没有保存。',
    save: '保存设定', saved: '已保存，新的回复会用上。', failed: '保存失败。请检查各项长度后重试。',
  },
} as const;

const toLines = (value: readonly string[]): string => value.join('\n');
const fromLines = (value: string): string[] => value.split('\n').map((line) => line.trim()).filter(Boolean);
const today = (): string => localDay(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone);

export const CharacterSheetSettings = ({ locale }: { locale: 'en' | 'zh-CN' }): JSX.Element => {
  const t = copy[locale];
  const [profile, setProfile] = useState<CharacterProfile>(defaultCharacterProfile);
  const [likes, setLikes] = useState(''), [dislikes, setDislikes] = useState('');
  const [status, setStatus] = useState<'saved' | 'failed' | 'drafted' | null>(null);
  const [busy, setBusy] = useState(false);
  const show = (value: CharacterProfile): void => { setProfile(value); setLikes(toLines(value.likes)); setDislikes(toLines(value.dislikes)); };
  useEffect(() => { void window.deskpet.persona.getCharacter().then(show).catch(() => setStatus('failed')); }, []);
  const change = (patch: Partial<CharacterProfile>): void => { setStatus(null); setProfile((current) => ({ ...current, ...patch })); };
  // An age typed before a start day counts from today, as it will once saved.
  const age = characterAge({ age: profile.age, ageSince: profile.ageSince ?? today() }, today());
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setBusy(true); setStatus(null);
    try {
      // An age needs a day to count from; today is the natural start.
      const ageSince = profile.age === null ? null : profile.ageSince ?? today();
      show(await window.deskpet.persona.updateCharacter({ ...profile, ageSince, likes: fromLines(likes), dislikes: fromLines(dislikes) }));
      setStatus('saved');
    } catch { setStatus('failed'); }
    finally { setBusy(false); }
  };
  return <section className="panel persona-settings" aria-label={t.title}>
    <header><div><h2>{t.title}</h2><p>{t.intro}</p></div>
      <button type="button" className="secondary" disabled={busy} onClick={() => { show({ ...characterDraft(), ownerBirthday: profile.ownerBirthday }); setStatus('drafted'); }}>{t.draft}</button></header>
    <form onSubmit={(event) => void save(event)}>
      <div className="persona-row">
        <label>{t.age}<input type="number" min={1} max={120} disabled={busy} value={profile.age ?? ''}
          onChange={(event) => change({ age: event.target.value === '' ? null : Math.max(1, Math.min(120, Math.round(Number(event.target.value)))) })} /></label>
        <label>{t.ageSince}<input type="date" disabled={busy || profile.age === null} value={profile.ageSince ?? ''}
          onChange={(event) => change({ ageSince: event.target.value || null })} /></label>
      </div>
      <small>{age ? t.ageNow(age.age, age.nextBirthday) : t.ageNone}</small>
      <label>{t.ownerBirthday}<input type="text" placeholder="MM-DD" maxLength={5} pattern="[0-9]{2}-[0-9]{2}" value={profile.ownerBirthday ?? ''}
        aria-describedby="character-owner-birthday-help" disabled={busy} onChange={event => change({ ownerBirthday: event.target.value || undefined })} /></label>
      <small id="character-owner-birthday-help">{t.birthdayHelp}</small>
      <label>{t.bible}<textarea rows={8} maxLength={6_000} disabled={busy} value={profile.bible} onChange={(event) => change({ bible: event.target.value })} /></label>
      <small>{t.bibleHelp}</small>
      <div className="persona-row">
        <label>{t.likes}<textarea rows={4} disabled={busy} value={likes} onChange={(event) => { setStatus(null); setLikes(event.target.value); }} /></label>
        <label>{t.dislikes}<textarea rows={4} disabled={busy} value={dislikes} onChange={(event) => { setStatus(null); setDislikes(event.target.value); }} /></label>
      </div>
      <label>{t.pet}<textarea rows={2} maxLength={300} disabled={busy} value={profile.pet} onChange={(event) => change({ pet: event.target.value })} /></label>
      <p className="muted">{t.privacy}</p>
      <div className="persona-actions"><button type="submit" disabled={busy}>{t.save}</button>
        {status && <span role={status === 'failed' ? 'alert' : 'status'}>{t[status]}</span>}</div>
    </form>
  </section>;
};
