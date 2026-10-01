import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';
import type { ParticipantId, ServerMessage } from '@driftless/protocol';
import { describe, expect, it } from 'vitest';
import {
  ERROR_MESSAGES,
  MAX_RTC_CONFIG_REQUESTS_PER_CONNECTION,
  SignalingController,
} from '../src/controller.js';
import { createMemoryLogger } from '../src/logger.js';
import { RoomStore } from '../src/roomStore.js';
import {
  RtcConfigIssuer,
  turnCredential,
  turnUserLabel,
  turnUsername,
  type RtcConfigPolicy,
} from '../src/rtcConfig.js';
import {
  FakeClock,
  clientMessage,
  expectType,
  parseStrict,
  proofFor,
  sequentialRandom,
} from './support.js';

// A test-only secret. The vector below was computed independently with
// Python's hmac and hashlib and checked with `openssl dgst -sha1 -hmac`.
const SECRET = 'driftless-test-turn-shared-secret-0123456789';
const PARTICIPANT = 'AAECAwQFBgcICQoL' as ParticipantId; // bytes 0..11
const VECTOR = {
  label: '55ExuweLHq6bAGju',
  username: '1760000600:55ExuweLHq6bAGju',
  credential: 'jNPBBpHb/yHa6E7b/JSRBd1m8bs=',
};

const NOW = 1_760_000_000_000;
const ROOM_TTL = 3_600_000;
const STUN = ['stun:stun.example.org:3478'];
const TURN = ['turn:turn.example.org:3478?transport=udp', 'turns:turn.example.org:5349'];

function policy(overrides: Partial<RtcConfigPolicy> = {}): RtcConfigPolicy {
  return { stunUrls: STUN, turn: { urls: TURN, secret: SECRET }, ttlMs: 600_000, ...overrides };
}

describe('TURN REST credentials', () => {
  it('match an independently computed vector', () => {
    expect(turnUserLabel(SECRET, PARTICIPANT)).toBe(VECTOR.label);
    expect(turnUsername(1_760_000_600, VECTOR.label)).toBe(VECTOR.username);
    expect(turnCredential(SECRET, VECTOR.username)).toBe(VECTOR.credential);
    // The draft's construction, checked against `openssl dgst -sha1 -hmac north`.
    expect(turnCredential('north', '1433895918:bob')).toBe('+qCJxktJhPsEAA0wfh7NCKO+G0M=');
  });

  it('is what a TURN server using the shared secret recomputes', () => {
    const issued = new RtcConfigIssuer(policy()).issue(PARTICIPANT, NOW, NOW + ROOM_TTL);
    const turn = issued.iceServers.find((server) => server.urls[0]?.startsWith('turn'));
    if (turn?.username == null || turn.credential === null) throw new Error('expected TURN');
    // What coturn does with use-auth-secret: HMAC-SHA1 of the received username.
    const recomputed = createHmac('sha1', SECRET).update(turn.username).digest('base64');
    expect(turn.credential).toBe(recomputed);
    expect(turn).toStrictEqual({
      urls: TURN,
      username: VECTOR.username,
      credential: VECTOR.credential,
    });
  });

  it('differs for another participant, another time, and another secret', () => {
    const issuer = new RtcConfigIssuer(policy());
    const credentialOf = (config: ReturnType<RtcConfigIssuer['issue']>) =>
      config.iceServers.find((server) => server.credential !== null);
    const base = credentialOf(issuer.issue(PARTICIPANT, NOW, NOW + ROOM_TTL));
    const other = Buffer.from(Array.from({ length: 12 }, (_, i) => 100 + i)).toString('base64url');
    const otherParticipant = credentialOf(
      issuer.issue(other as ParticipantId, NOW, NOW + ROOM_TTL),
    );
    const later = credentialOf(issuer.issue(PARTICIPANT, NOW + 5000, NOW + ROOM_TTL));
    const otherSecret = credentialOf(
      new RtcConfigIssuer(policy({ turn: { urls: TURN, secret: `${SECRET}-rotated` } })).issue(
        PARTICIPANT,
        NOW,
        NOW + ROOM_TTL,
      ),
    );
    const usernames = [base, otherParticipant, later, otherSecret].map((s) => s?.username);
    const credentials = [base, otherParticipant, later, otherSecret].map((s) => s?.credential);
    expect(new Set(credentials).size).toBe(4);
    // The same participant keeps one label at another time; the expiry changes.
    expect(later?.username?.split(':')[1]).toBe(base?.username?.split(':')[1]);
    expect(later?.username).not.toBe(base?.username);
    expect(new Set(usernames.map((u) => u?.split(':')[1])).size).toBe(3);
  });

  it('encodes the expiry in whole seconds and never outlives the TTL or the room', () => {
    const issuer = new RtcConfigIssuer(policy());
    const fresh = issuer.issue(PARTICIPANT, NOW + 999, NOW + ROOM_TTL);
    expect(fresh.expiresAt).toBe(NOW + 600_000);
    const expiry = Number(fresh.iceServers[1]?.username?.split(':')[0]);
    expect(expiry * 1000).toBe(fresh.expiresAt);
    expect(fresh.expiresAt).toBeLessThanOrEqual(NOW + 999 + 600_000);

    const late = issuer.issue(PARTICIPANT, NOW, NOW + 120_500);
    expect(late.expiresAt).toBe(NOW + 120_000);
    expect(Number(late.iceServers[1]?.username?.split(':')[0]) * 1000).toBe(late.expiresAt);
  });

  it('issues only STUN, or nothing, without TURN', () => {
    expect(
      new RtcConfigIssuer(policy({ turn: undefined })).issue(PARTICIPANT, NOW, NOW + ROOM_TTL),
    ).toStrictEqual({
      expiresAt: NOW + 600_000,
      iceServers: [{ urls: STUN, username: null, credential: null }],
      turn: false,
    });
    expect(
      new RtcConfigIssuer(policy({ turn: undefined, stunUrls: [] })).issue(
        PARTICIPANT,
        NOW,
        NOW + ROOM_TTL,
      ),
    ).toStrictEqual({ expiresAt: NOW + 600_000, iceServers: [], turn: false });
  });

  it('never includes the shared secret in what it issues', () => {
    const issued = new RtcConfigIssuer(policy()).issue(PARTICIPANT, NOW, NOW + ROOM_TTL);
    expect(JSON.stringify(issued)).not.toContain(SECRET);
    expect(JSON.stringify(issued)).not.toContain(PARTICIPANT);
  });
});

interface Client {
  readonly received: ServerMessage[];
  readonly raw: string[];
  readonly connection: ReturnType<SignalingController['connect']>;
  send(type: string, payload?: unknown): void;
  last(): ServerMessage | undefined;
}

/** `null` runs the controller with no issuer at all. */
function harness(issuerPolicy: RtcConfigPolicy | null = policy()) {
  const clock = new FakeClock(NOW);
  const logger = createMemoryLogger();
  const store = new RoomStore({
    roomTtlMs: ROOM_TTL,
    reconnectGraceMs: 30_000,
    random: sequentialRandom(),
  });
  const controller = new SignalingController({
    store,
    logger,
    clock: clock.read,
    rateLimit: { burst: 1000, perSecond: 1000 },
    ...(issuerPolicy === null ? {} : { rtcConfig: new RtcConfigIssuer(issuerPolicy) }),
  });
  function connect(): Client {
    const received: ServerMessage[] = [];
    const raw: string[] = [];
    let sequence = 0;
    const connection = controller.connect({
      send(text) {
        raw.push(text);
        received.push(parseStrict(text));
      },
      close() {
        // Not exercised here.
      },
    });
    return {
      received,
      raw,
      connection,
      send(type, payload = {}) {
        connection.receiveText(clientMessage(type, payload, sequence++));
      },
      last: () => received.at(-1),
    };
  }
  function roomPair() {
    const host = connect();
    host.send('ROOM_CREATE');
    const created = expectType(host.last(), 'ROOM_CREATED');
    const guest = connect();
    guest.send('ROOM_JOIN', {
      roomId: created.payload.roomId,
      inviteSecret: created.payload.inviteSecret,
    });
    const joined = expectType(guest.last(), 'ROOM_JOINED');
    return { host, guest, created, joined };
  }
  return { clock, logger, connect, roomPair };
}

function expectRefused(message: ServerMessage | undefined): void {
  expect(expectType(message, 'ERROR').payload).toStrictEqual({
    code: 'INVALID_STATE',
    message: ERROR_MESSAGES.INVALID_STATE,
    recoverable: true,
  });
}

describe('RTC_CONFIG_REQUEST', () => {
  it('answers a host and a guest each on their own connection only', () => {
    const { roomPair, clock } = harness();
    const { host, guest, created, joined } = roomPair();
    const hostBefore = host.received.length;
    guest.send('RTC_CONFIG_REQUEST');
    expect(host.received.length).toBe(hostBefore);
    const guestConfig = expectType(guest.last(), 'RTC_CONFIG');
    expect(guestConfig.payload.expiresAt).toBe(clock.now + 600_000);
    expect(guestConfig.payload.iceServers[0]).toStrictEqual({
      urls: STUN,
      username: null,
      credential: null,
    });
    const guestTurn = guestConfig.payload.iceServers[1];
    expect(guestTurn?.urls).toStrictEqual(TURN);
    expect(guestTurn?.username).toBe(
      `${String((clock.now + 600_000) / 1000)}:${turnUserLabel(SECRET, joined.payload.participantId)}`,
    );

    const guestBefore = guest.received.length;
    host.send('RTC_CONFIG_REQUEST');
    expect(guest.received.length).toBe(guestBefore);
    const hostTurn = expectType(host.last(), 'RTC_CONFIG').payload.iceServers[1];
    expect(hostTurn?.username).toBe(
      `${String((clock.now + 600_000) / 1000)}:${turnUserLabel(SECRET, created.payload.participantId)}`,
    );
    expect(hostTurn?.credential).not.toBe(guestTurn?.credential);
  });

  it('refuses a connection outside a room, before any room exists, and after leaving', () => {
    const { connect, roomPair, logger } = harness();
    const stranger = connect();
    stranger.send('RTC_CONFIG_REQUEST');
    expectRefused(stranger.last());
    const { guest } = roomPair();
    guest.send('ROOM_LEAVE');
    expectType(guest.last(), 'ROOM_LEFT');
    guest.send('RTC_CONFIG_REQUEST');
    expectRefused(guest.last());
    expect(stranger.raw.join('')).not.toContain('turn:');
    expect(guest.raw.at(-1)).not.toContain('turn:');
    expect(logger.events.filter((event) => event.event === 'rtc_config_issued')).toHaveLength(0);
  });

  it('refuses a resuming connection until its proof is accepted', () => {
    const { connect, roomPair } = harness();
    const { guest, joined } = roomPair();
    guest.connection.transportClosed(1006);
    const resuming = connect();
    resuming.send('SESSION_RESUME_BEGIN', {
      sessionId: joined.payload.sessionId,
      participantId: joined.payload.participantId,
    });
    const { challenge } = expectType(resuming.last(), 'SESSION_RESUME_CHALLENGE').payload;
    resuming.send('RTC_CONFIG_REQUEST');
    expectRefused(resuming.last());
    expect(resuming.raw.join('')).not.toContain('turn:');
    // The challenge is still pending; the refused request did not consume it.
    resuming.send('SESSION_RESUME_PROVE', {
      challenge,
      proof: proofFor(
        joined.payload.resumeSecret,
        joined.payload.sessionId,
        joined.payload.participantId,
        challenge,
      ),
    });
    expectType(resuming.last(), 'SESSION_RESUMED');
    resuming.send('RTC_CONFIG_REQUEST');
    expectType(resuming.last(), 'RTC_CONFIG');
  });

  it('refuses a reconnecting member and an unauthenticated resume attempt with a wrong proof', () => {
    const { connect, roomPair } = harness();
    const { guest, joined } = roomPair();
    guest.connection.transportClosed(1006);
    const attacker = connect();
    attacker.send('SESSION_RESUME_BEGIN', {
      sessionId: joined.payload.sessionId,
      participantId: joined.payload.participantId,
    });
    const { challenge } = expectType(attacker.last(), 'SESSION_RESUME_CHALLENGE').payload;
    attacker.send('SESSION_RESUME_PROVE', { challenge, proof: 'A'.repeat(43) });
    expect(expectType(attacker.last(), 'ERROR').payload.code).toBe('SESSION_UNAVAILABLE');
    attacker.send('RTC_CONFIG_REQUEST');
    expectRefused(attacker.last());
    expect(attacker.raw.join('')).not.toContain('turn:');
  });

  it('bounds the requests per connection', () => {
    const { roomPair } = harness();
    const { host } = roomPair();
    for (let index = 0; index < MAX_RTC_CONFIG_REQUESTS_PER_CONNECTION; index += 1) {
      host.send('RTC_CONFIG_REQUEST');
      expectType(host.last(), 'RTC_CONFIG');
    }
    host.send('RTC_CONFIG_REQUEST');
    expectRefused(host.last());
  });

  it('caps the configuration at the room expiry', () => {
    const { roomPair, clock } = harness(policy({ ttlMs: 86_400_000 }));
    const { host, created } = roomPair();
    clock.advance(1500);
    host.send('RTC_CONFIG_REQUEST');
    const config = expectType(host.last(), 'RTC_CONFIG');
    expect(config.payload.expiresAt).toBe(Math.floor(created.payload.expiresAt / 1000) * 1000);
    expect(config.payload.expiresAt - config.sentAt).toBeLessThanOrEqual(ROOM_TTL);
  });

  it('answers with an empty list, valid until the room expires, without an issuer', () => {
    const { roomPair, logger } = harness(null);
    const { host, created } = roomPair();
    host.send('RTC_CONFIG_REQUEST');
    expect(expectType(host.last(), 'RTC_CONFIG').payload).toStrictEqual({
      expiresAt: created.payload.expiresAt,
      iceServers: [],
    });
    expect(logger.events.at(-1)).toStrictEqual({
      event: 'rtc_config_issued',
      connection: 1,
      turn: 'not_configured',
    });
  });

  it('never logs the TURN username, credential, or secret', () => {
    const { roomPair, logger } = harness();
    const { host, guest } = roomPair();
    host.send('RTC_CONFIG_REQUEST');
    guest.send('RTC_CONFIG_REQUEST');
    const issued = [host, guest].map((client) => expectType(client.last(), 'RTC_CONFIG'));
    const logged = JSON.stringify(logger.events);
    for (const config of issued) {
      for (const server of config.payload.iceServers) {
        for (const value of [server.username, server.credential, ...server.urls]) {
          if (value !== null) expect(logged).not.toContain(value);
        }
      }
    }
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(turnUserLabel(SECRET, PARTICIPANT));
    expect(logger.events.filter((event) => event.event === 'rtc_config_issued')).toStrictEqual([
      { event: 'rtc_config_issued', connection: 1, turn: 'issued' },
      { event: 'rtc_config_issued', connection: 2, turn: 'issued' },
    ]);
  });
});
