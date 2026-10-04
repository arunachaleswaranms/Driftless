import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  MAX_ICE_CANDIDATE_BYTES,
  MAX_ICE_CANDIDATES_PER_NEGOTIATION,
  MAX_PEER_MESSAGE_BYTES,
  MAX_SDP_BYTES,
  MAX_SDP_MID_BYTES,
  MAX_SDP_MLINE_INDEX,
  MAX_SIGNALING_MESSAGE_BYTES,
  MAX_USERNAME_FRAGMENT_BYTES,
  NEGOTIATION_MESSAGE_TYPES,
  PEER_CONTROL_CHANNEL_LABEL,
  PEER_MESSAGE_TYPES,
  isSessionDescription,
  parseClientMessage,
  parsePeerMessage,
  parseServerMessage,
  serializeMessage,
  toIceCandidate,
  type IceCandidate,
  type NegotiationId,
  type ParseResult,
} from '../src/index.js';
import {
  CANDIDATE,
  INVITE_SECRET,
  NEGOTIATION_ID,
  OTHER_PARTICIPANT_ID,
  PARTICIPANT_ID,
  ROOM_ID,
  SDP,
  VALID_NEGOTIATION_PAYLOADS,
  VALID_PEER_PAYLOADS,
  envelope,
} from './fixtures.js';

const encoder = new TextEncoder();

function expectInvalidPayload(result: ParseResult<unknown>): void {
  expect(result).toStrictEqual({ ok: false, code: 'INVALID_MESSAGE', reason: 'invalid_payload' });
}

const bothDirections = [
  ['client', parseClientMessage],
  ['server', parseServerMessage],
] as const;

describe('negotiation bounds', () => {
  it('are explicit, provisional values that fit inside the message bound', () => {
    expect({
      MAX_SIGNALING_MESSAGE_BYTES,
      MAX_SDP_BYTES,
      MAX_ICE_CANDIDATE_BYTES,
      MAX_SDP_MID_BYTES,
      MAX_SDP_MLINE_INDEX,
      MAX_USERNAME_FRAGMENT_BYTES,
      MAX_ICE_CANDIDATES_PER_NEGOTIATION,
      MAX_PEER_MESSAGE_BYTES,
    }).toStrictEqual({
      MAX_SIGNALING_MESSAGE_BYTES: 32_768,
      MAX_SDP_BYTES: 16_384,
      MAX_ICE_CANDIDATE_BYTES: 1024,
      MAX_SDP_MID_BYTES: 64,
      MAX_SDP_MLINE_INDEX: 63,
      MAX_USERNAME_FRAGMENT_BYTES: 256,
      MAX_ICE_CANDIDATES_PER_NEGOTIATION: 32,
      MAX_PEER_MESSAGE_BYTES: 1024,
    });
    expect(MAX_SIGNALING_MESSAGE_BYTES).toBeLessThanOrEqual(64 * 1024);
    expect(PEER_CONTROL_CHANNEL_LABEL).toBe('driftless-control');
  });

  it('fit a maximal SDP made of ordinary lines into one message', () => {
    // Real descriptions are CRLF-separated ASCII lines; CRLF escapes to four bytes.
    const line = `a=x-filler:${'0'.repeat(60)}\r\n`;
    let sdp = line.repeat(Math.floor(MAX_SDP_BYTES / line.length));
    sdp += 'a'.repeat(MAX_SDP_BYTES - sdp.length);
    expect(encoder.encode(sdp).byteLength).toBe(MAX_SDP_BYTES);
    const text = envelope(
      'RTC_OFFER',
      { negotiationId: NEGOTIATION_ID, sdp },
      {
        sequence: Number.MAX_SAFE_INTEGER,
        sentAt: Number.MAX_SAFE_INTEGER,
      },
    );
    expect(encoder.encode(text).byteLength).toBeLessThanOrEqual(MAX_SIGNALING_MESSAGE_BYTES);
    expect(parseClientMessage(text).ok).toBe(true);
    expect(parseServerMessage(text).ok).toBe(true);
  });
});

describe.each(bothDirections)('negotiation messages (%s direction)', (_name, parse) => {
  it.each(Object.entries(VALID_NEGOTIATION_PAYLOADS))('parses %s', (type, payload) => {
    const result = parse(envelope(type, payload, { sequence: 3, sentAt: 9 }));
    expect(result).toStrictEqual({
      ok: true,
      message: { protocolVersion: 1, type, sequence: 3, sentAt: 9, payload },
    });
  });

  it.each(Object.entries(VALID_NEGOTIATION_PAYLOADS))(
    '%s rejects extra fields, missing fields, and destination or role claims',
    (type, payload) => {
      for (const extra of [
        { extra: 1 },
        { roomId: ROOM_ID },
        { participantId: PARTICIPANT_ID },
        { targetParticipantId: OTHER_PARTICIPANT_ID },
        { role: 'host' },
        { inviteSecret: INVITE_SECRET },
        { type: 'offer' },
      ]) {
        expectInvalidPayload(parse(envelope(type, { ...payload, ...extra })));
      }
      for (const field of Object.keys(payload)) {
        const rest = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== field));
        expectInvalidPayload(parse(envelope(type, rest)));
      }
    },
  );

  it.each(NEGOTIATION_MESSAGE_TYPES)('%s rejects malformed negotiation IDs', (type) => {
    const payload = VALID_NEGOTIATION_PAYLOADS[type];
    for (const negotiationId of [
      null,
      7,
      '',
      ROOM_ID,
      PARTICIPANT_ID,
      INVITE_SECRET,
      NEGOTIATION_ID.slice(1),
      `${NEGOTIATION_ID}A`,
      `${NEGOTIATION_ID.slice(1)}=`,
      `${NEGOTIATION_ID.slice(1)}+`,
      [NEGOTIATION_ID],
      { negotiationId: NEGOTIATION_ID },
    ]) {
      expectInvalidPayload(parse(envelope(type, { ...payload, negotiationId })));
    }
  });

  it.each(['RTC_OFFER', 'RTC_ANSWER'] as const)('%s bounds and types the SDP', (type) => {
    const sdp = (value: unknown) =>
      parse(envelope(type, { negotiationId: NEGOTIATION_ID, sdp: value }));
    for (const value of ['', null, 1, true, [SDP], { sdp: SDP }]) expectInvalidPayload(sdp(value));
    expect(sdp('x'.repeat(MAX_SDP_BYTES)).ok).toBe(true);
    expectInvalidPayload(sdp('x'.repeat(MAX_SDP_BYTES + 1)));
  });

  it.each(['RTC_OFFER', 'RTC_ANSWER'] as const)(
    '%s counts multi-byte SDP content in bytes',
    (type) => {
      const sdp = (value: string) =>
        parse(envelope(type, { negotiationId: NEGOTIATION_ID, sdp: value }));
      // Two-byte and four-byte characters exactly at the bound, and just over
      // it with far fewer code units than MAX_SDP_BYTES.
      expect(sdp('é'.repeat(MAX_SDP_BYTES / 2)).ok).toBe(true);
      expectInvalidPayload(sdp('é'.repeat(MAX_SDP_BYTES / 2 + 1)));
      expect(sdp('😀'.repeat(MAX_SDP_BYTES / 4)).ok).toBe(true);
      expectInvalidPayload(sdp(`${'😀'.repeat(MAX_SDP_BYTES / 4)}x`));
      expectInvalidPayload(sdp(`${'x'.repeat(MAX_SDP_BYTES - 2)}€`));
    },
  );

  it('carries ICE_CANDIDATE only as the exact validated candidate object', () => {
    const ice = (candidate: unknown) =>
      parse(envelope('ICE_CANDIDATE', { negotiationId: NEGOTIATION_ID, candidate }));
    expect(ice(CANDIDATE).ok).toBe(true);
    expectInvalidPayload(ice(CANDIDATE.candidate));
    expectInvalidPayload(ice(null));
    expectInvalidPayload(ice([CANDIDATE]));
    expectInvalidPayload(ice({ ...CANDIDATE, address: '192.0.2.10' }));
  });

  it('ICE_COMPLETE accepts only the negotiation ID', () => {
    expect(parse(envelope('ICE_COMPLETE', { negotiationId: NEGOTIATION_ID })).ok).toBe(true);
    expectInvalidPayload(parse(envelope('ICE_COMPLETE', {})));
    expectInvalidPayload(
      parse(envelope('ICE_COMPLETE', { negotiationId: NEGOTIATION_ID, candidate: null })),
    );
  });
});

describe('negotiation message typing', () => {
  it('produces typed payloads built from validated values', () => {
    const result = parseServerMessage(
      envelope('ICE_CANDIDATE', VALID_NEGOTIATION_PAYLOADS.ICE_CANDIDATE),
    );
    if (!result.ok || result.message.type !== 'ICE_CANDIDATE') throw new Error('expected ICE');
    expectTypeOf(result.message.payload.negotiationId).toEqualTypeOf<NegotiationId>();
    expectTypeOf(result.message.payload.candidate).toEqualTypeOf<IceCandidate>();
    expect(Object.keys(result.message.payload.candidate)).toStrictEqual([
      'candidate',
      'sdpMid',
      'sdpMLineIndex',
      'usernameFragment',
    ]);
  });

  it('round-trips through serializeMessage', () => {
    for (const [type, payload] of Object.entries(VALID_NEGOTIATION_PAYLOADS)) {
      const parsed = parseClientMessage(envelope(type, payload));
      if (!parsed.ok) throw new Error(type);
      expect(parseServerMessage(serializeMessage(parsed.message))).toStrictEqual(parsed);
    }
  });
});

describe('toIceCandidate', () => {
  it('accepts browser-shaped candidates, including null mid, index, or fragment', () => {
    expect(toIceCandidate(CANDIDATE)).toStrictEqual(CANDIDATE);
    for (const variant of [
      { ...CANDIDATE, sdpMid: null },
      { ...CANDIDATE, sdpMLineIndex: null },
      { ...CANDIDATE, usernameFragment: null },
      { ...CANDIDATE, sdpMLineIndex: MAX_SDP_MLINE_INDEX },
      { ...CANDIDATE, candidate: 'c'.repeat(MAX_ICE_CANDIDATE_BYTES) },
      { ...CANDIDATE, sdpMid: 'm'.repeat(MAX_SDP_MID_BYTES) },
      { ...CANDIDATE, usernameFragment: 'u'.repeat(MAX_USERNAME_FRAGMENT_BYTES) },
    ]) {
      expect(toIceCandidate(variant)).toStrictEqual(variant);
    }
  });

  it('returns a fresh plain object with only the four fields', () => {
    const input = { ...CANDIDATE };
    const output = toIceCandidate(input);
    expect(output).not.toBe(input);
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
  });

  it('rejects over-bound, empty, non-ASCII, and wrongly typed fields', () => {
    for (const variant of [
      { ...CANDIDATE, candidate: '' },
      { ...CANDIDATE, candidate: 'c'.repeat(MAX_ICE_CANDIDATE_BYTES + 1) },
      { ...CANDIDATE, candidate: `${'c'.repeat(MAX_ICE_CANDIDATE_BYTES - 1)}é` },
      { ...CANDIDATE, candidate: 'candidate:1 1 udp 1 host.local 1 typ host\n' },
      { ...CANDIDATE, candidate: 'candidate:\u0000' },
      { ...CANDIDATE, candidate: null },
      { ...CANDIDATE, candidate: 1 },
      { ...CANDIDATE, sdpMid: '' },
      { ...CANDIDATE, sdpMid: 'm'.repeat(MAX_SDP_MID_BYTES + 1) },
      { ...CANDIDATE, sdpMid: 0 },
      { ...CANDIDATE, sdpMLineIndex: -1 },
      { ...CANDIDATE, sdpMLineIndex: 1.5 },
      { ...CANDIDATE, sdpMLineIndex: MAX_SDP_MLINE_INDEX + 1 },
      { ...CANDIDATE, sdpMLineIndex: '0' },
      { ...CANDIDATE, usernameFragment: '' },
      { ...CANDIDATE, usernameFragment: 'u'.repeat(MAX_USERNAME_FRAGMENT_BYTES + 1) },
      { ...CANDIDATE, usernameFragment: 'ü' },
      { ...CANDIDATE, sdpMid: null, sdpMLineIndex: null },
    ]) {
      expect(toIceCandidate(variant)).toBeUndefined();
    }
  });

  it('requires exactly the four fields and a plain object', () => {
    const withoutFragment = Object.fromEntries(
      Object.entries(CANDIDATE).filter(([key]) => key !== 'usernameFragment'),
    );
    for (const value of [
      withoutFragment,
      { ...CANDIDATE, extra: 1 },
      { ...CANDIDATE, toJSON: null },
      JSON.parse(`{"__proto__":{},"candidate":"c","sdpMid":"0","sdpMLineIndex":0}`) as unknown,
      Object.assign(Object.create({ inherited: true }) as object, CANDIDATE),
      null,
      undefined,
      'candidate:1',
      [CANDIDATE],
    ]) {
      expect(toIceCandidate(value)).toBeUndefined();
    }
  });
});

describe('isSessionDescription', () => {
  it('accepts non-empty text within the byte bound only', () => {
    expect(isSessionDescription(SDP)).toBe(true);
    expect(isSessionDescription('x'.repeat(MAX_SDP_BYTES))).toBe(true);
    for (const value of ['', 'x'.repeat(MAX_SDP_BYTES + 1), null, undefined, 1, {}, [SDP]]) {
      expect(isSessionDescription(value)).toBe(false);
    }
  });
});

describe('peer messages', () => {
  it('define the handshake and Local Sync setup', () => {
    expect([...PEER_MESSAGE_TYPES]).toStrictEqual([
      'PEER_HELLO',
      'PEER_READY',
      'MEDIA_INFO',
      'MEDIA_MATCH',
      'MEDIA_MISMATCH',
      'READY',
      'NOT_READY',
    ]);
  });

  it.each(Object.entries(VALID_PEER_PAYLOADS))('parses %s', (type, payload) => {
    const result = parsePeerMessage(envelope(type, payload, { sequence: 0, sentAt: 5 }));
    expect(result).toStrictEqual({
      ok: true,
      message: { protocolVersion: 1, type, sequence: 0, sentAt: 5, payload },
    });
    if (result.ok) expect(parsePeerMessage(serializeMessage(result.message))).toStrictEqual(result);
  });

  it.each(Object.entries(VALID_PEER_PAYLOADS))(
    '%s rejects extra, missing, malformed, or self-addressed identities',
    (type, payload) => {
      const peer = (value: unknown) => parsePeerMessage(envelope(type, value));
      for (const extra of [{ inviteSecret: INVITE_SECRET }, { roomId: ROOM_ID }, { text: 'hi' }]) {
        expectInvalidPayload(peer({ ...payload, ...extra }));
      }
      for (const field of Object.keys(payload)) {
        const rest = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== field));
        expectInvalidPayload(peer(rest));
      }
      expectInvalidPayload(peer({ ...payload, negotiationId: ROOM_ID }));
      expectInvalidPayload(peer({ ...payload, senderId: NEGOTIATION_ID }));
      expectInvalidPayload(peer({ ...payload, recipientId: 'x' }));
      expectInvalidPayload(peer({ ...payload, recipientId: payload.senderId }));
    },
  );

  it('keeps peer, client, and server message sets apart', () => {
    for (const type of ['PEER_HELLO', 'PEER_READY'] as const) {
      const text = envelope(type, VALID_PEER_PAYLOADS[type]);
      expect(parseClientMessage(text)).toMatchObject({ ok: false, reason: 'unknown_type' });
      expect(parseServerMessage(text)).toMatchObject({ ok: false, reason: 'unknown_type' });
    }
    for (const [type, payload] of Object.entries(VALID_NEGOTIATION_PAYLOADS)) {
      expect(parsePeerMessage(envelope(type, payload))).toMatchObject({
        ok: false,
        reason: 'unknown_type',
      });
    }
    for (const type of ['ROOM_JOIN', 'CHAT', 'PLAY', 'SYNC', 'TRANSFER_CHUNK']) {
      expect(parsePeerMessage(envelope(type, {}))).toMatchObject({
        ok: false,
        reason: 'unknown_type',
      });
    }
  });

  it('applies the common envelope rules', () => {
    const hello = VALID_PEER_PAYLOADS.PEER_HELLO;
    expect(parsePeerMessage(envelope('PEER_HELLO', hello, { protocolVersion: 2 }))).toStrictEqual({
      ok: false,
      code: 'UNSUPPORTED_PROTOCOL',
      reason: 'unsupported_version',
    });
    expect(parsePeerMessage(envelope('PEER_HELLO', hello, { extra: 1 }))).toMatchObject({
      ok: false,
      reason: 'unknown_field',
    });
    expect(parsePeerMessage(envelope('PEER_HELLO', hello, { sequence: -1 }))).toMatchObject({
      ok: false,
      reason: 'invalid_sequence',
    });
    expect(parsePeerMessage('{')).toMatchObject({ ok: false, reason: 'invalid_json' });
    expect(parsePeerMessage(' '.repeat(MAX_PEER_MESSAGE_BYTES + 1))).toMatchObject({
      ok: false,
      reason: 'too_large',
    });
  });
});

describe('secret-like negotiation content', () => {
  it('never echoes rejected SDP or candidate text in parse failures', () => {
    const marker = 'a=fingerprint:sha-256 SECRET-MARKER 198.51.100.77 ice-pwd:marker';
    const results = [
      parseClientMessage(envelope('RTC_OFFER', { negotiationId: 'bad', sdp: marker })),
      parseClientMessage(
        envelope('ICE_CANDIDATE', {
          negotiationId: NEGOTIATION_ID,
          candidate: { ...CANDIDATE, candidate: `${marker}\n` },
        }),
      ),
      parseServerMessage(
        envelope('RTC_ANSWER', { negotiationId: NEGOTIATION_ID, sdp: marker, x: 1 }),
      ),
    ];
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain('SECRET-MARKER');
      expect(JSON.stringify(result)).not.toContain('198.51.100.77');
    }
  });
});
