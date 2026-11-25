import type { ServerResponse } from 'node:http';

/**
 * The background "最近和主人的事" summary is its own model request, made a while after chat turns.
 * Fixture model servers answer it here and leave it out of the requests a test counts as replies.
 */
const PROMPT = 'Summarize the owner’s recent plans';

interface Body { messages?: ReadonlyArray<{ role?: string; content?: unknown }> }

export const isRecentSummary = (body: Body | undefined): boolean =>
  body?.messages?.some((message) => message.role === 'system' && typeof message.content === 'string' && message.content.startsWith(PROMPT)) === true;

/** A neutral streamed summary, so nothing test-specific is injected into later turns. */
export const answerRecentSummary = (response: ServerResponse): void => {
  const content = JSON.stringify({ summary: '主人最近在做合成测试。' });
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`);
};
