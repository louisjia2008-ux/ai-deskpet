import type { AutoMemoryCase } from './cases/auto-memory';
import type { SleepCase } from './cases/memory-sleep';
import type { PersonaCase } from './cases/persona';

export interface Check { name: string; passed: boolean; detail?: string }
/** Judged on what the app saved, after its own filters and de-duplication. */
export const autoMemoryChecks = (item: AutoMemoryCase, saved: readonly string[]): Check[] => {
  const checks: Check[] = [
    { name: '格式：一句话，用户/The user 开头，≤120 字', passed: saved.every((text) => /^(?:用户|The user)/u.test(text) && text.length <= 120) },
  ];
  if (item.none) checks.push({ name: '不该保存', passed: saved.length === 0, detail: saved.join(' / ') });
  for (const capture of item.capture ?? []) checks.push({ name: `应记住：${capture.name}`, passed: saved.some((text) => capture.pattern.test(text)) });
  for (const forbid of item.forbid ?? []) checks.push({ name: `不应记住：${forbid.name}`, passed: !saved.some((text) => forbid.pattern.test(text)) });
  return checks;
};

export interface SleepChange { kind: 'merge' | 'promote' | 'drop' | 'expire'; before: string[]; after: string | null }

/** Judged on the changes the app applied and the memories it kept, not on the model's raw plan. */
export const sleepChecks = (item: SleepCase, changes: readonly SleepChange[], final: ReadonlyArray<{ text: string; layer: string }>): Check[] => {
  const checks: Check[] = [];
  const text = (n: number): string => item.entries[n - 1]!.text;
  const merges = changes.filter((change) => change.kind === 'merge');
  const removed = (n: number): boolean => changes.some((change) => (change.kind === 'drop' || change.kind === 'expire') && change.before.includes(text(n)));
  const members = (change: SleepChange): string[] => [...change.before, ...(change.after ? [change.after] : [])];
  for (const expected of item.merge ?? []) {
    const fixed = expected.ids.filter((n) => item.entries[n - 1]!.kind === 'fixed').map(text);
    const loose = expected.ids.filter((n) => item.entries[n - 1]!.kind !== 'fixed').map(text);
    const change = merges.find((candidate) => loose.every((entry) => candidate.before.includes(entry)) && fixed.every((entry) => candidate.after === entry));
    checks.push({ name: `应合并：${expected.name}`, passed: change !== undefined });
    if (change && fixed.length === 0) {
      const after = change.after ?? '';
      for (const pattern of expected.text ?? []) checks.push({ name: `合并后保留：${pattern.name}`, passed: pattern.pattern.test(after), detail: after });
      for (const pattern of expected.notText ?? []) checks.push({ name: `合并后不应写：${pattern.name}`, passed: !pattern.pattern.test(after), detail: after });
      checks.push({ name: '合并文本格式', passed: /^(?:用户|The user)/u.test(after) && after.length <= 160, detail: after });
      if (expected.deep) checks.push({ name: '合并结果进入深层', passed: final.some((memory) => memory.text === after && memory.layer === 'deep') });
    }
  }
  for (const [a, b] of item.separate ?? []) {
    checks.push({ name: `不应合并：${a} 与 ${b}`, passed: !merges.some((change) => members(change).includes(text(a)) && members(change).includes(text(b))) });
  }
  const deep = (n: number): boolean => final.some((memory) => memory.layer === 'deep' && (memory.text === text(n)
    || merges.some((change) => change.before.includes(text(n)) && change.after === memory.text)));
  for (const n of item.promote ?? []) checks.push({ name: `应提升：${n}`, passed: deep(n) });
  for (const n of item.shallow ?? []) checks.push({ name: `应留在浅层：${n}`, passed: !deep(n) });
  for (const n of item.drop ?? []) checks.push({ name: `应删除：${n}`, passed: removed(n) });
  // Kept means still there as written (a promotion keeps the text); being merged into something else is not keeping it.
  for (const n of item.keep ?? []) checks.push({ name: `应保留：${n}`, passed: final.some((memory) => memory.text === text(n)) });
  if (item.maxPromote !== undefined) {
    const before = item.entries.filter((entry) => entry.kind === 'deep').length, after = final.filter((memory) => memory.layer === 'deep').length;
    checks.push({ name: `深层新增不超过 ${item.maxPromote} 条`, passed: after - before <= item.maxPromote, detail: `${after - before} 条` });
  }
  if (item.idle) checks.push({ name: '无需合并或删除', passed: !changes.some((change) => change.kind !== 'promote') });
  return checks;
};

const DISCLAIMER = /作为(?:一个|一名)?(?:AI|人工智能|语言模型|助手)|我(?:只)?是(?:一个)?(?:AI|人工智能|语言模型)|as an AI|language model/iu;

export const personaChecks = (item: PersonaCase, reply: { text: string; finished: boolean }, addressUser: string): Check[] => {
  const text = reply.text.trim();
  const checks: Check[] = [
    { name: '完整回复', passed: reply.finished && text.length > 0 },
    { name: '不说“作为AI”套话', passed: item.selfDisclosure === true || !DISCLAIMER.test(text) },
    { name: '正文不带控制标签', passed: !/\[(?:mood|sticker)[:：]/iu.test(text) },
  ];
  if (!item.code) checks.push({ name: '聊天不用标题格式', passed: !/^#{1,6}\s/mu.test(text) });
  if (item.maxChars !== undefined) checks.push({ name: `长度 ≤ ${item.maxChars} 字`, passed: text.length <= item.maxChars, detail: `${text.length} 字` });
  if (item.address && addressUser) checks.push({ name: `称呼“${addressUser}”`, passed: text.includes(addressUser) });
  for (const pattern of item.must ?? []) checks.push({ name: `应包含：${pattern.name}`, passed: pattern.pattern.test(text) });
  for (const pattern of item.mustNot ?? []) checks.push({ name: `不应包含：${pattern.name}`, passed: !pattern.pattern.test(text) });
  return checks;
};
