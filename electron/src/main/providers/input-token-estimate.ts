import { createHash } from 'node:crypto';
import { Tiktoken } from 'js-tiktoken/lite';
import cl100k from 'js-tiktoken/ranks/cl100k_base';

let encoder: Tiktoken | undefined;
const counts = new Map<string, number>();

/** Local reference BPE estimate, not provider-reported usage or proof of a
 * remote/local model's exact tokenizer. Counting the complete serialized JSON
 * already runs above what providers report (1.14x at the closest of 189 real
 * requests), so no further multiplier is applied.
 * Count the complete serialized request; never clip required content or tools.
 */
export const estimateSerializedInputTokens = (body: string): number => {
  const bytes = Buffer.byteLength(body, 'utf8');
  // Bound tokenizer work for pathological inputs; this conservative branch
  // will be rejected by the normal maximum context before any HTTP dispatch.
  if (bytes > 1_048_576) return bytes;
  const key = createHash('sha256').update(body).digest('hex');
  const cached = counts.get(key);
  if (cached !== undefined) return cached;
  encoder ??= new Tiktoken(cl100k);
  // Treat apparent special tokens in user/tool text as ordinary text.
  let reference = 0;
  // The pure-JS BPE merge is quadratic for a long unbroken piece. Bound each
  // encoding operation, retaining every UTF-16 code unit without splitting a
  // surrogate pair. Chunk boundaries add conservatism; no content is removed.
  for (let start = 0; start < body.length;) {
    let end = Math.min(body.length, start + 256);
    if (end < body.length && /[\uD800-\uDBFF]/u.test(body[end - 1]!)) end--;
    reference += encoder.encode(body.slice(start, end), [], []).length;
    start = end;
  }
  const result = reference;
  if (counts.size >= 16) counts.delete(counts.keys().next().value!);
  counts.set(key, result); // Only hashes/counts; no prompt strings retained.
  return result;
};
