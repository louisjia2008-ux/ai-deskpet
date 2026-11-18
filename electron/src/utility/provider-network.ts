import { net } from 'electron';

const CONNECTION_ERRORS = new Set([
  'ERR_PROXY_CONNECTION_FAILED', 'ERR_TUNNEL_CONNECTION_FAILED',
  'ERR_NO_SUPPORTED_PROXIES', 'ERR_MANDATORY_PROXY_CONFIGURATION_FAILED',
  'ERR_NAME_NOT_RESOLVED', 'ERR_NAME_RESOLUTION_FAILED', 'ERR_DNS_SERVER_FAILED',
  'ERR_CONNECTION_CLOSED', 'ERR_CONNECTION_RESET', 'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_ABORTED', 'ERR_CONNECTION_FAILED', 'ERR_ADDRESS_UNREACHABLE',
  'ERR_INTERNET_DISCONNECTED', 'ERR_NETWORK_CHANGED', 'ERR_NETWORK_ACCESS_DENIED',
  'ERR_SSL_PROTOCOL_ERROR', 'ERR_SSL_VERSION_OR_CIPHER_MISMATCH',
  'ERR_CERT_COMMON_NAME_INVALID', 'ERR_CERT_DATE_INVALID', 'ERR_CERT_AUTHORITY_INVALID',
  'ERR_CERT_REVOKED', 'ERR_CERT_INVALID', 'ERR_PROXY_CERTIFICATE_INVALID',
]);
const TIMEOUT_ERRORS = new Set(['ERR_TIMED_OUT', 'ERR_CONNECTION_TIMED_OUT', 'ERR_DNS_TIMED_OUT']);

/** Use the utility's Chromium system network context, including the user's OS
 * proxy/PAC configuration. Keep ambient cookies/auth out of provider requests;
 * the adapter still owns the explicit bearer header, URL, redirect and limits. */
export const providerNetworkFetch: typeof fetch = async (input, init) => {
  try {
    return await net.fetch(input instanceof URL ? input.href : input, { ...init, credentials: 'omit' });
  } catch (error) {
    // Chromium uses fixed `net::ERR_*` messages. Match the entire message so
    // arbitrary upstream text, URLs and credentials never become diagnostics.
    // Caller cancellation remains cancellation even if a network error races it.
    if (init?.signal?.aborted) throw error;
    const reason = error instanceof Error ? /^net::(ERR_[A-Z_]+)$/u.exec(error.message)?.[1] : undefined;
    const code = reason && TIMEOUT_ERRORS.has(reason) ? 'provider.timeout'
      : reason && CONNECTION_ERRORS.has(reason) ? 'provider.network' : undefined;
    if (code) throw Object.assign(new Error(code), { code });
    throw error;
  }
};
