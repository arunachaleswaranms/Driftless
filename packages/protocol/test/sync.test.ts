import { describe, expect, it } from 'vitest';
import {
  MAX_SYNC_CLOCK_MS,
  MAX_PEER_MESSAGE_BYTES,
  parsePeerMessage,
  parseClientMessage,
  parseServerMessage,
  utf8ByteLength,
} from '../src/index.js';
import { encodedBytes, envelope, VALID_PEER_PAYLOADS } from './fixtures.js';
const common = {
  ...VALID_PEER_PAYLOADS.PEER_HELLO,
  localSelectionId: encodedBytes(16),
  remoteSelectionId: encodedBytes(16, 1),
  localReadinessId: encodedBytes(16, 2),
  remoteReadinessId: encodedBytes(16, 3),
  syncSequence: Number.MAX_SAFE_INTEGER,
};
const heartbeat = {
  ...common,
  phase: 'HEARTBEAT',
  revision: Number.MAX_SAFE_INTEGER,
  mode: 'playing',
  positionMs: Number.MAX_SAFE_INTEGER,
  capturedAtMs: MAX_SYNC_CLOCK_MS,
  clockOffsetMs: -Number.MAX_SAFE_INTEGER,
  roundTripMs: Number.MAX_SAFE_INTEGER,
};
const observation = {
  ...common,
  phase: 'OBSERVATION',
  guestReceivedAtMs: MAX_SYNC_CLOCK_MS,
  guestSentAtMs: MAX_SYNC_CLOCK_MS,
};
describe('strict discriminated SYNC', () => {
  it.each([heartbeat, observation])(
    'exact shape, peer only, all missing/extra/prototype fields rejected %s',
    (p) => {
      const text = envelope('SYNC', p);
      expect(parsePeerMessage(text).ok).toBe(true);
      expect(parseClientMessage(text).ok).toBe(false);
      expect(parseServerMessage(text).ok).toBe(false);
      for (const key of Object.keys(p)) {
        const missing: Record<string, unknown> = { ...p };
        Reflect.deleteProperty(missing, key);
        expect(parsePeerMessage(envelope('SYNC', missing)).ok).toBe(false);
      }
      for (const key of [
        'extra',
        '__proto__',
        'constructor',
        'prototype',
        'filename',
        'fingerprint',
        ...(p.phase === 'HEARTBEAT'
          ? ['guestReceivedAtMs', 'guestSentAtMs']
          : ['revision', 'mode', 'positionMs', 'capturedAtMs', 'clockOffsetMs', 'roundTripMs']),
      ]) {
        expect(parsePeerMessage(envelope('SYNC', { ...p, [key]: 0 })).ok).toBe(false);
      }
      for (const key of [
        'localSelectionId',
        'remoteSelectionId',
        'localReadinessId',
        'remoteReadinessId',
        'sessionId',
        'negotiationId',
        'senderId',
        'recipientId',
      ]) {
        for (const bad of [null, '', {}, 1, '!', 'A'.repeat(21) + 'B'])
          expect(parsePeerMessage(envelope('SYNC', { ...p, [key]: bad })).ok).toBe(false);
      }
    },
  );
  it.each(['capturedAtMs', 'guestReceivedAtMs', 'guestSentAtMs'])('bounds timestamp %s', (key) => {
    const p = key === 'capturedAtMs' ? heartbeat : observation;
    for (const bad of [
      -1,
      0.5,
      MAX_SYNC_CLOCK_MS + 1,
      Number.MAX_SAFE_INTEGER + 1,
      NaN,
      Infinity,
      null,
      '1',
    ])
      expect(parsePeerMessage(envelope('SYNC', { ...p, [key]: bad })).ok).toBe(false);
    for (const legal of [0, MAX_SYNC_CLOCK_MS])
      expect(parsePeerMessage(envelope('SYNC', { ...p, [key]: legal })).ok).toBe(true);
  });
  it.each([heartbeat, observation])('positive safe sample id %s', (p) => {
    for (const bad of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, null, '1'])
      expect(parsePeerMessage(envelope('SYNC', { ...p, syncSequence: bad })).ok).toBe(false);
  });
  it('enforces numeric snapshot and all-or-none estimate', () => {
    expect(
      parsePeerMessage(envelope('SYNC', { ...heartbeat, clockOffsetMs: null, roundTripMs: null }))
        .ok,
    ).toBe(true);
    for (const override of [
      { clockOffsetMs: null },
      { roundTripMs: null },
      { clockOffsetMs: 0.1 },
      { clockOffsetMs: Number.MAX_SAFE_INTEGER + 1 },
      { roundTripMs: -1 },
      { roundTripMs: 0.5 },
      { roundTripMs: Number.MAX_SAFE_INTEGER + 1 },
      { revision: 0 },
      { revision: -1 },
      { positionMs: -1 },
      { positionMs: 0.5 },
      { positionMs: Number.MAX_SAFE_INTEGER + 1 },
      { revision: 0.5 },
      { mode: 'stopped' },
    ])
      expect(parsePeerMessage(envelope('SYNC', { ...heartbeat, ...override })).ok).toBe(false);
  });
  it('rejects conceptual shapes and unknown phases/types', () => {
    for (const phase of [null, 0, 'CLOCK_REQUEST', 'ACK', 'heartbeat'])
      expect(parsePeerMessage(envelope('SYNC', { ...heartbeat, phase })).ok).toBe(false);
    for (const type of ['SYNC_ACK', 'SYNC_RESULT', 'CLOCK_REQUEST', 'CLOCK_RESPONSE'])
      expect(parsePeerMessage(envelope(type, heartbeat)).ok).toBe(false);
    expect(parsePeerMessage(envelope('SYNC', common)).ok).toBe(false);
  });
  it('largest legal messages retain the unchanged 1024-byte bound', () => {
    const sizes = [heartbeat, observation].map((p) => {
      const text = envelope('SYNC', p, {
        sequence: Number.MAX_SAFE_INTEGER,
        sentAt: Number.MAX_SAFE_INTEGER,
      });
      expect(parsePeerMessage(text).ok).toBe(true);
      expect(utf8ByteLength(text)).toBeLessThan(MAX_PEER_MESSAGE_BYTES);
      expect(parsePeerMessage(text + ' '.repeat(MAX_PEER_MESSAGE_BYTES)).ok).toBe(false);
      return utf8ByteLength(text);
    });
    expect(sizes).toEqual([648, 545]);
  });
});
