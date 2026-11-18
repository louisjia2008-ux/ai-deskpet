import { providerFailureCode } from './provider-errors';
import { providerSetupText } from './provider-setup-i18n';

type SetupChannel = 'providers:discover-models' | 'providers:upsert';

/** Electron wraps invoke rejections. Accept only its complete expected-channel
 * envelope and an independently allowlisted code; never render raw messages. */
export const providerSetupFailureText = (error: unknown, channel: SetupChannel, locale: string): string => {
  let code = providerFailureCode(error, '');
  if (!code && error instanceof Error) {
    const prefix = `Error invoking remote method '${channel}': Error: `;
    if (error.message.startsWith(prefix)) {
      const candidate = error.message.slice(prefix.length);
      code = providerFailureCode(new Error(candidate), '');
    }
  }
  const text = providerSetupText(locale);
  const keys = {
    'provider.authentication': 'provider.setupAuthentication',
    'provider.permissionDenied': 'provider.setupPermission',
    'provider.quota': 'provider.setupQuota',
    'provider.rateLimit': 'provider.setupRateLimit',
    'provider.limitUnknown': 'provider.setupLimitUnknown',
    'provider.timeout': 'provider.setupTimeout',
    'provider.network': 'provider.setupNetwork',
    'provider.catalogInvalid': 'provider.setupCatalogInvalid',
    'provider.credentialsRequired': 'provider.credentialsPending',
    'provider.credentialEndpointChanged': 'provider.endpointKeyChanged',
    'provider.bindingMismatch': 'provider.setupChanged',
    'provider.discoveryBusy': 'provider.setupBusy',
    'provider.configurationBusy': 'provider.setupBusy',
    'provider.unavailable': 'provider.setupUnavailable',
    'provider.request': 'provider.setupRequest',
  } as const;
  const key = keys[code as keyof typeof keys];
  if (key) return `${text(key)} (${code})`;
  return text(channel === 'providers:upsert' ? 'provider.setupSaveFailed' : 'provider.catalogError');
};
