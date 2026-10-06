import { describe, expect, it } from 'vitest';
import {
  isMediaSelectionId,
  isReadinessId,
  isMediaFingerprint,
  MAX_MEDIA_FINGERPRINT_BYTES,
  MAX_PEER_MESSAGE_BYTES,
  parsePeerMessage,
  parseClientMessage,
  parseServerMessage,
  utf8ByteLength,
} from '../src/index.js';
import {
  encodedBytes,
  envelope,
  SESSION_ID,
  NEGOTIATION_ID,
  PARTICIPANT_ID,
  OTHER_PARTICIPANT_ID,
} from './fixtures.js';
const context = {
  sessionId: SESSION_ID,
  negotiationId: NEGOTIATION_ID,
  senderId: PARTICIPANT_ID,
  recipientId: OTHER_PARTICIPANT_ID,
};
const selectionId = encodedBytes(16);
const fingerprint = encodedBytes(32);
const pair = { localSelectionId: selectionId, remoteSelectionId: encodedBytes(16, 8), fingerprint };
const bodies = {
  PLAY: {
    localSelectionId: selectionId,
    remoteSelectionId: pair.remoteSelectionId,
    localReadinessId: encodedBytes(16, 10),
    remoteReadinessId: encodedBytes(16, 11),
    revision: Number.MAX_SAFE_INTEGER,
    positionMs: Number.MAX_SAFE_INTEGER,
  },
  PAUSE: {
    localSelectionId: selectionId,
    remoteSelectionId: pair.remoteSelectionId,
    localReadinessId: encodedBytes(16, 10),
    remoteReadinessId: encodedBytes(16, 11),
    revision: 1,
    positionMs: 0,
  },
  SEEK: {
    localSelectionId: selectionId,
    remoteSelectionId: pair.remoteSelectionId,
    localReadinessId: encodedBytes(16, 10),
    remoteReadinessId: encodedBytes(16, 11),
    revision: 2,
    positionMs: 1000,
  },
  MEDIA_INFO: {
    selectionId,
    fingerprintVersion: 1,
    fingerprint,
    byteLength: MAX_MEDIA_FINGERPRINT_BYTES,
  },
  MEDIA_MATCH: pair,
  MEDIA_MISMATCH: {
    localSelectionId: selectionId,
    remoteSelectionId: pair.remoteSelectionId,
    reason: 'IDENTITY_MISMATCH',
  },
  READY: { ...pair, readinessId: encodedBytes(16, 10) },
  NOT_READY: { localSelectionId: null, reason: 'NO_MEDIA' },
};
describe('Local Sync protocol', () => {
  it.each([
    [isMediaSelectionId, selectionId, 22],
    [isReadinessId, encodedBytes(16, 10), 22],
    [isMediaFingerprint, fingerprint, 43],
  ] as const)('validates canonical identity %s', (guard, value, length) => {
    expect(guard(value)).toBe(true);
    for (const bad of [
      null,
      {},
      2,
      '',
      value + '=',
      value.slice(1),
      'x'.repeat(length),
      value + 'A',
      value.slice(0, -1) + 'B',
      value.replace(/./, '+'),
    ])
      expect(guard(bad)).toBe(false);
  });
  it.each(Object.entries(bodies))(
    '%s accepts exact fields, fits 1024 bytes and is peer-only',
    (type, body) => {
      const text = envelope(
        type,
        { ...context, ...body },
        { sequence: Number.MAX_SAFE_INTEGER, sentAt: Number.MAX_SAFE_INTEGER },
      );
      expect(parsePeerMessage(text).ok).toBe(true);
      expect(utf8ByteLength(text)).toBeLessThan(MAX_PEER_MESSAGE_BYTES);
      expect(parseClientMessage(text).ok).toBe(false);
      expect(parseServerMessage(text).ok).toBe(false);
    },
  );
  it.each(Object.entries(bodies))(
    '%s refuses every missing field, unknown/prototype keys and malformed context',
    (type, body) => {
      const payload = { ...context, ...body };
      for (const field of Object.keys(payload)) {
        expect(
          parsePeerMessage(
            envelope(
              type,
              Object.fromEntries(Object.entries(payload).filter(([key]) => key !== field)),
            ),
          ).ok,
        ).toBe(false);
      }
      for (const key of ['filename', 'path', '__proto__', 'constructor', 'prototype']) {
        expect(parsePeerMessage(envelope(type, { ...payload, [key]: 'private' })).ok).toBe(false);
      }
      for (const field of Object.keys(context))
        expect(parsePeerMessage(envelope(type, { ...payload, [field]: 'bad' })).ok).toBe(false);
    },
  );
  it.each([-1, 0, 0.5, MAX_MEDIA_FINGERPRINT_BYTES + 1, Number.MAX_SAFE_INTEGER + 1, '1', null])(
    'refuses byte length %s',
    (byteLength) => {
      expect(
        parsePeerMessage(envelope('MEDIA_INFO', { ...context, ...bodies.MEDIA_INFO, byteLength }))
          .ok,
      ).toBe(false);
    },
  );
  it.each([0, 2, '1', null])('refuses fingerprint version %s', (fingerprintVersion) => {
    expect(
      parsePeerMessage(
        envelope('MEDIA_INFO', { ...context, ...bodies.MEDIA_INFO, fingerprintVersion }),
      ).ok,
    ).toBe(false);
  });
  it.each(['MEDIA_INFO', 'MEDIA_MATCH', 'READY'] as const)(
    '%s rejects malformed fingerprints',
    (type) => {
      for (const fingerprint of ['', encodedBytes(31), encodedBytes(33), 'x'.repeat(43)])
        expect(
          parsePeerMessage(envelope(type, { ...context, ...bodies[type], fingerprint })).ok,
        ).toBe(false);
    },
  );
  it.each(Object.entries(bodies))('%s rejects malformed selection IDs', (type, body) => {
    const field = type === 'MEDIA_INFO' ? 'selectionId' : 'localSelectionId';
    expect(parsePeerMessage(envelope(type, { ...context, ...body, [field]: 'bad' })).ok).toBe(
      false,
    );
    if ('remoteSelectionId' in body)
      expect(
        parsePeerMessage(envelope(type, { ...context, ...body, remoteSelectionId: 'bad' })).ok,
      ).toBe(false);
  });
  it.each([
    'USER',
    'NO_MEDIA',
    'MEDIA_CHANGED',
    'PEER_MEDIA_CHANGED',
    'MEDIA_MISMATCH',
    'LOCAL_MEDIA_ERROR',
    'PLAYBACK_UNAVAILABLE',
  ])('accepts Not Ready reason %s', (reason) => {
    for (const localSelectionId of [null, selectionId])
      expect(
        parsePeerMessage(envelope('NOT_READY', { ...context, localSelectionId, reason })).ok,
      ).toBe(true);
  });
  it.each(['NOT_READY', 'MEDIA_MISMATCH'] as const)('%s rejects free-text reasons', (type) => {
    expect(
      parsePeerMessage(envelope(type, { ...context, ...bodies[type], reason: 'anything else' })).ok,
    ).toBe(false);
  });
  it('enforces UTF-8 size before parsing and rejects extra envelope fields', () => {
    const legal = envelope('READY', { ...context, ...bodies.READY });
    expect(
      parsePeerMessage(legal + ' '.repeat(MAX_PEER_MESSAGE_BYTES - utf8ByteLength(legal))).ok,
    ).toBe(true);
    expect(parsePeerMessage(legal + ' '.repeat(MAX_PEER_MESSAGE_BYTES)).ok).toBe(false);
    expect(parsePeerMessage('界'.repeat(342)).ok).toBe(false);
    expect(
      parsePeerMessage(
        envelope('READY', { ...context, ...bodies.READY }, { __proto__: null, extra: 1 }),
      ).ok,
    ).toBe(false);
  });
});

describe('playback numeric contracts', () => {
  it.each(['PLAY', 'PAUSE', 'SEEK'] as const)(
    '%s rejects malformed revision and position',
    (type) => {
      for (const field of ['revision', 'positionMs']) {
        for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', null, {}, Infinity, NaN])
          expect(
            parsePeerMessage(envelope(type, { ...context, ...bodies[type], [field]: value })).ok,
          ).toBe(false);
      }
      expect(
        parsePeerMessage(envelope(type, { ...context, ...bodies[type], revision: 0 })).ok,
      ).toBe(false);
    },
  );
  it('old conceptual SYNC shape is rejected', () => {
    expect(parsePeerMessage(envelope('SYNC', { ...context, ...bodies.PLAY })).ok).toBe(false);
  });
});

it.each(['READY', 'PLAY', 'PAUSE', 'SEEK'] as const)(
  '%s rejects every malformed readiness identity',
  (type) => {
    const fields = type === 'READY' ? ['readinessId'] : ['localReadinessId', 'remoteReadinessId'];
    for (const field of fields)
      for (const bad of [
        null,
        {},
        4,
        '',
        'A'.repeat(21),
        'A'.repeat(23),
        'A'.repeat(22) + '=',
        '+' + 'A'.repeat(21),
        'A'.repeat(21) + 'B',
      ])
        expect(
          parsePeerMessage(envelope(type, { ...context, ...bodies[type], [field]: bad })).ok,
        ).toBe(false);
  },
);
