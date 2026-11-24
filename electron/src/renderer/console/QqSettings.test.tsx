import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DeskPetApi, ProviderConfig } from '../../shared';
import type { QqChannelAPI, QqChannelStatus } from '../../shared/qq-channel';
import { QqSettings } from './QqSettings';

afterEach(cleanup);
const provider: ProviderConfig = { id: '00000000-0000-4000-8000-000000000020', name: 'Synthetic provider', kind: 'ollama',
  baseUrl: 'http://127.0.0.1:11434', model: 'synthetic-model', enabled: true, supportsTools: true, secretState: 'missing' };
const status = (patch: Partial<QqChannelStatus> = {}): QqChannelStatus => ({
  enabled: false, stopped: false, connection: 'disabled', transport: 'official', appIdConfigured: true, appId: 'app-1', onebotUrl: '', secretConfigured: true,
  bound: false, bindingDisplayName: null, pairingCandidate: null, pairingIssue: null, groupPairingIssue: null, gatewayEvents: [], groups: [], groupCandidate: null, groupRequests: 0, groupDailyLimit: 30, providerId: provider.id, model: provider.model,
  dailyRequests: 0, dailyRequestLimit: 50, webCallLimit: 10, pendingOutbox: 0, failedOutbox: 0, uncertainOutbox: 0, lastPrivatePush: null, lastError: null, ...patch,
});
const setup = (patch: Partial<QqChannelStatus> = {}, locale = 'en') => {
  let current = status(patch);
  const getState = vi.fn(async () => structuredClone(current));
  const configure = vi.fn<QqChannelAPI['configure']>(async input => {
    current = { ...current, ...(input.appId === undefined ? {} : { appId: input.appId, appIdConfigured: !!input.appId }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled, stopped: !input.enabled }),
      ...(input.providerId === undefined ? {} : { providerId: input.providerId }), ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.appSecret === undefined ? {} : { secretConfigured: !!input.appSecret }) };
    return structuredClone(current);
  });
  const stop = vi.fn(async () => { current = { ...current, stopped: true, connection: 'disabled' }; return structuredClone(current); });
  const startPairing = vi.fn(async () => ({ code: '123456', expiresAt: '2026-11-02T22:00:00.000Z' }));
  const confirmPairing = vi.fn<QqChannelAPI['confirmPairing']>(async () => { current = { ...current, bound: true, pairingCandidate: null }; return structuredClone(current); });
  const unbind = vi.fn(async () => status({ stopped: true })), retryDeliveries = vi.fn(async () => undefined);
  const startGroupPairing = vi.fn(async () => ({ code: '654321', expiresAt: '2026-11-04T00:00:00.000Z' }));
  const setGroupOpen = vi.fn(async () => status({})), removeGroup = vi.fn(async () => status({})), confirmGroupPairing = vi.fn(async () => status({}));
  const sendPrivateImageTest = vi.fn<QqChannelAPI['sendPrivateImageTest']>(async () => ({ status: 'sent', title: '开心招手', error: null }));
  const qq: QqChannelAPI = { setCronDelivery: vi.fn(async () => undefined), sendPrivateImageTest, setPrivateCare: vi.fn(async () => current), sendPrivateCareNow: vi.fn(async () => current), setPrivateReminders: vi.fn(async () => current), getState, configure, stop, startPairing, confirmPairing, unbind, retryDeliveries, startGroupPairing, confirmGroupPairing, setGroupOpen, removeGroup };
  Object.defineProperty(window, 'deskpet', { configurable: true, value: { qq } as Partial<DeskPetApi> });
  render(<QqSettings locale={locale} providers={[provider]} />);
  return { sendPrivateImageTest, getState, configure, stop, startPairing, confirmPairing, unbind, retryDeliveries };
};

it('does not enable, pair or send credentials merely by opening settings', async () => {
  const f = setup(); await screen.findByLabelText('QQ AppID');
  expect(f.configure).not.toHaveBeenCalled(); expect(f.startPairing).not.toHaveBeenCalled();
  expect(screen.getByText(/QQ Cron create\/update\/resume require your direct \/confirm/u)).toBeInTheDocument(); // folded under the rules summary
  expect(screen.getByText(/at most 2048 output tokens/u)).toHaveTextContent('120-second run deadline');
  expect(screen.getByText(/QQ tasks pause after restart/u)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Generate pairing code' })).toBeDisabled();
  // Nothing is running, so there is nothing to stop yet.
  expect(screen.queryByRole('button', { name: 'Emergency stop QQ' })).not.toBeInTheDocument();
});

it('preserves an unchanged secret, only submits it explicitly and clears the input immediately', async () => {
  const f = setup(); const appId = await screen.findByLabelText('QQ AppID');
  const save = screen.getByRole('button', { name: 'Save QQ settings' });
  expect(save).toBeDisabled(); fireEvent.click(save); expect(f.configure).not.toHaveBeenCalled();
  fireEvent.change(appId, { target: { value: 'temporary-edit' } });
  expect(save).toBeEnabled();
  fireEvent.change(appId, { target: { value: 'app-1' } });
  expect(save).toBeDisabled();
  fireEvent.change(appId, { target: { value: 'edited-app' } });
  fireEvent.click(save);
  await waitFor(() => expect(f.configure).toHaveBeenCalledTimes(1));
  expect(f.configure.mock.calls[0]![0]).not.toHaveProperty('appSecret');
  const input = screen.getByLabelText('AppSecret (leave blank to keep saved secret)');
  expect(input).toHaveAttribute('type', 'password');
  fireEvent.change(input, { target: { value: 'private-secret-fixture' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save QQ settings' }));
  await waitFor(() => expect(f.configure).toHaveBeenCalledTimes(2));
  expect(f.configure.mock.calls[1]![0]).toMatchObject({ appSecret: 'private-secret-fixture' });
  expect(input).toHaveValue(''); expect(document.body.textContent).not.toContain('private-secret-fixture');
  fireEvent.click(screen.getByRole('button', { name: 'Clear saved AppSecret and stop' }));
  await waitFor(() => expect(f.configure).toHaveBeenCalledTimes(3));
  expect(f.configure.mock.calls[2]![0]).toEqual({ appSecret: null, enabled: false });
});

it('requires an explicit desktop click to approve a candidate identity', async () => {
  const candidate = { id: '00000000-0000-4000-8000-000000000030', senderId: 'owner-openid', expiresAt: '2026-11-02T22:00:00.000Z' };
  const f = setup({ enabled: true, pairingCandidate: candidate });
  await screen.findByText('owner-openid'); expect(f.confirmPairing).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm this QQ identity' }));
  await waitFor(() => expect(f.confirmPairing).toHaveBeenCalledExactlyOnceWith(candidate.id));
  await waitFor(() => expect(screen.queryByText('owner-openid')).not.toBeInTheDocument());
});

it('shows pairing instructions only after an explicit code request and keeps stop available', async () => {
  const f = setup({ enabled: true }); await screen.findByLabelText('QQ AppID');
  fireEvent.click(screen.getByRole('button', { name: 'Generate pairing code' }));
  await screen.findByText('/pair 123456');
  expect(screen.getByText(/desktop must approve/u)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Emergency stop QQ' }));
  await waitFor(() => expect(f.stop).toHaveBeenCalledOnce());
  expect(screen.queryByText('/pair 123456')).not.toBeInTheDocument();
});

it('does not render raw upstream errors, secrets or diagnostics', async () => {
  const f = setup({}, 'zh-CN'); await screen.findByLabelText('QQ AppID');
  expect(screen.getByText(/重启后 QQ 任务暂停/u)).toBeInTheDocument();
  expect(screen.getByText(/最多 10 个未取消任务/u)).toHaveTextContent('每轮最多 4 次模型请求');
  fireEvent.change(screen.getByLabelText('QQ AppID'), { target: { value: 'new-app' } });
  f.configure.mockRejectedValueOnce(new Error('PRIVATE_PROVIDER_ERROR_WITH_SECRET'));
  fireEvent.click(screen.getByRole('button', { name: '保存 QQ 设置' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('无法更新 QQ 设置');
  expect(document.body.textContent).not.toContain('PRIVATE_PROVIDER_ERROR_WITH_SECRET');
});

it('lets emergency stop supersede a pending save without restoring stale online state', async () => {
  const f = setup({ enabled: true, connection: 'online' }); await screen.findByLabelText('QQ AppID');
  let finish!: (value: QqChannelStatus) => void;
  f.configure.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.change(screen.getByLabelText('QQ AppID'), { target: { value: 'new-app' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save QQ settings' }));
  expect(screen.getByRole('button', { name: 'Emergency stop QQ' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Emergency stop QQ' })); await screen.findByText('Stopped');
  await act(async () => finish(status({ enabled: true, connection: 'online' })));
  expect(screen.getByText('Stopped')).toBeInTheDocument(); expect(screen.queryByText('Online')).not.toBeInTheDocument();
});

it('shows the account risk and submits only the OneBot endpoint and an explicit token', async () => {
  const f = setup(); await screen.findByLabelText('QQ AppID');
  fireEvent.change(screen.getByLabelText('Connection method'), { target: { value: 'onebot' } });
  expect(screen.getByText(/secondary account you can afford to lose/u)).toBeInTheDocument();
  expect(screen.queryByLabelText('QQ AppID')).not.toBeInTheDocument();
  expect(screen.getByText('No access token saved')).toBeInTheDocument();
  expect(screen.getByLabelText('OneBot WebSocket address (this computer only)')).toHaveValue('ws://127.0.0.1:3001');
  const token = screen.getByLabelText('OneBot access token (leave blank to keep saved token)');
  fireEvent.change(token, { target: { value: 'synthetic-token' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save QQ settings' }));
  await waitFor(() => expect(f.configure).toHaveBeenCalledTimes(1));
  const input = f.configure.mock.calls[0]![0];
  expect(input).toMatchObject({ transport: 'onebot', onebotUrl: 'ws://127.0.0.1:3001', appSecret: 'synthetic-token' });
  expect(input).not.toHaveProperty('appId');
  expect(token).toHaveValue('');
});

it('explains OneBot connection problems and shows the QQ number wording for the candidate', async () => {
  setup({ transport: 'onebot', onebotUrl: 'ws://127.0.0.1:3001', enabled: true, lastError: 'qq.onebotAuthFailed',
    pairingCandidate: { id: '00000000-0000-4000-8000-000000000021', senderId: '123456789', expiresAt: '2026-11-02T22:00:00.000Z' } });
  expect(await screen.findByText(/NapCat rejected the access token/u)).toBeInTheDocument();
  expect(screen.getByText('Verify that this is your own QQ number before approving.')).toBeInTheDocument();
});

it('sends a single official image to the displayed private binding without reconfiguring QQ', async () => {
  const privateBindingId = '00000000-0000-4000-8000-000000000029';
  const f = setup({ enabled: true, bound: true, connection: 'online', privateBindingId }, 'zh-CN');
  const button = await screen.findByRole('button', { name: '向已绑定私聊发送测试表情' });
  expect(f.sendPrivateImageTest).not.toHaveBeenCalled();
  fireEvent.click(button);
  expect(await screen.findByText('QQ 已确认发送测试表情 · 开心招手')).toBeInTheDocument();
  expect(f.sendPrivateImageTest).toHaveBeenCalledExactlyOnceWith(privateBindingId);
  expect(f.configure).not.toHaveBeenCalled();
});

it('keeps emergency stop available when the stop could not be saved', async () => {
  const f = setup({ enabled: true, connection: 'online' }); await screen.findByLabelText('QQ AppID');
  // The running channel was revoked in memory, so later reads say stopped, but the saved stop failed.
  f.stop.mockImplementationOnce(async () => { f.getState.mockResolvedValue(status({ enabled: true, stopped: true, connection: 'disabled' })); throw new Error('qq.persistFailed'); });
  fireEvent.click(screen.getByRole('button', { name: 'Emergency stop QQ' }));
  expect(await screen.findByRole('alert')).toBeVisible();
  await new Promise(resolve => setTimeout(resolve, 3_200));
  expect(screen.getByRole('button', { name: 'Emergency stop QQ' })).toBeEnabled();
  expect(screen.getByRole('alert')).toBeVisible();
}, 10_000);
