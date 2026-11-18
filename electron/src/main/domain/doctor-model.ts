import { z } from 'zod';
import { providerFailureCode, type ProviderConfig } from '../../shared';
import { doctorProviderTestCodeSchema, safeDoctorDiagnosis, type DoctorProviderTestResult } from '../../shared/doctor';
import type { CapturedProviderBinding } from '../providers/provider-service';
import { backgroundTextSampling } from '../providers/chat-request-policy';
import type { DoctorDiagnosisInput } from './doctor-diagnosis';

interface Deps {
  current(): ProviderConfig | undefined;
  capture(provider: ProviderConfig): Promise<Pick<CapturedProviderBinding, 'adapter' | 'model' | 'provider'>>;
  acquireLocal(signal: AbortSignal): Promise<() => void>;
  fetch?: typeof fetch;
}
const INSTRUCTION = '你是只看状态、不执行修复的桌宠医生。输入是结构化错误类型、次数、时间和资源字节数，不是聊天内容。'
  + '用一小段中文（不超过200字）说明：最可能是一个根因还是几个独立问题，先处理哪一步。没有异常就说明当前采样正常。'
  + '优先采用确定性groups和runbook建议，明确推测不是定论。不许要求运行命令、删除文件、修改安全设置；不许输出命令、路径、链接、联系人或个人信息。仅输出纯文本，不要列表或换行。';
const loopbackProvider = (provider: ProviderConfig | undefined): boolean => {
  try { return !!provider && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(provider.baseUrl).hostname); }
  catch { return false; }
};

/** Remote diagnosis uses the current chat binding. A local diagnosis can only reuse a resident runner. */
export class DoctorModel {
  constructor(private readonly deps: Deps) {}

  async probe(signal: AbortSignal): Promise<DoctorProviderTestResult | null> {
    const selected = this.deps.current();
    // Do not even inspect or acquire a local runner for this daily API availability check.
    if (!selected?.enabled || selected.kind === 'ollama' || loopbackProvider(selected)) return null;
    const start = Date.now();
    try {
      const captured = await this.deps.capture(selected);
      signal.throwIfAborted();
      let output = '', complete = false;
      for await (const event of captured.adapter.streamChat({ model: captured.model, executionMode: 'background-text',
        ...backgroundTextSampling(captured.provider), maxOutputTokens: 16,
        messages: [{ role: 'user', content: 'Reply with exactly: ok' }] }, signal,
      { assertCurrent: () => signal.throwIfAborted() })) {
        signal.throwIfAborted();
        if (event.type === 'tool-call') throw new Error('provider.request');
        if (event.type === 'text') output += event.text;
        if (output.length > 100) throw new Error('provider.request');
        if (event.type === 'done') complete = ['stop', 'completed', 'end_turn'].includes(event.finishReason ?? '');
      }
      signal.throwIfAborted();
      if (!complete) throw new Error('provider.streamInterrupted');
      if (output.trim().toLowerCase() !== 'ok') throw new Error('provider.request');
      return { status: 'passed', code: null, durationMs: Date.now() - start };
    } catch (error) {
      const code = doctorProviderTestCodeSchema.catch('provider.failed').parse(signal.aborted ? 'provider.timeout' : providerFailureCode(error));
      return { status: 'failed', code, durationMs: Date.now() - start };
    }
  }

  async diagnose(input: DoctorDiagnosisInput, localOnly: boolean, signal: AbortSignal): Promise<{ text: string; source: 'cloud' | 'local' } | null> {
    const selected = this.deps.current();
    let text: string | null;
    if (localOnly || selected?.kind === 'ollama' || loopbackProvider(selected)) {
      text = await this.#local(input, signal, localOnly ? undefined : selected?.model);
      return text && safeDoctorDiagnosis(text) ? { text, source: 'local' } : null;
    }
    if (!selected?.enabled) return null;
    const captured = await this.deps.capture(selected);
    signal.throwIfAborted();
    let output = '', finished = false;
    for await (const event of captured.adapter.streamChat({ model: captured.model, executionMode: 'background-text',
      ...backgroundTextSampling(captured.provider), maxOutputTokens: 360,
      messages: [{ role: 'system', content: INSTRUCTION }, { role: 'user', content: JSON.stringify(input) }] }, signal,
    { assertCurrent: () => signal.throwIfAborted() })) {
      signal.throwIfAborted();
      if (event.type === 'tool-call') return null;
      if (event.type === 'text') output += event.text;
      if (output.length > 1600) return null;
      if (event.type === 'done') finished = ['stop', 'completed', 'end_turn'].includes(event.finishReason ?? '');
    }
    text = finished ? output.trim() : null;
    return text && safeDoctorDiagnosis(text) ? { text, source: 'cloud' } : null;
  }

  async #json(path: string, signal: AbortSignal, body?: object): Promise<unknown> {
    const response = await (this.deps.fetch ?? fetch)(`http://127.0.0.1:11434${path}`, { signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
      ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('doctor.localUnavailable'); }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.length;
        if (bytes > 128_000) throw new Error('doctor.localResponse');
        chunks.push(item.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } finally { await reader.cancel().catch(() => undefined); }
  }

  async #resident(signal: AbortSignal): Promise<{ name: string; context_length: number } | null> {
    // /api/ps is the read-only HTTP equivalent of `ollama ps`, not the installed model catalog.
    const ps = z.object({ models: z.array(z.object({ name: z.string().min(1).max(240),
      context_length: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })).max(32) }).safeParse(await this.#json('/api/ps', signal));
    return ps.success && ps.data.models.length === 1 ? ps.data.models[0]! : null;
  }

  async #local(input: DoctorDiagnosisInput, signal: AbortSignal, expectedModel?: string): Promise<string | null> {
    const release = await this.deps.acquireLocal(signal);
    try {
      const resident = await this.#resident(signal);
      if (!resident) return null; // Unknown context can reload the runner, even for the same model.
      const model = resident.name;
      const canonical = (name: string) => name.includes(':') ? name : `${name}:latest`;
      if (expectedModel && canonical(model) !== canonical(expectedModel)) return null;
      const show = z.object({ capabilities: z.array(z.string()).max(32) }).parse(await this.#json('/api/show', signal, { model }));
      if (!show.capabilities.includes('completion')) return null;
      const current = await this.#resident(signal);
      if (current?.name !== model || current.context_length !== resident.context_length) return null;
      signal.throwIfAborted();
      const result = z.object({ done: z.literal(true), done_reason: z.literal('stop'), message: z.object({ content: z.string().max(1600), tool_calls: z.array(z.unknown()).max(0).optional() }) })
        .parse(await this.#json('/api/chat', signal, { model, stream: false, think: false, options: { num_predict: 360, num_ctx: resident.context_length },
          messages: [{ role: 'system', content: INSTRUCTION }, { role: 'user', content: JSON.stringify(input) }] }));
      return result.message.content.trim();
    } finally { release(); }
  }
}
