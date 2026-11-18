import { expect, it, vi } from 'vitest';
import { OllamaKnowledgeEmbeddings } from './ollama-embedding';

it('does not load an embedding or evict another resident local model', async () => {
  const release = vi.fn(),
    request = vi.fn(async () => Response.json({ models: [{ name: 'a-chat-model' }] }));
  const embeddings = new OllamaKnowledgeEmbeddings(async () => release, request);
  await expect(embeddings.embed(['query'], new AbortController().signal)).rejects.toThrow('knowledge.localModelBusy');
  expect(request).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledOnce();
});

it('holds the local admission slot until the model disappears after keep_alive zero', async () => {
  const events: string[] = [];
  let dispatched = false,
    after = 0;
  const embeddings = new OllamaKnowledgeEmbeddings(
    async () => {
      events.push('acquire');
      return () => events.push('release');
    },
    async (url, opts) => {
      expect(String(url)).toMatch(/^http:\/\/127\.0\.0\.1:11434\/api\/(ps|embed|show)$/u);
      expect(opts?.redirect).toBe('error');
      if (String(url).endsWith('/show')) return Response.json({ details: { format: 'gguf' }, capabilities: ['embedding'] });
      if (String(url).endsWith('/embed')) {
        expect(JSON.parse(String(opts?.body))).toMatchObject({ model: 'nomic-embed-text', keep_alive: 0, truncate: false });
        dispatched = true;
        events.push('embed');
        return Response.json({ embeddings: [Array(768).fill(0.5)] });
      }
      const loaded = dispatched && after++ === 0;
      events.push(loaded ? 'loaded' : 'empty');
      return Response.json({ models: loaded ? [{ name: 'nomic-embed-text:latest' }] : [] });
    },
  );
  expect(await embeddings.embed(['query'], new AbortController().signal)).toHaveLength(1);
  expect(events).toEqual(['acquire', 'empty', 'embed', 'loaded', 'empty', 'release']);
});

it('blocks a cloud-backed Ollama alias before sending query or vault content', async () => {
  const bodies: string[] = [];
  const embedding = new OllamaKnowledgeEmbeddings(
    async () => () => undefined,
    async (url, opts) => {
      bodies.push(String(opts?.body ?? ''));
      if (String(url).endsWith('/ps')) return Response.json({ models: [] });
      if (String(url).endsWith('/show'))
        return Response.json({ remote_model: 'remote-alias', details: { format: 'gguf' }, capabilities: ['embedding'] });
      throw new Error('unexpected embedding request');
    },
  );
  await expect(embedding.embed(['sensitive local note'], new AbortController().signal)).rejects.toThrow(
    'knowledge.embeddingNotLocal',
  );
  expect(bodies.join('')).not.toContain('sensitive local note');
});

it('waits after its own recent chat turn for the matching runner to leave without evicting other models', async () => {
  let statusChecks = 0;
  let differentRunner = false;
  const requests: string[] = [];
  const embedding = new OllamaKnowledgeEmbeddings(
    async () => () => undefined,
    async (url) => {
      const path = new URL(String(url)).pathname;
      requests.push(path);
      if (path === '/api/ps') return Response.json({ models: differentRunner ? [{ name: 'external:latest' }]
        : statusChecks++ === 0 ? [{ name: 'chat-model:latest' }] : [] });
      if (path === '/api/show') return Response.json({ details: { format: 'gguf' }, capabilities: ['embedding'] });
      if (path === '/api/embed') return Response.json({ embeddings: [[1, 0]] });
      throw new Error('unexpected endpoint');
    },
  );
  embedding.expectChatRelease('chat-model');
  const signal = new AbortController().signal;
  expect(await embedding.embed(['query'], signal)).toEqual([[1, 0]]);
  expect(requests).toEqual(['/api/ps', '/api/ps', '/api/show', '/api/embed', '/api/ps']);
  requests.length = 0;
  differentRunner = true;
  await expect(embedding.embed(['query'], signal)).rejects.toThrow('knowledge.localModelBusy');
  expect(requests).toEqual(['/api/ps']);
});
