import { isNegotiationId, NEGOTIATION_ID_BYTES } from '@driftless/protocol';
import { describe, expect, it, vi } from 'vitest';
import { MAX_STUN_URLS, parseIceTransportPolicy, parseStunUrls } from './iceServers.ts';
import { acceptRtcConfig, offersTurn } from './rtcConfig.ts';
import { createNegotiationId } from './negotiationId.ts';
import { SIGNALING_PATH, signalingUrlFor } from './signalingUrl.ts';

function location(href: string) {
  const url = new URL(href);
  return { protocol: url.protocol, host: url.host, hostname: url.hostname };
}

describe('signalingUrlFor', () => {
  it('uses wss on the page origin for https pages', () => {
    expect(signalingUrlFor(location('https://driftless.example/app?x=1#y'))).toStrictEqual({
      ok: true,
      url: 'wss://driftless.example/v1/signaling',
    });
    expect(signalingUrlFor(location('https://driftless.example:8443/'))).toStrictEqual({
      ok: true,
      url: 'wss://driftless.example:8443/v1/signaling',
    });
  });

  it('allows plain ws only for loopback development origins', () => {
    for (const href of ['http://localhost:4173/', 'http://127.0.0.1:5173/', 'http://[::1]:4173/']) {
      const result = signalingUrlFor(location(href));
      expect(result).toStrictEqual({
        ok: true,
        url: `ws://${new URL(href).host}${SIGNALING_PATH}`,
      });
    }
  });

  it('refuses insecure non-loopback and unusual origins', () => {
    for (const href of [
      'http://driftless.example/',
      'http://192.168.1.20:4173/',
      'http://localhost.example/',
      'file:///index.html',
      'ftp://localhost/',
    ]) {
      expect(signalingUrlFor(location(href))).toStrictEqual({
        ok: false,
        reason: 'insecure_origin',
      });
    }
  });

  it('never puts a query, fragment, or credential in the URL', () => {
    const result = signalingUrlFor(location('https://driftless.example/?room=abc#secret'));
    if (!result.ok) throw new Error('expected a URL');
    const url = new URL(result.url);
    expect(url.search).toBe('');
    expect(url.hash).toBe('');
    expect(url.pathname).toBe('/v1/signaling');
  });
});

describe('parseStunUrls', () => {
  it('defaults to no ICE servers', () => {
    for (const raw of [undefined, '', '   ']) {
      expect(parseStunUrls(raw)).toStrictEqual({ ok: true, iceServers: [] });
    }
  });

  it('accepts stun and stuns URLs', () => {
    expect(
      parseStunUrls(
        'stun:stun.example.org:3478, stuns:stun.example.org, stun:192.0.2.1, stun:[2001:db8::1]:3478',
      ),
    ).toStrictEqual({
      ok: true,
      iceServers: [
        {
          urls: [
            'stun:stun.example.org:3478',
            'stuns:stun.example.org',
            'stun:192.0.2.1',
            'stun:[2001:db8::1]:3478',
          ],
        },
      ],
    });
  });

  it('refuses TURN, credentials, queries, malformed hosts and ports, and too many URLs', () => {
    for (const raw of [
      'turn:turn.example.org',
      'turns:turn.example.org:5349',
      'stun:user:pass@stun.example.org',
      'stun:stun.example.org?transport=udp',
      'stun:',
      'stun:stun.example.org:0',
      'stun:stun.example.org:65536',
      'stun:-bad.example.org',
      'stun:stun..example.org',
      'stun:stun.example.org/path',
      'stun: stun.example.org',
      'http://stun.example.org',
      'stun:stun.example.org,',
      'stun:stun.example.org,,stun:b.example.org',
      `stun:${'a'.repeat(300)}`,
      Array.from(
        { length: MAX_STUN_URLS + 1 },
        (_, index) => `stun:s${String(index)}.example`,
      ).join(','),
    ]) {
      expect(parseStunUrls(raw), raw).toStrictEqual({ ok: false, reason: 'invalid_ice_config' });
    }
  });
});

describe('createNegotiationId', () => {
  it('encodes secure random bytes canonically', () => {
    const fill = vi.fn((bytes: Uint8Array) => {
      bytes.fill(0xff);
    });
    const id = createNegotiationId(fill);
    expect(fill).toHaveBeenCalledOnce();
    expect(fill.mock.calls[0]?.[0]).toHaveLength(NEGOTIATION_ID_BYTES);
    expect(id).toBe('_'.repeat(24));
    expect(isNegotiationId(id)).toBe(true);
  });

  it('uses crypto.getRandomValues by default and does not repeat', () => {
    const spy = vi.spyOn(crypto, 'getRandomValues');
    const ids = new Set(Array.from({ length: 200 }, () => createNegotiationId()));
    expect(ids.size).toBe(200);
    expect(spy).toHaveBeenCalledTimes(200);
    for (const id of ids) expect(isNegotiationId(id)).toBe(true);
  });

  it('never uses Math.random or the clock', () => {
    const random = vi.spyOn(Math, 'random');
    const now = vi.spyOn(Date, 'now');
    createNegotiationId();
    expect(random).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });
});

describe('parseIceTransportPolicy', () => {
  it('defaults to all and accepts only all or relay', () => {
    for (const raw of [undefined, '', '  ', 'all', ' all ']) {
      expect(parseIceTransportPolicy(raw)).toStrictEqual({ ok: true, policy: 'all' });
    }
    expect(parseIceTransportPolicy('relay')).toStrictEqual({ ok: true, policy: 'relay' });
    for (const raw of ['RELAY', 'public', 'none', 'relay,all', 'direct']) {
      expect(parseIceTransportPolicy(raw)).toStrictEqual({
        ok: false,
        reason: 'invalid_ice_config',
      });
    }
  });
});

describe('acceptRtcConfig', () => {
  const turn = {
    urls: ['turn:turn.example.org:3478?transport=udp'],
    username: '1760000600:label',
    credential: 'credential=',
  };
  const stun = { urls: ['stun:stun.example.org'], username: null, credential: null };
  const message = (expiresAt: number, sentAt: number, iceServers = [stun, turn]) =>
    ({
      protocolVersion: 1,
      type: 'RTC_CONFIG',
      sequence: 3,
      sentAt,
      payload: { expiresAt, iceServers },
    }) as const;

  it('maps entries to RTCIceServer and measures the lifetime on the service clock', () => {
    // The browser clock (5) is far from the service clock (1_000_000).
    expect(acceptRtcConfig(message(1_600_000, 1_000_000), 5)).toStrictEqual({
      iceServers: [
        { urls: ['stun:stun.example.org'] },
        {
          urls: ['turn:turn.example.org:3478?transport=udp'],
          username: '1760000600:label',
          credential: 'credential=',
        },
      ],
      turn: true,
      expiresAt: 600_005,
    });
    expect(acceptRtcConfig(message(10, 0, [stun]), 0)).toMatchObject({ turn: false });
    expect(acceptRtcConfig(message(10, 0, []), 0)).toStrictEqual({
      iceServers: [],
      turn: false,
      expiresAt: 10,
    });
  });

  it('refuses an expired, instant, or over-long configuration', () => {
    expect(acceptRtcConfig(message(1000, 1000), 0)).toBeUndefined();
    expect(acceptRtcConfig(message(999, 1000), 0)).toBeUndefined();
    expect(acceptRtcConfig(message(86_400_001, 0), 0)).toBeUndefined();
    expect(acceptRtcConfig(message(86_400_000, 0), 0)).toBeDefined();
  });
});

describe('offersTurn', () => {
  it('detects turn: and turns: URLs only', () => {
    expect(offersTurn({ iceServers: [{ urls: 'turn:a.example' }] })).toBe(true);
    expect(offersTurn({ iceServers: [{ urls: ['stun:a.example', 'turns:b.example'] }] })).toBe(
      true,
    );
    expect(offersTurn({ iceServers: [{ urls: ['stun:a.example'] }] })).toBe(false);
    expect(offersTurn({})).toBe(false);
  });
});
