/* global module */
'use strict';

const MAX_LINE_BYTES = 1024 * 1024;
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value, name, max, { optional = false } = {}) {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${name} 必须是 1–${max} 个字符`);
  }
  return value.trim();
}

function validateConfig(input) {
  if (!isObject(input)) throw new Error('缺少 Minecraft 连接配置');
  const host = boundedString(input.host, '服务器地址', 253);
  if (/[\s/@?#]/.test(host)) throw new Error('服务器地址只能填写主机名或 IP');
  const port = Number(input.port ?? 25565);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须为 1–65535');
  const username = boundedString(input.username, '角色名或 Microsoft 账号', 254);
  const auth = input.auth ?? 'offline';
  if (!['offline', 'microsoft'].includes(auth)) throw new Error('不支持的 Minecraft 登录方式');
  if (auth === 'offline' && !/^[a-zA-Z0-9_]{1,16}$/.test(username)) {
    throw new Error('离线角色名需要 1–16 个英文字母、数字或下划线');
  }
  const version = input.version === undefined || input.version === 'auto' ? false
    : boundedString(input.version, '游戏版本', 32);
  if (version && !/^\d+(?:\.\d+){1,2}$/.test(version)) throw new Error('请输入 Java 版版本号或 auto');
  const ownerName = boundedString(input.ownerName, '玩家名', 16, { optional: true });
  if (ownerName && !/^[a-zA-Z0-9_]{1,16}$/.test(ownerName)) throw new Error('玩家名格式不正确');
  return { host, port, username, auth, version, ownerName };
}

module.exports = { MAX_LINE_BYTES, validateConfig };
