import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { AttentionAPI } from '../../shared/attention';
import { doctorStateSchema, type DoctorStatus } from '../../shared/doctor';
import { DoctorPanel } from './DoctorPanel';

const at = '2026-11-17T07:00:00.000Z';
const status = (manualSelfTestsToday = 0): DoctorStatus => ({
  ...doctorStateSchema.parse({ enabled: true, cases: [], session: null, alerts: { day: '', count: 0 } }),
  lastCheckAt: at, open: 0, alertsToday: 0, dailyLimit: 6, selfTestPassRate: 1, manualSelfTestsToday, runbooks: {},
  diagnosis: { at, source: 'local', text: '当前采样正常，可以继续使用。' },
  selfTests: [{ at, source: 'auto', status: 'passed', code: null, durationMs: 100,
    stages: { lock: true, open: true, title: true, paste: true, click: true, ocrReceipt: false, dbReceipt: true } }],
});

it('shows the diagnosis, database stage and pass rate, invoking only the manual self-test button', async () => {
  const manual = vi.fn(async () => status(5));
  const api: AttentionAPI = { snapshot: vi.fn(), acknowledge: vi.fn(), doctor: async () => status(), testDoctorWeChat: manual };
  render(<DoctorPanel api={api} locale="zh-CN" />);
  expect(await screen.findByText('当前采样正常，可以继续使用。')).toBeInTheDocument();
  expect(screen.getByText('14 天通过率：100%')).toBeInTheDocument();
  expect(screen.getByText('数据库回执：✓')).toBeInTheDocument();
  const button = screen.getByRole('button', { name: '现在测一次微信发送' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() => expect(manual).toHaveBeenCalledOnce());
  await waitFor(() => expect(button).toBeDisabled());
});
