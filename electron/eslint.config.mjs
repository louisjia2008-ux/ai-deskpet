import eslint from '@eslint/js';
import parser from '@typescript-eslint/parser';
import typescript from '@typescript-eslint/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    // Imported Minecraft fixtures use the CommonJS/no-undef gate below instead
    // of application style rules, just like the imported engine itself.
    ignores: ['.webpack/**', '.swiftpm-cache/**', '.minecraft-package/**', '**/.ralph/**', 'minecraft-runtime/vendor/**', 'minecraft-runtime/test/**', 'minecraft-runtime/test-support/**', 'minecraft-runtime/tools/**', 'minecraft-runtime/node_modules/**', 'minecraft-companion-runtime/**', 'coverage/**', 'node_modules/**', 'out/**', 'playwright-report/**', 'test-results/**'],
  },
  eslint.configs.recommended,
  {
    // The WeChat reply helper is a CommonJS Node script copied byte-for-byte
    // into the listener; its control-character regexes are deliberate filters.
    files: ['wechat-runtime/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        AbortSignal: 'readonly', Buffer: 'readonly', __dirname: 'readonly', clearTimeout: 'readonly',
        crypto: 'readonly', fetch: 'readonly', process: 'readonly', require: 'readonly', module: 'readonly',
        setTimeout: 'readonly', window: 'readonly',
      },
    },
    rules: { 'no-control-regex': 'off', 'no-useless-escape': 'off' },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        Buffer: 'readonly',
        DOMException: 'readonly',
        Electron: 'readonly',
        Element: 'readonly',
        HTMLCanvasElement: 'readonly',
        HTMLButtonElement: 'readonly',
        Headers: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        ReadableStream: 'readonly',
        RequestInit: 'readonly',
        MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: 'readonly',
        MAIN_WINDOW_WEBPACK_ENTRY: 'readonly',
        NodeJS: 'readonly',
        OVERLAY_WINDOW_PRELOAD_WEBPACK_ENTRY: 'readonly',
        OVERLAY_WINDOW_WEBPACK_ENTRY: 'readonly',
        Response: 'readonly',
        ResizeObserver: 'readonly',
        TextDecoder: 'readonly',
        URL: 'readonly',
        __dirname: 'readonly',
        clearInterval: 'readonly',
        clearTimeout: 'readonly',
        crypto: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        navigator: 'readonly',
        process: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly',
        structuredClone: 'readonly',
        window: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': typescript,
      'react-hooks': reactHooks,
    },
    rules: {
      ...typescript.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
];
