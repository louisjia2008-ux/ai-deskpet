import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line no-empty-pattern
test('optional check-in failures combine without a badge, open usable diagnostics and clear after publication', async ({}) => {
  test.setTimeout(90_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deskpet-attention-proactive-')));
  let requests = 0;
  const server = createServer((request, response) => {
    request.resume(); request.on('end', () => {
      if (!request.url?.endsWith('/chat/completions')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"data":[]}'); return; }
      requests++;
      if (requests <= 3) { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code: null, type: 'invalid_request_error', param: 'temperature', message: 'Unsupported parameter: temperature is not supported with this model.' } })); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '问候恢复成功，记得休息。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
    });
  });
  let app: ElectronApplication | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing fixture port');
    const base = `http://127.0.0.1:${address.port}`;
    await writeFile(join(root, 'isolated-candidate.json'), JSON.stringify({ version: 1, purpose: 'deskpet-isolated-candidate' }));
    const entry = join(root, 'boot.cjs');
    await writeFile(entry, [
      "const {dialog,net,Notification}=require('electron');",
      'dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});Notification.prototype.show=function(){};',
      'const original=net.fetch.bind(net);',
      `net.fetch=(input,opts)=>{const u=new URL(input);if(u.protocol==='file:'||u.origin===${JSON.stringify(base)})return original(input,opts);throw Error('Unexpected test network destination');};`,
      'require(' + JSON.stringify(join(process.cwd(), '.webpack', process.arch, 'main/index.js')) + ');',
    ].join('\n'));
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY']) if (process.env[key]) env[key] = process.env[key]!;
    app = await electron.launch({ args: [entry, '--deskpet-isolated-profile=' + root], env });
    await expect.poll(() => app!.windows().some(w => w.url().includes('/main_window/'))).toBe(true);
    const page = app.windows().find(w => w.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(join(root, 'profile'));
    await page.evaluate(async base => {
      await window.deskpet.app.setLocale('zh-CN');
      const p = await window.deskpet.providers.upsert({ id: crypto.randomUUID(), kind: 'lm-studio', name: '问候测试模型', baseUrl: base + '/v1', model: 'check-in-fixture', enabled: true, supportsTools: false, localExecutionConfirmed: true });
      await window.deskpet.permissions.request({ capabilityId: 'automation.text', duration: 'always' });
      await window.deskpet.automation.configureProactive({ enabled: true, mode: 'auto', providerId: p.id, model: p.model, eventKinds: ['explicit-check-in'], quietStart: '00:00', quietEnd: '00:00', timezone: 'Asia/Shanghai', cooldownMinutes: 1, dailyLimit: 12, topics: [], privacy: 'local-only' });
    }, base);
    await page.reload(); await expect(page.locator('.app-shell')).toBeVisible();
    const run = () => page.evaluate(() => window.deskpet.automation.explicitCheckIn({ operationId: crypto.randomUUID() }));
    for (let i = 1; i <= 2; i++) {
      await run();
      await expect.poll(async () => (await page.evaluate(() => window.deskpet.automation.snapshot())).automationTriggers.filter(t => t.status === 'failed').length).toBe(i);
    }
    await page.locator('nav').getByRole('button', { name: '动态', exact: true }).click();
    await page.getByRole('tab', { name: '待处理中心', exact: true }).click();
    await expect(page.getByRole('article', { name: '主动问候暂时未成功' })).toHaveCount(1);
    await expect(page.getByRole('button', { name: '需要处理 0', exact: true })).toBeVisible();
    await expect(page.getByText('近期失败次数: 2')).toBeVisible();
    await page.getByRole('button', { name: '查看问候诊断', exact: true }).click();
    await expect(page.getByRole('region', { name: '查看问候诊断' })).toContainText('问候测试模型');
    await expect(page.getByRole('region', { name: '查看问候诊断' })).toContainText('此模型不支持的参数');
    await expect(page.getByText('无法读取权威任务状态。请在存储恢复后重试。')).toHaveCount(0);
    await page.getByRole('button', { name: '移出待处理', exact: true }).click();
    await expect(page.getByRole('article')).toHaveCount(0);
    await run(); await expect.poll(() => requests).toBe(3);
    await expect(page.getByRole('article', { name: '主动问候暂时未成功' })).toHaveCount(1);
    await expect(page.getByText('近期失败次数: 3')).toBeVisible();
    await page.screenshot({ path: join(root, 'grouped-diagnostics.png'), scale: 'css' });
    await run(); await expect.poll(() => requests).toBe(4);
    await expect.poll(async () => (await page.evaluate(() => window.deskpet.attention.snapshot())).items.length).toBe(0);
    await expect(page.getByRole('article')).toHaveCount(0);
    const history = await page.evaluate(() => window.deskpet.automation.snapshot());
    expect(history.jobs).toHaveLength(4); expect(history.automationTriggers.filter(t => t.publishedAt)).toHaveLength(1);
    expect(await page.evaluate(() => window.deskpet.jobs.list())).toEqual([]);
  } finally { await app?.close(); server.close(); await rm(root, { recursive: true, force: true }); }
});
