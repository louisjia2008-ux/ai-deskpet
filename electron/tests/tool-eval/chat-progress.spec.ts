import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatEvent } from '../../src/shared';

interface ProgressObservation { at: string; phase: string; text: string }
interface ProgressEvidence { events: ChatEvent[]; rendered: ProgressObservation[]; stop(): void }

// Explicit opt-in: real local inference and public web access, with an isolated
// profile. The observed status changes come from the production IPC and DOM.
// eslint-disable-next-line no-empty-pattern
test('shows real search, page reading and answer composition in the chat UI', async ({}, info) => {
  test.skip(process.env.DESKPET_TOOL_EVAL !== '1', 'Explicit opt-in required for live local inference.');
  test.setTimeout(240_000);
  const profile = await mkdtemp(join(tmpdir(), 'deskpet-chat-progress-'));
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({ args: [join(process.cwd(), '.webpack', process.arch, 'main/index.js')], env: { ...process.env, NODE_ENV: 'test', DESKPET_E2E_USER_DATA: profile } });
    await expect.poll(() => application!.windows().some((window) => window.url().includes('/main_window/'))).toBe(true);
    const page = application.windows().find((window) => window.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    await page.evaluate(async (model) => {
      await window.deskpet.app.setLocale('zh-CN');
      await window.deskpet.providers.upsert({ id: crypto.randomUUID(), kind: 'ollama', name: 'Progress acceptance', model, baseUrl: 'http://127.0.0.1:11434/v1', enabled: true, supportsTools: true });
      for (const capabilityId of ['web.read', 'web.search']) await window.deskpet.permissions.request({ capabilityId, duration: 'session' });
    }, process.env.DESKPET_TOOL_MODEL ?? 'kitty-qwen-27b:latest');
    await page.locator('nav').getByRole('button', { name: '聊天', exact: true }).click();
    await page.evaluate(() => {
      const evidence: ProgressEvidence = { events: [], rendered: [], stop: () => undefined };
      const unsubscribe = window.deskpet.chat.onEvent((event) => {
        if (event.type !== 'delta') evidence.events.push(event);
      });
      const observer = new window.MutationObserver(() => {
        const status = document.querySelector('.message.assistant:last-child .chat-waiting');
        const phase = status?.getAttribute('data-phase');
        if (phase && evidence.rendered.at(-1)?.phase !== phase) evidence.rendered.push({ at: new Date().toISOString(), phase, text: status?.textContent ?? '' });
      });
      observer.observe(document.querySelector('.transcript-inner')!, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-phase'] });
      evidence.stop = () => { observer.disconnect(); unsubscribe(); };
      (window as typeof window & { progressEvidence: ProgressEvidence }).progressEvidence = evidence;
    });
    const composer = page.locator('.composer textarea');
    await composer.fill('请先调用搜索工具搜索 Python official documentation，再读取搜到的 docs.python.org 官方网页。最后用两句话说明这个网站是什么，并给出来源链接。');
    await composer.press('Enter');
    await expect(page.locator('.message.assistant').last()).toHaveAttribute('data-status', 'complete', { timeout: 210_000 });
    await expect(page.locator('.chat-waiting')).toHaveCount(0, { timeout: 6_000 });
    const evidence = await page.evaluate(() => {
      const record = (window as typeof window & { progressEvidence: ProgressEvidence }).progressEvidence;
      record.stop(); return { events: record.events, rendered: record.rendered };
    });
    const events = await page.evaluate(() => window.deskpet.tasks.listRunEvents());
    await writeFile(info.outputPath('progress-evidence.json'), JSON.stringify({ ...evidence, runEvents: events }, null, 2));
    await page.screenshot({ path: info.outputPath('completed-answer.png') });
    const phases = evidence.rendered.map((observation) => observation.phase);
    expect(phases).toEqual(expect.arrayContaining(['thinking', 'web.search', 'web.read', 'composing', 'responding']));
    expect(phases.indexOf('web.search')).toBeLessThan(phases.indexOf('web.read'));
    expect(evidence.rendered.find((observation) => observation.phase === 'web.search')?.text).toContain('搜索');
    expect(evidence.rendered.find((observation) => observation.phase === 'web.read')?.text).toContain('读取');
    expect(evidence.rendered.find((observation) => observation.phase === 'composing')?.text).toContain('整理');
    await expect(page.locator('.message.assistant').last()).toContainText('docs.python.org');
  } finally {
    await application?.close();
    await rm(profile, { recursive: true, force: true });
  }
});
