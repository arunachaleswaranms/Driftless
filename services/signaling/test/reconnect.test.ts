import {
  MAX_NEGOTIATIONS_PER_MEMBERSHIP,
  type NegotiationId,
  type ParticipantId,
  type ResumeChallenge,
  type ResumeProof,
  type ResumeSecret,
  type ServerMessage,
  type SessionId,
} from '@driftless/protocol';
import { describe, expect, it } from 'vitest';
import {
  CLOSE_CODES,
  ERROR_MESSAGES,
  MAX_PROTOCOL_VIOLATIONS,
  RESUME_CHALLENGE_TTL_MS,
  SignalingController,
  isResumableClose,
  type Connection,
} from '../src/controller.js';
import { createMemoryLogger } from '../src/logger.js';
import { RoomStore } from '../src/roomStore.js';
import {
  FakeClock,
  clientMessage,
  expectType,
  flipped,
  parseStrict,
  proofFor,
  sequentialRandom,
} from './support.js';

const TTL = 600_000;
const GRACE = 30_000;
const A = 'A'.repeat(24) as NegotiationId;
const B = 'B'.repeat(24) as NegotiationId;
const SDP = 'v=0\r\na=ice-pwd:RECOVERSDPMARK\r\n';
const CANDIDATE = {
  candidate: 'candidate:1 1 udp 1 198.51.100.7 5000 typ host RECOVERCANDMARK',
  sdpMid: '0',
  sdpMLineIndex: 0,
  usernameFragment: 'ufrag',
};

interface TestClient {
  readonly connection: Connection;
  readonly received: ServerMessage[];
  readonly raw: string[];
  readonly closes: { code: number; reason: string }[];
  send(type: string, payload?: unknown): void;
  last(): ServerMessage | undefined;
}

function harness(options: { rateLimit?: { burst: number; perSecond: number } } = {}) {
  const clock = new FakeClock();
  const logger = createMemoryLogger();
  const store = new RoomStore({
    roomTtlMs: TTL,
    reconnectGraceMs: GRACE,
    random: sequentialRandom(),
  });
  const controller = new SignalingController({
    store,
    logger,
    clock: clock.read,
    random: sequentialRandom(),
    rateLimit: options.rateLimit ?? { burst: 1000, perSecond: 1000 },
  });

  function connect(): TestClient {
    const received: ServerMessage[] = [];
    const raw: string[] = [];
    const closes: { code: number; reason: string }[] = [];
    let sequence = 0;
    const connection = controller.connect({
      send(text) {
        raw.push(text);
        received.push(parseStrict(text));
      },
      close(code, reason) {
        closes.push({ code, reason });
      },
    });
    return {
      connection,
      received,
      raw,
      closes,
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

  /** Opens a new connection and runs BEGIN → CHALLENGE → PROVE with the given secret. */
  function resume(
    sessionId: SessionId,
    participantId: ParticipantId,
    secret: ResumeSecret,
    client = connect(),
  ) {
    client.send('SESSION_RESUME_BEGIN', { sessionId, participantId });
    const challenge = expectType(client.last(), 'SESSION_RESUME_CHALLENGE').payload.challenge;
    const proof = proofFor(secret, sessionId, participantId, challenge);
    client.send('SESSION_RESUME_PROVE', { challenge, proof });
    return { client, challenge, proof };
  }

  return { clock, logger, store, controller, connect, roomPair, resume };
}

function expectUnavailable(message: ServerMessage | undefined): void {
  expect(expectType(message, 'ERROR').payload).toStrictEqual({
    code: 'SESSION_UNAVAILABLE',
    message: ERROR_MESSAGES.SESSION_UNAVAILABLE,
    recoverable: true,
  });
}

describe('close classification', () => {
  it('treats only a normal close, going away, and a client protocol error as intentional', () => {
    expect(isResumableClose(1000)).toBe(false);
    expect(isResumableClose(1001)).toBe(false);
    expect(isResumableClose(1002)).toBe(false);
    for (const code of [1005, 1006, 1008, 1009, 1011, 4000]) {
      expect(isResumableClose(code)).toBe(true);
    }
  });
});

describe('signaling loss and presence', () => {
  it('holds a lost guest, tells the host, and resumes the same participant', () => {
    const h = harness();
    const { host, guest, created, joined } = h.roomPair();
    guest.connection.transportClosed(1006);
    expect(guest.connection.state).toBe('CLOSED');
    expect(expectType(host.last(), 'ROOM_PARTICIPANT_CONNECTION').payload).toStrictEqual({
      participantId: joined.payload.participantId,
      signaling: 'RECONNECTING',
      activeNegotiationId: null,
      negotiationCount: 0,
    });
    expect(h.store.memberCount).toBe(2);

    const { client } = h.resume(
      created.payload.sessionId,
      joined.payload.participantId,
      joined.payload.resumeSecret,
    );
    expect(expectType(client.last(), 'SESSION_RESUMED').payload).toStrictEqual({
      sessionId: created.payload.sessionId,
      roomId: created.payload.roomId,
      participantId: joined.payload.participantId,
      role: 'guest',
      expiresAt: created.payload.expiresAt,
      peer: { participantId: created.payload.participantId, role: 'host', signaling: 'CONNECTED' },
      activeNegotiationId: null,
      negotiationCount: 0,
    });
    expect(client.connection.state).toBe('IN_ROOM');
    expect(expectType(host.last(), 'ROOM_PARTICIPANT_CONNECTION').payload.signaling).toBe(
      'CONNECTED',
    );
    // The resumed connection is a full member again: it can leave, and the
    // host sees the ordinary intentional departure.
    client.send('ROOM_LEAVE');
    expectType(client.last(), 'ROOM_LEFT');
    expect(expectType(host.last(), 'ROOM_PARTICIPANT_LEFT').payload.reason).toBe('LEFT');
  });

  it('holds a lost host without closing the room or promoting the guest', () => {
    const h = harness();
    const { host, guest, created, joined } = h.roomPair();
    host.connection.transportClosed(1006);
    expect(h.store.roomCount).toBe(1);
    const notice = expectType(guest.last(), 'ROOM_PARTICIPANT_CONNECTION');
    expect(notice.payload.participantId).toBe(created.payload.participantId);
    expect(notice.payload.signaling).toBe('RECONNECTING');
    // The guest cannot offer: it is not promoted.
    guest.send('RTC_OFFER', { negotiationId: A, sdp: SDP });
    expectType(guest.last(), 'ERROR');

    const { client } = h.resume(
      created.payload.sessionId,
      created.payload.participantId,
      created.payload.resumeSecret,
    );
    const resumed = expectType(client.last(), 'SESSION_RESUMED').payload;
    expect(resumed.role).toBe('host');
    expect(resumed.participantId).toBe(created.payload.participantId);
    expect(resumed.peer).toStrictEqual({
      participantId: joined.payload.participantId,
      role: 'guest',
      signaling: 'CONNECTED',
    });
    expect(expectType(guest.last(), 'ROOM_PARTICIPANT_CONNECTION').payload.signaling).toBe(
      'CONNECTED',
    );
  });

  it('times a lost guest out and frees its slot, telling the host', () => {
    const h = harness();
    const { host, guest, created, joined } = h.roomPair();
    guest.connection.transportClosed(1006);
    h.clock.advance(GRACE - 1);
    h.controller.sweep();
    expectType(host.last(), 'ROOM_PARTICIPANT_CONNECTION');
    h.clock.advance(1);
    h.controller.sweep();
    expect(expectType(host.last(), 'ROOM_PARTICIPANT_LEFT').payload).toStrictEqual({
      participantId: joined.payload.participantId,
      reason: 'RECONNECT_TIMEOUT',
    });
    const late = h.resume(
      created.payload.sessionId,
      joined.payload.participantId,
      joined.payload.resumeSecret,
    );
    expectUnavailable(late.client.last());
    expect(h.logger.events).toContainEqual({ event: 'reconnect_timeout', role: 'guest' });
  });

  it('closes the room when the host does not return in time', () => {
    const h = harness();
    const { host, guest, created } = h.roomPair();
    host.connection.transportClosed(1006);
    h.clock.advance(GRACE);
    h.controller.sweep();
    expect(expectType(guest.last(), 'ROOM_CLOSED').payload.reason).toBe('HOST_RECONNECT_TIMEOUT');
    expect(guest.connection.state).toBe('NOT_IN_ROOM');
    const late = h.connect();
    late.send('ROOM_JOIN', {
      roomId: created.payload.roomId,
      inviteSecret: created.payload.inviteSecret,
    });
    expect(expectType(late.last(), 'ERROR').payload.code).toBe('ROOM_UNAVAILABLE');
  });

  it('tells a guest that joins while the host is away, and the host when it returns', () => {
    const h = harness();
    const host = h.connect();
    host.send('ROOM_CREATE');
    const created = expectType(host.last(), 'ROOM_CREATED');
    host.connection.transportClosed(1006);
    const guest = h.connect();
    guest.send('ROOM_JOIN', {
      roomId: created.payload.roomId,
      inviteSecret: created.payload.inviteSecret,
    });
    expect(guest.received.map((message) => message.type)).toStrictEqual([
      'ROOM_JOINED',
      'ROOM_PARTICIPANT_CONNECTION',
    ]);
    const joined = expectType(guest.received[0], 'ROOM_JOINED');
    const { client } = h.resume(
      created.payload.sessionId,
      created.payload.participantId,
      created.payload.resumeSecret,
    );
    expect(expectType(client.last(), 'SESSION_RESUMED').payload.peer).toStrictEqual({
      participantId: joined.payload.participantId,
      role: 'guest',
      signaling: 'CONNECTED',
    });
  });

  it('lets room expiry win over a reconnect in progress', () => {
    const h = harness();
    const { host, guest, created, joined } = h.roomPair();
    h.clock.advance(TTL - 1000);
    guest.connection.transportClosed(1006);
    h.clock.advance(1000);
    h.controller.sweep();
    expect(expectType(host.last(), 'ROOM_CLOSED').payload.reason).toBe('EXPIRED');
    expectUnavailable(
      h
        .resume(
          created.payload.sessionId,
          joined.payload.participantId,
          joined.payload.resumeSecret,
        )
        .client.last(),
    );
  });
});

describe('resume authentication', () => {
  it('answers a real and a nonexistent session with equivalent fresh challenges', () => {
    const h = harness();
    const { guest, created, joined } = h.roomPair();
    guest.connection.transportClosed(1006);
    const real = h.connect();
    real.send('SESSION_RESUME_BEGIN', {
      sessionId: created.payload.sessionId,
      participantId: joined.payload.participantId,
    });
    const fake = h.connect();
    fake.send('SESSION_RESUME_BEGIN', {
      sessionId: flipped(created.payload.sessionId),
      participantId: flipped(joined.payload.participantId),
    });
    const connected = h.connect();
    connected.send('SESSION_RESUME_BEGIN', {
      sessionId: created.payload.sessionId,
      participantId: created.payload.participantId,
    });
    const challenges = [real, fake, connected].map(
      (client) => expectType(client.last(), 'SESSION_RESUME_CHALLENGE').payload,
    );
    for (const payload of challenges) expect(Object.keys(payload)).toStrictEqual(['challenge']);
    expect(new Set(challenges.map((payload) => payload.challenge)).size).toBe(3);
    expect(real.connection.state).toBe('RESUMING');
    expect(h.controller.pendingChallengeCount).toBe(3);
  });

  it('gives one result for a wrong proof, a fake session, and an expired room', () => {
    const h = harness();
    const { guest, created, joined } = h.roomPair();
    guest.connection.transportClosed(1006);
    const wrong = h.resume(
      created.payload.sessionId,
      joined.payload.participantId,
      flipped(joined.payload.resumeSecret),
    ).client;
    const fake = h.resume(
      flipped(created.payload.sessionId),
      joined.payload.participantId,
      joined.payload.resumeSecret,
    ).client;
    h.clock.advance(TTL);
    const expired = h.resume(
      created.payload.sessionId,
      joined.payload.participantId,
      joined.payload.resumeSecret,
    ).client;
    const bodies = [wrong, fake, expired].map((client) => {
      expectUnavailable(client.last());
      return JSON.stringify(client.last()?.payload);
    });
    expect(new Set(bodies).size).toBe(1);
    for (const client of [wrong, fake, expired]) {
      expect(client.connection.state).toBe('NOT_IN_ROOM');
      expect(client.closes).toStrictEqual([]);
      const text = client.raw.join('');
      for (const value of [created.payload.roomId, created.payload.participantId]) {
        expect(text).not.toContain(value);
      }
    }
  });

  it('consumes the challenge whatever the outcome and never accepts a replayed proof', () => {
    const h = harness();
    const { guest, created, joined } = h.roomPair();
    const { sessionId } = created.payload;
    const { participantId, resumeSecret } = joined.payload;
    guest.connection.transportClosed(1006);

    // A failed proof consumes the challenge: a correct one cannot follow it.
    const first = h.connect();
    first.send('SESSION_RESUME_BEGIN', { sessionId, participantId });
    const challenge = expectType(first.last(), 'SESSION_RESUME_CHALLENGE').payload.challenge;
    first.send('SESSION_RESUME_PROVE', {
      challenge,
      proof: proofFor(flipped(resumeSecret), sessionId, participantId, challenge),
    });
    expectUnavailable(first.last());
    first.send('SESSION_RESUME_PROVE', {
      challenge,
      proof: proofFor(resumeSecret, sessionId, participantId, challenge),
    });
    expect(expectType(first.last(), 'ERROR').payload.code).toBe('INVALID_STATE');
    expect(h.controller.pendingChallengeCount).toBe(0);

    // A proof captured for one challenge does not answer another.
    const second = h.connect();
    second.send('SESSION_RESUME_BEGIN', { sessionId, participantId });
    second.send('SESSION_RESUME_PROVE', {
      challenge: expectType(second.last(), 'SESSION_RESUME_CHALLENGE').payload.challenge,
      proof: proofFor(resumeSecret, sessionId, participantId, challenge),
    });
    expectUnavailable(second.last());
    // Nor does naming the earlier challenge help.
    const third = h.connect();
    third.send('SESSION_RESUME_BEGIN', { sessionId, participantId });
    third.send('SESSION_RESUME_PROVE', {
      challenge,
      proof: proofFor(resumeSecret, sessionId, participantId, challenge),
    });
    expectUnavailable(third.last());

    // A valid resume, then a later loss: the captured proof is useless.
    const valid = h.resume(sessionId, participantId, resumeSecret);
    expectType(valid.client.last(), 'SESSION_RESUMED');
    valid.client.connection.transportClosed(1006);
    const replay = h.connect();
    replay.send('SESSION_RESUME_BEGIN', { sessionId, participantId });
    replay.send('SESSION_RESUME_PROVE', { challenge: valid.challenge, proof: valid.proof });
    expectUnavailable(replay.last());
    // The real participant still can.
    expectType(h.resume(sessionId, participantId, resumeSecret).client.last(), 'SESSION_RESUMED');
  });

  it('expires an unanswered challenge exactly at its deadline', () => {
    const h = harness();
    const { guest, created, joined } = h.roomPair();
    guest.connection.transportClosed(1006);
    const { sessionId } = created.payload;
    const { participantId, resumeSecret } = joined.payload;
    const late = h.connect();
    late.send('SESSION_RESUME_BEGIN', { sessionId, participantId });
    const challenge = expectType(late.last(), 'SESSION_RESUME_CHALLENGE').payload.challenge;
    h.clock.advance(RESUME_CHALLENGE_TTL_MS);
    late.send('SESSION_RESUME_PROVE', {
      challenge,
      proof: proofFor(resumeSecret, sessionId, participantId, challenge),
    });
    expectUnavailable(late.last());

    const swept = h.connect();
    swept.send('SESSION_RESUME_BEGIN', { sessionId, participantId });
    h.clock.advance(RESUME_CHALLENGE_TTL_MS - 1);
    h.controller.sweep();
    expect(swept.connection.state).toBe('RESUMING');
    h.clock.advance(1);
    h.controller.sweep();
    expect(swept.connection.state).toBe('NOT_IN_ROOM');
    expect(h.controller.pendingChallengeCount).toBe(0);
  });

  it('never takes over a participant whose connection is still live', () => {
    const h = harness();
    const { host, guest, created, joined } = h.roomPair();
    const attempt = h.resume(
      created.payload.sessionId,
      joined.payload.participantId,
      joined.payload.resumeSecret,
    );
    expectUnavailable(attempt.client.last());
    expect(attempt.client.connection.state).toBe('NOT_IN_ROOM');
    expect(guest.connection.state).toBe('IN_ROOM');
    expect(guest.closes).toStrictEqual([]);
    expect(h.store.memberCount).toBe(2);
    expect(h.store.connectedCount).toBe(2);
    // The original connection keeps working, and the host saw nothing.
    host.send('RTC_OFFER', { negotiationId: A, sdp: SDP });
    expectType(guest.last(), 'RTC_OFFER');
    expect(host.received.map((message) => message.type)).not.toContain(
      'ROOM_PARTICIPANT_CONNECTION',
    );
    expect(attempt.client.raw.join('')).not.toContain(joined.payload.resumeSecret);
  });

  it('powers down the old connection once the membership moves', () => {
    const h = harness();
    const { host, guest, created, joined } = h.roomPair();
    guest.connection.transportClosed(1006);
    const { client } = h.resume(
      created.payload.sessionId,
      joined.payload.participantId,
      joined.payload.resumeSecret,
    );
    // Late traffic arriving on the old connection is ignored entirely.
    const before = host.received.length;
    guest.send('RTC_ANSWER', { negotiationId: A, sdp: SDP });
    guest.send('ROOM_LEAVE');
    expect(host.received).toHaveLength(before);
    expect(client.connection.state).toBe('IN_ROOM');
    expect(h.store.membershipOf(guest.connection.id)).toBeUndefined();
  });

  it('starts a fresh sequence space on the new connection without authorizing it', () => {
    const h = harness();
    const { guest, created, joined } = h.roomPair();
    guest.connection.transportClosed(1006);
    const fresh = h.connect();
    // Sequence 0 on a new connection is accepted, but grants nothing on its own.
    fresh.send('RTC_ANSWER', { negotiationId: A, sdp: SDP });
    expect(expectType(fresh.last(), 'ERROR').payload.code).toBe('INVALID_STATE');
    const { client } = h.resume(
      created.payload.sessionId,
      joined.payload.participantId,
      joined.payload.resumeSecret,
      fresh,
    );
    expect(client.received.map((message) => message.sequence)).toStrictEqual([0, 1, 2]);
    expectType(client.last(), 'SESSION_RESUMED');
  });

  it('accepts resume messages only in the right state', () => {
    const h = harness();
    const { host, created } = h.roomPair();
    // A member cannot ask to resume or answer a challenge.
    host.send('SESSION_RESUME_BEGIN', {
      sessionId: created.payload.sessionId,
      participantId: created.payload.participantId,
    });
    expect(expectType(host.last(), 'ERROR').payload.code).toBe('INVALID_STATE');
    host.send('SESSION_RESUME_PROVE', {
      challenge: 'C'.repeat(32) as ResumeChallenge,
      proof: 'A'.repeat(43) as ResumeProof,
    });
    expect(expectType(host.last(), 'ERROR').payload.code).toBe('INVALID_STATE');
    // A proof without a challenge, and anything else while one is pending.
    const client = h.connect();
    client.send('SESSION_RESUME_PROVE', {
      challenge: 'C'.repeat(32) as ResumeChallenge,
      proof: 'A'.repeat(43) as ResumeProof,
    });
    expect(expectType(client.last(), 'ERROR').payload.code).toBe('INVALID_STATE');
    client.send('SESSION_RESUME_BEGIN', {
      sessionId: created.payload.sessionId,
      participantId: created.payload.participantId,
    });
    for (const type of ['ROOM_CREATE', 'SESSION_RESUME_BEGIN']) {
      client.send(
        type,
        type === 'ROOM_CREATE'
          ? {}
          : { sessionId: created.payload.sessionId, participantId: created.payload.participantId },
      );
      expect(expectType(client.last(), 'ERROR').payload.code).toBe('INVALID_STATE');
    }
    expect(h.store.roomCount).toBe(1);
    // A pending challenge does not survive its connection.
    client.connection.transportClosed(1006);
    expect(h.controller.pendingChallengeCount).toBe(0);
  });

  it('drops pending challenges and held memberships on shutdown', () => {
    const h = harness();
    const { guest, created, joined } = h.roomPair();
    guest.connection.transportClosed(1006);
    const pending = h.connect();
    pending.send('SESSION_RESUME_BEGIN', {
      sessionId: created.payload.sessionId,
      participantId: joined.payload.participantId,
    });
    expect(h.controller.pendingChallengeCount).toBe(1);
    h.controller.shutdown();
    expect(h.controller.pendingChallengeCount).toBe(0);
    expect(h.store.roomCount).toBe(0);
    expect(h.store.memberCount).toBe(0);
  });

  it('never logs the secret, proof, challenge, or identifiers', () => {
    const h = harness();
    const { guest, created, joined } = h.roomPair();
    guest.connection.transportClosed(1006);
    const failed = h.resume(
      created.payload.sessionId,
      joined.payload.participantId,
      flipped(joined.payload.resumeSecret),
    );
    const ok = h.resume(
      created.payload.sessionId,
      joined.payload.participantId,
      joined.payload.resumeSecret,
    );
    const logged = JSON.stringify(h.logger.events);
    for (const value of [
      created.payload.resumeSecret,
      joined.payload.resumeSecret,
      created.payload.sessionId,
      created.payload.roomId,
      created.payload.participantId,
      joined.payload.participantId,
      failed.challenge,
      failed.proof,
      ok.challenge,
      ok.proof,
    ]) {
      expect(logged).not.toContain(value);
    }
    const kinds = h.logger.events.map((event) => event.event);
    for (const kind of [
      'participant_disconnected',
      'resume_challenge_issued',
      'resume_rejected',
      'participant_resumed',
    ] as const) {
      expect(kinds).toContain(kind);
    }
    // Secrets go only to their owner, once.
    expect(ok.client.raw.join('')).not.toContain(joined.payload.resumeSecret);
    expect(ok.client.raw.join('')).not.toContain(created.payload.resumeSecret);
  });
});

describe('policy closures are terminal', () => {
  it('does not hold the membership of a connection closed for violations', () => {
    const h = harness();
    const { host, guest, created, joined } = h.roomPair();
    for (let index = 0; index < MAX_PROTOCOL_VIOLATIONS; index += 1)
      guest.connection.receiveText('{');
    expect(guest.closes[0]?.code).toBe(CLOSE_CODES.POLICY_VIOLATION);
    // The transport close that follows changes nothing.
    guest.connection.transportClosed(1008);
    expect(expectType(host.last(), 'ROOM_PARTICIPANT_LEFT').payload.reason).toBe('DISCONNECTED');
    expectUnavailable(
      h
        .resume(
          created.payload.sessionId,
          joined.payload.participantId,
          joined.payload.resumeSecret,
        )
        .client.last(),
    );
  });

  it('does not hold the membership of a rate-limited or binary-sending host', () => {
    const h = harness({ rateLimit: { burst: 3, perSecond: 1 } });
    const { host, guest, created } = h.roomPair();
    for (let index = 0; index < 10; index += 1) host.send('ROOM_CREATE');
    expect(expectType(guest.last(), 'ROOM_CLOSED').payload.reason).toBe('HOST_DISCONNECTED');
    h.clock.advance(10_000);
    expectUnavailable(
      h
        .resume(
          created.payload.sessionId,
          created.payload.participantId,
          created.payload.resumeSecret,
        )
        .client.last(),
    );

    const other = harness();
    const pair = other.roomPair();
    pair.guest.connection.receiveBinary();
    expect(expectType(pair.host.last(), 'ROOM_PARTICIPANT_LEFT').payload.reason).toBe(
      'DISCONNECTED',
    );
  });

  it('does not hold the membership when the transport reports a protocol violation', () => {
    const h = harness();
    const { host, guest } = h.roomPair();
    guest.connection.transportClosed(1009, true);
    expect(expectType(host.last(), 'ROOM_PARTICIPANT_LEFT').payload.reason).toBe('DISCONNECTED');
  });

  it('ends membership at once on intentional leave', () => {
    const h = harness();
    const { host, guest, created, joined } = h.roomPair();
    guest.send('ROOM_LEAVE');
    expect(expectType(host.last(), 'ROOM_PARTICIPANT_LEFT').payload.reason).toBe('LEFT');
    guest.connection.transportClosed(1006);
    expectUnavailable(
      h
        .resume(
          created.payload.sessionId,
          joined.payload.participantId,
          joined.payload.resumeSecret,
        )
        .client.last(),
    );
  });
});

describe('no traffic for an absent peer, and recovery relay', () => {
  function negotiated() {
    const h = harness();
    const pair = h.roomPair();
    pair.host.send('RTC_OFFER', { negotiationId: A, sdp: SDP });
    pair.guest.send('RTC_ANSWER', { negotiationId: A, sdp: SDP });
    return { h, ...pair };
  }

  it('refuses SDP, ICE, and recovery towards a reconnecting guest and replays nothing later', () => {
    const { h, host, guest, created, joined } = negotiated();
    guest.connection.transportClosed(1006);
    for (const [type, payload] of [
      ['RTC_RECOVER', { previousNegotiationId: A, negotiationId: B, sdp: SDP }],
      ['ICE_CANDIDATE', { negotiationId: A, candidate: CANDIDATE }],
      ['ICE_COMPLETE', { negotiationId: A }],
    ] as const) {
      host.send(type, payload);
      expect(expectType(host.last(), 'ERROR').payload.code).toBe('INVALID_STATE');
    }
    const { client } = h.resume(
      created.payload.sessionId,
      joined.payload.participantId,
      joined.payload.resumeSecret,
    );
    expect(client.received.map((message) => message.type)).toStrictEqual([
      'SESSION_RESUME_CHALLENGE',
      'SESSION_RESUMED',
    ]);
    // The snapshot still names the negotiation the service accepted.
    const resumed = expectType(client.last(), 'SESSION_RESUMED').payload;
    expect([resumed.activeNegotiationId, resumed.negotiationCount]).toStrictEqual([A, 1]);
    expect(expectType(host.last(), 'ROOM_PARTICIPANT_CONNECTION').payload).toMatchObject({
      signaling: 'CONNECTED',
      activeNegotiationId: A,
      negotiationCount: 1,
    });
  });

  it('relays a guest request and a host recovery offer, then refuses the old negotiation', () => {
    const { h, host, guest } = negotiated();
    guest.send('RTC_RECOVERY_REQUEST', { negotiationId: A });
    expect(expectType(host.last(), 'RTC_RECOVERY_REQUEST').payload).toStrictEqual({
      negotiationId: A,
    });
    guest.send('RTC_RECOVERY_REQUEST', { negotiationId: A });
    expect(expectType(guest.last(), 'ERROR').payload.code).toBe('INVALID_STATE');
    host.send('RTC_RECOVER', { previousNegotiationId: A, negotiationId: B, sdp: SDP });
    expect(expectType(guest.last(), 'RTC_RECOVER').payload).toStrictEqual({
      previousNegotiationId: A,
      negotiationId: B,
      sdp: SDP,
    });
    guest.send('ICE_COMPLETE', { negotiationId: A });
    expect(expectType(guest.last(), 'ERROR').payload.code).toBe('INVALID_STATE');
    guest.send('RTC_ANSWER', { negotiationId: B, sdp: SDP });
    expectType(host.last(), 'RTC_ANSWER');
    // The guest can never send a recovery offer.
    guest.send('RTC_RECOVER', { previousNegotiationId: B, negotiationId: A, sdp: SDP });
    expect(expectType(guest.last(), 'ERROR').payload.code).toBe('INVALID_STATE');
    const steps = h.logger.events.flatMap((event) =>
      event.event === 'negotiation_relayed' ? [event.step] : [],
    );
    expect(steps).toStrictEqual(['offer', 'answer', 'recovery_request', 'recover', 'answer']);
    const logged = JSON.stringify(h.logger.events);
    for (const marker of ['RECOVERSDPMARK', A, B]) expect(logged).not.toContain(marker);
  });

  it(`stops relaying recoveries after ${String(MAX_NEGOTIATIONS_PER_MEMBERSHIP)} negotiations`, () => {
    const { host, guest } = negotiated();
    const ids = ['B', 'C', 'D', 'E'].map((c) => c.repeat(24));
    let previous: string = A;
    for (const [index, id] of ids.entries()) {
      host.send('RTC_RECOVER', { previousNegotiationId: previous, negotiationId: id, sdp: SDP });
      if (index < MAX_NEGOTIATIONS_PER_MEMBERSHIP - 1) {
        expect(expectType(guest.last(), 'RTC_RECOVER').payload.negotiationId).toBe(id);
        previous = id;
      } else {
        expect(expectType(host.last(), 'ERROR').payload.code).toBe('INVALID_STATE');
      }
    }
  });
});
