import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttentionAPI, HealthItem, HealthSnapshot } from '../../shared/attention';
import { HealthPanel } from './HealthPanel';

const entry = (feature: HealthItem['feature'], state: HealthItem['state'], patch: Partial<HealthItem> = {}): HealthItem =>
  ({ feature, state, lastSuccessAt: null, lastFailureAt: null, errorCode: null, failures: 0, sinceLaunch: false, ...patch });
const fixture = (items: HealthItem[]) => {
  const snapshot: HealthSnapshot = { checkedAt: '2026-11-14T13:00:00.000Z', items, issues: items.filter((item) => item.state === 'failing').length };
  const api = { snapshot: vi.fn(), acknowledge: vi.fn(), health: vi.fn(async () => structuredClone(snapshot)) } as unknown as AttentionAPI;
  return { api, onOpen: vi.fn() };
};
afterEach(cleanup);

describe('background status page', () => {
  it('puts the broken feature first with its reason in plain words and a way to fix it', async () => {
    const f = fixture([entry('wechat', 'ok'), entry('telegram', 'off'),
      entry('auto-memory', 'failing', { errorCode: 'provider.unsupportedParameter', failures: 2, lastFailureAt: '2026-11-14T12:36:33.000Z', sinceLaunch: true })]);
    render(<HealthPanel api={f.api} locale="zh-CN" onOpen={f.onOpen} />);
    expect(await screen.findByText('1 项没有正常工作')).toBeVisible();
    const cards = screen.getAllByRole('article');
    expect(within(cards[0]!).getByRole('heading')).toHaveTextContent('自动记忆');
    expect(within(cards[0]!).getByText(/模型不接受这次请求的参数设置/)).toBeVisible();
    expect(within(cards[0]!).getByText('连续失败 2 次')).toBeVisible();
    expect(within(cards[0]!).getByText(/本次启动以来/)).toBeVisible();
    expect(within(cards[2]!).getByRole('heading')).toHaveTextContent('Telegram');
    expect(within(cards[1]!).queryByRole('button')).toBeNull();
    fireEvent.click(within(cards[0]!).getByRole('button', { name: '去设置' }));
    expect(f.onOpen).toHaveBeenCalledWith('auto-memory');
  });

  it('tells the owner what to do about a skipped WeChat message and lets them mark it as seen', async () => {
    const failing = entry('wechat', 'failing', { errorCode: 'wechat.dropped', failures: 1, lastFailureAt: '2026-11-16T04:20:00.000Z', fingerprint: 'a'.repeat(64) });
    const f = fixture([failing]);
    const seen: HealthSnapshot = { checkedAt: '2026-11-16T13:00:00.000Z', items: [{ ...failing, acknowledged: true }], issues: 0 };
    const acknowledgeHealth = vi.fn(async () => seen);
    const onIssues = vi.fn();
    render(<HealthPanel api={{ ...f.api, acknowledgeHealth }} locale="zh-CN" onOpen={f.onOpen} onIssues={onIssues} />);
    const card = await screen.findByRole('article');
    expect(within(card).getByText('1 条消息没回')).toBeVisible();
    expect(within(card).getByText(/不用修。这是最近 24 小时的记录/)).toBeVisible();
    expect(within(card).queryByText(/上次成功/)).toBeNull();
    expect(within(card).getByText(/上次失败/)).toBeVisible();
    expect(onIssues).toHaveBeenLastCalledWith(1);
    fireEvent.click(within(card).getByRole('button', { name: '知道了' }));
    expect(await screen.findByText('没有新问题。有 1 项你已经知道了。')).toBeVisible();
    expect(acknowledgeHealth).toHaveBeenCalledWith({ key: 'wechat:0', fingerprint: 'a'.repeat(64) });
    expect(onIssues).toHaveBeenLastCalledWith(0);
    // Seen, but still failing: the badge keeps saying so.
    expect(within(screen.getByRole('article')).getByText('异常 · 已知道')).toBeVisible();
    expect(within(screen.getByRole('article')).queryByRole('button', { name: '知道了' })).toBeNull();
    expect(within(screen.getByRole('article')).getByRole('button', { name: '去设置' })).toBeVisible();
  });

  it('shows only the count of retained invalid diary copies on the knowledge card', async () => {
    const f = fixture([entry('knowledge', 'ok', { retainedInvalidDiaries: 2 })]);
    render(<HealthPanel api={f.api} locale="zh-CN" onOpen={f.onOpen} />);
    const card = await screen.findByRole('article');
    expect(within(card).getByRole('heading')).toHaveTextContent('知识库');
    expect(within(card).getByText('有 2 篇已失效但被你改过的日记副本。')).toBeVisible();
    expect(within(card).queryByRole('button', { name: '知道了' })).toBeNull();
  });

  it('shows WeChat recovery and opens WeChat settings when proactive delivery fails its preflight', async () => {
    const f = fixture([entry('proactive', 'failing', { errorCode: 'wechat.drawer_state_unknown' })]);
    render(<HealthPanel api={f.api} locale="zh-CN" onOpen={f.onOpen} />);
    const card = await screen.findByRole('article');
    expect(within(card).getByRole('heading')).toHaveTextContent('主动消息');
    expect(within(card).getByRole('status')).toHaveTextContent('无法确认聊天详情面板的状态。');
    expect(within(card).getByText(/检查已绑定主人私聊的聊天详情面板/)).toBeVisible();
    fireEvent.click(within(card).getByRole('button', { name: '去设置' }));
    expect(f.onOpen).toHaveBeenCalledWith('wechat');
  });

  it('says so when everything that is on works, and shows an unknown code as is', async () => {
    const f = fixture([entry('schedules', 'ok', { lastSuccessAt: '2026-11-14T07:00:00.000Z' })]);
    const { unmount } = render(<HealthPanel api={f.api} locale="en" onOpen={f.onOpen} />);
    expect(await screen.findByText('Everything that is turned on is working.')).toBeVisible();
    unmount();
    const g = fixture([entry('qq', 'failing', { errorCode: 'qq.gatewayClosed' })]);
    render(<HealthPanel api={g.api} locale="en" onOpen={g.onOpen} />);
    expect(await screen.findByText(/qq\.gatewayClosed/, { selector: 'p' })).toBeVisible();
  });
});
