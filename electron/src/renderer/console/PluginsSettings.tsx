import { useEffect, useRef, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import type { ProviderConfig } from '../../shared';
import { pluginConfigurationSchema } from '../../shared/plugins';
import type { PluginProbe, PluginSettings, PluginState, WebPluginKind } from '../../shared/plugins';
import type { ReaAPI } from '../../shared/rea';
import { ReaAnalysis, reaFailureText } from './ReaAnalysis';
import './plugins-settings.css';

type ReaStatus = Awaited<ReturnType<ReaAPI['status']>> & { enabled?: boolean; reasonCode?: string; verified?: boolean; checkedAt?: string | null };
interface Props { providers: ProviderConfig[]; locale: string; onPermissions(): void; onOpenSession(id: string): void; refresh(): Promise<void> }

const localProvider = (provider: ProviderConfig): boolean => {
  if (!provider.enabled || provider.localExecutionConfirmed !== true || !['ollama', 'lm-studio', 'openai-compatible'].includes(provider.kind)) return false;
  try { const url = new URL(provider.baseUrl); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname); }
  catch { return false; }
};
const probeFailure = (code: string, zh: boolean): string => {
  const http = /^plugin\.(crawl|search)Http([45]\d\d)(?:\.(browser|navigation|extraction))?$/u.exec(code);
  if (http) {
    const api = http[1] === 'crawl' ? 'POST /crawl' : 'GET /search';
    const stage = http[3] ? ' · ' + ({browser: zh ? '浏览器启动' : 'browser startup', navigation: zh ? '打开目标网页' : 'navigation', extraction: zh ? '提取正文' : 'extraction'}[http[3]] ?? '') : '';
    return (zh ? '本地服务返回 ' : 'Local service returned ') + `HTTP ${http[2]} (${api})${stage}`;
  }
  if (/permission/iu.test(code)) return zh ? '需要联网工具权限，请在“管理插件权限”中允许后重试。' : 'Web tool permission is required. Open Manage plugin permissions and allow it, then retry.';
  if (/auth|token|unauthorized/iu.test(code)) return zh ? '服务拒绝了认证，请核对 Crawl4AI 令牌。' : 'Authentication was rejected. Check the Crawl4AI token.';
  if (/timeout/iu.test(code)) return zh ? '服务响应超时，请检查服务和代理后重试。' : 'The service timed out. Check the service and proxy, then retry.';
  if (/json|format/iu.test(code)) return zh ? '服务返回格式不正确，请确认 SearXNG 已启用 JSON 输出，并核对服务地址。' : 'The service returned an unexpected format. Enable SearXNG JSON output and verify the service URL.';
  if (/reaCleanupUnconfirmed/iu.test(code)) return zh ? 'REA 已关闭，但未能确认分析进程已退出。请再次保存以重试关闭；如仍失败，请重启 DeskPet。' : 'REA is disabled, but its analysis processes could not be confirmed closed. Save again to retry closing them; restart DeskPet if this continues.';
  if (/configurationRollbackFailed/iu.test(code)) return zh ? '保存未完成，令牌也未能恢复。请检查本地凭据存储，并重新保存令牌和插件设置。' : 'Saving failed and the previous token could not be restored. Check local credential storage, then save the token and plugin settings again.';
  if (/saveFailed/iu.test(code)) return zh ? '插件设置未保存，已保留上次配置。请检查本地存储后重试。' : 'Plugin settings were not saved; the previous configuration was kept. Check local storage, then retry.';
  if (/configurationChanged/iu.test(code)) return zh ? '测试期间配置已更改，请按最新配置重新测试。' : 'Configuration changed during the test. Retry with the saved configuration.';
  if (/searchEnginesUnavailable/iu.test(code)) return zh ? '搜索服务已连接，但上游搜索引擎不可用。请检查 SearXNG 的引擎和代理配置。' : 'The search service is connected, but its upstream engines are unavailable. Check SearXNG engines and proxy configuration.';
  if (/responseTooLarge/iu.test(code)) return zh ? '服务返回内容过大，请检查服务配置后重试。' : 'The service response is too large. Check its configuration and retry.';
  if (/empty|noResults/iu.test(code)) return zh ? '服务已响应，但没有返回可用结果，请检查搜索引擎与网络。' : 'The service responded without usable results. Check its search engines and network.';
  if (/target|url|config|endpoint/iu.test(code)) return zh ? '请使用本机服务地址，例如 http://127.0.0.1:8080，不要包含路径、账号或查询参数。' : 'Use a local service origin such as http://127.0.0.1:8080, without a path, credentials or query parameters.';
  return zh ? '测试未通过。请确认本地服务已启动，并检查服务地址、认证与代理。' : 'The test failed. Confirm that the local service is running and check its URL, authentication and proxy.';
};

export const PluginsSettings = ({ providers, locale, onPermissions, onOpenSession, refresh }: Props): JSX.Element => {
  const zh = locale === 'zh-CN';
  const [saved, setSaved] = useState<PluginState | null>(null);
  const [settings, setSettings] = useState<PluginSettings | null>(null);
  const [token, setToken] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [probes, setProbes] = useState<Partial<Record<WebPluginKind, PluginProbe>>>({});
  const [rea, setRea] = useState<ReaStatus | null>(null);
  const [analysisSession, setAnalysisSession] = useState<string | null>(null);
  const [interpretationStarted, setInterpretationStarted] = useState(false);
  const [providerId, setProviderId] = useState('');
  const live = useRef(true);
  const actionPending = useRef(false);
  const sessionRef = useRef<string | null>(null);
  const eligibleProviders = providers.filter(localProvider);
  const provider = eligibleProviders.find((item) => item.id === providerId) ?? eligibleProviders[0] ?? null;
  const dirty = !!saved && !!settings && (JSON.stringify(saved.settings) !== JSON.stringify(settings) || !!token || clearToken);

  const load = async (): Promise<void> => {
    setError('');
    try {
      const [state, status] = await Promise.all([window.deskpet.plugins.getState(), window.deskpet.rea.status()]);
      if (live.current) { setSaved(state); setSettings(state.settings); setRea(status); if (state.warningCode) setError(probeFailure(state.warningCode, zh)); }
    } catch { if (live.current) setError(zh ? '暂时无法读取插件设置，请重试。' : 'Could not load plugin settings. Please retry.'); }
  };
  useEffect(() => {
    live.current = true;
    void load();
    return () => { live.current = false; };
    // Loading is tied to this settings panel, not locale or parent refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const perform = async (name: string, action: () => Promise<void>): Promise<void> => {
    if (actionPending.current) return;
    actionPending.current = true; setBusy(name); setError(''); setNotice('');
    try { await action(); }
    catch (caught) { if (live.current) setError(name === 'rea' || name === 'start' ? reaFailureText(caught, zh) : probeFailure(caught instanceof Error ? caught.message : '', zh)); }
    finally { actionPending.current = false; if (live.current) setBusy(null); }
  };
  const updateWeb = (patch: Partial<PluginSettings['web']>): void => {
    setSettings((current) => current ? { ...current, web: { ...current.web, ...patch } } : current);
    setNotice(''); setProbes({});
  };
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!settings) return;
    const input = pluginConfigurationSchema.safeParse({ settings, ...(token.trim() ? { crawl4aiToken: token.trim() } : {}), ...(clearToken ? { clearCrawl4aiToken: true } : {}) });
    if (!input.success) { setError(zh ? '请检查本机服务地址和正文大小。地址只接受 localhost、127.0.0.1 或 ::1，正文大小为 1000–12000 个字符。' : 'Check the local service URLs and content size. Only localhost, 127.0.0.1 or ::1 origins are allowed; content size must be 1000–12000 characters.'); return; }
    await perform('save', async () => {
      const value = await window.deskpet.plugins.configure(input.data);
      if (!live.current) return;
      setSaved(value); setSettings(value.settings); setToken(''); setClearToken(false); setProbes({});
      if (!value.settings.rea.enabled) { sessionRef.current = null; setAnalysisSession(null); setInterpretationStarted(false); }
      const status = await window.deskpet.rea.status();
      if (!live.current) return;
      setRea(status);
      setNotice(zh ? '插件设置已保存。' : 'Plugin settings saved.');
      if (value.warningCode) setError(probeFailure(value.warningCode, zh));
      await refresh();
    });
  };
  const test = async (kind: WebPluginKind): Promise<void> => perform(kind, async () => {
    const value = await window.deskpet.plugins.test({ kind });
    if (live.current) setProbes((current) => ({ ...current, [kind]: value }));
  });
  const checkRuntime = async (): Promise<void> => perform('rea', async () => {
    const status = await window.deskpet.rea.checkRuntime();
    if (live.current) setRea(status);
  });
  const startAnalysis = async (): Promise<void> => perform('start', async () => {
    if (sessionRef.current) { await window.deskpet.rea.cancel({ sessionId: sessionRef.current }); sessionRef.current = null; setAnalysisSession(null); }
    const selected = await window.deskpet.chat.createSession({ title: zh ? 'REA 静态分析' : 'REA static analysis', kind: 'normal' });
    if (!live.current) { await window.deskpet.rea.cancel({ sessionId: selected.id }); return; }
    sessionRef.current = selected.id; setAnalysisSession(selected.id); setInterpretationStarted(false);
    await refresh();
  });
  const renderProbe = (kind: WebPluginKind): JSX.Element | null => {
    const probe = probes[kind];
    return probe ? <div role={probe.ok ? 'status' : 'alert'} className={`plugin-test-result ${probe.ok ? 'is-success' : 'is-error'}`}>
      <strong>{probe.ok ? probe.code === 'plugin.partialSearch' ? zh ? '搜索可用，部分上游暂时限流或不可用' : 'Search is available; some upstream engines are limited or unavailable' : kind === 'searxng' ? zh ? '搜索测试通过' : 'Search test passed' : zh ? '网页读取测试通过' : 'Page read test passed' : probeFailure(probe.code, zh)}</strong>
      {probe.ok && probe.resultCount !== undefined && <span>{zh ? `返回 ${probe.resultCount} 条结果` : `${probe.resultCount} results returned`}</span>}
      {probe.ok && probe.excerpt && <p>{probe.excerpt}</p>}
    </div> : null;
  };

  if (!settings || !saved) return <div className="plugin-settings"><h2>{zh ? '插件' : 'Plugins'}</h2>{error ? <><p role="alert">{error}</p><button type="button" onClick={() => void load()}>{zh ? '重新加载' : 'Reload'}</button></> : <p role="status">{zh ? '正在读取插件设置…' : 'Loading plugin settings…'}</p>}</div>;
  const reaEnabled = saved.settings.rea.enabled;
  const reaLabel = !reaEnabled ? zh ? '已关闭' : 'Disabled' : rea?.available ? zh ? '运行时就绪' : 'Runtime ready' : rea?.reasonCode === 'rea.runtimeNotChecked' ? zh ? '待检查' : 'Needs a check' : zh ? '运行时不可用' : 'Runtime unavailable';
  return <div className="plugin-settings">
    <div className="plugin-settings-heading"><div><h2>{zh ? '插件' : 'Plugins'}</h2><p>{zh ? '管理 Kitty 的联网工具与静态分析能力。' : 'Manage Kitty’s web tools and static analysis.'}</p></div><button type="button" className="secondary" onClick={onPermissions}>{zh ? '管理插件权限' : 'Manage plugin permissions'}</button></div>
    <form onSubmit={(event) => void save(event)} aria-label={zh ? '插件设置' : 'Plugin settings'}>
      <fieldset disabled={busy !== null} className="plugin-card">
        <div className="plugin-card-heading"><div><span className="plugin-category">{zh ? '联网工具' : 'WEB TOOLS'}</span><h3>SearXNG + Crawl4AI</h3></div><label className="plugin-toggle"><input type="checkbox" checked={settings.web.enabled} onChange={(event) => updateWeb({ enabled: event.target.checked })} />{zh ? '启用联网插件' : 'Enable web plugin'}</label></div>
        <p>{zh ? 'SearXNG 查找相关网址，Crawl4AI 提取网页正文。连接本机自托管服务，无需按次付费的搜索 API。' : 'SearXNG finds relevant URLs; Crawl4AI extracts page content. Connect your local services without a paid per-request search API.'}</p>
        <p className="plugin-state">{saved.settings.web.enabled ? zh ? '已启用 · 聊天联网工具使用以下服务' : 'Enabled · chat web tools use these services' : zh ? '已关闭 · 聊天使用原有联网工具' : 'Disabled · chat uses its existing web tools'}</p>
        <details className="plugin-details"><summary>{zh ? '详情与设置' : 'Details and settings'}</summary>
        <div className="plugin-fields"><label>{zh ? 'SearXNG 服务地址' : 'SearXNG service URL'}<input type="url" required value={settings.web.searxngUrl} onChange={(event) => updateWeb({ searxngUrl: event.target.value })} spellCheck={false} /></label><label>{zh ? 'Crawl4AI 服务地址' : 'Crawl4AI service URL'}<input type="url" required value={settings.web.crawl4aiUrl} onChange={(event) => updateWeb({ crawl4aiUrl: event.target.value })} spellCheck={false} /></label></div>
        <p className="plugin-hint">{zh ? '请先启动本地服务，并在 SearXNG 中启用 JSON 输出。这里只连接服务，不会自动安装或启动它们。' : 'Start the local services and enable SearXNG JSON output first. This panel connects to them; it does not install or start them.'}</p>
        <div className="plugin-fields"><label>{zh ? 'Crawl4AI 令牌（可选）' : 'Crawl4AI token (optional)'}<input type="password" autoComplete="new-password" value={token} disabled={clearToken} placeholder={saved.crawl4aiTokenConfigured ? zh ? '已保存，留空以保留' : 'Saved; leave blank to keep' : zh ? '服务未启用认证时可留空' : 'Leave blank if your service has no authentication'} onChange={(event) => { setToken(event.target.value); setNotice(''); setProbes({}); }} /></label><label>{zh ? '每页正文上限（字符）' : 'Page content limit (characters)'}<input type="number" min={1000} max={12000} step={500} value={settings.web.maxCharacters} onChange={(event) => updateWeb({ maxCharacters: Number(event.target.value) })} /></label></div>
        {saved.crawl4aiTokenConfigured && <label className="check-row"><input type="checkbox" checked={clearToken} onChange={(event) => { setClearToken(event.target.checked); setToken(''); setProbes({}); setNotice(''); }} />{zh ? '移除已保存的 Crawl4AI 令牌' : 'Remove saved Crawl4AI token'}</label>}
        <p className="plugin-hint">{zh ? '较小的正文更适合本地模型。长网页会分页返回，并保留来源链接。' : 'Smaller pages suit local models. Long pages are returned in parts with source URLs.'}</p>
        <div className="button-row"><button type="button" className="secondary" disabled={dirty} onClick={() => void test('searxng')}>{busy === 'searxng' ? zh ? '正在测试搜索…' : 'Testing search…' : zh ? '测试搜索' : 'Test search'}</button><button type="button" className="secondary" disabled={dirty} onClick={() => void test('crawl4ai')}>{busy === 'crawl4ai' ? zh ? '正在测试读取…' : 'Testing read…' : zh ? '测试网页读取' : 'Test page reading'}</button></div>
        {dirty && <p className="plugin-hint">{zh ? '保存修改后，可以测试新的连接配置。' : 'Save your changes before testing the updated connections.'}</p>}
        {renderProbe('searxng')}{renderProbe('crawl4ai')}
        </details>
      </fieldset>
      <fieldset disabled={busy !== null} className="plugin-card">
        <div className="plugin-card-heading"><div><span className="plugin-category">{zh ? '开发工具' : 'DEVELOPER TOOLS'}</span><h3>REA · {zh ? '静态应用分析' : 'Static app analysis'}</h3></div><label className="plugin-toggle"><input type="checkbox" checked={settings.rea.enabled} onChange={(event) => { setSettings({ ...settings, rea: { enabled: event.target.checked } }); setNotice(''); }} />{zh ? '启用 REA' : 'Enable REA'}</label></div>
        <p>{zh ? '分析 JavaScript 应用的模块与边界。每次分析使用独立会话，不占用日常聊天。' : 'Inspect the modules and boundaries of a JavaScript application in a separate analysis conversation.'}</p>
        <p className="plugin-state" role="status">{reaLabel}{rea?.available && rea.version ? ` · ${rea.version}` : ''}</p>
        <details className="plugin-details"><summary>{zh ? '详情与设置' : 'Details and settings'}</summary>
        {reaEnabled && rea && !rea.available && <p className="plugin-hint">{rea.reasonCode === 'rea.runtimeNotChecked' ? zh ? '点击“检查运行时”验证本地安装与接口。' : 'Check the runtime to verify its local installation and interface.' : reaFailureText(rea.reasonCode ?? 'rea.runtimeUnavailable', zh)}</p>}
        <div className="button-row"><button type="button" className="secondary" disabled={!reaEnabled || dirty} onClick={() => void checkRuntime()}>{busy === 'rea' ? zh ? '正在检查…' : 'Checking…' : zh ? '检查运行时' : 'Check runtime'}</button><button type="button" disabled={!reaEnabled || !rea?.available || dirty} onClick={() => void startAnalysis()}>{analysisSession ? zh ? '开始新分析' : 'Start a new analysis' : zh ? '开始静态分析' : 'Start static analysis'}</button></div>
        </details>
      </fieldset>
      <div className="plugin-save"><button type="submit" disabled={busy !== null || (!dirty && !saved.warningCode)}>{busy === 'save' ? zh ? '正在保存…' : 'Saving…' : zh ? '保存插件设置' : 'Save plugin settings'}</button>{notice && <span role="status">{notice}</span>}</div>
      {error && <p role="alert" className="notice">{error}</p>}
    </form>
    {analysisSession && reaEnabled && <section className="plugin-card plugin-analysis-workspace" aria-label={zh ? 'REA 分析工作台' : 'REA analysis workspace'}>
      <div className="plugin-card-heading"><h3>{zh ? '分析工作台' : 'Analysis workspace'}</h3><button type="button" className="secondary" onClick={() => onOpenSession(analysisSession)}>{interpretationStarted ? zh ? '查看模型解读' : 'View model interpretation' : zh ? '打开分析会话' : 'Open analysis conversation'}</button></div>
      {interpretationStarted && <p role="status">{zh ? '解读请求已提交。打开分析会话可查看回复或停止生成；关闭静态分析不会删除这段会话。' : 'Interpretation requested. Open the analysis conversation to view the reply or stop generation. Closing static analysis keeps this conversation.'}</p>}
      <label className="plugin-model-choice">{zh ? '解读模型（仅本地）' : 'Interpretation model (local only)'}<select value={provider?.id ?? ''} onChange={(event) => setProviderId(event.target.value)} disabled={!eligibleProviders.length}><option value="" disabled>{zh ? '暂无已确认的本地模型' : 'No confirmed local model'}</option>{eligibleProviders.map((item) => <option value={item.id} key={item.id}>{item.name} · {item.model}</option>)}</select></label>
      <ReaAnalysis key={analysisSession} api={window.deskpet.rea} sessionId={analysisSession} providerId={provider?.id ?? null} model={provider?.model ?? ''} locale={locale} permissions={onPermissions} embedded onInterpretationStarted={() => setInterpretationStarted(true)} />
    </section>}
  </div>;
};
