import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanionJournal } from '../../src/main/domain/companion-journal';
import { DomainRepository } from '../../src/main/domain/repository';

interface RequestBody {
  model?: string;
  input?: string[];
  messages?: Array<{ role: string; content: string; tool_call_id?: string }>;
  tools?: Array<{ function: { name: string; description: string } }>;
}
interface Wire {
  path: string;
  body: RequestBody;
}
const sharedPath = 'Shared/Fixture note.md';
const privatePath = 'Private shelf/Sealed title.md';
const sharedText = '# Shared fixture\nNORTH_SHAREABLE_FIXTURE';
const privateText = '# Private fixture\nNORTH_LOCAL_SHELF';
const savedPath = 'Shared/Fixture note (2).md';
const savedText = '# Append-only fixture\nSYNTHETIC_NEW_NOTE';
const diaryDate = '2024-02-02';
const diaryText = 'SYNTHETIC_DIARY_BODY';
const fixtureKeyPrefix = 'SYNTHETIC_VAULT_WRAP:';

async function seedDiary(profile: string): Promise<string> {
  const key = Buffer.alloc(32, 21);
  const vault = { getVaultKey: async () => key };
  for (const keyFolder of ['vault', 'qq-channel-vault']) {
    await mkdir(join(profile, keyFolder), { recursive: true, mode: 0o700 });
    await writeFile(join(profile, keyFolder, 'vault-key.safe'), fixtureKeyPrefix + key.toString('base64'), { mode: 0o600 });
  }
  const repository = new DomainRepository(join(profile, 'profile.enc.json'), vault);
  await repository.initialize();
  const sessionId = randomUUID(), createdAt = diaryDate + 'T12:00:00.000Z';
  await repository.transaction(state => {
    state.chatSessions.push({ id: sessionId, title: 'Synthetic diary source', kind: 'normal', companionScope: 'owner', createdAt, updatedAt: createdAt });
    state.chatMessages.push({ id: randomUUID(), sessionId, role: 'user', content: 'Synthetic source for the diary.', status: 'complete',
      errorCode: null, createdAt, contextTrace: { version: 1, lineage: 'complete', memoryReferences: [], historyMessageIds: [],
        scope: { kind: 'global' }, privacy: 'cloud-allowed' } });
  });
  const journal = new CompanionJournal(join(profile, 'diary.enc.json'), vault);
  await journal.initialize();
  await journal.configure({ ...journal.preferences(), diaryEnabled: true });
  await journal.tick({ now: Date.parse('2024-02-03T03:01:00Z'), timezone: 'UTC', available: () => true,
    state: () => repository.snapshot(), suppressed: () => false,
    complete: async () => ({ text: diaryText, summary: 'A synthetic summary.' }) });
  expect(journal.list().map(({ date }) => date)).toEqual([diaryDate]);
  await journal.configure({ ...journal.preferences(), diaryEnabled: false });
  await journal.shutdown();
  return sessionId;
}
const prompts = {
  unshared: 'VAULT_UNSHARED: Search the vault for the north fixture.',
  search: 'VAULT_SEARCH: Search the vault for the north fixture and cite a source.',
  save: 'VAULT_SAVE: Please save the fixture Markdown to my notes.',
  detached: 'VAULT_DETACHED: Are there any notes tools available?',
};
const finals = {
  unshared: 'No shared note matched.',
  search: 'The shared fixture matched. （出自《Fixture note》）',
  save: 'Saved Shared/Fixture note (2).md.',
  detached: 'The vault tools are unavailable.',
};
const toolDescriptions = {
  search: 'Search the owner’s linked notes',
  read: 'Read one Markdown note',
  save: 'Create a new Markdown note',
};
const toolName = (body: RequestBody, tool: keyof typeof toolDescriptions): string | undefined =>
  body.tools?.find(item => item.function.description.includes(toolDescriptions[tool]))?.function.name;
const toolResult = <T,>(body: RequestBody, callId: string): T | undefined => {
  const message = body.messages?.find(item => item.role === 'tool' && item.tool_call_id === callId);
  return message ? JSON.parse(message.content) as T : undefined;
};
const respond = (res: ServerResponse, delta: object, reason: 'stop' | 'tool_calls'): void => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`);
};

// eslint-disable-next-line no-empty-pattern
test('vault indexing, file creation and cloud folder privacy use only synthetic loopback inference', async ({}) => {
  test.setTimeout(90_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deskpet-vault-e2e-'))),
    vault = join(root, 'fixture-notes');
  await mkdir(vault);
  await mkdir(join(vault, '.obsidian'));
  await mkdir(join(vault, 'Shared'));
  await mkdir(join(vault, 'Private shelf'));
  await writeFile(join(root, 'isolated-candidate.json'), JSON.stringify({ version: 1, purpose: 'deskpet-isolated-candidate' }));
  await writeFile(join(vault, 'Map.md'), '# North\nNORTH_PRIVATE_FIXTURE_A');
  await writeFile(join(vault, 'Old.md'), 'Unrelated note');
  await writeFile(join(vault, '.obsidian', 'hidden.md'), 'NEVER_INCLUDE_HIDDEN');
  const diarySource = await seedDiary(join(root, 'profile'));
  const wires: Wire[] = [];
  let hold = false,
    pending: ServerResponse | undefined;
  const answer = (res: ServerResponse): void => respond(res, { content: 'The note says Hall 7 [1].' }, 'stop');
  const fixtureErrors: string[] = [];
  const cloudAnswer = (body: RequestBody, res: ServerResponse): void => {
    const call = (tool: keyof typeof toolDescriptions, id: string, input: object): void => {
      const name = toolName(body, tool);
      if (!name) throw new Error(`Missing declared notes.${tool}`);
      respond(res, { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] }, 'tool_calls');
    };
    const prompt = body.messages?.filter(item => item.role === 'user').at(-1)?.content;
    if (prompt === prompts.unshared) {
      const result = toolResult<{ hits: unknown[] }>(body, 'vault-unshared-search');
      if (!result) return call('search', 'vault-unshared-search', { query: 'NORTH' });
      expect(result).toMatchObject({ hits: [], privacy: 'cloud-allowed' });
      return respond(res, { content: finals.unshared }, 'stop');
    }
    if (prompt === prompts.search) {
      const result = toolResult<{ hits: Array<{ path: string }> }>(body, 'vault-shared-search');
      if (!result) return call('search', 'vault-shared-search', { query: 'NORTH' });
      expect(result.hits.map(hit => hit.path)).toEqual([sharedPath]);
      expect(result).toMatchObject({ privacy: 'cloud-allowed', hits: [{ excerpt: sharedText }] });
      const detail = toolResult<{ text: string }>(body, 'vault-shared-read');
      if (!detail) return call('read', 'vault-shared-read', { path: result.hits[0]!.path });
      expect(detail).toMatchObject({ text: sharedText, path: sharedPath, privacy: 'cloud-allowed' });
      return respond(res, { content: finals.search }, 'stop');
    }
    if (prompt === prompts.save) {
      const result = toolResult<{ saved: boolean; path?: string }>(body, 'vault-shared-save');
      if (!result) return call('save', 'vault-shared-save', { title: 'Fixture note', folder: 'Shared', markdown: savedText });
      expect(result).toMatchObject({ saved: true, path: savedPath, privacy: 'cloud-allowed' });
      return respond(res, { content: finals.save }, 'stop');
    }
    if (prompt === prompts.detached) {
      for (const tool of ['search', 'read', 'save'] as const) expect(toolName(body, tool)).toBeUndefined();
      return respond(res, { content: finals.detached }, 'stop');
    }
    throw new Error('Unexpected synthetic cloud prompt');
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as RequestBody,
      path = req.url ?? '';
    wires.push({ path, body });
    const json = (value: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (path === '/api/ps') {
      json({ models: [] });
      return;
    }
    if (path === '/api/show') {
      if (body.model === 'cloud-alias') {
        json({ remote_host: 'https://fixture.invalid', remote_model: 'cloud', details: { format: 'gguf' } });
        return;
      }
      if (body.model === 'unknown-alias') {
        json({});
        return;
      }
      json({
        details: { format: 'gguf' },
        capabilities: [['bge-m3', 'nomic-embed-text', 'qwen3-embedding:0.6b'].includes(body.model ?? '') ? 'embedding' : 'completion'],
        model_info: { 'general.architecture': 'llama', 'llama.context_length': 16384 },
      });
      return;
    }
    if (path === '/api/embed') {
      json({
        embeddings: (body.input ?? []).map((t) => {
          const v = Array<number>(768).fill(0);
          v[t.includes('NORTH') ? 0 : t.includes('SOUTH') ? 1 : 2] = 1;
          return v;
        }),
      });
      return;
    }
    if (path === '/v1/models') {
      json({ data: [{ id: 'local-gguf' }, { id: 'cloud-alias' }, { id: 'unknown-alias' }] });
      return;
    }
    if (path === '/v1/chat/completions') {
      if (body.model === 'cloud-alias') {
        try { cloudAnswer(body, res); }
        catch (error) {
          fixtureErrors.push(error instanceof Error ? error.message : 'Unexpected fixture error');
          res.writeHead(500).end();
        }
      } else if (hold) pending = res;
      else answer(res);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const origin = 'http://127.0.0.1:' + address.port,
    entry = join(root, 'boot.cjs');
  await writeFile(
    entry,
    [
      "const {dialog,net,safeStorage}=require('electron');dialog.showMessageBox=async(...args)=>({response:args.at(-1)?.type==='question'?1:0,checkboxChecked:false});",
      'const fixtureKeyPrefix=' + JSON.stringify(fixtureKeyPrefix) + ';',
      "safeStorage.isEncryptionAvailable=()=>true;safeStorage.encryptString=value=>Buffer.from(fixtureKeyPrefix+value);safeStorage.decryptString=bytes=>{const value=bytes.toString();if(!value.startsWith(fixtureKeyPrefix))throw Error('Wrong fixture wrapper');return value.slice(fixtureKeyPrefix.length);};",
      'dialog.showOpenDialog=async()=>({canceled:false,filePaths:[' + JSON.stringify(vault) + ']});',
      'const base=' + JSON.stringify(origin) + ';',
      "const rewrite=input=>{const u=new URL(input);if(u.origin==='http://127.0.0.1:11434'&&['/api/ps','/api/show','/api/embed'].includes(u.pathname))return base+u.pathname;if(u.origin===base||u.protocol==='file:')return u.href;throw Error('Unexpected fixture destination');};",
      'const http=global.fetch,chromium=net.fetch.bind(net);global.fetch=(u,i)=>http(rewrite(u),i);net.fetch=(u,i)=>chromium(rewrite(u),i);',
      'require(' + JSON.stringify(join(process.cwd(), '.webpack', process.arch, 'main/index.js')) + ');',
    ].join('\n'),
  );
  let app: ElectronApplication | undefined;
  try {
    const env: Record<string, string> = {};
    for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY']) if (process.env[k]) env[k] = process.env[k]!;
    app = await electron.launch({ args: [entry, '--deskpet-isolated-profile=' + root], env });
    await expect.poll(() => app!.windows().some((w) => w.url().includes('/main_window/'))).toBe(true);
    const page = app.windows().find((w) => w.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(join(root, 'profile'));
    const add = (model: string) =>
      page.evaluate(
        async ({ baseUrl, model }) =>
          window.deskpet.providers.upsert({
            id: crypto.randomUUID(),
            kind: 'ollama',
            name: model,
            baseUrl,
            model,
            enabled: true,
            supportsTools: model === 'cloud-alias',
            localExecutionConfirmed: true,
            contextWindowTokens: 16384,
            maxOutputTokens: 4096,
          }),
        { baseUrl: origin + '/v1', model },
      );
    const local = await add('local-gguf'),
      cloud = await add('cloud-alias'),
      unknown = await add('unknown-alias');
    await page.evaluate(() => window.deskpet.app.setLocale('en'));
    await page.locator('nav').getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByTestId('knowledge-settings');
    await page.getByRole('tab', { name: 'Notebook', exact:true }).click();
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: 'Choose vault' }).click();
    await expect(settings.getByText(/fixture-notes/)).toBeVisible();
    await settings.getByRole('button', { name: 'Update index' }).click();
    await expect(settings.getByText(/2 notes/)).toBeVisible();
    const ask = (provider: { id: string; model: string }, query = 'NORTH') =>
      page.evaluate((input) => window.deskpet.knowledge.ask(input), { providerId: provider.id, model: provider.model, query });
    await settings.getByRole('textbox', { name: 'Search note excerpts' }).fill('NORTH');
    await settings.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(settings.getByText('Map.md', { exact: true })).toBeVisible();
    await expect(settings.getByText('lines 1–2')).toBeVisible();
    await settings.getByRole('combobox', { name: 'Local model for answers' }).selectOption(local.id);
    await settings.getByRole('button', { name: 'Ask local model' }).click();
    await expect(settings.getByText('The note says Hall 7 [1].')).toBeVisible();
    const chatWires = () => wires.filter((w) => w.path === '/v1/chat/completions');
    expect(chatWires()).toHaveLength(1);
    const body = chatWires()[0]!.body;
    expect(body.model).toBe('local-gguf');
    expect(body.tools).toBeUndefined();
    const payload = JSON.parse(body.messages!.at(-1)!.content);
    expect(payload).toMatchObject({
      question: 'NORTH',
      excerpts: [{ number: 1, path: 'Map.md', lines: [1, 2], text: '# North\nNORTH_PRIVATE_FIXTURE_A' }],
    });
    for (const denied of [cloud, unknown]) await expect(ask(denied)).rejects.toThrow();
    expect(chatWires()).toHaveLength(1);
    // The provider has received the verified old source. Editing it now must prevent showing a stale answer.
    hold = true;
    const stale = ask(local).then(
      () => true,
      () => false,
    );
    await expect.poll(() => !!pending).toBe(true);
    await writeFile(join(vault, 'Map.md'), 'SOUTH_PRIVATE_FIXTURE_B');
    answer(pending!);
    pending = undefined;
    hold = false;
    expect(await stale).toBe(false);
    await rm(join(vault, 'Old.md'));
    await writeFile(join(vault, 'New.md'), 'SOUTH second note');
    const after = await page.evaluate(() => window.deskpet.knowledge.reindex());
    expect(after).toMatchObject({ indexedNotes: 2, changedNotes: 2, removedNotes: 1, lastError: null });
    const search = (query: string) => page.evaluate((q) => window.deskpet.knowledge.search(q), query);
    expect(await search('NORTH')).toEqual([]);
    expect((await search('SOUTH')).map((r) => r.path).sort()).toEqual(['Map.md', 'New.md']);
    expect(JSON.stringify(wires)).not.toContain('NEVER_INCLUDE_HIDDEN');

    await writeFile(join(vault, sharedPath), sharedText);
    await writeFile(join(vault, privatePath), privateText);
    expect(await page.evaluate(() => window.deskpet.knowledge.reindex())).toMatchObject({ indexedNotes: 4, lastError: null });
    expect((await search('NORTH')).map(hit => hit.path).sort()).toEqual([privatePath, sharedPath].sort());
    const localFolder = settings.getByRole('switch', { name: 'Allow Private shelf to leave this computer' });
    const sharedFolder = settings.getByRole('switch', { name: 'Allow Shared to leave this computer' });
    await expect(localFolder).not.toBeChecked();
    await expect(sharedFolder).not.toBeChecked();

    const nav = page.locator('nav');
    const openSettings = async (): Promise<void> => {
      await nav.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('tab', { name: 'Notebook', exact: true }).click();
      await expect(settings).toBeVisible();
    };
    await page.evaluate(async id => {
      await window.deskpet.providers.select(id);
      await window.deskpet.permissions.request({ capabilityId: 'notes.read', duration: 'session' });
    }, cloud.id);
    const send = async (prompt: string): Promise<void> => {
      await nav.getByRole('button', { name: 'New conversation', exact: true }).click();
      await page.locator('.composer textarea').fill(prompt);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
    };
    const expectAnswer = async (text: string): Promise<void> => {
      const reply = page.locator('.message.assistant').last();
      await expect(reply).toHaveAttribute('data-status', 'complete');
      await expect(reply).toContainText(text);
    };

    await send(prompts.unshared);
    await expectAnswer(finals.unshared);
    await openSettings();
    await sharedFolder.click();
    await expect(sharedFolder).toBeChecked();
    await expect(localFolder).not.toBeChecked();
    const writable = settings.getByRole('switch', { name: 'Can create notes in Shared' });
    await writable.click();
    await expect(writable).toBeChecked();

    await send(prompts.search);
    await expectAnswer(finals.search);
    // A standing permission must not skip this task's write approval.
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    const standing = await page.evaluate(() => window.deskpet.permissions.request({ capabilityId: 'notes.write', duration: 'session' }));
    expect(standing).toMatchObject({ capabilityId: 'notes.write', state: 'session' });
    await send(prompts.save);
    const approval = page.getByRole('region', { name: 'This step needs your approval', exact: true });
    await expect(approval).toBeVisible();
    await expect(readFile(join(vault, savedPath), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await approval.getByRole('button', { name: 'Allow for this task', exact: true }).click();
    await expectAnswer(finals.save);
    expect(await readFile(join(vault, sharedPath), 'utf8')).toBe(sharedText);
    expect(await readFile(join(vault, savedPath), 'utf8')).toMatch(
      /^---\ncreated: [^\n]+\nsource: desktop\nby: deskpet\n---\n(?:\n)?# Append-only fixture\nSYNTHETIC_NEW_NOTE\n?$/u,
    );
    await expect.poll(async () => (await search('SYNTHETIC_NEW_NOTE')).map(hit => hit.path)).toContain(savedPath);

    await openSettings();
    const diarySync = settings.getByRole('switch', { name: 'Sync her diary' });
    await expect(diarySync).not.toBeChecked();
    const diaryPath = join(vault, '日记', diaryDate + '.md');
    await expect(readFile(diaryPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await diarySync.click();
    await expect(diarySync).toBeChecked();
    await expect.poll(() => readFile(diaryPath, 'utf8').catch(() => '')).toMatch(
      /^---\ncreated: 2024-02-03T03:01:00\.000Z\nby: deskpet\nkind: diary\n---\n\nSYNTHETIC_DIARY_BODY\n?$/u,
    );
    const shareDiary = settings.getByRole('switch', { name: 'Allow 日记 to leave this computer' });
    await expect(shareDiary).toBeDisabled();
    await expect(shareDiary).not.toBeChecked();
    await diarySync.click();
    await expect(diarySync).not.toBeChecked();
    await expect(shareDiary).toBeDisabled();
    expect(await readFile(diaryPath, 'utf8')).toContain(diaryText);
    await page.evaluate(id => window.deskpet.chat.setArchived(id, true), diarySource);
    await expect.poll(() => readFile(diaryPath, 'utf8').then(() => 'exists', (error: NodeJS.ErrnoException) => error.code)).toBe('ENOENT');
    const health = await page.evaluate(() => window.deskpet.attention.health!());
    expect(JSON.stringify(health)).not.toContain(diaryDate);
    expect(JSON.stringify(health)).not.toContain(diaryText);

    await settings.getByRole('button', { name: 'Disconnect and remove index' }).click();
    await expect(settings.getByText('No vault selected')).toBeVisible();
    await expect(search('SOUTH')).rejects.toThrow();
    await send(prompts.detached);
    await expectAnswer(finals.detached);
    const cloudWires = chatWires().filter(wire => wire.body.model === 'cloud-alias');
    expect(cloudWires.length).toBeGreaterThanOrEqual(8);
    expect(JSON.stringify(cloudWires)).not.toContain(diaryText);
    expect(JSON.stringify(cloudWires)).toContain(sharedPath);
    for (const blocked of [privatePath, 'NORTH_LOCAL_SHELF', 'Map.md', 'NORTH_PRIVATE_FIXTURE_A', 'SOUTH_PRIVATE_FIXTURE_B', 'NEVER_INCLUDE_HIDDEN']) {
      expect(JSON.stringify(cloudWires)).not.toContain(blocked);
    }
    expect(fixtureErrors).toEqual([]);
  } finally {
    await app?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
