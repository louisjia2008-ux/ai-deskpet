import { expect, it } from 'vitest';
import { qqRunFailureText } from './qq-run-failure';

it.each([
  ['provider.network', '网络或代理'],
  ['provider.timeout', '超时'],
  ['provider.authentication', '身份验证'],
  ['provider.credentialsRequired', '配置密钥'],
  ['provider.quota', '余额或额度'],
  ['provider.rateLimit', '请求频率'],
  ['provider.modelUnavailable', '模型不可用'],
  ['provider.streamInterrupted', '回复中断'],
  ['tool.webBudgetExceeded', '联网次数已用完'],
])('gives a concrete fixed explanation for %s', (code, explanation) => {
  const text = qqRunFailureText(code);
  expect(text).toContain(explanation);
  expect(text).not.toContain(code);
  expect(qqRunFailureText(code, true)).toBe(text);
});

it('keeps private and group disclosure refusals separate', () => {
  expect(qqRunFailureText('qq.disclosureBlocked')).toBe('这条回复不能通过 QQ 发送。');
  expect(qqRunFailureText('qq.disclosureBlocked', true)).toBe('这条回复不能发到群里。');
});

it.each(['provider.failed', 'https://private.example/SECRET', 'provider.network SECRET', '__proto__', 'constructor'])('never echoes unknown code %s', code => {
  expect(qqRunFailureText(code)).toBe('这一轮没有完成，请在桌面查看错误详情后重试。');
});
