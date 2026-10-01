import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  MAX_ICE_SERVER_CREDENTIAL_BYTES,
  MAX_ICE_SERVER_URL_BYTES,
  MAX_ICE_SERVER_USERNAME_BYTES,
  MAX_RTC_CONFIG_TTL_MS,
  MAX_RTC_ICE_SERVERS,
  MAX_RTC_ICE_SERVER_URLS,
  iceServerUrlKind,
  parseClientMessage,
  parseServerMessage,
  toRtcIceServer,
  type RtcIceServer,
} from '../src/index.js';
import { RTC_ICE_SERVERS, envelope } from './fixtures.js';

const TURN = RTC_ICE_SERVERS[1];
const STUN = RTC_ICE_SERVERS[0];

function rtcConfig(payload: unknown) {
  return parseServerMessage(envelope('RTC_CONFIG', payload));
}

describe('RTC configuration bounds', () => {
  it('are explicit, provisional values', () => {
    expect({
      MAX_RTC_ICE_SERVERS,
      MAX_RTC_ICE_SERVER_URLS,
      MAX_ICE_SERVER_URL_BYTES,
      MAX_ICE_SERVER_USERNAME_BYTES,
      MAX_ICE_SERVER_CREDENTIAL_BYTES,
      MAX_RTC_CONFIG_TTL_MS,
    }).toStrictEqual({
      MAX_RTC_ICE_SERVERS: 4,
      MAX_RTC_ICE_SERVER_URLS: 4,
      MAX_ICE_SERVER_URL_BYTES: 300,
      MAX_ICE_SERVER_USERNAME_BYTES: 128,
      MAX_ICE_SERVER_CREDENTIAL_BYTES: 128,
      MAX_RTC_CONFIG_TTL_MS: 86_400_000,
    });
  });
});

describe('iceServerUrlKind', () => {
  it('accepts STUN and TURN URLs with hosts, ports, and TURN transports', () => {
    for (const url of [
      'stun:stun.example.org',
      'stun:stun.example.org:3478',
      'stuns:stun.example.org:5349',
      'stun:192.0.2.1:3478',
      'stun:[2001:db8::1]:3478',
    ]) {
      expect(iceServerUrlKind(url)).toBe('stun');
    }
    for (const url of [
      'turn:turn.example.org',
      'turn:turn.example.org:3478?transport=udp',
      'turn:turn.example.org:3478?transport=tcp',
      'turns:turn.example.org:5349?transport=tcp',
      'turn:[2001:db8::1]:3478',
    ]) {
      expect(iceServerUrlKind(url)).toBe('turn');
    }
  });

  it('refuses every other scheme and malformed URL', () => {
    for (const url of [
      '',
      'https://turn.example.org',
      'http://turn.example.org',
      'javascript:alert(1)',
      'data:text/plain,x',
      'TURN:turn.example.org',
      'turn://turn.example.org',
      'turn:user@turn.example.org',
      'turn:turn.example.org/path',
      'turn:turn.example.org:0',
      'turn:turn.example.org:65536',
      'turn:turn.example.org?transport=tls',
      'turn:turn.example.org?transport=udp&x=1',
      'stun:stun.example.org?transport=udp',
      'turn: turn.example.org',
      'turn:turn.example.org ',
      'turn:-bad.example.org',
      `turn:${'a'.repeat(MAX_ICE_SERVER_URL_BYTES)}`,
    ]) {
      expect(iceServerUrlKind(url)).toBeUndefined();
    }
    for (const value of [undefined, null, 1, {}, ['turn:turn.example.org']]) {
      expect(iceServerUrlKind(value)).toBeUndefined();
    }
  });
});

describe('toRtcIceServer', () => {
  it('returns a fresh plain object of the validated fields', () => {
    const input = { ...TURN, urls: [...TURN.urls] };
    const server = toRtcIceServer(input);
    expect(server).toStrictEqual(TURN);
    expect(server).not.toBe(input);
    expect(server?.urls).not.toBe(input.urls);
    expectTypeOf(server).toEqualTypeOf<RtcIceServer | undefined>();
    expect(toRtcIceServer({ ...STUN, urls: [...STUN.urls] })).toStrictEqual(STUN);
  });

  it('requires credentials on TURN entries and forbids them on STUN entries', () => {
    expect(toRtcIceServer({ ...TURN, username: null })).toBeUndefined();
    expect(toRtcIceServer({ ...TURN, credential: null })).toBeUndefined();
    expect(toRtcIceServer({ ...STUN, username: 'user' })).toBeUndefined();
    expect(toRtcIceServer({ ...STUN, credential: 'secret' })).toBeUndefined();
  });

  it('refuses mixed, duplicate, empty, and too many URLs', () => {
    expect(
      toRtcIceServer({ ...TURN, urls: ['stun:stun.example.org', 'turn:turn.example.org'] }),
    ).toBeUndefined();
    expect(
      toRtcIceServer({ ...TURN, urls: ['turn:turn.example.org', 'turn:turn.example.org'] }),
    ).toBeUndefined();
    expect(toRtcIceServer({ ...TURN, urls: [] })).toBeUndefined();
    expect(toRtcIceServer({ ...TURN, urls: 'turn:turn.example.org' })).toBeUndefined();
    const five = Array.from({ length: MAX_RTC_ICE_SERVER_URLS + 1 }, (_, index) => {
      return `turn:turn${String(index)}.example.org`;
    });
    expect(toRtcIceServer({ ...TURN, urls: five })).toBeUndefined();
    expect(toRtcIceServer({ ...TURN, urls: five.slice(0, MAX_RTC_ICE_SERVER_URLS) })).toBeDefined();
  });

  it('bounds the username and credential, and requires printable ASCII without spaces', () => {
    const at = (bytes: number) => 'u'.repeat(bytes);
    expect(toRtcIceServer({ ...TURN, username: at(MAX_ICE_SERVER_USERNAME_BYTES) })).toBeDefined();
    expect(
      toRtcIceServer({ ...TURN, username: at(MAX_ICE_SERVER_USERNAME_BYTES + 1) }),
    ).toBeUndefined();
    expect(
      toRtcIceServer({ ...TURN, credential: at(MAX_ICE_SERVER_CREDENTIAL_BYTES) }),
    ).toBeDefined();
    expect(
      toRtcIceServer({ ...TURN, credential: at(MAX_ICE_SERVER_CREDENTIAL_BYTES + 1) }),
    ).toBeUndefined();
    for (const bad of ['', 'has space', 'tab\t', 'é', '\u0000']) {
      expect(toRtcIceServer({ ...TURN, username: bad })).toBeUndefined();
      expect(toRtcIceServer({ ...TURN, credential: bad })).toBeUndefined();
    }
  });

  it('refuses unknown, missing, and prototype fields', () => {
    expect(toRtcIceServer({ ...TURN, credentialType: 'password' })).toBeUndefined();
    expect(toRtcIceServer({ urls: TURN.urls, username: TURN.username })).toBeUndefined();
    expect(
      toRtcIceServer(
        JSON.parse(`{"urls":["stun:a.example"],"username":null,"credential":null,"__proto__":{}}`),
      ),
    ).toBeUndefined();
    for (const value of [null, undefined, 'turn:turn.example.org', [TURN], new Map()]) {
      expect(toRtcIceServer(value)).toBeUndefined();
    }
  });
});

describe('RTC_CONFIG_REQUEST', () => {
  it('is a client message with an empty payload', () => {
    expect(parseClientMessage(envelope('RTC_CONFIG_REQUEST', {})).ok).toBe(true);
    expect(parseClientMessage(envelope('RTC_CONFIG_REQUEST', { ttl: 1 })).ok).toBe(false);
  });

  it('is not a server message, and RTC_CONFIG is not a client message', () => {
    expect(parseServerMessage(envelope('RTC_CONFIG_REQUEST', {}))).toStrictEqual({
      ok: false,
      code: 'INVALID_MESSAGE',
      reason: 'unknown_type',
    });
    expect(
      parseClientMessage(envelope('RTC_CONFIG', { expiresAt: 1, iceServers: [] })),
    ).toStrictEqual({ ok: false, code: 'INVALID_MESSAGE', reason: 'unknown_type' });
  });
});

describe('RTC_CONFIG', () => {
  it('parses STUN and TURN entries, and an empty list', () => {
    const result = rtcConfig({ expiresAt: 5, iceServers: RTC_ICE_SERVERS });
    expect(result.ok && result.message.payload).toStrictEqual({
      expiresAt: 5,
      iceServers: RTC_ICE_SERVERS,
    });
    expect(rtcConfig({ expiresAt: 5, iceServers: [] }).ok).toBe(true);
  });

  it('bounds the number of entries', () => {
    const entries = Array.from({ length: MAX_RTC_ICE_SERVERS }, () => STUN);
    expect(rtcConfig({ expiresAt: 5, iceServers: entries }).ok).toBe(true);
    expect(rtcConfig({ expiresAt: 5, iceServers: [...entries, STUN] }).ok).toBe(false);
  });

  it('refuses any invalid entry, field, or expiry instead of skipping it', () => {
    for (const payload of [
      { expiresAt: 5, iceServers: [STUN, { ...TURN, urls: ['https://turn.example.org'] }] },
      { expiresAt: 5, iceServers: [{ urls: ['turn:turn.example.org'] }] },
      { expiresAt: 5, iceServers: 'stun:stun.example.org' },
      { expiresAt: -1, iceServers: [] },
      { expiresAt: 1.5, iceServers: [] },
      { expiresAt: '5', iceServers: [] },
      { iceServers: [] },
      { expiresAt: 5 },
      { expiresAt: 5, iceServers: [], iceTransportPolicy: 'relay' },
    ]) {
      expect(rtcConfig(payload)).toStrictEqual({
        ok: false,
        code: 'INVALID_MESSAGE',
        reason: 'invalid_payload',
      });
    }
  });

  it('never echoes a credential in a parse failure', () => {
    const credential = 'recognizable-turn-credential';
    const result = rtcConfig({
      expiresAt: 5,
      iceServers: [{ ...TURN, credential, extra: credential }],
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(credential);
  });
});
