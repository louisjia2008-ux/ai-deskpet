import type { MessageKey } from './i18n';

export const TOOL_FAILURE_KEYS = {
  'tool.permission.math.calculate': 'tool.error.permissionMath',
  'tool.permission.time.read': 'tool.error.permissionTime',
  'tool.permission.system.read': 'tool.error.permissionSystem',
  'tool.permission.timer.write': 'tool.error.permissionTimer',
  'tool.permission.notification.write': 'tool.error.permissionNotification',
  'tool.permission.workspace.read': 'tool.error.permissionRead',
  'tool.permission.workspace.write': 'tool.error.permissionWrite',
  'tool.permission.web.read': 'tool.error.permissionWeb',
  'tool.permission.web.search': 'tool.error.permissionSearch',
  'tool.permission': 'tool.error.permission',
  'tool.channelBlocked': 'tool.error.channelBlocked',
  'tool.webBudgetExceeded': 'tool.error.webBudgetExceeded',
  'tool.invalidArguments': 'tool.error.arguments',
  'tool.notDeclared': 'tool.error.notDeclared',
  'tool.notRequested': 'tool.error.notRequested',
  'tool.unknown': 'tool.error.unknown',
  'tool.repeatedFailure': 'tool.error.unknown',
  'tool.network': 'tool.error.network',
  'tool.timeout': 'tool.error.timeout',
  'tool.webTarget': 'tool.error.webTarget',
  'tool.searchUnavailable': 'tool.error.searchUnavailable',
  'tool.pluginUnavailable': 'tool.error.pluginUnavailable',
  'tool.pluginAuthentication': 'tool.error.pluginAuthentication',
  'tool.pluginResponse': 'tool.error.pluginResponse',
  'tool.mcpReadFailed': 'tool.error.mcpReadFailed',
  'tool.mcpAuthentication': 'tool.error.mcpAuthentication',
  'tool.fileMissing': 'tool.error.fileMissing',
  'tool.fileAccess': 'tool.error.fileAccess',
  'tool.effectConflict': 'tool.error.effectConflict',
  'tool.executionFailed': 'tool.error.execution',
  'knowledge.folderPrivate': 'chat.error.contextPrivacy',
  'knowledge.policyChanged': 'chat.error.contextPrivacy',
  'knowledge.folderNotWritable': 'tool.error.fileAccess',
  'knowledge.noteInvalid': 'tool.error.arguments',
  'knowledge.nameUnavailable': 'tool.error.fileAccess',
  'knowledge.writeFailed': 'tool.error.fileAccess',
  'tool.contextPrivacyBlocked': 'chat.error.contextPrivacy',
} as const satisfies Readonly<Record<string, MessageKey>>;

export type ToolFailureCode = keyof typeof TOOL_FAILURE_KEYS;
export const isToolFailureCode = (code: unknown): code is ToolFailureCode => typeof code === 'string' && Object.hasOwn(TOOL_FAILURE_KEYS, code);

// Transport only a known, localized code; never expose raw URLs, paths or input.
export const toolFailureCode = (error: unknown): ToolFailureCode | undefined => {
  if (error !== null && typeof error === 'object' && 'code' in error && isToolFailureCode(error.code)) return error.code;
  return undefined;
};
