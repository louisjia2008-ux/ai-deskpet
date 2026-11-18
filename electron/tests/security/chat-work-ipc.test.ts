import { expect, it } from 'vitest';
import { authorizeIpcRequest } from '../../src/main/ipc-policy';
import type { InvokeChannel } from '../../src/shared';
const id='01234567-89ab-4def-8123-456789abcdef';
const cases:Array<[InvokeChannel,Record<string,unknown>]>=[['chat-work:search-artifacts',{query:'report',offset:0,limit:30}],['chat-work:preview-artifact',{sessionId:id,taskId:id,path:'report.md',sha256:'a'.repeat(64)}],['chat-work:export-artifact-pdf',{sessionId:id,taskId:id,path:'report.md',sha256:'a'.repeat(64)}],['chat-work:list',{sessionId:id}],['chat-work:get',{sessionId:id,id}],['chat-work:open-artifact',{sessionId:id,taskId:id,path:'report.md'}],['chat-work:search-history',{sessionId:id,query:'report'}],['chat-work:read-history',{sessionId:id,messageId:id}],['chat-work:list-cron',{sessionId:id}],['chat-work:pause-cron',{sessionId:id,id}],['chat-work:resume-cron',{sessionId:id,id,expectedRevision:1,allowedCapabilities:['math.calculate']}],['chat-work:cancel-cron',{sessionId:id,id}]];
for(const [channel,payload] of cases)it(`${channel} requires a console app sender and rejects injected authorization`,()=>{
 const request={channel,envelope:{version:1,payload},senderRole:'console' as const,senderUrl:'deskpet://app/main_window/index.html',allowedRoles:['console'] as const,development:false};
 expect(authorizeIpcRequest(request)).toEqual(payload);expect(()=>authorizeIpcRequest({...request,senderRole:'overlay'})).toThrow('role');expect(()=>authorizeIpcRequest({...request,senderUrl:'https://example.org'})).toThrow('origin');expect(()=>authorizeIpcRequest({...request,envelope:{version:1,payload:{...payload,allowedCapabilities:['workspace.read'],providerId:id}}})).toThrow();
});
