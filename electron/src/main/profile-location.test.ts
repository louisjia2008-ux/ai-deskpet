// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureProfileLocation, isIsolatedProfile, planProfileLocation, selectIsolatedProfile, wechatWorkerSwitch } from './profile-location';

const roots: string[] = [];
const fixture = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'deskpet-isolation-test-')));
  roots.push(root);
  writeFileSync(join(root, 'isolated-candidate.json'), JSON.stringify({ version: 1, purpose: 'deskpet-isolated-candidate' }));
  return root;
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('early isolated packaged profile selection', () => {
  it('allows the WeChat worker switch only for an explicit interactive isolated profile', () => {
    const root = fixture();
    const isolated = `--deskpet-isolated-profile=${root}`;
    const application = { isPackaged: true, getPath: vi.fn(() => '/daily-app-data'), setPath: vi.fn(), setName: vi.fn(), setAppLogsPath: vi.fn() };
    expect(planProfileLocation(application, [isolated, wechatWorkerSwitch], 'daily')).toMatchObject({ root, operation: 'interactive' });
    for (const argv of [[wechatWorkerSwitch], [isolated, wechatWorkerSwitch, wechatWorkerSwitch], [isolated, `${wechatWorkerSwitch}=true`]]) {
      expect(() => planProfileLocation(application, argv, 'daily')).toThrow('startup.argumentsConflict');
    }
  });
  it('binds every data path and keychain name before any caller can initialize storage', () => {
    const root = fixture();
    const application = { isPackaged: true, getPath: vi.fn(() => '/daily-app-data'), setPath: vi.fn(), setName: vi.fn(), setAppLogsPath: vi.fn() };
    configureProfileLocation(application, [`--deskpet-isolated-profile=${root}`]);
    expect(isIsolatedProfile()).toBe(true);
    expect(application.setName).toHaveBeenCalledExactlyOnceWith('DeskPet Electron Candidate');
    expect(application.setPath.mock.calls).toEqual([['appData', join(root, 'app-data')], ['userData', join(root, 'profile')], ['sessionData', join(root, 'cache')], ['crashDumps', join(root, 'crash-dumps')]]);
    expect(application.setAppLogsPath).toHaveBeenCalledExactlyOnceWith(join(root, 'logs'));
  });
  it('rejects malformed, relative, duplicate, unmarked and daily-containing roots instead of falling back', () => {
    const root = fixture();
    for (const argv of [['--deskpet-isolated-profile'], ['--deskpet-isolated-profile=relative'], [`--deskpet-isolated-profile=${root}`, `--deskpet-isolated-profile=${root}`]]) expect(() => selectIsolatedProfile(argv, '/daily')).toThrow();
    expect(() => selectIsolatedProfile([`--deskpet-isolated-profile=${root}`], root)).toThrow('daily profile');
    writeFileSync(join(root, 'isolated-candidate.json'), '{}');
    expect(() => selectIsolatedProfile([`--deskpet-isolated-profile=${root}`], '/daily')).toThrow('marker');
  });
  it('rejects linked roots and linked profile children before using them', () => {
    const root = fixture(); const outside = fixture(); const linked = join(root, 'linked');
    symlinkSync(outside, linked);
    expect(() => selectIsolatedProfile([`--deskpet-isolated-profile=${linked}`], '/daily')).toThrow('linked');
    symlinkSync(outside, join(root, 'profile'));
    const application = { isPackaged: true, getPath: vi.fn(() => '/daily'), setPath: vi.fn(), setName: vi.fn(), setAppLogsPath: vi.fn() };
    expect(() => configureProfileLocation(application, [`--deskpet-isolated-profile=${root}`])).toThrow('linked');
    expect(application.setPath).not.toHaveBeenCalledWith('userData', join(root, 'profile'));
  });
  it('retains the normal packaged default and does not honor development-only env overrides', () => {
    const root = fixture(); mkdirSync(join(root, 'normal'));
    const application = { isPackaged: true, getPath: vi.fn(() => join(root, 'normal')), setPath: vi.fn(), setName: vi.fn(), setAppLogsPath: vi.fn() };
    vi.stubEnv('DESKPET_E2E_USER_DATA', '/must-not-use');
    try {
      configureProfileLocation(application, []);
      expect(isIsolatedProfile()).toBe(false);
      expect(application.setName).toHaveBeenCalledExactlyOnceWith('DeskPet Electron');
      expect(application.setPath).toHaveBeenCalledExactlyOnceWith('userData', join(root, 'normal', 'DeskPet Electron'));
    } finally { vi.unstubAllEnvs(); }
  });
});
