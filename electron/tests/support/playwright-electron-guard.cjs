/* global __dirname, process */
// Playwright removes NODE_OPTIONS when spawning Electron. Inject the stub into
// that subprocess before its own -r loader, leaving the tested bundle untouched.
const cp = require('node:child_process');
const path = require('node:path');
const { realpathSync, existsSync } = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const electronPath = realpathSync(require('electron'));
const spawn = cp.spawn;
cp.spawn = function guardedSpawn(command, args, options) {
  if (
    typeof command === 'string' &&
    path.isAbsolute(command) &&
    existsSync(command) &&
    realpathSync(command) === electronPath
  ) {
    args = ['-r', path.join(__dirname, 'electron-dialog-stub.cjs'), ...args];
    options = { ...options, env: { ...(options?.env ?? process.env) } };
    delete options.env.NODE_OPTIONS;
  }
  return spawn.call(this, command, args, options);
};
syncBuiltinESMExports();
