import { isIP } from 'node:net';

/** Validated service configuration. */
export interface SignalingConfig {
  readonly mode: 'development' | 'production';
  readonly host: string;
  readonly port: number;
  readonly allowedOrigins: readonly string[];
  readonly roomTtlMs: number;
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
export function loadConfig(env: Environment): ConfigResult {
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

  return {
    ok: true,
    config: { mode, host, port, allowedOrigins, roomTtlMs: ttlSeconds * 1000 },
  };
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
