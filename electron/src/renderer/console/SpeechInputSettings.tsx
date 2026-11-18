import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { SpeechInputSettings as Settings } from '../../shared/speech-input';

export const SpeechInputSettings = ({ zh }: { zh: boolean }): JSX.Element | null => {
  const api = window.deskpet.speech;
  const [settings, setSettings] = useState<Settings | null>(null), [failed, setFailed] = useState(false);
  useEffect(() => { void api?.status().then(setSettings).catch(() => setFailed(true)); }, [api]);
  const save = async (value: Settings): Promise<void> => { try { setSettings(await api!.configure(value)); setFailed(false); } catch { setFailed(true); } };
  if (!api) return null;
  return <section className="panel"><h3>{zh ? '语音输入' : 'Speech input'}</h3><p>{zh ? '只在使用麦克风时录音，最长60秒，本地识别。默认填入草稿，不发送。' : 'Records only when using the microphone, up to 60 seconds. Transcribes locally into the draft without sending by default.'}</p>
    {settings && <><label>{zh ? '录音方式' : 'Recording mode'}<select value={settings.mode} onChange={e => void save({ ...settings, mode: e.target.value as Settings['mode'] })}>
      <option value="hold">{zh ? '按住说话，松开结束' : 'Hold to talk, release to finish'}</option><option value="toggle">{zh ? '点一下开始，再点一下结束' : 'Click to start, click again to finish'}</option></select></label>
      <label className="check-row"><input type="checkbox" checked={settings.autoSend} onChange={e => void save({ ...settings, autoSend: e.target.checked })} />{zh ? '说完自动发送（已有草稿时仍只填入）' : 'Send after speaking (never sends an existing draft)'}</label></>}
    {failed && <p role="alert">{zh ? '语音输入设置读取或保存失败。' : 'Could not load or save speech input settings.'}</p>}</section>;
};
