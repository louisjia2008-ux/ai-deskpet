import { describe, expect, it, vi } from 'vitest';
import { AutoLaunchService } from './auto-launch';

describe('actual login item status', () => {
  it('never registers the developer Electron executable', () => {
    const adapter = { getLoginItemSettings: vi.fn(), setLoginItemSettings: vi.fn() };
    const service = new AutoLaunchService(adapter, false, 'darwin');
    expect(service.state()).toBe('unavailable');
    expect(() => service.setEnabled(true)).toThrow('startup.unavailable');
    expect(adapter.setLoginItemSettings).not.toHaveBeenCalled();
  });
  it('reports approval as pending, and rejects a registration the system did not apply', () => {
    const adapter = { getLoginItemSettings: vi.fn(() => ({ openAtLogin: false, status: 'requires-approval' })), setLoginItemSettings: vi.fn() };
    const service = new AutoLaunchService(adapter, true, 'darwin');
    expect(service.setEnabled(true)).toBe('approval-required');
    expect(adapter.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true, type: 'mainAppService' });
    adapter.getLoginItemSettings.mockReturnValue({ openAtLogin: false, status: 'not-registered' });
    expect(() => service.setEnabled(true)).toThrow('startup.error');
  });
  it('shows external system changes rather than a stale preference', () => {
    const adapter = { getLoginItemSettings: vi.fn(() => ({ openAtLogin: true, status: 'enabled' })), setLoginItemSettings: vi.fn() };
    const service = new AutoLaunchService(adapter, true, 'darwin');
    expect(service.state()).toBe('enabled');
    adapter.getLoginItemSettings.mockReturnValue({ openAtLogin: false, status: 'not-registered' });
    expect(service.state()).toBe('disabled');
  });
});
