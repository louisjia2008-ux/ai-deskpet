import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeskPetApi } from '../../shared';
import { defaultMinecraftDedicatedSettings } from '../../shared/minecraft-dedicated';
import type { MinecraftDedicatedSnapshot, MinecraftSurveyPlanStatus } from '../../shared/minecraft-dedicated';
import { MinecraftDedicatedSettings, MinecraftDedicatedStatus } from './MinecraftDedicatedPanel';

const acceptedAt = '2026-11-20T08:00:00.000Z';

function fixture(patch: Partial<MinecraftDedicatedSnapshot> = {}) {
  let snapshot: MinecraftDedicatedSnapshot = {
    settings: { ...defaultMinecraftDedicatedSettings },
    status: 'eula_required', error: null, port: 25566, startedAt: null, players: [],
    worldPath: '/isolated/minecraft/world', backupPath: '/isolated/minecraft/backups', lastBackupAt: null, eulaAcceptedAt: null,
    versions: { java: '21', minecraft: '1.21.8', mod: '0.1.0', modSha256: 'a'.repeat(64) },
    ownerName: '', botName: 'DeskPetCore', botConnected: false, botError: null, offlineModelUsed: 0, plan: null,
    ...patch,
  };
  let receive: ((state: MinecraftDedicatedSnapshot) => void) | undefined;
  function publish(patch: Partial<MinecraftDedicatedSnapshot>): MinecraftDedicatedSnapshot {
    snapshot = { ...snapshot, ...patch };
    receive?.(snapshot);
    return snapshot;
  }
  const api = {
    getState: vi.fn(async () => snapshot),
    onChanged: vi.fn((listener: (state: MinecraftDedicatedSnapshot) => void) => {
      receive = listener;
      return () => { receive = undefined; };
    }),
    acceptEula: vi.fn(async () => publish({ status: 'stopped', eulaAcceptedAt: acceptedAt })),
    updateIdentity: vi.fn(async (identity: Pick<MinecraftDedicatedSnapshot, 'ownerName' | 'botName'>) => publish(identity)),
    updateSettings: vi.fn(async (patch: Partial<MinecraftDedicatedSnapshot['settings']>) => publish({ settings: { ...snapshot.settings, ...patch } })),
    start: vi.fn(async () => publish({ status: 'running' })),
    stop: vi.fn(async () => publish({ status: 'stopped' })),
    restart: vi.fn(async () => publish({ status: 'running' })),
    backup: vi.fn(async () => publish({ lastBackupAt: acceptedAt })),
    openBackups: vi.fn(async () => undefined),
  } satisfies NonNullable<DeskPetApi['minecraftDedicated']>;
  return { api, publish };
}

afterEach(cleanup);

describe('Minecraft dedicated world controls', () => {
  it('gates startup on EULA and binds plan approval to the saved owner and bot', async () => {
    const { api } = fixture();
    render(<MinecraftDedicatedSettings api={api} locale="zh-CN" />);
    const accept = await screen.findByRole('button', { name: '同意 EULA' });
    const start = screen.getByRole('button', { name: '启动' });
    const plan = screen.getByRole('switch', { name: '允许游戏内确认施工' });
    expect(start).toBeDisabled();
    expect(plan).not.toBeChecked();
    expect(plan).toBeDisabled();
    expect(screen.getByRole('switch', { name: '本地 Minecraft 世界' })).toBeChecked();
    expect(screen.getByRole('combobox', { name: /服务器内存/ })).toHaveValue('3');
    expect(screen.getByRole('spinbutton', { name: '离线模型每日上限' })).toHaveValue(20);
    expect(screen.getByRole('link', { name: 'Minecraft EULA' })).toHaveAttribute('href', 'https://www.minecraft.net/en-us/eula');
    expect(screen.getByText('localhost:25566')).toBeVisible();

    fireEvent.click(accept);
    await waitFor(() => expect(start).toBeEnabled());
    expect(api.acceptEula).toHaveBeenCalledTimes(1);
    fireEvent.click(start);
    expect(await screen.findByText('运行中')).toBeVisible();
    fireEvent.change(screen.getByRole('textbox', { name: '主人玩家名' }), { target: { value: 'LocalOwner' } });
    fireEvent.click(screen.getByRole('button', { name: '保存玩家名' }));
    await waitFor(() => expect(plan).toBeEnabled());
    expect(plan).toHaveAccessibleDescription(/LocalOwner.*DeskPetCore/);
    fireEvent.click(plan);
    await waitFor(() => expect(plan).toBeChecked());
    expect(api.updateSettings).toHaveBeenLastCalledWith({ allowPlanApproval: true });
  });

  it('disables world controls when the Mod was not packaged', async () => {
    const { api } = fixture({ status: 'unpackaged' });
    render(<MinecraftDedicatedSettings api={api} locale="zh-CN" />);
    expect(await screen.findByText('未打包')).toBeVisible();
    expect(screen.getByRole('switch', { name: '本地 Minecraft 世界' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '同意 EULA' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '启动' })).toBeDisabled();
  });

  it('can stop during startup without exposing a stale startup error', async () => {
    const { api, publish } = fixture({ status: 'stopped', eulaAcceptedAt: acceptedAt });
    let failStartup: (error: Error) => void = () => undefined;
    const startup = new Promise<MinecraftDedicatedSnapshot>((_resolve, reject) => { failStartup = reject; });
    api.start.mockImplementation(async () => {
      publish({ status: 'starting' });
      return startup;
    });
    api.stop.mockImplementation(async () => {
      failStartup(new Error('The start operation was interrupted'));
      return publish({ status: 'stopped' });
    });
    render(<MinecraftDedicatedSettings api={api} locale="en" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
    expect(await screen.findByText('Starting')).toBeVisible();
    const stop = screen.getByRole('button', { name: 'Stop' });
    expect(stop).toBeEnabled();
    expect(screen.getByRole('switch', { name: 'Local Minecraft world' })).toBeEnabled();
    fireEvent.click(stop);
    expect(await screen.findByText('Stopped')).toBeVisible();
    expect(api.stop).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('Minecraft dedicated world status', () => {
  it('renders pushed blocked coordinates and a Mod completion, and shows the offline limit', async () => {
    const plan: MinecraftSurveyPlanStatus = {
      planId: '00000000-0000-4000-8000-000000000001', revision: 2, template: 'starter_house', status: 'paused',
      completed: 42, total: 115, phase: 'walls', reason: 'site_changed',
      waiting: 'materials', blocked: { reason: 'expected_block_changed', pos: { x: 8, y: 162, z: 8 } },
      violations: 0, misplacements: 1, siteChanges: 1, lateAttempts: 0, started: true,
    };
    const { api, publish } = fixture({
      status: 'running', players: ['DeskPetCore', 'LocalOwner'], startedAt: acceptedAt, botConnected: true,
      eulaAcceptedAt: acceptedAt, offlineModelUsed: 20, plan,
    });
    const onSettings = vi.fn();
    render(<MinecraftDedicatedStatus api={api} locale="zh-CN" onSettings={onSettings} />);
    expect(await screen.findByText('生存小屋')).toBeVisible();
    expect(screen.getByText('DeskPetCore, LocalOwner')).toBeVisible();
    expect(screen.getByText('已连接')).toBeVisible();
    expect(screen.getByText('今日离线模型调用已达上限')).toBeVisible();
    expect(screen.getByText('8, 162, 8')).toBeVisible();
    expect(screen.getByText('等材料')).toBeVisible();
    expect(screen.getByRole('progressbar', { name: '施工进度' })).toHaveAttribute('value', '42');

    const completed: MinecraftSurveyPlanStatus = { ...plan, status: 'completed', completed: 115 };
    delete completed.blocked;
    delete completed.waiting;
    delete completed.reason;
    act(() => { publish({ plan: completed }); });
    expect(screen.getByText('已完成')).toBeVisible();
    expect(screen.getByText('115/115')).toBeVisible();
    expect(screen.queryByText('8, 162, 8')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Minecraft 设置' }));
    expect(onSettings).toHaveBeenCalledTimes(1);
  });
});
