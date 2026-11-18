export const KNOWLEDGE_EMBEDDING_MODELS = ['nomic-embed-text', 'bge-m3', 'qwen3-embedding:0.6b'] as const;
export type KnowledgeEmbeddingModel = typeof KNOWLEDGE_EMBEDDING_MODELS[number];
export type KnowledgeEmbeddingStatus = 'unknown' | 'installed' | 'missing' | 'unavailable';

export const DEFAULT_KNOWLEDGE_EMBEDDING_MODEL: KnowledgeEmbeddingModel = 'bge-m3';

export const KNOWLEDGE_EMBEDDING_PREFIXES: Record<KnowledgeEmbeddingModel, { documentPrefix: string; queryPrefix: string }> = {
  'nomic-embed-text': { documentPrefix: 'search_document: ', queryPrefix: 'search_query: ' },
  'bge-m3': { documentPrefix: '', queryPrefix: '' },
  'qwen3-embedding:0.6b': { documentPrefix: '', queryPrefix: 'Instruct: 根据查询检索最相关的笔记片段\nQuery: ' },
};
