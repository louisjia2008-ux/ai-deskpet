import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line no-empty-pattern
test('one setting turns on check-ins, which use the character and reach the desktop bubble', async ({}) => {
  test.setTimeout(120_000);
  const profile = await mkdtemp(join(tmpdir(), 'deskpet-check-in-e2e-'));
  const requests: Array<{ messages: Array<{ role: string; content: string }>; tools?: unknown[] }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (!request.url?.endsWith('/chat/completions')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(request.url?.endsWith('/api/show') ? { model_info: {} } : { data: [{ id: 'fixture' }] })); return; }
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof requests[number]);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '今天也辛苦啦，要不要歇一会儿？' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  let application: ElectronApplication | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    application = await electron.launch({ args: [join(process.cwd(), '.webpack', process.arch, 'main/index.js')], env: { ...process.env, NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile } });
    await expect.poll(() => application!.windows().some((window) => window.url().includes('/main_window/'))).toBe(true);
    const page: Page = application.windows().find((window) => window.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
    await page.evaluate(async (baseUrl) => {
      await window.deskpet.app.setLocale('zh-CN');
      const id = crypto.randomUUID();
      await window.deskpet.providers.upsert({ id, kind: 'ollama', name: 'Check-in fixture', baseUrl, model: 'fixture', enabled: true, supportsTools: false, localExecutionConfirmed: true, contextWindowTokens: 16384 });
      await window.deskpet.providers.select(id);
    }, `http://127.0.0.1:${address.port}/v1`);
    await page.reload(); await expect(page.locator('.app-shell')).toBeVisible();
    await page.locator('nav').getByRole('button', { name: '陪伴', exact: true }).click();
    await page.getByRole('tab', { name: '人设', exact: true }).click();
    await page.getByRole('textbox', { name: '性格', exact: true }).fill('傲娇，嘴硬心软');
    await page.getByRole('button', { name: '保存人格', exact: true }).click();
    await expect(page.getByText('已保存，新的回复会使用这个人格。')).toBeVisible();
    await page.getByRole('tab', { name: '主动关心', exact: true }).click();
    expect(requests).toHaveLength(0);
    await page.getByRole('radio', { name: '主动问候', exact: true }).click();
    await page.getByRole('button', { name: '现在问候一次', exact: true }).click();
    const overlay = application.windows().find((window) => window.url().includes('/overlay_window/'))!;
    await expect(overlay.getByText('今天也辛苦啦，要不要歇一会儿？', { exact: true })).toBeVisible({ timeout: 30_000 });
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).toContain('傲娇');
    expect(JSON.stringify(requests[0])).toContain('默认用自然的简体中文');
    expect(requests[0]?.tools ?? []).toHaveLength(0);
    await overlay.getByRole('button', { name: '接着聊' }).click();
    await expect(page.locator('.chat-reply').last()).toHaveText('今天也辛苦啦，要不要歇一会儿？');
    await expect(page.locator('.sidebar-session-row').first()).toContainText('主动问候');
  } finally { await application?.close(); server.close(); await rm(profile, { recursive: true, force: true }); }
});
