// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { expect,it,vi } from 'vitest';
import type { ProviderConfig } from '../../shared';
import type { CapturedProviderBinding } from '../providers/provider-service';
import type { ProviderAdapter, ProviderModelInspection } from '../providers/types';
import { providerBindingFingerprint } from '../providers/request-budget';
import { localToolModel } from './mcp-local-turn';

const tool={ name:'real-tool',description:'Return the specified fixture',inputSchema:{type:'object'},digest:'digest' };
const fixture=() => {
  const provider:ProviderConfig={id:randomUUID(),name:'Local fixture',kind:'ollama',baseUrl:'http://127.0.0.1:11434/v1',model:'fixture',
    localExecutionConfirmed:true,supportsTools:true,enabled:true,secretState:'missing'};
  const local:ProviderModelInspection={contextWindowTokens:8192,source:'ollama-show',executionDestination:'unknown',localGguf:true};
  let inspection=local, names=['selected_tool'];
  const dispatch=vi.fn();
  const adapter:ProviderAdapter={listModels:async()=>[],inspectModel:async()=>inspection,async *streamChat(request,_signal,options){
    await options?.validateBeforeSend?.();options?.assertCurrent?.();dispatch(request);
    for(const name of names)yield {type:'tool-call',name,id:randomUUID(),argumentsJson:'{"value":1}'};
    yield {type:'done',finishReason:'tool_calls'};
  }};
  const binding:CapturedProviderBinding={provider,model:provider.model,inspection:local,bindingDigest:providerBindingFingerprint(provider,provider.model),adapter};
  const providers={list:()=>[provider],captureBinding:vi.fn(async()=>binding)};
  return {providers,provider,dispatch,setNames:(value:string[])=>{names=value;},reportRemote:()=>{inspection={...local,executionDestination:'remote'};}};
};
it('rejects extra or unselected tool proposals without calling any service',async()=>{
  const f=fixture(), driver=await localToolModel(f.providers,f.provider.id,'fixture',new AbortController().signal,()=>undefined);
  for(const names of [['selected_tool','selected_tool'],['different_tool'],[]]){
    f.setNames(names);await expect(driver.propose('Only this question',tool)).rejects.toThrow('extensions.invalidProposal');
  }
  f.setNames(['selected_tool']);await expect(driver.propose('Only this question',tool)).resolves.toEqual({value:1});
});
it('revalidates local execution after capture and before dispatch',async()=>{
  const f=fixture(), driver=await localToolModel(f.providers,f.provider.id,'fixture',new AbortController().signal,()=>undefined);
  f.reportRemote();
  await expect(driver.propose('Do not deliver this private question',tool)).rejects.toThrow('extensions.localToolModel');
  expect(f.dispatch).not.toHaveBeenCalled();
});
