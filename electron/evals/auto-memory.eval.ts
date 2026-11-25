import { afterAll, expect, it } from 'vitest';
import { AutoMemoryService, parseAutoMemoryOutput } from '../src/main/domain/auto-memory';
import { ChatService } from '../src/main/domain/chat-service';
import { autoMemoryCases } from './cases/auto-memory';
import { recordingAdapter, scratchRepository, storedMemory } from './production';
import { autoMemoryChecks } from './scoring';
import { evalProvider, evalSettings, judge, runCases, writeReport } from './runner';
import type { CaseResult } from './runner';

const RUBRIC = `The app's background reader saw "sent" (the owner's recent messages it was allowed to read, and "known", facts already saved) and saved "saved" to the owner's long-term profile.
Score 0-4, one point each:
1. Every saved entry is stated by the owner in the messages; nothing is guessed, embellished or taken from quoted or pasted text. (Nothing saved: give the point.)
2. Every saved entry will still matter in later conversations (identity, ongoing goals, lasting preferences, people and pets, routines), not a one-off request, question, passing mood or finished task. (Nothing saved: give the point.)
3. Nothing sensitive (passwords, codes, long numbers, other people's contact details) and nothing a known fact already covers. (Nothing saved: give the point.)
4. No lasting fact the owner clearly stated in "sent" was missed. If nothing in "sent" deserved saving, give the point.
Entries are one self-contained sentence; ignore minor wording.`;

let results: CaseResult[] = [];
afterAll(() => { if (results.length) process.stdout.write(`auto-memory ${writeReport('auto-memory', results)}\n`); });

it('saves lasting facts and nothing else, as the app does', async () => {
  results = await runCases('auto-memory', autoMemoryCases, async (item) => {
    const { repository, dispose } = await scratchRepository();
    try {
      const now = new Date().toISOString();
      const known = (item.known ?? []).map((text) => storedMemory(text, { origin: 'auto-profile', layer: 'deep', updatedAt: now }));
      await repository.transaction((state) => { state.autoMemory.enabled = true; state.memories.push(...structuredClone(known)); });
      const chat = new ChatService(repository), session = await chat.createSession('Eval', 'normal');
      for (const content of item.messages) await chat.addMessage({ sessionId: session.id, role: 'user', content, status: 'complete', errorCode: null });
      const provider = evalProvider(), recorder = recordingAdapter();
      const service = new AutoMemoryService(repository, { available: () => true, idleMs: 0, channelSessionAllowed: () => false,
        captureBinding: async () => ({ provider, model: provider.model, adapter: recorder.adapter,
          inspection: { contextWindowTokens: null, executionDestination: 'unknown', source: 'unknown' } }) });
      service.note(session.id, { providerId: provider.id, model: evalSettings().model, destination: 'remote' });
      const started = Date.now();
      await service.tick();
      const reply = recorder.replies[0], request = recorder.requests[0];
      // The service records a failed read instead of throwing; a request that never got an answer is an error, not a score.
      const failure = service.attempts().errorCode;
      if (request && (!reply || reply.text === '') && failure) throw new Error(failure);
      const sent = request ? JSON.parse(request.messages[1]!.content) as { known: string[]; messages: Array<{ n: number; text: string }> } : { known: [], messages: [] };
      const knownIds = new Set(known.map((memory) => memory.id));
      const saved = repository.snapshot().memories.filter((memory) => !knownIds.has(memory.id)).map((memory) => memory.text);
      let proposed: string[] | null = null;
      if (reply) { try { proposed = parseAutoMemoryOutput(reply.text).map((entry) => entry.text); } catch { /* Invalid below. */ } }
      const invalid = !reply ? undefined : !reply.finished ? 'reply cut off' : proposed === null ? 'not the requested JSON' : undefined;
      const checks = autoMemoryChecks(item, saved);
      const verdict = invalid ? undefined : await judge(RUBRIC, { sent, saved }, 4);
      return { checks, ...(verdict ? { judge: verdict } : {}), ...(invalid ? { invalid } : {}),
        output: { sent: Boolean(request), raw: reply?.text ?? null, proposed, saved, status: service.attempts().errorCode ?? null }, ms: Date.now() - started };
    } finally { await dispose(); }
  });
  expect(results.length).toBeGreaterThan(0);
});
