import { afterAll, expect, it } from 'vitest';
import { AUTO_MEMORY_INSTRUCTION, acceptAutoMemories, parseAutoMemoryOutput } from '../src/main/domain/auto-memory';
import { autoMemoryCases } from './cases/auto-memory';
import { autoMemoryChecks } from './scoring';
import { complete, judge, runCases, writeReport } from './runner';
import type { CaseResult } from './runner';

const RUBRIC = `The app read recent messages the user wrote and saved the "accepted" entries to the user's long-term profile; "known" was already saved.
Score 0-4, one point each:
1. Every accepted entry is stated by the user in the messages it cites; nothing is guessed, embellished or taken from quoted or pasted text.
2. Every accepted entry will still matter in later conversations (identity, ongoing goals, lasting preferences, people and pets, routines), not a one-off request, question, passing mood or finished task.
3. Nothing sensitive (passwords, codes, numbers, other people's contact details) and nothing a known fact already covers.
4. No lasting fact the user clearly stated was missed. If nothing should have been saved and nothing was, give this point.
Entries are one self-contained sentence; ignore minor wording.`;

let results: CaseResult[] = [];
afterAll(() => { if (results.length) process.stdout.write(`auto-memory ${writeReport('auto-memory', results)}\n`); });

it('extracts lasting facts and nothing else', async () => {
  results = await runCases('auto-memory', autoMemoryCases, async (item) => {
    const messages = item.messages.map((text, index) => ({ n: index + 1, text }));
    const reply = await complete([
      { role: 'system', content: AUTO_MEMORY_INSTRUCTION },
      { role: 'user', content: JSON.stringify({ known: item.known ?? [], messages }) },
    ], { executionMode: 'background-text' });
    let found: ReturnType<typeof parseAutoMemoryOutput> | null = null;
    try { found = parseAutoMemoryOutput(reply.text); } catch { /* Scored below as unparseable. */ }
    const accepted = found ? acceptAutoMemories(found, new Set(messages.map((message) => message.n))) : [];
    const checks = autoMemoryChecks(item, reply, found, accepted);
    const verdict = found ? await judge(RUBRIC, { known: item.known ?? [], messages, accepted }, 4) : undefined;
    return { checks, ...(verdict ? { judge: verdict } : {}), output: { raw: reply.text, accepted }, ms: reply.ms };
  });
  expect(results.length).toBeGreaterThan(0);
});
