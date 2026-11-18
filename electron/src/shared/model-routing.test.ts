import { expect,it } from 'vitest';
import type { ProviderConfig } from './contracts';
import { complexRequest, defaultModelFallback, defaultModelRouting, modelFallbackSchema, modelRoutingSchema, routingDestination } from './model-routing';

it('only routes local to enabled, explicitly declared local noncloud models', () => {
  const provider:ProviderConfig = { id:'fixture', name:'Local fixture', model:'chat',enabled:true,kind:'ollama',baseUrl:'http://127.0.0.1:11434/v1',localExecutionConfirmed:true,supportsTools:false,secretState:'missing' };
  expect(defaultModelRouting.enabled).toBe(false);
  expect(routingDestination(provider)).toBe('local');
  expect(routingDestination({...provider,localExecutionConfirmed:false})).toBe('unknown');
  expect(routingDestination({...provider,baseUrl:'https://example.org/v1'})).toBe('cloud');
  expect(routingDestination({...provider,model:'qwen:cloud'})).toBe('cloud');
  expect(modelRoutingSchema.safeParse({...defaultModelRouting,enabled:true}).success).toBe(false);
  expect(complexRequest('Compare these options and their tradeoffs')).toBe(true);
  expect(complexRequest('你好')).toBe(false);
});

it('keeps old routing settings valid and lets fallback be enabled independently', () => {
  const legacy = { enabled:false, localProviderId:null, cloudProviderId:null };
  expect(modelRoutingSchema.parse(legacy)).toEqual(legacy);
  expect(defaultModelRouting.fallback).toEqual({enabled:false,providerIds:[]});
  expect(defaultModelFallback).toEqual({enabled:false,providerIds:[]});
  const providerIds = ['00000000-0000-4000-8000-000000000001'];
  expect(modelRoutingSchema.parse({...legacy,fallback:{enabled:true,providerIds}})).toEqual({...legacy,fallback:{enabled:true,providerIds}});
});

it('bounds the fallback order and rejects duplicate, malformed, or empty enabled targets', () => {
  const providerIds = [1,2,3,4].map(value => `00000000-0000-4000-8000-00000000000${value}`);
  expect(modelFallbackSchema.parse({enabled:true,providerIds:providerIds.slice(0,3)}).providerIds).toEqual(providerIds.slice(0,3));
  for (const ids of [providerIds, [providerIds[0],providerIds[0]], ['not-an-id'], []]) {
    expect(modelFallbackSchema.safeParse({enabled:true,providerIds:ids}).success).toBe(false);
  }
  expect(modelFallbackSchema.safeParse({enabled:false,providerIds:[]}).success).toBe(true);
});
