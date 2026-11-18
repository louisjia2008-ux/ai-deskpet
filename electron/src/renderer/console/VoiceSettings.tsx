import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { VoiceProblem, VoiceStatus } from '../../shared/voice';
import './persona-settings.css';
import { SpeechInputSettings } from './SpeechInputSettings';
import { CompanionJournalSettings } from './CompanionJournalSettings';

const copy = {
  en: {
    title: 'Voice', intro: 'She reads her desktop chat replies aloud with a local voice model, and her mouth follows the sound. WeChat, QQ and groups are never read aloud.',
    memory: 'The model loads when she starts talking and is released after 10 quiet minutes.',
    enable: 'Read replies aloud', folder: 'Voice folder', none: 'No folder chosen', choose: 'Choose folder', test: 'Test voice', stop: 'Stop',
    help: 'The folder holds .venv (Python with mlx-audio), hf (the Qwen3-TTS 0.6B Base model cache) and voice/reference.wav with its transcript voice/reference.txt. To hear your WeChat voice messages and answer with voice notes, add silk-python to .venv and the Qwen3-ASR 1.7B model to hf.',
    state: { off: 'Off.', missing: 'The folder is not ready.', idle: 'Ready. The model loads on her next reply.', loading: 'Loading the voice model…', ready: 'Loaded.', speaking: 'Speaking…', error: 'The voice worker stopped while loading. Check the folder and try again.' },
    problem: { folder: 'Choose the voice folder.', python: 'Missing .venv/bin/python.', model: 'Missing the Qwen3-TTS 0.6B Base model in hf.', reference: 'Missing voice/reference.wav or voice/reference.txt.', worker: '' } satisfies Record<VoiceProblem, string>,
    failed: 'That did not work. Try again.',
  },
  'zh-CN': {
    title: '语音', intro: '她会用本地语音模型把桌面聊天的回复读出来，嘴型跟着声音动。微信、QQ 和群聊不会读。',
    memory: '她开口时才加载模型，安静 10 分钟后自动释放内存。',
    enable: '朗读她的回复', folder: '语音文件夹', none: '还没有选择文件夹', choose: '选择文件夹', test: '试听', stop: '停止',
    help: '文件夹里要有 .venv（装了 mlx-audio 的 Python）、hf（Qwen3-TTS 0.6B Base 模型缓存），以及 voice/reference.wav 和它的文字 voice/reference.txt。想让她听懂你在微信发的语音并用语音条回你，还要在 .venv 里装 silk-python，在 hf 里放 Qwen3-ASR 1.7B 模型。',
    state: { off: '已关闭。', missing: '文件夹还没准备好。', idle: '准备好了，下次回复时加载模型。', loading: '正在加载语音模型…', ready: '模型已加载。', speaking: '正在说话…', error: '语音进程在加载时退出了。请检查文件夹后重试。' },
    problem: { folder: '请选择语音文件夹。', python: '缺少 .venv/bin/python。', model: 'hf 里缺少 Qwen3-TTS 0.6B Base 模型。', reference: '缺少 voice/reference.wav 或 voice/reference.txt。', worker: '' } satisfies Record<VoiceProblem, string>,
    failed: '操作失败，请重试。',
  },
} as const;

export const VoiceSettings = ({ locale }: { locale: 'en' | 'zh-CN' }): JSX.Element => {
  const t = copy[locale];
  const api = window.deskpet.character;
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const act = async (operation: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setFailed(false);
    try { await operation(); setStatus(await api.getVoice()); }
    catch { setFailed(true); }
    finally { setBusy(false); }
  };
  useEffect(() => { void api.getVoice().then(setStatus).catch(() => setFailed(true)); }, [api]);
  // Loading and speaking change on their own; follow them until they settle.
  const settling = status?.state === 'loading' || status?.state === 'speaking';
  useEffect(() => {
    if (!settling) return;
    const timer = window.setInterval(() => void api.getVoice().then(setStatus).catch(() => undefined), 1_000);
    return () => window.clearInterval(timer);
  }, [api, settling]);
  const usable = status !== null && status.enabled && status.problem === null;
  return <><section className="panel persona-settings" aria-label={t.title}>
    <header><div><h2>{t.title}</h2><p>{t.intro}</p></div></header>
    <label className="check-row"><input type="checkbox" checked={status?.enabled ?? false} disabled={busy || status === null}
      onChange={(event) => void act(() => api.setVoiceEnabled(event.target.checked))} />{t.enable}</label>
    <div className="persona-row">
      <label>{t.folder}<input type="text" readOnly value={status?.runtimeDir ?? ''} placeholder={t.none} /></label>
      <div className="persona-actions"><button type="button" className="secondary" disabled={busy} onClick={() => void act(() => api.chooseVoiceFolder())}>{t.choose}</button></div>
    </div>
    <small>{t.help}</small>
    {status && <p role="status">{t.state[status.state]}{status.state === 'missing' && status.problem ? ` ${t.problem[status.problem]}` : ''}</p>}
    <p className="muted">{t.memory}</p>
    <div className="persona-actions">
      <button type="button" disabled={busy || !usable || status?.state === 'speaking'} onClick={() => void act(() => api.testVoice())}>{t.test}</button>
      {status?.state === 'speaking' && <button type="button" className="secondary" onClick={() => void act(() => api.stopVoice())}>{t.stop}</button>}
      {failed && <span role="alert">{t.failed}</span>}
    </div>
  </section><SpeechInputSettings zh={locale === 'zh-CN'} /><CompanionJournalSettings zh={locale === 'zh-CN'} part="voice" /></>;
};
