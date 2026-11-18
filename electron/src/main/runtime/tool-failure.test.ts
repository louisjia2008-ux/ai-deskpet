import { expect, it } from 'vitest';
import { ToolFailure, recoverableToolFailure, toolFailureResult } from './tool-failure';

it.each([
  ['pageNotFound', false, 'HTTP 404 or 410'],
  ['pageAccessDenied', false, 'HTTP 401 or 403'],
  ['pageRateLimited', false, 'HTTP 429'],
  ['pageServerError', true, 'HTTP 5xx'],
  ['dnsUnavailable', false, 'Public DNS'],
  ['nonPublicAddress', false, 'private or reserved'],
  ['invalidTarget', false, 'public HTTPS'],
  ['responseTooLarge', false, 'size limit'],
  ['navigationFailed', true, 'navigate'],
  ['extractionFailed', false, 'readable page'],
  ['browserFailed', false, 'browser service'],
  ['emptyContent', false, 'no readable content'],
] as const)('gives native and plugin readers the same safe guidance for %s', (detail, retryable, explanation) => {
  for (const prefix of ['plugin', 'web']) {
    const result = toolFailureResult(new ToolFailure('tool.pluginResponse', 'PRIVATE_EXCEPTION https://private.example/', `${prefix}.${detail}`));
    expect(result).toMatchObject({ ok: false, error: { retryable } });
    expect(result.error.message).toContain(explanation);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
    expect(JSON.stringify(result)).not.toContain('private.example');
  }
});

it('keeps authority failures fatal and side effects out of the read-only recovery path', () => {
  for (const code of ['tool.webTarget', 'tool.contextPrivacyBlocked', 'tool.permission.web.read'] as const) {
    expect(recoverableToolFailure(new ToolFailure(code), false, 'execution')).toBe(false);
  }
  expect(recoverableToolFailure(new ToolFailure('tool.network'), true, 'execution')).toBe(false);
});

it('keeps argument correction available and never uses arbitrary exception text as guidance', () => {
  expect(toolFailureResult(new ToolFailure('tool.invalidArguments', 'PRIVATE_SCHEMA'))).toMatchObject({ error: { retryable: true } });
  const result = toolFailureResult(new ToolFailure('tool.pluginResponse', 'PRIVATE_EXCEPTION', 'PRIVATE_DETAIL'));
  expect(result.error.message).toBe('The tool did not complete. Use another safe approach or report the limitation.');
});
