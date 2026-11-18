import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { VmSandboxAPI, VmSandboxStatus } from '../../shared/vm-sandbox';
import './persona-settings.css';

const copy = {
  en: {
    title: 'Sandbox virtual machine',
    intro: 'A separate Linux computer inside this Mac where a model can run real commands: write and run code, install packages, process files.',
    limits: 'What it can reach: the internet, and one shared folder, "DeskPet Sandbox" in your home. What it cannot: your other files, apps and passwords, anything running on this Mac, your local network. Commands run without administrator rights and stop after a time limit.',
    asks: 'Only desktop chat can use it, with local or cloud models. The first command of each task asks for your approval, and private conversations cannot use it.',
    caution: 'Treat files that appear in the shared folder like downloads from the internet: look before you open or run them.',
    unavailable: 'Lima is not installed. Install it with "brew install lima", then reopen this page.',
    absent: 'Not set up.', stopped: 'Set up and stopped. It starts by itself when a command needs it.', running: 'Running. It stops by itself after 15 minutes without commands.',
    broken: 'The machine is damaged. Remove it and set it up again.',
    setup: 'Set up', settingUp: 'Setting up. The first time downloads Ubuntu and installs tools, about 10 minutes…', starting: 'Starting…',
    stop: 'Stop now', stopping: 'Stopping…', remove: 'Remove the machine', removing: 'Removing…', confirm: 'Remove it and everything inside it? The shared folder stays.',
    cancel: 'Cancel', folder: 'Open the shared folder', failed: 'That did not finish. Check your network connection and try again.',
  },
  'zh-CN': {
    title: '沙盒虚拟机',
    intro: '这台 Mac 里一台独立的 Linux 电脑，模型可以在里面运行真正的命令：写代码并运行、安装软件包、处理文件。',
    limits: '它能碰到的：互联网，以及一个共享文件夹（你主目录下的“DeskPet Sandbox”）。它碰不到的：你的其他文件、应用和密码，这台 Mac 上运行的任何服务，你的局域网。命令没有管理员权限，超时会被停止。',
    asks: '只有桌面聊天能用，本地和云端模型都可以。每个任务的第一条命令需要你批准；私密会话不能使用。',
    caution: '共享文件夹里出现的文件，请当作从网上下载的文件对待：打开或运行前先看一眼。',
    unavailable: '没有安装 Lima。用“brew install lima”安装后，重新打开此页。',
    absent: '尚未建立。', stopped: '已建立，当前未运行。需要执行命令时会自动启动。', running: '运行中。15 分钟没有命令会自动停止。',
    broken: '虚拟机已损坏。请删除后重新建立。',
    setup: '建立', settingUp: '正在建立。首次需要下载 Ubuntu 并安装工具，大约 10 分钟…', starting: '正在启动…',
    stop: '立即停止', stopping: '正在停止…', remove: '删除虚拟机', removing: '正在删除…', confirm: '删除虚拟机和里面的全部内容？共享文件夹会保留。',
    cancel: '取消', folder: '打开共享文件夹', failed: '没有完成。请检查网络后重试。',
  },
} as const;

export const SandboxSettings = ({ api, locale }: { api: VmSandboxAPI; locale: 'en' | 'zh-CN' }): JSX.Element => {
  const t = copy[locale];
  const [status, setStatus] = useState<VmSandboxStatus | null>(null);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    void api.status().then(setStatus).catch(() => undefined);
    return api.onChanged(setStatus);
  }, [api]);
  if (status === null) return <section className="panel persona-settings" aria-label={t.title}><h2>{t.title}</h2></section>;
  const act = (work: () => Promise<VmSandboxStatus>): void => { setConfirming(false); void work().then(setStatus).catch(() => undefined); };
  const busy = status.busy !== null;
  const line = status.busy === 'setup' ? (status.state === 'absent' ? t.settingUp : t.starting) : status.busy === 'stop' ? t.stopping : status.busy === 'remove' ? t.removing : t[status.state];
  return <section className="panel persona-settings" aria-label={t.title}>
    <div><h2>{t.title}</h2><p>{t.intro}</p></div>
    <p className="muted">{t.limits}</p>
    <p className="muted">{t.asks}</p>
    <p className="muted">{t.caution}</p>
    <p role="status">{line}</p>
    {status.failed && !busy && <p role="alert" className="error-banner">{t.failed}</p>}
    {status.state !== 'unavailable' && <div className="button-row">
      {status.state === 'absent' && <button type="button" disabled={busy} onClick={() => act(api.setup)}>{t.setup}</button>}
      {status.state === 'running' && <button type="button" className="secondary" disabled={busy} onClick={() => act(api.stop)}>{t.stop}</button>}
      {status.state !== 'absent' && !confirming && <button type="button" className="secondary" disabled={busy} onClick={() => setConfirming(true)}>{t.remove}</button>}
      <button type="button" className="secondary" onClick={() => void api.openFolder()}>{t.folder}</button>
    </div>}
    {confirming && <div className="button-row" role="group" aria-label={t.confirm}><span>{t.confirm}</span>
      <button type="button" className="danger" disabled={busy} onClick={() => act(api.remove)}>{t.remove}</button>
      <button type="button" className="secondary" onClick={() => setConfirming(false)}>{t.cancel}</button>
    </div>}
  </section>;
};
