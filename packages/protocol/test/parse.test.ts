import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CLIENT_MESSAGE_TYPES,
  ERROR_CODES,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_SIGNALING_MESSAGE_BYTES,
  NEGOTIATION_MESSAGE_TYPES,
  PROTOCOL_VERSION,
  SERVER_MESSAGE_TYPES,
  parseClientMessage,
  parseServerMessage,
  serializeMessage,
  type ClientMessage,
  type InviteSecret,
  type ParseResult,
  type RoomId,
  type ServerMessage,
} from '../src/index.js';
import {
  INVITE_SECRET,
  OTHER_PARTICIPANT_ID,
  PARTICIPANT_ID,
  ROOM_ID,
  VALID_CLIENT_PAYLOADS,
  VALID_SERVER_PAYLOADS,
  envelope,
} from './fixtures.js';

function expectRejected(
  result: ParseResult<unknown>,
  reason: string,
  code: 'INVALID_MESSAGE' | 'UNSUPPORTED_PROTOCOL' = 'INVALID_MESSAGE',
): void {
  // A failure carries only fixed tokens: nothing from the input is echoed back.
  expect(result).toStrictEqual({ ok: false, code, reason });
}

function without(value: object, field: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
}

const clientJoin = (payload: unknown, overrides: object = {}): string =>
  envelope('ROOM_JOIN', payload, overrides);

describe('protocol constants', () => {
  it('fixes protocolVersion 1 and a bounded message size', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(MAX_SIGNALING_MESSAGE_BYTES).toBe(32_768);
  });

  it('defines only the room and negotiation signaling message types', () => {
    expect([...CLIENT_MESSAGE_TYPES].sort()).toStrictEqual(
      Object.keys(VALID_CLIENT_PAYLOADS).sort(),
    );
    expect([...SERVER_MESSAGE_TYPES].sort()).toStrictEqual(
      Object.keys(VALID_SERVER_PAYLOADS).sort(),
    );
    const all: readonly string[] = [...CLIENT_MESSAGE_TYPES, ...SERVER_MESSAGE_TYPES];
    for (const outOfScope of [
      'OFFER',
      'ANSWER',
      'PLAY',
      'PAUSE',
      'SEEK',
      'SYNC',
      'MEDIA_INFO',
      'CHAT',
      'REACTION',
      'TRANSFER_CHUNK',
      'PEER_HELLO',
    ]) {
      expect(all).not.toContain(outOfScope);
    }
  });

  it('defines a small error vocabulary', () => {
    expect(ERROR_CODES).toStrictEqual([
      'INVALID_MESSAGE',
      'UNSUPPORTED_PROTOCOL',
      'INVALID_STATE',
      'ROOM_UNAVAILABLE',
      'ROOM_FULL',
      'RATE_LIMITED',
      'SERVER_ERROR',
      'SESSION_UNAVAILABLE',
    ]);
  });
});

describe('valid messages', () => {
  it.each(Object.entries(VALID_CLIENT_PAYLOADS))('parses client %s', (type, payload) => {
    const result = parseClientMessage(envelope(type, payload, { sequence: 7, sentAt: 42 }));
    expect(result).toStrictEqual({
      ok: true,
      message: { protocolVersion: 1, type, sequence: 7, sentAt: 42, payload },
    });
  });

  it.each(Object.entries(VALID_SERVER_PAYLOADS))('parses server %s', (type, payload) => {
    const result = parseServerMessage(envelope(type, payload));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.message.payload).toStrictEqual(payload);
  });

  it('produces strongly typed messages', () => {
    const result = parseClientMessage(clientJoin(VALID_CLIENT_PAYLOADS.ROOM_JOIN));
    expectTypeOf(result).toEqualTypeOf<ParseResult<ClientMessage>>();
    if (!result.ok) throw new Error('expected a valid message');
    const { message } = result;
    if (message.type !== 'ROOM_JOIN') throw new Error('expected ROOM_JOIN');
    expectTypeOf(message.payload.roomId).toEqualTypeOf<RoomId>();
    expectTypeOf(message.payload.inviteSecret).toEqualTypeOf<InviteSecret>();
    expect(message.payload).toStrictEqual({ roomId: ROOM_ID, inviteSecret: INVITE_SECRET });
    expectTypeOf(parseServerMessage('')).toEqualTypeOf<ParseResult<ServerMessage>>();
  });

  it('accepts zero and the largest safe integer for sequence and sentAt', () => {
    for (const value of [0, Number.MAX_SAFE_INTEGER]) {
      const text = envelope('ROOM_CREATE', {}, { sequence: value, sentAt: value });
      expect(parseClientMessage(text).ok).toBe(true);
    }
  });

  it('accepts envelope fields in any order', () => {
    const text = JSON.stringify({
      payload: {},
      sentAt: 1,
      sequence: 2,
      type: 'ROOM_LEAVE',
      protocolVersion: 1,
    });
    expect(parseClientMessage(text).ok).toBe(true);
  });
});

describe('protocol version', () => {
  it('rejects version 0 and future versions as unsupported', () => {
    for (const version of [0, 2, 3, 1000, Number.MAX_SAFE_INTEGER]) {
      const text = envelope('ROOM_CREATE', {}, { protocolVersion: version });
      expectRejected(parseClientMessage(text), 'unsupported_version', 'UNSUPPORTED_PROTOCOL');
      expectRejected(parseServerMessage(text), 'unsupported_version', 'UNSUPPORTED_PROTOCOL');
    }
  });

  it('reports an unsupported version even when the rest of the envelope differs', () => {
    const text = JSON.stringify({ protocolVersion: 2, kind: 'something-new' });
    expectRejected(parseClientMessage(text), 'unsupported_version', 'UNSUPPORTED_PROTOCOL');
  });

  it('rejects non-integer or non-numeric versions as malformed', () => {
    for (const version of ['1', 1.5, -1, null, true, [1], { v: 1 }]) {
      const text = envelope('ROOM_CREATE', {}, { protocolVersion: version });
      expectRejected(parseClientMessage(text), 'invalid_version');
    }
  });

  it('rejects a missing version', () => {
    const text = JSON.stringify({ type: 'ROOM_CREATE', sequence: 0, sentAt: 0, payload: {} });
    expectRejected(parseClientMessage(text), 'missing_field');
  });
});

describe('envelope shape', () => {
  it('rejects non-object JSON roots', () => {
    for (const text of ['null', '[]', '[{"protocolVersion":1}]', '1', '"text"', 'true', '0']) {
      expectRejected(parseClientMessage(text), 'not_object');
      expectRejected(parseServerMessage(text), 'not_object');
    }
  });

  it.each(['type', 'sequence', 'sentAt', 'payload'])('rejects a missing %s', (field) => {
    const value = JSON.parse(envelope('ROOM_CREATE', {})) as Record<string, unknown>;
    expectRejected(parseClientMessage(JSON.stringify(without(value, field))), 'missing_field');
  });

  it('rejects additional envelope fields', () => {
    for (const extra of [
      { extra: 1 },
      { roomId: ROOM_ID },
      { participantId: PARTICIPANT_ID },
      { signature: 'x' },
    ]) {
      expectRejected(parseClientMessage(envelope('ROOM_CREATE', {}, extra)), 'unknown_field');
    }
  });

  it('rejects wrong field types', () => {
    expectRejected(parseClientMessage(envelope('ROOM_CREATE', {}, { type: 7 })), 'unknown_type');
    expectRejected(
      parseClientMessage(envelope('ROOM_CREATE', {}, { sequence: '1' })),
      'invalid_sequence',
    );
    expectRejected(
      parseClientMessage(envelope('ROOM_CREATE', {}, { sentAt: '1' })),
      'invalid_sent_at',
    );
    expectRejected(parseClientMessage(envelope('ROOM_CREATE', 'x')), 'invalid_payload');
    expectRejected(parseClientMessage(envelope('ROOM_CREATE', null)), 'invalid_payload');
    expectRejected(parseClientMessage(envelope('ROOM_CREATE', [])), 'invalid_payload');
  });
});

describe('sequence and sentAt', () => {
  // JSON cannot spell NaN or Infinity, but 1e400 parses to Infinity.
  const invalidNumbers = ['-1', '1.5', '-0.5', '1e400', '-1e400', '9007199254740992', '1e20'];
  const invalidValues: unknown[] = [null, true, '0', [0], { value: 0 }];

  it('rejects invalid sequence values', () => {
    for (const raw of invalidNumbers) {
      const text = `{"protocolVersion":1,"type":"ROOM_CREATE","sequence":${raw},"sentAt":0,"payload":{}}`;
      expectRejected(parseClientMessage(text), 'invalid_sequence');
    }
    for (const sequence of invalidValues) {
      expectRejected(
        parseClientMessage(envelope('ROOM_CREATE', {}, { sequence })),
        'invalid_sequence',
      );
    }
  });

  it('rejects invalid sentAt values', () => {
    for (const raw of invalidNumbers) {
      const text = `{"protocolVersion":1,"type":"ROOM_CREATE","sequence":0,"sentAt":${raw},"payload":{}}`;
      expectRejected(parseClientMessage(text), 'invalid_sent_at');
    }
    for (const sentAt of invalidValues) {
      expectRejected(
        parseClientMessage(envelope('ROOM_CREATE', {}, { sentAt })),
        'invalid_sent_at',
      );
    }
  });
});

describe('message type', () => {
  it('rejects unknown and out-of-scope types', () => {
    for (const type of [
      'room_create',
      'ROOM_DELETE',
      'OFFER',
      'ANSWER',
      'rtc_offer',
      'PEER_HELLO',
      'PLAY',
      'CHAT',
      'TRANSFER_CHUNK',
      '',
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
    ]) {
      expectRejected(parseClientMessage(envelope(type, {})), 'unknown_type');
      expectRejected(parseServerMessage(envelope(type, {})), 'unknown_type');
    }
  });

  it('keeps the room messages of each direction apart', () => {
    const negotiation: readonly string[] = NEGOTIATION_MESSAGE_TYPES;
    for (const type of SERVER_MESSAGE_TYPES.filter((type) => !negotiation.includes(type))) {
      expectRejected(parseClientMessage(envelope(type, {})), 'unknown_type');
    }
    for (const type of CLIENT_MESSAGE_TYPES.filter((type) => !negotiation.includes(type))) {
      expectRejected(parseServerMessage(envelope(type, {})), 'unknown_type');
    }
  });
});

describe('client payloads', () => {
  it.each(['ROOM_CREATE', 'ROOM_LEAVE'])('%s accepts only an empty object', (type) => {
    for (const payload of [
      { roomId: ROOM_ID },
      { participantId: PARTICIPANT_ID },
      { role: 'host' },
      { extra: null },
    ]) {
      expectRejected(parseClientMessage(envelope(type, payload)), 'invalid_payload');
    }
  });

  it('ROOM_JOIN rejects missing fields', () => {
    expectRejected(parseClientMessage(clientJoin({ roomId: ROOM_ID })), 'invalid_payload');
    expectRejected(
      parseClientMessage(clientJoin({ inviteSecret: INVITE_SECRET })),
      'invalid_payload',
    );
    expectRejected(parseClientMessage(clientJoin({})), 'invalid_payload');
  });

  it('ROOM_JOIN rejects extra fields, including identity claims', () => {
    for (const extra of [
      { participantId: PARTICIPANT_ID },
      { role: 'host' },
      { extra: true },
      { expiresAt: 1 },
    ]) {
      expectRejected(
        parseClientMessage(clientJoin({ ...VALID_CLIENT_PAYLOADS.ROOM_JOIN, ...extra })),
        'invalid_payload',
      );
    }
  });

  it('ROOM_JOIN rejects wrong types, malformed values, and overlong values', () => {
    const cases: unknown[] = [
      { roomId: 1, inviteSecret: INVITE_SECRET },
      { roomId: ROOM_ID, inviteSecret: null },
      { roomId: [ROOM_ID], inviteSecret: INVITE_SECRET },
      { roomId: INVITE_SECRET, inviteSecret: ROOM_ID },
      { roomId: `${ROOM_ID}A`, inviteSecret: INVITE_SECRET },
      { roomId: ROOM_ID, inviteSecret: `${INVITE_SECRET}A` },
      { roomId: ROOM_ID, inviteSecret: INVITE_SECRET.slice(1) },
      { roomId: ROOM_ID, inviteSecret: `${INVITE_SECRET.slice(0, -1)}=` },
      { roomId: ROOM_ID, inviteSecret: INVITE_SECRET.replace(/.$/, '+') },
      { roomId: ROOM_ID, inviteSecret: 'x'.repeat(3000) },
      { roomId: 'r'.repeat(3000), inviteSecret: INVITE_SECRET },
    ];
    for (const payload of cases) {
      expectRejected(parseClientMessage(clientJoin(payload)), 'invalid_payload');
    }
  });
});

describe('server payloads', () => {
  const server = (type: keyof typeof VALID_SERVER_PAYLOADS, payload: unknown) =>
    parseServerMessage(envelope(type, payload));

  it.each(Object.entries(VALID_SERVER_PAYLOADS))(
    '%s rejects an extra field and each missing field',
    (type, payload) => {
      const key = type as keyof typeof VALID_SERVER_PAYLOADS;
      expectRejected(server(key, { ...payload, extra: 1 }), 'invalid_payload');
      for (const field of Object.keys(payload)) {
        expectRejected(server(key, without(payload, field)), 'invalid_payload');
      }
    },
  );

  it('rejects wrong roles and malformed identifiers', () => {
    const created = VALID_SERVER_PAYLOADS.ROOM_CREATED;
    const joined = VALID_SERVER_PAYLOADS.ROOM_JOINED;
    expectRejected(server('ROOM_CREATED', { ...created, role: 'guest' }), 'invalid_payload');
    expectRejected(server('ROOM_CREATED', { ...created, roomId: 'short' }), 'invalid_payload');
    expectRejected(
      server('ROOM_CREATED', { ...created, inviteSecret: ROOM_ID }),
      'invalid_payload',
    );
    expectRejected(server('ROOM_CREATED', { ...created, expiresAt: -1 }), 'invalid_payload');
    expectRejected(server('ROOM_JOINED', { ...joined, role: 'host' }), 'invalid_payload');
    expectRejected(
      server('ROOM_JOINED', { ...joined, peer: { participantId: PARTICIPANT_ID, role: 'guest' } }),
      'invalid_payload',
    );
    expectRejected(
      server('ROOM_JOINED', {
        ...joined,
        peer: { participantId: PARTICIPANT_ID, role: 'host', x: 1 },
      }),
      'invalid_payload',
    );
    expectRejected(
      server('ROOM_PARTICIPANT_JOINED', {
        participant: { participantId: OTHER_PARTICIPANT_ID, role: 'host' },
      }),
      'invalid_payload',
    );
    expectRejected(
      server('ROOM_PARTICIPANT_LEFT', { participantId: ROOM_ID, reason: 'LEFT' }),
      'invalid_payload',
    );
  });

  it('rejects unknown reasons', () => {
    expectRejected(
      server('ROOM_PARTICIPANT_LEFT', { participantId: OTHER_PARTICIPANT_ID, reason: 'KICKED' }),
      'invalid_payload',
    );
    expectRejected(server('ROOM_CLOSED', { reason: 'expired' }), 'invalid_payload');
    for (const reason of ['EXPIRED', 'HOST_LEFT', 'HOST_DISCONNECTED']) {
      expect(server('ROOM_CLOSED', { reason }).ok).toBe(true);
    }
  });

  it('bounds ERROR payloads', () => {
    const error = VALID_SERVER_PAYLOADS.ERROR;
    expectRejected(server('ERROR', { ...error, code: 'NOPE' }), 'invalid_payload');
    expectRejected(server('ERROR', { ...error, message: '' }), 'invalid_payload');
    expectRejected(
      server('ERROR', { ...error, message: 'm'.repeat(MAX_ERROR_MESSAGE_LENGTH + 1) }),
      'invalid_payload',
    );
    expectRejected(server('ERROR', { ...error, recoverable: 'yes' }), 'invalid_payload');
    expect(server('ERROR', { ...error, message: 'm'.repeat(MAX_ERROR_MESSAGE_LENGTH) }).ok).toBe(
      true,
    );
    for (const code of ERROR_CODES) expect(server('ERROR', { ...error, code }).ok).toBe(true);
  });
});

describe('untrusted JSON', () => {
  it('rejects malformed JSON without exposing parser details', () => {
    for (const text of [
      '',
      ' ',
      '{',
      '{"protocolVersion":1,',
      "{'protocolVersion':1}",
      '{"protocolVersion":1}}',
      'undefined',
      'NaN',
      '\u0000',
      '{"a":1,}',
    ]) {
      expect(() => parseClientMessage(text)).not.toThrow();
      expectRejected(parseClientMessage(text), 'invalid_json');
    }
  });

  it('rejects oversized input before parsing it', () => {
    const padding = ' '.repeat(MAX_SIGNALING_MESSAGE_BYTES);
    expectRejected(parseClientMessage(`${envelope('ROOM_CREATE', {})}${padding}`), 'too_large');
    expectRejected(parseServerMessage('x'.repeat(MAX_SIGNALING_MESSAGE_BYTES + 1)), 'too_large');
  });

  it('tolerates deeply nested input', () => {
    const depth = 1500;
    const text = `${'['.repeat(depth)}${']'.repeat(depth)}`;
    expectRejected(parseClientMessage(text), 'not_object');
    const nested = `{"protocolVersion":1,"type":"ROOM_CREATE","sequence":0,"sentAt":0,"payload":${'{"a":'.repeat(600)}1${'}'.repeat(600)}}`;
    expectRejected(parseClientMessage(nested), 'invalid_payload');
  });

  it('rejects prototype-pollution keys and never pollutes Object.prototype', () => {
    const texts = [
      '{"protocolVersion":1,"type":"ROOM_CREATE","sequence":0,"sentAt":0,"payload":{},"__proto__":{"polluted":true}}',
      '{"protocolVersion":1,"type":"ROOM_CREATE","sequence":0,"sentAt":0,"payload":{"__proto__":{"polluted":true}}}',
      '{"protocolVersion":1,"type":"ROOM_CREATE","sequence":0,"sentAt":0,"payload":{"constructor":{"prototype":{"polluted":true}}}}',
      `{"protocolVersion":1,"type":"ROOM_JOIN","sequence":0,"sentAt":0,"payload":{"roomId":"${ROOM_ID}","inviteSecret":"${INVITE_SECRET}","__proto__":{"polluted":true}}}`,
    ];
    const expected = ['unknown_field', 'invalid_payload', 'invalid_payload', 'invalid_payload'];
    texts.forEach((text, index) => {
      expectRejected(parseClientMessage(text), expected[index] ?? '');
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('returns plain payload objects with only the validated fields', () => {
    const result = parseServerMessage(envelope('ROOM_JOINED', VALID_SERVER_PAYLOADS.ROOM_JOINED));
    if (!result.ok || result.message.type !== 'ROOM_JOINED')
      throw new Error('expected ROOM_JOINED');
    expect(Object.getPrototypeOf(result.message.payload)).toBe(Object.prototype);
    expect(Object.keys(result.message.payload.peer)).toStrictEqual(['participantId', 'role']);
  });
});

describe('serializeMessage', () => {
  it('round-trips every message through the matching parser', () => {
    for (const [type, payload] of Object.entries(VALID_CLIENT_PAYLOADS)) {
      const parsed = parseClientMessage(envelope(type, payload));
      if (!parsed.ok) throw new Error(type);
      expect(parseClientMessage(serializeMessage(parsed.message))).toStrictEqual(parsed);
    }
    for (const [type, payload] of Object.entries(VALID_SERVER_PAYLOADS)) {
      const parsed = parseServerMessage(envelope(type, payload));
      if (!parsed.ok) throw new Error(type);
      expect(parseServerMessage(serializeMessage(parsed.message))).toStrictEqual(parsed);
    }
  });

  it('writes only the envelope fields', () => {
    const message = {
      protocolVersion: 1,
      type: 'ROOM_LEAVE',
      sequence: 3,
      sentAt: 4,
      payload: {},
      internal: 'must not be written',
    } as ClientMessage;
    expect(serializeMessage(message)).toBe(
      '{"protocolVersion":1,"type":"ROOM_LEAVE","sequence":3,"sentAt":4,"payload":{}}',
    );
  });
});
