import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServerView } from '../../src/shared/desktop-extensions';

interface ApprovedCall { tool: string; arguments: Record<string,unknown>; endpoint: string }
interface ManagedDialogs { next: ApprovedCall | null; denyNext: boolean; prompts: Array<{message:string;detail:string;allowed:boolean}>; unexpected:string[] }
type ManagedGlobal = { __managedPlaywrightDialogs: ManagedDialogs };
const capability = /\/mcp\/[a-f0-9]{64}/u;

// Actual AppController, private bridge vault, native approvals and Playwright's
// headless shell. Only
// the one-call approval choice is scripted, and only for this local fixture.
// eslint-disable-next-line no-empty-pattern
test('managed Playwright uses reviewed UI calls across sessions and stops its isolated browser when disabled', async ({}, info) => {
  test.skip(process.platform !== 'darwin','This actual-browser fixture runs on macOS.');
  test.setTimeout(110_000);
  const root = await realpath(await mkdtemp(join(tmpdir(),'deskpet-managed-playwright-')));
  const project = process.cwd(), profile = join(root,'profile');
  await writeFile(join(root,'isolated-candidate.json'),JSON.stringify({version:1,purpose:'deskpet-isolated-candidate'}));
  const compiled = join(project,'.webpack',process.arch,'main/index.js');
  const bootstrap = join(root,'managed-playwright-bootstrap.cjs');
  await writeFile(bootstrap,`
'use strict';
if (process.env.NODE_ENV !== 'test' || !process.argv.includes(${JSON.stringify('--deskpet-isolated-profile='+root)})) throw new Error('Refusing non-isolated managed-browser fixture');
const { app, dialog } = require('electron');
app.setAppPath(${JSON.stringify(project)});
const state = globalThis.__managedPlaywrightDialogs = {next:null,denyNext:false,prompts:[],unexpected:[]};
dialog.showOpenDialog = async () => {state.unexpected.push('open');return {canceled:true,filePaths:[]};};
dialog.showOpenDialogSync = () => {state.unexpected.push('open-sync');return undefined;};
dialog.showSaveDialog = async () => {state.unexpected.push('save');return {canceled:true,filePath:''};};
dialog.showSaveDialogSync = () => {state.unexpected.push('save-sync');return undefined;};
dialog.showMessageBox = async (...args) => {
  const options = args.at(-1) || {};
  if (options.title !== 'Allow this MCP call?') {state.unexpected.push('message:' + String(options.title));return {response:options.cancelId ?? 0,checkboxChecked:false};}
  const next = state.next; state.next = null;
  const allowed = !!next && options.message === JSON.stringify('Playwright') + ' · ' + JSON.stringify(next.tool)
    && options.detail === next.endpoint + String.fromCharCode(10,10) + JSON.stringify(next.arguments,null,2);
  if (!allowed && !state.denyNext) state.unexpected.push('unplanned MCP review');
  state.denyNext = false;
  state.prompts.push({message:options.message || '',detail:options.detail || '',allowed});
  return {response:allowed ? 1 : 0,checkboxChecked:false};
};
dialog.showMessageBoxSync = (...args) => {state.unexpected.push('message-sync');return args.at(-1)?.cancelId ?? 0;};
dialog.showErrorBox = title => {state.unexpected.push('error:' + String(title));};
require(${JSON.stringify(compiled)});
`);
  let fixtureRequests = 0;
  const fixture = createServer((_request,response) => {
    fixtureRequests++;
    response.writeHead(200,{'content-type':'text/html'});
    response.end('<!doctype html><title>DeskPet managed fixture</title><h1>Managed browser fixture</h1><button onclick="document.querySelector(\'p\').textContent=\'Clicks 1\'">Increment</button><p>Clicks 0</p>');
  });
  await new Promise<void>(resolve => fixture.listen(0,'127.0.0.1',resolve));
  const fixtureUrl = 'http://127.0.0.1:'+(fixture.address() as AddressInfo).port+'/';
  const env:Record<string,string> = {NODE_ENV:'test'};
  for (const key of ['PATH','HOME','TMPDIR','LANG','LC_ALL','DISPLAY']) if (process.env[key] !== undefined) env[key] = process.env[key]!;
  let app:ElectronApplication|undefined, page:Page|undefined, failure:string|null = null, firstOrigin:string|null = null, finalOrigin:string|null = null;
  const states:McpServerView[] = [];
  let toolNames:string[] = [], dialogs:ManagedDialogs|null = null;
  const checks:Record<string,boolean> = {};
  try {
    app = await electron.launch({args:[bootstrap,'--deskpet-isolated-profile='+root],cwd:project,env});
    await expect.poll(() => app!.windows().some(item => item.url().includes('/main_window/'))).toBe(true);
    page = app.windows().find(item => item.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    await app.evaluate(({app},expected) => {
      if (app.isPackaged || app.getPath('userData') !== expected.profile || app.getAppPath() !== expected.project) throw new Error('Refusing non-fixture runtime');
    },{profile,project});
    const id = await page.evaluate(async () => {
      await window.deskpet.app.setLocale('en');
      const extensions = window.deskpet.plugins.extensions;
      if (!extensions.installRecommended) throw new Error('Recommended catalog unavailable');
      const state = await extensions.installRecommended({skills:[],servers:['playwright'],enabled:true});
      const server = state.servers.find(item => item.preset === 'playwright');
      if (!server) throw new Error('Managed preset missing');
      return server.id;
    });
    await page.locator('nav').getByRole('button',{name:'Settings',exact:true}).click();
    await page.getByRole('tab',{name:'MCP servers',exact:true}).click();
    const panel = page.getByRole('group',{name:'MCP servers',exact:true});
    const card = panel.getByRole('region',{name:'Playwright',exact:true});
    await expect(card.getByRole('checkbox',{name:'Enable server'})).toBeChecked();
    await card.getByRole('button',{name:'List tools'}).click();
    const selectedTool = panel.getByRole('combobox',{name:'Tool',exact:true});
    await expect(selectedTool).toBeVisible({timeout:30_000});
    toolNames = await selectedTool.locator('option').evaluateAll(options => options.map(option => option.getAttribute('value') ?? ''));
    expect(toolNames).toHaveLength(24); expect(toolNames).not.toContain('browser_run_code_unsafe');
    await expect(panel.getByText('Connected · 24 tools',{exact:true})).toBeVisible();
    const readServer = async ():Promise<McpServerView> => page!.evaluate(async serverId => {
      const server = (await window.deskpet.plugins.extensions.state()).servers.find(item => item.id === serverId);
      if (!server) throw new Error('Managed server missing'); return server;
    },id);
    let server = await readServer(); states.push(server);
    expect(server).toMatchObject({preset:'playwright',privateBridge:true,enabled:true});
    expect(server.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/…$/u);
    expect(capability.test(JSON.stringify(server))).toBe(false);
    firstOrigin = new URL(server.endpoint).origin;
    const result = panel.locator('.extension-workspace pre.extension-preview').last();
    const setArguments = async (name:string,args:Record<string,unknown>):Promise<void> => {
      await selectedTool.selectOption(name);
      await expect(selectedTool).toHaveValue(name);
      await panel.getByLabel('Arguments (JSON object)').fill(JSON.stringify(args));
    };
    const allowCall = async (name:string,args:Record<string,unknown>):Promise<void> => {
      server = await readServer();
      await app!.evaluate((_electron,next) => {(globalThis as unknown as ManagedGlobal).__managedPlaywrightDialogs.next = next;},{tool:name,arguments:args,endpoint:server.endpoint});
      await setArguments(name,args);
      await panel.getByRole('button',{name:'Review and call',exact:true}).click();
      await expect(panel.getByRole('button',{name:'Review and call',exact:true})).toBeEnabled({timeout:30_000});
    };
    await setArguments('browser_navigate',{url:fixtureUrl});
    await app.evaluate(() => {(globalThis as unknown as ManagedGlobal).__managedPlaywrightDialogs.denyNext = true;});
    await panel.getByRole('button',{name:'Review and call',exact:true}).click();
    await expect(panel.getByRole('alert')).toHaveText('This call was denied.'); expect(fixtureRequests).toBe(0); checks.deniedCallDoesNotNavigate = true;
    await allowCall('browser_navigate',{url:fixtureUrl});
    await expect(result).toContainText('DeskPet managed fixture'); expect(fixtureRequests).toBeGreaterThan(0);
    await allowCall('browser_snapshot',{}); await expect(result).toContainText('Clicks 0'); checks.pageSurvivesClientSessionClosure = true;
    const ref = /button "Increment" \[ref=([^\]]+)\]/u.exec(await result.innerText())?.[1];
    expect(ref).toBeTruthy();
    await allowCall('browser_click',{target:ref!}); await expect(panel.getByText('Tool error',{exact:true})).toHaveCount(0);
    await allowCall('browser_snapshot',{}); await expect(result).toContainText('Clicks 1'); checks.separateSessionClickPersists = true;
    await result.scrollIntoViewIfNeeded();
    await page.screenshot({path:info.outputPath('managed-playwright-reviewed-result.png'),scale:'css'});
    const toggle = card.getByRole('checkbox',{name:'Enable server'});
    await toggle.click(); await expect(toggle).not.toBeChecked();
    await expect.poll(async () => {try {await fetch(firstOrigin!+'/');return false;}catch{return true;}}).toBe(true); checks.disabledWorkerStopped = true;
    await toggle.click(); await expect(toggle).toBeChecked();
    await card.getByRole('button',{name:'List tools'}).click(); await expect(selectedTool).toBeVisible({timeout:30_000});
    const restarted = await readServer(); states.push(restarted); expect(restarted.revision).toBeGreaterThan(states[0]!.revision); expect(restarted.privateBridge).toBe(true);
    finalOrigin = new URL(restarted.endpoint).origin;
    await allowCall('browser_snapshot',{});
    await expect(result).toContainText(/about:blank|No open pages|No open tabs/u);
    await expect(result).not.toContainText('Clicks 1'); await expect(result).not.toContainText('Managed browser fixture'); checks.restartHasFreshBrowserContext = true;
    dialogs = await app.evaluate(() => (globalThis as unknown as ManagedGlobal).__managedPlaywrightDialogs);
    expect(dialogs.next).toBeNull(); expect(dialogs.unexpected).toEqual([]); expect(dialogs.prompts).toHaveLength(6);
    expect(dialogs.prompts.map(item => item.allowed)).toEqual([false,true,true,true,true,true]);
    expect(dialogs.prompts.every(item => item.detail.includes('/…'))).toBe(true);
    expect(capability.test(JSON.stringify([states,dialogs,await panel.innerText()]))).toBe(false); checks.capabilityHiddenFromUiAndReviews = true;
    await app.close(); app = undefined;
    await expect.poll(async () => {try {await fetch(finalOrigin!+'/');return false;}catch{return true;}}).toBe(true); checks.appExitStopsWorker = true;
  } catch (error) {
    failure = error instanceof Error ? error.stack ?? error.message : String(error);
    if (page && !page.isClosed()) await page.screenshot({path:info.outputPath('managed-playwright-failure.png')}).catch(() => undefined);
    throw error;
  } finally {
    await app?.close().catch(() => undefined);
    fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve()));
    await writeFile(info.outputPath('managed-playwright-evidence.json'),JSON.stringify({scope:'Isolated development AppController, encrypted private bridge binding, native per-call approval and the actual Playwright headless shell against one synthetic local page. No real profiles, models, credentials or external endpoints.',failure,checks,states,toolNames,dialogs},null,2));
    await rm(root,{recursive:true,force:true});
  }
});
