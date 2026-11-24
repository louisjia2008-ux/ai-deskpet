import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultAutomationProactive } from '../../shared/automation-schemas';
import type { AutomationAPI, ProactivePolicyInput } from '../../shared/automation';
import type { ProviderConfig } from '../../shared';
import { CareSettings } from './CareSettings';

afterEach(cleanup);
const provider = { id: 'p1', name: 'OpenAI', kind: 'openai', model: 'model-1', enabled: true } as ProviderConfig;
const setup = () => {
  let policy = defaultAutomationProactive();
  const configureProactive = vi.fn(async (input: ProactivePolicyInput) => { policy = { ...input, revision: policy.revision + 1 }; return policy; });
  const explicitCheckIn = vi.fn(async () => undefined), requestPermission = vi.fn(async () => undefined);
  const api = { snapshot: async () => ({ proactivePolicy: policy }), configureProactive, explicitCheckIn } as unknown as AutomationAPI;
  render(<CareSettings api={api} providers={[provider]} activeProviderId="p1" locale="zh-CN" requestPermission={requestPermission} />);
  return { configureProactive, explicitCheckIn, requestPermission };
};
const mode = (name: string) => screen.findByRole('radio', { name });

it('turns everything on in one step, after asking for the permission', async () => {
  const f = setup();
  fireEvent.click(await mode('主动问候'));
  await waitFor(() => expect(f.configureProactive).toHaveBeenCalledOnce());
  expect(f.requestPermission).toHaveBeenCalledOnce();
  expect(f.configureProactive.mock.calls[0]![0]).toMatchObject({ enabled: true, mode: 'auto', providerId: 'p1', model: null, quietStart: '23:00', quietEnd: '08:00', dailyLimit: 2 });
  expect(f.configureProactive.mock.calls[0]![0].eventKinds).toContain('explicit-check-in');
  await waitFor(async () => expect(await mode('主动问候')).toHaveAttribute('aria-checked', 'true'));
  fireEvent.click(screen.getByRole('button', { name: '现在问候一次' }));
  await waitFor(() => expect(f.explicitCheckIn).toHaveBeenCalledOnce());
});

it('does not ask for the permission when turning it off', async () => {
  const f = setup();
  fireEvent.click(await mode('主动问候'));
  await waitFor(async () => expect(await mode('主动问候')).toHaveAttribute('aria-checked', 'true'));
  f.requestPermission.mockClear();
  fireEvent.click(await mode('关闭'));
  await waitFor(() => expect(f.configureProactive).toHaveBeenCalledTimes(2));
  expect(f.configureProactive.mock.calls[1]![0]).toMatchObject({ enabled: false, mode: 'off' });
  expect(f.requestPermission).not.toHaveBeenCalled();
});

it('changes only its own fields and keeps the advanced rules as saved', async () => {
  let policy = { ...defaultAutomationProactive(), eventKinds: ['focus-completed'] as ProactivePolicyInput['eventKinds'], quietStart: '22:00', timezone: 'Asia/Shanghai', topics: ['tea'] };
  const configureProactive = vi.fn(async (input: ProactivePolicyInput) => { policy = { ...input, revision: policy.revision + 1 }; return policy; });
  const api = { snapshot: async () => ({ proactivePolicy: policy }), configureProactive, explicitCheckIn: vi.fn() } as unknown as AutomationAPI;
  render(<CareSettings api={api} providers={[provider]} activeProviderId="p1" locale="zh-CN" requestPermission={vi.fn(async () => undefined)} />);
  fireEvent.click(await mode('只记录，不打扰'));
  await waitFor(() => expect(configureProactive).toHaveBeenCalledOnce());
  expect(configureProactive.mock.calls[0]![0]).toMatchObject({ mode: 'observe', enabled: false, eventKinds: ['focus-completed'], quietStart: '22:00', timezone: 'Asia/Shanghai', topics: ['tea'] });
});

it('can always be switched off, even with no usable model', async () => {
  let policy: ReturnType<typeof defaultAutomationProactive> = { ...defaultAutomationProactive(), enabled: true, mode: 'auto' };
  const configureProactive = vi.fn(async (input: ProactivePolicyInput) => { policy = { ...input, revision: policy.revision + 1 }; return policy; });
  const api = { snapshot: async () => ({ proactivePolicy: policy }), configureProactive, explicitCheckIn: vi.fn() } as unknown as AutomationAPI;
  render(<CareSettings api={api} providers={[]} activeProviderId={null} locale="zh-CN" requestPermission={vi.fn(async () => undefined)} />);
  const off = await mode('关闭');
  await waitFor(() => expect(off).toBeEnabled());
  fireEvent.click(off);
  await waitFor(() => expect(configureProactive).toHaveBeenCalledWith(expect.objectContaining({ mode: 'off', enabled: false })));
});
