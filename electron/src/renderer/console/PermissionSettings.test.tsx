import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeskPetApi, MessageKey, PermissionDescriptor } from '../../shared';
import { messages } from '../../shared';
import { PermissionSettings } from './PermissionSettings';

const fixture = () => {
  let permissions: PermissionDescriptor[] = [
    { capabilityId: 'time.read', titleCode: 'permission.time', detailCode: 'permission.time.detail', risk: 'low', state: 'not-requested', expiresAt: null },
    { capabilityId: 'workspace.write', titleCode: 'permission.workspaceWrite', detailCode: 'permission.workspaceWrite.detail', risk: 'high', state: 'not-requested', expiresAt: null },
  ];
  const request = vi.fn<DeskPetApi['permissions']['request']>(async ({ capabilityId, duration }) => {
    permissions = permissions.map((item) => item.capabilityId === capabilityId ? { ...item, state: duration === 'always' ? 'always' : 'session' } : item);
    return permissions.find((item) => item.capabilityId === capabilityId)!;
  });
  const revoke = vi.fn<DeskPetApi['permissions']['revoke']>(async (capabilityId) => {
    permissions = permissions.map((item) => item.capabilityId === capabilityId ? { ...item, state: 'not-requested' } : item);
    return permissions.find((item) => item.capabilityId === capabilityId)!;
  });
  Object.defineProperty(window, 'deskpet', { configurable: true, value: { permissions: { request, revoke } } });
  const Harness = () => {
    const [current, setCurrent] = useState(permissions);
    return <PermissionSettings permissions={current} t={(key) => messages['zh-CN'][key as MessageKey]} refresh={async () => { setCurrent([...permissions]); }} />;
  };
  render(<Harness />);
  return { request, revoke };
};

afterEach(cleanup);

describe('tool permission choices', () => {
  it('grants only the chosen tool, upgrades to always, then allows downgrade and revocation', async () => {
    const { request, revoke } = fixture();
    const time = within(screen.getByRole('article', { name: '日期与时间' }));
    const files = within(screen.getByRole('article', { name: '写入工作区文件' }));
    expect(request).not.toHaveBeenCalled();
    expect(time.getByText('未授权')).toBeVisible();
    fireEvent.click(time.getByRole('button', { name: '本次会话允许' }));
    await time.findByText('本次会话');
    fireEvent.click(time.getByRole('button', { name: '始终允许' }));
    await time.findByRole('button', { name: '改为本次会话' });
    expect(files.getByText('未授权')).toBeVisible();
    expect(request.mock.calls).toEqual([[{ capabilityId: 'time.read', duration: 'session' }], [{ capabilityId: 'time.read', duration: 'always' }]]);
    fireEvent.click(time.getByRole('button', { name: '改为本次会话' }));
    await time.findByText('本次会话');
    fireEvent.click(time.getByRole('button', { name: '撤销' }));
    await time.findByText('未授权');
    expect(revoke).toHaveBeenCalledExactlyOnceWith('time.read');
  });

  it('keeps the saved state truthful when a request fails and lets the user retry', async () => {
    const { request } = fixture();
    request.mockRejectedValueOnce(new Error('Storage unavailable'));
    const time = within(screen.getByRole('article', { name: '日期与时间' }));
    fireEvent.click(time.getByRole('button', { name: '始终允许' }));
    expect(await time.findByRole('alert')).toHaveTextContent('无法更新');
    expect(time.getByText('未授权')).toBeVisible();
    fireEvent.click(time.getByRole('button', { name: '始终允许' }));
    await time.findByRole('button', { name: '改为本次会话' });
    expect(time.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('prevents conflicting repeated clicks while the selected permission is saving', async () => {
    const { request } = fixture();
    let release: (() => void) | undefined;
    request.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ capabilityId: 'time.read', titleCode: 'permission.time', detailCode: 'permission.time.detail', risk: 'low', state: 'always', expiresAt: null }); }));
    const time = within(screen.getByRole('article', { name: '日期与时间' }));
    fireEvent.click(time.getByRole('button', { name: '始终允许' }));
    expect(time.getByRole('button', { name: '本次会话允许' })).toBeDisabled();
    fireEvent.click(time.getByRole('button', { name: '始终允许' }));
    expect(request).toHaveBeenCalledOnce();
    await act(async () => release?.());
    await waitFor(() => expect(time.getByRole('button', { name: '本次会话允许' })).toBeEnabled());
  });
});
