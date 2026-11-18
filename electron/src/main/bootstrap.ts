import { app, dialog } from 'electron';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { readFileSync } from 'node:fs';
import { readArtifactMode } from './artifact-mode';
import { planProfileLocation, applyProfileLocation } from './profile-location';
import { dispatchStartup } from './startup-gate';
import { registerDeskPetScheme } from './local-protocol';

const refuse = (code: string): void => {
  // Reject immediately; wait only for native UI readiness, never for product initialization.
  // A synchronous pre-ready NSAlert can block LaunchServices/accessibility startup.
  void app.whenReady().then(async () => {
    await dialog.showMessageBox({ type: 'error', title: 'DeskPet startup refused / 已拒绝启动',
      message: 'Validation candidate refused to open / 验证候选已拒绝打开',
      detail: `Use the supplied isolated launcher. Missing, conflicting or invalid configuration was rejected before profile, locks, recovery and encrypted storage initialization.\n请使用随附的隔离启动器；程序没有回落到日常资料。\nCode: ${code}`,
      buttons: ['Exit / 退出'], noLink: true });
  }).catch(() => undefined).finally(() => app.exit(78));
};

dispatchStartup(() => planProfileLocation(app, process.argv, readArtifactMode(app.getAppPath(), app.isPackaged)), {
  configure: (plan) => applyProfileLocation(app, plan),
  refuse,
  interactive: () => {
    registerDeskPetScheme();
    void import('./interactive-startup').then(({ startInteractive }) => startInteractive()).catch(() => refuse('startup.interactiveLoadFailed'));
  },
  inspection: (plan) => {
    // This branch never imports AppController, windows, providers, jobs or recovery.
    void app.whenReady().then(async () => {
      const { inspectExistingProfile, assertExistingMacCredentialNamespace, ProfileInspectionError } = await import('./profile-inspection');
      const { safeStorage } = await import('electron');
      const { runtimeIdentity } = await import('./runtime-identity');
      let report: unknown;
      let exitCode = 0;
      try {
        // Electron's patched fs treats app.asar as a virtual directory. Hash the
        // actual archive without changing global ASAR behavior or store reads.
        const archiveFS = createRequire(process.execPath)('original-fs') as { readFileSync: typeof readFileSync };
        report = { operation: 'read-only-profile-inspection', verdict: 'PASS', pid: process.pid, executablePath: process.execPath, appPath: app.getAppPath(),
          artifactMode: plan.artifactMode, runtimeName: app.getName(),
          runtimeIdentity: runtimeIdentity(),
          appASARSHA256: app.isPackaged ? createHash('sha256').update(archiveFS.readFileSync(app.getAppPath())).digest('hex') : null,
          ...(await inspectExistingProfile({ profilePath: plan.inspection!.profilePath, safeStorage,
            assertCredentialNamespace: () => assertExistingMacCredentialNamespace(plan.runtimeName) })) };
      } catch (error) {
        exitCode = 2;
        report = { operation: 'read-only-profile-inspection', verdict: 'FAIL', code: error instanceof ProfileInspectionError ? error.code : 'inspection.unavailable',
          pid: process.pid, executablePath: process.execPath, artifactMode: plan.artifactMode };
      }
      try { await writeFile(plan.inspection!.reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
      catch { exitCode = 2; }
      app.exit(exitCode);
    }).catch(() => app.exit(2));
  },
});
