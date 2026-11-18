import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { ReaAPI, ReaResult, ReaTarget } from '../../shared/rea';
import './rea-analysis.css';

export const reaFailureText = (error: unknown, zh: boolean): string => {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const key = text.match(/rea\.([a-zA-Z]+)/u)?.[1];
  const messages: Record<string, [string, string]> = {
    disabled: ['REA 已关闭。请在插件设置中启用并保存。', 'REA is disabled. Enable it in plugin settings and save.'],
    runtimeMissing: ['REA 运行时文件缺失，请重新安装配套运行时。', 'REA runtime files are missing. Reinstall the matching runtime.'],
    serverIdentityMismatch: ['REA 服务身份与固定版本不一致，请重新安装配套运行时。', 'The REA server identity does not match the pinned version. Reinstall the matching runtime.'],
    runtimeUnavailable: ['尚未安装可用的 REA 运行时。请先检查运行时。', 'No usable REA runtime is installed. Check the runtime first.'],
    runtimeIdentityMismatch: ['REA 运行时文件与固定版本不一致，请重新安装配套运行时。', 'The REA runtime does not match the pinned version. Reinstall the matching runtime.'],
    runtimePathInvalid: ['REA 运行时路径不可用，请检查运行时安装。', 'The REA runtime path is unavailable. Check its installation.'],
    runtimePlatformUnsupported: ['当前系统暂不支持此 REA 运行时。', 'This REA runtime does not support the current platform.'],
    toolContractMismatch: ['REA 运行时接口与此版本 DeskPet 不兼容。', 'The REA runtime interface is incompatible with this DeskPet version.'],
    sessionUnavailable: ['分析会话已关闭或不可用，请开始一次新分析。', 'The analysis session is unavailable. Start a new analysis.'],
    sessionBusy: ['分析正在运行，请等待完成或取消。', 'Analysis is running. Wait for it to finish or cancel.'],
    targetOutOfScope: ['请选择独立的 JavaScript 应用目录，不要选择 DeskPet 用户数据目录或它的上层目录。', 'Choose a separate JavaScript application directory, outside the DeskPet profile and its parent directories.'],
    linkedTarget: ['请选择实际的应用目录或 app.asar，不能使用符号链接。', 'Choose the actual application directory or app.asar, rather than a symbolic link.'],
    targetTokenInvalid: ['所选目标已失效，请重新选择分析目标。', 'The selected target is no longer valid. Choose it again.'],
    targetChanged: ['目标文件已经变化，请重新选择后分析。', 'The target files changed. Select the target again.'],
    analysisTokenInvalid: ['分析结果已失效，请重新运行静态分析。', 'This analysis result is no longer available. Run static analysis again.'],
    retainedEvidenceUnavailable: ['运行时没有返回可查看的分析结果，请检查运行时兼容性。', 'The runtime did not return a retained analysis result. Check runtime compatibility.'],
    resultLimit: ['本次分析的结果数量已达上限，请关闭后开始新分析。', 'This analysis reached its result limit. Close it and start a new analysis.'],
    targetLimit: ['打开的分析目标过多，请先关闭当前分析。', 'Too many analysis targets are open. Close the current analysis first.'],
    cleanupUnconfirmed: ['未能确认分析进程已关闭，请再次取消或重启 DeskPet。', 'Could not confirm that the analysis process closed. Cancel again or restart DeskPet.'],
    toolTimeout: ['静态分析超时，请尝试较小的 JavaScript 目录。', 'Static analysis timed out. Try a smaller JavaScript directory.'],
    startupTimeout: ['REA 启动超时，请检查运行时。', 'REA startup timed out. Check the runtime.'],
  };
  if (key && messages[key]) return messages[key][zh ? 0 : 1];
  if (/permission|权限/u.test(text)) return zh ? '需要静态分析权限，请点击“分析权限”进行设置。' : 'Static analysis permission is required. Open Analysis permission to configure it.';
  if (/contextPrivacy|localExecution/u.test(text)) return zh ? '解读结果需要已确认在本机执行的模型，请检查模型设置。' : 'Interpreting results requires a model confirmed to run locally. Check model settings.';
  return zh ? '操作未完成。请检查分析权限和运行时状态后重试。' : 'The operation did not complete. Check analysis permission and runtime status, then retry.';
};

interface Props {
  api: ReaAPI;
  sessionId: string;
  providerId: string | null;
  model: string;
  locale: string;
  permissions(): void;
  embedded?: boolean;
  onInterpretationStarted?(): void;
}

export const ReaAnalysis = ({ api, sessionId, providerId, model, locale, permissions, embedded = false, onInterpretationStarted }: Props): JSX.Element => {
  const sessionRef = useRef({ id: sessionId, generation: 0, live: true });
  if (sessionRef.current.id !== sessionId) sessionRef.current = { id: sessionId, generation: sessionRef.current.generation + 1, live: true };
  const zh = locale === 'zh-CN';
  const [target, setTarget] = useState<ReaTarget | null>(null);
  const [result, setResult] = useState<ReaResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [question, setQuestion] = useState('');
  const [available, setAvailable] = useState<boolean | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    const context = sessionRef.current;
    context.live = true;
    busyRef.current = false;
    setTarget(null); setResult(null); setError(''); setBusy(false); setQuestion('');
    void api.status().then((status) => { if (context.live) setAvailable(status.available); }).catch(() => { if (context.live) setAvailable(false); });
    return () => {
      context.live = false;
      void api.cancel({ sessionId }).catch(() => undefined);
    };
  }, [api, sessionId]);

  const perform = async (run: (isCurrent: () => boolean) => Promise<void>): Promise<void> => {
    if (busyRef.current) return;
    const context = sessionRef.current;
    const generation = context.generation;
    const isCurrent = (): boolean => context.live && context === sessionRef.current && context.generation === generation;
    busyRef.current = true; setBusy(true); setError('');
    try { await run(isCurrent); }
    catch (caught) { if (isCurrent()) setError(reaFailureText(caught, zh)); }
    finally { if (isCurrent()) { busyRef.current = false; setBusy(false); } }
  };

  const contents = <div>
    <p>{zh ? '选择 app.asar 或 JavaScript 应用目录，运行静态分析，再查看摘要、模块与边界。分析不会运行目标应用。' : 'Choose app.asar or a JavaScript application directory, run static analysis, then inspect its summary, modules and boundaries. The target application is not executed.'}</p>
    <p className="plugin-hint">{zh ? '分析会在本机保存明文结果。只有点击模型解读，所选结果才会交给已确认的本地模型。' : 'Analysis saves plaintext results on this machine. Selected results are sent to a confirmed local model only when you request an interpretation.'}</p>
    <details className="rea-data-details"><summary>{zh ? '分析数据与本地模型' : 'Analysis data and local models'}</summary><p>{zh ? '明文工件保存在专用本地目录，不包含在加密用户数据备份内。模型解读使用独立的本地会话，不会调用联网或文件工具。运行时的分析进程没有系统级强制沙箱。' : 'Plaintext artifacts stay in a dedicated local directory outside encrypted profile backups. Model interpretation uses a separate local conversation without web or file tools. The analysis process has no OS-enforced sandbox.'}</p></details>
    {available === false && <p className="notice">{zh ? 'REA 当前不可用，请在上方检查运行时。' : 'REA is unavailable. Check its runtime above.'}</p>}
    <div className="button-row">
      <button type="button" disabled={!sessionId || busy || available !== true} onClick={() => void perform(async (isCurrent) => {
        if (target) await api.cancel({ sessionId });
        const chosen = await api.chooseTarget({ sessionId });
        if (isCurrent()) { setTarget(chosen); setResult(null); }
        else if (chosen) await api.cancel({ sessionId });
      })}>{zh ? '选择分析目标' : 'Choose analysis target'}</button>
      <button type="button" className="secondary" onClick={permissions}>{zh ? '分析权限' : 'Analysis permission'}</button>
      <button type="button" disabled={!target || busy} onClick={() => void perform(async (isCurrent) => { const value = await api.analyze({ sessionId, targetId: target!.id }); if (isCurrent()) setResult(value); })}>{busy ? zh ? '处理中…' : 'Working…' : zh ? '运行静态分析' : 'Run static analysis'}</button>
      <button type="button" className="secondary" disabled={!target && !busy} onClick={() => {
        const context = sessionRef.current;
        context.generation++;
        void api.cancel({ sessionId }).then(() => {
          if (context.live && context === sessionRef.current) { setTarget(null); setResult(null); busyRef.current = false; setBusy(false); setError(''); }
        }).catch(() => { if (context.live) setError(reaFailureText('rea.cleanupUnconfirmed', zh)); });
      }}>{zh ? '取消并关闭分析' : 'Cancel and close analysis'}</button>
    </div>
    {target && <p className="rea-target">{target.name} · {target.files} {zh ? '个文件' : 'files'}<span>SHA-256 {target.identitySHA256}</span></p>}
    {error && <p role="alert" className="notice">{error}</p>}
    {result && <>
      <p role="status">{zh ? '静态分析结果 · 仅本地' : 'Static analysis result · local only'}{result.truncated ? zh ? ' · 当前为片段' : ' · excerpt shown' : ''}</p>
      <pre>{result.text}</pre>
      <div className="button-row">{(['summary', 'modules', 'boundaries'] as const).map((view) => <button key={view} type="button" className="secondary" disabled={busy} onClick={() => void perform(async (isCurrent) => { const value = await api.inspect({ sessionId, targetId: target!.id, resultId: result.id, view }); if (isCurrent()) setResult(value); })}>{zh ? { summary: '查看摘要', modules: '查看模块', boundaries: '查看边界' }[view] : `Inspect ${view}`}</button>)}</div>
      <label>{zh ? '关于所选结果的问题' : 'Question about selected result'}<input value={question} maxLength={2000} onChange={(event) => setQuestion(event.target.value)} /></label>
      {!providerId && <p className="notice">{zh ? '可直接阅读分析结果。若要模型解读，请先在“模型与服务”中配置并确认一个在本机执行的模型。' : 'You can read the analysis directly. To interpret it with a model, configure a provider and confirm that it runs locally in Models & services.'}</p>}
      <button type="button" disabled={busy || !providerId || !question.trim()} onClick={() => void perform(async (isCurrent) => {
        await api.ask({ sessionId, resultId: result.id, question: question.trim(), providerId: providerId!, model });
        if (isCurrent()) { setQuestion(''); onInterpretationStarted?.(); }
      })}>{zh ? '以本地模型解读所选结果' : 'Ask local model about selected result'}</button>
    </>}
  </div>;
  return embedded ? <div className="rea-analysis rea-analysis-embedded">{contents}</div> : <details className="rea-analysis"><summary>REA · {zh ? '静态应用分析' : 'Static app analysis'}</summary>{contents}</details>;
};
