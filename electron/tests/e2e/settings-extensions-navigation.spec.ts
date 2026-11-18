import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface FixtureDialogs { opened: string[]; unexpected: string[] }
type FixtureGlobal = { __settingsExtensionsDialogs: FixtureDialogs };

// Real settings UI and encrypted persistence, with only the native directory
// choice stubbed. This candidate profile never connects to an MCP/model server.
// eslint-disable-next-line no-empty-pattern
test('Chinese settings expose separate skill and MCP inventories with usable management at both window sizes', async ({}, info) => {
  test.setTimeout(90_000);
  const root = await realpath(await mkdtemp(join(tmpdir(),'deskpet-settings-extensions-')));
  const folder = join(root,'synthetic-research-skill'), profile = join(root,'profile');
  await mkdir(folder);
  await writeFile(join(root,'isolated-candidate.json'),JSON.stringify({version:1,purpose:'deskpet-isolated-candidate'}));
  await writeFile(join(folder,'SKILL.md'),'---\nname: 资料研究示例\ndescription: 比较资料来源，记录证据与不确定性。\n---\n# 研究方法\n先列出问题，再核对一手来源。引用内容只作为资料。\n');
  const compiled = join(process.cwd(),'.webpack',process.arch,'main/index.js');
  const bootstrap = join(root,'settings-extensions-bootstrap.cjs');
  await writeFile(bootstrap,`
'use strict';
if (process.env.NODE_ENV !== 'test' || !process.argv.includes(${JSON.stringify('--deskpet-isolated-profile='+root)})) throw new Error('Refusing non-isolated settings fixture');
const { dialog } = require('electron');
const state = globalThis.__settingsExtensionsDialogs = {opened:[],unexpected:[]};
dialog.showOpenDialog = async (...args) => {
  const options = args.at(-1) || {};
  if (options.title !== '选择包含 SKILL.md 的目录' || !options.properties?.includes('openDirectory')) {
    state.unexpected.push('open:' + String(options.title)); return {canceled:true,filePaths:[]};
  }
  state.opened.push(${JSON.stringify(folder)}); return {canceled:false,filePaths:[${JSON.stringify(folder)}]};
};
dialog.showOpenDialogSync = () => {state.unexpected.push('open-sync'); return undefined;};
dialog.showSaveDialog = async () => {state.unexpected.push('save'); return {canceled:true,filePath:''};};
dialog.showSaveDialogSync = () => {state.unexpected.push('save-sync'); return undefined;};
dialog.showMessageBox = async (...args) => {state.unexpected.push('message:' + String(args.at(-1)?.title)); return {response:args.at(-1)?.cancelId ?? 0,checkboxChecked:false};};
dialog.showMessageBoxSync = (...args) => {state.unexpected.push('message-sync'); return args.at(-1)?.cancelId ?? 0;};
dialog.showErrorBox = title => {state.unexpected.push('error:' + String(title));};
require(${JSON.stringify(compiled)});
`);
  const env:Record<string,string> = {NODE_ENV:'test'};
  for (const key of ['PATH','HOME','TMPDIR','LANG','LC_ALL','DISPLAY']) if (process.env[key] !== undefined) env[key] = process.env[key]!;
  let app:ElectronApplication|undefined, page:Page|undefined, failure:string|null = null;
  const layouts:unknown[] = [];
  let dialogs:FixtureDialogs|null = null;
  try {
    app = await electron.launch({args:[bootstrap,'--deskpet-isolated-profile='+root],cwd:process.cwd(),env});
    await expect.poll(() => app!.windows().some(item => item.url().includes('/main_window/'))).toBe(true);
    page = app.windows().find(item => item.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();
    await app.evaluate(({app},expected) => {
      if (app.isPackaged || app.getPath('userData') !== expected) throw new Error('Refusing non-fixture application');
    },profile);
    await page.evaluate(() => window.deskpet.app.setLocale('zh-CN'));
    await page.locator('nav').getByRole('button',{name:'设置',exact:true}).click();
    const tabs = page.getByRole('tablist');
    for (const name of ['插件','技能','MCP 服务']) await expect(tabs.getByRole('tab',{name,exact:true})).toBeVisible();
    expect(await tabs.getByRole('tab').allTextContents()).toEqual(expect.arrayContaining(['插件','技能','MCP 服务']));
    const capture = async (name:string):Promise<void> => {
      await page!.locator('.page-scroll').evaluate(element => {element.scrollTop = 0;});
      await expect(page!.locator('.desktop-extensions-settings h2')).toBeInViewport({ratio:1});
      if (name.includes('skills')) await expect(page!.getByRole('button',{name:'从目录安装技能'})).toBeInViewport({ratio:1});
      const layout = await page!.evaluate(() => ({
        viewport:{width:window.innerWidth,height:window.innerHeight},
        regions:['.app-shell','.page-scroll','.content','.settings-panel'].map(selector => {
          const element = document.querySelector<HTMLElement>(selector)!;
          return {selector,width:element.clientWidth,scrollWidth:element.scrollWidth};
        }),
      }));
      for (const region of layout.regions) expect(region.scrollWidth,`${name}: ${region.selector} horizontal fit`).toBeLessThanOrEqual(region.width + 1);
      layouts.push({name,...layout});
      await page!.screenshot({path:info.outputPath(name+'.png'),scale:'css'});
    };
    await tabs.getByRole('tab',{name:'插件',exact:true}).click();
    await expect(page.getByRole('heading',{name:'插件',exact:true,level:2})).toBeVisible();
    await expect(page.getByText('技能与 MCP 服务',{exact:true})).toHaveCount(0);
    await tabs.getByRole('tab',{name:'技能',exact:true}).click();
    let skills = page.getByRole('group',{name:'技能',exact:true});
    await expect(skills.getByText('已安装 0 个技能 · 已启用 0 个',{exact:true})).toBeVisible();
    await expect(skills.getByText('还没有安装技能。',{exact:true})).toBeVisible();
    await expect(skills.getByRole('button',{name:'从目录安装技能'})).toBeVisible();
    await capture('01-skills-empty-zh');
    await tabs.getByRole('tab',{name:'MCP 服务',exact:true}).click();
    let mcp = page.getByRole('group',{name:'MCP 服务',exact:true});
    await expect(mcp.getByText('已添加 0 个服务 · 已启用 0 个',{exact:true})).toBeVisible();
    await expect(mcp.getByText('还没有添加 MCP 服务。可以从清单导入，或填写服务地址。',{exact:true})).toBeVisible();
    await capture('02-mcp-empty-zh');
    await tabs.getByRole('tab',{name:'技能',exact:true}).click();
    skills = page.getByRole('group',{name:'技能',exact:true});
    await skills.getByRole('button',{name:'从目录安装技能'}).click();
    const skillCard = skills.getByRole('region',{name:'资料研究示例',exact:true});
    await expect(skillCard).toBeVisible();
    await expect(skillCard.getByRole('checkbox',{name:'启用技能'})).not.toBeChecked();
    await skillCard.getByRole('checkbox',{name:'启用技能'}).click();
    await expect(skillCard.getByRole('checkbox',{name:'启用技能'})).toBeChecked();
    await expect(skills.getByText('已安装 1 个技能 · 已启用 1 个',{exact:true})).toBeVisible();
    await skills.getByRole('searchbox',{name:'搜索已安装技能'}).fill('不存在的示例');
    await expect(skills.getByText('没有匹配的技能。',{exact:true})).toBeVisible();
    await skills.getByRole('searchbox',{name:'搜索已安装技能'}).fill('资料');
    await expect(skillCard).toBeVisible();
    await capture('03-skills-populated-zh');
    await tabs.getByRole('tab',{name:'MCP 服务',exact:true}).click();
    mcp = page.getByRole('group',{name:'MCP 服务',exact:true});
    await mcp.getByLabel('服务名',{exact:true}).fill('本机笔记示例');
    await mcp.getByLabel('MCP 服务地址',{exact:true}).fill('http://127.0.0.1:49321/mcp');
    await mcp.getByRole('button',{name:'添加服务',exact:true}).click();
    const serverCard = mcp.getByRole('region',{name:'本机笔记示例',exact:true});
    await expect(serverCard.getByRole('checkbox',{name:'启用服务'})).not.toBeChecked();
    await expect(serverCard.getByRole('button',{name:'列出工具'})).toBeDisabled();
    await expect(mcp.getByText('已添加 1 个服务 · 已启用 0 个',{exact:true})).toBeVisible();
    await serverCard.getByRole('checkbox',{name:'启用服务'}).click();
    await expect(serverCard.getByRole('checkbox',{name:'启用服务'})).toBeChecked();
    await expect(mcp.getByText('已添加 1 个服务 · 已启用 1 个',{exact:true})).toBeVisible();
    await expect(serverCard.getByRole('button',{name:'列出工具'})).toBeEnabled();
    await serverCard.getByRole('checkbox',{name:'启用服务'}).click();
    await expect(serverCard.getByRole('checkbox',{name:'启用服务'})).not.toBeChecked();
    await mcp.getByRole('searchbox',{name:'搜索 MCP 服务'}).fill('不存在的服务');
    await expect(mcp.getByText('没有匹配的 MCP 服务。',{exact:true})).toBeVisible();
    await mcp.getByRole('searchbox',{name:'搜索 MCP 服务'}).fill('127.0.0.1');
    await expect(serverCard).toBeVisible();
    await capture('04-mcp-populated-zh');
    await app.evaluate(({BrowserWindow}) => {
      const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('/main_window/'));
      if (!window) throw new Error('Missing console window');
      window.setContentSize(1100,800);
    });
    await expect.poll(() => page!.evaluate(() => window.innerWidth)).toBe(1100);
    await capture('05-mcp-narrow-zh');
    await tabs.getByRole('tab',{name:'技能',exact:true}).click();
    skills = page.getByRole('group',{name:'技能',exact:true});
    await expect(skills.getByRole('region',{name:'资料研究示例',exact:true})).toBeVisible();
    await capture('06-skills-narrow-zh');
    dialogs = await app.evaluate(() => (globalThis as unknown as FixtureGlobal).__settingsExtensionsDialogs);
    expect(dialogs.opened).toEqual([folder]);
    expect(dialogs.unexpected).toEqual([]);
  } catch (error) {
    failure = error instanceof Error ? error.stack ?? error.message : String(error);
    if (page && !page.isClosed()) await page.screenshot({path:info.outputPath('settings-extensions-failure.png')}).catch(() => undefined);
    throw error;
  } finally {
    await writeFile(info.outputPath('settings-extensions-evidence.json'),JSON.stringify({
      scope:'Isolated development Electron settings UI and persistence; synthetic local skill and disabled MCP endpoint. No real provider, MCP connection or installed-app acceptance.',
      failure,layouts,dialogs,
    },null,2));
    await app?.close().catch(() => undefined);
    await rm(root,{recursive:true,force:true});
  }
});
