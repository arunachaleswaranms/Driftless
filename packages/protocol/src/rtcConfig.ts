// Bounded representation of the ICE server configuration the signaling
// service gives an admitted room member (Phase 2D).
//
// The service answers `RTC_CONFIG_REQUEST` from a connection that carries a
// room membership with `RTC_CONFIG`: a short list of STUN and TURN servers,
// and the time until which they may be used. TURN entries carry a
// short-lived username and credential that the service derives for this
// participant; the long-lived secret they derive from never leaves the
// service. Every bound below is a provisional implementation and security
// bound, not a limit of WebRTC.

/** At most this many ICE server entries in one `RTC_CONFIG`. */
export const MAX_RTC_ICE_SERVERS = 4;

/** At most this many URLs in one ICE server entry. */
export const MAX_RTC_ICE_SERVER_URLS = 4;

/** Upper bound on one ICE server URL, in bytes; a 253-character host name fits. */
export const MAX_ICE_SERVER_URL_BYTES = 300;

/** Upper bound on a TURN username, in bytes. */
export const MAX_ICE_SERVER_USERNAME_BYTES = 128;

/** Upper bound on a TURN credential, in bytes. */
export const MAX_ICE_SERVER_CREDENTIAL_BYTES = 128;

/**
 * Upper bound on how long an `RTC_CONFIG` may be used: `expiresAt` minus the
 * message's `sentAt`, both on the service's clock. One day, the longest room
 * lifetime the service accepts.
 */
export const MAX_RTC_CONFIG_TTL_MS = 86_400_000;

/**
 * One ICE server, mirroring `RTCIceServer`. Every field is always present.
 * A STUN entry has only `stun:` or `stuns:` URLs and a null username and
 * credential; a TURN entry has only `turn:` or `turns:` URLs and both a
 * username and a credential.
 */
export interface RtcIceServer {
  readonly urls: readonly string[];
  readonly username: string | null;
  readonly credential: string | null;
}

// A host is a DNS name, an IPv4 literal, or a bracketed IPv6 literal, with an
// optional port. No user information, path, fragment, or whitespace.
const HOST = String.raw`(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]+\])`;
const PORT = String.raw`(?::([0-9]{1,5}))?`;
// RFC 7064 (stun, stuns) and RFC 7065 (turn, turns): only TURN URLs may name
// a transport.
const STUN_URL = new RegExp(String.raw`^stuns?:${HOST}${PORT}$`);
const TURN_URL = new RegExp(String.raw`^turns?:${HOST}${PORT}(?:\?transport=(?:udp|tcp))?$`);

/** Printable ASCII without spaces. */
const TOKEN = /^[\x21-\x7e]+$/;

export type IceServerUrlKind = 'stun' | 'turn';

/**
 * Whether `value` is an acceptable STUN or TURN URL, and which. Any other
 * scheme, including `http:`, `https:`, and `javascript:`, is refused.
 */
export function iceServerUrlKind(value: unknown): IceServerUrlKind | undefined {
  if (typeof value !== 'string' || value.length > MAX_ICE_SERVER_URL_BYTES) return undefined;
  const stun = STUN_URL.exec(value);
  if (stun !== null) return validPort(stun[1]) ? 'stun' : undefined;
  const turn = TURN_URL.exec(value);
  if (turn !== null) return validPort(turn[1]) ? 'turn' : undefined;
  return undefined;
}

function validPort(port: string | undefined): boolean {
  return port === undefined || (Number(port) >= 1 && Number(port) <= 65_535);
}

/**
 * Validates an untrusted value as an `RtcIceServer` and returns a fresh plain
 * object built only from its validated fields, or undefined. Never throws.
 */
export function toRtcIceServer(value: unknown): RtcIceServer | undefined {
  if (!isPlainObject(value)) return undefined;
  const keys = Object.keys(value);
  if (
    keys.length !== ICE_SERVER_KEYS.length ||
    !keys.every((key) => (ICE_SERVER_KEYS as readonly string[]).includes(key))
  ) {
    return undefined;
  }
  const { urls, username, credential } = value as Readonly<Record<string, unknown>>;
  if (!Array.isArray(urls) || urls.length === 0 || urls.length > MAX_RTC_ICE_SERVER_URLS) {
    return undefined;
  }
  const accepted: string[] = [];
  let kind: IceServerUrlKind | undefined;
  for (const url of urls as unknown[]) {
    const urlKind = iceServerUrlKind(url);
    // One entry is either all STUN or all TURN, without duplicates.
    if (urlKind === undefined || (kind !== undefined && urlKind !== kind)) return undefined;
    if (accepted.includes(url as string)) return undefined;
    kind = urlKind;
    accepted.push(url as string);
  }
  if (kind === 'stun') {
    return username === null && credential === null
      ? { urls: accepted, username: null, credential: null }
      : undefined;
  }
  if (
    !isToken(username, MAX_ICE_SERVER_USERNAME_BYTES) ||
    !isToken(credential, MAX_ICE_SERVER_CREDENTIAL_BYTES)
  ) {
    return undefined;
  }
  return { urls: accepted, username, credential };
}

const ICE_SERVER_KEYS = ['urls', 'username', 'credential'] as const;

function isToken(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length <= maxBytes && TOKEN.test(value);
}

function isPlainObject(value: unknown): value is object {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
