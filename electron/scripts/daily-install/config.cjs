/* global process, __dirname */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const check = (value, code) => { if (!value) throw Error(code); };
const keys = ['version', 'installedApp', 'profileRoot', 'backupRoot', 'stageRoot', 'signingIdentity', 'electronZipDir',
  'workerDir', 'wechatRoot', 'launchAgent', 'launchAgentLabel', 'python'];
function privateFile(file) {
  const info = fs.lstatSync(file);
  check(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o777) === 0o600 && info.nlink === 1, 'unsafe-install-config');
}
function validate(config) {
  check(config && typeof config === 'object' && !Array.isArray(config) && config.version === 1
    && Object.keys(config).length === keys.length && keys.every(key => Object.hasOwn(config, key)), 'invalid-install-config');
  for (const key of keys.filter(key => !['version', 'signingIdentity', 'launchAgentLabel'].includes(key))) {
    check(typeof config[key] === 'string' && path.isAbsolute(config[key]) && path.resolve(config[key]) === config[key]
      && config[key] !== path.parse(config[key]).root
      && !/[\r\n\0]/u.test(config[key]) && !config[key].includes('<'), `invalid-config-${key}`);
  }
  check(/^[a-f0-9]{40}$/iu.test(config.signingIdentity), 'certificate-sha1-required');
  check(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/u.test(config.launchAgentLabel), 'invalid-launch-agent-label');
  check(path.basename(config.installedApp) === 'DeskPet Electron.app', 'invalid-daily-app-name');
  const protectedRoots = ['installedApp', 'profileRoot', 'workerDir', 'wechatRoot', 'backupRoot', 'stageRoot'].map(key => config[key]);
  for (let i = 0; i < protectedRoots.length; i++) for (let j = i + 1; j < protectedRoots.length; j++) {
    const a = protectedRoots[i], b = protectedRoots[j];
    check(a !== b && !a.startsWith(b + '/') && !b.startsWith(a + '/'), 'overlapping-install-roots');
  }
  return config;
}
function loadConfig(file = path.join(os.homedir(), '.config/deskpet/install.json')) {
  check(path.isAbsolute(file) && fs.realpathSync(file) === file, 'config-must-be-canonical'); privateFile(file);
  return validate(JSON.parse(fs.readFileSync(file, 'utf8')));
}
function context() {
  const stage = process.env.DESKPET_INSTALL_STAGE;
  check(stage && path.isAbsolute(stage) && fs.realpathSync(stage) === stage, 'install-stage-required');
  const info = fs.lstatSync(stage);
  check(info.isDirectory() && info.uid === process.getuid() && (info.mode & 0o777) === 0o700, 'unsafe-install-stage');
  const config = loadConfig(path.join(stage, 'install-config.json'));
  check(path.dirname(stage) === config.stageRoot, 'stage-outside-configured-root');
  privateFile(path.join(stage, 'install-context.json'));
  const record = JSON.parse(fs.readFileSync(path.join(stage, 'install-context.json'), 'utf8'));
  check(record.stage === stage && path.dirname(record.checkpoint) === config.backupRoot
    && /^install-\d{8}-[A-Za-z0-9._-]+$/u.test(path.basename(record.checkpoint)), 'invalid-install-context');
  return { stage, config, checkpoint: record.checkpoint, project: path.resolve(__dirname, '../..') };
}
module.exports = { check, validate, loadConfig, context, privateFile };
