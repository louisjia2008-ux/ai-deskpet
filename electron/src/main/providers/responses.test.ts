// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '../../shared';
import { providerUtilityCommandSchema, providerUtilityResponseSchema } from '../../utility/provider-protocol';
import { OpenAICompatibleAdapter } from './openai-compatible';
import { chatRequestLimits } from './chat-request-policy';
import type { CapturedProviderBinding } from './provider-service';
import { prepareProviderChatRequest, providerBindingFingerprint, providerChatEndpoint, providerWireProtocol } from './request-budget';
import type { ProviderChatRequest, ProviderResponseItem, ProviderStreamEvent } from './types';

const config = (): ProviderConfig => ({ id:randomUUID(),kind:'openai',name:'Synthetic official OpenAI',baseUrl:'https://api.openai.com/v1',model:'gpt-6.1-terra',enabled:true,supportsTools:true,secretState:'configured',contextWindowTokens:8192,maxOutputTokens:512 });
const input = (provider=config()):ProviderChatRequest => ({model:provider.model,messages:[{role:'user',content:'Synthetic request'}],
  ...chatRequestLimits({provider,model:provider.model,inspection:{contextWindowTokens:null}} as CapturedProviderBinding),
  identity:{requestId:randomUUID(),bindingDigest:providerBindingFingerprint(provider,provider.model)}});
const frame = (event:unknown):string => `data: ${JSON.stringify(event)}\r\n\r\n`;
const message = (text:string):Extract<ProviderResponseItem,{type:'message'}> => ({type:'message',id:'msg_synthetic',role:'assistant',status:'completed',phase:'final_answer',content:[{type:'output_text',text}]});
const completed = (output:ProviderResponseItem[],usage:Record<string,number>={input_tokens:17,output_tokens:9}):string=>frame({type:'response.completed',response:{id:'resp_synthetic',status:'completed',output,usage}});
const collect=async(provider:ProviderConfig,request:ProviderChatRequest,sse:string|Response,signal?:AbortSignal)=>{
  const fetcher=vi.fn<typeof fetch>(async()=>typeof sse==='string'?new Response(sse):sse),events:ProviderStreamEvent[]=[];let error:unknown;
  try{for await(const event of new OpenAICompatibleAdapter({config:provider,apiKey:'SYNTHETIC_KEY'},fetcher).streamChat(request,signal))events.push(event);}catch(caught){error=caught;}
  return {events,error,fetcher,observations:events.flatMap(event=>event.type==='request-observation'?[event.observation]:[])};
};
const reasoning:ProviderResponseItem={type:'reasoning',id:'rs_synthetic',summary:[],encrypted_content:'SYNTHETIC_OPAQUE_REASONING',status:'completed'};
const call=(n:number,name='web_search'):ProviderResponseItem=>({type:'function_call',id:`fc_${n}`,call_id:`call_${n}`,name,arguments:`{"query":"synthetic${n}"}`,status:'completed'});

describe('official OpenAI Responses protocol',()=>{
  it('selects Responses only for the explicitly official OpenAI service and binds the actual endpoint',()=>{
    const provider=config();expect(providerWireProtocol(provider)).toBe('responses');expect(providerChatEndpoint(provider)).toBe('https://api.openai.com/v1/responses');
    for(const other of [{...provider,kind:'openai-compatible' as const},{...provider,baseUrl:'https://api.openai.com.proxy.invalid/v1'},{...provider,baseUrl:'https://proxy.invalid/v1'}]){
      expect(providerWireProtocol(other)).toBeUndefined();expect(providerChatEndpoint(other)).toMatch(/\/chat\/completions$/u);
      expect(providerBindingFingerprint(other,provider.model)).not.toBe(providerBindingFingerprint(provider,provider.model));
    }
  });
  it('uses the verified Terra none policy while leaving other models and proxy services unchanged',()=>{
    const provider=config();const limits=(p:ProviderConfig,model=p.model)=>chatRequestLimits({provider:p,model,inspection:{contextWindowTokens:null}} as CapturedProviderBinding);
    expect(limits(provider)).toMatchObject({wireProtocol:'responses',reasoningEffort:'none'});
    expect(limits(provider,'gpt-6.1-terra-2026-11-01').reasoningEffort).toBe('none');
    expect(limits(provider,'o3').reasoningEffort).toBeUndefined();expect(limits(provider,'gpt-6.1-sol').reasoningEffort).toBeUndefined();
    expect(limits({...provider,kind:'openai-compatible'})).not.toHaveProperty('wireProtocol');
  });
  it('serializes a stateless bounded wire body with flat mapped tools and no legacy parameters',()=>{
    const provider=config(),request=input(provider);request.tools=[{name:'web.search',description:'Search',parameters:{type:'object',properties:{query:{type:'string'}}}}];
    const prepared=prepareProviderChatRequest(request),body=JSON.parse(prepared.bodyText);
    expect(body).toMatchObject({model:provider.model,input:[{role:'user',content:'Synthetic request'}],stream:true,store:false,max_output_tokens:512,reasoning:{effort:'none'},tools:[{type:'function',name:'web_search',strict:false}]});
    for(const key of ['messages','max_tokens','max_completion_tokens','reasoning_effort','stream_options','identity','contextBudget'])expect(body).not.toHaveProperty(key);
    expect(prepared.bodySHA256).toBe(createHash('sha256').update(prepared.bodyText).digest('hex'));
    expect(providerUtilityCommandSchema.safeParse({version:1,kind:'provider:chat',requestId:randomUUID(),credentials:{config:provider,apiKey:'SYNTHETIC_KEY'},request}).success).toBe(true);
  });
  it('streams chunk-split Unicode, records usage and hashes precisely the body actually dispatched',async()=>{
    const provider=config(),request=input(provider);
    const bytes=new globalThis.TextEncoder().encode(frame({type:'response.output_text.delta',delta:'你好'})+completed([message('你好')],{input_tokens:31,output_tokens:7}));
    const response=new Response(new globalThis.ReadableStream({start(controller){for(let offset=0;offset<bytes.length;offset+=7)controller.enqueue(bytes.slice(offset,offset+7));controller.close();}}));
    const result=await collect(provider,request,response);expect(result.error).toBeUndefined();
    expect(result.fetcher.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/responses');
    expect(result.events.filter(event=>event.type==='text')).toEqual([{type:'text',text:'你好'}]);
    const actualHash=createHash('sha256').update(String(result.fetcher.mock.calls[0]?.[1]?.body)).digest('hex');
    expect(result.observations.map(item=>item.phase)).toEqual(['fetch-invoked','response-received','terminal']);
    expect(result.observations.every(item=>item.bodySHA256===actualHash)).toBe(true);
    expect(result.observations.at(-1)).toMatchObject({outcome:'completed',finishReason:'stop',usage:{inputTokens:31,outputTokens:7,source:'provider-reported'}});
    expect(result.events.at(-1)).toEqual({type:'done',finishReason:'stop'});
    for(const event of result.events)expect(providerUtilityResponseSchema.safeParse({version:1,kind:'provider:event',requestId:randomUUID(),event}).success).toBe(true);
  });
  it('accumulates multiple fragmented calls and preserves complete opaque reasoning for a fresh stateless continuation',async()=>{
    const provider=config(),request=input(provider);request.tools=[{name:'web.search',description:'Search',parameters:{type:'object'}}];
    let sse='';for(const n of [1,2]){
      const item=call(n);if(item.type!=='function_call')throw Error('fixture');
      sse+=frame({type:'response.output_item.added',output_index:n,item:{...item,arguments:'',status:'in_progress'}});
      sse+=frame({type:'response.function_call_arguments.delta',output_index:n,item_id:item.id,delta:'{"query":'});
      sse+=frame({type:'response.function_call_arguments.delta',output_index:n,item_id:item.id,delta:`"synthetic${n}"}`});
      sse+=frame({type:'response.function_call_arguments.done',output_index:n,item_id:item.id,arguments:item.arguments});
      sse+=frame({type:'response.output_item.done',output_index:n,item});
    }
    const output=[reasoning,call(1),call(2)],result=await collect(provider,request,sse+completed(output));
    expect(result.error).toBeUndefined();const calls=result.events.filter(event=>event.type==='tool-call');
    expect(calls).toEqual([1,2].map(n=>({type:'tool-call',id:`call_${n}`,name:'web.search',argumentsJson:`{"query":"synthetic${n}"}`})));
    const retained=result.events.find(event=>event.type==='response-items');if(retained?.type!=='response-items')throw Error('missing replay items');
    expect(retained.items).toEqual(output);
    const next:ProviderChatRequest={...request,identity:{...request.identity!,requestId:randomUUID()},messages:[...request.messages,{role:'assistant',content:'',responseItems:retained.items,toolCalls:calls.map(c=>({id:c.id,name:c.name,argumentsJson:c.argumentsJson}))},...calls.map(c=>({role:'tool' as const,toolCallId:c.id,content:'FULL_SYNTHETIC_TOOL_RESULT'}))]};
    const second=await collect(provider,next,completed([message('Result')]));expect(second.error).toBeUndefined();
    const body=JSON.parse(String(second.fetcher.mock.calls[0]?.[1]?.body));
    expect(body.input.slice(1,4)).toEqual(output);expect(body.input.slice(-2)).toEqual([1,2].map(n=>({type:'function_call_output',call_id:`call_${n}`,output:'FULL_SYNTHETIC_TOOL_RESULT'})));
    expect(body).not.toHaveProperty('previous_response_id');expect(prepareProviderChatRequest(next).inputEstimate).toBeGreaterThan(prepareProviderChatRequest(request).inputEstimate);
  });
  it('retains commentary phase in replay and avoids duplicating already streamed text',async()=>{
    const provider=config(),result=await collect(provider,input(provider),frame({type:'response.output_text.delta',delta:'Working.'})+completed([{...message('Working.'),phase:'commentary'},call(1)]));
    expect(result.error).toBeUndefined();expect(result.events.filter(e=>e.type==='text')).toEqual([{type:'text',text:'Working.'}]);
    expect(result.events.find(e=>e.type==='response-items')).toMatchObject({items:[{phase:'commentary'},{type:'function_call'}]});
  });
  it.each(['eof','incomplete','failed','error'] as const)('withholds executable calls on %s and preserves reported usage',async failure=>{
    const provider=config(),request=input(provider),partial=frame({type:'response.output_item.added',output_index:0,item:call(1)});
    const end=failure==='eof'?'':failure==='error'?frame({type:'error',message:'untrusted raw error'}):frame({type:`response.${failure}`,response:{status:failure,incomplete_details:{reason:'max_output_tokens'},usage:{input_tokens:14,output_tokens:5},output:[call(1)]}});
    const result=await collect(provider,request,partial+end);expect(result.error).toBeDefined();expect(result.events.some(e=>e.type==='tool-call'||e.type==='done'||e.type==='response-items')).toBe(false);
    expect(result.observations.at(-1)).toMatchObject({outcome:'failed'});
    if(failure==='incomplete'){expect(result.error).toMatchObject({message:'provider.truncated'});expect(result.observations.at(-1)).toMatchObject({finishReason:'length',usage:{inputTokens:14,outputTokens:5}});}
  });
  it('rejects mismatched final function arguments and duplicate call identities instead of executing them',async()=>{
    const provider=config();for(const sse of [frame({type:'response.output_item.added',output_index:0,item:{...call(1),arguments:'{"query":"different"}'}})+completed([call(1)]),completed([call(1),call(1)])]){
      const result=await collect(provider,input(provider),sse);expect(result.error).toBeDefined();expect(result.events.some(e=>e.type==='tool-call')).toBe(false);
    }
  });
  it('enforces the text-only job boundary on both streamed and terminal forged calls',async()=>{
    const provider=config();for(const sse of [frame({type:'response.output_item.added',output_index:0,item:call(1)}),completed([call(1)],{input_tokens:22,output_tokens:4}),frame({type:'response.output_item.added',output_index:0,item:{type:'web_search_call',id:'hosted'}})]){
      const request={...input(provider),executionMode:'background-text' as const},result=await collect(provider,request,sse);
      expect(result.error).toMatchObject({message:'job.toolsForbidden'});expect(result.events.some(e=>e.type==='tool-call')).toBe(false);
      const body=JSON.parse(String(result.fetcher.mock.calls[0]?.[1]?.body));expect(body.tool_choice).toBe('none');expect(body).not.toHaveProperty('tools');
      if(sse.includes('response.completed'))expect(result.observations.at(-1)).toMatchObject({usage:{inputTokens:22,outputTokens:4}});
    }
  });
  it('rejects mismatched host protocols and oversized replay context before network dispatch',async()=>{
    const provider=config(),request=input(provider);delete request.wireProtocol;
    const missing=await collect(provider,request,completed([message('unused')]));expect(missing.error).toMatchObject({message:'provider.bindingMismatch'});expect(missing.fetcher).not.toHaveBeenCalled();
    const big=input(provider);big.messages.push({role:'assistant',content:'',responseItems:[{...reasoning,encrypted_content:'OPAQUE'.repeat(20_000)},call(1)],toolCalls:[{id:'call_1',name:'web.search',argumentsJson:'{}'}]});
    const oversized=await collect(provider,big,completed([message('unused')]));expect(oversized.error).toMatchObject({code:'provider.contextBudgetExceeded'});expect(oversized.fetcher).not.toHaveBeenCalled();
  });
  it.each([
    [400,'unsupported_parameter','provider.unsupportedParameter'],
    [404,'model_not_found','provider.modelUnavailable'],
    [403,'unsupported_country_region_territory','provider.regionRestricted'],
    [403,'permission_denied','provider.permissionDenied'],
    [429,'insufficient_quota','provider.quota'],
  ])('classifies bounded HTTP %s/%s without exposing raw provider text or retrying',async(status,code,expected)=>{
    const provider=config(),request=input(provider),response=new Response(JSON.stringify({error:{code,param:'SYNTHETIC_PRIVATE_PARAM',message:'SYNTHETIC_PRIVATE_SERVER_MESSAGE'}}),{status:Number(status)});
    const result=await collect(provider,request,response);expect(result.error).toMatchObject({code:expected});expect(String(result.error)).not.toContain('SYNTHETIC_PRIVATE');
    expect(result.fetcher).toHaveBeenCalledOnce();expect(result.observations.at(-1)).toMatchObject({outcome:'failed',httpStatus:status});
  });
  it('keeps HTTP status classification when its error payload is oversized or malformed',async()=>{
    const provider=config();for(const body of ['not JSON','x'.repeat(8193)]){
      const result=await collect(provider,input(provider),new Response(body,{status:400}));expect(result.error).toMatchObject({code:'provider.request'});expect(result.fetcher).toHaveBeenCalledOnce();
    }
  });
  it('distinguishes a refusal completion from truncated text and does not repeat the refusal',async()=>{
    const provider=config(),text='Synthetic refusal';const sse=frame({type:'response.refusal.delta',delta:text})+completed([{type:'message',role:'assistant',status:'completed',content:[{type:'refusal',refusal:text}]}]);
    const result=await collect(provider,input(provider),sse);expect(result.error).toBeUndefined();expect(result.events.filter(e=>e.type==='text')).toEqual([{type:'text',text}]);expect(result.events.at(-1)).toEqual({type:'done',finishReason:'stop'});
  });
  it('never treats DONE alone or a completion with a contradictory status as completion',async()=>{
    const provider=config();for(const sse of ['data: [DONE]\n\n',frame({type:'response.completed',response:{status:'incomplete',output:[call(1)]}})]){
      const result=await collect(provider,input(provider),sse);expect(result.error).toMatchObject({message:'provider.streamInterrupted'});expect(result.events.some(e=>e.type==='tool-call'||e.type==='done')).toBe(false);
    }
  });
});
