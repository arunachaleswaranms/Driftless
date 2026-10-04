import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { iceServerUrlKind, type IceServerUrlKind } from '@driftless/protocol';
import type { RtcConfigPolicy } from './rtcConfig.js';

/** Validated service configuration. */
export interface SignalingConfig {
  readonly mode: 'development' | 'production';
  readonly host: string;
  readonly port: number;
  readonly allowedOrigins: readonly string[];
  readonly roomTtlMs: number;
  readonly reconnectGraceMs: number;
  readonly heartbeatIntervalMs: number;
  /** ICE servers for admitted room members, and the TURN secret. */
  readonly rtc: RtcConfigPolicy;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: SignalingConfig }
  | { readonly ok: false; readonly error: string };

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8787;

/** Provisional engineering default, not a product decision: one hour. */
export const DEFAULT_ROOM_TTL_SECONDS = 3600;
export const MIN_ROOM_TTL_SECONDS = 60;
export const MAX_ROOM_TTL_SECONDS = 86_400;

/** Provisional reconnect grace period: an implementation bound, not a UX promise. */
export const DEFAULT_RECONNECT_GRACE_SECONDS = 30;
export const MIN_RECONNECT_GRACE_SECONDS = 5;
export const MAX_RECONNECT_GRACE_SECONDS = 120;

/** Provisional WebSocket ping interval; not tuned for mobile networks. */
export const DEFAULT_HEARTBEAT_SECONDS = 15;
export const MIN_HEARTBEAT_SECONDS = 5;
export const MAX_HEARTBEAT_SECONDS = 60;

/**
 * Provisional lifetime of an issued ICE configuration and its TURN
 * credential: one hour, the default room lifetime. The TURN server checks a
 * credential's expiry on authenticated requests, which may include refreshes
 * of an allocation in use, so a lifetime shorter than a relayed session can
 * end that session; peer recovery then fetches a fresh credential. Every
 * credential is also capped at its room's expiry.
 */
export const DEFAULT_TURN_CREDENTIAL_TTL_SECONDS = 3600;
export const MIN_TURN_CREDENTIAL_TTL_SECONDS = 60;
export const MAX_TURN_CREDENTIAL_TTL_SECONDS = 86_400;

/** At most this many STUN URLs, and this many TURN URLs. */
export const MAX_ICE_URLS = 4;

/** Bounds on the TURN shared secret, in characters of printable ASCII. */
export const MIN_TURN_SECRET_LENGTH = 32;
export const MAX_TURN_SECRET_LENGTH = 512;

/** Reads a secret file. Injectable so tests need no file system. */
export type ReadSecretFile = (path: string) => string;

const readSecretFileFromDisk: ReadSecretFile = (path) => readFileSync(path, 'utf8');

/**
 * Development-only defaults: the web client's Vite development server and
 * preview server on loopback. Production has no default; it must list its
 * origins explicitly.
 */
export const DEVELOPMENT_ORIGINS: readonly string[] = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
];

const MAX_ALLOWED_ORIGINS = 16;
const DIGITS = /^[0-9]{1,6}$/;

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Reads the service configuration from environment variables. Invalid values
 * are rejected, never replaced by defaults. Error messages name the variable
 * but do not echo its value.
 */
export function loadConfig(
  env: Environment,
  readSecretFile: ReadSecretFile = readSecretFileFromDisk,
): ConfigResult {
  const nodeEnv = env.NODE_ENV;
  const mode = nodeEnv === 'production' ? 'production' : 'development';

  const host = env.SIGNALING_HOST ?? DEFAULT_HOST;
  if (host !== 'localhost' && isIP(host) === 0) {
    return fail('SIGNALING_HOST must be an IP address literal or "localhost".');
  }

  const port = readInteger(env.SIGNALING_PORT, DEFAULT_PORT, 0, 65_535);
  if (port === undefined) {
    return fail('SIGNALING_PORT must be an integer from 0 to 65535 (0 selects a free port).');
  }

  const ttlSeconds = readInteger(
    env.SIGNALING_ROOM_TTL_SECONDS,
    DEFAULT_ROOM_TTL_SECONDS,
    MIN_ROOM_TTL_SECONDS,
    MAX_ROOM_TTL_SECONDS,
  );
  if (ttlSeconds === undefined) {
    return fail(
      `SIGNALING_ROOM_TTL_SECONDS must be an integer from ${String(MIN_ROOM_TTL_SECONDS)} to ${String(MAX_ROOM_TTL_SECONDS)}.`,
    );
  }

  const graceSeconds = readInteger(
    env.SIGNALING_RECONNECT_GRACE_SECONDS,
    DEFAULT_RECONNECT_GRACE_SECONDS,
    MIN_RECONNECT_GRACE_SECONDS,
    MAX_RECONNECT_GRACE_SECONDS,
  );
  if (graceSeconds === undefined) {
    return fail(
      `SIGNALING_RECONNECT_GRACE_SECONDS must be an integer from ${String(MIN_RECONNECT_GRACE_SECONDS)} to ${String(MAX_RECONNECT_GRACE_SECONDS)}.`,
    );
  }

  const heartbeatSeconds = readInteger(
    env.SIGNALING_HEARTBEAT_SECONDS,
    DEFAULT_HEARTBEAT_SECONDS,
    MIN_HEARTBEAT_SECONDS,
    MAX_HEARTBEAT_SECONDS,
  );
  if (heartbeatSeconds === undefined) {
    return fail(
      `SIGNALING_HEARTBEAT_SECONDS must be an integer from ${String(MIN_HEARTBEAT_SECONDS)} to ${String(MAX_HEARTBEAT_SECONDS)}.`,
    );
  }

  const rawOrigins = env.SIGNALING_ALLOWED_ORIGINS;
  let allowedOrigins: readonly string[];
  if (rawOrigins === undefined) {
    if (mode === 'production') {
      return fail('SIGNALING_ALLOWED_ORIGINS is required when NODE_ENV=production.');
    }
    allowedOrigins = DEVELOPMENT_ORIGINS;
  } else {
    const parsed = parseOrigins(rawOrigins, mode);
    if (typeof parsed === 'string') return fail(parsed);
    allowedOrigins = parsed;
  }

  const rtc = loadRtcPolicy(env, readSecretFile);
  if (typeof rtc === 'string') return fail(rtc);

  return {
    ok: true,
    config: {
      mode,
      host,
      port,
      allowedOrigins,
      roomTtlMs: ttlSeconds * 1000,
      reconnectGraceMs: graceSeconds * 1000,
      heartbeatIntervalMs: heartbeatSeconds * 1000,
      rtc,
    },
  };
}

/**
 * The ICE servers for admitted room members. TURN needs both its URLs and
 * exactly one source of the shared secret: `SIGNALING_TURN_SECRET_FILE`, a
 * file holding it (preferred, for a secret store or a mounted secret), or
 * `SIGNALING_TURN_SECRET`. No message echoes the secret or the file's
 * contents.
 */
function loadRtcPolicy(env: Environment, readSecretFile: ReadSecretFile): RtcConfigPolicy | string {
  const stunUrls = parseIceUrls(env.SIGNALING_STUN_URLS, 'stun');
  if (stunUrls === undefined) {
    return `SIGNALING_STUN_URLS must be a comma-separated list of at most ${String(MAX_ICE_URLS)} stun: or stuns: URLs.`;
  }
  const turnUrls = parseIceUrls(env.SIGNALING_TURN_URLS, 'turn');
  if (turnUrls === undefined) {
    return `SIGNALING_TURN_URLS must be a comma-separated list of at most ${String(MAX_ICE_URLS)} turn: or turns: URLs.`;
  }
  const ttlSeconds = readInteger(
    env.SIGNALING_TURN_CREDENTIAL_TTL_SECONDS,
    DEFAULT_TURN_CREDENTIAL_TTL_SECONDS,
    MIN_TURN_CREDENTIAL_TTL_SECONDS,
    MAX_TURN_CREDENTIAL_TTL_SECONDS,
  );
  if (ttlSeconds === undefined) {
    return `SIGNALING_TURN_CREDENTIAL_TTL_SECONDS must be an integer from ${String(MIN_TURN_CREDENTIAL_TTL_SECONDS)} to ${String(MAX_TURN_CREDENTIAL_TTL_SECONDS)}.`;
  }

  const inline = env.SIGNALING_TURN_SECRET;
  const file = env.SIGNALING_TURN_SECRET_FILE;
  if (inline !== undefined && file !== undefined) {
    return 'Set only one of SIGNALING_TURN_SECRET and SIGNALING_TURN_SECRET_FILE.';
  }
  if (turnUrls.length === 0) {
    if (inline !== undefined || file !== undefined) {
      return 'A TURN secret is set but SIGNALING_TURN_URLS is not.';
    }
    return { stunUrls, turn: undefined, ttlMs: ttlSeconds * 1000 };
  }

  let secret: string;
  if (file !== undefined) {
    if (file === '') return 'SIGNALING_TURN_SECRET_FILE must name a file.';
    try {
      // One trailing line break, as an editor or `echo` leaves it, is not
      // part of the secret.
      secret = readSecretFile(file).replace(/\r?\n$/, '');
    } catch {
      return 'SIGNALING_TURN_SECRET_FILE could not be read.';
    }
  } else if (inline !== undefined) {
    secret = inline;
  } else {
    return 'SIGNALING_TURN_URLS requires SIGNALING_TURN_SECRET_FILE or SIGNALING_TURN_SECRET.';
  }
  if (!isTurnSecret(secret)) {
    return `The TURN secret must be ${String(MIN_TURN_SECRET_LENGTH)} to ${String(MAX_TURN_SECRET_LENGTH)} characters of printable ASCII without spaces.`;
  }
  return { stunUrls, turn: { urls: turnUrls, secret }, ttlMs: ttlSeconds * 1000 };
}

function parseIceUrls(raw: string | undefined, kind: IceServerUrlKind): string[] | undefined {
  if (raw === undefined || raw.trim() === '') return [];
  const entries = raw.split(',').map((entry) => entry.trim());
  if (entries.length > MAX_ICE_URLS) return undefined;
  if (!entries.every((entry) => iceServerUrlKind(entry) === kind)) return undefined;
  return [...new Set(entries)];
}

function isTurnSecret(value: string): boolean {
  return (
    value.length >= MIN_TURN_SECRET_LENGTH &&
    value.length <= MAX_TURN_SECRET_LENGTH &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

/**
 * Parses a comma-separated list of exact origins. A wildcard or `null` is never
 * accepted. Production additionally requires https.
 */
export function parseOrigins(
  raw: string,
  mode: SignalingConfig['mode'],
): readonly string[] | string {
  const entries = raw.split(',').map((entry) => entry.trim());
  if (entries.some((entry) => entry === '')) {
    return 'SIGNALING_ALLOWED_ORIGINS must be a comma-separated list of origins with no empty entries.';
  }
  if (entries.length > MAX_ALLOWED_ORIGINS) {
    return `SIGNALING_ALLOWED_ORIGINS may list at most ${String(MAX_ALLOWED_ORIGINS)} origins.`;
  }
  for (const entry of entries) {
    if (!isExactOrigin(entry)) {
      return 'SIGNALING_ALLOWED_ORIGINS entries must be exact origins such as https://app.example (scheme, host, and optional port only; no wildcard).';
    }
    if (mode === 'production' && !entry.startsWith('https://')) {
      return 'SIGNALING_ALLOWED_ORIGINS entries must use https when NODE_ENV=production.';
    }
  }
  return [...new Set(entries)];
}

/**
 * An origin exactly as a browser serializes it in the Origin header: http or
 * https, a host, an optional non-default port, and nothing else.
 */
function isExactOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // WHATWG URL parsing accepts '*' in a host name; a wildcard is never allowed.
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.origin === value &&
    !value.includes('*')
  );
}

function readInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number | undefined {
  if (raw === undefined) return fallback;
  if (!DIGITS.test(raw)) return undefined;
  const value = Number(raw);
  return value >= min && value <= max ? value : undefined;
}

function fail(error: string): ConfigResult {
  return { ok: false, error };
}
