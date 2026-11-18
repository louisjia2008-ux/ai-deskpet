import { createHash } from 'node:crypto';
import { ToolFailure } from '../runtime/tool-failure';

// The remote workspace can contain copied credential files even when it cannot
// reach the host vault. Apply this predicate to traversal as well as direct reads.
export const telegramCredentialPath = (path: string): boolean => path.normalize('NFKC').split(/[\\/]/u).some(part =>
  /^(?:\.(?:ssh|aws|gnupg|kube|git|docker|config)|\.env(?:[.-].*)?|\.(?:npmrc|pypirc|netrc|git-credentials)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|(?:credentials?|secrets?|tokens?|api[-_]?keys?|passwords?|auth)(?:[._-].*)?|.+\.(?:pem|key|pfx|p12|kdbx|keychain(?:-db)?))$/iu.test(part));

export function telegramWorkspacePreview(tool: string, input: unknown, privateTask: boolean, ownerInput = ''): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('telegram.invalidApproval');
  const { content, ...operation } = input as Record<string, unknown>;
  if (!['workspace.read', 'workspace.list', 'workspace.search', 'workspace.write'].includes(tool)) throw new Error('telegram.invalidApproval');
  if (typeof operation.path === 'string' && telegramCredentialPath(operation.path)) throw new Error('tool.channelBlocked');
  if (privateTask) {
    // A model can smuggle file contents into its next query or path. Only show
    // fields the owner themselves supplied on this turn. Do not offer blind approval.
    for (const field of ['path','query','find']) {
      const value = operation[field];
      if (typeof value === 'string' && value !== '.' && !ownerInput.includes(value)) throw new ToolFailure('tool.contextPrivacyBlocked');
    }
  }
  const details = typeof content === 'string'
    ? { ...operation, bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') }
    : operation;
  // JSON keeps control characters inside their fields. Large write contents stay on the computer.
  return tool + '\n' + JSON.stringify(details).replace(/[\p{Cf}\u2028\u2029]/gu, char =>
    char.split('').map(unit => '\\u' + unit.charCodeAt(0).toString(16).padStart(4, '0')).join(''));
}
