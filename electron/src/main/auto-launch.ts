import type { AutoLaunchState } from '../shared';

interface LoginItemAdapter {
  getLoginItemSettings(): { openAtLogin: boolean; status?: string };
  setLoginItemSettings(settings: { openAtLogin: boolean; type?: 'mainAppService' }): void;
}

export class AutoLaunchService {
  constructor(private readonly adapter: LoginItemAdapter, private readonly packaged: boolean, private readonly platform: NodeJS.Platform) {}

  state(): AutoLaunchState {
    if (!this.packaged || !['darwin', 'win32'].includes(this.platform)) return 'unavailable';
    try {
      const settings = this.adapter.getLoginItemSettings();
      if (this.platform === 'darwin') {
        if (settings.status === 'requires-approval') return 'approval-required';
        if (settings.status === 'not-found') return 'error';
        return settings.status === 'enabled' ? 'enabled' : 'disabled';
      }
      return settings.openAtLogin ? 'enabled' : 'disabled';
    } catch { return 'error'; }
  }

  setEnabled(enabled: boolean): AutoLaunchState {
    if (this.state() === 'unavailable') throw new Error('startup.unavailable');
    this.adapter.setLoginItemSettings({ openAtLogin: enabled, ...(this.platform === 'darwin' ? { type: 'mainAppService' as const } : {}) });
    const state = this.state();
    if (state === 'error' || (enabled && state === 'disabled') || (!enabled && state === 'enabled')) throw new Error('startup.error');
    return state;
  }
}
