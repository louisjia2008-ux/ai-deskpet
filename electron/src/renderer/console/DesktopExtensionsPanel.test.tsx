import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '../../shared';
import type { DesktopExtensionsAPI, DesktopExtensionsState } from '../../shared/desktop-extensions';
import { DesktopExtensionsPanel } from './DesktopExtensionsPanel';

afterEach(cleanup);
const id = '00000000-0000-4000-8000-000000000010';
const skill: DesktopExtensionsState['skills'][number] = {
  id,name:'Research',description:'Compare primary evidence.',sourceDirectory:'/synthetic/skills/research',
  digest:'a'.repeat(64),revision:2,enabled:true,installedAt:'2026-11-01T00:00:00.000Z',updatedAt:'2026-11-01T00:00:00.000Z',
};
const provider: ProviderConfig = {id:'00000000-0000-4000-8000-000000000020',name:'Local fixture',kind:'ollama',
  baseUrl:'http://127.0.0.1:11434',model:'fixture',enabled:true,supportsTools:true,localExecutionConfirmed:true,secretState:'missing'};
const server: DesktopExtensionsState['servers'][number] = {id:'00000000-0000-4000-8000-000000000030',name:'Local notes',endpoint:'http://127.0.0.1:8080/mcp',enabled:false,revision:1};
const setup = (options: {zh?:boolean;skills?:DesktopExtensionsState['skills'];servers?:DesktopExtensionsState['servers'];section?:'skills'|'mcp'} = {}) => {
  let state: DesktopExtensionsState = {skills:structuredClone(options.skills ?? [skill]),servers:structuredClone(options.servers ?? [])};
  let text = 'PRIVATE_SKILL_BODY';
  const snapshot = () => structuredClone(state);
  const api = {
    state:vi.fn(async () => snapshot()),
    configureToken:vi.fn<DesktopExtensionsAPI['configureToken']>(async(selected,token)=>{state.servers=state.servers.map(item=>item.id===selected?{...item,authConfigured:token!==null}:item);return snapshot();}),
    installSkill:vi.fn(async () => snapshot()),
    updateSkill:vi.fn<DesktopExtensionsAPI['updateSkill']>(async selected => {
      state.skills = state.skills.map(item => item.id === selected ? {...item,description:'Updated primary evidence.',digest:'b'.repeat(64),revision:(item.revision ?? 1) + 1,enabled:false} : item);
      text = 'UPDATED_SKILL_BODY'; return snapshot();
    }),
    readSkill:vi.fn(async () => text),runSkill:vi.fn(async () => ({jobId:'synthetic-job'})),
    toggle:vi.fn<DesktopExtensionsAPI['toggle']>(async (kind,selected,enabled) => {
      if (kind === 'skill') state.skills = state.skills.map(item => item.id === selected ? {...item,enabled,revision:(item.revision ?? 1) + 1} : item);
      if (kind === 'server') state.servers = state.servers.map(item => item.id === selected ? {...item,enabled} : item);
      return snapshot();
    }),
    remove:vi.fn<DesktopExtensionsAPI['remove']>(async (kind,selected) => {
      if (kind === 'skill') state.skills = state.skills.filter(item => item.id !== selected);
      if (kind === 'server') state.servers = state.servers.filter(item => item.id !== selected);
      return snapshot();
    }),
    previewBridge:vi.fn(async () => null),previewManifest:vi.fn(async () => null),inspectPreview:vi.fn(async () => []),importManifest:vi.fn(async () => snapshot()),
    addServer:vi.fn(async () => snapshot()),listTools:vi.fn<DesktopExtensionsAPI['listTools']>(async () => []),
    askTool:vi.fn(async () => ({result:{isError:false,text:'fixture'},answer:null})),cancelQuestion:vi.fn(async () => undefined),
    callTool:vi.fn(async () => ({isError:false,text:'fixture'})),
    setChatTools:vi.fn<NonNullable<DesktopExtensionsAPI['setChatTools']>>(async input => {
      state.servers = state.servers.map(item => {
        if (item.id !== input.id) return item;
        const next = { ...item };
        delete next.chatAccess;
        return input.tools.length ? { ...next, chatAccess: { results: input.results, tools: input.tools } } : next;
      });
      return snapshot();
    }),
  } satisfies DesktopExtensionsAPI;
  render(<DesktopExtensionsPanel api={api} providers={[provider]} zh={options.zh ?? false} {...(options.section ? {section:options.section} : {})} />);
  return api;
};

it('saves a service token without redisplaying it and offers explicit removal',async()=>{
  const github={...server,name:'GitHub',endpoint:'https://api.githubcopilot.com/mcp/readonly',preset:'github' as const,enabled:true};
  const api=setup({section:'mcp',servers:[github]});
  const card=await screen.findByRole('region',{name:'GitHub'});
  fireEvent.click(within(card).getByText('Authentication settings'));
  const input=within(card).getByLabelText('Access token');
  fireEvent.change(input,{target:{value:'synthetic-bearer'}});
  fireEvent.click(within(card).getByRole('button',{name:'Save token'}));
  await screen.findByText('Token saved securely.');
  expect(api.configureToken).toHaveBeenCalledWith(github.id,'synthetic-bearer');
  expect(input).toHaveValue('');
  expect(within(card).queryByText('synthetic-bearer')).not.toBeInTheDocument();
  fireEvent.click(within(card).getByRole('button',{name:'Remove token'}));
  expect(api.configureToken).toHaveBeenCalledTimes(1);
  fireEvent.click(within(card).getByRole('button',{name:'Remove (you will need to enter it again)'}));
  await screen.findByText('Saved token removed.');
  expect(api.configureToken).toHaveBeenLastCalledWith(github.id,null);
});

it('shows management metadata without reading or running the skill body automatically', async () => {
  const api = setup(), card = await screen.findByRole('region',{name:'Research'});
  expect(within(card).getByText('Compare primary evidence.')).toBeInTheDocument();
  fireEvent.click(within(card).getByText('Source and revision'));
  expect(within(card).getByText('/synthetic/skills/research')).toBeInTheDocument();
  expect(within(card).getByText('a'.repeat(64))).toBeInTheDocument();
  expect(within(card).getByText('2',{exact:true})).toBeInTheDocument();
  expect(api.readSkill).not.toHaveBeenCalled(); expect(api.runSkill).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('searchbox',{name:'Search installed skills'}),{target:{value:'primary'}});
  expect(screen.getByRole('region',{name:'Research'})).toBeInTheDocument();
  fireEvent.click(within(card).getByRole('button',{name:'View skill'}));
  await screen.findByText('PRIVATE_SKILL_BODY');
  expect(api.readSkill).toHaveBeenCalledExactlyOnceWith(id);
  expect(api.runSkill).not.toHaveBeenCalled();
});

it('opens a dedicated skills inventory without MCP controls', async () => {
  const api = setup({section:'skills',servers:[server]});
  expect(screen.getByRole('heading',{name:'Skills',level:2})).toBeInTheDocument();
  await screen.findByText('1 skills installed · 1 enabled');
  expect(screen.getByRole('region',{name:'Research'})).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Import JSON manifest'})).not.toBeInTheDocument();
  expect(screen.queryByRole('region',{name:'Local notes'})).not.toBeInTheDocument();
  expect(api.listTools).not.toHaveBeenCalled();
});

it('shows MCP inventory, searches it, and checks tools only after explicit enabling', async () => {
  const api = setup({section:'mcp',servers:[server]});
  await screen.findByText('1 servers added · 0 enabled');
  expect(screen.getByRole('heading',{name:'MCP servers',level:2})).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Install skill from folder'})).not.toBeInTheDocument();
  expect(screen.queryByRole('region',{name:'Research'})).not.toBeInTheDocument();
  expect(api.listTools).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('searchbox',{name:'Search MCP servers'}),{target:{value:'unmatched'}});
  expect(screen.getByText('No matching MCP servers.')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('searchbox',{name:'Search MCP servers'}),{target:{value:'127.0.0.1'}});
  const card = screen.getByRole('region',{name:'Local notes'});
  expect(within(card).getByRole('button',{name:'List tools'})).toBeDisabled();
  fireEvent.click(within(card).getByRole('checkbox',{name:'Enable server'}));
  await screen.findByText('1 servers added · 1 enabled');
  expect(api.toggle).toHaveBeenCalledExactlyOnceWith('server',server.id,true);
  api.listTools.mockResolvedValueOnce([{name:'notes.read',description:'Read a note.',inputSchema:{type:'object'},digest:'c'.repeat(64)}]);
  fireEvent.click(within(card).getByRole('button',{name:'List tools'}));
  await screen.findByText('Connected · 1 tools');
  expect(api.listTools).toHaveBeenCalledExactlyOnceWith(server.id);
  expect(api.callTool).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Arguments (JSON object)'),{target:{value:'{"note":"example"}'}});
  fireEvent.click(screen.getByRole('button',{name:'Review and call'}));
  await screen.findByText('fixture');
  expect(api.callTool).toHaveBeenCalledExactlyOnceWith({id:server.id,name:'notes.read',digest:'c'.repeat(64),arguments:{note:'example'}});
  fireEvent.click(within(card).getByRole('button',{name:'Remove'}));
  await screen.findByText('No MCP servers added yet. Import a manifest or enter a server endpoint.');
  expect(api.remove).toHaveBeenCalledExactlyOnceWith('server',server.id);
  expect(screen.queryByLabelText('Arguments (JSON object)')).not.toBeInTheDocument();
});

it('discards an opened old snapshot after updating and requires explicit re-enablement', async () => {
  const api = setup(), card = await screen.findByRole('region',{name:'Research'});
  fireEvent.click(within(card).getByRole('button',{name:'View skill'})); await screen.findByText('PRIVATE_SKILL_BODY');
  fireEvent.click(within(card).getByRole('button',{name:'Update from source folder'}));
  await screen.findByText('Skill content updated and disabled. Review it again before enabling it.');
  expect(api.updateSkill).toHaveBeenCalledExactlyOnceWith(id);
  expect(screen.queryByText('PRIVATE_SKILL_BODY')).not.toBeInTheDocument();
  expect(within(card).getByRole('checkbox',{name:'Enable skill'})).not.toBeChecked();
  expect(api.readSkill).toHaveBeenCalledTimes(1);
  fireEvent.click(within(card).getByRole('button',{name:'View skill'})); await screen.findByText('UPDATED_SKILL_BODY');
  fireEvent.change(screen.getByLabelText('Task',{exact:true}),{target:{value:'Use this reference.'}});
  expect(screen.getByRole('button',{name:'Run with this skill'})).toBeDisabled();
  fireEvent.click(within(card).getByRole('checkbox',{name:'Enable skill'}));
  await waitFor(() => expect(screen.getByRole('button',{name:'Run with this skill'})).toBeEnabled());
  expect(api.toggle).toHaveBeenCalledExactlyOnceWith('skill',id,true);
  expect(api.runSkill).not.toHaveBeenCalled();
});

it('offers an explicit source choice for legacy skills and removes only the selected entry', async () => {
  const legacy = {id,name:'Legacy',enabled:false};
  const api = setup({skills:[legacy]}), card = await screen.findByRole('region',{name:'Legacy'});
  expect(within(card).getByRole('button',{name:'Choose folder to update'})).toBeInTheDocument();
  fireEvent.click(within(card).getByText('Source and revision'));
  expect(within(card).getByText('Not recorded for this older entry. Choose a folder when updating.')).toBeInTheDocument();
  fireEvent.click(within(card).getByRole('button',{name:'Remove'}));
  await screen.findByText('No skills installed yet.');
  expect(api.remove).toHaveBeenCalledExactlyOnceWith('skill',id);
  expect(api.updateSkill).not.toHaveBeenCalled(); expect(api.readSkill).not.toHaveBeenCalled();
});

it.each([
  {zh:true,code:'extensions.duplicateSkill',message:'此来源或相同内容的技能已经安装。请查看已有技能，使用更新操作。'},
  {zh:false,code:'extensions.duplicateSkill',message:'A skill from this source or with identical content is already installed. View the existing skill and use its update action.'},
  {zh:true,code:'extensions.invalidSkill',message:'无法读取有效的 SKILL.md。请选择包含 UTF-8 普通文件的目录，正文最多 32,000 个字符，不支持链接文件。'},
  {zh:false,code:'extensions.invalidSkill',message:'Could not read a valid SKILL.md. Choose a folder containing a regular UTF-8 file, up to 32,000 characters. Linked files are not supported.'},
])('uses a fixed skill error for $code in zh=$zh without exposing upstream details', async ({zh,code,message}) => {
  const api = setup({zh,skills:[]});
  await screen.findByText(zh ? '还没有安装技能。' : 'No skills installed yet.');
  api.installSkill.mockRejectedValueOnce(new Error(`${code}: PRIVATE_UPSTREAM_DETAIL`));
  fireEvent.click(screen.getByRole('button',{name:zh ? '从目录安装技能' : 'Install skill from folder'}));
  expect(await screen.findByRole('alert')).toHaveTextContent(message);
  expect(screen.queryByText(/PRIVATE_UPSTREAM_DETAIL/u)).not.toBeInTheDocument();
});

it('grants only the checked tools to desktop chat, pinned to the listed definitions', async () => {
  const api = setup({ section: 'mcp', servers: [{ ...server, enabled: true }] });
  const card = await screen.findByRole('region', { name: 'Local notes' });
  api.listTools.mockResolvedValueOnce([
    { name: 'search_notes', description: 'Search notes.', inputSchema: { type: 'object' }, digest: 'c'.repeat(64) },
    { name: 'delete_note', description: 'Delete a note.', inputSchema: { type: 'object' }, digest: 'd'.repeat(64) },
  ]);
  fireEvent.click(within(card).getByRole('button', { name: 'List tools' }));
  fireEvent.click(await screen.findByText('Use in desktop chat'));
  expect(screen.getByLabelText('search_notes')).not.toBeChecked();
  expect(screen.getByLabelText(/^Private/u)).toBeChecked();
  fireEvent.click(screen.getByLabelText('search_notes'));
  fireEvent.click(screen.getByRole('button', { name: 'Save chat settings' }));
  await screen.findByText('1 tools are now available in chat.');
  expect(api.setChatTools).toHaveBeenCalledExactlyOnceWith({ id: server.id, results: 'private', tools: [{ name: 'search_notes', digest: 'c'.repeat(64) }] });
  expect(await within(card).findByText(/1 tools available in chat · results treated as private/u)).toBeInTheDocument();
});
