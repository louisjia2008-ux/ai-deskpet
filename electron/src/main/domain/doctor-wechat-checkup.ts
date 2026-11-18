/** One bounded owner-command reply. Prefer removing healthy lists over truncating the diagnosis or VM facts. */
export const compactWeChatCheckup = (text: string): string => {
  const size = (value: string) => [...value].length;
  const lines = text.split('\n').filter(Boolean);
  if (size(text) <= 500) return text;
  const important = lines.filter(line => !/^(?:正常|还没运行过|未开启)：/u.test(line));
  if (size(important.join('\n')) <= 500) return important.join('\n');
  const details = important.filter(line => /^\s*-/u.test(line));
  const essential = important.filter(line => !/^\s*-/u.test(line));
  const omitted = '其余项目见桌宠「动态 → 医生」。';
  const result = [...essential];
  for (const line of details) {
    if (size([...result, line, omitted].join('\n')) > 500) break;
    result.push(line);
  }
  result.push(omitted);
  return [...result.join('\n')].slice(0, 500).join('');
};
