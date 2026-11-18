// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ProviderConfig } from '../../shared';
import { DomainRepository } from '../domain/repository';
import { AgentRuntime } from '../runtime/agent-runtime';
import { EffectLedger } from '../runtime/effect-ledger';
import { PermissionGate } from '../runtime/permissions';
import { TaskEventStream } from '../runtime/task-event-stream';
import { ToolRegistry } from '../runtime/tool-registry';
import { OpenAICompatibleAdapter } from './openai-compatible';
import { prepareProviderChatRequest, providerBindingFingerprint } from './request-budget';
import type { ProviderChatRequest, ProviderResponseItem } from './types';

describe('Responses continuation through the production bounded agent runtime',()=>{
  it('executes one granted tool and replays its complete associated reasoning and result in the next wire budget',async()=>{
    const root=await mkdtemp(join(tmpdir(),'deskpet-responses-runtime-'));
    try {
      const repository=new DomainRepository(join(root,'profile.enc.json'),{getVaultKey:async()=>Buffer.alloc(32,19)});await repository.initialize();
      const events=new TaskEventStream(join(root,'events.jsonl'));await events.initialize();
      const gate=new PermissionGate(repository);await gate.grant('math.calculate','session');
      const tools=new ToolRegistry(),execute=vi.fn(async()=>({value:4}));
      tools.register({id:'math.calculate',title:'Calculate',capabilityId:'math.calculate',risk:'low',sideEffect:false,
        inputSchema:z.object({expression:z.string()}).strict(),execute});
      const runtime=new AgentRuntime(tools,gate,new EffectLedger(repository),events);
      const provider:ProviderConfig={id:randomUUID(),kind:'openai',baseUrl:'https://api.openai.com/v1',name:'Synthetic',model:'gpt-6.1-terra',enabled:true,supportsTools:true,secretState:'configured',contextWindowTokens:8192,maxOutputTokens:512};
      const output:ProviderResponseItem[]=[{type:'reasoning',id:'rs_fixture',summary:[],encrypted_content:'SYNTHETIC_OPAQUE_THINKING'},
        {type:'function_call',id:'fc_fixture',call_id:'call_fixture',name:'math_calculate',arguments:'{"expression":"2+2"}',status:'completed'}];
      const sse=(items:ProviderResponseItem[])=>`data: ${JSON.stringify({type:'response.completed',response:{status:'completed',output:items,usage:{input_tokens:32,output_tokens:12}}})}\n\n`;
      let count=0;const fetcher=vi.fn<typeof fetch>(async()=>new Response(++count===1?sse(output):sse([{type:'message',role:'assistant',content:[{type:'output_text',text:'4'}],status:'completed'}])));
      const adapter=new OpenAICompatibleAdapter({config:provider,apiKey:'SYNTHETIC_KEY'},fetcher),hashes:string[]=[];
      const result=await runtime.run('Compute 2+2',{
        next:async({messages,tools:available,signal})=>{
          const request:ProviderChatRequest={model:provider.model,wireProtocol:'responses',reasoningEffort:'none',messages,
            maxOutputTokens:512,outputTokenParameter:'max_completion_tokens',contextBudget:{contextWindowTokens:8192,safetyMarginTokens:256,capacitySource:'configured'},
            identity:{requestId:randomUUID(),bindingDigest:providerBindingFingerprint(provider,provider.model)},
            tools:available.map(tool=>({name:tool.id,description:tool.title,parameters:tool.parameters}))};
          const prepared=prepareProviderChatRequest(request);hashes.push(prepared.bodySHA256);
          const calls:Array<{id:string;toolId:string;input:unknown}>=[];let retained:ProviderResponseItem[]|undefined,text='';
          for await(const event of adapter.streamChat(request,signal)){
            if(event.type==='text')text+=event.text;
            if(event.type==='response-items')retained=event.items;
            if(event.type==='tool-call')calls.push({id:event.id,toolId:event.name,input:JSON.parse(event.argumentsJson)});
            if(event.type==='request-observation')expect(event.observation.bodySHA256).toBe(prepared.bodySHA256);
          }
          return calls.length?{type:'tools',calls,...(retained?{responseItems:retained}:{})}:{type:'final',content:text};
        },
      });
      expect(result).toMatchObject({status:'succeeded',content:'4',iterations:2});expect(execute).toHaveBeenCalledOnce();expect(fetcher).toHaveBeenCalledTimes(2);
      const body=JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));expect(body.input.slice(1,3)).toEqual(output);
      expect(body.input.at(-1)).toEqual({type:'function_call_output',call_id:'call_fixture',output:'{"value":4}'});
      expect(hashes[1]).not.toBe(hashes[0]);
    } finally {await rm(root,{recursive:true,force:true});}
  });
});
