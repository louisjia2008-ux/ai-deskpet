import type { Configuration } from 'webpack';

import { rules } from './webpack.rules';

export const rendererConfig: Configuration = {
  // Forge otherwise defaults to eval-source-map in development. Keep the same
  // no-eval CSP in the normal npm start path and in packaged renderer windows.
  devtool: 'source-map',
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'ts-loader',
          // Preserve renderer imports for Webpack's ESM resolution and tree
          // shaking. The Node/main-process compiler keeps its CommonJS output.
          options: { transpileOnly: false, compilerOptions: { module: 'ESNext' } },
        },
      },
      ...rules.slice(1),
    ],
  },
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css', '.json'],
  },
};
