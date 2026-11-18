import { _electron as electron, test, expect } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { estimateSerializedInputTokens } from '../../src/main/providers/input-token-estimate';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Wire {
  model:string; messages:Array<{role:string; content:string; tool_call_id?:string}>;
  tools?:Array<{function:{description:string;name:string}}>;
}

// One real desktop controller, only in-process loopback model fixtures.
// eslint-disable-next-line no-empty-pattern
test('desktop routing requires a cloud choice, protects private chats, and budgets history and sequential tool reads', async ({}) => {
  test.setTimeout(160000);
  const root = await realpath(await mkdtemp(join(tmpdir(),'deskpet-local-routing-')));
  await mkdir(join(root,'profile/workspace'),{recursive:true});
  await writeFile(join(root,'isolated-candidate.json'),JSON.stringify({version:1,purpose:'deskpet-isolated-candidate'}));
  const sample = (name:string) => Array.from({length:131},(_,i)=>createHash('sha256').update(name+String(i)).digest('hex')).join('');
  const firstPage = sample('first'), secondPage = sample('second');
  await writeFile(join(root,'profile/workspace/first.txt'),firstPage);
  await writeFile(join(root,'profile/workspace/second.txt'),secondPage);
  const wires:Wire[]=[];
  const server = createServer(async(req,res)=>{
    if (req.url === '/api/show') { res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({remote_host:'https://synthetic-cloud.invalid'}));return; }
    if (!req.url?.endsWith('/chat/completions')) {res.writeHead(200,{'content-type':'application/json'});res.end('{"data":[]}');return;}
    const data:Buffer[]=[]; for await (const chunk of req) data.push(Buffer.from(chunk));
    const wire:Wire=JSON.parse(Buffer.concat(data).toString()); wires.push(wire);
    const input = wire.messages.filter(m=>m.role==='user').at(-1)?.content;
    const results = wire.messages.filter(m=>m.role==='tool');
    let delta:Record<string,unknown>={content:'Fixture reply: '+wire.model};
    if (input?.startsWith('Transcript fixture ')) delta={content:input+' '+ 'z'.repeat(7400)};
    if (input==='Read the two fixture pages.' && results.length<2) {
      const name=wire.tools?.find(item=>item.function.description.startsWith('Read workspace file.'))?.function.name;
      const id = results.length ? 'second':'first';
      delta={tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify({path:id+'.txt',maxCharacters:10000})}}]};
    }
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address(); if(!address || typeof address==='string') throw Error('Loopback fixture unavailable');
  const entry=join(root,'launch.cjs'),compiled=join(process.cwd(),'.webpack',process.arch,'main/index.js');
  await writeFile(entry,[
    "const {dialog}=require('electron'); globalThis.routeChoice=0; globalThis.routePrompts=0;",
    "dialog.showMessageBox=async(...args)=>{ const opts=args.at(-1); if(opts.message==='Which model should handle this complex request?'){ globalThis.routePrompts++; return {response:globalThis.routeChoice,checkboxChecked:false}; } return {response:opts.cancelId??0,checkboxChecked:false}; };",
    'require('+JSON.stringify(compiled)+');',
  ].join('\n'));
  let app:ElectronApplication|undefined;
  try {
    const env:Record<string,string>={};
    for(const key of ['HOME','PATH','TMPDIR','LANG','DISPLAY']) if(process.env[key])env[key]=process.env[key]!;
    app=await electron.launch({args:[entry,'--deskpet-isolated-profile='+root],env});
    await expect.poll(()=>app!.windows().some(w=>w.url().includes('/main_window/'))).toBe(true);
    const page=app.windows().find(w=>w.url().includes('/main_window/'))!; await expect(page.locator('.app-shell')).toBeVisible();
    expect(await app.evaluate(({app})=>app.getPath('userData'))).toBe(join(root,'profile'));
    const ids=await page.evaluate(async baseUrl=>{
      await window.deskpet.app.setLocale('en');
      const localProviderId=crypto.randomUUID(),cloudProviderId=crypto.randomUUID();
      await window.deskpet.providers.upsert({id:localProviderId,kind:'lm-studio',name:'Fixture local',model:'fixture-local',localExecutionConfirmed:true,
        enabled:true,supportsTools:true,baseUrl,contextWindowTokens:32768,maxOutputTokens:512});
      await window.deskpet.providers.upsert({id:cloudProviderId,kind:'ollama',name:'Fixture cloud via loopback',model:'fixture:cloud',enabled:true,supportsTools:false,baseUrl});
      await window.deskpet.providers.select(localProviderId);
      await window.deskpet.providers.setRouting({enabled:true,localProviderId,cloudProviderId});
      const create=async(title:string)=>(await window.deskpet.chat.createSession({title,kind:'normal'})).id;
      return {localProviderId,cloudProviderId,public:await create('Routing fixture'),private:await create('Private route'),long:await create('Long transcript')};
    },'http://127.0.0.1:'+address.port+'/v1');
    const send=async(sessionId:string,content:string)=>{
      const started=await page.evaluate(args=>window.deskpet.chat.send(args),{sessionId,providerId:ids.cloudProviderId,content});
      const state=()=>page.evaluate(async({sessionId,runId})=>{
        const items=await window.deskpet.chat.listMessages(sessionId);
        const assistant=items.find(item=>item.role==='assistant' && item.requestReceipts?.some(r=>r.runId===runId)) ?? items.filter(item=>item.role==='assistant').at(-1);
        const interaction=await window.deskpet.chat.getInteraction(sessionId);
        return {terminal:!!assistant && assistant.status!=='streaming' && !interaction, status:assistant?.status,
          errorCode:assistant?.errorCode, progress:interaction?.progress.phase, waitingFor:interaction?.approval?.toolId,
          receipts:assistant?.requestReceipts?.map(r=>({estimate:r.inputEstimate,capacity:r.maxInputTokens,phase:r.phase}))};
      },{sessionId,runId:started.runId});
      await expect.poll(state,{timeout:20000}).toMatchObject({terminal:true});
      const end=await state();
      expect(end,JSON.stringify({end,wires:wires.map(w=>({model:w.model,toolPages:w.messages.filter(m=>m.role==='tool').length}))})).toMatchObject({status:'complete',errorCode:null});
    };
    const cloud=()=>wires.filter(w=>w.model==='fixture:cloud');
    const prompts=()=>app!.evaluate(()=> (globalThis as unknown as {routePrompts:number}).routePrompts);
    await send(ids.public,'Hello.'); expect(wires.at(-1)?.model).toBe('fixture-local');
    await send(ids.public,'Deep research on synthetic public data.'); expect(cloud()).toHaveLength(0); expect(await prompts()).toBe(1);
    await app.evaluate(()=>{(globalThis as unknown as {routeChoice:number}).routeChoice=1;});
    await send(ids.public,'A research report using this synthetic public question.'); expect(cloud()).toHaveLength(1);
    // Use only a temporary desktop grant in the synthetic profile.
    await app.evaluate(({dialog})=>{
      const prior=dialog.showMessageBox;
      dialog.showMessageBox=(async(...args:unknown[])=>{
        const opts=args.at(-1) as {message:string};
        if(opts.message==='Which model should handle this complex request?') return prior(opts);
        return {response:1,checkboxChecked:false};
      }) as typeof dialog.showMessageBox;
    });
    await page.evaluate(()=>window.deskpet.permissions.request({capabilityId:'workspace.read',duration:'session'}));
    // Calibrate against this build's actual tool declarations. Both pages must fit
    // individually, while their combined original payload exceeds the same budget.
    const baseline = wires[0]!;
    const wireCost = (wire:Wire) => estimateSerializedInputTokens(JSON.stringify(wire)) + 64 + wire.messages.length * 16 + (wire.tools?.length ?? 0) * 32;
    const afterRead = {...baseline,tools:baseline.tools?.filter(tool=>!tool.function.description.startsWith('Search web.') && !tool.function.description.startsWith('Read HTTPS page.')) ?? []};
    const pageReply = (name:string,content:string) => ({role:'tool',tool_call_id:name,content:JSON.stringify({content,offset:0,totalCharacters:content.length,nextOffset:null,truncated:false,sourceSHA256:createHash('sha256').update(content).digest('hex')})});
    const estimates=[pageReply('first',firstPage),pageReply('second',secondPage)].map(page=>wireCost({...afterRead,messages:[...afterRead.messages,page]}));
    const contextWindowTokens=Math.max(wireCost(baseline),...estimates) + 1152 + 512 + 256;
    expect(wireCost({...afterRead,messages:[...afterRead.messages,pageReply('first',firstPage),pageReply('second',secondPage)]})).toBeGreaterThan(contextWindowTokens);
    await page.evaluate(async({id,contextWindowTokens})=>{
      const provider=(await window.deskpet.providers.list()).find(item=>item.id===id)!;
      const {secretState,...config}=provider;void secretState;
      await window.deskpet.providers.upsert({...config,contextWindowTokens});
    },{id:ids.localProviderId,contextWindowTokens});
    await send(ids.private,'Read the two fixture pages.');
    const third=wires.at(-1)!, pages=third.messages.filter(m=>m.role==='tool');
    expect(pages).toHaveLength(2);
    expect(JSON.parse(pages[0]!.content)).toMatchObject({compressed:true,tool:'workspace.read',source:'first.txt',offset:0});
    expect(JSON.parse(pages[1]!.content).content).toBe(secondPage);
    const before=await prompts();
    await send(ids.private,'Deep research on these private files.');
    expect(await prompts()).toBe(before); expect(cloud()).toHaveLength(1);
    expect(JSON.stringify(cloud())).not.toContain(firstPage.slice(0,64));
    for(let i=1;i<=5;i++)await send(ids.long,'Transcript fixture '+i);
    const last=wires.at(-1)!;
    expect(last.messages.some(m=>m.role==='assistant' && m.content.startsWith('Earlier conversation excerpts') && m.content.includes('Transcript fixture 1'))).toBe(true);
    await page.evaluate(id=>window.deskpet.chat.openSession(id),ids.long);
    await expect(page.getByText(/older messages are represented by quoted excerpts/).last()).toBeVisible();
  } finally {
    await app?.close(); server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve()));
    await rm(root,{recursive:true,force:true});
  }
});
