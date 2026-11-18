/* global process, fetch */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, realpath, lstat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openBridge } from './mcp-stdio-bridge.mjs';
import { copyService } from './mcp-stdio-bridge-sandbox.mjs';

const fixture = async (t) => {
  const temp = await mkdtemp(join(await realpath(tmpdir()), 'deskpet-stdio-fixture-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, 'package');
  await mkdir(root, { mode: 0o700 });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@fixture/math' }));
  await writeFile(join(root, 'outside.json'), 'synthetic public fixture');
  return { temp, root };
};

test('copies only pure JavaScript and reviewed data; rejects a linked entry or nested dependency', async (t) => {
  const { root, temp } = await fixture(t);
  await writeFile(join(root, 'entry.cjs'), 'void 0');
  await writeFile(join(root, '.env'), 'synthetic only');
  await writeFile(join(root, 'credentials.json'), 'synthetic only');
  const copy = join(temp, 'copy');
  assert.equal(await copyService(root, 'entry.cjs', copy), 'math');
  await assert.rejects(readFile(join(copy, 'credentials.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(copy, '.env')), { code: 'ENOENT' });
  await symlink(join(root, 'outside.json'), join(root, 'linked.cjs'));
  await assert.rejects(copyService(root, 'linked.cjs', join(temp, 'next')));
  await assert.rejects(copyService(root, 'entry.cjs', join(temp, 'other')));
  await assert.rejects(copyService(root, 'entry.cjs', join(root, 'recursive')));
});

test(
  'macOS bridge isolates the real stdio child and serves one negotiated HTTP session',
  { skip: process.platform !== 'darwin', timeout: 30000 },
  async (t) => {
    const { root, temp } = await fixture(t),
      outside = join(temp, 'outside');
    await writeFile(outside, 'synthetic private sentinel');
    const source = `
    const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process'),readline=require('node:readline');
    const line=readline.createInterface({input:process.stdin});
    const denied=f=>{try{f();return false}catch{return true}};
    line.on('line',async raw=>{
      const msg=JSON.parse(raw);if(msg.id===undefined)return;
      let result={};
      if(msg.method==='initialize')result={protocolVersion:msg.params.protocolVersion,capabilities:{tools:{}}};
      if(msg.method==='tools/list')result={tools:[{name:'probe',inputSchema:{type:'object'}}]};
      if(msg.method==='tools/call'){
        const outside=msg.params.arguments.outside;
        const blocked=await new Promise(done=>{const socket=net.connect(1,'127.0.0.1');socket.on('connect',()=>{socket.destroy();done(false)});socket.on('error',e=>done(['EPERM','EACCES'].includes(e.code)));});
        result={content:[{type:'text',text:JSON.stringify({input:msg.params.arguments.value,read:denied(()=>fs.readFileSync(outside)),write:denied(()=>fs.writeFileSync('test-write','x')),network:blocked,
          child:denied(()=>cp.execFileSync('/usr/bin/true')),env:process.env.DESKPET_MCP_SYNTHETIC===undefined})}]};
      }
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result})+'\\n');
    });
  `;
    await writeFile(join(root, 'server.cjs'), source);
    const sentinel = process.env.DESKPET_MCP_SYNTHETIC;
    process.env.DESKPET_MCP_SYNTHETIC = 'present-only-in-bridge';
    t.after(() => {
      if (sentinel === undefined) delete process.env.DESKPET_MCP_SYNTHETIC;
      else process.env.DESKPET_MCP_SYNTHETIC = sentinel;
    });
    const bridge = await openBridge(root, 'server.cjs');
    t.after(bridge.close);
    assert.equal((await lstat(bridge.manifest)).mode & 0o777, 0o600);
    assert.equal((await lstat(dirname(bridge.manifest))).mode & 0o777, 0o700);
    const manifest = JSON.parse(await readFile(bridge.manifest, 'utf8'));
    assert.equal(manifest.kind, 'deskpet-stdio-bridge');
    // Never echo the endpoint or session token through assertions or diagnostics.
    const endpoint = manifest.endpoint,
      version = '2025-11-25';
    let headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const post = (body, extra = {}) =>
      fetch(endpoint, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify({ jsonrpc: '2.0', ...body }) });
    assert.equal(
      (await post({ method: 'initialize', id: 1, params: { protocolVersion: version } }, { origin: 'https://untrusted.invalid' }))
        .status,
      403,
    );
    assert.equal((await post({ method: 'tools/list', id: 2 })).status, 400);
    const init = await post({ method: 'initialize', id: 3, params: { protocolVersion: version } });
    assert.equal(init.status, 200);
    const id = init.headers.get('mcp-session-id');
    assert.ok(typeof id === 'string' && id.length >= 24);
    assert.equal((await init.json()).result.protocolVersion, version);
    headers = { ...headers, 'mcp-session-id': id, 'mcp-protocol-version': version };
    assert.equal((await post({ id: 4, method: 'tools/list' })).status, 409);
    assert.equal((await post({ method: 'notifications/initialized' })).status, 202);
    assert.equal((await (await post({ id: 5, method: 'tools/list' })).json()).result.tools[0].name, 'probe');
    const call = await (
      await post({ id: 6, method: 'tools/call', params: { name: 'probe', arguments: { outside, value: 13 } } })
    ).json();
    assert.deepEqual(JSON.parse(call.result.content[0].text), {
      input: 13,
      read: true,
      write: true,
      network: true,
      child: true,
      env: true,
    });
    assert.equal((await fetch(endpoint, { method: 'DELETE', headers })).status, 204);
    assert.equal((await post({ id: 7, method: 'tools/list' })).status, 404);
    await bridge.close();
    await assert.rejects(readFile(bridge.manifest), { code: 'ENOENT' });
  },
);
