import { isIP } from 'node:net';
import { z } from 'zod';

import { formatTimerDeadline } from '../../../shared/timer-time';
import { parseDirectToolCommand } from '../../domain/direct-tool-command';
import type { LocalWebPlugins } from '../../plugins/local-web-plugins';
import { ToolFailure } from '../../runtime/tool-failure';
import { calculate } from '../../tools/calculator';
import { webToolContent } from '../../tools/web-content';
import type { SecureWebReader } from '../../tools/web-reader';
import { searchWeb, siteRestrictions, type SearchResult } from '../../tools/web-search';

export type WeChatReadTool =
  | { toolId: 'web.search'; input: { query: string } }
  | { toolId: 'web.read'; input: { url: string } }
  | { toolId: 'math.calculate'; input: { expression: string } }
  | { toolId: 'time.current'; input: { timezone?: string | undefined } };

export type WeChatReadEvidence =
  | { kind: 'search-excerpts'; engine: string; results: SearchResult[] }
  | { kind: 'page-excerpt'; source: string; excerpt: string; truncated: boolean }
  | { kind: 'calculation'; result: number }
  | { kind: 'time'; iso: string; timezone: string };

export interface WeChatReadOptions {
  signal?: AbortSignal;
  authorize?(): Promise<void>;
  assertCurrent?(): void;
  consume?(toolId: WeChatReadTool['toolId']): boolean;
}

interface Dependencies {
  web: SecureWebReader;
  webPlugins?: Pick<LocalWebPlugins, 'enabled' | 'search'>;
  timezone?(): string;
  now?(): Date;
}

const resultLimit = 3;
const control = /[\p{Cc}\p{Bidi_Control}\u2028\u2029]/u;
const sensitive = /(?:https?:\/\/|file:\/\/|\b(?:password|passcode|credential|bearer|api[ _-]?key|access[ _-]?token)\s*[:=]|\b(?:sk-[a-z\d_-]{12,}|gh[pousr]_[a-z\d]{10,}|AKIA[A-Z\d]{16})\b|[A-Z\d._%+-]+@[A-Z\d.-]+\.[A-Z]{2,}|(?<!\d)1[3-9]\d{9}(?!\d)|(?:密码|口令|验证码|密钥|身份证号|手机号)\s*[:：=]?\s*\S|\b(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3})\b|(?:^|\s)(?:~\/|\/(?:Users|home|private|etc)\/))/iu;
const arithmetic = z.strictObject({ expression: z.string().trim().min(1).max(160).regex(/^[\d.eE+\-−*/×÷%^( )]+$/u) });
const clock = z.strictObject({ timezone: z.string().trim().min(1).max(80).regex(/^[A-Za-z][\w+/-]*$/u).optional() });
const query = z.strictObject({ query: z.string().trim().min(2).max(200) });
const page = z.strictObject({ url: z.string().trim().min(1).max(400) });

function publicUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
      || !url.hostname.includes('.') || isIP(url.hostname) !== 0
      || /(?:^|\.)(?:localhost|local|internal|lan|home|onion)\.?$/iu.test(url.hostname)) return null;
    return url;
  } catch { return null; }
}

function publicQuery(value: string): boolean {
  if (control.test(value) || sensitive.test(value) || !/[\p{L}\p{N}]/u.test(value)) return false;
  try {
    const restrictions = siteRestrictions(value);
    return [...restrictions.include, ...restrictions.exclude].every(({ domain }) => publicUrl(`https://${domain}/`) !== null);
  } catch { return false; }
}

/** The model can propose only these read-only arguments. The scheduler still owns tool allowance and authorization. */
export function commandFromScheduledTool(toolId: string, input: unknown): WeChatReadTool | null {
  switch (toolId) {
    case 'web.search': {
      const parsed = query.safeParse(input);
      return parsed.success && publicQuery(parsed.data.query) ? { toolId, input: parsed.data } : null;
    }
    case 'web.read': {
      const parsed = page.safeParse(input);
      if (!parsed.success || control.test(parsed.data.url) || sensitive.test(parsed.data.url.slice('https://'.length))) return null;
      const url = publicUrl(parsed.data.url);
      return url ? { toolId, input: { url: url.href } } : null;
    }
    case 'math.calculate': {
      const parsed = arithmetic.safeParse(input);
      return parsed.success ? { toolId, input: parsed.data } : null;
    }
    case 'time.current': {
      const parsed = clock.safeParse(input);
      if (!parsed.success) return null;
      try { if (parsed.data.timezone) new Intl.DateTimeFormat('zh-CN', { timeZone: parsed.data.timezone }); }
      catch { return null; }
      return { toolId, input: parsed.data };
    }
    default: return null;
  }
}

/** Complete commands only. A known slash command with malformed input gets a usage reply. */
export function matchWeChatReadTool(raw: string, name = 'DeskPet'): WeChatReadTool | 'invalid' | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const text = raw.trim().replace(new RegExp('^@' + escaped + '[，,：:\\s]+', 'u'), '');
  const match = /^\/(search|read|calc|time)(?:\s|$)/iu.exec(text);
  if (match) {
    if (control.test(text) || text.length > 500) return 'invalid';
    const name = match[1]!.toLowerCase();
    const argument = text.slice(match[0].length).trim();
    const command = name === 'search' ? commandFromScheduledTool('web.search', { query: argument })
      : name === 'read' ? commandFromScheduledTool('web.read', { url: argument })
      : name === 'calc' ? commandFromScheduledTool('math.calculate', { expression: argument })
      : commandFromScheduledTool('time.current', argument ? { timezone: argument } : {});
    return command ?? 'invalid';
  }
  const direct = parseDirectToolCommand(text);
  return direct?.toolId === 'time.current' ? commandFromScheduledTool(direct.toolId, direct.input) : null;
}

const short = (value: string, size: number): string => [...value].slice(0, size).join('');
const excerpt = (value: string, size: number): string => short(value.replace(/[\p{Cc}\p{Bidi_Control}\u2028\u2029]/gu, ' ')
  .replace(/https?:\/\/\S+/giu, '').replace(/\s+/gu, ' ').trim(), size);

function cite(raw: string): string | null {
  try {
    const url = new URL(raw);
    url.hash = '';
    for (const name of [...url.searchParams.keys()]) {
      if (/^(?:utm_[a-z_]+|gclid|fbclid)$/iu.test(name)) url.searchParams.delete(name);
    }
    const checked = publicUrl(url.href);
    return checked && checked.href.length <= 180 ? checked.href : null;
  } catch { return null; }
}

function formatEvidence(result: WeChatReadEvidence): string {
  switch (result.kind) {
    case 'time': return `现在是 ${formatTimerDeadline(result.iso, result.timezone)}。`;
    case 'calculation': return `计算结果：${result.result}`;
    case 'page-excerpt': return `网页摘录${result.truncated || [...result.excerpt].length > 215 ? '（节选）' : ''}：${short(result.excerpt, 215)} 来源：${result.source}`;
    case 'search-excerpts': {
      const best = result.results[0];
      if (!best) return '这次公开搜索没有找到可引用的结果。';
      // One compact source keeps the quoted WeChat bubble and its link visible
      // together. The task runner still receives the full structured evidence.
      return `搜索摘要未经核验：${short(best.title, 32)} ${best.url}`;
    }
  }
}

export class WeChatReadTools {
  constructor(private readonly dependencies: Dependencies) {}

  async run(command: WeChatReadTool | 'invalid', options: WeChatReadOptions = {}): Promise<string> {
    if (command === 'invalid') {
      await options.authorize?.();
      options.signal?.throwIfAborted();
      options.assertCurrent?.();
      return '请输入 /search 公共关键词、/read 公开 HTTPS 网址、/calc 算式，或 /time [时区]。';
    }
    try { return formatEvidence(await this.runTask(command, options)); }
    catch (error) {
      if (!(error instanceof ToolFailure || error instanceof RangeError
        || error instanceof DOMException && error.name === 'TimeoutError')) throw error;
      options.signal?.throwIfAborted();
      options.assertCurrent?.();
      await options.authorize?.();
      options.signal?.throwIfAborted();
      options.assertCurrent?.();
      return command.toolId.startsWith('web.') ? '这次没能取得公开网页结果。' : '这个输入暂时无法计算或读取。';
    }
  }

  async runTask(command: WeChatReadTool, options: WeChatReadOptions = {}): Promise<WeChatReadEvidence> {
    const checked = commandFromScheduledTool(command.toolId, command.input);
    if (!checked) throw new ToolFailure('tool.invalidArguments');
    const timeout = AbortSignal.timeout(14_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const assert = () => { signal.throwIfAborted(); options.assertCurrent?.(); };
    const authorize = async () => { assert(); await options.authorize?.(); assert(); };
    await authorize();
    if (options.consume?.(checked.toolId) === false) throw new ToolFailure('tool.webBudgetExceeded');
    switch (checked.toolId) {
      case 'time.current': {
        const timezone = checked.input.timezone ?? this.dependencies.timezone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
        new Intl.DateTimeFormat('zh-CN', { timeZone: timezone });
        return { kind: 'time', iso: (this.dependencies.now?.() ?? new Date()).toISOString(), timezone };
      }
      case 'math.calculate': return { kind: 'calculation', result: calculate(checked.input.expression).result };
      case 'web.search': {
        const plugins = this.dependencies.webPlugins;
        const { results, engine } = await (plugins?.enabled
          ? plugins.search(checked.input.query, resultLimit, signal, assert)
          : searchWeb(this.dependencies.web, checked.input.query, resultLimit, signal, assert));
        await authorize();
        return { kind: 'search-excerpts', engine, results: results.slice(0, resultLimit).flatMap(item => {
          const url = cite(item.url);
          const title = excerpt(item.title, 100);
          return url && title ? [{ title, url, snippet: excerpt(item.snippet, 220) }] : [];
        }) };
      }
      case 'web.read': {
        const response = await this.dependencies.web.read(checked.input.url, signal, assert);
        await authorize();
        const source = cite(response.url);
        if (!source) throw new ToolFailure('tool.webTarget');
        const result = webToolContent(response, 'text', { maxCharacters: 1_200 });
        const text = excerpt(result.text, 1_200);
        if (!text) throw new ToolFailure('tool.network');
        return { kind: 'page-excerpt', source, excerpt: text, truncated: result.truncated || result.text.length > 1_200 };
      }
    }
  }
}
