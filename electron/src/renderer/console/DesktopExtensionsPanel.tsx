import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { ProviderConfig } from '../../shared';
import type { DesktopExtensionsAPI, DesktopExtensionsState, ManifestPreview, McpResult, McpTool, RecommendedExtensionsCatalog, RecommendedInstall } from '../../shared/desktop-extensions';
import { recommendedServerIds, recommendedSkillIds } from '../../shared/desktop-extensions';
import { MethodEditor } from './SaveMethodDialog';
import './plugins-settings.css';
import './desktop-extensions-settings.css';

interface Props { api: DesktopExtensionsAPI; providers: ProviderConfig[]; zh: boolean; section?: 'skills' | 'mcp' }

export const DesktopExtensionsPanel = ({ api, providers, zh, section }: Props): JSX.Element => {
  const [state, setState] = useState<DesktopExtensionsState | null>(null);
  const [recommended,setRecommended] = useState<RecommendedExtensionsCatalog|null>(null);
  const [tokens,setTokens] = useState<Record<string,string>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [notice,setNotice] = useState(''), [skillQuery,setSkillQuery] = useState(''), [serverQuery,setServerQuery] = useState('');
  const [reading, setReading] = useState<{ id: string; text: string } | null>(null);
  const [editingMethod, setEditingMethod] = useState(false);
  const [task, setTask] = useState(''), [providerId, setProviderId] = useState('');
  const selectedProvider = providers.find(p => p.id === providerId) ?? providers[0];
  const [jobId, setJobId] = useState(''), [job, setJob] = useState<{ status: string; result: string | null } | null>(null);
  const [name, setName] = useState(''), [endpoint, setEndpoint] = useState('');
  const [preview, setPreview] = useState<ManifestPreview | null>(null);
  const [previewTools, setPreviewTools] = useState<Record<number,McpTool[]>>({});
  const [catalog, setCatalog] = useState<{ id: string; tools: McpTool[] } | null>(null);
  const [chatPick, setChatPick] = useState<{ names: string[]; results: 'private' | 'public' }>({ names: [], results: 'private' });
  const [question,setQuestion]=useState(''), [answer,setAnswer]=useState<string|null>(null);
  const [questionProvider,setQuestionProvider]=useState(''), [asking,setAsking]=useState<string|null>(null);
  const questionRef=useRef<string|null>(null);
  const toolProviders=providers.filter(p=>p.supportsTools);
  const local=toolProviders.find(p=>p.id===questionProvider)??toolProviders[0];
  useEffect(()=>()=>{const operationId=questionRef.current;if(operationId)void api.cancelQuestion(operationId).catch(()=>undefined);},[api]);
  const [toolName, setToolName] = useState(''), [args, setArgs] = useState('{}'), [result, setResult] = useState<McpResult | null>(null);
  const selectedTool = catalog?.tools.find(tool => tool.name === toolName);
  const catalogServer = state?.servers.find(server => server.id === catalog?.id);
  const selectedSkill = state?.skills.find(skill => skill.id === reading?.id);
  const visibleSkills = state?.skills.filter(skill => `${skill.name}\n${skill.description ?? ''}`.toLocaleLowerCase().includes(skillQuery.trim().toLocaleLowerCase())) ?? [];
  const visibleServers = state?.servers.filter(server => `${server.name}\n${server.endpoint}`.toLocaleLowerCase().includes(serverQuery.trim().toLocaleLowerCase())) ?? [];
  const perform = useCallback(async (action: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (cause) {
      const detail = cause instanceof Error ? cause.message : '';
      if (detail.includes('extensions.denied')) setError(zh ? '本次调用已拒绝。' : 'This call was denied.');
      else if (detail.includes('extensions.authRequired')) setError(zh ? '服务需要有效令牌。请在此服务的认证设置中保存令牌后重试。' : 'The server requires a valid token. Save one in its authentication settings and retry.');
      else if (detail.includes('extensions.invalidToken')) setError(zh ? '令牌格式不正确，请检查是否包含空格或换行。' : 'The token format is invalid. Check for spaces or line breaks.');
      else if (/extensions\.(?:authUnavailable|authSaveFailed)/u.test(detail)) setError(zh ? '令牌未能保存。请检查系统安全存储后重试。' : 'The token could not be saved. Check system secure storage and retry.');
      else if (detail.includes('extensions.privateCredential')) setError(zh ? '服务响应包含私密认证信息，已阻止展示。' : 'A response contained private authentication material and was blocked.');
      else if (detail.includes('extensions.playwright')) setError(zh ? '浏览器服务暂时不可用。请确认 Playwright 运行时和浏览器已安装，再重新列出工具。' : 'The browser service is unavailable. Check that the Playwright runtime and browser are installed, then list tools again.');
      else if (detail.includes('extensions.callOutcomeUnknown')) setError(zh ? '调用结果未知。请在服务端核对，本次调用没有自动重试。' : 'Call outcome unknown. Check the server before retrying.');
      else if (detail.includes('job.privacyBlocked')) setError(zh ? '请选择已确认在本机运行、且有本机 GGUF 元数据的 Ollama 模型。' : 'This skill requires an Ollama model with a confirmed local GGUF file.');
      else if (detail.includes('extensions.questionCancelled')) setError(zh ? '本次问答已取消。' : 'The tool question was cancelled.');
      else if (detail.includes('extensions.localToolModel')) setError(zh ? '请选用已核实本机 GGUF 且支持工具的 Ollama 模型。' : 'Choose a verified local Ollama GGUF model that supports tools.');
      else if (detail.includes('extensions.invalidProposal')) setError(zh ? '本机模型未提出有效的单一工具调用。' : 'The local model did not propose one valid tool call.');
      else if (detail.includes('extensions.invalidJson')) setError(zh ? '请填写 JSON 对象作为工具参数。' : 'Enter a JSON object for the tool arguments.');
      else if (detail.includes('extensions.invalidSkill')) setError(zh ? '无法读取有效的 SKILL.md。请选择包含 UTF-8 普通文件的目录，正文最多 32,000 个字符，不支持链接文件。' : 'Could not read a valid SKILL.md. Choose a folder containing a regular UTF-8 file, up to 32,000 characters. Linked files are not supported.');
      else if (detail.includes('extensions.duplicateSkill')) setError(zh ? '此来源或相同内容的技能已经安装。请查看已有技能，使用更新操作。' : 'A skill from this source or with identical content is already installed. View the existing skill and use its update action.');
      else if (detail.includes('extensions.skillCapacity')) setError(zh ? '最多保存 80 个技能，请先移除不再使用的技能。' : 'You can keep up to 80 skills. Remove an unused skill before installing another.');
      else if (detail.includes('extensions.chatToolCapacity')) setError(zh ? '聊天里最多开放 24 个连接器工具，请先取消一些。' : 'Desktop chat can use at most 24 connector tools. Turn some off first.');
      else if (detail.includes('extensions.duplicateTool')) setError(zh ? '有两个工具名称在聊天里会重名，请只选其中一个。' : 'Two of these tool names collide in chat. Choose only one of them.');
      else if (detail.includes('extensions.changed')) setError(zh ? '扩展内容或启用状态已变化，请重新查看后再试。' : 'The extension content or enabled state changed. Review it again before retrying.');
      else if (detail.includes('extensions.disabled')) setError(zh ? '此扩展尚未启用，或已经停用。请核对启用状态。' : 'This extension is disabled. Check its enabled state.');
      else if (detail.includes('extensions.missing')) setError(zh ? '此扩展已不存在，请重新打开扩展设置。' : 'This extension no longer exists. Reopen extension settings.');
      else if (detail.includes('extensions.unavailable')) setError(zh ? '扩展暂时不可用，请稍后重试。' : 'Extensions are temporarily unavailable. Try again later.');
      else setError(zh ? '操作未完成。请核对扩展设置及本地服务状态。' : 'The operation did not finish. Check the extension settings and local service.');
    } finally { setBusy(false); }
  }, [zh]);
  useEffect(() => { void perform(async () => {
    const [snapshot,items]=await Promise.all([api.state(),api.catalog?.()??Promise.resolve(null)]);
    setState(snapshot);setRecommended(items);
  }); }, [api, perform]);
  const installRecommended = (input:RecommendedInstall):void => { void perform(async()=>{
    if (!api.installRecommended) return;
    setState(await api.installRecommended(input));setRecommended(await api.catalog?.()??null);
    setNotice(input.servers.length ? (zh ? '所选服务已添加并启用。GitHub 需要保存令牌；Playwright 在使用时启动。' : 'Selected servers added and enabled. GitHub needs a token; Playwright starts on use.') : (zh?'所选技能已添加并启用。':'Selected skills added and enabled.'));
  }); };
  useEffect(() => {
    if (!jobId) return;
    let active = true;
    const update = () => { void window.deskpet.jobs.get(jobId).then(value => { if (active) setJob(value); }).catch(() => { if (active) setJob(null); }); };
    const stop = window.deskpet.jobs.onChanged(update); update();
    return () => { active = false; stop(); };
  }, [jobId]);
  const toggle = (kind: 'skill' | 'server', id: string, enabled: boolean): void => { void perform(async () => {
    setState(await api.toggle(kind,id,enabled));
    if (kind === 'server') { setCatalog(null); setResult(null); }
  }); };
  const remove = (kind: 'skill' | 'server', id: string): void => { void perform(async () => {
    setState(await api.remove(kind,id));
    if (kind === 'skill' && reading?.id === id) setReading(null);
    if (kind === 'server') { setCatalog(null); setResult(null); }
  }); };
  const heading = section === 'skills' ? (zh ? '技能' : 'Skills') : section === 'mcp' ? (zh ? 'MCP 服务' : 'MCP servers') : (zh ? '本地扩展' : 'Local extensions');
  if (!state) return <div className="plugin-settings desktop-extensions-settings">
    {section && <h2>{heading}</h2>}
    {error ? <><p role="alert">{error}</p><button type="button" className="secondary" disabled={busy} onClick={() => void perform(async () => setState(await api.state()))}>{zh ? '重新加载' : 'Reload'}</button></> : <p role="status">{zh ? '正在读取扩展列表…' : 'Loading extensions…'}</p>}
  </div>;
  return <div className="plugin-settings desktop-extensions-settings">
    {section && <div className="plugin-settings-heading"><h2>{heading}</h2></div>}
    {asking && <button type="button" onClick={()=>void api.cancelQuestion(asking).catch(()=>undefined)}>{zh ? '取消本次工具问答' : 'Cancel this tool question'}</button>}
    <fieldset className="plugin-card" disabled={busy} aria-label={heading}>
    {!section && <legend>{heading}</legend>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {section !== 'mcp' && <div className="extension-section">
    {!section && <h3>{zh ? '技能' : 'Skills'}</h3>}
    <p className="extension-summary">{zh ? `已安装 ${state.skills.length} 个技能 · 已启用 ${state.skills.filter(skill => skill.enabled).length} 个` : `${state.skills.length} skills installed · ${state.skills.filter(skill => skill.enabled).length} enabled`}</p>
    <p>{zh ? '导入技能，为桌面研究和本地文本任务提供可复用的方法。新安装的技能默认停用，可以先查看内容再启用。' : 'Import reusable guidance for desktop research and local text tasks. New skills start disabled so you can review them before enabling them.'}</p>
    <details className="plugin-details"><summary>{zh ? '兼容性与使用范围' : 'Compatibility and usage'}</summary>
      <p>{zh ? '技能默认仅限本地。查看内容后，可批准当前版本公开使用，与联网研究配合并交给所选模型。未批准公开的技能需要本地模型；读取它的简介或正文会将当前会话设为仅本地，关闭后续联网与 MCP。技能不会授予操作权限。' : 'Skills start local-only. After reviewing the text, you can approve this revision for public research and your selected model. Private summaries and text require a local model and make the conversation local-only, disabling subsequent web and MCP calls. Skills grant no tool permissions.'}</p>
      <p>{zh ? '只导入 SKILL.md，不会自动读取同目录的脚本或附件。更新会重新读取原目录；正文变化后会停用，须查看并重新启用。' : 'Only SKILL.md is imported; scripts and attachments are not loaded automatically. Updating rereads the source folder. Changed content is disabled until you review and enable it again.'}</p>
    </details>
    <button type="button" onClick={() => void perform(async () => {
      const next = await api.installSkill(); setState(next);
      if (next.skills.length > (state?.skills.length ?? 0)) setNotice(zh ? '技能已安装，当前停用。请查看内容后再启用。' : 'Skill installed and disabled. Review its contents before enabling it.');
    })}>{zh ? '从目录安装技能' : 'Install skill from folder'}</button>
    {recommended && api.installRecommended && <details className="plugin-details"><summary>{zh ? '四个推荐技能' : 'Four recommended skills'}</summary>
      <ul>{recommended.skills.map(item=><li key={item.id}><strong>{item.name}</strong> · {item.description} {item.installed && <span>{zh?'（已安装）':'(Installed)'}</span>}</li>)}</ul>
      <button type="button" className="secondary" onClick={()=>installRecommended({skills:[...recommendedSkillIds],servers:[],enabled:true})}>{zh?'添加并启用推荐技能':'Add and enable recommended skills'}</button>
    </details>}
    {!!state?.skills.length && <label>{zh ? '搜索已安装技能' : 'Search installed skills'}<input type="search" value={skillQuery} onChange={event => setSkillQuery(event.target.value)} /></label>}
    {!state.skills.length && <p className="extension-empty">{zh ? '还没有安装技能。' : 'No skills installed yet.'}</p>}
    {!!state?.skills.length && !visibleSkills.length && <p>{zh ? '没有匹配的技能。' : 'No matching skills.'}</p>}
    {visibleSkills.map(skill => <section className="extension-entry" key={skill.id} aria-label={skill.name}>
      <div className="extension-entry-heading"><h4>{skill.name}</h4><span className="extension-status">{skill.enabled ? (zh ? '已启用' : 'Enabled') : (zh ? '已停用' : 'Disabled')}</span><span>{skill.exposure === 'public' ? (zh ? '已批准公开使用' : 'Approved for public research') : (zh ? '仅限本地' : 'Local only')}</span></div><p>{skill.description || (zh ? '此技能未提供简介。' : 'This skill has no description.')}</p>
      <details><summary>{zh ? '来源与版本' : 'Source and revision'}</summary>
        <dl>
          <dt>{zh ? '本机来源目录' : 'Local source folder'}</dt><dd><code>{skill.sourceDirectory ?? (zh ? '旧版条目未记录，更新时可选择目录。' : 'Not recorded for this older entry. Choose a folder when updating.')}</code></dd>
          <dt>{zh ? '版本' : 'Revision'}</dt><dd>{skill.revision ?? 1}</dd>
          <dt>{zh ? '内容指纹（SHA-256）' : 'Content fingerprint (SHA-256)'}</dt><dd><code>{skill.digest ?? (zh ? '未记录' : 'Not recorded')}</code></dd>
          <dt>{zh ? '安装时间' : 'Installed'}</dt><dd>{skill.installedAt ?? (zh ? '未记录' : 'Not recorded')}</dd>
          <dt>{zh ? '内容更新时间' : 'Content updated'}</dt><dd>{skill.updatedAt ?? (zh ? '未记录' : 'Not recorded')}</dd>
        </dl>
      </details>
      <div className="button-row">
      <label><input type="checkbox" checked={skill.enabled} onChange={e => toggle('skill', skill.id,e.target.checked)} />{zh ? '启用技能' : 'Enable skill'}</label>
      <button type="button" className="secondary" onClick={() => void perform(async () => { setReading({ id: skill.id, text: await api.readSkill(skill.id) }); setEditingMethod(false); setTask(''); setJobId(''); setJob(null); })}>{zh ? '查看技能' : 'View skill'}</button>
      {!skill.userMethod && <button type="button" className="secondary" onClick={() => void perform(async () => {
        const next = await api.updateSkill(skill.id), updated = next.skills.find(item => item.id === skill.id); setState(next);
        if (reading?.id === skill.id) { setReading(null); setJobId(''); setJob(null); }
        if (updated?.digest !== skill.digest) setNotice(zh ? '技能内容已更新并停用，请重新查看后启用。' : 'Skill content updated and disabled. Review it again before enabling it.');
        else if (updated?.sourceDirectory && !skill.sourceDirectory) setNotice(zh ? '已记录来源目录，技能内容未变化。' : 'Source folder recorded. Skill content is unchanged.');
        else setNotice(zh ? '技能内容未变化。' : 'Skill content is unchanged.');
      })}>{skill.sourceDirectory ? (zh ? '从原目录更新' : 'Update from source folder') : (zh ? '选择目录更新' : 'Choose folder to update')}</button>}
      <button type="button" className="text-button" onClick={() => remove('skill',skill.id)}>{zh ? '移除' : 'Remove'}</button>
      </div>
    </section>)}
    {reading && selectedSkill && <div className="extension-workspace"><h4>{selectedSkill.name}</h4><pre className="extension-preview">{reading.text}</pre>
      {api.setSkillExposure && selectedSkill.digest && <button type="button" className="secondary" onClick={() => void perform(async () => {
        setState(await api.setSkillExposure!({ id: selectedSkill.id, digest: selectedSkill.digest!, revision: selectedSkill.revision ?? 1, exposure: selectedSkill.exposure === 'public' ? 'local-only' : 'public' }));
        setNotice(zh ? '使用范围已更新。公开授权仅适用于刚审阅的版本。' : 'Usage scope updated for the reviewed revision.');
      })}>{selectedSkill.exposure === 'public' ? (zh ? '恢复为仅限本地' : 'Restrict to local use') : (zh ? '审阅并批准公开使用' : 'Review and approve public use')}</button>}
      {selectedSkill.userMethod && api.saveMethod && <><button type="button" className="secondary" onClick={() => setEditingMethod(value => !value)}>{zh ? '编辑我的方法' : 'Edit my method'}</button>
        {editingMethod && <MethodEditor api={api} locale={zh ? 'zh-CN' : 'en'} skill={selectedSkill} initialName={selectedSkill.name} initialText={reading.text} onSaved={() => { void perform(async () => { setState(await api.state()); setReading(null); setEditingMethod(false); }); }} />}</>}
      <label>{zh ? '任务' : 'Task'}<textarea value={task} onChange={event => setTask(event.target.value)} maxLength={8000} /></label>
      <label>{zh ? '执行模型（仅本地）' : 'Model (local only)'}<select value={selectedProvider?.id ?? ''} onChange={event => setProviderId(event.target.value)}>
        {providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name} · {provider.model}</option>)}</select></label>
      <button type="button" disabled={!selectedSkill.enabled || !selectedProvider || !task.trim()} onClick={() => void perform(async () => {
        const response = await api.runSkill({ id: selectedSkill.id, operationId: crypto.randomUUID(), providerId: selectedProvider!.id, model: selectedProvider!.model, task });
        setJob(null); setJobId(response.jobId);
      })}>{zh ? '使用此技能运行' : 'Run with this skill'}</button>
      {jobId && <p role="status">{zh ? '任务状态' : 'Job status'} · {job?.status ?? '…'}</p>}{job?.result && <pre className="extension-preview">{job.result}</pre>}
    </div>}
    </div>}
    {section !== 'skills' && <div className="extension-section">
    {!section && <h3>{zh ? 'MCP 工具服务' : 'MCP tool servers'}</h3>}
    <p className="extension-summary">{zh ? `已添加 ${state.servers.length} 个服务 · 已启用 ${state.servers.filter(server => server.enabled).length} 个` : `${state.servers.length} servers added · ${state.servers.filter(server => server.enabled).length} enabled`}</p>
    <p>{zh ? '可以导入 JSON 清单，或手动添加本机 HTTP 或公共 HTTPS 服务。调用前会在桌面显示目标和完整参数，结果只在这里展示。' : 'Import a JSON manifest, or add a local HTTP or public HTTPS endpoint. Review the destination and arguments on the desktop before each call.'}</p>
    <p className="plugin-hint">{zh ? '“已启用”表示允许连接，不代表服务当前在线。点击“列出工具”可检查连接并查看可用能力。' : 'Enabled means connections are allowed; it does not confirm that the server is online. Use List tools to check the connection and inspect its capabilities.'}</p>
    {!!state.servers.length && <label>{zh ? '搜索 MCP 服务' : 'Search MCP servers'}<input type="search" value={serverQuery} onChange={event => setServerQuery(event.target.value)} /></label>}
    {!state.servers.length && <p className="extension-empty">{zh ? '还没有添加 MCP 服务。可以从清单导入，或填写服务地址。' : 'No MCP servers added yet. Import a manifest or enter a server endpoint.'}</p>}
    {!!state.servers.length && !visibleServers.length && <p>{zh ? '没有匹配的 MCP 服务。' : 'No matching MCP servers.'}</p>}
    {visibleServers.map(server => <section className="extension-entry" aria-label={server.name} key={server.id}>
      <div className="extension-entry-heading"><h4>{server.name}</h4><span className="extension-status">{server.enabled ? (zh ? '已启用' : 'Enabled') : (zh ? '已停用' : 'Disabled')}</span></div>
      <p>{server.preset==='playwright' ? (zh?'DeskPet 独立浏览器 · 按需启动':'DeskPet isolated browser · starts on demand') : <code>{server.endpoint}</code>}</p>
      {server.chatAccess && <p className="plugin-hint">{zh ? `聊天中可用 ${server.chatAccess.tools.length} 个工具 · 结果${server.chatAccess.results === 'private' ? '按私人资料处理' : '视为公开信息'}` : `${server.chatAccess.tools.length} tools available in chat · results treated as ${server.chatAccess.results === 'private' ? 'private' : 'public'}`}</p>}
      {server.preset==='github' && <p className="plugin-hint">{zh?'只读模式 · ':'Read-only mode · '}{server.authConfigured?(zh?'认证已配置':'Authentication configured'):(zh?'待配置令牌':'Token required')}</p>}
      <div className="button-row"><label><input type="checkbox" checked={server.enabled} onChange={e => toggle('server',server.id,e.target.checked)} />{zh ? '启用服务' : 'Enable server'}</label>
        <button type="button" className="secondary" disabled={!server.enabled} onClick={() => void perform(async () => {
          setCatalog(null); setResult(null); setAnswer(null);
          const tools = await api.listTools(server.id); setCatalog({id: server.id,tools}); setToolName(tools[0]?.name ?? ''); setArgs('{}'); setResult(null); setAnswer(null);
          setChatPick({ names: tools.filter(tool => server.chatAccess?.tools.some(grant => grant.name === tool.name && grant.digest === tool.digest)).map(tool => tool.name), results: server.chatAccess?.results ?? 'private' });
        })}>{zh ? '列出工具' : 'List tools'}</button>
        <button type="button" className="text-button" onClick={() => remove('server',server.id)}>{zh ? '移除' : 'Remove'}</button></div>
      {server.endpoint.startsWith('https:') && !server.privateBridge && <details className="plugin-details"><summary>{zh?'认证设置':'Authentication settings'}</summary>
        <p className="plugin-hint">{server.authConfigured?(zh?'已保存令牌。留空可保留，令牌不会显示在列表或工具参数中。':'A token is saved. Leave blank to keep it; it is never shown in the list or tool arguments.'):(zh?'需要认证的服务可以在这里保存 Bearer 令牌。':'Save a Bearer token here if this server requires authentication.')}</p>
        <label>{zh?'访问令牌':'Access token'}<input type="password" autoComplete="new-password" maxLength={4096} value={tokens[server.id]??''} onChange={event=>setTokens(previous=>({...previous,[server.id]:event.target.value}))}/></label>
        <div className="button-row"><button type="button" disabled={!tokens[server.id]?.trim()} onClick={()=>void perform(async()=>{
          const token=tokens[server.id]!.trim();setTokens(previous=>({...previous,[server.id]:''}));setCatalog(null);setResult(null);setAnswer(null);
          setState(await api.configureToken(server.id,token));setNotice(zh?'令牌已加密保存。':'Token saved securely.');
        })}>{zh?'保存令牌':'Save token'}</button>
        {server.authConfigured && <button type="button" className="secondary" onClick={()=>void perform(async()=>{setCatalog(null);setResult(null);setAnswer(null);setState(await api.configureToken(server.id,null));setNotice(zh?'已移除保存的令牌。':'Saved token removed.');})}>{zh?'移除令牌':'Remove token'}</button>}</div>
      </details>}
    </section>)}
    <div className="extension-add-server">
    <h3>{zh ? '添加 MCP 服务' : 'Add MCP server'}</h3>
    {recommended && api.installRecommended && <details className="plugin-details"><summary>{zh?'四个推荐 MCP 服务':'Four recommended MCP servers'}</summary>
      <ul>{recommended.servers.map(item=><li key={item.id}><strong>{item.name}</strong> · {item.description} {item.installed&&<span>{zh?'（已添加）':'(Added)'}</span>}</li>)}</ul>
      <button type="button" className="secondary" onClick={()=>installRecommended({skills:[],servers:[...recommendedServerIds],enabled:true})}>{zh?'添加并启用推荐服务':'Add and enable recommended servers'}</button>
    </details>}
    <div className="button-row">
    <button type="button" onClick={() => void perform(async () => {
      setPreview(null); setPreviewTools({}); setPreview(await api.previewManifest());
    })}>{zh ? '从 JSON 清单导入' : 'Import JSON manifest'}</button>
    <button type="button" className="secondary" onClick={() => void perform(async () => {
      setPreview(null); setPreviewTools({}); setPreview(await api.previewBridge());
    })}>{zh ? '导入本机受限 stdio 桥' : 'Import local restricted stdio bridge'}</button>
    </div>
    {preview && <section className="extension-entry" aria-label={zh ? '清单预览' : 'Manifest preview'}>
      <h4>{zh ? '清单预览' : 'Manifest preview'}</h4>
      <p>{zh ? '导入只保存服务名称和地址，默认停用。可先主动连接服务查看其工具，执行任何工具仍须逐次批准。' : 'Import saves names and endpoints with each server disabled. You can inspect its tools first. Running a tool requires separate approval.'}</p>
      {preview.servers.map((candidate,index) => <div key={candidate.endpoint}><strong>{candidate.name}</strong> · <code>{candidate.endpoint}</code>{' '}
        {!candidate.privateBridge && <button type="button" className="secondary" onClick={() => void perform(async () => {
          const tools = await api.inspectPreview(preview.id,index); setPreviewTools(previous=>({...previous,[index]:tools}));
        })}>{zh ? '连接并预览工具' : 'Connect and preview tools'}</button>}
        {candidate.privateBridge && <small>{zh ? '已隐藏私有路径；启用后才会连接。' : 'Private path hidden. Connection requires enabling the bridge.'}</small>}
        {previewTools[index] && <ul>{previewTools[index].map(tool => <li key={tool.name}><code>{tool.name}</code> · {tool.description}</li>)}</ul>}
      </div>)}
      <p>{zh ? '重复服务' : 'Duplicates'}: {preview.duplicates} · {zh ? '已略过不支持的条目（含命令、凭据或自定义路径）' : 'Unsupported entries skipped (commands, credentials or custom paths)'}: {preview.skipped}</p>
      <div className="button-row"><button type="button" disabled={!preview.servers.length} onClick={() => void perform(async () => {
        setState(await api.importManifest(preview.id)); setPreview(null); setPreviewTools({});
      })}>{zh ? '按停用状态导入' : 'Import as disabled'}</button><button type="button" className="secondary" onClick={()=>setPreview(null)}>{zh ? '关闭预览' : 'Close preview'}</button></div>
    </section>}
    <div className="plugin-fields">
    <label>{zh ? '服务名' : 'Server name'}<input value={name} maxLength={100} onChange={e=>setName(e.target.value)} /></label>
    <label>{zh ? 'MCP 服务地址' : 'MCP endpoint'}<input type="url" placeholder="http://127.0.0.1:8080/mcp" value={endpoint} onChange={e=>setEndpoint(e.target.value)} /></label>
    </div>
    <button type="button" disabled={!name.trim() || !endpoint.trim()} onClick={() => void perform(async () => { setState(await api.addServer(name,endpoint)); setName(''); setEndpoint(''); })}>{zh ? '添加服务' : 'Add server'}</button>
    </div>
    {catalog && <div className="extension-workspace"><h4>{state.servers.find(s=>s.id === catalog.id)?.name}</h4><p className="plugin-state" role="status">{zh ? `连接成功 · ${catalog.tools.length} 个工具` : `Connected · ${catalog.tools.length} tools`}</p>{!catalog.tools.length && <p>{zh ? '此服务没有可用工具。' : 'This server has no available tools.'}</p>}
      {selectedTool && <><label>{zh ? '工具' : 'Tool'}<select value={toolName} onChange={e => { setToolName(e.target.value); setArgs('{}'); setResult(null); setAnswer(null); }}>
        {catalog.tools.map(tool => <option key={tool.name} value={tool.name}>{tool.name}</option>)}</select></label>
        <p>{selectedTool.description}</p><details><summary>{zh ? '参数格式' : 'Input schema'}</summary><pre className="extension-preview">{JSON.stringify(selectedTool.inputSchema,null,2)}</pre></details>
        <label>{zh ? '参数（JSON 对象）' : 'Arguments (JSON object)'}<textarea maxLength={8000} value={args} onChange={e=>setArgs(e.target.value)} /></label>
        <button type="button" onClick={() => void perform(async () => {
          let value: unknown; try { value = JSON.parse(args); } catch { throw new Error('extensions.invalidJson'); }
          if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('extensions.invalidJson');
          setAnswer(null); setResult(null); setResult(await api.callTool({ id: catalog.id, name: selectedTool.name, digest: selectedTool.digest, arguments: value as Record<string,unknown> }));
        })}>{zh ? '审阅并调用' : 'Review and call'}</button>
        <details className="plugin-details"><summary>{zh ? '本次桌面问答只用此工具' : 'Ask with this tool only'}</summary>
          <p>{zh ? '本机模型只会看到在此输入的问题和所选工具。请在桌面核对模型提出的全部参数，批准后才会发送给服务。' : 'The local model receives only this question and the selected tool. Review the proposed arguments before sending them to the server.'}</p>
          <label>{zh ? '本次问题' : 'Question for this tool'}<textarea value={question} maxLength={8000} onChange={e=>setQuestion(e.target.value)} /></label>
          <label>{zh ? '本次工具模型（仅本机）' : 'Local tool model'}<select value={local?.id??''} onChange={e=>setQuestionProvider(e.target.value)}>{toolProviders.map(p=><option key={p.id} value={p.id}>{p.name} · {p.model}</option>)}</select></label>
          {!local && <small>{zh ? '请先配置支持工具的本机 Ollama 模型。' : 'Configure a local Ollama model with tool support first.'}</small>}
          <button type="button" disabled={!local || !question.trim()} onClick={()=>void perform(async()=>{
            const operationId=crypto.randomUUID();
            setResult(null);setAnswer(null);questionRef.current=operationId;setAsking(operationId);
            try {
              const response=await api.askTool({operationId,id:catalog.id,name:selectedTool.name,digest:selectedTool.digest,providerId:local!.id,model:local!.model,question});
              setResult(response.result);setAnswer(response.answer??(zh?'工具已调用，本机模型未完成解读。':'The tool was called. The local model could not finish its explanation.'));
            } finally {questionRef.current=null;setAsking(null);}
          })}>{zh ? '让本机模型提出参数' : 'Propose arguments locally'}</button>
        </details></>}
      {api.setChatTools && !catalogServer?.preset && !!catalog.tools.length && <details className="plugin-details" open={!!catalogServer?.chatAccess}><summary>{zh ? '在桌面聊天中使用' : 'Use in desktop chat'}</summary>
        <p>{zh ? '勾选的工具会出现在桌面聊天里。每次调用都会先显示完整参数，由你批准；服务改了工具定义后，需要回来重新勾选。QQ、Telegram 和定时任务不会用到这些工具。' : 'Checked tools become available in desktop chat. Each call shows its exact arguments for your approval. If the server changes a tool definition, check it again here. QQ, Telegram and schedules never use them.'}</p>
        {catalogServer?.chatAccess?.tools.some(grant => !catalog.tools.some(tool => tool.name === grant.name && tool.digest === grant.digest)) && <p className="plugin-hint" role="status">{zh ? '有工具的定义已在服务端变化，聊天里暂时用不了，请重新核对后保存。' : 'Some tool definitions changed on the server and are paused in chat. Review and save again.'}</p>}
        {catalog.tools.map(tool => <label key={tool.name}><input type="checkbox" checked={chatPick.names.includes(tool.name)}
          onChange={event => setChatPick(pick => ({ ...pick, names: event.target.checked ? [...pick.names, tool.name] : pick.names.filter(name => name !== tool.name) }))} />{tool.name}</label>)}
        <fieldset><legend>{zh ? '这些工具返回的内容' : 'What these tools return'}</legend>
          <label><input type="radio" name={`chat-results-${catalog.id}`} checked={chatPick.results === 'private'} onChange={() => setChatPick(pick => ({ ...pick, results: 'private' }))} />{zh ? '私人资料（笔记、日程、本机文件等）：用过后这段对话转为仅限本机' : 'Private (notes, calendar, local files): the conversation becomes local-only after use'}</label>
          <label><input type="radio" name={`chat-results-${catalog.id}`} checked={chatPick.results === 'public'} onChange={() => setChatPick(pick => ({ ...pick, results: 'public' }))} />{zh ? '公开信息（公开文档、搜索结果等）' : 'Public information (public docs, search results)'}</label>
        </fieldset>
        <button type="button" onClick={() => void perform(async () => {
          const selected = catalog.tools.filter(tool => chatPick.names.includes(tool.name)).map(({ name, digest }) => ({ name, digest }));
          setState(await api.setChatTools!({ id: catalog.id, results: chatPick.results, tools: selected }));
          setNotice(selected.length ? (zh ? `已在聊天中开放 ${selected.length} 个工具。` : `${selected.length} tools are now available in chat.`) : (zh ? '已停止在聊天中使用此服务。' : 'This server is no longer used in chat.'));
        })}>{zh ? '保存聊天设置' : 'Save chat settings'}</button>
      </details>}
      {answer && <div><strong>{zh ? '本机模型解读' : 'Local explanation'}</strong><pre className="extension-preview">{answer}</pre></div>}
      {result && <div><strong>{result.isError ? zh ? '工具返回错误' : 'Tool error' : zh ? '工具结果' : 'Tool result'}</strong>
        <pre className="extension-preview">{result.text}</pre></div>}
    </div>}
    </div>}
  </fieldset></div>;
};
