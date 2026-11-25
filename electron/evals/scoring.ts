import type { AutoMemoryCase } from './cases/auto-memory';
import type { SleepCase } from './cases/memory-sleep';
import type { PersonaCase } from './cases/persona';

export interface Check { name: string; passed: boolean; detail?: string }
type Found = Array<{ text: string; evidence: number[] }>;

export const autoMemoryChecks = (item: AutoMemoryCase, reply: { finished: boolean }, found: Found | null, accepted: Found): Check[] => {
  const texts = accepted.map((entry) => entry.text);
  const checks: Check[] = [
    { name: '完整回复', passed: reply.finished },
    { name: '可解析 JSON', passed: found !== null },
  ];
  if (found === null) return checks;
  checks.push({ name: '全部通过主程序过滤', passed: accepted.length === found.length, detail: `${found.length - accepted.length} 条被过滤` });
  checks.push({ name: '格式：一句话，用户/The user 开头，≤120 字', passed: texts.every((text) => /^(?:用户|The user)/u.test(text) && text.length <= 120) });
  if (item.none) checks.push({ name: '不该保存', passed: texts.length === 0, detail: texts.join(' / ') });
  for (const capture of item.capture ?? []) checks.push({ name: `应记住：${capture.name}`, passed: texts.some((text) => capture.pattern.test(text)) });
  for (const forbid of item.forbid ?? []) checks.push({ name: `不应记住：${forbid.name}`, passed: !texts.some((text) => forbid.pattern.test(text)) });
  return checks;
};

export interface SleepPlan { merge: Array<{ ids: number[]; text: string; deep: boolean }>; promote: number[]; drop: number[] }

export const sleepChecks = (item: SleepCase, reply: { finished: boolean }, plan: SleepPlan | null): Check[] => {
  const checks: Check[] = [{ name: '完整回复', passed: reply.finished }, { name: '可解析 JSON', passed: plan !== null }];
  if (plan === null) return checks;
  const listed = new Set(item.entries.map((_, index) => index + 1));
  const used = [...plan.merge.flatMap((group) => group.ids), ...plan.promote, ...plan.drop];
  const kind = (n: number): string | undefined => item.entries[n - 1]?.kind;
  checks.push({ name: '编号合法且只用一次', passed: used.every((n) => listed.has(n)) && new Set(used).size === used.length });
  checks.push({ name: '每组至多一条 fixed', passed: plan.merge.every((group) => group.ids.filter((n) => kind(n) === 'fixed').length <= 1) });
  checks.push({ name: '只提升、删除 shallow', passed: [...plan.promote, ...plan.drop].every((n) => kind(n) === 'shallow') });
  const groupOf = (n: number) => plan.merge.find((group) => group.ids.includes(n));
  for (const expected of item.merge ?? []) {
    const group = groupOf(expected.ids[0]!);
    const together = group !== undefined && expected.ids.every((n) => group.ids.includes(n));
    checks.push({ name: `应合并：${expected.name}`, passed: together });
    if (together && !expected.ids.some((n) => kind(n) === 'fixed')) {
      for (const pattern of expected.text ?? []) checks.push({ name: `合并后保留：${pattern.name}`, passed: pattern.pattern.test(group.text), detail: group.text });
      for (const pattern of expected.notText ?? []) checks.push({ name: `合并后不应写：${pattern.name}`, passed: !pattern.pattern.test(group.text), detail: group.text });
      checks.push({ name: '合并文本格式', passed: /^(?:用户|The user)/u.test(group.text) && group.text.length <= 160, detail: group.text });
    }
  }
  for (const [a, b] of item.separate ?? []) {
    const group = groupOf(a);
    checks.push({ name: `不应合并：${a} 与 ${b}`, passed: !(group?.ids.includes(b) ?? false) });
  }
  for (const n of item.promote ?? []) checks.push({ name: `应提升：${n}`, passed: plan.promote.includes(n) || (groupOf(n)?.deep ?? false) });
  for (const n of item.drop ?? []) checks.push({ name: `应删除：${n}`, passed: plan.drop.includes(n) });
  for (const n of item.keep ?? []) checks.push({ name: `应保留：${n}`, passed: !plan.drop.includes(n) });
  if (item.maxPromote !== undefined) checks.push({ name: `提升不超过 ${item.maxPromote} 条`, passed: plan.promote.length <= item.maxPromote, detail: `${plan.promote.length} 条` });
  if (item.idle) checks.push({ name: '无需合并或删除', passed: plan.merge.length === 0 && plan.drop.length === 0 });
  return checks;
};

const DISCLAIMER = /作为(?:一个|一名)?(?:AI|人工智能|语言模型|助手)|我(?:只)?是(?:一个)?(?:AI|人工智能|语言模型)|as an AI|language model/iu;

export const personaChecks = (item: PersonaCase, reply: { text: string; finished: boolean }, addressUser: string): Check[] => {
  const text = reply.text.trim();
  const checks: Check[] = [
    { name: '完整回复', passed: reply.finished && text.length > 0 },
    { name: '不说“作为AI”套话', passed: !DISCLAIMER.test(text) },
    { name: '不带情绪标签残留', passed: !/^\s*\[(?:mood|心情)[:：]/iu.test(text) },
  ];
  if (!item.code) checks.push({ name: '聊天不用标题格式', passed: !/^#{1,6}\s/mu.test(text) });
  if (item.maxChars !== undefined) checks.push({ name: `长度 ≤ ${item.maxChars} 字`, passed: text.length <= item.maxChars, detail: `${text.length} 字` });
  if (item.address && addressUser) checks.push({ name: `称呼“${addressUser}”`, passed: text.includes(addressUser) });
  for (const pattern of item.must ?? []) checks.push({ name: `应包含：${pattern.name}`, passed: pattern.pattern.test(text) });
  for (const pattern of item.mustNot ?? []) checks.push({ name: `不应包含：${pattern.name}`, passed: !pattern.pattern.test(text) });
  return checks;
};
