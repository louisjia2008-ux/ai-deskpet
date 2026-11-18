import { win32 } from 'node:path';

/** Fixed trusted helpers receive OS runtime settings, never the host credential
 * environment, SSH agent, Node injection flags, proxies or browser session data.
 * This reduces propagation; it does not confer OS filesystem isolation. */
export const boundedChildEnvironment = (source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const names = ['SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'];
  return { PATH: process.platform === 'win32' ? win32.join(source.SystemRoot ?? 'C:/Windows', 'System32') : '/usr/bin:/bin:/usr/sbin:/sbin',
    ...Object.fromEntries(names.flatMap((name) => source[name] === undefined ? [] : [[name, source[name]]])) };
};
