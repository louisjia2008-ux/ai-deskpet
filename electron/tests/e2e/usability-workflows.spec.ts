import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type * as NodeFS from 'node:fs';
import type * as NodePath from 'node:path';
import type * as NodeOS from 'node:os';
import type * as NodeDNS from 'node:dns/promises';
import type * as NodeHTTPS from 'node:https';
import type * as NodeHTTP from 'node:http';
import type * as NodeModule from 'node:module';
import { createRequire } from 'node:module';
import type * as Undici from 'undici';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ResearchTask } from '../../src/shared/research-tasks';

interface Wire { messages: Array<{role:string;content:string;tool_call_id?:string}>; tools?:Array<{function:{name:string;description:string}}> }
interface EmbeddingFixtureCall { method:string; path:string; model?:string; inputs?:number; queries?:number; documents?:number }
interface EmbeddingFixtureDiagnostic { phase:string; category:string; code?:string; method?:string; path?:string }
interface EmbeddingFixtureGlobal { __usabilityEmbeddingCalls:EmbeddingFixtureCall[]; __usabilityEmbeddingDiagnostics:EmbeddingFixtureDiagnostic[] }
const titles: Record<string,string> = {'tools.discover':'Load more tools.','skills.list':'List enabled skills.','skills.read':'Read one enabled skill.',
  'research.read':'Read a verified research artifact.','web.search':'Search web.','web.read':'Read HTTPS page.','workspace.read':'Read workspace file.','workspace.write':'Write workspace file.'};
const hash = (value:string|Buffer):string => createHash('sha256').update(value).digest('hex');
const source = 'https://usability.fixture.example/article';
const sourceLiteral = 'USABILITY_PUBLIC_SOURCE: The fixture recorded 37 units.';
const preference = 'SYNTHETIC_PRIVATE_PREFERENCE：我偏好简洁直接的回答，先给结论，再解释理由。';
const method = 'PUBLIC_REUSABLE_METHOD: Read the source, preserve uncertainty, and report the source URL.';
const output = <T>(wire:Wire,id:string):T|undefined => {
  const message = wire.messages.find(item => item.role === 'tool' && item.tool_call_id === id);
  return message ? JSON.parse(message.content) as T : undefined;
};
const respond = (response:ServerResponse,wire:Wire,call?:{id:string;tool:string;input:unknown},content=''):void => {
  const descriptor = call && wire.tools?.find(item => item.function.description.startsWith(titles[call.tool]!));
  if (call && !descriptor) throw new Error(`Missing ${call.tool}`);
  const delta = call ? {tool_calls:[{index:0,id:call.id,type:'function',function:{name:descriptor!.function.name,arguments:JSON.stringify(call.input)}}]} : {content};
  response.writeHead(200,{'content-type':'text/event-stream'});
  response.end(`data: ${JSON.stringify({choices:[{delta,finish_reason:call?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:30,total_tokens:130}})}\n\ndata: [DONE]\n\n`);
};

/** Real Electron renderer, IPC, runtime, encrypted persistence, PDF renderer and
 * files; model/embedding and exactly two public-looking web hosts are fixtures.
 * No daily profile, real credential, personal memory or external network is used.
 * Set DESKPET_USABILITY_EXECUTABLE to the actual .app/Contents/MacOS executable
 * for packaged acceptance. DESKPET_USABILITY_ARTIFACT_MODE defaults to
 * validation-candidate for that path (set daily only when testing a daily build).
 * Native Keychain/safeStorage is never stubbed; any OS confirmation stays native. */
// eslint-disable-next-line no-empty-pattern
test('background research delivers inspectable artifacts, reviewed methods compose with web, and local recall stays explicit', async ({}, info) => {
  test.setTimeout(360_000);
  const root = await realpath(await mkdtemp(join(tmpdir(),'deskpet-usability-'))), profile = join(root,'profile');
  await writeFile(join(root,'isolated-candidate.json'),JSON.stringify({version:1,purpose:'deskpet-isolated-candidate'}));
  const errors:string[] = [], researchWires:Wire[] = [], editWires:Wire[] = [], launches:unknown[] = [];
  const embeddingFixtureCalls:Array<{launch:number;calls:EmbeddingFixtureCall[]}>=[];
  const embeddingHTTPCalls:EmbeddingFixtureCall[]=[],embeddingHTTPDiagnostics:EmbeddingFixtureDiagnostic[]=[];
  let application:ElectronApplication|undefined, page:Page|undefined;
  let gatedWeb:ServerResponse|undefined, resumeGate:ServerResponse|undefined, releaseWeb=false, expectedReport='';
  const firstReport='# First attempt\n\nVerified selected material.\n', resumedReport='# Continued report\n\nFirst result preserved; remaining section completed.\n';
  const editSection='\n## Requested edit\n\nEDITED_ARTIFACT_SENTINEL: added through the original conversation.\n';
  const server = createServer((request,response) => {
    const chunks:Buffer[]=[]; request.on('data',(chunk:Buffer)=>chunks.push(chunk)); request.on('end',()=>{
      try {
        if(request.url?.startsWith('/__embedding/')){
          const call:EmbeddingFixtureCall={method:request.method??'',path:request.url.slice('/__embedding'.length)};
          embeddingHTTPCalls.push(call);
          try{
            const payload=chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')) as {model?:string;input?:unknown;truncate?:boolean;keep_alive?:number}:{};
            let body:unknown;
            if(call.path==='/api/ps'&&call.method==='GET')body={models:[]};
            else if(call.path==='/api/show'&&call.method==='POST'&&payload.model==='nomic-embed-text'){
              call.model=payload.model;body={details:{format:'gguf'},capabilities:['embedding']};
            }else if(call.path==='/api/embed'&&call.method==='POST'&&payload.model==='nomic-embed-text'
              &&Array.isArray(payload.input)&&payload.input.every(input=>typeof input==='string')&&payload.truncate===false&&payload.keep_alive===0){
              const input=payload.input as string[];call.model=payload.model;call.inputs=input.length;
              call.queries=input.filter(value=>value.startsWith('search_query: ')).length;
              call.documents=input.filter(value=>value.startsWith('search_document: ')).length;
              body={embeddings:input.map(()=>Array.from({length:768},(_,index)=>index===0?1:0))};
            }else throw new Error('Unexpected isolated embedding request');
            response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(body));return;
          }catch(cause){
            embeddingHTTPDiagnostics.push({phase:'fixture-response',category:cause instanceof SyntaxError?'invalid-json':'unexpected-request',method:call.method,path:call.path});
            throw cause;
          }
        }
        const host = request.headers['x-usability-host'];
        if (host) {
          if (host === 'www.bing.com') { response.writeHead(200,{'content-type':'text/html'}).end(`<ol><li class="b_algo"><h2><a href="${source}">Fixture evidence</a></h2><div class="b_caption"><p>Observed synthetic units.</p></div></li></ol>`); return; }
          if (host === 'usability.fixture.example') {
            if (!releaseWeb) { gatedWeb=response; return; }
            response.writeHead(200,{'content-type':'text/html'}).end(`<html><head><title>Fixture evidence</title></head><body><p>${sourceLiteral}</p></body></html>`); return;
          }
          throw new Error('Unexpected fixture host');
        }
        if (request.url === '/api/show') { response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({details:{format:'gguf'},model_info:{'general.architecture':'qwen','qwen.context_length':32768}})); return; }
        if (request.url === '/v1/models') { response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({data:[{id:'usability-fixture'}]})); return; }
        if (request.url !== '/v1/chat/completions') throw new Error('Unexpected fixture route');
        const wire = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Wire;
        const prompt = wire.messages.filter(item=>item.role==='user').at(-1)?.content ?? '';
        if (prompt.includes('USABILITY_EDIT_ARTIFACT:')) {
          editWires.push(wire);
          const path=prompt.match(/research\/[a-f0-9-]{36}\/report\.md/u)?.[0]; expect(path).toBeTruthy();
          expect(prompt).toContain(hash(expectedReport)); expect(prompt).not.toContain('.pdf');
          const read=output<{content:string;sourceSHA256:string;truncated:boolean}>(wire,'edit-read');
          if(!read){respond(response,wire,{id:'edit-read',tool:'workspace.read',input:{path,maxCharacters:8000}});return;}
          expect(read).toMatchObject({content:expectedReport,sourceSHA256:hash(expectedReport),truncated:false});
          const edited=expectedReport+editSection, written=output<{written:boolean;path:string;bytes:number;sha256:string}>(wire,'edit-write');
          if(!written){respond(response,wire,{id:'edit-write',tool:'workspace.write',input:{path,content:edited}});return;}
          expect(written).toMatchObject({written:true,path,bytes:Buffer.byteLength(edited),sha256:hash(edited)});
          respond(response,wire,undefined,'USABILITY_EDIT_COMPLETE: source file updated and write receipt verified.');return;
        }
        if (prompt.includes('RESUME_RESEARCH:')) {
          const path=prompt.match(/research\/[a-f0-9-]{36}\/report\.md/u)![0];
          const resumed=prompt.includes('Verified previous report (quoted material');
          if(resumed && !output(wire,'resume-read')) {respond(response,wire,{id:'resume-read',tool:'research.read',input:{path,maxCharacters:8000}});return;}
          if(resumed)expect(JSON.stringify(output(wire,'resume-read'))).toContain('First attempt');
          if(!output(wire,'resume-write')) {respond(response,wire,{id:'resume-write',tool:'workspace.write',input:{path,content:resumed?resumedReport:firstReport}});return;}
          if(!resumed){resumeGate=response;return;}
          respond(response,wire,undefined,'RESUME_COMPLETE: previous result read and preserved.');return;
        }
        if(prompt.includes('OUTSIDE_RESEARCH:')) {respond(response,wire,{id:'outside-write',tool:'workspace.write',input:{path:'outside-task.md',content:'MUST_NOT_WRITE'}});return;}
        if (prompt.includes('USABILITY_RESEARCH:')) {
          researchWires.push(wire); expect(JSON.stringify(wire)).not.toContain(preference);
          expect(wire.tools?.every(item=>/^(Search web\.|Read HTTPS page\.|Calculate expression\.|Current time\.|Update current task plan\.|Write workspace file\.|Read a verified research artifact\.)/u.test(item.function.description))).toBe(true);
          const found = output<{results:Array<{url:string}>}>(wire,'research-search');
          if (!found) {respond(response,wire,{id:'research-search',tool:'web.search',input:{query:'fixture observations site:usability.fixture.example'}});return;}
          expect(found.results[0]?.url).toBe(source);
          const read = output<{url:string;text:string}>(wire,'research-read');
          if (!read) {respond(response,wire,{id:'research-read',tool:'web.read',input:{url:source}});return;}
          expect(read.text).toContain(sourceLiteral);
          const path = prompt.match(/research\/[a-f0-9-]{36}\/report\.md/u)?.[0]; expect(path).toBeTruthy();
          expectedReport=`# Usability report\n\n${sourceLiteral}\n\nSource: ${read.url}\n`;
          if (!output(wire,'research-write')) {respond(response,wire,{id:'research-write',tool:'workspace.write',input:{path,content:expectedReport}});return;}
          respond(response,wire,undefined,'USABILITY_RESEARCH_COMPLETE: report saved with verified source.');return;
        }
        if (prompt.includes('PUBLIC_METHOD_TASK:')) {
          if (!output(wire,'discover')) {respond(response,wire,{id:'discover',tool:'tools.discover',input:{group:'skills'}});return;}
          const list = output<{skills:Array<{id:string}>;privacy:string}>(wire,'catalog');
          if (!list) {respond(response,wire,{id:'catalog',tool:'skills.list',input:{}});return;}
          expect(list.privacy).toBe('cloud-allowed'); expect(list.skills).toHaveLength(1);
          if (!output(wire,'method')) {respond(response,wire,{id:'method',tool:'skills.read',input:{id:list.skills[0]!.id}});return;}
          expect(JSON.stringify(output(wire,'method'))).toContain(method);
          if (!output(wire,'method-web')) {respond(response,wire,{id:'method-web',tool:'web.read',input:{url:source}});return;}
          expect(JSON.stringify(output(wire,'method-web'))).toContain(sourceLiteral);
          respond(response,wire,undefined,'PUBLIC_METHOD_COMPLETE: reviewed method and source used in one task.');return;
        }
        respond(response,wire,undefined,'CONCURRENT_CHAT_COMPLETE');
      } catch (cause) { errors.push(cause instanceof Error ? cause.stack ?? cause.message : String(cause)); if (!response.headersSent) response.writeHead(500); response.end('Synthetic assertion failed'); }
    });
  });
  try {
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const address=server.address(); if (!address||typeof address==='string') throw new Error('No fixture port');
    const entry=join(process.cwd(),'.webpack',process.arch,'main/index.js');
    const executableInput=process.env.DESKPET_USABILITY_EXECUTABLE;
    const executablePath=executableInput ? await realpath(executableInput) : undefined;
    const artifactMode=process.env.DESKPET_USABILITY_ARTIFACT_MODE ?? (executablePath ? 'validation-candidate' : 'daily');
    if(!['daily','validation-candidate'].includes(artifactMode))throw new Error('Invalid DESKPET_USABILITY_ARTIFACT_MODE');
    // The packaged route launches the native executable. It never loads app.asar
    // through a source/bootstrap entry and cannot turn isPackaged into a mock.
    const expectedAsar=executablePath ? await realpath(join(dirname(dirname(executablePath)),'Resources','app.asar')) : null;
    const archiveSHA256=expectedAsar ? hash(await readFile(expectedAsar)) : null;
    const sourceMainSHA256=executablePath ? null : hash(await readFile(entry));
    const undiciEntry=createRequire(join(process.cwd(),'package.json')).resolve('undici');
    const env:Record<string,string>={NODE_ENV:'test'};for(const key of ['PATH','HOME','TMPDIR','LANG','LC_ALL','DISPLAY'])if(process.env[key])env[key]=process.env[key]!;
    const launch=async ():Promise<Page>=>{
      application=await electron.launch({cwd:process.cwd(),env,timeout:120_000,
        ...(executablePath ? {executablePath,args:['--deskpet-isolated-profile='+root]} : {args:[entry,'--deskpet-isolated-profile='+root]})});
      await expect.poll(()=>application!.windows().some(window=>window.url().includes('/main_window/'))).toBe(true);
      page=application.windows().find(window=>window.url().includes('/main_window/'))!;
      await expect(page.locator('.app-shell')).toBeVisible();
      const identity=await page.evaluate(()=>window.deskpet.app.getDiagnostics());
      expect(identity.runtimeIdentity).toMatchObject({dataDirectory:profile,isPackaged:Boolean(executablePath),artifactMode,runtimeApplicationName:'DeskPet Electron Candidate'});
      if(executablePath)expect(identity.runtimeIdentity).toMatchObject({appPath:expectedAsar,executablePath});
      else expect(identity.runtimeIdentity?.mainBundleSHA256).toBe(sourceMainSHA256);
      expect(identity.runtimeIdentity?.mainBundleSHA256).toMatch(/^[a-f0-9]{64}$/u);
      launches.push(identity.runtimeIdentity);
      // Install synthetic transport/dialog hooks only after the actual launched
      // application's immutable identity and isolated profile have been checked.
      await application.evaluate(({app,dialog},fixture)=>{
        const runtime=process as typeof process & {mainModule:{require(id:string):unknown}};
        const fs=runtime.mainModule.require('node:fs') as typeof NodeFS;
        const path=runtime.mainModule.require('node:path') as typeof NodePath;
        const os=runtime.mainModule.require('node:os') as typeof NodeOS;
        const marker=JSON.parse(fs.readFileSync(path.join(fixture.root,'isolated-candidate.json'),'utf8')) as {version:number;purpose:string};
        const canonical=fs.realpathSync(fixture.root);
        const assertIsolated=():void=>{
          if(process.env.NODE_ENV!=='test'||!process.argv.includes('--deskpet-isolated-profile='+fixture.root)
            ||path.dirname(canonical)!==fs.realpathSync(os.tmpdir())||!path.basename(canonical).startsWith('deskpet-usability-')
            ||app.getPath('userData')!==path.join(canonical,'profile')||marker.version!==1||marker.purpose!=='deskpet-isolated-candidate'
            ||app.isPackaged!==Boolean(fixture.executablePath)
            ||(fixture.executablePath&&(app.getAppPath()!==fixture.expectedAsar||fs.realpathSync(process.execPath)!==fixture.executablePath)))throw new Error('Refusing fixture instrumentation outside the selected isolated runtime');
        };
        assertIsolated();
        const dns=runtime.mainModule.require('node:dns/promises') as typeof NodeDNS;
        const https=runtime.mainModule.require('node:https') as typeof NodeHTTPS;
        const http=runtime.mainModule.require('node:http') as typeof NodeHTTP;
        const module=runtime.mainModule.require('node:module') as typeof NodeModule;
        const hosts=new Set(['www.bing.com','usability.fixture.example']);
        const lookup=dns.lookup as (hostname:string,options?:unknown)=>Promise<unknown>;
        dns.lookup=((hostname:string,options?:{all?:boolean})=>{
          if(!hosts.has(hostname))return lookup(hostname,options);
          assertIsolated();return Promise.resolve(options?.all?[{address:'93.184.216.34',family:4}]:{address:'93.184.216.34',family:4});
        }) as typeof dns.lookup;
        const request=https.request;
        https.request=((...args:[NodeHTTPS.RequestOptions|string|URL, (NodeHTTPS.RequestOptions|((response:NodeHTTP.IncomingMessage)=>void))?, ((response:NodeHTTP.IncomingMessage)=>void)?])=>{
          const options=args[0];
          if(typeof options==='object'&&!(options instanceof URL)&&hosts.has(String(options.servername))){
            assertIsolated();return http.request({...options,protocol:'http:',hostname:'127.0.0.1',port:fixture.port,
              headers:{...options.headers,'x-usability-host':options.servername}},args[1] as ((response:NodeHTTP.IncomingMessage)=>void)|undefined);
          }
          return Reflect.apply(request,https,args) as NodeHTTP.ClientRequest;
        }) as typeof https.request;
        module.syncBuiltinESMExports();
        // OllamaKnowledgeEmbeddings captures fetch in its constructor. Replacing
        // globalThis.fetch after startup misses that reference. Node's captured
        // fetch still consults the Undici global dispatcher on every request.
        const undici=runtime.mainModule.require(fixture.undiciEntry) as typeof Undici;
        const embeddingCalls:EmbeddingFixtureCall[]=[];
        const embeddingDiagnostics:EmbeddingFixtureDiagnostic[]=[];
        const fixtureGlobal=globalThis as unknown as EmbeddingFixtureGlobal;
        fixtureGlobal.__usabilityEmbeddingCalls=embeddingCalls;
        fixtureGlobal.__usabilityEmbeddingDiagnostics=embeddingDiagnostics;
        const originalDispatcher=undici.getGlobalDispatcher();
        const recordFailure=(phase:string,cause:unknown,method:string,path:string):void=>{
          const error=cause as {name?:unknown;code?:unknown};
          const code=typeof error?.code==='string'&&/^[A-Z_0-9]{1,80}$/u.test(error.code)?error.code:undefined;
          embeddingDiagnostics.push({phase,category:error?.name==='SyntaxError'?'SyntaxError':error?.name==='TypeError'?'TypeError':'transport-error',
            ...(code?{code}:{}),method,path});
        };
        class IsolatedEmbeddingDispatcher extends undici.Dispatcher {
          override dispatch(options:Undici.Dispatcher.DispatchOptions,handler:Undici.Dispatcher.DispatchHandler):boolean {
            const origin=options.origin===undefined ? undefined : new URL(options.origin).origin;
            if(origin!=='http://127.0.0.1:11434')return originalDispatcher.dispatch(options,handler);
            assertIsolated();
            const call:EmbeddingFixtureCall={method:options.method,path:options.path};embeddingCalls.push(call);
            const diagnosticHandler=new Proxy(handler,{get(target,key){
              if(key==='onError')return (cause:Error):void=>{recordFailure('dispatch-response',cause,call.method,call.path);target.onError?.(cause);};
              const member=Reflect.get(target,key,target) as unknown;
              return typeof member==='function'?member.bind(target):member;
            }});
            // Redirect this exact origin to the existing synthetic HTTP server.
            // Keep native fetch body streaming and handler semantics intact;
            // every unexpected path still reaches only the fixture and fails.
            try{return originalDispatcher.dispatch({...options,origin:`http://127.0.0.1:${fixture.port}`,path:'/__embedding'+options.path},diagnosticHandler);}
            catch(cause){recordFailure('dispatch',cause,call.method,call.path);throw cause;}
          }
        }
        assertIsolated();
        undici.setGlobalDispatcher(new IsolatedEmbeddingDispatcher());
        // Electron app dialogs only. Never modify safeStorage, native Keychain,
        // credentials, startup identity, BrowserWindow security or app.isPackaged.
        dialog.showMessageBox=async()=>{assertIsolated();return {response:1,checkboxChecked:false};};
      },{root,port:address.port,executablePath:executablePath??null,expectedAsar,undiciEntry});
      return page;
    };
    page=await launch();
    const identity=launches[0];
    await page.evaluate(async ({baseUrl,preference})=>{
      await window.deskpet.app.setLocale('en');
      await window.deskpet.chat.createSession({title:'Concurrent chat',kind:'normal'});
      const id=crypto.randomUUID();await window.deskpet.providers.upsert({id,name:'Usability fixture',kind:'ollama',baseUrl,model:'usability-fixture',enabled:true,supportsTools:true,localExecutionConfirmed:true,contextWindowTokens:32768,maxOutputTokens:1024});await window.deskpet.providers.select(id);
      await window.deskpet.memory.upsert({id:crypto.randomUUID(),operationId:crypto.randomUUID(),expectedRevision:0,text:preference,tags:['preference']});
      for(const capabilityId of ['skills.read','web.read','workspace.read','workspace.write'])await window.deskpet.permissions.request({capabilityId,duration:'session'});
    },{baseUrl:`http://127.0.0.1:${address.port}/v1`,preference});
    await page.reload();await expect(page.locator('.app-shell')).toBeVisible();
    const nav=page.locator('nav');
    await nav.getByRole('button',{name:'Tools',exact:true}).click();await page.getByRole('tab',{name:'Background tasks',exact:true}).click();
    const research=page.locator('.research-tasks');await research.getByLabel('Research goal',{exact:true}).fill('USABILITY_RESEARCH: compare the fixture evidence and save a report.');
    await research.getByRole('button',{name:'Start background research',exact:true}).click();
    await expect.poll(()=>Boolean(gatedWeb)).toBe(true);
    await page.screenshot({path:info.outputPath('research-running.png')});
    await nav.getByRole('button',{name:'Chat',exact:true}).click();
    await page.locator('.composer textarea').fill('NORMAL_CONCURRENT: say hello.');await page.getByRole('button',{name:'Send',exact:true}).click();
    await expect(page.locator('.message.assistant').filter({hasText:'CONCURRENT_CHAT_COMPLETE'})).toBeVisible();
    releaseWeb=true;gatedWeb!.writeHead(200,{'content-type':'text/html'}).end(`<html><body><p>${sourceLiteral}</p></body></html>`);
    let task:ResearchTask|undefined;
    await expect.poll(async()=>{task=(await page!.evaluate(()=>window.deskpet.research!.list()))[0];return task?.status;},{timeout:30000}).toBe('completed');
    expect(await readFile(join(profile,'workspace',task!.reportPath),'utf8')).toBe(expectedReport);
    expect(task!.sources[0]?.url).toBe(source);expect(task!.artifacts[0]?.sha256).toBe(hash(expectedReport));
    await nav.getByRole('button',{name:'Tools',exact:true}).click();await page.getByRole('tab',{name:'Artifacts',exact:true}).click();
    const card=page.locator('.artifact-card').filter({has:page.getByRole('button',{name:task!.reportPath,exact:true})});await card.getByRole('button',{name:task!.reportPath,exact:true}).click();
    await expect(page.locator('.artifact-detail')).toContainText(sourceLiteral);
    await card.getByRole('button',{name:'Export PDF',exact:true}).click();
    await expect(page.getByRole('status').filter({hasText:'PDF saved:'})).toBeVisible();
    const artifacts=await page.evaluate(()=>window.deskpet.chatWork.searchArtifacts({}));const pdf=artifacts.items.find(item=>item.path.endsWith('.pdf'))!;expect(pdf).toBeDefined();
    expect((await readFile(join(profile,'workspace',pdf.path))).subarray(0,5).toString()).toBe('%PDF-');
    await page.locator('.artifact-card').filter({hasText:pdf.path}).first().getByRole('button',{name:pdf.path,exact:true}).click();
    await expect(page.locator('.artifact-pdf canvas')).toBeVisible();
    await page.screenshot({path:info.outputPath('artifact-pdf.png')});
    await page.locator('.artifact-card').filter({has:page.getByRole('button',{name:pdf.path,exact:true})}).getByRole('button',{name:'Edit source',exact:true}).click();
    await expect(page.locator('.composer textarea')).toContainText(task!.reportPath);
    await expect(page.locator('.composer textarea')).toContainText(task!.artifacts[0]!.sha256);
    expect(await page.locator('.composer textarea').inputValue()).not.toContain(pdf.path);
    await page.locator('.composer textarea').fill('');
    await nav.getByRole('button',{name:'Tools',exact:true}).click();await page.getByRole('tab',{name:'Artifacts',exact:true}).click();
    await card.getByRole('button',{name:'Continue editing',exact:true}).click();
    await expect(page.locator('.composer textarea')).toContainText(task!.reportPath);
    await expect(page.locator('.composer textarea')).toContainText(task!.artifacts[0]!.sha256);
    // Send the staged draft through the actual composer/runtime. The model
    // fixture must read the saved version before writing an edited source file.
    const draft=await page.locator('.composer textarea').inputValue();
    await page.locator('.composer textarea').fill(draft+'\nUSABILITY_EDIT_ARTIFACT: add the requested synthetic edit section to this source.');
    await page.getByRole('button',{name:'Send',exact:true}).click();
    await expect(page.locator('.message.assistant').filter({hasText:'USABILITY_EDIT_COMPLETE'})).toBeVisible({timeout:30_000});
    const editedReport=expectedReport+editSection;
    expect(await readFile(join(profile,'workspace',task!.reportPath),'utf8')).toBe(editedReport);
    const editedTasks=await page.evaluate(id=>window.deskpet.chatWork.list(id),task!.sessionId!);
    const editedTask=editedTasks.find(item=>item.artifacts.some(artifact=>artifact.path===task!.reportPath&&artifact.sha256===hash(editedReport)));
    expect(editedTask).toMatchObject({sessionId:task!.sessionId,status:'completed'});
    const editedReceipt=editedTask!.artifacts.find(artifact=>artifact.path===task!.reportPath)!;
    expect(editedReceipt).toEqual({path:task!.reportPath,bytes:Buffer.byteLength(editedReport),sha256:hash(editedReport)});
    expect(editedTask!.id).not.toBe(artifacts.items.find(item=>item.path===task!.reportPath)!.taskId);
    expect(hash(await readFile(join(profile,'workspace',pdf.path)))).toBe(pdf.sha256);
    expect(editWires).toHaveLength(3);
    await page.screenshot({path:info.outputPath('artifact-source-edited.png')});
    await page.locator('.chat-work-panel > summary').click();
    const editedCard=page.locator(`.chat-work-task[data-task-id="${editedTask!.id}"]`);
    await editedCard.locator(':scope > summary').click();
    await editedCard.getByText('Save as my method',{exact:true}).click();
    await editedCard.getByLabel('Method name',{exact:true}).fill('Usability evidence method');await editedCard.getByLabel('Review and edit method',{exact:true}).fill(method);
    await editedCard.getByRole('button',{name:'Save local method',exact:true}).click();await expect(editedCard.getByRole('status').filter({hasText:'Method saved.'})).toBeVisible();
    await nav.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('tab',{name:'Skills',exact:true}).click();
    const skill=page.getByRole('region',{name:'Usability evidence method',exact:true});await skill.getByLabel('Enable skill').click();await expect(skill.getByLabel('Enable skill')).toBeChecked();await skill.getByRole('button',{name:'View skill',exact:true}).click();
    await page.getByRole('button',{name:'Review and approve public use',exact:true}).click();await expect(skill).toContainText('Approved for public research');
    await page.screenshot({path:info.outputPath('public-method.png')});
    await page.evaluate(async()=>{await window.deskpet.chat.createSession({title:'Public method check',kind:'normal'});});await page.reload();
    await nav.getByRole('button',{name:'Chat',exact:true}).click();
    await page.locator('.composer textarea').fill('PUBLIC_METHOD_TASK: use the approved public method and read the source.');await page.getByRole('button',{name:'Send',exact:true}).click();
    await expect(page.locator('.message.assistant').filter({hasText:'PUBLIC_METHOD_COMPLETE'})).toBeVisible({timeout:30000});
    await nav.getByRole('button',{name:'Memory',exact:true}).click();
    expect(await application!.evaluate(()=>(globalThis as unknown as EmbeddingFixtureGlobal).__usabilityEmbeddingCalls)).toEqual([]);
    const recall=page.getByRole('region',{name:'Find memories by meaning',exact:true});await recall.getByRole('textbox').fill('以后说重点，别绕弯子');await recall.getByRole('button',{name:'Search on this device',exact:true}).click();
    await expect(recall).toContainText(preference,{timeout:30000});
    await expect(recall).toContainText('Searched 1 memories by meaning on this device.');
    const memoryCalls=await application!.evaluate(()=>(globalThis as unknown as EmbeddingFixtureGlobal).__usabilityEmbeddingCalls);
    expect(memoryCalls.map(call=>`${call.method} ${call.path}`)).toEqual(['GET /api/ps','POST /api/show','POST /api/embed','GET /api/ps']);
    expect(embeddingHTTPCalls.map(({method,path})=>({method,path}))).toEqual(memoryCalls);
    expect(embeddingHTTPCalls.find(call=>call.path==='/api/embed')).toMatchObject({model:'nomic-embed-text',inputs:2,queries:1,documents:1});
    expect(await application!.evaluate(()=>(globalThis as unknown as EmbeddingFixtureGlobal).__usabilityEmbeddingDiagnostics)).toEqual([]);
    await page.screenshot({path:info.outputPath('memory-recall.png')});
    await recall.getByRole('button',{name:'Continue with this question',exact:true}).click();
    await expect(page.locator('.composer textarea')).toHaveValue('以后说重点，别绕弯子');
    expect(await page.locator('.composer textarea').inputValue()).not.toContain(preference);
    const resumed=await page.evaluate(async()=>{const provider=(await window.deskpet.providers.list())[0]!;return window.deskpet.research!.submit({operationId:crypto.randomUUID(),goal:'RESUME_RESEARCH: finish the selected report.',material:'Verified selected material.',providerId:provider.id,model:provider.model,allowRemote:false,maxMinutes:2,maxToolCalls:8});});
    await expect.poll(()=>Boolean(resumeGate),{timeout:15000}).toBe(true);
    await page.evaluate(id=>window.deskpet.research!.cancel(id),resumed.id);
    await expect.poll(async()=>(await page!.evaluate(id=>window.deskpet.research!.get(id),resumed.id)).status).toBe('cancelled');
    embeddingFixtureCalls.push({launch:1,calls:await application!.evaluate(()=>(globalThis as unknown as EmbeddingFixtureGlobal).__usabilityEmbeddingCalls)});
    expect(embeddingFixtureCalls[0]!.calls).toEqual(memoryCalls);
    await application!.close(); application=undefined;
    page=await launch();
    expect(await readFile(join(profile,'workspace',task!.reportPath),'utf8')).toBe(editedReport);
    expect((await page.evaluate(({sessionId,id})=>window.deskpet.chatWork.get(sessionId,id),{sessionId:task!.sessionId!,id:editedTask!.id}))?.artifacts).toContainEqual(editedReceipt);
    expect((await page.evaluate(id=>window.deskpet.research!.get(id),resumed.id)).status).toBe('cancelled');
    await page.evaluate(id=>window.deskpet.research!.resume({id,operationId:crypto.randomUUID()}),resumed.id);
    let continued:ResearchTask|undefined;
    await expect.poll(async()=>{continued=await page!.evaluate(id=>window.deskpet.research!.get(id),resumed.id);return continued.status;},{timeout:30000}).toBe('completed');
    expect(continued!.sessionId).toBe(resumed.id);expect(continued!.attempts).toHaveLength(2);
    expect(await readFile(join(profile,'workspace',continued!.reportPath),'utf8')).toBe(resumedReport);
    expect(await readFile(join(profile,'workspace',`research/${resumed.id}/attempts/${continued!.attempts[0]!.id}/report.md`),'utf8')).toBe(firstReport);
    const denied=await page.evaluate(async()=>{const provider=(await window.deskpet.providers.list())[0]!;return window.deskpet.research!.submit({operationId:crypto.randomUUID(),goal:'OUTSIDE_RESEARCH: attempt an unauthorized path.',material:'',providerId:provider.id,model:provider.model,allowRemote:false,maxMinutes:2,maxToolCalls:4});});
    await expect.poll(async()=>(await page!.evaluate(id=>window.deskpet.research!.get(id),denied.id)).status,{timeout:15000}).toBe('failed');
    await expect(readFile(join(profile,'workspace','outside-task.md'))).rejects.toThrow();
    const deniedResult=await page.evaluate(id=>window.deskpet.research!.get(id),denied.id);
    embeddingFixtureCalls.push({launch:2,calls:await application!.evaluate(()=>(globalThis as unknown as EmbeddingFixtureGlobal).__usabilityEmbeddingCalls)});
    expect(embeddingFixtureCalls[1]!.calls).toEqual([]);
    if(expectedAsar)expect(hash(await readFile(expectedAsar))).toBe(archiveSHA256);
    const evidence=JSON.stringify({identity,launches,packagedExecutable:executablePath??null,archiveSHA256,task,continued,denied:deniedResult,
      artifacts:artifacts.items,editedTask,editedReceipt,embeddingFixtureCalls,embeddingHTTPCalls,embeddingHTTPDiagnostics,editRequests:editWires.length,researchRequests:researchWires.length,fixtureErrors:errors},null,2);
    await writeFile(info.outputPath('evidence.json'),evidence);
    await info.attach('evidence',{body:evidence,contentType:'application/json'});
    expect(errors).toEqual([]);
  } finally {
    const embeddingRuntime=application?await application.evaluate(()=>{
      const state=globalThis as unknown as Partial<EmbeddingFixtureGlobal>;
      return {calls:state.__usabilityEmbeddingCalls??[],diagnostics:state.__usabilityEmbeddingDiagnostics??[]};
    }).catch(()=>({calls:[],diagnostics:[{phase:'diagnostics-read',category:'runtime-unavailable'}]})):null;
    const diagnostics=JSON.stringify({launches,embeddingFixtureCalls,embeddingRuntime,embeddingHTTPCalls,embeddingHTTPDiagnostics},null,2);
    await writeFile(info.outputPath('embedding-fixture-diagnostics.json'),diagnostics);
    await info.attach('embedding-fixture-diagnostics',{body:diagnostics,contentType:'application/json'});
    if(application)await application.close().catch(()=>undefined);
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    await rm(root,{recursive:true,force:true});
    await writeFile(info.outputPath('cleanup.json'),JSON.stringify({isolatedRoot:root,removed:await realpath(root).then(()=>false,()=>true)},null,2));
  }
});
