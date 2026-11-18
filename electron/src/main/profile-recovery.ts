import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { app, dialog, safeStorage } from 'electron';
import type { ResolvedLocale, StartupRecoveryState } from '../shared';
import { messages } from '../shared';
import { IpcRouter } from './ipc-router';
import { ProfileBackupService } from './profile-backup';
import { SafeStorageVault } from './security';
import type { SafeStorageAdapter } from './security/safe-storage-vault';
import type { WindowManager } from './window-manager';

const directory = async (path: string): Promise<boolean> => { try { return (await lstat(path)).isDirectory(); } catch { return false; } };
const entries = async (path: string): Promise<string[]> => { try { return (await readdir(path)).sort().reverse().slice(0, 50); } catch { return []; } };

export class ProfileRecoveryService {
  readonly #candidates = new Map<string, { path: string; label: string }>();
  constructor(private readonly root: string, private readonly backups: string, private readonly adapter: SafeStorageAdapter, private readonly version: string) {}

  async snapshots(): Promise<Array<{ id: string; label: string }>> {
    this.#candidates.clear();
    const add = async (path: string, label: string): Promise<void> => {
      if (!(await directory(path)) || !(await directory(join(path, 'vault')))) return;
      try { if (!(await lstat(join(path, 'profile.enc.json'))).isFile()) return; } catch { return; }
      this.#candidates.set(randomUUID(), { path, label });
    };
    for (const name of await entries(join(this.root, 'recovery'))) {
      if (/^[0-9a-f-]{36}$/.test(name)) await add(join(this.root, 'recovery', name, 'previous'), `recovery / ${name}`);
    }
    for (const name of await entries(this.backups)) {
      if (!name.startsWith('install-') || !(await directory(join(this.backups, name)))) continue;
      for (const child of ['source-profile', 'previous-profile']) await add(join(this.backups, name, child), `${name} / ${child}`);
    }
    return [...this.#candidates].map(([id, candidate]) => ({ id, label: candidate.label }));
  }

  async prepareSnapshot(id: string): Promise<void> {
    const candidate = this.#candidates.get(id);
    if (candidate === undefined) throw new Error('recovery.invalidSnapshot');
    const temporary = join(this.root, 'recovery', randomUUID(), 'snapshot.deskpet-backup');
    await mkdir(join(temporary, '..'), { recursive: true, mode: 0o700 });
    const password = randomBytes(32).toString('base64');
    const sourceVault = new SafeStorageVault(join(candidate.path, 'vault'), this.adapter);
    try {
      await new ProfileBackupService(candidate.path, sourceVault, this.version).create(temporary, password);
      await this.prepareBackup(temporary, password);
    } finally { await rm(temporary, { force: true }); }
  }

  async prepareBackup(path: string, password: string): Promise<void> {
    const vault = new SafeStorageVault(join(this.root, 'vault'), this.adapter);
    await new ProfileBackupService(this.root, vault, this.version).prepareRestore(path, password);
  }
}

// This controller deliberately registers only recovery IPC. Domain services and
// providers never initialize against empty or damaged data behind this screen.
export class ProfileRecoveryController {
  readonly #ipc: IpcRouter;
  readonly #service: ProfileRecoveryService;
  #state: StartupRecoveryState | null = null;
  #busy = false;
  #prepared = false;

  constructor(private readonly windows: WindowManager, private readonly affectedPath: string) {
    this.#ipc = new IpcRouter(windows);
    const backups = !app.isPackaged && process.env.DESKPET_E2E_USER_DATA
      ? join(app.getPath('userData'), 'install-snapshots') : join(app.getPath('appData'), 'DeskPet Backups');
    this.#service = new ProfileRecoveryService(app.getPath('userData'), backups, safeStorage, app.getVersion());
  }

  async initialize(): Promise<void> {
    const locale: ResolvedLocale = app.getLocale().toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
    const t = (key: keyof typeof messages.en): string => messages[locale][key];
    this.#state = { locale, affectedFile: basename(this.affectedPath), dataDirectory: app.getPath('userData'), snapshots: await this.#service.snapshots() };
    this.#ipc.register('recovery:get-state', ['console'], () => this.#state);
    const prepare = async (operation: () => Promise<boolean>): Promise<boolean> => {
      if (this.#busy || this.#prepared) throw new Error('backup.error.busy');
      this.#busy = true;
      try { this.#prepared = await operation(); return this.#prepared; } finally { this.#busy = false; }
    };
    this.#ipc.register('recovery:restore-snapshot', ['console'], ({ id }) => prepare(async () => {
      const result = await dialog.showMessageBox({ type: 'warning', message: t('recovery.confirm'), buttons: [t('common.cancel'), t('recovery.restoreSnapshot')], defaultId: 0, cancelId: 0 });
      if (result.response !== 1) return false;
      await this.#service.prepareSnapshot(id); return true;
    }));
    this.#ipc.register('recovery:restore-backup', ['console'], ({ password }) => prepare(async () => {
      const result = await dialog.showOpenDialog({ title: t('backup.restore'), properties: ['openFile'], filters: [{ name: 'DeskPet encrypted backup', extensions: ['deskpet-backup'] }] });
      if (result.canceled || result.filePaths[0] === undefined) return false;
      const confirmation = await dialog.showMessageBox({ type: 'warning', message: t('recovery.confirm'), buttons: [t('common.cancel'), t('backup.restore')], defaultId: 0, cancelId: 0 });
      if (confirmation.response !== 1) return false;
      await this.#service.prepareBackup(result.filePaths[0], password); return true;
    }));
    this.#ipc.register('backup:restart', ['console'], () => {
      if (!this.#prepared) throw new Error('backup.error.pending');
      setTimeout(() => { app.relaunch(); app.quit(); }, 250);
    });
    this.windows.showConsole();
  }

  dispose(): void { this.#ipc.dispose(); }
}
