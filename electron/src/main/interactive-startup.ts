import { app, dialog } from 'electron';
import started from 'electron-squirrel-startup';

import { AppController } from './app-controller';
import { installLocalProtocol } from './local-protocol';
import { WindowManager } from './window-manager';
import { abandonPendingRestore, applyPendingProfileRestore } from './profile-backup';
import { ProfileRecoveryController } from './profile-recovery';
import { PersistenceCorruptionError, UnsupportedSchemaVersionError } from './persistence/errors';

export const startInteractive = (): void => {
if (process.platform === 'win32') app.setAppUserModelId('com.deskpet.companion.electron');

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (started || !hasSingleInstanceLock) {
  app.quit();
} else {
  const windows = new WindowManager();
  let controller: AppController | null = null;
  let recovery: ProfileRecoveryController | null = null;
  let initialized = false;
  let quitting = false;
  let canQuit = false;

  app.on('second-instance', () => windows.showConsole());
  app.on('activate', () => {
    if (!initialized && recovery === null) return;
    if (recovery !== null) { windows.showConsole(); return; }
    windows.createWindows();
    windows.showConsole();
    void controller?.attachWindows().catch(() => undefined);
  });
  app.on('before-quit', (event) => {
    if (canQuit || controller === null) { recovery?.dispose(); windows.dispose(); return; }
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void controller.shutdown().catch(() => undefined).finally(() => {
      controller?.dispose(); controller = null;
      canQuit = true; windows.dispose(); app.quit();
    });
  });

  void app.whenReady().then(async () => {
    try {
      let restoreAbandoned = false;
      try { await applyPendingProfileRestore(app.getPath('userData')); }
      catch (error) {
        if (!(error instanceof Error) || error.message !== 'backup.automaticProtectionUnknown' || !(restoreAbandoned = await abandonPendingRestore(app.getPath('userData')))) throw error;
      }
      await installLocalProtocol(`${app.getPath('userData')}/managed`);
      controller = new AppController(windows);
      await controller.initialize();
      initialized = true;
      windows.createWindows();
      await controller.attachWindows();
      if (restoreAbandoned) {
        const zh = app.getLocale().startsWith('zh');
        void dialog.showMessageBox({ type: 'warning', message: zh ? '备份恢复没有完成' : 'The backup was not restored',
          detail: zh ? '上次准备恢复后，当前资料又发生了变化。为避免覆盖新内容，这次恢复已取消，当前资料保持不变。你可以重新恢复一次。' : 'Your current data changed after the restore was prepared. To avoid overwriting it, the restore was cancelled and your data is unchanged. You can restore again.' });
      }
      windows.createTray(
        {
          showConsole: () => windows.showConsole(),
          showAttention: () => controller?.openAttention(),
          toggleOverlay: () => {
            const overlay = windows.overlayWindow();
            if (overlay?.isVisible()) overlay.hide();
            else overlay?.showInactive();
          },
          quit: () => app.quit(),
        },
        app.getLocale().startsWith('zh')
          ? { show: '打开 DeskPet', attention: '待处理中心', toggle: '显示或隐藏桌宠', quit: '退出' }
          : { show: 'Open DeskPet', attention: 'Attention center', toggle: 'Show or hide companion', quit: 'Quit' },
      );
    } catch (error) {
      if (error instanceof PersistenceCorruptionError || error instanceof UnsupportedSchemaVersionError) {
        controller?.dispose(); controller = null;
        windows.dispose();
        recovery = new ProfileRecoveryController(windows, error instanceof PersistenceCorruptionError ? error.quarantinedPath : 'settings.json');
        await recovery.initialize();
        return;
      }
      const message = error instanceof Error ? error.message : 'DeskPet could not start.';
      dialog.showErrorBox('DeskPet Electron could not start securely', message);
      app.quit();
    }
  });
}

};
