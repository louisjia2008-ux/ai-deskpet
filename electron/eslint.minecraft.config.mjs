// Imported code keeps its original style; unresolved names must still fail CI.
export default [{
  files: ['minecraft-runtime/vendor/server/**/*.js', 'minecraft-runtime/test/**/*.js', 'minecraft-runtime/test-support/**/*.cjs', 'minecraft-runtime/tools/**/*.cjs', 'minecraft-companion-runtime/*.js', 'minecraft-companion-runtime/core/**/*.js', 'minecraft-companion-runtime/test/*.js'],
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
    globals: Object.fromEntries([
      'require', 'module', 'process', '__dirname', 'Buffer', 'console',
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
      'queueMicrotask', 'AbortController', 'AbortSignal', 'URL', 'setImmediate', 'clearImmediate', 'performance', 'structuredClone',
    ].map((name) => [name, 'readonly'])),
  },
  rules: { 'no-undef': 'error' },
}];
