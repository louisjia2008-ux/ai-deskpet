import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real host timers, durable event/job publication and UI; synthetic time, model
// and window-geometry boolean only. Never inspects the user's screen.
// eslint-disable-next-line no-empty-pattern
test('automatic greetings respect two-hour cooldown, fullscreen, unanswered restraint and restart', async ({}) => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), 'deskpet-restraint-e2e-')), profile = join(root, 'profile'), entry = join(root, 'boot.cjs');
  let requests = 0;
  const server = createServer((request, response) => { request.resume(); request.on('end', () => {
    if (!request.url?.endsWith('/chat/completions')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"data":[]}'); return; }
    requests++; response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: `合成问候第${requests}条，慢慢来就好。` }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  }); });
  const boot = async (date: string) => writeFile(entry, [
    "const {safeStorage,powerMonitor}=require('electron');safeStorage.isEncryptionAvailable=()=>true;safeStorage.encryptString=s=>Buffer.from('SYNTHETIC_RESTRAINT:'+s);safeStorage.decryptString=b=>b.toString().slice(20);",
    `const OriginalDate=Date;let clock=OriginalDate.parse(${JSON.stringify(date)});global.__companionClock=ms=>clock=ms;global.__companionFullscreen=false;`,
    "global.Date=new Proxy(OriginalDate,{construct:(t,args)=>Reflect.construct(t,args.length?args:[clock]),get:(t,k)=>k==='now'?()=>clock:Reflect.get(t,k)});",
    "powerMonitor.getSystemIdleTime=()=>0;const cp=require('node:child_process'),exec=cp.execFile;cp.execFile=(file,args,options,cb)=>{if(file==='/usr/bin/osascript'&&args.includes('JavaScript')){queueMicrotask(()=>cb(null,String(global.__companionFullscreen)+'\\n',''));return {kill(){}};}return exec(file,args,options,cb);};",
    'const interval=global.setInterval;global.setInterval=(cb,ms,...args)=>interval(cb,[5000,30000].includes(ms)?200:ms,...args);',
    'require(' + JSON.stringify(join(process.cwd(), '.webpack', process.arch, 'main/index.js')) + ');',
  ].join('\n'));
  let application: ElectronApplication | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing fixture port');
    await boot('2026-11-15T08:00:00Z');
    const launch = async () => {
      application = await electron.launch({ args: [entry], env: { ...process.env, NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile } });
      await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
      await expect.poll(() => application!.windows().some(window => window.url().includes('/main_window/'))).toBe(true);
      const page = application.windows().find(window => window.url().includes('/main_window/'))!; await expect(page.locator('.app-shell')).toBeVisible(); return page;
    };
    let page = await launch();
    const provider = await page.evaluate(async baseUrl => {
      await window.deskpet.app.setLocale('zh-CN');
      // This clock-driven case counts check-in requests, not the independent
      // ten-minute automatic memory extractor.
      await window.deskpet.autoMemory.configure({ enabled: false });
      const p = await window.deskpet.providers.upsert({ id: crypto.randomUUID(), kind: 'lm-studio', name: 'Restraint fixture', baseUrl,
        model: 'fixture', enabled: true, supportsTools: false, localExecutionConfirmed: true, contextWindowTokens: 16384 });
      const session = await window.deskpet.chat.createSession({ kind: 'normal', title: 'Owner chat' });
      await window.deskpet.chat.send({ sessionId: session.id, providerId: p.id, content: '合成聊天' }); return p;
    }, `http://127.0.0.1:${address.port}/v1`);
    await expect.poll(() => requests).toBe(1);
    await expect.poll(() => page.evaluate(() => window.deskpet.chat.listSessions().then(async sessions =>
      (await window.deskpet.chat.listMessages(sessions.find(s => s.title === 'Owner chat')!.id)).at(-1)?.status))).toBe('complete');
    await page.evaluate(async p => {
      await window.deskpet.permissions.request({ capabilityId: 'automation.text', duration: 'always' });
      await window.deskpet.automation.configureProactive({ enabled: true, mode: 'auto', providerId: p.id, model: p.model, privacy: 'local-only',
        eventKinds: ['explicit-check-in'], quietStart: '00:00', quietEnd: '00:00', timezone: 'UTC', cooldownMinutes: 120, dailyLimit: 2, topics: [] });
    }, provider);
    const clock = async (date: string, fullscreen = false) => application!.evaluate((_, value) => {
      const fixture = globalThis as unknown as { __companionClock(ms: number): void; __companionFullscreen: boolean };
      fixture.__companionClock(Date.parse(value.date)); fixture.__companionFullscreen = value.fullscreen;
    }, { date, fullscreen });
    const settle = () => page.waitForTimeout(800); // several accelerated real host ticks
    const published = () => page.evaluate(() => window.deskpet.automation.snapshot().then(s => s.automationTriggers.filter(t => t.publishedAt).length));
    await clock('2026-11-15T09:59:59Z'); await settle(); expect(requests).toBe(1);
    await clock('2026-11-15T10:01:00Z', true); await settle(); expect(requests).toBe(1);
    await clock('2026-11-15T10:01:00Z'); await expect.poll(published).toBe(1); expect(requests).toBe(2);
    await clock('2026-11-15T17:01:00Z'); await settle(); expect(requests).toBe(2);
    await application!.close(); application = undefined; await boot('2026-11-15T17:01:00Z'); page = await launch(); await settle(); expect(requests).toBe(2);
    await clock('2026-11-16T10:01:00Z'); await expect.poll(published).toBe(2); expect(requests).toBe(3);
    await clock('2026-11-17T10:01:00Z'); await settle(); expect(requests).toBe(3);
  } finally { await application?.close(); server.closeAllConnections(); server.close(); await rm(root, { recursive: true, force: true }); }
});
