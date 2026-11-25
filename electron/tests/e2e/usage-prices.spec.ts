import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderConfig, UsageEvent, UsageSnapshot } from '../../src/shared';
import { projectUsage } from '../../src/main/domain/usage-projection';
import { answerRecentSummary, isRecentSummary } from './support/recent-summary';


// Real renderer, preload, IPC, host ledger, utility transport and encrypted
// persistence; only the model response is a deterministic loopback fixture.
// All profiles are newly marked isolated candidates; no personal key or profile.
// eslint-disable-next-line no-empty-pattern
test('prices repair unknown records, freeze new requests and survive a normal packaged restart', async ({}, info) => {
  test.setTimeout(180_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deskpet-usage-prices-')));
  await writeFile(join(root, 'isolated-candidate.json'), JSON.stringify({ version: 1, purpose: 'deskpet-isolated-candidate' }));
  const evidenceRoot = process.env.DESKPET_COST_EVIDENCE ?? info.outputPath('cost-evidence');
  await mkdir(evidenceRoot, { recursive: true });
  const executablePath = process.env.DESKPET_COST_APP;
  const wires: Array<{ prompt: string; bodySHA256: string; usage: Record<string, unknown> }> = [];
  const errors: string[] = [], identities: unknown[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.url?.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'synthetic-cost-model' }] })); return;
      }
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      const bytes = Buffer.concat(chunks), body = JSON.parse(bytes.toString()) as { messages: Array<{ role: string; content: string }> };
      const prompt = body.messages.filter(message => message.role === 'user').at(-1)?.content ?? '';
      const usage: Record<string, unknown> = { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400, cache_write_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 80 } };
      if (prompt.includes('COST_REPORTED')) { usage.cost = 0.5; usage.cost_currency = 'USD'; }
      if (prompt.includes('COST_ZERO')) { usage.cost = 0; usage.cost_currency = 'USD'; }
      if (prompt.includes('COST_NO_OUTPUT')) { delete usage.completion_tokens; delete usage.completion_tokens_details; }
      if (isRecentSummary(body)) { answerRecentSummary(response); return; } 
      wires.push({ prompt, bodySHA256: createHash('sha256').update(bytes).digest('hex'), usage });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: `SYNTHETIC_DONE_${prompt}` }, finish_reason: 'stop' }], usage })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing synthetic fixture port');
  let application: ElectronApplication | undefined, page: Page;
  let provider: ProviderConfig;
  let beforeRestart: { usage: UsageSnapshot; sessions: unknown; messages: unknown } | undefined;
  const snapshots: Record<string, UsageSnapshot> = {};
  const sizes: unknown[] = [];
  const launch = async (): Promise<void> => {
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY']) if (process.env[key] !== undefined) env[key] = process.env[key]!;
    application = await electron.launch({ env, cwd: process.cwd(), timeout: 20_000, ...(executablePath ? { executablePath, args: [`--deskpet-isolated-profile=${root}`] }
      : { args: [join(process.cwd(), '.webpack', process.arch, 'main/index.js'), `--deskpet-isolated-profile=${root}`] }) });
    await expect.poll(() => application!.windows().some(window => window.url().includes('/main_window/'))).toBe(true);
    page = application.windows().find(window => window.url().includes('/main_window/'))!;
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.locator('.app-shell')).toBeVisible();
    identities.push(await application.evaluate(({ app }) => ({ pid: process.pid, appPath: app.getAppPath(), packaged: app.isPackaged, dataDirectory: app.getPath('userData') })));
    const diagnostics = await page.evaluate(() => window.deskpet.app.getDiagnostics());
    expect(diagnostics.runtimeIdentity?.dataDirectory).toBe(join(root, 'profile'));
    identities.push(diagnostics.runtimeIdentity);
  };
  const normalQuit = async (): Promise<void> => {
    const current = application!;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => current.process().once('exit', (code, signal) => resolve({ code, signal })));
    await current.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); });
    expect(await exited).toEqual({ code: 0, signal: null });
    application = undefined;
  };
  const usage = async (): Promise<void> => {
    await page.locator('nav').getByRole('button', { name: 'Tools', exact: true }).click(); await page.getByRole('tab', { name: 'Tokens and cost', exact: true }).click();
    await expect(page.locator('.usage-page')).toBeVisible();
    await expect(page.locator('.usage-page .usage-summary').first()).toBeVisible();
  };
  // The background recent summary is accounted as scope "other"; these checks cover the priced chat requests.
  const readUsage = async (): Promise<UsageSnapshot> => { const snapshot = await page.evaluate(() => window.deskpet.usage.snapshot()); return { ...snapshot, events: snapshot.events.filter(event => event.scope !== 'other') }; };
  const eventFor = async (prompt: string): Promise<UsageEvent> => {
    const snapshot = await readUsage(), wire = wires.find(item => item.prompt === prompt)!;
    expect(wire).toBeDefined();
    const sessions = await page.evaluate(() => window.deskpet.chat.listSessions());
    for (const session of sessions) {
      const messages = await page.evaluate(id => window.deskpet.chat.listMessages(id), session.id);
      const reply = messages.find(message => message.role === 'assistant' && message.content === `SYNTHETIC_DONE_${prompt}`);
      const receipt = reply?.requestReceipts?.find(item => item.expectedBodySHA256 === wire.bodySHA256);
      if (receipt) return snapshot.events.find(event => event.requestId === receipt.requestId)!;
    }
    throw new Error(`Missing synthetic receipt for ${prompt}`);
  };
  const send = async (prompt: string): Promise<void> => {
    await page.locator('nav').getByRole('button', { name: 'Chat', exact: true }).click();
    const count = await page.locator('.message.assistant').count();
    await page.locator('.composer textarea').fill(prompt); await page.locator('.composer textarea').press('Enter');
    await expect(page.locator('.message.assistant')).toHaveCount(count + 1);
    await expect(page.locator('.message.assistant').last()).toHaveAttribute('data-status', 'complete');
    await expect(page.locator('.message.assistant').last()).toContainText(`SYNTHETIC_DONE_${prompt}`);
    expect((await eventFor(prompt)).dispatchedAt).not.toBeNull();
  };
  const setPrice = async (input: string, output: string, cached: string, written: string, currency = 'USD'): Promise<void> => {
    await usage();
    const editor = page.locator('.usage-rate-editor');
    if (await editor.getAttribute('open') === null) await editor.locator(':scope > summary').click();
    await editor.getByLabel('Currency', { exact: true }).selectOption(currency);
    await editor.getByLabel('Input / million tokens', { exact: true }).fill(input);
    await editor.getByLabel('Output / million tokens', { exact: true }).fill(output);
    await editor.getByLabel('Cache read / million tokens', { exact: true }).fill(cached);
    await editor.getByLabel('Cache write / million tokens', { exact: true }).fill(written);
    await editor.getByRole('button', { name: 'Save custom price', exact: true }).click();
    await expect(editor.getByRole('status')).toContainText('Custom price saved');
    await expect.poll(async () => (await readUsage()).rates.find(rate => rate.providerId === provider.id && rate.model === provider.model && 'price' in rate && rate.price.source === 'manual'))
      .toMatchObject({ price: { currency, inputPerMillion: Number(input), outputPerMillion: Number(output) } });
  };
  const screenshot = async (name: string): Promise<void> => { await page.screenshot({ path: join(evidenceRoot, name), fullPage: true }); };
  try {
    await launch();
    await page!.evaluate(async baseUrl => {
      await window.deskpet.app.setLocale('en'); await window.deskpet.app.setTheme('light');
      const provider = await window.deskpet.providers.upsert({ id: crypto.randomUUID(), kind: 'lm-studio', name: 'Synthetic cost provider', baseUrl, model: 'synthetic-cost-model',
        enabled: true, supportsTools: false, localExecutionConfirmed: true, contextWindowTokens: 16384, maxOutputTokens: 512 });
      await window.deskpet.providers.select(provider.id);
      await window.deskpet.providers.upsert({ id: crypto.randomUUID(), kind: 'openai', name: 'Official reference only — no credential', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-terra', enabled: false, supportsTools: true });
    }, `http://127.0.0.1:${address.port}/v1`);
    await page!.reload(); await expect(page!.locator('.app-shell')).toBeVisible();
    provider = (await page!.evaluate(() => window.deskpet.providers.list())).find(item => item.kind === 'lm-studio')!;
    const automatic = (await readUsage()).rates.find(rate => 'price' in rate && rate.price.source === 'reference');
    expect(automatic).toMatchObject({ model: 'gpt-6.1-terra', price: { currency: 'USD', inputPerMillion: 1, outputPerMillion: 5, cachedInputPerMillion: 0.05, endpoint: 'https://api.openai.com/v1' } });
    await send('COST_UNKNOWN');
    const unknown = await eventFor('COST_UNKNOWN');
    expect(unknown).toMatchObject({ priceSnapshot: null, inputTokens: 1000, outputTokens: 200, cachedInputTokens: 400, cacheWriteInputTokens: 100, reasoningOutputTokens: 80 });
    await usage(); await expect(page!.locator(`.usage-page tr[data-request-id="${unknown.requestId}"]`)).toContainText('No price saved when this request was made');
    await screenshot('01-missing-rate.png');
    await setPrice('2', '10', '0.2', '2.5');
    await expect(page!.locator(`.usage-page tr[data-request-id="${unknown.requestId}"]`)).toContainText('$0.00333');
    await expect(page!.locator(`.usage-page tr[data-request-id="${unknown.requestId}"]`)).toContainText('Supplement at current price');
    await screenshot('02-custom-price-supplement.png');
    await page!.locator(`.usage-page tr[data-request-id="${unknown.requestId}"]`).scrollIntoViewIfNeeded();
    await screenshot('02b-current-supplement-row.png');
    await send('COST_FROZEN');
    const frozen = await eventFor('COST_FROZEN');
    expect(frozen.priceSnapshot).toMatchObject({ inputPerMillion: 2, outputPerMillion: 10, cachedInputPerMillion: 0.2, cacheWriteInputPerMillion: 2.5, source: 'manual' });
    await setPrice('20', '100', '2', '25');
    await send('COST_NEW_RATE');
    snapshots.afterPriceChange = await readUsage();
    const projected = projectUsage(snapshots.afterPriceChange);
    expect(projected.requests.find(item => item.event.requestId === frozen.requestId)?.cost).toMatchObject({ amount: 0.00333, basis: 'request-snapshot', cacheBreakdown: 'reported' });
    expect(projected.requests.find(item => item.event.requestId === unknown.requestId)?.cost).toMatchObject({ amount: 0.0333, basis: 'current-reference' });
    await usage();
    const frozenRow = page!.locator(`.usage-page tr[data-request-id="${frozen.requestId}"]`);
    await frozenRow.getByText('Pricing details', { exact: true }).click();
    await frozenRow.scrollIntoViewIfNeeded();
    await screenshot('03-frozen-and-current-prices.png');
    await setPrice('8', '28', '2', '8', 'CNY'); await send('COST_CNY');
    await send('COST_REPORTED'); await send('COST_ZERO'); await send('COST_NO_OUTPUT');
    await usage();
    await expect(page!.getByText('Estimated cost (CNY)', { exact: true })).toBeVisible();
    await expect(page!.getByText('Estimated cost (USD)', { exact: true })).toBeVisible();
    const noOutput = await eventFor('COST_NO_OUTPUT');
    await expect(page!.locator(`.usage-page tr[data-request-id="${noOutput.requestId}"]`)).toContainText('Provider did not return output tokens');
    const zero = await eventFor('COST_ZERO');
    await expect(page!.locator(`.usage-page tr[data-request-id="${zero.requestId}"]`)).toContainText('$0.00');
    snapshots.mixedCurrencies = await readUsage();
    expect(projectUsage(snapshots.mixedCurrencies).summary).toMatchObject({ reportedUSD: 0.5, reportedCostRequests: 2, unknownCostRequests: 1,
      estimatedByCurrency: { USD: 0.03663, CNY: 0.0224 } });
    await screenshot('04-currencies-and-reasons.png');
    await page!.locator(`.usage-page tr[data-request-id="${noOutput.requestId}"]`).scrollIntoViewIfNeeded();
    await screenshot('04b-request-cost-reasons.png');
    const editor = page!.locator('.usage-rate-editor'); await editor.locator(':scope > summary').click();
    await editor.getByRole('button', { name: 'Refresh model catalog', exact: true }).click();
    await expect(editor.getByRole('status')).toContainText('Model catalog refreshed');
    await editor.getByRole('button', { name: 'Remove custom price', exact: true }).click();
    await expect(editor.getByRole('status')).toContainText('Custom price removed');
    expect((await readUsage()).rates.some(rate => rate.providerId === provider.id && 'price' in rate && rate.price.source === 'manual')).toBe(false);
    await setPrice('8', '28', '2', '8', 'CNY');
    const official = (await page!.evaluate(() => window.deskpet.providers.list())).find(item => item.kind === 'openai')!;
    await editor.getByLabel('Provider', { exact: true }).selectOption(official.id);
    await expect(editor.locator('.usage-active-price')).toContainText('Official reference');
    await editor.getByRole('button', { name: 'Fill from current price', exact: true }).click();
    await expect(editor.getByLabel('Cache read / million tokens', { exact: true })).toHaveValue('0.05');
    await screenshot('05-official-price-without-discovery.png');
    await editor.getByLabel('Provider', { exact: true }).selectOption(provider.id);
    await application!.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('/main_window/')); window!.setSize(820, 600); });
    await editor.getByRole('button', { name: 'Fill from current price', exact: true }).click();
    await editor.getByRole('button', { name: 'Save custom price', exact: true }).scrollIntoViewIfNeeded();
    const layout = await page!.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, scrollWidth: document.documentElement.scrollWidth,
      save: document.querySelector('.usage-rate-editor button[type="submit"]')!.getBoundingClientRect().toJSON(), scroll: document.querySelector('.page-scroll')!.getBoundingClientRect().toJSON() }));
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width); expect(layout.save.bottom).toBeLessThanOrEqual(layout.scroll.bottom + 1); sizes.push(layout);
    await screenshot('06-minimum-window-controls.png');
    await page!.evaluate(async () => { await window.deskpet.app.setLocale('zh-CN'); });
    await expect(page!.getByRole('heading', { level: 1, name: 'Token 与费用' })).toBeVisible();
    await page!.getByRole('region', { name: '累计费用', exact: true }).scrollIntoViewIfNeeded();
    await screenshot('07-chinese-minimum-summary.png');
    await page!.evaluate(async () => { await window.deskpet.app.setLocale('en'); });
    const sessions = await page!.evaluate(() => window.deskpet.chat.listSessions());
    const savedMessages = await Promise.all(sessions.map(session => page!.evaluate(id => window.deskpet.chat.listMessages(id), session.id)));
    beforeRestart = { usage: await readUsage(), sessions, messages: savedMessages };
    await normalQuit(); await launch();
    expect(await readUsage()).toEqual(beforeRestart.usage);
    expect(await page!.evaluate(() => window.deskpet.chat.listSessions())).toEqual(beforeRestart.sessions);
    expect(await Promise.all(sessions.map(session => page!.evaluate(id => window.deskpet.chat.listMessages(id), session.id)))).toEqual(beforeRestart.messages);
    await usage(); await page!.getByRole('region', { name: 'Cost totals', exact: true }).scrollIntoViewIfNeeded();
    await screenshot('08-restart-preserved.png');
    expect(wires).toHaveLength(7); expect(errors).toEqual([]);
    await normalQuit();
    const profile = await readFile(join(root, 'profile/profile.enc.json'));
    const evidence = { status: 'passed', isolatedRoot: root, executablePath: executablePath ?? null, identities, cases: { automaticPriceWithoutDiscovery: true, manualSupplement: true,
      requestSnapshotFrozen: true, cacheSplit: true, reasoningIncludedOnce: true, currenciesSeparated: true, reportedMoneyPreferred: true, reportedZeroPreserved: true,
      missingOutputExplained: true, refreshAndRemove: true, minimumWindow: true, normalRestartIdentical: true }, requestCount: wires.length, wires, snapshots,
      beforeRestart, sizes, pageErrors: errors, persistedProfileSHA256: createHash('sha256').update(profile).digest('hex'), limits: ['Synthetic loopback model responses; no real provider price/invoice reconciliation.', 'Official configuration has no credential and performs no provider request.'] };
    await writeFile(join(evidenceRoot, 'evidence.json'), JSON.stringify(evidence, null, 2));
  } catch (error) {
    const failurePage = application?.windows().find(window => window.url().includes('/main_window/'));
    if (failurePage) await failurePage.screenshot({ path: join(evidenceRoot, 'failure.png'), fullPage: true }).catch(() => undefined);
    await writeFile(join(evidenceRoot, 'failure.json'), JSON.stringify({ error: error instanceof Error ? error.stack : String(error), identities, wires, snapshots, beforeRestart, errors }, null, 2));
    throw error;
  } finally {
    if (application) await application.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
