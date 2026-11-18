// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DomainRepository } from '../domain/repository';
import { AgentRuntime } from './agent-runtime';
import { PermissionGate } from './permissions';
import { EffectLedger } from './effect-ledger';
import { TaskEventStream } from './task-event-stream';
import { ToolRegistry } from './tool-registry';
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){const root=await mkdtemp(join(tmpdir(),'deskpet-task-scope-'));roots.push(root);const repository=new DomainRepository(join(root,'profile.enc.json'),{getVaultKey:async()=>Buffer.alloc(32,72)});await repository.initialize();const tools=new ToolRegistry(),permissions=new PermissionGate(repository),events=new TaskEventStream(join(root,'events.jsonl'));await events.initialize();return {repository,tools,permissions,runtime:new AgentRuntime(tools,permissions,new EffectLedger(repository),events)};}
it('checks host task scope before executing a tool even when a global grant exists',async()=>{
 const f=await fixture();await f.permissions.grant('workspace.write','always');const execute=vi.fn(async()=>({written:true}));
 f.tools.register({id:'workspace.write',title:'Write',capabilityId:'workspace.write',risk:'high',sideEffect:true,inputSchema:z.object({path:z.string()}),execute});
 await expect(f.runtime.run('Scoped scheduled task',{next:async()=>({type:'tools',calls:[{id:'write',toolId:'workspace.write',input:{path:'blocked.txt'}}]})},undefined,[],undefined,undefined,{beforeTool:()=>{throw new Error('schedule.authorizationChanged');}})).rejects.toThrow('schedule.authorizationChanged');
 expect(execute).not.toHaveBeenCalled();expect(f.repository.snapshot().sideEffects).toHaveLength(0);
});
it('records the validated input and actual output only after a successful tool operation',async()=>{
 const f=await fixture();await f.permissions.grant('math.calculate','session');f.tools.register({id:'math.calculate',title:'Calculate',capabilityId:'math.calculate',risk:'low',sideEffect:false,inputSchema:z.object({value:z.number()}),execute:async()=>({result:42})});let calls=0;const receipt=vi.fn(async()=>undefined);
 await f.runtime.run('Calculate',{next:async()=>++calls===1?{type:'tools',calls:[{id:'calc',toolId:'math.calculate',input:{value:42}}]}:{type:'final',content:'42'}},undefined,[],receipt);
 expect(receipt).toHaveBeenCalledExactlyOnceWith('math.calculate',{result:42},{value:42});
});
it('rechecks task authority after an asynchronous tool starts, before its commit',async()=>{
 const f=await fixture();await f.permissions.grant('workspace.write','always');let current=true;const write=vi.fn();
 f.tools.register({id:'workspace.write',title:'Write',capabilityId:'workspace.write',risk:'high',sideEffect:true,inputSchema:z.object({path:z.string()}),execute:async(_input,context)=>{await Promise.resolve();current=false;context.assertAuthorized?.();write();return {written:true};}});
 await expect(f.runtime.run('Task',{next:async()=>({type:'tools',calls:[{id:'write',toolId:'workspace.write',input:{path:'blocked.txt'},effectKey:'scope-commit-test'}]})},undefined,[],undefined,undefined,{beforeTool:()=>{if(!current)throw new Error('schedule.authorizationChanged');}})).rejects.toThrow();
 expect(write).not.toHaveBeenCalled();
});
