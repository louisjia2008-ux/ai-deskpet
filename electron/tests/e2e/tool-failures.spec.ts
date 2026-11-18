import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Model and DNS responses are deterministic local fixtures. Validation, runtime,
// permission IPC and UI remain real; no public DNS or remote provider is used.
// eslint-disable-next-line no-empty-pattern
test('explains tool network and input failures, and cancels a pending web read', async ({}, info) => {
  test.setTimeout(60_000);
  const profile = await mkdtemp(join(tmpdir(), 'deskpet-tool-error-e2e-'));
  let application: ElectronApplication | undefined;
  const entry = join(profile, 'entry.cjs');
  await writeFile(entry, `const dns = require('node:dns/promises'); const lookup = dns.lookup;
globalThis.__toolFailureDns = { cancelStarted: false };
dns.lookup = (host, options) => {
  if (host === 'cancel-dns.invalid') { globalThis.__toolFailureDns.cancelStarted = true; return new Promise(() => {}); }
  if (host === 'deskpet-tool-eval.invalid') return Promise.reject(Object.assign(new Error('Synthetic DNS failure'), { code: 'ENOTFOUND' }));
  return lookup(host, options);
};
require(${JSON.stringify(join(process.cwd(), '.webpack', process.arch, 'main/index.js'))});`);
  const requestPrompts: string[] = [];
  const server = createServer((request, response) => {
    if (request.url?.endsWith('/api/show') || request.url?.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(request.url.endsWith('/api/show')
        ? { model_info: { 'general.architecture': 'llama', 'llama.context_length': 32768 } }
        : { data: [{ id: 'fixture' }] }));
      return;
    }
    const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string; description: string } }> };
      const prompt = body.messages.find((message) => message.role === 'user')!.content;
      requestPrompts.push(prompt);
      // The progress report after repeated failures declares no tools.
      if (!body.tools) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'WRAP_UP_REPORT' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      const title = prompt === 'timezone' ? 'Current time.' : prompt === 'missing-file' ? 'Read workspace file.' : 'Read HTTPS page.';
      const name = body.tools.find((tool) => tool.function.description.startsWith(title))!.function.name;
      const args = prompt === 'timezone' ? { timezone: 'Not/A_Timezone' } : prompt === 'missing-file' ? { path: 'missing-test-file.txt' } : { url: prompt === 'blocked-target' ? 'http://127.0.0.1/' : prompt === 'cancel' ? 'https://cancel-dns.invalid/' : 'https://deskpet-tool-eval.invalid/' };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${requestPrompts.length}`, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
  try {
    application = await electron.launch({ args: [entry], env: { ...process.env, NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile } });
    await expect.poll(() => application!.windows().some((window) => window.url().includes('/main_window/'))).toBe(true);
    const page = application.windows().find((window) => window.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    await application.evaluate(({ app, dialog }, expectedProfile) => {
      if (app.isPackaged || app.getPath('userData') !== expectedProfile) throw new Error('Permission fixture requires a disposable profile');
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    }, profile);
    await page.evaluate(async (baseUrl) => {
      await window.deskpet.app.setLocale('en');
      await window.deskpet.providers.upsert({ id: crypto.randomUUID(), kind: 'ollama', name: 'Error fixture', model: 'fixture', baseUrl, enabled: true, supportsTools: true, localExecutionConfirmed: true, contextWindowTokens: 32768, maxOutputTokens: 512 });
      for (const capabilityId of ['time.read', 'web.read', 'workspace.read']) await window.deskpet.permissions.request({ capabilityId, duration: 'session' });
    }, `http://127.0.0.1:${address.port}/v1`);
    const results: Array<Record<string, unknown>> = [];
    for (const [prompt, code, text] of [
      ['timezone', 'tool.invalidArguments', 'invalid tool parameters'],
      ['missing-file', 'tool.fileMissing', 'file was not found'],
      ['blocked-target', 'tool.webTarget', 'web address is not supported'],
      ['network', 'tool.network', 'could not be reached'],
    ]) {
      await page.locator('nav').getByRole('button', { name: 'Chat', exact: true }).click();
      await page.locator('#main-content').getByRole('button', { name: 'New conversation', exact: true }).click();
      await page.locator('.composer textarea').fill(prompt!); await page.locator('.composer textarea').press('Enter');
      const start = Date.now();
      const retryable = prompt !== 'blocked-target';
      await expect(page.locator('.message.assistant')).toHaveAttribute('data-status', retryable ? 'complete' : 'failed', { timeout: 20_000 });
      const current = await page.getByRole('combobox', { name: 'New chat', exact: true }).inputValue();
      const final = (await page.evaluate((id) => window.deskpet.chat.listMessages(id), current)).at(-1)!;
      if (retryable) { expect(final.errorCode).toBeNull(); expect(final.content).toContain('WRAP_UP_REPORT'); expect(final.content).toContain('repeated tool failures'); }
      else { expect(final.errorCode).toBe(code); await expect(page.getByRole('alert')).toContainText(text!); }
      const requestCount = requestPrompts.filter((item) => item === prompt).length;
      const runId = final.requestReceipts?.[0]?.runId;
      const events = await page.evaluate(() => window.deskpet.tasks.listRunEvents());
      const corrections = events.filter((event) => event.runId === runId && event.metadata.errorCode === code && event.metadata.recovery !== undefined);
      // Two real failures, two declined repeats, then one tool-free report.
      expect(requestCount).toBe(retryable ? 5 : 1);
      expect(corrections).toHaveLength(retryable ? 2 : 0);
      results.push({ prompt, errorCode: final.errorCode, elapsedMs: Date.now() - start, requestCount, safeCorrections: corrections.length });
      await page.screenshot({ path: info.outputPath(`${prompt}.png`) });
    }
    await page.locator('#main-content').getByRole('button', { name: 'New conversation', exact: true }).click();
    await page.locator('.composer textarea').fill('cancel'); await page.locator('.composer textarea').press('Enter');
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    // Observe the actual pending DNS fixture, not an earlier permission audit.
    await expect.poll(() => application!.evaluate(() => (globalThis as typeof globalThis & { __toolFailureDns: { cancelStarted: boolean } }).__toolFailureDns.cancelStarted)).toBe(true);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.locator('.message.assistant')).toHaveAttribute('data-status', 'cancelled', { timeout: 3_000 });
    await writeFile(info.outputPath('error-results.json'), JSON.stringify({ results, cancellationDuringDns: true }, null, 2));
  } finally { await application?.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(profile, { recursive: true, force: true }); }
});
