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
    });
    expect(result).toStrictEqual({
      ok: true,
      config: {
        mode: 'production',
        host: '0.0.0.0',
        port: 9000,
        allowedOrigins: ['https://app.example', 'https://staging.example:8443'],
        roomTtlMs: 600_000,
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
