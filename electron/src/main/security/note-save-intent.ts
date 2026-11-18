const sentenceEnd = /[。！？!?\r\n]/u;
const quotedText = /“[^”]*(?:”|$)|‘[^’]*(?:’|$)|「[^」]*(?:」|$)|『[^』]*(?:』|$)|《[^》]*(?:》|$)|〈[^〉]*(?:〉|$)|"[^"]*(?:"|$)|(?:^|\s)'[^']*(?:'|$)/gu;
const reportingIntro = /^(?:>|fwd\b|(?:请\s*)?(?:帮我\s*)?(?:转发|引用|转述|复述|翻译|举例|示例|例句))/iu;
const imperative = /^(?:(?:请\s*)?(?:帮我\s*)?(?:记一下|记录一下|存一下|记下来|新建(?:一篇)?笔记)|(?:请\s*)?帮我\s*记(?!得|忆|性|载))/u;
const referentialImperative = /^(?:请\s*)?(?:帮我\s*)?(?:把\s*)?这(?:个|段|条|份)(?:内容)?\s*(?:记下来|存起来|保存下来|存下来)/u;
const noteTarget = /笔记(?:库|里)?/gu;
const noteAction = /保存|存|记录|记(?!得|忆|性|载)|写|新建|整理/gu;
// 不错 / 不少 are praise or quantity, not refusals.
const conditionalOrNegative = /不(?!错|少)|别|没|如果|假如|要是|是否|怎么|如何/u;

/** Only the bounded first sentence of the current owner's text can authorize a save. */
export function explicitNoteSaveRequest(text: string): boolean {
  const normalized = text.normalize('NFKC').trim();
  const end = normalized.search(sentenceEnd);
  const sentence = end === -1 ? normalized : normalized.slice(0, end);
  if (normalized[end] === '?' || /[吗么]\s*$/u.test(sentence)) return false;

  const instruction = Array.from(sentence).slice(0, 80).join('').replace(quotedText, ' ').split(':', 1)[0]?.trim() ?? '';
  if (!instruction || reportingIntro.test(instruction) || /[吗么]$/u.test(instruction)) return false;
  if (imperative.test(instruction) || referentialImperative.test(instruction)) return true;
  if (/^(?:please\s+)?(?:save|add|write)\s+(?:this|a note)\s+(?:to|in)\s+(?:my\s+)?(?:notes|vault)\.?$/iu.test(instruction)) return true;

  const target = [...instruction.matchAll(noteTarget)].at(-1);
  if (!target) return false;
  // Match the action next to the note target. Earlier unrelated actions could hide a later refusal.
  const directive = instruction.replace(noteTarget, value => ' '.repeat(value.length));
  const actions = [...directive.matchAll(noteAction)];
  const before = actions.filter(action => action.index < target.index).at(-1);
  const after = actions.find(action => action.index > target.index);
  const beforeDistance = before ? target.index - before.index - before[0].length : Infinity;
  const afterDistance = after ? after.index - target.index - target[0].length : Infinity;
  const action = beforeDistance < afterDistance ? before : after;
  return action !== undefined && !conditionalOrNegative.test(directive.slice(0, action.index));
}
