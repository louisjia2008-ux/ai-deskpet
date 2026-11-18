/** A bounded completion check for explicit file requests. It consumes only the
 * owner's current request/follow-ups and host tool receipts, never page text,
 * plans or a model's claim that a file was written. It grants no permission. */
const WRITE_INTENT = /写(?:成|入|到)|保存(?:为|到)?|输出(?:为|到)|合并(?:成|到|为)|生成|更新|\b(?:write|save|export|create|produce|generate|update|edit)\b/giu;
const CANCEL_WRITE = /(?:不要|不用|不必|无需|别|停止|取消).{0,24}(?:写|保存|文件|报告|任务)|\b(?:do not|don't|stop|cancel|skip)\b.{0,32}\b(?:writ\w*|sav\w*|file|report|task)\b/iu;
const EXPLANATORY = /如何|怎么|怎样|解释|说明|示例|例如|举例|提示词|引用|这段|步骤|\b(?:explain|describe|how|example|quote\w*|prompt|instruction|said|says|whether|what|if)\b/iu;
const QUESTION = /^\s*(?:如何|怎么|怎样|请问|请教我|(?:explain\s+)?(?:how|whether|what|if)\b)/iu;
const QUOTED = /`[^`]*`|"[^"]*"|(?<![\p{L}\p{N}])'[^']*'|“[^”]*”|‘[^’]*’/gu;
// Match an output at the beginning of the target phrase, never an arbitrary
// filename later in "write a summary of input.md here". Only writable types.
const PATH = /^[\s`"']*((?:[\p{L}\p{N}_][\p{L}\p{N}_.-]*\/)*[\p{L}\p{N}_][\p{L}\p{N}_.-]*\.(?:md|txt|csv|json))(?=$|[\s`"'，。；、,;:：)）!?！？]|\.(?=$|[\s`"'，。；、,;:：)）!?！？]))/iu;

const canonicalPath = (value: string): string | null => {
  const path = value.replace(/^\.\//u, '');
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').some(part => part === '.' || part === '..' || !part)) return null;
  return path;
};

export const requestedFilePaths = (text: string): string[] => {
  if (CANCEL_WRITE.test(text)) return [];
  const quotes = [...text.matchAll(QUOTED)].map(match => ({ start: match.index!, end: match.index! + match[0].length }));
  const result = new Set<string>();
  for (const part of text.matchAll(/[^\n。；;!?！？]+/gu)) {
    const clause = part[0];
    if (QUESTION.test(clause)) continue;
    for (const intent of clause.matchAll(WRITE_INTENT)) {
      const position = part.index! + intent.index!;
      if (quotes.some(quote => position >= quote.start && position < quote.end)) continue;
      // An explanatory clause does not veto a separate imperative. Keep the
      // guard local to the current command, not the whole owner's request.
      const prefix = clause.slice(0, intent.index).split(/[,，]|\b(?:and|then|but)\b|并(?:且)?|然后|但是/iu).at(-1)!;
      if (EXPLANATORY.test(prefix)) continue;
      let target = clause.slice(intent.index! + intent[0].length).trimStart();
      if (/^[a-z]/iu.test(intent[0])) {
        target = target.replace(/^(?:(?:the|a|an)\s+)?file\s+/iu, '');
        if (!PATH.test(target)) {
          const position = /^(?:(?:the|a|an)\s+)?(?:report|summary|notes?|draft|document|output|results?|data|list|plan|analysis|text|content|table|it|this|that)\s+(?:to|as|into)\s+(?=[`"']?[\p{L}\p{N}_])/iu.exec(target);
          if (!position) continue;
          target = target.slice(position[0].length);
        }
      } else target = target.replace(/^(?:一(?:份|个|篇))?(?:中文|英文)?(?:研究)?(?:报告|笔记|文件|草稿)?\s*/u, '');
      for (let count = 0; count < 5; count += 1) {
        const match = PATH.exec(target);
        if (!match) break;
        const path = canonicalPath(match[1]!);
        if (path) result.add(path);
        const remaining = target.slice(match[0].length).replace(/^[`"']/u, '');
        const separator = /^\s*(?:and\b|和|、|,|，|&)\s*/iu.exec(remaining);
        if (!separator) break;
        target = remaining.slice(separator[0].length);
      }
    }
  }
  return result.size <= 4 ? [...result] : [];
};

export class FileDelivery {
  #paths: string[];
  readonly #written = new Set<string>();
  webFailures = 0;
  sourcesRead = 0;

  constructor(request: string) { this.#paths = requestedFilePaths(request); }
  get paths(): string[] { return [...this.#paths]; }
  get missing(): string[] { return this.#paths.filter(path => !this.#written.has(path)); }
  get required(): boolean { return this.#paths.length > 0; }

  followup(text: string): boolean {
    const next = requestedFilePaths(text);
    if (!CANCEL_WRITE.test(text) && next.length === 0) return false;
    this.#paths = next;
    // Repeating an output target in a new instruction requires a new write.
    for (const path of next) this.#written.delete(path);
    return true;
  }

  record(toolId: string, output: unknown): void {
    if (!output || typeof output !== 'object' || Array.isArray(output)) return;
    const value = output as Record<string, unknown>;
    if (value.ok === false || value.skipped === true) return;
    if ((toolId === 'web.read' || (toolId.startsWith('mcp.') && value.source))
      && typeof value.text === 'string' && value.text.trim()) this.sourcesRead += 1;
    if (toolId !== 'workspace.write' || value.written !== true || typeof value.path !== 'string'
      || typeof value.bytes !== 'number' || value.bytes <= 0 || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)) return;
    const path = canonicalPath(value.path);
    if (path) this.#written.add(path);
  }
}
