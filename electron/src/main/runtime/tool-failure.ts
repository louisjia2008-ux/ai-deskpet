import { isToolFailureCode, toolFailureCode } from '../../shared/tool-failures';
import type { ToolFailureCode } from '../../shared/tool-failures';
import { PermissionDeniedError } from './permissions';

export class ToolFailure extends Error {
  /** `detail` is a fixed code from this codebase, never text from a page or path. */
  constructor(readonly code: ToolFailureCode, message: string = code, readonly detail?: string) { super(message); this.name = 'ToolFailure'; }
}

const FAILURE_EXPLANATIONS: Record<string, { message: string; retryable: boolean }> = {
  'knowledge.folderPrivate': { message: 'That note is unavailable with the current sharing rules. Search again within the available folders or report the limitation.', retryable: false },
  'tool.webBudgetExceeded': { message: 'The host web-call allowance for this task is exhausted. This call was not executed. Do not retry or request other tools; report only existing verified results and clearly list what remains unverified.', retryable: false },
  'plugin.pageNotFound': { message: 'The page is missing (HTTP 404 or 410). Do not read this URL again; report it as unavailable and continue with verified sources.', retryable: false },
  'plugin.pageAccessDenied': { message: 'The website denied access (HTTP 401 or 403). Do not retry this URL or bypass its access controls. Report the limitation and continue with verified sources.', retryable: false },
  'plugin.pageRateLimited': { message: 'The website rate-limited this request (HTTP 429). Do not immediately retry this URL. Report the limitation and continue with verified sources.', retryable: false },
  'plugin.pageServerError': { message: 'The website returned a server error (HTTP 5xx). Use another source or report the limitation.', retryable: true },
  'plugin.crawlFailed': { message: 'The site could not be fetched or returned an error. Use another source or report the limitation.', retryable: true },
  'plugin.dnsUnavailable': { message: 'Public DNS could not resolve this host. Trying different paths on the same host will not fix this. Report the host as unavailable and continue with other verified sources.', retryable: false },
  'plugin.nonPublicAddress': { message: 'The host resolved to a private or reserved address and the request was blocked. Do not bypass the public-network boundary or try other paths on this host. Report the source as unavailable.', retryable: false },
  'plugin.invalidTarget': { message: 'The URL does not satisfy the public HTTPS target policy. Do not bypass the network boundary. Use an eligible public HTTPS source or report the limitation.', retryable: false },
  'plugin.navigationFailed': { message: 'The browser could not navigate to the page. No page content was verified. Use another source or report the limitation.', retryable: true },
  'plugin.extractionFailed': { message: 'The browser did not produce a verified readable page. Do not treat snippets or page metadata as page content. Use another source or report the limitation.', retryable: false },
  'plugin.browserFailed': { message: 'The local browser service could not start or finish this read. Trying more URLs will not fix the browser service. Report the limitation and continue using already verified material.', retryable: false },
  'plugin.emptyContent': { message: 'The page has no readable content in the requested format. Do not repeatedly read the same format; use another source or report the limitation.', retryable: false },
  'plugin.responseTooLarge': { message: 'The response exceeded the reader size limit. Retrying this URL with a smaller output page does not reduce its downloaded size. Use a smaller source or report the limitation.', retryable: false },
  'plugin.redirectLimit': { message: 'The page exceeded the supported redirect policy. Do not bypass the redirect checks. Use another source or report the limitation.', retryable: false },
  'plugin.unsupportedContent': { message: 'The response format is not supported by this reader. Use an HTML, plain-text or JSON source, or report the limitation.', retryable: false },
  'tool.network': { message: 'Could not connect. The host may not exist or may be unreachable. Use another source or report the limitation.', retryable: true },
  'tool.timeout': { message: 'The request timed out. Use another source or report the limitation.', retryable: true },
  'tool.mcpReadFailed': { message: 'The MCP service did not return usable content. Use another source or report the gap.', retryable: true },
  'tool.mcpAuthentication': { message: 'The MCP service needs a valid credential configured in desktop settings. Do not retry this service or ask for credentials in chat. Use another source or report the gap.', retryable: false },
};

/** Only known, safe-to-repeat failures return to the model. Authority and
 * uncertain side-effect failures always leave the run through its error path. */
export const recoverableToolFailure = (
  failure: ToolFailure,
  sideEffect: boolean,
  phase: 'arguments' | 'execution',
): boolean => phase === 'arguments'
  ? failure.code === 'tool.invalidArguments'
  : !sideEffect && (['tool.invalidArguments', 'tool.fileMissing', 'tool.network', 'tool.timeout', 'tool.searchUnavailable', 'tool.pluginResponse',
    'tool.mcpReadFailed', 'tool.mcpAuthentication', 'knowledge.folderPrivate'] as readonly string[]).includes(failure.code);

export const toolFailureResult = (failure: ToolFailure): { ok: false; error: { code: ToolFailureCode; message: string; retryable: boolean } } => ({
  ok: false,
  error: {
    code: failure.code,
    // Exception bodies and schema issues may contain paths, URLs or input.
    // The schema is already supplied separately in the tool descriptor.
    message: failure.code === 'tool.invalidArguments'
      ? 'Arguments did not satisfy the tool schema. Correct them before trying again.'
      : FAILURE_EXPLANATIONS[(failure.detail ?? failure.code).replace(/^web\./u, 'plugin.')]?.message ?? 'The tool did not complete. Use another safe approach or report the limitation.',
    retryable: FAILURE_EXPLANATIONS[(failure.detail ?? failure.code).replace(/^web\./u, 'plugin.')]?.retryable ?? true,
  },
});

/** For a call the host will not run again. Unlike a correction, this asks the
 * model to report the gap rather than work around it. */
export const refusedCallResult = (failure: ToolFailure, message: string): { ok: false; error: { code: ToolFailureCode; message: string; retryable: false } } => ({
  ok: false,
  error: { code: failure.code, message, retryable: false },
});

export const classifyToolFailure = (error: unknown, toolId: string): ToolFailure => {
  const known = toolFailureCode(error);
  if (known !== undefined) return new ToolFailure(known, known, error instanceof ToolFailure ? error.detail : undefined);
  if (error instanceof PermissionDeniedError) {
    const code = `tool.permission.${error.capabilityId}`;
    return new ToolFailure(isToolFailureCode(code) ? code : 'tool.permission');
  }
  const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (error instanceof Error && error.name === 'TimeoutError') return new ToolFailure('tool.timeout');
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT'].includes(String(code))) return new ToolFailure('tool.network');
  if (toolId.startsWith('workspace.')) return new ToolFailure(code === 'ENOENT' ? 'tool.fileMissing' : 'tool.fileAccess');
  if (error instanceof RangeError) return new ToolFailure('tool.invalidArguments');
  if (toolId.startsWith('web.')) return new ToolFailure('tool.network');
  return new ToolFailure('tool.executionFailed');
};
