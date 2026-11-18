import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import type * as Crypto from 'node:crypto';
import type * as Fs from 'node:fs';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConsolidationCandidate } from '../../src/shared/consolidation';
import type { MemoryItem } from '../../src/shared';
import type { PersistentState } from '../../src/main/domain/schemas';

const archive = '/private/tmp/deskpet/output/deskpet-electron-ep4-summary-closeout-20261029/validation/e2e';
const prior = '/private/tmp/deskpet/output/deskpet-electron-ep4-20261029/fidelity/run-2026-10-29T08-00-29.157Z';
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
interface Wire { model: string; messages: Array<{ role: string; content: string }>; tools?: unknown[]; tool_choice?: string; max_tokens?: number; reasoning_effort?: string; temperature?: number }
interface WireRecord { body: Wire; bodySHA256: string; responseBody: string; authorizationPresent: boolean; fakeCredentialMatches: boolean }
const facts = (memories: MemoryItem[]) => memories.map((memory) => ({ id: memory.id, text: memory.text, tags: memory.tags, revision: memory.contextMetadata?.revision, sources: memory.contextMetadata?.sourceReferences, events: memory.contextMetadata?.sourceEventIds }));
const compact = [
  'Luma Orchard: blue north gate opens Thursdays at 09:00 local; closed on public holidays even Thursdays. Check seedling labels before watering. 1.5 litres per seedling per visit, not per day or whole orchard. No apple harvesting; this orchard only.',
  'Mara learning-review only: English default, one conclusion sentence, two reasons, one everyday example. Explain terms plainly before use. Excludes small talk, code-only requests and emergencies. Current explicit language/format takes priority; not Lin or everyone.',
  'Aster lab: Lin corrected deadline on 2026-04-30. Current 2026-05-14 16:30 UTC+08:00; old 2026-05-12 18:00 UTC+08:00 superseded. Amount 250 millilitres, not litres; this deadline correction did not change amount.',
  'Cedar Room: green door, exactly eight desks. Niko checks labels on Mondays. Sources do not provide founding date or ticket price; do not infer free admission. Separate from Orchard, Mara and Aster.',
];
for (const scenario of ['complete-fixture', 'original-truncated-sse'] as const) {
  // eslint-disable-next-line no-empty-pattern
  test(`bounded consolidation closeout: ${scenario}`, async ({}, info) => {
    test.setTimeout(100_000);
    const root = await mkdtemp(join(tmpdir(), 'deskpet-closeout-e2e-')); const profile = join(root, 'profile');
    const directory = join(archive, `${new Date().toISOString().replaceAll(':','-')}-${scenario}`); await mkdir(directory, { recursive: true });
    await copyFile(join(process.cwd(), 'tests/e2e/consolidation-closeout.spec.ts'), join(directory,'test-spec.ts'));
    const original = JSON.parse(await readFile(join(prior, 'summary-persisted.state.json'),'utf8')) as PersistentState;
    const oldGeneration = JSON.parse(await readFile(join(prior,'generation-01.json'),'utf8')) as { rawSSE: string; stream: { content: string } };
    const ids = original.memories.map((source) => source.id); const providerId = randomUUID(), fakeCredential = `FAKE_CLOSEOUT_${randomUUID()}`;
    const candidate: ConsolidationCandidate = { segments: compact.map((text,index) => ({text,sourceIds:[ids[index]!]})), coveredMemoryIds: ids, uncoveredMemoryIds: [], conflicts: [] };
    const requests: WireRecord[] = []; const metadata: unknown[] = [], launches: unknown[] = [], checkpoints: Array<{phase:string;state:PersistentState}> = [], processes: Array<{pid:number;type:string;name?:string|undefined}> = [];
    let application: ElectronApplication | undefined, page: Page | undefined, sessionId = '', batchId = '', verdict = 'RUNNING', failure: string | undefined;
    const entry = join(process.cwd(),'.webpack',process.arch,'main/index.js'); const mainBundleSHA256 = hash(await readFile(entry)); const utilityBundleSHA256 = hash(await readFile(join(process.cwd(),'.webpack',process.arch,'main/utility.js')));
    const server = createServer((request,response) => {
      const chunks: Buffer[] = []; request.on('data',(chunk:Buffer) => chunks.push(chunk)); request.on('end',() => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!request.url?.endsWith('/chat/completions')) { metadata.push({path:request.url}); response.writeHead(200,{'content-type':'application/json'}); response.end(JSON.stringify(request.url?.endsWith('/api/show') ? {model_info:{'general.architecture':'llama','llama.context_length':32768}} : {data:[{id:'closeout-fixture'}]})); return; }
        const body = JSON.parse(raw) as Wire; const job = body.tool_choice === 'none';
        const responseBody = job && scenario === 'original-truncated-sse' ? oldGeneration.rawSSE : `data: ${JSON.stringify({choices:[{delta:{content:job ? JSON.stringify(candidate) : 'CONTROLLED_CLOSEOUT_CHAT'},finish_reason:'stop'}],usage:{prompt_tokens:71,completion_tokens:29}})}\n\ndata: [DONE]\n\n`;
        requests.push({body,bodySHA256:hash(raw),responseBody,authorizationPresent:typeof request.headers.authorization === 'string',fakeCredentialMatches:request.headers.authorization === `Bearer ${fakeCredential}`});
        response.writeHead(200,{'content-type':'text/event-stream'}); response.end(responseBody);
      });
    });
    await new Promise<void>((resolve,reject) => {server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing own controlled receiver port');
    const launch = async () => {
      const env: Record<string,string> = {NODE_ENV:'test',DESKPET_E2E_USER_DATA:profile}; for (const key of ['PATH','HOME','TMPDIR','LANG','LC_ALL','DISPLAY']) if (process.env[key] !== undefined) env[key] = process.env[key]!;
      application = await electron.launch({args:[entry],cwd:process.cwd(),env}); await expect.poll(() => application!.windows().some((window) => window.url().includes('/main_window/'))).toBe(true);
      page = application.windows().find((window) => window.url().includes('/main_window/'))!; await expect(page.locator('.app-shell')).toBeVisible(); await page.evaluate(() => window.deskpet.app.setLocale('en'));
      const identity = (await page.evaluate(() => window.deskpet.app.getDiagnostics())).runtimeIdentity; expect(identity?.dataDirectory).toBe(profile); expect(identity?.mainBundleSHA256).toBe(mainBundleSHA256); expect(identity?.utilityBundleSHA256).toBe(utilityBundleSHA256);
      const security = await application.evaluate(({app,BrowserWindow}) => ({pid:process.pid,noSandbox:app.commandLine.hasSwitch('no-sandbox'),windows:BrowserWindow.getAllWindows().map((window) => {
        const prefs = (window.webContents as typeof window.webContents & {getLastWebPreferences():Electron.WebPreferences}).getLastWebPreferences(); return {sandbox:prefs.sandbox,contextIsolation:prefs.contextIsolation,nodeIntegration:prefs.nodeIntegration,webSecurity:prefs.webSecurity};
      })})); expect(security.noSandbox).toBe(false); for (const prefs of security.windows) expect(prefs).toEqual({sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true}); launches.push({identity,security});
    };
    const state = async (phase: string): Promise<PersistentState> => {
      const value = await application!.evaluate(({app,safeStorage},expected) => {
        if (app.isPackaged || app.getPath('userData') !== expected) throw new Error('Own synthetic profile only'); const runtime = process as typeof process & {mainModule:{require(id:string):unknown}};
        const fs = runtime.mainModule.require('node:fs') as typeof Fs, crypto = runtime.mainModule.require('node:crypto') as typeof Crypto; const envelope = JSON.parse(fs.readFileSync(`${expected}/profile.enc.json`,'utf8')) as {nonce:string;authenticationTag:string;ciphertext:string};
        const key = Buffer.from(safeStorage.decryptString(fs.readFileSync(`${expected}/vault/vault-key.safe`)),'base64'); try {const d = crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.nonce,'base64'));d.setAuthTag(Buffer.from(envelope.authenticationTag,'base64'));return JSON.parse(Buffer.concat([d.update(Buffer.from(envelope.ciphertext,'base64')),d.final()]).toString('utf8')) as PersistentState;}finally{key.fill(0);}
      },profile); checkpoints.push({phase,state:value}); await copyFile(join(profile,'profile.enc.json'),join(directory,`${phase}.enc.json`)); await writeFile(join(directory,`${phase}.state.json`),JSON.stringify(value,null,2)); return value;
    };
    const close = async () => {if (!application) return; processes.push(...await application.evaluate(({app}) => app.getAppMetrics().map((item) => ({pid:item.pid,type:item.type,name:item.name})))); await application.close();application=undefined;page=undefined;};
    const freshChat = async () => {const id = await page!.evaluate(async () => (await window.deskpet.chat.createSession({title:'Independent closeout fixture recall',kind:'normal'})).id); await page!.evaluate((input) => window.deskpet.chat.send(input),{sessionId:id,content:'What are the saved Aster, Cedar, Luma and Mara facts?',providerId,model:'closeout-fixture'}); await expect.poll(async () => (await page!.evaluate((id) => window.deskpet.chat.listMessages(id),id)).at(-1)?.status).toBe('complete'); return requests.at(-1)!;};
    try {
      await launch(); await page!.evaluate(async (config) => {await window.deskpet.providers.upsert({id:config.providerId,kind:'ollama',name:'Synthetic closeout local provider',baseUrl:config.endpoint,model:'closeout-fixture',enabled:true,supportsTools:false,localExecutionConfirmed:true,contextWindowTokens:16384,maxOutputTokens:1536,apiKey:config.fakeCredential});await window.deskpet.providers.select(config.providerId);for (const source of config.sources) await window.deskpet.memory.upsert({id:source.id,text:source.text,tags:source.tags,privacy:'local-only',scope:{kind:'global'},operationId:crypto.randomUUID(),expectedRevision:0});},{providerId,endpoint:`http://127.0.0.1:${address.port}/v1`,fakeCredential,sources:original.memories});
      await page!.locator('nav').getByRole('button',{name:'Memory',exact:true}).click(); await page!.getByRole('tab',{name:'Manual consolidation',exact:true}).click(); await page!.getByRole('button',{name:'Start consolidation review',exact:true}).click();
      await expect.poll(async () => (await page!.evaluate(() => window.deskpet.chat.listSessions())).length).toBe(1); sessionId = (await page!.evaluate(() => window.deskpet.chat.listSessions()))[0]!.id;
      const before = await state('before-generation'); const initialFacts = facts(before.memories);
      const region = page!.getByRole('region',{name:'Manual memory consolidation',exact:true}); for (const id of ids) await region.getByRole('checkbox',{name:`Select source ${id}`,exact:true}).check();
      await region.getByLabel('Consolidation provider',{exact:true}).selectOption(providerId); await region.getByLabel('Consolidation model',{exact:true}).fill('closeout-fixture'); await region.getByRole('button',{name:'Review selected sources',exact:true}).click();
      const preview = region.getByRole('region',{name:'Consolidation material and binding',exact:true}); await expect(preview).toContainText(original.memories[0]!.text); expect(requests).toHaveLength(0);
      const draft = (await page!.evaluate((id) => window.deskpet.consolidation.list(id),sessionId))[0]!; batchId=draft.id; expect(draft.binding.limits.reasoningEffort).toBe('none'); expect(draft.budget.maxOutputTokens).toBe(1536); expect(draft.binding.limits.contextBudget.contextWindowTokens).toBe(16384); expect(draft.sources.map((source) => source.id)).toEqual(ids);
      await page!.screenshot({path:join(directory,'actual-preview.png'),fullPage:true}); await region.getByRole('button',{name:'Generate candidate once',exact:true}).click();
      await expect.poll(async () => (await page!.evaluate((id) => window.deskpet.consolidation.get(id),batchId)).status).not.toBe('generating');
      const current = await page!.evaluate((id) => window.deskpet.consolidation.get(id),batchId); expect(requests).toHaveLength(1); const jobRequest=requests[0]!;
      expect(jobRequest.body.reasoning_effort).toBe('none'); expect(jobRequest.body.max_tokens).toBe(1536); expect(jobRequest.body.temperature).toBe(0.2); expect(jobRequest.body.tools).toBeUndefined(); expect(jobRequest.fakeCredentialMatches).toBe(true); expect(JSON.stringify(jobRequest.body)).not.toContain(fakeCredential);
      const generated = await state('generated'); const stored = generated.backgroundJobs.find((job) => job.id === current.jobId)!; expect(stored.request?.bodySHA256).toBe(jobRequest.bodySHA256); expect(stored.request?.inputEstimate).toBe(draft.budget.inputEstimate); expect(stored.binding.limits.reasoningEffort).toBe('none'); expect(facts(generated.memories)).toEqual(initialFacts);
      if (scenario === 'original-truncated-sse') {
        expect(current.status).toBe('failed'); expect(current.completionReason).toBe('provider.truncated'); expect(current.candidate).toBeNull(); expect(current.active).toBe(false); expect(current.rawResponse).toBeNull();
        expect(stored.request?.observations.at(-1)?.finishReason).toBe('length'); expect(stored.request?.observations.at(-1)?.usage).toMatchObject({inputTokens:1016,outputTokens:1536,source:'provider-reported'});
        await expect(region.getByRole('button',{name:'Confirm reviewed version',exact:true})).toHaveCount(0); await close(); await launch(); const restored=await page!.evaluate((id) => window.deskpet.consolidation.get(id),batchId); expect(restored.status).toBe('failed'); expect(restored.candidate).toBeNull(); expect(requests).toHaveLength(1);
        const raw=await freshChat();for(const source of original.memories) expect(JSON.stringify(raw.body)).toContain(source.text); expect((await state('new-process-failed-no-regeneration')).backgroundJobs).toHaveLength(1);
      } else {
        expect(current.status).toBe('review'); expect(current.candidate).toEqual(candidate); expect(current.active).toBe(false);
        const review=region.getByRole('region',{name:'Consolidation candidate review',exact:true});await expect(review).toBeVisible();await review.getByRole('checkbox',{name:'I compared this version with every source, including conditions and conflicts',exact:true}).check();await review.getByRole('checkbox',{name:'Use this summary for eligible requests',exact:true}).check();
        const confirm=review.getByRole('button',{name:'Confirm reviewed version',exact:true});await confirm.scrollIntoViewIfNeeded();expect(await confirm.evaluate((node)=>{const rect=node.getBoundingClientRect(),hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);return hit===node||(hit!==null&&node.contains(hit));})).toBe(true);await confirm.click();
        await expect.poll(async () => (await page!.evaluate((id) => window.deskpet.consolidation.get(id),batchId)).active).toBe(true); const summary=await freshChat();expect(JSON.stringify(summary.body)).toContain('Reviewed derived memory representation');for(const source of original.memories)expect(JSON.stringify(summary.body)).not.toContain(source.text);
        const applied=await state('applied-real-http-fixture');expect(facts(applied.memories)).toEqual(initialFacts);
        await page!.locator(`[data-session-id="${sessionId}"] .session-item`).click();await page!.locator('nav').getByRole('button',{name:'Memory',exact:true}).click();await page!.getByRole('tab',{name:'Manual consolidation',exact:true}).click();await region.locator(`[data-consolidation-id="${batchId}"]`).getByRole('button',{name:'Review batch',exact:true}).click();await region.getByRole('button',{name:'Disable summary',exact:true}).click();await expect.poll(async () => (await page!.evaluate((id) => window.deskpet.consolidation.get(id),batchId)).active).toBe(false);const raw=await freshChat();for(const source of original.memories)expect(JSON.stringify(raw.body)).toContain(source.text);expect(facts((await state('disabled-current-originals')).memories)).toEqual(initialFacts);expect(requests.filter((record)=>record.body.tool_choice==='none')).toHaveLength(1);
      }
      await page!.screenshot({path:join(directory,'final.png'),fullPage:true});verdict='PASS';
    } catch(error) {failure=error instanceof Error?error.stack??error.message:String(error);verdict='FAIL';try{await page?.screenshot({path:join(directory,'failure.png'),fullPage:true});}catch{/* Already closed process. */}throw error;}
    finally {
      if(application){try{await close();}catch{const pid=application.process().pid;if(pid){try{process.kill(pid,'SIGTERM');}catch{/* Already exited. */}}}}
      server.closeAllConnections();await new Promise<void>((resolve)=>server.close(()=>resolve()));const pidClosure=processes.map(({pid})=>{let alive=false;try{process.kill(pid,0);alive=true;}catch{/* Expected closed. */}return{pid,alive};});
      await writeFile(join(directory,'evidence.json'),JSON.stringify({verdict,failure,scenario,profile,directory,entry,mainBundleSHA256,utilityBundleSHA256,launches,configuration:{normalRendererSecurity:true,controlledHTTP:true,actualProviderUtility:true,realModelCalls:0,fixtureUsageOnly:true,originalSourceBodiesUnchanged:true},sessionId,batchId,sourceIds:ids,candidate,requests,metadata,checkpoints,processes,closure:{recordingServerClosed:!server.listening,pidClosure,profileRetained:true}},null,2));await info.attach('closeout-evidence',{path:join(directory,'evidence.json'),contentType:'application/json'});
    }
  });
}
