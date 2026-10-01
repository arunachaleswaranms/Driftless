/**
 * The browser's ICE server configuration boundary.
 *
 * Phase 2B accepts STUN servers only, from the build-time development setting
 * `VITE_RTC_STUN_URLS`: a comma-separated list of `stun:` or `stuns:` URLs.
 * The default is no ICE server at all, which is enough for peers on one host;
 * no public STUN service is assumed. TURN is deliberately refused here: a
 * TURN credential in a browser build would be a long-lived public secret.
 * TURN will instead need short-lived credentials issued at run time, which
 * this boundary can later accept as a separate input.
 */

/** At most this many STUN URLs. */
export const MAX_STUN_URLS = 4;

/** Upper bound on one STUN URL, in characters; a 253-character host name fits. */
export const MAX_STUN_URL_LENGTH = 300;

export type IceServersResult =
  | { readonly ok: true; readonly iceServers: readonly RTCIceServer[] }
  | { readonly ok: false; readonly reason: 'invalid_ice_config' };

// `stun:` or `stuns:`, a DNS name, IPv4 literal, or bracketed IPv6 literal, and
// an optional port. No user information, path, query, or whitespace.
const STUN_URL =
  /^stuns?:(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]+\])(?::([0-9]{1,5}))?$/;

/**
 * Validates the configured STUN URLs. An unset or empty value means no ICE
 * servers. Any invalid entry rejects the whole configuration rather than
 * being skipped, so a mistake is never silently ignored.
 */
export function parseStunUrls(raw: string | undefined): IceServersResult {
  const value = raw?.trim() ?? '';
  if (value === '') return { ok: true, iceServers: [] };
  const urls = value.split(',').map((entry) => entry.trim());
  if (urls.length > MAX_STUN_URLS || !urls.every(isStunUrl)) {
    return { ok: false, reason: 'invalid_ice_config' };
  }
  return { ok: true, iceServers: [{ urls: [...new Set(urls)] }] };
}

function isStunUrl(url: string): boolean {
  if (url.length > MAX_STUN_URL_LENGTH) return false;
  const match = STUN_URL.exec(url);
  if (match === null) return false;
  const port = match[1];
  return port === undefined || (Number(port) >= 1 && Number(port) <= 65_535);
}
