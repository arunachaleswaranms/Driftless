import { Buffer } from 'node:buffer';
import {
  MAX_ICE_CANDIDATE_BYTES,
  MAX_ICE_CANDIDATES_PER_NEGOTIATION,
  MAX_SDP_BYTES,
  MAX_SIGNALING_MESSAGE_BYTES,
  type InviteSecret,
  type NegotiationId,
  type RoomId,
  type ServerMessage,
} from '@driftless/protocol';
import { describe, expect, it } from 'vitest';
import {
  CLOSE_CODES,
  ERROR_MESSAGES,
  MAX_PROTOCOL_VIOLATIONS,
  SignalingController,
  type Connection,
} from '../src/controller.js';
import { createMemoryLogger } from '../src/logger.js';
import { DEFAULT_RATE_LIMIT, type RateLimit } from '../src/rateLimiter.js';
import { RoomStore } from '../src/roomStore.js';
import { FakeClock, clientMessage, expectType, parseStrict, sequentialRandom } from './support.js';

const TTL = 60_000;

interface TestClient {
  readonly connection: Connection;
  readonly received: ServerMessage[];
  readonly raw: string[];
  readonly closes: { code: number; reason: string }[];
  send(type: string, payload?: unknown, extra?: object): void;
  sendRaw(text: string): void;
  last(): ServerMessage | undefined;
}

function harness(options: { rateLimit?: RateLimit; store?: RoomStore } = {}) {
  const clock = new FakeClock();
  const logger = createMemoryLogger();
  const store = options.store ?? new RoomStore({ roomTtlMs: TTL, random: sequentialRandom() });
  const controller = new SignalingController({
    store,
    logger,
    clock: clock.read,
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
        // Every server message must pass the strict protocol parser.
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
      send(type, payload = {}, extra = {}) {
        connection.receiveText(clientMessage(type, payload, sequence++, extra));
      },
      sendRaw(text) {
        connection.receiveText(text);
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

  return { clock, logger, store, controller, connect, roomPair };
}

function expectError(message: ServerMessage | undefined, code: string, recoverable: boolean): void {
  const error = expectType(message, 'ERROR');
  expect(error.payload).toStrictEqual({
    code,
    message: ERROR_MESSAGES[error.payload.code],
    recoverable,
  });
}

function otherSecret(secret: InviteSecret): InviteSecret {
  const bytes = Buffer.from(secret, 'base64url');
  bytes[5] = (bytes[5] ?? 0) ^ 1;
  return bytes.toString('base64url') as InviteSecret;
}

describe('room lifecycle', () => {
  it('creates a room and makes the creator host', () => {
    const { connect, clock } = harness();
    const host = connect();
    expect(host.connection.state).toBe('NOT_IN_ROOM');
    host.send('ROOM_CREATE');
    const created = expectType(host.last(), 'ROOM_CREATED');
    expect(created.payload.role).toBe('host');
    expect(created.payload.expiresAt).toBe(clock.now + TTL);
    expect(created.payload.roomId).not.toBe(created.payload.inviteSecret);
    expect(host.connection.state).toBe('IN_ROOM');
  });

  it('joins a guest and notifies both sides with sanitized events', () => {
    const { host, guest, created, joined } = harness().roomPair();
    expect(joined.payload).toStrictEqual({
      roomId: created.payload.roomId,
      participantId: joined.payload.participantId,
      role: 'guest',
      peer: { participantId: created.payload.participantId, role: 'host' },
      expiresAt: created.payload.expiresAt,
    });
    const notice = expectType(host.last(), 'ROOM_PARTICIPANT_JOINED');
    expect(notice.payload).toStrictEqual({
      participant: { participantId: joined.payload.participantId, role: 'guest' },
    });
    expect(guest.connection.state).toBe('IN_ROOM');
  });

  it('numbers server messages per connection from 0', () => {
    const { host, guest } = harness().roomPair();
    host.send('ROOM_LEAVE');
    expect(host.received.map((message) => message.sequence)).toStrictEqual([0, 1, 2]);
    expect(guest.received.map((message) => message.sequence)).toStrictEqual([0, 1]);
  });

  it('keeps the room when the guest leaves and tells the host', () => {
    const { host, guest, joined } = harness().roomPair();
    guest.send('ROOM_LEAVE');
    expectType(guest.last(), 'ROOM_LEFT');
    expect(guest.connection.state).toBe('NOT_IN_ROOM');
    expect(expectType(host.last(), 'ROOM_PARTICIPANT_LEFT').payload).toStrictEqual({
      participantId: joined.payload.participantId,
      reason: 'LEFT',
    });
    expect(host.connection.state).toBe('IN_ROOM');
  });

  it('closes the room when the host leaves without promoting the guest', () => {
    const { host, guest, store } = (() => {
      const h = harness();
      return { ...h.roomPair(), store: h.store };
    })();
    host.send('ROOM_LEAVE');
    expectType(host.last(), 'ROOM_LEFT');
    expect(expectType(guest.last(), 'ROOM_CLOSED').payload.reason).toBe('HOST_LEFT');
    expect(guest.connection.state).toBe('NOT_IN_ROOM');
    expect(store.roomCount).toBe(0);
    // The former guest may start its own room, as a new host.
    guest.send('ROOM_CREATE');
    expect(expectType(guest.last(), 'ROOM_CREATED').payload.role).toBe('host');
  });

  it('handles disconnects of the guest and of the host', () => {
    const first = harness().roomPair();
    first.guest.connection.transportClosed(1006);
    expect(first.guest.connection.state).toBe('CLOSED');
    expect(expectType(first.host.last(), 'ROOM_PARTICIPANT_LEFT').payload.reason).toBe(
      'DISCONNECTED',
    );

    const h = harness();
    const second = h.roomPair();
    second.host.connection.transportClosed(1001);
    expect(expectType(second.guest.last(), 'ROOM_CLOSED').payload.reason).toBe('HOST_DISCONNECTED');
    expect(h.store.roomCount).toBe(0);
    expect(h.controller.connectionCount).toBe(1);
  });

  it('expires rooms and tells every member', () => {
    const h = harness();
    const { host, guest, created } = h.roomPair();
    h.clock.advance(TTL - 1);
    h.controller.expireDueRooms();
    expect(h.store.roomCount).toBe(1);
    h.clock.advance(1);
    h.controller.expireDueRooms();
    expect(expectType(host.last(), 'ROOM_CLOSED').payload.reason).toBe('EXPIRED');
    expect(expectType(guest.last(), 'ROOM_CLOSED').payload.reason).toBe('EXPIRED');
    expect(host.connection.state).toBe('NOT_IN_ROOM');
    expect(guest.connection.state).toBe('NOT_IN_ROOM');

    const late = h.connect();
    late.send('ROOM_JOIN', {
      roomId: created.payload.roomId,
      inviteSecret: created.payload.inviteSecret,
    });
    expectError(late.last(), 'ROOM_UNAVAILABLE', true);
    expect(h.logger.events).toContainEqual({ event: 'room_closed', reason: 'EXPIRED' });
  });

  it('forgets closed connections', () => {
    const h = harness();
    const { host, guest } = h.roomPair();
    host.connection.transportClosed(1000);
    guest.connection.transportClosed(1000);
    expect(h.controller.connectionCount).toBe(0);
    expect(h.store.memberCount).toBe(0);
    // Late events for a closed connection are ignored.
    host.send('ROOM_CREATE');
    expect(h.store.roomCount).toBe(0);
  });
});

describe('connection state rules', () => {
  it('rejects create or join while in a room', () => {
    const h = harness();
    const { host, guest, created } = h.roomPair();
    const other = h.connect();
    other.send('ROOM_CREATE');
    const otherRoom = expectType(other.last(), 'ROOM_CREATED');

    host.send('ROOM_CREATE');
    expectError(host.last(), 'INVALID_STATE', true);
    guest.send('ROOM_CREATE');
    expectError(guest.last(), 'INVALID_STATE', true);
    guest.send('ROOM_JOIN', {
      roomId: created.payload.roomId,
      inviteSecret: created.payload.inviteSecret,
    });
    expectError(guest.last(), 'INVALID_STATE', true);
    // Cross-room: a member cannot also join another room, even with its secret.
    host.send('ROOM_JOIN', {
      roomId: otherRoom.payload.roomId,
      inviteSecret: otherRoom.payload.inviteSecret,
    });
    expectError(host.last(), 'INVALID_STATE', true);
    expect(h.store.roomCount).toBe(2);
    expect(h.store.memberCount).toBe(3);
  });

  it('rejects leave when not in a room', () => {
    const { connect } = harness();
    const client = connect();
    client.send('ROOM_LEAVE');
    expectError(client.last(), 'INVALID_STATE', true);
    expect(client.closes).toStrictEqual([]);
  });

  it('rejects a third participant with ROOM_FULL only when the secret is correct', () => {
    const h = harness();
    const { created } = h.roomPair();
    const third = h.connect();
    third.send('ROOM_JOIN', {
      roomId: created.payload.roomId,
      inviteSecret: created.payload.inviteSecret,
    });
    expectError(third.last(), 'ROOM_FULL', true);
    third.send('ROOM_JOIN', {
      roomId: created.payload.roomId,
      inviteSecret: otherSecret(created.payload.inviteSecret),
    });
    expectError(third.last(), 'ROOM_UNAVAILABLE', true);
    expect(third.connection.state).toBe('NOT_IN_ROOM');
  });

  it('gives identical responses for missing rooms, wrong secrets, and expired rooms', () => {
    const h = harness();
    const host = h.connect();
    host.send('ROOM_CREATE');
    const created = expectType(host.last(), 'ROOM_CREATED');
    const probe = h.connect();
    const attempts: [RoomId, InviteSecret][] = [
      ['AAAAAAAAAAAAAAAAAAAAAA' as RoomId, created.payload.inviteSecret],
      [created.payload.roomId, otherSecret(created.payload.inviteSecret)],
    ];
    for (const [roomId, inviteSecret] of attempts)
      probe.send('ROOM_JOIN', { roomId, inviteSecret });
    h.clock.advance(TTL);
    probe.send('ROOM_JOIN', {
      roomId: created.payload.roomId,
      inviteSecret: created.payload.inviteSecret,
    });
    const bodies = probe.received.map((message) => JSON.stringify(message.payload));
    expect(new Set(bodies).size).toBe(1);
    expectError(probe.last(), 'ROOM_UNAVAILABLE', true);
  });

  it('rejects participant identity claims in client messages', () => {
    const h = harness();
    const { host, guest, created } = h.roomPair();
    const intruder = h.connect();
    intruder.send('ROOM_LEAVE', { participantId: created.payload.participantId });
    expectError(intruder.last(), 'INVALID_MESSAGE', true);
    intruder.send(
      'ROOM_JOIN',
      { roomId: created.payload.roomId, inviteSecret: created.payload.inviteSecret },
      { participantId: created.payload.participantId },
    );
    expectError(intruder.last(), 'INVALID_MESSAGE', true);
    expect(host.connection.state).toBe('IN_ROOM');
    expect(guest.connection.state).toBe('IN_ROOM');
    expect(h.store.memberCount).toBe(2);
  });
});

describe('sequence rules', () => {
  it('requires strictly increasing client sequences', () => {
    const { connect } = harness();
    const client = connect();
    client.sendRaw(clientMessage('ROOM_LEAVE', {}, 5));
    expectError(client.last(), 'INVALID_STATE', true);
    client.sendRaw(clientMessage('ROOM_CREATE', {}, 5));
    expectError(client.last(), 'INVALID_MESSAGE', true);
    client.sendRaw(clientMessage('ROOM_CREATE', {}, 4));
    expectError(client.last(), 'INVALID_MESSAGE', true);
    expect(client.connection.state).toBe('NOT_IN_ROOM');
    // Gaps are allowed.
    client.sendRaw(clientMessage('ROOM_CREATE', {}, 100));
    expectType(client.last(), 'ROOM_CREATED');
  });

  it('does not consume a sequence number for an invalid message', () => {
    const { connect } = harness();
    const client = connect();
    client.sendRaw(clientMessage('ROOM_CREATE', { extra: 1 }, 1));
    expectError(client.last(), 'INVALID_MESSAGE', true);
    client.sendRaw(clientMessage('ROOM_CREATE', {}, 1));
    expectType(client.last(), 'ROOM_CREATED');
  });

  it('treats sentAt as diagnostic only', () => {
    const { connect } = harness();
    const client = connect();
    client.sendRaw(clientMessage('ROOM_CREATE', {}, 0, { sentAt: Number.MAX_SAFE_INTEGER }));
    expectType(client.last(), 'ROOM_CREATED');
  });
});

describe('abuse bounds', () => {
  it(`closes a connection after ${String(MAX_PROTOCOL_VIOLATIONS)} invalid messages`, () => {
    const h = harness();
    const { host, guest } = h.roomPair();
    for (let index = 1; index < MAX_PROTOCOL_VIOLATIONS; index += 1) {
      guest.sendRaw('not json');
      expectError(guest.last(), 'INVALID_MESSAGE', true);
    }
    expect(guest.closes).toStrictEqual([]);
    guest.sendRaw('{"protocolVersion":1}');
    expectError(guest.last(), 'INVALID_MESSAGE', false);
    expect(guest.closes).toStrictEqual([
      { code: CLOSE_CODES.POLICY_VIOLATION, reason: 'too many invalid messages' },
    ]);
    expect(guest.connection.state).toBe('CLOSED');
    expect(expectType(host.last(), 'ROOM_PARTICIPANT_LEFT').payload.reason).toBe('DISCONNECTED');
  });

  it('closes on an unsupported protocol version', () => {
    const { connect } = harness();
    const client = connect();
    client.sendRaw(clientMessage('ROOM_CREATE', {}, 0, { protocolVersion: 2 }));
    expectError(client.last(), 'UNSUPPORTED_PROTOCOL', false);
    expect(client.closes[0]?.code).toBe(CLOSE_CODES.PROTOCOL_ERROR);
  });

  it('refuses binary messages and closes', () => {
    const h = harness();
    const { host, guest } = h.roomPair();
    guest.connection.receiveBinary();
    expectError(guest.last(), 'INVALID_MESSAGE', false);
    expect(guest.closes[0]?.code).toBe(CLOSE_CODES.UNSUPPORTED_DATA);
    expect(guest.connection.state).toBe('CLOSED');
    expectType(host.last(), 'ROOM_PARTICIPANT_LEFT');
  });

  it('rate-limits a flooding connection and closes it', () => {
    const h = harness({ rateLimit: { burst: 5, perSecond: 1 } });
    const client = h.connect();
    for (let index = 0; index < 50; index += 1) client.send('ROOM_LEAVE');
    expect(client.received).toHaveLength(6);
    expect(client.received.slice(0, 5).every((m) => m.type === 'ERROR')).toBe(true);
    expectError(client.last(), 'RATE_LIMITED', false);
    expect(client.closes).toStrictEqual([
      { code: CLOSE_CODES.POLICY_VIOLATION, reason: 'rate limit exceeded' },
    ]);
    expect(h.controller.connectionCount).toBe(0);
  });

  it('allows paced traffic under the rate limit', () => {
    const h = harness({ rateLimit: { burst: 2, perSecond: 1 } });
    const client = h.connect();
    for (let index = 0; index < 20; index += 1) {
      client.send('ROOM_LEAVE');
      h.clock.advance(1000);
    }
    expect(client.closes).toStrictEqual([]);
    expect(client.received).toHaveLength(20);
  });

  it('turns an internal failure into a fixed SERVER_ERROR without logging its details', () => {
    const detail = 'internal detail that must not leak';
    class FailingStore extends RoomStore {
      override createRoom(): never {
        throw new Error(detail);
      }
    }
    const h = harness({ store: new FailingStore({ roomTtlMs: TTL }) });
    const client = h.connect();
    client.send('ROOM_CREATE');
    expectError(client.last(), 'SERVER_ERROR', false);
    expect(client.closes[0]?.code).toBe(CLOSE_CODES.INTERNAL_ERROR);
    expect(JSON.stringify([h.logger.events, client.raw])).not.toContain(detail);
    expect(h.logger.events).toContainEqual({ event: 'internal_error', context: 'dispatch' });
  });

  it('closes everything on shutdown', () => {
    const h = harness();
    const { host, guest } = h.roomPair();
    h.controller.shutdown();
    expect(host.closes[0]?.code).toBe(CLOSE_CODES.GOING_AWAY);
    expect(guest.closes[0]?.code).toBe(CLOSE_CODES.GOING_AWAY);
    expect(h.store.roomCount).toBe(0);
    expect(h.controller.connectionCount).toBe(0);
  });

  it('refuses connections after shutdown', () => {
    const h = harness();
    h.controller.shutdown();
    const late = h.connect();
    expect(late.closes).toStrictEqual([
      { code: CLOSE_CODES.GOING_AWAY, reason: 'server shutting down' },
    ]);
    expect(late.connection.state).toBe('CLOSED');
    late.send('ROOM_CREATE');
    expect(late.received).toStrictEqual([]);
    expect(h.store.roomCount).toBe(0);
    expect(h.controller.connectionCount).toBe(0);
  });
});

describe('secret and identifier leakage', () => {
  it('sends the invite secret only to the creator, once', () => {
    const h = harness();
    const { host, guest, created } = h.roomPair();
    const third = h.connect();
    third.send('ROOM_JOIN', {
      roomId: created.payload.roomId,
      inviteSecret: created.payload.inviteSecret,
    });
    guest.send('ROOM_LEAVE');
    host.send('ROOM_LEAVE');
    const secret = created.payload.inviteSecret;
    const hostOthers = host.raw.filter((text) => !text.includes('"ROOM_CREATED"'));
    expect(host.raw.filter((text) => text.includes(secret))).toHaveLength(1);
    for (const text of [...hostOthers, ...guest.raw, ...third.raw]) {
      expect(text).not.toContain(secret);
    }
  });

  it('never logs secrets, room IDs, or participant IDs', () => {
    const h = harness();
    const { guest, created, joined } = h.roomPair();
    guest.send('ROOM_JOIN', {
      roomId: created.payload.roomId,
      inviteSecret: otherSecret(created.payload.inviteSecret),
    });
    guest.sendRaw(`{"inviteSecret":"${created.payload.inviteSecret}"}`);
    guest.connection.transportClosed(1006);
    h.clock.advance(TTL);
    h.controller.expireDueRooms();

    const logged = JSON.stringify(h.logger.events);
    for (const value of [
      created.payload.inviteSecret,
      otherSecret(created.payload.inviteSecret),
      created.payload.roomId,
      created.payload.participantId,
      joined.payload.participantId,
    ]) {
      expect(logged).not.toContain(value);
    }
    const kinds = new Set(h.logger.events.map((event) => event.event));
    for (const kind of [
      'connection_opened',
      'room_created',
      'participant_joined',
      'message_rejected',
      'participant_left',
      'connection_closed',
      'room_closed',
    ]) {
      expect(kinds).toContain(kind);
    }
  });

  it('does not echo rejected input in errors', () => {
    const { connect } = harness();
    const client = connect();
    const marker = 'secret-marker-value';
    client.sendRaw(`{"protocolVersion":1,"type":"${marker}","sequence":0,"sentAt":0,"payload":{}}`);
    client.sendRaw(`{${marker}`);
    for (const text of client.raw) expect(text).not.toContain(marker);
  });
});

describe('WebRTC negotiation relay', () => {
  const NEGOTIATION = 'N'.repeat(24) as NegotiationId;
  const OTHER_NEGOTIATION = 'M'.repeat(24) as NegotiationId;
  // Recognizable secret-like material that must never be logged or echoed.
  const OFFER_SDP =
    'v=0\r\no=- 1 2 IN IP4 203.0.113.9\r\ns=-\r\nt=0 0\r\na=ice-ufrag:SDPUFRAGMARK\r\na=ice-pwd:SDPPWDMARK\r\na=fingerprint:sha-256 FINGERPRINTMARK\r\n';
  const ANSWER_SDP = OFFER_SDP.replace('203.0.113.9', '203.0.113.10');
  const CANDIDATE = {
    candidate: 'candidate:1 1 udp 2122260223 198.51.100.23 54400 typ host CANDIDATEMARK',
    sdpMid: '0',
    sdpMLineIndex: 0,
    usernameFragment: 'UFRAGMARK',
  };
  const MARKERS = [
    'SDPUFRAGMARK',
    'SDPPWDMARK',
    'FINGERPRINTMARK',
    'CANDIDATEMARK',
    'UFRAGMARK',
    '203.0.113',
    '198.51.100.23',
    NEGOTIATION,
  ];

  function offer(negotiationId = NEGOTIATION, sdp = OFFER_SDP) {
    return { negotiationId, sdp };
  }
  function answer(negotiationId = NEGOTIATION, sdp = ANSWER_SDP) {
    return { negotiationId, sdp };
  }
  function ice(negotiationId = NEGOTIATION, candidate: object = CANDIDATE) {
    return { negotiationId, candidate };
  }

  /** A room whose host has offered and whose guest has answered. */
  function negotiated(h = harness()) {
    const pair = h.roomPair();
    pair.host.send('RTC_OFFER', offer());
    pair.guest.send('RTC_ANSWER', answer());
    return { h, ...pair };
  }

  it('relays a complete negotiation between host and guest only', () => {
    const h = harness();
    const { host, guest } = h.roomPair();
    const third = h.connect();
    third.send('ROOM_CREATE');
    const before = {
      host: host.received.length,
      guest: guest.received.length,
      third: third.received.length,
    };

    host.send('RTC_OFFER', offer());
    expect(expectType(guest.last(), 'RTC_OFFER').payload).toStrictEqual(offer());
    host.send('ICE_CANDIDATE', ice());
    expect(expectType(guest.last(), 'ICE_CANDIDATE').payload).toStrictEqual(ice());
    guest.send('RTC_ANSWER', answer());
    expect(expectType(host.last(), 'RTC_ANSWER').payload).toStrictEqual(answer());
    guest.send('ICE_CANDIDATE', ice());
    expect(expectType(host.last(), 'ICE_CANDIDATE').payload).toStrictEqual(ice());
    host.send('ICE_COMPLETE', { negotiationId: NEGOTIATION });
    expect(expectType(guest.last(), 'ICE_COMPLETE').payload).toStrictEqual({
      negotiationId: NEGOTIATION,
    });
    guest.send('ICE_COMPLETE', { negotiationId: NEGOTIATION });
    expectType(host.last(), 'ICE_COMPLETE');

    // Each side received exactly the other side's three or four messages,
    // with no echo to the sender and nothing to an unrelated connection.
    expect(host.received.slice(before.host).map((m) => m.type)).toStrictEqual([
      'RTC_ANSWER',
      'ICE_CANDIDATE',
      'ICE_COMPLETE',
    ]);
    expect(guest.received.slice(before.guest).map((m) => m.type)).toStrictEqual([
      'RTC_OFFER',
      'ICE_CANDIDATE',
      'ICE_COMPLETE',
    ]);
    expect(third.received).toHaveLength(before.third);
    // Server sequences continue per connection across relayed messages.
    expect(guest.received.map((m) => m.sequence)).toStrictEqual(
      guest.received.map((_, index) => index),
    );
  });

  it('refuses negotiation from a connection that is not in a room', () => {
    const h = harness();
    const outsider = h.connect();
    for (const [type, payload] of [
      ['RTC_OFFER', offer()],
      ['RTC_ANSWER', answer()],
      ['ICE_CANDIDATE', ice()],
      ['ICE_COMPLETE', { negotiationId: NEGOTIATION }],
    ] as const) {
      outsider.send(type, payload);
      expectError(outsider.last(), 'INVALID_STATE', true);
    }
    expect(outsider.closes).toStrictEqual([]);
  });

  it('lets only the host offer and only the guest answer', () => {
    const { host, guest } = harness().roomPair();
    guest.send('RTC_OFFER', offer());
    expectError(guest.last(), 'INVALID_STATE', true);
    expectType(host.last(), 'ROOM_PARTICIPANT_JOINED');

    host.send('RTC_OFFER', offer());
    expectType(guest.last(), 'RTC_OFFER');
    host.send('RTC_ANSWER', answer());
    expectError(host.last(), 'INVALID_STATE', true);
    expectType(guest.last(), 'RTC_OFFER');
  });

  it('refuses an offer before a guest has joined', () => {
    const h = harness();
    const host = h.connect();
    host.send('ROOM_CREATE');
    host.send('RTC_OFFER', offer());
    expectError(host.last(), 'INVALID_STATE', true);
    host.send('ICE_CANDIDATE', ice());
    expectError(host.last(), 'INVALID_STATE', true);
    expect(h.store.negotiationCount).toBe(0);
  });

  it('refuses an answer or ICE without an active offer', () => {
    const { host, guest } = harness().roomPair();
    guest.send('RTC_ANSWER', answer());
    expectError(guest.last(), 'INVALID_STATE', true);
    host.send('ICE_CANDIDATE', ice());
    expectError(host.last(), 'INVALID_STATE', true);
    guest.send('ICE_COMPLETE', { negotiationId: NEGOTIATION });
    expectError(guest.last(), 'INVALID_STATE', true);
  });

  it('refuses messages that name a different negotiation', () => {
    const { host, guest } = harness().roomPair();
    host.send('RTC_OFFER', offer());
    guest.send('RTC_ANSWER', answer(OTHER_NEGOTIATION));
    expectError(guest.last(), 'INVALID_STATE', true);
    host.send('ICE_CANDIDATE', ice(OTHER_NEGOTIATION));
    expectError(host.last(), 'INVALID_STATE', true);
    host.send('ICE_COMPLETE', { negotiationId: OTHER_NEGOTIATION });
    expectError(host.last(), 'INVALID_STATE', true);
    // The real negotiation is unaffected.
    guest.send('RTC_ANSWER', answer());
    expectType(host.last(), 'RTC_ANSWER');
  });

  it('refuses a second offer and a second answer', () => {
    const { host, guest } = negotiated();
    host.send('RTC_OFFER', offer(OTHER_NEGOTIATION));
    expectError(host.last(), 'INVALID_STATE', true);
    host.send('RTC_OFFER', offer());
    expectError(host.last(), 'INVALID_STATE', true);
    guest.send('RTC_ANSWER', answer());
    expectError(guest.last(), 'INVALID_STATE', true);
  });

  it('refuses guest ICE before its answer, and ICE after completion', () => {
    const { host, guest } = harness().roomPair();
    host.send('RTC_OFFER', offer());
    guest.send('ICE_CANDIDATE', ice());
    expectError(guest.last(), 'INVALID_STATE', true);
    guest.send('ICE_COMPLETE', { negotiationId: NEGOTIATION });
    expectError(guest.last(), 'INVALID_STATE', true);
    // The host may trickle before the answer.
    host.send('ICE_CANDIDATE', ice());
    expectType(guest.last(), 'ICE_CANDIDATE');

    guest.send('RTC_ANSWER', answer());
    host.send('ICE_COMPLETE', { negotiationId: NEGOTIATION });
    host.send('ICE_CANDIDATE', ice());
    expectError(host.last(), 'INVALID_STATE', true);
    host.send('ICE_COMPLETE', { negotiationId: NEGOTIATION });
    expectError(host.last(), 'INVALID_STATE', true);
    // Completion is per participant: the guest may still trickle.
    guest.send('ICE_CANDIDATE', ice());
    expectType(host.last(), 'ICE_CANDIDATE');
  });

  it(`bounds each participant to ${String(MAX_ICE_CANDIDATES_PER_NEGOTIATION)} candidates`, () => {
    const { host, guest } = negotiated();
    for (let index = 0; index < MAX_ICE_CANDIDATES_PER_NEGOTIATION; index += 1) {
      host.send('ICE_CANDIDATE', ice());
      expectType(guest.last(), 'ICE_CANDIDATE');
    }
    const relayed = guest.received.length;
    host.send('ICE_CANDIDATE', ice());
    expectError(host.last(), 'INVALID_STATE', true);
    expect(guest.received).toHaveLength(relayed);
    // The guest's own allowance is separate.
    guest.send('ICE_CANDIDATE', ice());
    expectType(host.last(), 'ICE_CANDIDATE');
  });

  it('forgets the negotiation when the guest leaves, and never relays it to a new guest', () => {
    const h = harness();
    const { host, guest, created } = negotiated(h);
    expect(h.store.negotiationCount).toBe(1);
    guest.send('ROOM_LEAVE');
    expectType(host.last(), 'ROOM_PARTICIPANT_LEFT');
    expect(h.store.negotiationCount).toBe(0);

    // Stale messages for the old negotiation are refused, by both sides.
    guest.send('ICE_CANDIDATE', ice());
    expectError(guest.last(), 'INVALID_STATE', true);
    host.send('ICE_CANDIDATE', ice());
    expectError(host.last(), 'INVALID_STATE', true);

    const next = h.connect();
    next.send('ROOM_JOIN', {
      roomId: created.payload.roomId,
      inviteSecret: created.payload.inviteSecret,
    });
    expectType(next.last(), 'ROOM_JOINED');
    const joinedAt = next.received.length;
    // The new guest inherits nothing: old-ID answers and ICE are refused,
    // the host cannot reuse the old ID, and only a fresh offer is relayed.
    next.send('RTC_ANSWER', answer());
    expectError(next.last(), 'INVALID_STATE', true);
    host.send('ICE_CANDIDATE', ice());
    expectError(host.last(), 'INVALID_STATE', true);
    host.send('RTC_OFFER', offer());
    expectError(host.last(), 'INVALID_STATE', true);
    expect(next.received.slice(joinedAt).map((m) => m.type)).toStrictEqual(['ERROR']);

    host.send('RTC_OFFER', offer(OTHER_NEGOTIATION));
    expect(expectType(next.last(), 'RTC_OFFER').payload.negotiationId).toBe(OTHER_NEGOTIATION);
    next.send('RTC_ANSWER', answer(OTHER_NEGOTIATION));
    expectType(host.last(), 'RTC_ANSWER');
  });

  it('forgets the negotiation when the guest disconnects', () => {
    const h = harness();
    const { host, guest } = negotiated(h);
    guest.connection.transportClosed(1006);
    expect(h.store.negotiationCount).toBe(0);
    host.send('ICE_COMPLETE', { negotiationId: NEGOTIATION });
    expectError(host.last(), 'INVALID_STATE', true);
  });

  it('refuses negotiation after the room closes', () => {
    const first = negotiated();
    first.host.send('ROOM_LEAVE');
    expectType(first.guest.last(), 'ROOM_CLOSED');
    first.guest.send('ICE_CANDIDATE', ice());
    expectError(first.guest.last(), 'INVALID_STATE', true);
    expect(first.h.store.negotiationCount).toBe(0);

    const second = negotiated();
    second.h.clock.advance(TTL);
    second.h.controller.expireDueRooms();
    second.host.send('ICE_CANDIDATE', ice());
    expectError(second.host.last(), 'INVALID_STATE', true);
    second.guest.send('ICE_CANDIDATE', ice());
    expectError(second.guest.last(), 'INVALID_STATE', true);
    expect(second.h.store.negotiationCount).toBe(0);
  });

  it('rejects malformed, overlong, and destination-bearing negotiation messages', () => {
    const { host, guest } = harness().roomPair();
    const rejected = [
      offer(NEGOTIATION, ''),
      offer(NEGOTIATION, 'x'.repeat(MAX_SDP_BYTES + 1)),
      offer(NEGOTIATION, 'é'.repeat(MAX_SDP_BYTES / 2 + 1)),
      { ...offer(), roomId: 'AAAAAAAAAAAAAAAAAAAAAA' },
      { ...offer(), participantId: 'AAAAAAAAAAAAAAAA' },
      { ...offer(), role: 'host' },
      offer('short' as NegotiationId),
    ];
    for (const payload of rejected.slice(0, 4)) {
      host.send('RTC_OFFER', payload);
      expectError(host.last(), 'INVALID_MESSAGE', true);
    }
    for (const candidate of [
      { ...CANDIDATE, candidate: 'c'.repeat(MAX_ICE_CANDIDATE_BYTES + 1) },
      { ...CANDIDATE, extra: true },
      { candidate: CANDIDATE.candidate },
    ]) {
      guest.send('ICE_CANDIDATE', ice(NEGOTIATION, candidate));
      expectError(guest.last(), 'INVALID_MESSAGE', true);
    }
    expectType(guest.last(), 'ERROR');
    // Nothing reached the other side.
    expect(
      guest.received.filter((m) => m.type !== 'ROOM_JOINED' && m.type !== 'ERROR'),
    ).toStrictEqual([]);
  });

  it('accepts an SDP exactly at its bound', () => {
    const { host, guest } = harness().roomPair();
    const sdp = 'x'.repeat(MAX_SDP_BYTES);
    host.send('RTC_OFFER', offer(NEGOTIATION, sdp));
    expect(expectType(guest.last(), 'RTC_OFFER').payload.sdp).toBe(sdp);
  });

  it('refuses a message whose relay could exceed the message bound, before any state change', () => {
    const h = harness();
    const { host, guest } = h.roomPair();
    // Pad a valid offer with escape-heavy SDP until the sender's text is just
    // within the bound; the relay's longer envelope would not be.
    const prefix = clientMessage('RTC_OFFER', offer(NEGOTIATION, ''), 9);
    const room = MAX_SIGNALING_MESSAGE_BYTES - Buffer.byteLength(prefix);
    const sdp = '"'.repeat(Math.floor(room / 2));
    const text = clientMessage('RTC_OFFER', offer(NEGOTIATION, sdp), 9);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_SIGNALING_MESSAGE_BYTES);
    host.sendRaw(text);
    expectError(host.last(), 'INVALID_MESSAGE', true);
    expect(h.store.negotiationCount).toBe(0);
    expectType(guest.last(), 'ROOM_JOINED');
    expect(h.logger.events).toContainEqual({
      event: 'message_rejected',
      connection: host.connection.id,
      code: 'INVALID_MESSAGE',
      detail: 'relay_too_large',
    });
  });

  it('does not count stale negotiation refusals as protocol violations', () => {
    const { host, guest } = negotiated();
    guest.send('ROOM_LEAVE');
    for (let index = 0; index < MAX_PROTOCOL_VIOLATIONS * 3; index += 1) {
      host.send('ICE_CANDIDATE', ice());
      expectError(host.last(), 'INVALID_STATE', true);
    }
    expect(host.closes).toStrictEqual([]);
    expect(host.connection.state).toBe('IN_ROOM');
  });

  it('bounds a negotiation flood with the rate limit', () => {
    const h = harness({ rateLimit: DEFAULT_RATE_LIMIT });
    const { host, guest } = h.roomPair();
    host.send('RTC_OFFER', offer());
    for (let index = 0; index < 200; index += 1) host.send('ICE_CANDIDATE', ice());
    expectError(host.last(), 'RATE_LIMITED', false);
    expect(host.closes[0]?.code).toBe(CLOSE_CODES.POLICY_VIOLATION);
    const relayed = guest.received.filter((m) => m.type === 'ICE_CANDIDATE');
    expect(relayed.length).toBeLessThanOrEqual(MAX_ICE_CANDIDATES_PER_NEGOTIATION);
    expect(expectType(guest.last(), 'ROOM_CLOSED').payload.reason).toBe('HOST_DISCONNECTED');
  });

  it('never logs or echoes session descriptions, candidates, or negotiation IDs', () => {
    const h = harness();
    const { host, guest } = negotiated(h);
    host.send('ICE_CANDIDATE', ice());
    guest.send('ICE_CANDIDATE', ice());
    host.send('ICE_COMPLETE', { negotiationId: NEGOTIATION });
    guest.send('ICE_COMPLETE', { negotiationId: NEGOTIATION });
    // Rejected copies, both malformed and illegal.
    host.send('RTC_OFFER', { ...offer(), extra: 1 });
    host.send('RTC_OFFER', offer());
    guest.send(
      'ICE_CANDIDATE',
      ice(NEGOTIATION, { ...CANDIDATE, candidate: `${CANDIDATE.candidate}\n` }),
    );
    guest.sendRaw(`{"sdp":"${OFFER_SDP.replaceAll('\r\n', ' ')}"}`);
    guest.send('ROOM_LEAVE');

    const logged = JSON.stringify(h.logger.events);
    for (const marker of MARKERS) expect(logged).not.toContain(marker);
    const errors = [...host.raw, ...guest.raw].filter((text) => text.includes('"ERROR"'));
    expect(errors.length).toBeGreaterThan(0);
    for (const text of errors) for (const marker of MARKERS) expect(text).not.toContain(marker);

    expect(h.logger.events.filter((event) => event.event === 'negotiation_relayed')).toStrictEqual([
      { event: 'negotiation_relayed', connection: host.connection.id, step: 'offer' },
      { event: 'negotiation_relayed', connection: guest.connection.id, step: 'answer' },
      { event: 'negotiation_relayed', connection: host.connection.id, step: 'complete' },
      { event: 'negotiation_relayed', connection: guest.connection.id, step: 'complete' },
    ]);
  });
});
