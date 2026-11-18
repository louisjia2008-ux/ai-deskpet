/* @vitest-environment node */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearInterval, setInterval } from 'node:timers';
import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { OllamaKnowledgeEmbeddings } from '../../src/main/knowledge/ollama-embedding';
import { VaultKnowledgeService } from '../../src/main/knowledge/vault-index';
import { KNOWLEDGE_EMBEDDING_MODELS, KNOWLEDGE_EMBEDDING_PREFIXES } from '../../src/shared/knowledge-embedding';

function rssMiB(): number {
  const lines = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,comm='], { encoding: 'utf-8' }).trim().split('\n');
  const rows = lines.flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), kib: Number(match[3]), command: match[4]! }] : [];
  });
  const processes = new Set(rows.filter(row => /(?:^|\/)ollama$/iu.test(row.command)).map(row => row.pid));
  let added: boolean;
  do {
    added = false;
    for (const row of rows) {
      if (processes.has(row.parent) && !processes.has(row.pid)) {
        processes.add(row.pid);
        added = true;
      }
    }
  } while (added);
  return rows.reduce((sum, row) => sum + (processes.has(row.pid) ? row.kib : 0), 0) / 1024;
}

async function residentProbe(model: typeof KNOWLEDGE_EMBEDDING_MODELS[number], input: string, signal: AbortSignal) {
  const samples: Array<{ name: string; size: number; size_vram: number }> = [];
  let rss = 0;
  const probe = new OllamaKnowledgeEmbeddings(async () => () => undefined, async (url, options) => {
    if (!String(url).endsWith('/api/embed')) return fetch(url, options);
    const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
    const response = await fetch(url, { ...options, body: JSON.stringify({ ...body, keep_alive: '2s' }) });
    if (response.ok) {
      // A normal keep_alive:0 batch may unload before the sampler sees Metal's
      // runner. Keep this one synthetic probe briefly resident to get its allocation.
      const status = await fetch('http://127.0.0.1:11434/api/ps', { signal, redirect: 'error' });
      const payload = await status.json() as { models: typeof samples };
      samples.push(...payload.models);
      rss = rssMiB();
    }
    return response;
  });
  await probe.embed([input], signal, model);
  expect(samples).toHaveLength(1);
  const sample = samples[0]!;
  expect([model, model + ':latest']).toContain(sample.name);
  expect(sample.size).toBeGreaterThan(0);
  return { rss, runnerAllocationMiB: sample.size / 1024 ** 2, gpuAllocationMiB: sample.size_vram / 1024 ** 2 };
}

function cosine(a: number[], b: number[]): number {
  const product = a.reduce((n, x, i) => n + x * b[i]!, 0);
  const norm = (v: number[]) => Math.sqrt(v.reduce((n, x) => n + x * x, 0));
  return product / (norm(a) * norm(b));
}

it.skipIf(process.env.DESKPET_KNOWLEDGE_BENCHMARK !== '1')('benchmarks Ollama models on a synthetic Chinese vault', async () => {
  const fixture = join(process.cwd(), 'tests', 'fixtures', 'knowledge-embedding');
  const root = join(fixture, 'vault');
  const questions = JSON.parse(await readFile(join(fixture, 'queries.json'), 'utf-8')) as Array<{ query: string; expected: string }>;
  const documentPaths = new Map<string, string>();
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const path = join(entry.parentPath, entry.name);
    documentPaths.set(await readFile(path, 'utf-8'), path.slice(root.length + 1).normalize('NFC'));
  }
  expect(documentPaths.size).toBe(40);
  expect(questions).toHaveLength(30);
  const scratch = await mkdtemp(join(tmpdir(), 'deskpet-knowledge-benchmark-'));
  const key = randomBytes(32);
  const signal = AbortSignal.timeout(300_000);
  const adapter = new OllamaKnowledgeEmbeddings(async () => () => undefined);
  try {
    for (let i = 0; i < KNOWLEDGE_EMBEDDING_MODELS.length; i++) {
      const model = KNOWLEDGE_EMBEDDING_MODELS[i]!;
      const prefixes = KNOWLEDGE_EMBEDDING_PREFIXES[model];
      expect(await adapter.status(model, signal)).toBe('installed');
      const sourceVectors = new Map<string, number[]>();
      const service = new VaultKnowledgeService({
        directory: join(scratch, String(i)),
        vault: { getVaultKey: async () => key },
        embeddings: {
          embed: async (batch, batchSignal, selected) => {
            expect(selected).toBe(model);
            const vectors = await adapter.embed(batch, AbortSignal.any([signal, batchSignal]), selected);
            for (let index = 0; index < batch.length; index++) {
              const fixturePath = documentPaths.get(batch[index]!.slice(prefixes.documentPrefix.length));
              expect(fixturePath).toBeDefined();
              sourceVectors.set(fixturePath!, vectors[index]!.map(Math.fround));
            }
            return vectors;
          },
        },
      });
      await service.initialize();
      await service.setEmbeddingModel(model);
      await service.selectRoot(root);
      const baseline = rssMiB();
      expect(baseline).toBeGreaterThan(0);
      let peak = baseline;
      const sampler = setInterval(() => { peak = Math.max(peak, rssMiB()); }, 100);
      let elapsed: number;
      try {
        const started = performance.now();
        expect(await service.reindex()).toMatchObject({ indexedNotes: 40, indexedChunks: 40, lastError: null });
        elapsed = performance.now() - started;
      } finally {
        clearInterval(sampler);
        service.dispose();
      }
      expect(sourceVectors.size).toBe(40);
      let topFive = 0;
      let reciprocal = 0;
      for (let start = 0; start < questions.length; start += 16) {
        const batch = questions.slice(start, start + 16);
        const vectors = await adapter.embed(batch.map(({ query }) => prefixes.queryPrefix + query), signal, model);
        for (let index = 0; index < batch.length; index++) {
          const nearest = [...sourceVectors].map(([path, v]) => ({ path, score: cosine(v, vectors[index]!) }))
            .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
          const rank = nearest.findIndex(item => item.path === batch[index]!.expected) + 1;
          expect(rank).toBeGreaterThan(0);
          if (rank <= 5) topFive++;
          reciprocal += 1 / rank;
        }
      }
      const memory = await residentProbe(model, prefixes.documentPrefix + [...documentPaths.keys()].sort((a, b) => b.length - a.length)[0]!, signal);
      process.stdout.write(JSON.stringify({
        model, topFive, questions: questions.length, recallAt5: topFive / questions.length, mrr: reciprocal / questions.length,
        dimensions: sourceVectors.values().next().value?.length, indexSeconds: elapsed / 1000, rssBaselineMiB: baseline,
        indexRssPeakMiB: peak, loadedRssMiB: memory.rss, runnerAllocationMiB: memory.runnerAllocationMiB,
        gpuAllocationMiB: memory.gpuAllocationMiB,
      }) + '\n');
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 310_000);
