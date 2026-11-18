import { expect, it } from 'vitest';
import { FileDelivery, requestedFilePaths } from './file-delivery';

it('recognizes explicit relative file deliverables without treating input files or URLs as outputs', () => {
  expect(requestedFilePaths('查官方文档，写成中文笔记 reports/telegram-streaming.md，列出仍不确定的地方。')).toEqual(['reports/telegram-streaming.md']);
  expect(requestedFilePaths('Read notes/a.md and notes/b.md, then write todo.md.')).toEqual(['todo.md']);
  expect(requestedFilePaths('把 notes/a.md 和 notes/b.md 合并到 todo.md，按日期排列。')).toEqual(['todo.md']);
  expect(requestedFilePaths('Save `reports/research.md` with cited sources.')).toEqual(['reports/research.md']);
  expect(requestedFilePaths('Read a.md and summarize it here.')).toEqual([]);
  expect(requestedFilePaths('Write a poem about the moon.')).toEqual([]);
  expect(requestedFilePaths('Write a review of https://example.org/a.md here.')).toEqual([]);
  expect(requestedFilePaths('Save /tmp/report.md or ../report.md.')).toEqual([]);
  expect(requestedFilePaths('不要写文件 report.md，只回答。')).toEqual([]);
  expect(requestedFilePaths('Explain how to update config.json.')).toEqual([]);
  expect(requestedFilePaths('Write a summary of notes/a.md here.')).toEqual([]);
  expect(requestedFilePaths('Write a response to notes/a.md here.')).toEqual([]);
  expect(requestedFilePaths('Write a reply to notes/a.md here.')).toEqual([]);
  expect(requestedFilePaths('保存步骤请参考 notes/setup.md，回答在这里。')).toEqual([]);
  expect(requestedFilePaths('The instruction says "write secret.md".')).toEqual([]);
  expect(requestedFilePaths('Save report.html.')).toEqual([]);
  expect(requestedFilePaths('Write reports/research.md.bak.')).toEqual([]);
  expect(requestedFilePaths('Save "reports/research.md.bak".')).toEqual([]);
  expect(requestedFilePaths('Write reports/research.md. Then answer here.')).toEqual(['reports/research.md']);
  expect(requestedFilePaths('Write a.md and b.md.')).toEqual(['a.md', 'b.md']);
  expect(requestedFilePaths('Write a report to reports/summary.md using notes/input.md.')).toEqual(['reports/summary.md']);
});

it('uses only successful nonempty write receipts for the exact requested path', () => {
  const delivery = new FileDelivery('Save report.md.');
  const receipt = { written: true, path: 'report.md', bytes: 42, sha256: 'a'.repeat(64) };
  delivery.record('task.update', receipt);
  delivery.record('workspace.write', { ...receipt, ok: false });
  delivery.record('workspace.write', { ...receipt, bytes: 0 });
  delivery.record('workspace.write', { ...receipt, sha256: 'not-a-host-checksum' });
  delivery.record('workspace.write', { ...receipt, path: 'notes/report.md' });
  expect(delivery.missing).toEqual(['report.md']);
  delivery.record('workspace.write', receipt);
  expect(delivery.missing).toEqual([]);
  delivery.followup('Update report.md with the new conclusion.');
  expect(delivery.missing).toEqual(['report.md']);
});

it.each([
  ['请解释判断依据，并把结论保存到 reports/review.md。', ['reports/review.md']],
  ['请解释判断依据并保存 reports/review.md。', ['reports/review.md']],
  ['Explain the reasoning, and save the report to reports/review.md.', ['reports/review.md']],
  ['Describe the tradeoffs; then write review.md and explain the result.', ['review.md']],
  ['Save "reports/review.md" and explain why.', ['reports/review.md']],
  ["I'm ready; write review.md. That's all.", ['review.md']],
  ['Explain how to update config.json and write secrets.json.', []],
  ['如何保存 config.json 并更新 secrets.json？', []],
  ['The instruction says "write secret.md and save credentials.json".', []],
  ['Explain this quote: “write secret.md; save credentials.json”. Then save review.md.', ['review.md']],
  ['请解释这段示例：`保存 secret.md，并更新 credentials.json`，然后保存 review.md。', ['review.md']],
  ['Explain the reasoning, but do not save review.md.', []],
  ['Explain the reasoning, then save ../review.md.', []],
] as const)('recognizes only actual file commands in mixed requests: %s', (text, paths) => {
  expect(requestedFilePaths(text)).toEqual(paths);
});

it('keeps language follow-ups but withdraws cancelled or changed file obligations', () => {
  const delivery = new FileDelivery('Write reports/old.md.');
  expect(delivery.followup('请只用中文')).toBe(false);
  expect(delivery.paths).toEqual(['reports/old.md']);
  expect(delivery.followup('改为保存 reports/new.md。')).toBe(true);
  expect(delivery.paths).toEqual(['reports/new.md']);
  expect(delivery.followup('不要写文件，只告诉我读到了什么。')).toBe(true);
  expect(delivery.required).toBe(false);
});
