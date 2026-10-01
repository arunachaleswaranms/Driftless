import { describe, expect, it } from 'vitest';
import { DEVELOPMENT_ORIGINS, loadConfig } from '../src/config.js';

function error(env: Record<string, string>): string {
  const result = loadConfig(env);
  if (result.ok) throw new Error('expected a configuration error');
  return result.error;
}

describe('loadConfig', () => {
  it('uses conservative development defaults without any environment', () => {
    expect(loadConfig({})).toStrictEqual({
      ok: true,
      config: {
        mode: 'development',
        host: '127.0.0.1',
        port: 8787,
        allowedOrigins: DEVELOPMENT_ORIGINS,
        roomTtlMs: 3_600_000,
        reconnectGraceMs: 30_000,
        heartbeatIntervalMs: 15_000,
        rtc: { stunUrls: [], turn: undefined, ttlMs: 3_600_000 },
      },
    });
    for (const origin of DEVELOPMENT_ORIGINS) {
      expect(new URL(origin).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
    }
  });

  it('reads explicit values', () => {
    const result = loadConfig({
      NODE_ENV: 'production',
      SIGNALING_HOST: '0.0.0.0',
      SIGNALING_PORT: '9000',
      SIGNALING_ALLOWED_ORIGINS: 'https://app.example, https://staging.example:8443',
      SIGNALING_ROOM_TTL_SECONDS: '600',
      SIGNALING_RECONNECT_GRACE_SECONDS: '45',
      SIGNALING_HEARTBEAT_SECONDS: '20',
    });
    expect(result).toStrictEqual({
      ok: true,
      config: {
        mode: 'production',
        host: '0.0.0.0',
        port: 9000,
        allowedOrigins: ['https://app.example', 'https://staging.example:8443'],
        roomTtlMs: 600_000,
        reconnectGraceMs: 45_000,
        heartbeatIntervalMs: 20_000,
        rtc: { stunUrls: [], turn: undefined, ttlMs: 3_600_000 },
      },
    });
  });

  it('accepts IPv6 literals, localhost, and port 0', () => {
    for (const host of ['::1', '::', 'localhost', '192.168.1.10']) {
      expect(loadConfig({ SIGNALING_HOST: host }).ok).toBe(true);
    }
    expect(loadConfig({ SIGNALING_PORT: '0' }).ok).toBe(true);
  });

  it('rejects invalid hosts', () => {
    for (const host of ['', 'example.com', '127.0.0.1:80', ' 127.0.0.1', 'http://127.0.0.1']) {
      expect(error({ SIGNALING_HOST: host })).toContain('SIGNALING_HOST');
    }
  });

  it('rejects invalid ports', () => {
    for (const port of [
      '',
      '-1',
      '65536',
      '1e3',
      '80.5',
      ' 80',
      '+80',
      '0x50',
      'NaN',
      'Infinity',
    ]) {
      expect(error({ SIGNALING_PORT: port })).toContain('SIGNALING_PORT');
    }
  });

  it('rejects impossible or unbounded room lifetimes', () => {
    for (const ttl of ['', '0', '59', '86401', '1e9', '3600.5', '-60', 'Infinity', 'forever']) {
      expect(error({ SIGNALING_ROOM_TTL_SECONDS: ttl })).toContain('SIGNALING_ROOM_TTL_SECONDS');
    }
    expect(loadConfig({ SIGNALING_ROOM_TTL_SECONDS: '60' }).ok).toBe(true);
    expect(loadConfig({ SIGNALING_ROOM_TTL_SECONDS: '86400' }).ok).toBe(true);
  });

  it('bounds the reconnect grace period and the liveness interval', () => {
    for (const grace of ['', '0', '4', '121', '30.5', '-30', '1e2', 'Infinity']) {
      expect(error({ SIGNALING_RECONNECT_GRACE_SECONDS: grace })).toContain(
        'SIGNALING_RECONNECT_GRACE_SECONDS',
      );
    }
    for (const grace of ['5', '120']) {
      expect(loadConfig({ SIGNALING_RECONNECT_GRACE_SECONDS: grace }).ok).toBe(true);
    }
    for (const interval of ['', '0', '4', '61', '15.5', '-15', 'never']) {
      expect(error({ SIGNALING_HEARTBEAT_SECONDS: interval })).toContain(
        'SIGNALING_HEARTBEAT_SECONDS',
      );
    }
    for (const interval of ['5', '60']) {
      expect(loadConfig({ SIGNALING_HEARTBEAT_SECONDS: interval }).ok).toBe(true);
    }
  });

  it('rejects wildcard, null, and malformed origins', () => {
    for (const origins of [
      '*',
      'null',
      '',
      ',',
      'https://app.example,',
      'https://*.example',
      'https://app.example/',
      'https://app.example/path',
      'https://app.example?x=1',
      'https://user:pass@app.example',
      'HTTPS://APP.EXAMPLE',
      'https://app.example:443',
      'ws://app.example',
      'file:///tmp',
      'app.example',
    ]) {
      expect(error({ SIGNALING_ALLOWED_ORIGINS: origins })).toContain('SIGNALING_ALLOWED_ORIGINS');
    }
  });

  it('bounds the number of origins and removes duplicates', () => {
    const many = Array.from(
      { length: 17 },
      (_, index) => `http://localhost:${String(3000 + index)}`,
    );
    expect(error({ SIGNALING_ALLOWED_ORIGINS: many.join(',') })).toContain('at most 16');
    const result = loadConfig({
      SIGNALING_ALLOWED_ORIGINS: 'http://localhost:5173,http://localhost:5173',
    });
    expect(result.ok && result.config.allowedOrigins).toStrictEqual(['http://localhost:5173']);
  });

  it('requires explicit https origins in production', () => {
    expect(error({ NODE_ENV: 'production' })).toContain('required');
    expect(
      error({ NODE_ENV: 'production', SIGNALING_ALLOWED_ORIGINS: 'http://localhost:5173' }),
    ).toContain('https');
  });

  it('does not echo rejected values', () => {
    const value = 'https://attacker.example/secret-token-value';
    expect(error({ SIGNALING_ALLOWED_ORIGINS: value })).not.toContain('secret-token-value');
  });
});

describe('ICE server and TURN configuration', () => {
  const SECRET = 'a-test-turn-shared-secret-of-sufficient-length';
  const TURN = 'turn:turn.example.org:3478?transport=udp, turns:turn.example.org:5349';
  const noFile = (): string => {
    throw new Error('no file system in this test');
  };

  function rtc(env: Record<string, string>, readFile: (path: string) => string = noFile) {
    const result = loadConfig(env, readFile);
    if (!result.ok) throw new Error(result.error);
    return result.config.rtc;
  }

  function rtcError(env: Record<string, string>, readFile: (path: string) => string = noFile) {
    const result = loadConfig(env, readFile);
    if (result.ok) throw new Error('expected a configuration error');
    return result.error;
  }

  it('reads STUN URLs, TURN URLs, an inline secret, and the credential lifetime', () => {
    expect(
      rtc({
        SIGNALING_STUN_URLS: 'stun:stun.example.org:3478',
        SIGNALING_TURN_URLS: TURN,
        SIGNALING_TURN_SECRET: SECRET,
        SIGNALING_TURN_CREDENTIAL_TTL_SECONDS: '600',
      }),
    ).toStrictEqual({
      stunUrls: ['stun:stun.example.org:3478'],
      turn: {
        urls: ['turn:turn.example.org:3478?transport=udp', 'turns:turn.example.org:5349'],
        secret: SECRET,
      },
      ttlMs: 600_000,
    });
  });

  it('reads the secret from a file, without one trailing line break', () => {
    const paths: string[] = [];
    const config = rtc(
      {
        SIGNALING_TURN_URLS: 'turn:turn.example.org',
        SIGNALING_TURN_SECRET_FILE: '/run/secrets/turn',
      },
      (path) => {
        paths.push(path);
        return `${SECRET}\n`;
      },
    );
    expect(paths).toStrictEqual(['/run/secrets/turn']);
    expect(config.turn?.secret).toBe(SECRET);
  });

  it('requires exactly one secret source with TURN URLs, and none without', () => {
    expect(rtcError({ SIGNALING_TURN_URLS: 'turn:turn.example.org' })).toContain(
      'SIGNALING_TURN_SECRET_FILE',
    );
    expect(
      rtcError({
        SIGNALING_TURN_URLS: 'turn:turn.example.org',
        SIGNALING_TURN_SECRET: SECRET,
        SIGNALING_TURN_SECRET_FILE: '/run/secrets/turn',
      }),
    ).toContain('only one');
    expect(rtcError({ SIGNALING_TURN_SECRET: SECRET })).toContain('SIGNALING_TURN_URLS');
    expect(rtcError({ SIGNALING_TURN_SECRET_FILE: '/x' })).toContain('SIGNALING_TURN_URLS');
  });

  it('refuses weak, malformed, and unreadable secrets without echoing them', () => {
    for (const secret of [
      'short',
      'has a space in the middle of a long secret value',
      'é'.repeat(40),
      'x'.repeat(513),
    ]) {
      const message = rtcError({
        SIGNALING_TURN_URLS: 'turn:turn.example.org',
        SIGNALING_TURN_SECRET: secret,
      });
      expect(message).toContain('TURN secret');
      expect(message).not.toContain(secret);
    }
    const unreadable = rtcError(
      {
        SIGNALING_TURN_URLS: 'turn:turn.example.org',
        SIGNALING_TURN_SECRET_FILE: '/missing/secret',
      },
      () => {
        throw new Error(`ENOENT ${SECRET}`);
      },
    );
    expect(unreadable).toBe('SIGNALING_TURN_SECRET_FILE could not be read.');
    expect(
      rtcError(
        { SIGNALING_TURN_URLS: 'turn:turn.example.org', SIGNALING_TURN_SECRET_FILE: '/x' },
        () => 'too-short\n',
      ),
    ).not.toContain('too-short');
  });

  it('refuses wrong schemes, too many URLs, and malformed URLs', () => {
    for (const urls of [
      'stun:stun.example.org',
      'https://turn.example.org',
      'turn:turn.example.org,',
      'turn:a.example,turn:b.example,turn:c.example,turn:d.example,turn:e.example',
    ]) {
      expect(rtcError({ SIGNALING_TURN_URLS: urls, SIGNALING_TURN_SECRET: SECRET })).toContain(
        'SIGNALING_TURN_URLS',
      );
    }
    for (const urls of ['turn:turn.example.org', 'stun:x.example?transport=udp', 'javascript:x']) {
      expect(rtcError({ SIGNALING_STUN_URLS: urls })).toContain('SIGNALING_STUN_URLS');
    }
  });

  it('bounds the credential lifetime', () => {
    for (const ttl of ['59', '86401', '0', '1e3', '']) {
      expect(rtcError({ SIGNALING_TURN_CREDENTIAL_TTL_SECONDS: ttl })).toContain(
        'SIGNALING_TURN_CREDENTIAL_TTL_SECONDS',
      );
    }
    expect(rtc({ SIGNALING_TURN_CREDENTIAL_TTL_SECONDS: '60' }).ttlMs).toBe(60_000);
    expect(rtc({ SIGNALING_TURN_CREDENTIAL_TTL_SECONDS: '86400' }).ttlMs).toBe(86_400_000);
  });
});
