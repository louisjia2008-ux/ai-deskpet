// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { Tiktoken } from 'js-tiktoken/lite';
import cl100k from 'js-tiktoken/ranks/cl100k_base';
import { estimateSerializedInputTokens } from './input-token-estimate';

describe('bounded local token estimate', () => {
  it('counts JSON, Chinese, emoji and apparent special tokens as ordinary input', () => {
    const encoder = new Tiktoken(cl100k);
    for (const text of ['Hello, how are you?', '你好呀，陪我说说话吧。', '🫶🐱', '<|endoftext|>', JSON.stringify({ tools: [{ name: 'web_search', parameters: { type: 'object' } }] })]) {
      expect(estimateSerializedInputTokens(text)).toBe(encoder.encode(text, [], []).length);
      expect(estimateSerializedInputTokens(text)).toBeGreaterThan(0);
    }
  });
  it('does not mistake long but compressible English metadata bytes for as many tokens', () => {
    const body = 'The tool description is reference data. '.repeat(100);
    expect(estimateSerializedInputTokens(body)).toBeLessThan(Buffer.byteLength(body));
  });
  it('bounds long unbroken BPE pieces without dropping content or splitting surrogate pairs', () => {
    const body = ('a'.repeat(255) + '🫶').repeat(32);
    expect(estimateSerializedInputTokens(body)).toBeGreaterThan(0);
    expect(estimateSerializedInputTokens(body)).toBeLessThan(Buffer.byteLength(body));
  });
  it('bounds work and still refuses a pathological mandatory body', () => {
    const huge = 'x'.repeat(1_048_577);
    expect(estimateSerializedInputTokens(huge)).toBe(huge.length);
  });
});
