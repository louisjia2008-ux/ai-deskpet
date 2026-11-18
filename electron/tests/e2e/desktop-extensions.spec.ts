import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type ReviewState = { __mcpReview: { allow: boolean; prompts: string[] } };

// eslint-disable-next-line no-empty-pattern
test('desktop installs and runs a local skill; MCP sends only the individually approved arguments', async ({}) => {
  test.setTimeout(95_000);
  const root = await realpath(await mkdtemp(join(tmpdir(),'deskpet-extensions-e2e-')));
  const folder = join(root, 'synthetic-skill');
  await mkdir(folder); await writeFile(join(folder,'SKILL.md'), '---\nname: Fixture skill\n---\nSKILL_LOCAL_MARKER');
  await writeFile(join(root,'isolated-candidate.json'), JSON.stringify({ version:1, purpose:'deskpet-isolated-candidate' }));
  const calls: unknown[] = [], modelWires: string[] = [];
  let redirected = false, mcpInits = 0;
  const server = createServer(async (req,res) => {
    const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
    const raw = Buffer.concat(parts).toString('utf8');
    if (req.url === '/redirect') { res.writeHead(307,{ location:'/should-never-receive' }).end(); return; }
    if (req.url === '/should-never-receive') { redirected = true; res.writeHead(500).end(); return; }
    if (req.url === '/api/show') {
      const model=JSON.parse(raw).model;
      res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(model === 'unverified' ? {} :
        { details:{format:'gguf'},model_info:{'general.architecture':'qwen','qwen.context_length':16384} }));return;
    }
    if (req.url === '/v1/chat/completions') {
      modelWires.push(raw);
      res.writeHead(200,{ 'content-type':'text/event-stream' });
      const proposed=raw.includes('Propose exactly one call');
      if(proposed && raw.includes('HOLD_PROPOSAL_UNTIL_CANCEL'))return;
      const delta= proposed ? {tool_calls:[{index:0,id:'proposal',type:'function',function:{name:'selected_tool',arguments:'{"text":"approved model argument"}'}}]}
        : {content:raw.includes('Explain the selected tool result')?'LOCAL_ONE_SHOT_EXPLANATION':'Synthetic skill task finished.'};
      res.end('data: ' + JSON.stringify({ choices:[{ delta,finish_reason:proposed?'tool_calls':'stop' }] }) + '\n\ndata: [DONE]\n\n'); return;
    }
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    if (req.method === 'DELETE') { res.writeHead(204).end(); return; }
    const body = JSON.parse(raw);
    if (body.method === 'initialize') mcpInits++;
    if (body.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
    const result = body.method === 'initialize' ? {protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}
      : body.method === 'tools/list' ? {tools:[{name:'echo',description:'Echo the provided text.',inputSchema:{type:'object',properties:{text:{type:'string'}}}},
        {name:'unselected_tool',description:'UNSELECTED_DESCRIPTION',inputSchema:{type:'object'}}]}
      : { content:[{type:'text',text:'MCP_RESULT_VISIBLE_ONLY_HERE'}] };
    if (body.method === 'tools/call') calls.push(body.params);
    res.writeHead(200,{ 'content-type':'application/json', ...(body.method === 'initialize' ? { 'Mcp-Session-Id':'e2e-session' } : {}) });
    res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve)); const origin='http://127.0.0.1:'+ (server.address() as AddressInfo).port;
  const manifest=join(root,'servers.json');
  await writeFile(manifest,JSON.stringify({mcpServers:{'Local fixture MCP':{url:origin+'/mcp'},duplicate:{type:'http',url:origin+'/mcp'},
    command:{command:'node',args:['ignored']}}}));
  let app: ElectronApplication | undefined;
  try {
    const env: Record<string,string> = {};
    for (const key of ['PATH','HOME','TMPDIR','LANG','LC_ALL','DISPLAY']) if (process.env[key]) env[key]=process.env[key]!;
    app=await electron.launch({args:[join(process.cwd(),'.webpack',process.arch,'main/index.js'),'--deskpet-isolated-profile='+root],env});
    await app.evaluate(({dialog}, paths) => {
      const review = { allow:false, prompts:[] as string[] };
      (globalThis as unknown as ReviewState).__mcpReview = review;
      dialog.showOpenDialog = async (...args: unknown[]) => {
        const options=args.at(-1) as Electron.OpenDialogOptions;
        return {canceled:false,filePaths:[options.properties?.includes('openFile') ? paths.manifest : paths.folder]};
      };
      dialog.showMessageBox = async (...args: unknown[]) => {
        const options = args.at(-1) as Electron.MessageBoxOptions;
        if (options.title !== 'Allow this MCP call?') return { response:options.cancelId ?? 0, checkboxChecked:false };
        review.prompts.push((options.message ?? '') + '\n' + (options.detail ?? ''));
        const response = review.allow ? 1 : 0; review.allow=false;
        return {response,checkboxChecked:false};
      };
    },{folder,manifest});
    await expect.poll(()=>app!.windows().some(page=>page.url().includes('/main_window/'))).toBe(true);
    const page=app.windows().find(p=>p.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    const blockedTargets = await page.evaluate(async baseUrl => {
      await window.deskpet.app.setLocale('en');
      const make = (model: string) => window.deskpet.providers.upsert({ id:crypto.randomUUID(),name:model,
        kind:'ollama', model,baseUrl,enabled:true,supportsTools:model==='fixture',localExecutionConfirmed:true });
      await make('fixture'); return [await make('unverified'),await make('fixture:cloud')].map(p=>({id:p.id,model:p.model}));
    },origin+'/v1');
    await page.reload(); await expect(page.locator('.app-shell')).toBeVisible();
    await page.locator('nav').getByRole('button',{name:'Settings',exact:true}).click();
    await page.getByRole('tab',{name:'Skills',exact:true}).click();
    let panel=page.getByRole('group',{name:'Skills',exact:true});
    await panel.getByRole('button',{name:'Install skill from folder'}).click();
    await panel.getByRole('button',{name:'View skill'}).click();
    await expect(panel.getByText('SKILL_LOCAL_MARKER',{exact:false})).toBeVisible();
    await expect(panel.getByRole('button',{name:'Run with this skill'})).toBeDisabled();
    // The controlled checkbox reports the committed encrypted host state, not the pending click.
    const enableSkill = panel.getByLabel('Enable skill');
    await enableSkill.click(); await expect(enableSkill).toBeChecked();
    await panel.getByLabel('Task',{exact:true}).fill('Use the selected skill for this task.');
    for (const target of blockedTargets) {
      const blocked = await page.evaluate(async provider=>{
        const ext=window.deskpet.plugins.extensions, id=(await ext.state()).skills[0]!.id;
        try { await ext.runSkill({id, operationId:crypto.randomUUID(), task:'blocked unknown destination',providerId:provider.id,model:provider.model}); return false; } catch { return true; }
      },target);
      expect(blocked).toBe(true);
    } expect(modelWires).toHaveLength(0);
    await panel.getByLabel('Model (local only)').selectOption({ label:'fixture · fixture' });
    await panel.getByRole('button',{name:'Run with this skill'}).click();
    await expect(panel.getByText('Synthetic skill task finished.',{exact:true})).toBeVisible({timeout:20_000});
    expect(modelWires).toHaveLength(1); expect(modelWires[0]).toContain('SKILL_LOCAL_MARKER');
    expect(JSON.parse(modelWires[0]!)).toMatchObject({tool_choice:'none'});
    await page.getByRole('tab',{name:'MCP servers',exact:true}).click();
    panel=page.getByRole('group',{name:'MCP servers',exact:true});
    await panel.getByRole('button',{name:'Import JSON manifest'}).click();
    const preview=panel.getByRole('region',{name:'Manifest preview'});
    await expect(preview.getByText('Local fixture MCP',{exact:true})).toBeVisible();
    await expect(preview.getByText(/Duplicates: 1.*Unsupported entries skipped.*: 1/u)).toBeVisible();
    expect(mcpInits).toBe(0);
    await preview.getByRole('button',{name:'Connect and preview tools'}).click();
    await expect(preview.getByText('echo',{exact:true})).toBeVisible(); expect(calls).toEqual([]);
    await preview.getByRole('button',{name:'Import as disabled'}).click();
    await expect(preview).toHaveCount(0);
    await expect(panel.getByRole('button',{name:'List tools'})).toBeDisabled();
    const enableServer = panel.getByLabel('Enable server');
    await enableServer.click(); await expect(enableServer).toBeChecked();
    await panel.getByRole('button',{name:'List tools'}).click();
    await panel.getByLabel('Arguments (JSON object)').fill('{"text":"owner text"}');
    await panel.getByRole('button',{name:'Review and call'}).click();
    await expect(panel.getByRole('alert')).toHaveText('This call was denied.');
    expect(calls).toEqual([]);
    await app.evaluate(()=>{ (globalThis as unknown as ReviewState).__mcpReview.allow=true; });
    await panel.getByRole('button',{name:'Review and call'}).click();
    await expect(panel.getByText('MCP_RESULT_VISIBLE_ONLY_HERE',{exact:true})).toBeVisible();
    expect(calls).toEqual([{name:'echo',arguments:{text:'owner text'}}]); expect(modelWires).toHaveLength(1);
    const prompts=await app.evaluate(()=>(globalThis as unknown as ReviewState).__mcpReview.prompts);
    expect(prompts).toHaveLength(2); expect(prompts[1]).toContain(origin+'/mcp'); expect(prompts[1]).toContain('"text": "owner text"');
    await panel.getByText('Ask with this tool only',{exact:true}).click();
    await panel.getByLabel('Question for this tool').fill('QUESTION_ONLY_IN_LOCAL_CONTEXT');
    await panel.getByLabel('Local tool model').selectOption({label:'fixture · fixture'});
    const ask=panel.getByRole('button',{name:'Propose arguments locally'});
    await ask.click();await expect(panel.getByRole('alert')).toHaveText('This call was denied.');
    expect(calls).toHaveLength(1);
    await app.evaluate(()=>{(globalThis as unknown as ReviewState).__mcpReview.allow=true;});
    await ask.click();await expect(panel.getByText('LOCAL_ONE_SHOT_EXPLANATION',{exact:true})).toBeVisible({timeout:20_000});
    expect(calls).toHaveLength(2);expect(calls[1]).toEqual({name:'echo',arguments:{text:'approved model argument'}});
    expect(JSON.stringify(calls)).not.toContain('QUESTION_ONLY_IN_LOCAL_CONTEXT');
    const proposals=modelWires.filter(raw=>raw.includes('Propose exactly one call'));
    expect(proposals).toHaveLength(2);
    const proposal=JSON.parse(proposals[1]!);
    expect(proposal.tools).toHaveLength(1);
    expect(proposal.tools[0].function.name).toBe('selected_tool');
    expect(proposals[1]).not.toMatch(/UNSELECTED_DESCRIPTION|SKILL_LOCAL_MARKER|MCP_RESULT_VISIBLE_ONLY_HERE/u);
    const explanation=modelWires.find(raw=>raw.includes('Explain the selected tool result'))!;
    expect(JSON.parse(explanation)).toMatchObject({model:'fixture',tool_choice:'none'});
    expect(explanation).toContain('MCP_RESULT_VISIBLE_ONLY_HERE');expect(explanation).not.toContain('SKILL_LOCAL_MARKER');
    const current=await page.evaluate(async()=>{const ext=window.deskpet.plugins.extensions;const s=(await ext.state()).servers[0]!;
      const tool=(await ext.listTools(s.id))[0]!;return {id:s.id,name:tool.name,digest:tool.digest};});
    const beforeCloud=mcpInits;
    const blockedCloud=await page.evaluate(async({target,unknown})=>{try {
      await window.deskpet.plugins.extensions.askTool({...target,operationId:crypto.randomUUID(),providerId:unknown.id,model:unknown.model,question:'reject'});
      return false;
    }catch{return true;}},{target:current,unknown:blockedTargets[1]!});
    expect(blockedCloud).toBe(true);expect(mcpInits).toBe(beforeCloud);
    await panel.getByLabel('Question for this tool').fill('HOLD_PROPOSAL_UNTIL_CANCEL');
    await ask.click();await expect.poll(()=>modelWires.some(w=>w.includes('HOLD_PROPOSAL_UNTIL_CANCEL'))).toBe(true);
    await page.getByRole('button',{name:'Cancel this tool question'}).click();
    await expect(ask).toBeEnabled();expect(calls).toHaveLength(2);
    const deniedRedirect=await page.evaluate(async address=>{
      const ext=window.deskpet.plugins.extensions;
      const state=await ext.addServer('Redirect test',address); const id=state.servers.find(s=>s.name==='Redirect test')!.id;
      await ext.toggle('server',id,true); try { await ext.listTools(id); return false; } catch { return true; }
    },origin+'/redirect');
    expect(deniedRedirect).toBe(true); expect(redirected).toBe(false);
    const overlay=app.windows().find(p=>p.url().includes('/overlay_window/'))!;
    expect(await overlay.evaluate(async()=>{try { await window.deskpet.plugins.extensions.state(); return false; } catch { return true; }})).toBe(true);
  } finally {
    await app?.close().catch(()=>undefined); server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); await rm(root,{recursive:true,force:true});
  }
});
