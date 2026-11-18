import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DesktopExtensionsState } from '../../src/shared/desktop-extensions';

type FixtureGlobal = { __recommendedExtensionDialogs: string[] };
const skillNames = ['中英写作与文档共创','资料归纳与证据检查','IB Economics 双语讲解与答题自检','项目复盘与发布检查'];
const serverNames = ['DeepWiki','Microsoft Learn','Playwright','GitHub'];

// Real recommendation installation, encrypted storage, management UI and restart
// persistence in an isolated profile. No tool is listed or called, and the token
// is a synthetic fixture that is never sent to a service.
// eslint-disable-next-line no-empty-pattern
test('installs the four recommended skills and MCP servers idempotently, preserves manual entries and stores only private GitHub authentication', async ({}, info) => {
  test.setTimeout(90_000);
  const root = await realpath(await mkdtemp(join(tmpdir(),'deskpet-recommended-extensions-')));
  const profile = join(root,'profile');
  await writeFile(join(root,'isolated-candidate.json'),JSON.stringify({version:1,purpose:'deskpet-isolated-candidate'}));
  const compiled = join(process.cwd(),'.webpack',process.arch,'main/index.js');
  const bootstrap = join(root,'recommended-extensions-bootstrap.cjs');
  await writeFile(bootstrap,`
'use strict';
if (process.env.NODE_ENV !== 'test' || !process.argv.includes(${JSON.stringify('--deskpet-isolated-profile='+root)})) throw new Error('Refusing non-isolated recommendation fixture');
const { dialog, app } = require('electron');
app.setAppPath(${JSON.stringify(process.cwd())});
const unexpected = globalThis.__recommendedExtensionDialogs = [];
dialog.showOpenDialog = async (...args) => {unexpected.push('open:' + String(args.at(-1)?.title)); return {canceled:true,filePaths:[]};};
dialog.showOpenDialogSync = () => {unexpected.push('open-sync'); return undefined;};
dialog.showSaveDialog = async (...args) => {unexpected.push('save:' + String(args.at(-1)?.title)); return {canceled:true,filePath:''};};
dialog.showSaveDialogSync = () => {unexpected.push('save-sync'); return undefined;};
dialog.showMessageBox = async (...args) => {unexpected.push('message:' + String(args.at(-1)?.title)); return {response:args.at(-1)?.cancelId ?? 0,checkboxChecked:false};};
dialog.showMessageBoxSync = (...args) => {unexpected.push('message-sync'); return args.at(-1)?.cancelId ?? 0;};
dialog.showErrorBox = title => {unexpected.push('error:' + String(title));};
require(${JSON.stringify(compiled)});
`);
  const env:Record<string,string> = {NODE_ENV:'test'};
  for (const key of ['PATH','HOME','TMPDIR','LANG','LC_ALL','DISPLAY']) if (process.env[key] !== undefined) env[key] = process.env[key]!;
  let app:ElectronApplication|undefined, page:Page|undefined;
  let failure:string|null = null, finalState:DesktopExtensionsState|null = null;
  let encryptedSecretFileCount = 0;
  const dialogs:string[][] = [], screenshots:string[] = [];
  const syntheticToken = 'fixture_' + randomUUID().replaceAll('-','');
  const launch = async ():Promise<void> => {
    app = await electron.launch({args:[bootstrap,'--deskpet-isolated-profile='+root],cwd:process.cwd(),env});
    await expect.poll(() => app!.windows().some(item => item.url().includes('/main_window/'))).toBe(true);
    page = app.windows().find(item => item.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    await app.evaluate(({app},expected) => {
      if (app.isPackaged || app.getPath('userData') !== expected) throw new Error('Refusing non-fixture application');
    },profile);
  };
  const state = ():Promise<DesktopExtensionsState> => page!.evaluate(() => window.deskpet.plugins.extensions.state());
  const openTab = async (name:'技能'|'MCP 服务'):Promise<void> => {
    await page!.getByRole('tab',{name,exact:true}).click();
    await expect(page!.getByRole('group',{name,exact:true})).toBeVisible();
  };
  const capture = async (filename:string):Promise<void> => {
    await page!.locator('.page-scroll').evaluate(element => {element.scrollTop = 0;});
    await expect(page!.locator('.desktop-extensions-settings h2')).toBeInViewport({ratio:1});
    await page!.screenshot({path:info.outputPath(filename),scale:'css'});
    screenshots.push(filename);
  };
  const assertRecommended = (snapshot:DesktopExtensionsState):void => {
    expect(snapshot.skills).toHaveLength(4);
    expect(snapshot.skills.map(skill => skill.name).sort()).toEqual([...skillNames].sort());
    expect(snapshot.skills.every(skill => skill.enabled && !!skill.catalogId)).toBe(true);
    const recommended = snapshot.servers.filter(server => !!server.preset);
    expect(recommended).toHaveLength(4);
    expect(recommended.map(server => server.name).sort()).toEqual([...serverNames].sort());
    expect(recommended.every(server => server.enabled)).toBe(true);
    expect(snapshot.servers.filter(server => server.enabled)).toHaveLength(4);
    expect(snapshot.servers.find(server => server.preset === 'github')).toMatchObject({endpoint:'https://api.githubcopilot.com/mcp/readonly'});
  };
  try {
    await launch();
    await page!.evaluate(() => window.deskpet.app.setLocale('zh-CN'));
    await page!.locator('nav').getByRole('button',{name:'设置',exact:true}).click();
    await openTab('MCP 服务');
    let mcp = page!.getByRole('group',{name:'MCP 服务',exact:true});
    await mcp.getByLabel('服务名',{exact:true}).fill('保留的本机服务');
    await mcp.getByLabel('MCP 服务地址',{exact:true}).fill('http://127.0.0.1:49322/mcp');
    await mcp.getByRole('button',{name:'添加服务',exact:true}).click();
    await expect(mcp.getByRole('region',{name:'保留的本机服务',exact:true})).toBeVisible();
    const manual = (await state()).servers.find(server => server.name === '保留的本机服务')!;
    expect(manual).toMatchObject({endpoint:'http://127.0.0.1:49322/mcp',enabled:false});

    await openTab('技能');
    let skills = page!.getByRole('group',{name:'技能',exact:true});
    await skills.getByText('四个推荐技能',{exact:true}).click();
    const installSkills = skills.getByRole('button',{name:'添加并启用推荐技能',exact:true});
    await installSkills.click();
    await expect(skills.getByText('已安装 4 个技能 · 已启用 4 个',{exact:true})).toBeVisible();
    const installedSkills = (await state()).skills;
    expect(installedSkills.map(skill => skill.name).sort()).toEqual([...skillNames].sort());
    for (const name of skillNames) await expect(skills.getByRole('region',{name,exact:true}).getByRole('checkbox',{name:'启用技能'})).toBeChecked();
    await installSkills.click();
    await expect(skills.getByText('所选技能已添加并启用。',{exact:true})).toBeVisible();
    expect((await state()).skills).toEqual(installedSkills);
    await skills.getByText('四个推荐技能',{exact:true}).click();
    const writing = skills.getByRole('region',{name:'中英写作与文档共创',exact:true});
    await writing.getByRole('button',{name:'查看技能',exact:true}).click();
    await expect(skills.locator('pre.extension-preview')).toContainText('name: bilingual-writing');
    await expect(skills.locator('pre.extension-preview')).toContainText('中英写作与文档共创');
    await writing.getByRole('button',{name:'从原目录更新',exact:true}).click();
    await expect(skills.getByText('技能内容未变化。',{exact:true})).toBeVisible();
    expect((await state()).skills).toEqual(installedSkills);
    await capture('01-recommended-skills-zh.png');

    await openTab('MCP 服务');
    mcp = page!.getByRole('group',{name:'MCP 服务',exact:true});
    await mcp.getByText('四个推荐 MCP 服务',{exact:true}).click();
    const installServers = mcp.getByRole('button',{name:'添加并启用推荐服务',exact:true});
    await installServers.click();
    await expect(mcp.getByText('已添加 5 个服务 · 已启用 4 个',{exact:true})).toBeVisible();
    let snapshot = await state();
    assertRecommended(snapshot);
    expect(snapshot.servers.find(server => server.id === manual.id)).toEqual(manual);
    await installServers.click();
    await expect(mcp.getByText('所选服务已添加并启用。GitHub 需要保存令牌；Playwright 在使用时启动。',{exact:true})).toBeVisible();
    expect(await state()).toEqual(snapshot);
    await mcp.getByText('四个推荐 MCP 服务',{exact:true}).click();
    await capture('02-recommended-mcp-zh.png');

    await mcp.getByRole('searchbox',{name:'搜索 MCP 服务',exact:true}).fill('GitHub');
    const github = mcp.getByRole('region',{name:'GitHub',exact:true});
    await expect(github).toContainText('https://api.githubcopilot.com/mcp/readonly');
    await expect(github).toContainText('只读模式 · 待配置令牌');
    expect(snapshot.servers.find(server => server.preset === 'github')?.authConfigured).not.toBe(true);
    await github.getByText('认证设置',{exact:true}).click();
    await github.getByLabel('访问令牌',{exact:true}).fill(syntheticToken);
    await github.getByRole('button',{name:'保存令牌',exact:true}).click();
    await expect(github.getByLabel('访问令牌',{exact:true})).toHaveValue('');
    await expect(github).toContainText('只读模式 · 认证已配置');
    snapshot = await state();
    assertRecommended(snapshot);
    expect(snapshot.servers.find(server => server.preset === 'github')?.authConfigured).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain(syntheticToken);
    expect(await page!.locator('body').innerText()).not.toContain(syntheticToken);
    const secretFiles = await readdir(join(profile,'mcp-auth-vault','provider-secrets'));
    encryptedSecretFileCount = secretFiles.length;
    expect(encryptedSecretFileCount).toBe(1);
    for (const file of secretFiles) expect((await readFile(join(profile,'mcp-auth-vault','provider-secrets',file))).includes(Buffer.from(syntheticToken))).toBe(false);
    await capture('03-github-authentication-zh.png');
    dialogs.push(await app!.evaluate(() => (globalThis as unknown as FixtureGlobal).__recommendedExtensionDialogs));
    expect(dialogs.at(-1)).toEqual([]);
    await app!.close(); app = undefined; page = undefined;

    await launch();
    await page!.locator('nav').getByRole('button',{name:'设置',exact:true}).click();
    await openTab('MCP 服务');
    mcp = page!.getByRole('group',{name:'MCP 服务',exact:true});
    await expect(mcp.getByText('已添加 5 个服务 · 已启用 4 个',{exact:true})).toBeVisible();
    finalState = await state();
    assertRecommended(finalState);
    expect(finalState).toEqual(snapshot);
    expect(finalState.servers.find(server => server.id === manual.id)).toEqual(manual);
    expect(JSON.stringify(finalState)).not.toContain(syntheticToken);
    dialogs.push(await app!.evaluate(() => (globalThis as unknown as FixtureGlobal).__recommendedExtensionDialogs));
    expect(dialogs.at(-1)).toEqual([]);
  } catch (error) {
    failure = error instanceof Error ? error.stack ?? error.message : String(error);
    if (page && !page.isClosed()) await page.screenshot({path:info.outputPath('recommended-extensions-failure.png')}).catch(() => undefined);
    throw error;
  } finally {
    await writeFile(info.outputPath('recommended-extensions-evidence.json'),JSON.stringify({
      scope:'Isolated development Electron UI, recommended extension installation and encrypted persistence. Four bundled skills, four MCP presets and one preserved manual disabled endpoint. Synthetic GitHub token only; no MCP tool listing/call, provider invocation, external authentication or installed-app acceptance.',
      failure,finalState,encryptedSecretFileCount,dialogs,screenshots,
    },null,2));
    await app?.close().catch(() => undefined);
    await rm(root,{recursive:true,force:true});
  }
});
