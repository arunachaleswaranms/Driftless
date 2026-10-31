import { describe, expect, it } from 'vitest';
import {
  CLIENT_MESSAGE_TYPES,
  MAX_NEGOTIATIONS_WITHOUT_ESTABLISHMENT,
  MAX_SIGNALING_MESSAGE_BYTES,
  NEGOTIATION_ID_LENGTH,
  NEGOTIATION_MESSAGE_TYPES,
  PROTOCOL_VERSION,
  SERVER_MESSAGE_TYPES,
  parseClientMessage,
  parsePeerMessage,
  parseServerMessage,
  serializeMessage,
  type NegotiationId,
  type ParseResult,
} from '../src/index.js';
import { NEGOTIATION_ID, OTHER_NEGOTIATION_ID, envelope } from './fixtures.js';

// Phase 3 recovery hardening: establishment reports reset the bounded run of
// negotiations without establishment. They are signaling control metadata:
// one negotiation ID, nothing else.

function expectInvalidPayload(result: ParseResult<unknown>): void {
  expect(result).toStrictEqual({ ok: false, code: 'INVALID_MESSAGE', reason: 'invalid_payload' });
}

const encoder = new TextEncoder();

describe('RTC_ESTABLISHED and RTC_ESTABLISHED_ACK', () => {
  it('keep protocol version 1 and the four-negotiation consecutive bound', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(MAX_NEGOTIATIONS_WITHOUT_ESTABLISHMENT).toBe(4);
  });

  it('travel in one direction each and are not relayed negotiation messages', () => {
    expect(CLIENT_MESSAGE_TYPES).toContain('RTC_ESTABLISHED');
    expect(SERVER_MESSAGE_TYPES).not.toContain('RTC_ESTABLISHED');
    expect(SERVER_MESSAGE_TYPES).toContain('RTC_ESTABLISHED_ACK');
    expect(CLIENT_MESSAGE_TYPES).not.toContain('RTC_ESTABLISHED_ACK');
    const relayed: readonly string[] = NEGOTIATION_MESSAGE_TYPES;
    expect(relayed).not.toContain('RTC_ESTABLISHED');
    expect(relayed).not.toContain('RTC_ESTABLISHED_ACK');
  });

  it('accept exactly one negotiation ID and rebuild the payload', () => {
    const report = parseClientMessage(
      envelope('RTC_ESTABLISHED', { negotiationId: NEGOTIATION_ID }),
    );
    expect(report).toStrictEqual({
      ok: true,
      message: {
        protocolVersion: 1,
        type: 'RTC_ESTABLISHED',
        sequence: 0,
        sentAt: 1_760_000_000_000,
        payload: { negotiationId: NEGOTIATION_ID },
      },
    });
    const ack = parseServerMessage(
      envelope('RTC_ESTABLISHED_ACK', { negotiationId: OTHER_NEGOTIATION_ID }),
    );
    expect(ack.ok && ack.message.payload).toStrictEqual({ negotiationId: OTHER_NEGOTIATION_ID });
  });

  it('reject the wrong direction', () => {
    expect(
      parseServerMessage(envelope('RTC_ESTABLISHED', { negotiationId: NEGOTIATION_ID })),
    ).toMatchObject({ ok: false, reason: 'unknown_type' });
    expect(
      parseClientMessage(envelope('RTC_ESTABLISHED_ACK', { negotiationId: NEGOTIATION_ID })),
    ).toMatchObject({ ok: false, reason: 'unknown_type' });
    // Never peer traffic either.
    for (const type of ['RTC_ESTABLISHED', 'RTC_ESTABLISHED_ACK']) {
      expect(parsePeerMessage(envelope(type, { negotiationId: NEGOTIATION_ID }))).toMatchObject({
        ok: false,
        reason: 'unknown_type',
      });
    }
  });

  it.each([
    ['client', 'RTC_ESTABLISHED', parseClientMessage],
    ['server', 'RTC_ESTABLISHED_ACK', parseServerMessage],
  ] as const)('%s %s rejects malformed payloads', (_, type, parse) => {
    const bad: unknown[] = [
      {},
      null,
      [],
      'x',
      { negotiationId: null },
      { negotiationId: 7 },
      { negotiationId: '' },
      { negotiationId: NEGOTIATION_ID.slice(1) },
      { negotiationId: `${NEGOTIATION_ID}A` },
      { negotiationId: `${NEGOTIATION_ID.slice(0, -1)}+` },
      { negotiationId: NEGOTIATION_ID, extra: true },
      { negotiationId: NEGOTIATION_ID, previousNegotiationId: OTHER_NEGOTIATION_ID },
      { negotiationId: NEGOTIATION_ID, sdp: 'v=0' },
    ];
    for (const payload of bad) expectInvalidPayload(parse(envelope(type, payload)));
    // Prototype keys arrive as ordinary own keys and are unknown fields.
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      expectInvalidPayload(
        parse(
          `{"protocolVersion":1,"type":"${type}","sequence":0,"sentAt":0,"payload":{"negotiationId":"${NEGOTIATION_ID}","${key}":{}}}`,
        ),
      );
    }
    // An extra envelope field is refused before the payload is read.
    expect(
      parse(envelope(type, { negotiationId: NEGOTIATION_ID }, { negotiationId: NEGOTIATION_ID })),
    ).toMatchObject({ ok: false, reason: 'unknown_field' });
  });

  it('stay far inside the signaling message bound at their largest legal size', () => {
    expect(NEGOTIATION_ID.length).toBe(NEGOTIATION_ID_LENGTH);
    for (const type of ['RTC_ESTABLISHED', 'RTC_ESTABLISHED_ACK'] as const) {
      const text = serializeMessage({
        protocolVersion: PROTOCOL_VERSION,
        type,
        sequence: Number.MAX_SAFE_INTEGER,
        sentAt: Number.MAX_SAFE_INTEGER,
        payload: { negotiationId: NEGOTIATION_ID as NegotiationId },
      });
      // Every field is fixed-width at its maximum: the exact largest size.
      expect(encoder.encode(text).byteLength).toBe(type === 'RTC_ESTABLISHED' ? 155 : 159);
      expect(encoder.encode(text).byteLength).toBeLessThan(MAX_SIGNALING_MESSAGE_BYTES);
      const parse = type === 'RTC_ESTABLISHED' ? parseClientMessage : parseServerMessage;
      expect(parse(text).ok).toBe(true);
    }
  });
});
