import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenAICompatibleAdapter } from '../src/main/providers/openai-compatible';
import type { ProviderChatMessage, ProviderChatRequest } from '../src/main/providers/types';
import type { ProviderConfig } from '../src/shared';

/**
 * Quality evals call a real model through the production adapter, with the production instructions and parsers.
 * The key comes from OPENAI_API_KEY or the macOS keychain item `deskpet-eval` / `openai`, never from the app profile.
 * Results go to DESKPET_EVAL_OUT (default eval-results/, ignored by git): they hold model output, which can quote
 * the persona.
 */
export interface EvalSettings { model: string; judgeModel: string; baseUrl: string; out: string; repeat: number }

export const evalSettings = (): EvalSettings => ({
  model: process.env.DESKPET_EVAL_MODEL ?? 'gpt-6.2-sol',
  judgeModel: process.env.DESKPET_EVAL_JUDGE_MODEL ?? process.env.DESKPET_EVAL_MODEL ?? 'gpt-6.2-sol',
  baseUrl: process.env.DESKPET_EVAL_BASE_URL ?? 'https://api.openai.com/v1',
  out: process.env.DESKPET_EVAL_OUT ?? join(process.cwd(), 'eval-results'),
  repeat: Math.max(1, Number.parseInt(process.env.DESKPET_EVAL_REPEAT ?? '1', 10) || 1),
});

let cachedKey: string | null = null;
const apiKey = (): string => {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env.OPENAI_API_KEY?.trim();
  if (fromEnv) return (cachedKey = fromEnv);
  try {
    cachedKey = execFileSync('security', ['find-generic-password', '-s', 'deskpet-eval', '-a', 'openai', '-w'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('No OpenAI key: set OPENAI_API_KEY, or run once: security add-generic-password -s deskpet-eval -a openai -w');
  }
  if (!cachedKey) throw new Error('The deskpet-eval keychain item is empty.');
  return cachedKey;
};

const adapters = new Map<string, OpenAICompatibleAdapter>();
const adapter = (model: string, baseUrl: string): OpenAICompatibleAdapter => {
  const key = `${baseUrl}|${model}`;
  let found = adapters.get(key);
  if (!found) {
    const config: ProviderConfig = { id: 'eval-openai', kind: 'openai', name: 'Eval', baseUrl, model, enabled: true, supportsTools: false, secretState: 'configured' };
    found = new OpenAICompatibleAdapter({ config, apiKey: apiKey() });
    adapters.set(key, found);
  }
  return found;
};

export interface Completion { text: string; finished: boolean; ms: number }

/** One request exactly as the background tasks send it (official OpenAI: Responses, default sampling). */
export const complete = async (messages: ProviderChatMessage[], options: { model?: string; executionMode?: ProviderChatRequest['executionMode']; maxOutputTokens?: number } = {}): Promise<Completion> => {
  const settings = evalSettings(), model = options.model ?? settings.model, started = Date.now();
  let text = '', finished = false;
  const request: ProviderChatRequest = { model, messages, ...(options.executionMode ? { executionMode: options.executionMode } : {}),
    ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}) };
  for await (const event of adapter(model, settings.baseUrl).streamChat(request, AbortSignal.timeout(240_000))) {
    if (event.type === 'text') text += event.text;
    if (event.type === 'done' && (event.finishReason === 'stop' || event.finishReason === 'completed')) finished = true;
  }
  return { text, finished, ms: Date.now() - started };
};

export interface JudgeScore { score: number; max: number; reasons: string }

/** A model grades one output against a rubric; the reply must be {"score":n,"reasons":"..."}. */
export const judge = async (rubric: string, material: unknown, max: number): Promise<JudgeScore> => {
  const settings = evalSettings();
  const system = `You grade the output of a personal desktop companion app. Apply the rubric strictly and consistently. `
    + `Return ONLY one JSON object {"score":integer 0-${max},"reasons":"one or two short sentences in Chinese"}. No markdown.\n\nRubric:\n${rubric}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reply = await complete([{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(material) }], { model: settings.judgeModel, executionMode: 'background-text' });
    try {
      const parsed = JSON.parse(reply.text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '')) as { score?: unknown; reasons?: unknown };
      const score = Number(parsed.score);
      if (Number.isInteger(score) && score >= 0 && score <= max) return { score, max, reasons: String(parsed.reasons ?? '') };
    } catch { /* Ask once more. */ }
  }
  return { score: 0, max, reasons: 'judge-unparseable' };
};

export interface CaseResult {
  suite: string; id: string; title: string; run: number;
  checks: Array<{ name: string; passed: boolean; detail?: string }>;
  judge?: JudgeScore;
  output: unknown; ms: number; error?: string;
}

/** Programmatic checks weigh as much as the judge: each half of a case is worth 1. */
export const caseScore = (result: CaseResult): number => {
  if (result.error) return 0;
  const checks = result.checks.length === 0 ? 1 : result.checks.filter((check) => check.passed).length / result.checks.length;
  return result.judge ? (checks + result.judge.score / result.judge.max) / 2 : checks;
};

export const writeReport = (suite: string, results: CaseResult[]): string => {
  const settings = evalSettings(), stamp = new Date().toISOString().replaceAll(':', '-');
  const directory = join(settings.out, suite);
  mkdirSync(directory, { recursive: true });
  const total = results.length === 0 ? 0 : results.reduce((sum, result) => sum + caseScore(result), 0) / results.length;
  const lines = [`# ${suite} · ${(total * 100).toFixed(1)}%`, '', `model ${settings.model} · judge ${settings.judgeModel} · ${results.length} runs · ${new Date().toISOString()}`, '',
    '| case | run | score | failed checks | judge |', '|---|---|---|---|---|',
    ...results.map((result) => `| ${result.id} ${result.title} | ${result.run} | ${(caseScore(result) * 100).toFixed(0)}% | ${result.error ? `error: ${result.error}` : result.checks.filter((check) => !check.passed).map((check) => `${check.name}${check.detail ? ` (${check.detail})` : ''}`).join('; ')} | ${result.judge ? `${result.judge.score}/${result.judge.max} ${result.judge.reasons}` : ''} |`)];
  writeFileSync(join(directory, `${stamp}.md`), `${lines.join('\n')}\n`);
  writeFileSync(join(directory, `${stamp}.json`), JSON.stringify({ suite, settings: { ...settings, out: undefined }, total, results }, null, 2));
  return `${(total * 100).toFixed(1)}% → ${join(directory, `${stamp}.md`)}`;
};

/** Runs every case `repeat` times, two at a time, and never lets one failure stop the suite. */
export const runCases = async <C extends { id: string; title: string }>(suite: string, cases: readonly C[], run: (item: C) => Promise<Omit<CaseResult, 'suite' | 'id' | 'title' | 'run'>>): Promise<CaseResult[]> => {
  apiKey(); // A missing key stops the suite here instead of writing a report of errors.
  const settings = evalSettings(), jobs = cases.flatMap((item) => Array.from({ length: settings.repeat }, (_, index) => ({ item, run: index + 1 })));
  const results: CaseResult[] = [];
  const worker = async (): Promise<void> => {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      const started = Date.now();
      try { results.push({ suite, id: job.item.id, title: job.item.title, run: job.run, ...(await run(job.item)) }); }
      catch (error) { results.push({ suite, id: job.item.id, title: job.item.title, run: job.run, checks: [], output: null, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) }); }
    }
  };
  await Promise.all([worker(), worker()]);
  return results.sort((a, b) => a.id.localeCompare(b.id) || a.run - b.run);
};
