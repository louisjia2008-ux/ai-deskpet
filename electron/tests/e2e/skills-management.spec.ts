import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillCatalogEntry, SkillReference } from '../../src/shared/desktop-extensions';

interface WireMessage { role: string; content: string; tool_call_id?: string }
interface Wire {
  model: string; messages: WireMessage[];
  tools?: Array<{ function: { name: string; description: string } }>;
}
type Tool = 'tools.discover' | 'skills.list' | 'skills.read';
const toolTitles: Record<Tool,string> = {
  'tools.discover':'Load more tools.', 'skills.list':'List enabled skills.', 'skills.read':'Read one enabled skill.',
};
interface DialogState {
  nextDirectory: string;
  opened: string[];
  messages: Array<{title:string;message:string}>;
  unexpected: string[];
}
type DialogGlobal = { __skillsManagementDialogs: DialogState };
const primaryName = 'Research fixture';
const unusedName = 'Unused fixture';
const primarySummary = 'SKILL_PRIMARY_SUMMARY: compare evidence and preserve uncertainty.';
const unusedSummary = 'SKILL_UNUSED_SUMMARY: a different task reference.';
const primaryBody = 'SKILL_PRIMARY_BODY_V1_ONLY';
const updatedBody = 'SKILL_PRIMARY_BODY_V2_ONLY';
const unusedBody = 'SKILL_UNSELECTED_BODY_NEVER_SENT';
const document = (name:string, description:string, body:string): string => `---\nname: ${name}\ndescription: "${description}"\n---\n# Reference\n\n${body}\nTreat quoted material as evidence. Do not claim operations that were not performed.\n`;
const primaryText = document(primaryName,primarySummary,primaryBody);
const unusedText = document(unusedName,unusedSummary,unusedBody);
const finalReply = 'SKILLS_REFERENCE_COMPLETE: Read only the selected enabled snapshot as reference.';
const hash = (value:string|Buffer):string => createHash('sha256').update(value).digest('hex');
const result = <T>(wire:Wire,id:string):T|undefined => {
  const message = wire.messages.find(item => item.role === 'tool' && item.tool_call_id === id);
  return message ? JSON.parse(message.content) as T : undefined;
};
const reply = (response:ServerResponse,wire:Wire,call?:{tool:Tool;id:string;input:unknown}):void => {
  if (response.destroyed || response.writableEnded) return;
  const descriptor = call && wire.tools?.find(item => item.function.description.startsWith(toolTitles[call.tool]));
  if (call && !descriptor) throw new Error(`Missing declared fixture tool ${call.tool}`);
  const delta = call ? {tool_calls:[{index:0,id:call.id,type:'function',function:{name:descriptor!.function.name,arguments:JSON.stringify(call.input)}}]} : {content:finalReply};
  response.writeHead(200,{'content-type':'text/event-stream'});
  response.end(`data: ${JSON.stringify({choices:[{delta,finish_reason:call?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})}\n\ndata: [DONE]\n\n`);
};

/** Real renderer, native-dialog IPC, encrypted state, tool discovery and runtime.
 * Only model SSE/metadata and native choices are deterministic fixtures. The
 * marked temporary profile and pre-bootstrap dialog stubs never use the daily
 * app profile, an actual GGUF, a real provider credential or external network. */
for (const revokeInFlight of [false,true]) {
const title = revokeInFlight
  ? 'disabling a skill while its reference-based response is in flight prevents a successful final delivery'
  : 'desktop manages local skill snapshots and reads only the chosen enabled skill through real research tools';
// eslint-disable-next-line no-empty-pattern
test(title, async ({}, info) => {
  test.setTimeout(120_000);
  const root = await realpath(await mkdtemp(join(tmpdir(),'deskpet-skills-management-'))), profile = join(root,'profile');
  const primaryFolder = join(root,'synthetic-primary-source'), unusedFolder = join(root,'synthetic-unused-source');
  await mkdir(primaryFolder); await mkdir(unusedFolder);
  await writeFile(join(root,'isolated-candidate.json'),JSON.stringify({version:1,purpose:'deskpet-isolated-candidate'}));
  await writeFile(join(primaryFolder,'SKILL.md'),primaryText); await writeFile(join(unusedFolder,'SKILL.md'),unusedText);
  const requests:Wire[] = [], modelWires:string[] = [], metadataPaths:string[] = [], fixtureErrors:string[] = [];
  let selectedEntry:SkillCatalogEntry|undefined, app:ElectronApplication|undefined, page:Page|undefined;
  let failure:string|null = null, identity:unknown = null, installedBefore:unknown = null, installedAfter:unknown = null, terminalSnapshot:unknown = null;
  const responseGate: {pending:{response:ServerResponse;wire:Wire}|null;releaseAttempted:boolean;socketClosedBeforeRelease:boolean} = {
    pending:null,releaseAttempted:false,socketClosedBeforeRelease:false,
  };
  const server = createServer((request,response) => {
    const chunks:Buffer[] = []; request.on('data',(chunk:Buffer) => chunks.push(chunk));
    request.on('end',() => {
      try {
        if (request.url === '/api/show') {
          metadataPaths.push(request.url);
          response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({details:{format:'gguf'},model_info:{'general.architecture':'qwen','qwen.context_length':32768}})); return;
        }
        if (request.url === '/v1/models') {
          metadataPaths.push(request.url);
          response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({data:[{id:'skills-management-fixture'}]})); return;
        }
        if (request.url !== '/v1/chat/completions') throw new Error(`Unexpected fixture route ${request.url}`);
        const raw = Buffer.concat(chunks).toString('utf8'), wire = JSON.parse(raw) as Wire;
        modelWires.push(raw); requests.push(wire);
        expect(wire.model).toBe('skills-management-fixture');
        expect(raw).not.toContain('sourceDirectory');
        for (const privatePath of [root,primaryFolder,unusedFolder]) expect(raw).not.toContain(privatePath);
        expect(raw).not.toContain(unusedBody); expect(raw).not.toContain(updatedBody);
        expect(wire.messages.filter(item => item.role === 'user').at(-1)?.content).toContain('SKILLS_MANAGEMENT_E2E:');
        const discovered = result<{loaded:string}>(wire,'skills-discover');
        if (!discovered) {
          expect(raw).not.toContain(primarySummary); expect(raw).not.toContain(unusedSummary); expect(raw).not.toContain(primaryBody);
          expect(wire.tools?.some(item => item.function.description.startsWith(toolTitles['skills.list']))).toBe(false);
          expect(wire.tools?.some(item => item.function.description.startsWith(toolTitles['skills.read']))).toBe(false);
          reply(response,wire,{tool:'tools.discover',id:'skills-discover',input:{group:'skills'}}); return;
        }
        expect(discovered).toMatchObject({loaded:'skills'});
        const catalog = result<{skills:SkillCatalogEntry[];privacy:string}>(wire,'skills-list');
        if (!catalog) {
          expect(raw).not.toContain(primarySummary); expect(raw).not.toContain(unusedSummary); expect(raw).not.toContain(primaryBody);
          reply(response,wire,{tool:'skills.list',id:'skills-list',input:{scope:'local'}}); return;
        }
        expect(catalog.privacy).toBe('local-only');
        expect(catalog.skills.map(item => item.name).sort()).toEqual([primaryName,unusedName].sort());
        for (const entry of catalog.skills) expect(Object.keys(entry).sort()).toEqual(['description','digest','id','name','revision']);
        selectedEntry = catalog.skills.find(item => item.name === primaryName)!;
        expect(selectedEntry).toMatchObject({description:primarySummary,digest:hash(primaryText)});
        // The list itself is local material, so the very next request must no
        // longer declare a search or page-reading tool.
        expect(wire.tools?.some(item => /^(?:Search web\.|Read HTTPS page\.)/u.test(item.function.description))).toBe(false);
        const read = result<SkillReference & {privacy:string;trust:string}>(wire,'skills-read');
        if (!read) {
          expect(raw).not.toContain(primaryBody);
          reply(response,wire,{tool:'skills.read',id:'skills-read',input:{id:selectedEntry.id}}); return;
        }
        expect(read).toMatchObject({...selectedEntry,text:primaryText,privacy:'local-only',trust:'reference-only'});
        expect(wire.messages.filter(item => item.content.includes(primaryBody))).toHaveLength(1);
        expect(wire.messages.find(item => item.content.includes(primaryBody))?.role).toBe('tool');
        if (revokeInFlight) {
          expect(responseGate.pending).toBeNull();
          responseGate.pending = {response,wire}; return;
        }
        reply(response,wire);
      } catch (error) {
        fixtureErrors.push(error instanceof Error ? error.stack ?? error.message : String(error));
        if (!response.headersSent) response.writeHead(500,{'content-type':'application/json'});
        response.end(JSON.stringify({error:'Synthetic skills-management fixture assertion failed'}));
      }
    });
  });
  try {
    await new Promise<void>((resolve,reject) => {server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing loopback fixture port');
    const compiled = join(process.cwd(),'.webpack',process.arch,'main/index.js'), mainSHA256 = hash(await readFile(compiled));
    const bootstrap = join(root,'skills-management-bootstrap.cjs');
    await writeFile(bootstrap, `
'use strict';
if (process.env.NODE_ENV !== 'test' || !process.argv.includes(${JSON.stringify('--deskpet-isolated-profile='+root)})) throw new Error('Refusing non-isolated skills fixture');
const { dialog } = require('electron');
const state = globalThis.__skillsManagementDialogs = { nextDirectory:${JSON.stringify(primaryFolder)}, opened:[], messages:[], unexpected:[] };
dialog.showOpenDialog = async (...args) => {
  const options = args.at(-1) || {};
  if (options.title !== 'Choose a folder containing SKILL.md' || !options.properties?.includes('openDirectory')) {
    state.unexpected.push('open:' + String(options.title)); return {canceled:true,filePaths:[]};
  }
  state.opened.push(state.nextDirectory); return {canceled:false,filePaths:[state.nextDirectory]};
};
dialog.showOpenDialogSync = () => { state.unexpected.push('open-sync'); return undefined; };
dialog.showSaveDialog = async () => { state.unexpected.push('save'); return {canceled:true,filePath:''}; };
dialog.showSaveDialogSync = () => { state.unexpected.push('save-sync'); return undefined; };
dialog.showMessageBox = async (...args) => {
  const options = args.at(-1) || {};
  state.messages.push({title:options.title || '',message:options.message || ''});
  if (options.title === 'Read enabled local skills' && options.message === 'Allow this tool capability for DeskPet?') return {response:1,checkboxChecked:false};
  state.unexpected.push('message:' + String(options.title)); return {response:options.cancelId ?? 0,checkboxChecked:false};
};
dialog.showMessageBoxSync = (...args) => { state.unexpected.push('message-sync'); return args.at(-1)?.cancelId ?? 0; };
dialog.showErrorBox = (title) => { state.unexpected.push('error:' + String(title)); };
require(${JSON.stringify(compiled)});
`);
    const env:Record<string,string> = {NODE_ENV:'test'};
    for (const key of ['PATH','HOME','TMPDIR','LANG','LC_ALL','DISPLAY']) if (process.env[key] !== undefined) env[key] = process.env[key]!;
    app = await electron.launch({args:[bootstrap,'--deskpet-isolated-profile='+root],cwd:process.cwd(),env});
    await expect.poll(() => app!.windows().some(item => item.url().includes('/main_window/'))).toBe(true);
    page = app.windows().find(item => item.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    await app.evaluate(({app},expected) => {
      if (app.isPackaged || app.getPath('userData') !== expected) throw new Error('Refusing non-fixture application');
    },profile);
    const diagnostics = await page.evaluate(() => window.deskpet.app.getDiagnostics()); identity = diagnostics.runtimeIdentity;
    expect(diagnostics.runtimeIdentity).toMatchObject({dataDirectory:profile,isPackaged:false,mainBundleSHA256:mainSHA256});
    await page.evaluate(async config => {
      await window.deskpet.app.setLocale('en');
      await window.deskpet.providers.upsert(config); await window.deskpet.providers.select(config.id);
    },{id:randomUUID(),name:'Local skill fixture',kind:'ollama' as const,model:'skills-management-fixture',baseUrl:`http://127.0.0.1:${address.port}/v1`,
      enabled:true,supportsTools:true,localExecutionConfirmed:true,contextWindowTokens:32768,maxOutputTokens:512});
    await page.reload(); await expect(page.locator('.app-shell')).toBeVisible();
    const openSkills = async () => {
      await page!.locator('nav').getByRole('button',{name:'Settings',exact:true}).click();
      await page!.getByRole('tab',{name:'Skills',exact:true}).click();
      return page!.getByRole('group',{name:'Skills',exact:true});
    };
    let panel = await openSkills();
    await panel.getByRole('button',{name:'Install skill from folder'}).click();
    let primaryCard = panel.getByRole('region',{name:primaryName,exact:true});
    await expect(primaryCard.getByLabel('Enable skill')).not.toBeChecked();
    await primaryCard.getByRole('button',{name:'View skill'}).click();
    await expect(panel.locator('pre').filter({hasText:primaryBody})).toBeVisible();
    await expect(panel.getByRole('button',{name:'Run with this skill'})).toBeDisabled();
    await primaryCard.getByLabel('Enable skill').click(); await expect(primaryCard.getByLabel('Enable skill')).toBeChecked();
    await primaryCard.getByText('Source and revision',{exact:true}).click();
    await expect(primaryCard.getByText(primaryFolder,{exact:true})).toBeVisible();
    await expect(primaryCard.getByText(hash(primaryText),{exact:true})).toBeVisible();
    await app.evaluate((_electron,folder) => {(globalThis as unknown as DialogGlobal).__skillsManagementDialogs.nextDirectory = folder;},unusedFolder);
    await panel.getByRole('button',{name:'Install skill from folder'}).click();
    const unusedCard = panel.getByRole('region',{name:unusedName,exact:true});
    await unusedCard.getByLabel('Enable skill').click(); await expect(unusedCard.getByLabel('Enable skill')).toBeChecked();
    installedBefore = await page.evaluate(() => window.deskpet.plugins.extensions.state());
    expect(modelWires).toEqual([]);
    // Exercise the real permission IPC with a narrow, completely stubbed native
    // choice. No broad always grant or automatic tool approval is installed.
    const grant = await page.evaluate(() => window.deskpet.permissions.request({capabilityId:'skills.read',duration:'session'}));
    expect(grant?.state).toBe('session');
    await page.locator('nav').getByRole('button',{name:'Chat',exact:true}).click();
    await page.locator('.composer textarea').fill('SKILLS_MANAGEMENT_E2E: Discover the skills tools, list the enabled references, read Research fixture only, and explain what reference you used.');
    await page.getByRole('button',{name:'Send',exact:true}).click();
    const assistant = page.locator('.message.assistant').last();
    if (revokeInFlight) {
      await expect.poll(() => responseGate.pending !== null,{timeout:35_000}).toBe(true);
      await expect(assistant).toHaveAttribute('data-status','streaming');
      await expect(assistant).not.toContainText(finalReply);
    } else {
      await expect(assistant).toHaveAttribute('data-status','complete',{timeout:35_000});
      await expect(assistant).toContainText(finalReply);
    }
    expect(fixtureErrors).toEqual([]); expect(requests).toHaveLength(4);
    expect(modelWires.slice(0,3).every(raw => !raw.includes(primaryBody))).toBe(true);
    expect(modelWires[3]).toContain(primaryBody);
    expect(modelWires.every(raw => !raw.includes(unusedBody) && !raw.includes('sourceDirectory') && !raw.includes(root))).toBe(true);
    expect(metadataPaths).toContain('/api/show');
    const sessionId = await page.locator('.session-control select').inputValue();
    if (revokeInFlight) {
      // The read has completed and the old text is already present in the next
      // model request. Revoke through the real management UI before that held
      // request returns even its first content token.
      panel = await openSkills(); primaryCard = panel.getByRole('region',{name:primaryName,exact:true});
      await expect(primaryCard.getByLabel('Enable skill')).toBeChecked();
      await primaryCard.getByLabel('Enable skill').click();
      await expect(primaryCard.getByLabel('Enable skill')).not.toBeChecked();
      const disabledState = await page.evaluate(() => window.deskpet.plugins.extensions.state()); installedAfter = disabledState;
      expect(disabledState.skills.find(item => item.id === selectedEntry!.id)).toMatchObject({
        enabled:false,digest:selectedEntry!.digest,revision:selectedEntry!.revision + 1,
      });
      const held = responseGate.pending; if (!held) throw new Error('The controlled final response was not held');
      responseGate.releaseAttempted = true; responseGate.socketClosedBeforeRelease = held.response.destroyed;
      // Cancellation may already have closed the socket. Otherwise release a
      // valid synthetic success response and require the host to reject it.
      reply(held.response,held.wire);
      await expect.poll(() => page!.evaluate(id => window.deskpet.chat.getInteraction(id),sessionId),{timeout:20_000}).toBeNull();
      const persisted = await page.evaluate(async id => ({messages:await window.deskpet.chat.listMessages(id),work:await window.deskpet.chatWork.list(id)}),sessionId);
      terminalSnapshot = persisted;
      const savedReply = persisted.messages.filter(item => item.role === 'assistant').at(-1)!;
      expect(['failed','cancelled']).toContain(savedReply.status);
      expect(savedReply.content).not.toContain(finalReply); expect(savedReply.content).not.toContain(primaryBody);
      expect(savedReply.requestReceipts).toHaveLength(4);
      const stoppedWork = persisted.work.find(item => item.assistantMessageId === savedReply.id);
      expect(stoppedWork).toBeDefined(); expect(['failed','cancelled','interrupted']).toContain(stoppedWork!.status);
      expect(stoppedWork!.summary).not.toContain(finalReply);
      expect(requests).toHaveLength(4); expect(fixtureErrors).toEqual([]);
      await page.locator('nav').getByRole('button',{name:'Chat',exact:true}).click();
      await expect(page.locator('.message.assistant').last()).toHaveAttribute('data-status',/^(?:failed|cancelled)$/u);
      await expect(page.locator('.message.assistant').last()).not.toContainText(finalReply);
      await page.screenshot({path:info.outputPath('skills-revoked-in-flight.png')});
    } else {
    await expect.poll(() => page!.evaluate(id => window.deskpet.chat.getInteraction(id),sessionId)).toBeNull();
    const persisted = await page.evaluate(async id => ({messages:await window.deskpet.chat.listMessages(id),work:await window.deskpet.chatWork.list(id)}),sessionId);
    terminalSnapshot = persisted;
    const savedReply = persisted.messages.find(item => item.role === 'assistant' && item.content.includes(finalReply))!;
    expect(savedReply).toMatchObject({status:'complete',contextTrace:{privacy:'local-only'}});
    expect(savedReply.requestReceipts).toHaveLength(4);
    expect(persisted.work.find(item => item.assistantMessageId === savedReply.id)).toMatchObject({status:'completed',privacy:'local-only'});
    await page.screenshot({path:info.outputPath('skills-research-complete.png')});

    panel = await openSkills(); primaryCard = panel.getByRole('region',{name:primaryName,exact:true});
    await primaryCard.getByRole('button',{name:'View skill'}).click();
    await expect(panel.locator('pre').filter({hasText:primaryBody})).toBeVisible();
    const changedText = document(primaryName,'Updated primary reference.',updatedBody);
    await writeFile(join(primaryFolder,'SKILL.md'),changedText);
    await primaryCard.getByRole('button',{name:'Update from source folder'}).click();
    await expect(panel.getByRole('status')).toHaveText('Skill content updated and disabled. Review it again before enabling it.');
    await expect(primaryCard.getByLabel('Enable skill')).not.toBeChecked();
    await expect(panel.locator('pre').filter({hasText:primaryBody})).toHaveCount(0);
    await expect(panel.locator('pre').filter({hasText:updatedBody})).toHaveCount(0);
    const updatedState = await page.evaluate(() => window.deskpet.plugins.extensions.state()); installedAfter = updatedState;
    const updated = updatedState.skills.find(item => item.name === primaryName)!;
    expect(updated).toMatchObject({id:selectedEntry!.id,enabled:false,revision:selectedEntry!.revision + 1,digest:hash(changedText),sourceDirectory:primaryFolder});
    expect(updatedState.skills.find(item => item.name === unusedName)?.enabled).toBe(true);
    // Updating never calls a model or silently loads the changed body.
    expect(modelWires).toHaveLength(4);
    await primaryCard.getByRole('button',{name:'View skill'}).click();
    await expect(panel.locator('pre').filter({hasText:updatedBody})).toBeVisible();
    await expect(panel.locator('pre').filter({hasText:primaryBody})).toHaveCount(0);
    await panel.getByLabel('Task',{exact:true}).fill('Use the updated reference.');
    await expect(panel.getByRole('button',{name:'Run with this skill'})).toBeDisabled();
    await page.screenshot({path:info.outputPath('skills-updated-disabled.png')});
    }
    const dialogs = await app.evaluate(() => (globalThis as unknown as DialogGlobal).__skillsManagementDialogs);
    expect(dialogs.opened).toEqual([primaryFolder,unusedFolder]);
    expect(dialogs.messages).toEqual([{title:'Read enabled local skills',message:'Allow this tool capability for DeskPet?'}]);
    expect(dialogs.unexpected).toEqual([]);
  } catch (error) {
    failure = error instanceof Error ? error.stack ?? error.message : String(error); throw error;
  } finally {
    let finalState:unknown = null, dialogs:unknown = null;
    if (page && !page.isClosed()) {
      finalState = await page.evaluate(async () => ({extensions:await window.deskpet.plugins.extensions.state(),permissions:await window.deskpet.permissions.list(),events:await window.deskpet.tasks.listRunEvents()})).catch(() => null);
      if (failure) await page.screenshot({path:info.outputPath('skills-failure.png')}).catch(() => undefined);
    }
    if (app) dialogs = await app.evaluate(() => (globalThis as unknown as DialogGlobal).__skillsManagementDialogs).catch(() => null);
    await writeFile(info.outputPath('skills-management-evidence.json'),JSON.stringify({
      scope:'Isolated development Electron, real UI/IPC/runtime/persistence; synthetic loopback model and GGUF metadata; stubbed native dialogs. Not real model or installed-app acceptance.',
      revokeInFlight,releaseAttempted:responseGate.releaseAttempted,socketClosedBeforeRelease:responseGate.socketClosedBeforeRelease,
      identity,failure,fixtureErrors,metadataPaths,requests,selectedEntry,installedBefore,installedAfter,dialogs,terminalSnapshot,finalState,
    },null,2));
    await app?.close().catch(() => undefined); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); await rm(root,{recursive:true,force:true});
  }
});
}
