import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';

import { mainConfig } from './webpack.main.config';
import { rendererConfig } from './webpack.renderer.config';

const buildMode = process.env.DESKPET_PACKAGE_MODE ?? 'daily';
if (!['daily', 'validation-candidate'].includes(buildMode)) throw new Error('Choose daily or validation-candidate package mode.');
const validationCandidate = buildMode === 'validation-candidate';

const appName = validationCandidate ? 'DeskPet Electron Candidate' : 'DeskPet Electron';
const signingIdentity = process.env.DESKPET_MAC_SIGN_IDENTITY?.trim() || '-';

// The packager used by Forge defaults to ignoring signing failures, while
// the transitive declaration shipped by shared-types omits this packager option.
type MacSigning = Exclude<NonNullable<ForgeConfig['packagerConfig']>['osxSign'], boolean | undefined> & { continueOnError: false };
// A local self-signed certificate is untrusted, so the packager's `find-identity -v`
// check cannot see it. Selected by SHA-1, it is checked after packaging instead:
// verify-mac-package compares the sealed leaf certificate with that hash.
const pinnedCertificate = /^[0-9a-f]{40}$/iu.test(signingIdentity);
const macSigning: MacSigning = {
  identity: signingIdentity, identityValidation: signingIdentity !== '-' && !pinnedCertificate, type: 'development', continueOnError: false,
  preAutoEntitlements: false,
  optionsForFile: () => ({ entitlements: ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.disable-library-validation', 'com.apple.security.device.audio-input'] }),
};

const config: ForgeConfig = {
  hooks: {
    postPackage: async (_config, result) => {
      if (result.platform !== 'darwin') return;
      if (!result.outputPaths.length) throw new Error('No macOS package was produced.');
      for (const output of result.outputPaths) {
        execFileSync(process.execPath, [join(__dirname, 'scripts/verify-mac-package.mjs'),
          join(output, appName + '.app'), buildMode, signingIdentity === '-' ? 'ad-hoc' : 'certificate'], { stdio: 'inherit' });
      }
    },
    readPackageJson: async (_config, packageJson) => ({ ...packageJson, deskpetBuild: { version: 1, mode: buildMode } }),
  },
  packagerConfig: {
    ...(process.env.DESKPET_ELECTRON_ZIP_DIR ? { electronZipDir: process.env.DESKPET_ELECTRON_ZIP_DIR } : {}),
    name: appName,
    executableName: 'deskpet-electron',
    appBundleId: validationCandidate ? 'com.deskpet.companion.electron.validation' : 'com.deskpet.companion.electron',
    extendInfo: { DeskPetArtifactMode: buildMode, NSMicrophoneUsageDescription: '仅在你主动录音时使用麦克风，语音在本机识别。DeskPet uses the microphone only when you record a message. Speech is recognised locally on this Mac.' },
    appCategoryType: 'public.app-category.productivity',
    asar: true,
    // Local macOS installation: seal the final bundle and nested Electron code.
    // Developer ID signing and notarization remain separate distribution steps.
    ...(process.platform === 'darwin' ? { osxSign: macSigning } : {}),
    extraResource: [
      './resources/skills',
      './playwright-mcp-runtime',
      ...(process.platform === 'darwin' ? ['./wechat-runtime'] : []),
      ...(process.platform === 'darwin' ? ['./voice-runtime'] : []),
      ...(process.env.DESKPET_REA_BUNDLE_CONFIG ? [process.env.DESKPET_REA_BUNDLE_CONFIG] : []),
      './.minecraft-package/minecraft-runtime',
      './.minecraft-package/minecraft-companion-runtime',
      './.minecraft-package/node_modules',
      ...(process.platform === 'darwin' ? ['./migration/bin/DeskPetMigrationHelper'] : []),
    ],
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      name: 'deskpet_electron',
      setupExe: 'DeskPet-Electron-Setup.exe',
    }),
    new MakerZIP({}, ['darwin']),
    new MakerDeb({
      options: {
        maintainer: 'DeskPet contributors',
        homepage: 'https://github.com/louisjia2008-ux/ai-deskpet',
      },
    }),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new WebpackPlugin({
      mainConfig,
      renderer: {
        config: rendererConfig,
        entryPoints: [
          {
            html: './src/renderer/console/index.html',
            js: './src/renderer/console/index.tsx',
            name: 'main_window',
            preload: {
              js: './src/preload/index.ts',
            },
          },
          {
            html: './src/renderer/overlay/index.html',
            js: './src/renderer/overlay/index.tsx',
            name: 'overlay_window',
            preload: {
              js: './src/preload/index.ts',
            },
          },
        ],
      },
    }),
  ],
};

export default config;
