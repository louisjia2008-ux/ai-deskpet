import { expect, it } from 'vitest';
import { authorizeIpcRequest } from '../../src/main/ipc-policy';
import type { InvokeChannel } from '../../src/shared';
const id='01234567-89ab-4def-8123-456789abcdef';
const cases:Array<[InvokeChannel,Record<string,unknown>]> = [
  ['memory-recall:search',{operationId:id,sessionId:id,query:'A synthetic question'}],
  ['memory-recall:cancel',{operationId:id}], ['research:list',{}], ['research:get',{id}],
  ['research:submit',{operationId:id,goal:'A synthetic task',material:'',providerId:id,model:'fixture',allowRemote:false,maxMinutes:2,maxToolCalls:4}],
  ['research:cancel',{id}], ['research:resume',{id,operationId:id}], ['research:open-result',{id}],
  ['extensions:set-skill-exposure',{id,digest:'a'.repeat(64),revision:1,exposure:'public'}],
  ['extensions:save-method',{name:'Reviewed method',text:'Read actual evidence.'}],
];
for (const [channel,payload] of cases) it(`${channel} requires the trusted desktop and refuses injected authority`,()=>{
  const request={channel,envelope:{version:1,payload},senderRole:'console' as const,senderUrl:'deskpet://app/main_window/index.html',allowedRoles:['console'] as const,development:false};
  expect(authorizeIpcRequest(request)).toEqual(payload);
  expect(()=>authorizeIpcRequest({...request,senderRole:'overlay'})).toThrow('role');
  expect(()=>authorizeIpcRequest({...request,senderUrl:'https://example.org'})).toThrow('origin');
  expect(()=>authorizeIpcRequest({...request,envelope:{version:1,payload:{...payload,approved:true,permissionRevision:99}}})).toThrow();
});
