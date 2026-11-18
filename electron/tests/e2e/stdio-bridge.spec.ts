import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

interface Review { allowNext: boolean; prompts: string[] }
type BridgeTestGlobal = { __bridgeReview: Review };

// eslint-disable-next-line no-empty-pattern
test('imports a private live stdio bridge offline, masks its path, and requires desktop approval per tool call',async ({})=>{
  test.skip(process.platform!=='darwin','Restricted local stdio uses the macOS sandbox.');
  test.setTimeout(90_000);
  const root=await realpath(await mkdtemp(join(tmpdir(),'deskpet-bridge-ui-e2e-')));
  const source=join(root,'reviewed-node-service');await mkdir(source);
  await writeFile(join(root,'isolated-candidate.json'),JSON.stringify({version:1,purpose:'deskpet-isolated-candidate'}));
  await writeFile(join(source,'package.json'),JSON.stringify({name:'reviewed-stdio-fixture'}));
  await writeFile(join(source,'server.cjs'),[
    "const rl=require('node:readline').createInterface({input:process.stdin});",
    "rl.on('line', line=>{const r=JSON.parse(line);if(r.id===undefined)return;",
    "const result=r.method==='initialize'?{protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:",
    "r.method==='tools/list'?{tools:[{name:'probe',description:'Return a synthetic reply.',inputSchema:{type:'object'}}]}:",
    "{content:[{type:'text',text:'STDIO_SANDBOX_REPLY'}]};",
    "process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');});"
  ].join('\n'));
  const env: Record<string,string>={};
  for(const key of ['PATH','HOME','TMPDIR','LANG','LC_ALL','DISPLAY'])if(process.env[key])env[key]=process.env[key]!;
  const child=spawn(process.execPath,[join(process.cwd(),'scripts/mcp-stdio-bridge.mjs'),source,'server.cjs'],{env,stdio:['ignore','pipe','ignore']});
  const exited=once(child,'exit');
  const lines=createInterface({input:child.stdout});
  let app:ElectronApplication|undefined;
  try {
    const manifest=await Promise.race([
      once(lines,'line').then(([line])=>String(line)),
      exited.then(()=>{throw new Error('Restricted bridge did not start.');}),
    ]);
    expect(manifest.endsWith('/bridge.json')).toBe(true);
    app=await electron.launch({args:[join(process.cwd(),'.webpack',process.arch,'main/index.js'),'--deskpet-isolated-profile='+root],env});
    await app.evaluate(({dialog},file)=>{
      const review:Review={allowNext:false,prompts:[]};
      (globalThis as unknown as BridgeTestGlobal).__bridgeReview=review;
      dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});
      dialog.showMessageBox=async(...args:unknown[])=>{
        const o=args.at(-1) as Electron.MessageBoxOptions;
        if(o.title!=='Allow this MCP call?')return {response:o.cancelId??0,checkboxChecked:false};
        review.prompts.push(o.detail??'');const response=review.allowNext?1:0;review.allowNext=false;
        return {response,checkboxChecked:false};
      };
    },manifest);
    await expect.poll(()=>app!.windows().some(w=>w.url().includes('/main_window/'))).toBe(true);
    const page=app.windows().find(w=>w.url().includes('/main_window/'))!;
    await expect(page.locator('.app-shell')).toBeVisible();await page.evaluate(()=>window.deskpet.app.setLocale('en'));await page.reload();
    await page.locator('nav').getByRole('button',{name:'Settings',exact:true}).click();
    await page.getByRole('tab',{name:'MCP servers',exact:true}).click();
    const panel=page.getByRole('group',{name:'MCP servers',exact:true});
    await panel.getByRole('button',{name:'Import local restricted stdio bridge'}).click();
    const preview=panel.getByRole('region',{name:'Manifest preview'});await expect(preview).toBeVisible();
    await expect(preview.getByText('Private path hidden. Connection requires enabling the bridge.')).toBeVisible();
    await expect(preview.getByRole('button',{name:'Connect and preview tools'})).toHaveCount(0);
    await preview.getByRole('button',{name:'Import as disabled'}).click();
    await expect(panel.getByRole('button',{name:'List tools'})).toBeDisabled();
    const state=await page.evaluate(()=>window.deskpet.plugins.extensions.state());
    expect(state.servers[0]).toMatchObject({name:'reviewed-stdio-fixture',privateBridge:true,enabled:false});
    expect(state.servers[0]?.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/…$/u);
    const toggle=panel.getByLabel('Enable server');await toggle.click();await expect(toggle).toBeChecked();
    await panel.getByRole('button',{name:'List tools'}).click();await expect(panel.getByRole('combobox',{name:'Tool',exact:true})).toHaveValue('probe');
    await panel.getByRole('button',{name:'Review and call'}).click();
    await expect(panel.getByRole('alert')).toHaveText('This call was denied.');
    await expect(panel.getByText('STDIO_SANDBOX_REPLY',{exact:true})).toHaveCount(0);
    await app.evaluate(()=>{(globalThis as unknown as BridgeTestGlobal).__bridgeReview.allowNext=true;});
    await panel.getByRole('button',{name:'Review and call'}).click();
    await expect(panel.getByText('STDIO_SANDBOX_REPLY',{exact:true})).toBeVisible();
    const reviews=await app.evaluate(()=>(globalThis as unknown as BridgeTestGlobal).__bridgeReview.prompts);
    expect(reviews).toHaveLength(2);
    expect(reviews.every(prompt=>prompt.includes('/…'))).toBe(true);
    expect(/\/mcp\/[a-f0-9]{64}/u.test(JSON.stringify([state,reviews,await panel.innerText()]))).toBe(false);
  } finally {
    await app?.close().catch(()=>undefined);lines.close();
    if(child.exitCode===null && child.signalCode===null)child.kill('SIGTERM');
    await exited.catch(()=>undefined);await rm(root,{recursive:true,force:true});
  }
});
