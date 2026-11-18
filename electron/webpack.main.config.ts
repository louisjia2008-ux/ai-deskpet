import type { Configuration } from 'webpack';
import { DefinePlugin } from 'webpack';
import { join } from 'node:path';

import { rules } from './webpack.rules';
import { captureBuildIdentity } from './webpack.build-identity';

export const mainConfig: Configuration = {
  plugins: [new DefinePlugin({ DESKPET_BUILD_IDENTITY_JSON: DefinePlugin.runtimeValue(
    () => JSON.stringify(JSON.stringify(captureBuildIdentity(__dirname))),
    { contextDependencies: [join(__dirname, 'src')], fileDependencies: ['package.json', 'package-lock.json', 'forge.config.ts', 'webpack.main.config.ts', 'webpack.renderer.config.ts', 'webpack.rules.ts', 'webpack.build-identity.ts', 'tsconfig.json'].map((name) => join(__dirname, name)) },
  ) })],
  entry: {
    index: './src/main/index.ts',
    utility: './src/utility/entry.ts',
  },
  output: {
    filename: '[name].js',
  },
  module: { rules },
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css', '.json'],
  },
};
