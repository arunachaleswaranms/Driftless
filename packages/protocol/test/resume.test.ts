import { createHash, createHmac, randomBytes, webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_MESSAGE_TYPES,
  MAX_NEGOTIATIONS_PER_MEMBERSHIP,
  MAX_SDP_BYTES,
  RESUME_PROOF_DOMAIN,
  RESUME_PROOF_INPUT_BYTES,
  SERVER_MESSAGE_TYPES,
  decodeBase64Url,
  encodeBase64Url,
  parseClientMessage,
  parsePeerMessage,
  parseServerMessage,
  resumeProofInput,
  resumeSecretBytes,
  serializeMessage,
  type ParseResult,
  type ParticipantId,
  type ResumeChallenge,
  type ResumeSecret,
  type SessionId,
} from '../src/index.js';
import {
  INVITE_SECRET,
  NEGOTIATION_ID,
  OTHER_NEGOTIATION_ID,
  OTHER_PARTICIPANT_ID,
  PARTICIPANT_ID,
  RESUME_CHALLENGE,
  RESUME_PROOF,
  RESUME_SECRET,
  ROOM_ID,
  SDP,
  SESSION_ID,
  VALID_CLIENT_PAYLOADS,
  VALID_PEER_PAYLOADS,
  VALID_SERVER_PAYLOADS,
  encodedBytes,
  envelope,
} from './fixtures.js';

function expectInvalidPayload(result: ParseResult<unknown>): void {
  expect(result).toStrictEqual({ ok: false, code: 'INVALID_MESSAGE', reason: 'invalid_payload' });
}

function without(value: object, field: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
}

// A fixed vector, computed independently of this package (Python hashlib and
// hmac) from the byte layout documented in src/resume.ts. No production
// randomness is involved.
const VECTOR = {
  secret: 'gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaXmJmam5ydnp-g' as ResumeSecret,
  sessionId: 'EBESExQVFhcYGRobHB0eHyAhIiM' as SessionId,
  participantId: 'MDEyMzQ1Njc4OTo7' as ParticipantId,
  challenge: 'UFFSU1RVVldYWVpbXF1eX2BhYmNkZWZn' as ResumeChallenge,
  input:
    '64726966746c6573732d726573756d652d763100101112131415161718191a1b1c1d1e1f20212223303132333435363738393a3b505152535455565758595a5b5c5d5e5f6061626364656667',
  proof: 'SPsQyqpMlcEcZf7Z7SoxC9hy3bg-S5a3SEiKBk7YxMM',
};

/** The service's computation: Node's crypto over the shared input. */
function nodeProof(
  secret: ResumeSecret,
  sessionId: SessionId,
  participantId: ParticipantId,
  challenge: ResumeChallenge,
): string {
  const bytes = resumeSecretBytes(secret);
  const input = resumeProofInput(sessionId, participantId, challenge);
  if (bytes === undefined || input === undefined) throw new Error('invalid vector');
  const key = createHash('sha256').update(bytes).digest();
  return createHmac('sha256', key).update(input).digest('base64url');
}

/** The browser's computation: the standard Web Crypto API over the same input. */
async function webCryptoProof(
  secret: ResumeSecret,
  sessionId: SessionId,
  participantId: ParticipantId,
  challenge: ResumeChallenge,
): Promise<string> {
  const { subtle } = webcrypto;
  const bytes = resumeSecretBytes(secret);
  const input = resumeProofInput(sessionId, participantId, challenge);
  if (bytes === undefined || input === undefined) throw new Error('invalid vector');
  const keyBytes = await subtle.digest('SHA-256', bytes);
  const key = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return encodeBase64Url(new Uint8Array(await subtle.sign('HMAC', key, input)));
}

describe('base64url codec', () => {
  it('round-trips every length against Node, with no padding', () => {
    for (let length = 0; length <= 70; length += 1) {
      const bytes = randomBytes(length);
      const text = encodeBase64Url(bytes);
      expect(text).toBe(bytes.toString('base64url'));
      expect(decodeBase64Url(text)).toStrictEqual(new Uint8Array(bytes));
    }
  });

  it('accepts only canonical text', () => {
    for (const text of ['A', 'AAAAA', 'AB', 'AAB', 'AA==', 'A+A', 'A/A', 'AA A', 'Aé', '\u0000']) {
      expect(decodeBase64Url(text)).toBeUndefined();
    }
    expect(decodeBase64Url('AA')).toStrictEqual(new Uint8Array([0]));
    expect(decodeBase64Url('AAA')).toStrictEqual(new Uint8Array([0, 0]));
    expect(decodeBase64Url('')).toStrictEqual(new Uint8Array([]));
  });
});

describe('resume proof input', () => {
  it('has the documented fixed layout', () => {
    const input = resumeProofInput(VECTOR.sessionId, VECTOR.participantId, VECTOR.challenge);
    expect(input).toBeDefined();
    expect(input?.byteLength).toBe(RESUME_PROOF_INPUT_BYTES);
    expect(RESUME_PROOF_INPUT_BYTES).toBe(76);
    expect(Buffer.from(input ?? []).toString('hex')).toBe(VECTOR.input);
    expect(
      Buffer.from(input ?? [])
        .subarray(0, 19)
        .toString('ascii'),
    ).toBe(RESUME_PROOF_DOMAIN);
    expect(input?.[19]).toBe(0);
  });

  it('refuses non-canonical values instead of guessing', () => {
    const { sessionId, participantId, challenge } = VECTOR;
    expect(resumeProofInput('x' as SessionId, participantId, challenge)).toBeUndefined();
    expect(resumeProofInput(sessionId, ROOM_ID as ParticipantId, challenge)).toBeUndefined();
    expect(resumeProofInput(sessionId, participantId, NEGOTIATION_ID as ResumeChallenge)).toBe(
      undefined,
    );
    expect(resumeSecretBytes(INVITE_SECRET as ResumeSecret)).toBeUndefined();
    expect(resumeSecretBytes(VECTOR.secret)?.byteLength).toBe(33);
  });

  it('matches the fixed vector in Node crypto and in Web Crypto', async () => {
    const args = [VECTOR.secret, VECTOR.sessionId, VECTOR.participantId, VECTOR.challenge] as const;
    expect(nodeProof(...args)).toBe(VECTOR.proof);
    expect(await webCryptoProof(...args)).toBe(VECTOR.proof);
  });

  it('changes with every bound value and with the secret', async () => {
    const proofs = new Set([
      VECTOR.proof,
      nodeProof(
        VECTOR.secret,
        VECTOR.sessionId,
        VECTOR.participantId,
        encodedBytes(24, 0x51) as ResumeChallenge,
      ),
      nodeProof(
        VECTOR.secret,
        encodedBytes(20, 0x11) as SessionId,
        VECTOR.participantId,
        VECTOR.challenge,
      ),
      nodeProof(
        VECTOR.secret,
        VECTOR.sessionId,
        encodedBytes(12, 0x31) as ParticipantId,
        VECTOR.challenge,
      ),
      await webCryptoProof(
        encodedBytes(33, 0x81) as ResumeSecret,
        VECTOR.sessionId,
        VECTOR.participantId,
        VECTOR.challenge,
      ),
    ]);
    expect(proofs.size).toBe(5);
  });

  it('a proof differing in one byte is a different proof', () => {
    const bytes = decodeBase64Url(VECTOR.proof);
    if (bytes === undefined) throw new Error('bad vector');
    bytes[31] = (bytes[31] ?? 0) ^ 1;
    expect(encodeBase64Url(bytes)).not.toBe(VECTOR.proof);
  });
});

describe('session resume messages', () => {
  it.each(['SESSION_RESUME_BEGIN', 'SESSION_RESUME_PROVE'] as const)(
    '%s is client → server only, with exact fields',
    (type) => {
      const payload = VALID_CLIENT_PAYLOADS[type];
      expect(parseClientMessage(envelope(type, payload)).ok).toBe(true);
      expect(parseServerMessage(envelope(type, payload))).toMatchObject({ reason: 'unknown_type' });
      expectInvalidPayload(parseClientMessage(envelope(type, { ...payload, extra: 1 })));
      for (const field of Object.keys(payload)) {
        expectInvalidPayload(parseClientMessage(envelope(type, without(payload, field))));
      }
    },
  );

  it('SESSION_RESUME_BEGIN carries no secret and only canonical identifiers', () => {
    const begin = (payload: object) =>
      parseClientMessage(envelope('SESSION_RESUME_BEGIN', payload));
    for (const extra of [
      { resumeSecret: RESUME_SECRET },
      { inviteSecret: INVITE_SECRET },
      { roomId: ROOM_ID },
      { role: 'host' },
    ]) {
      expectInvalidPayload(begin({ ...VALID_CLIENT_PAYLOADS.SESSION_RESUME_BEGIN, ...extra }));
    }
    for (const sessionId of [ROOM_ID, NEGOTIATION_ID, `${SESSION_ID}A`, SESSION_ID.slice(1), 1]) {
      expectInvalidPayload(begin({ sessionId, participantId: PARTICIPANT_ID }));
    }
    expectInvalidPayload(begin({ sessionId: SESSION_ID, participantId: SESSION_ID }));
  });

  it('SESSION_RESUME_PROVE accepts a proof only in its canonical form, never a secret', () => {
    const prove = (payload: object) =>
      parseClientMessage(envelope('SESSION_RESUME_PROVE', payload));
    for (const proof of [
      RESUME_SECRET,
      `${RESUME_PROOF.slice(0, -1)}B`,
      `${RESUME_PROOF}=`,
      RESUME_PROOF.slice(1),
      RESUME_PROOF.toUpperCase()
        .replace(/[^A-Z]/g, 'A')
        .slice(0, 42),
      null,
    ]) {
      expectInvalidPayload(prove({ challenge: RESUME_CHALLENGE, proof }));
    }
    for (const challenge of [SESSION_ID, `${RESUME_CHALLENGE}A`, '', 0]) {
      expectInvalidPayload(prove({ challenge, proof: RESUME_PROOF }));
    }
    expectInvalidPayload(
      prove({ challenge: RESUME_CHALLENGE, proof: RESUME_PROOF, resumeSecret: RESUME_SECRET }),
    );
  });

  it.each(['SESSION_RESUME_CHALLENGE', 'SESSION_RESUMED', 'ROOM_PARTICIPANT_CONNECTION'] as const)(
    '%s is server → client only, with exact fields',
    (type) => {
      const payload = VALID_SERVER_PAYLOADS[type];
      const parsed = parseServerMessage(envelope(type, payload));
      expect(parsed.ok).toBe(true);
      if (parsed.ok)
        expect(parseServerMessage(serializeMessage(parsed.message))).toStrictEqual(parsed);
      expect(parseClientMessage(envelope(type, payload))).toMatchObject({ reason: 'unknown_type' });
      expectInvalidPayload(parseServerMessage(envelope(type, { ...payload, extra: 1 })));
      for (const field of Object.keys(payload)) {
        expectInvalidPayload(parseServerMessage(envelope(type, without(payload, field))));
      }
    },
  );

  it('SESSION_RESUME_CHALLENGE carries nothing about the room', () => {
    const challenge = (payload: object) =>
      parseServerMessage(envelope('SESSION_RESUME_CHALLENGE', payload));
    for (const extra of [{ roomId: ROOM_ID }, { sessionId: SESSION_ID }, { expiresAt: 1 }]) {
      expectInvalidPayload(challenge({ challenge: RESUME_CHALLENGE, ...extra }));
    }
    expectInvalidPayload(challenge({ challenge: NEGOTIATION_ID }));
  });

  describe('SESSION_RESUMED', () => {
    const base = VALID_SERVER_PAYLOADS.SESSION_RESUMED;
    const resumed = (payload: object) => parseServerMessage(envelope('SESSION_RESUMED', payload));

    it('accepts a host with or without a guest and a guest with its host', () => {
      expect(resumed(base).ok).toBe(true);
      expect(
        resumed({ ...base, peer: null, activeNegotiationId: null, negotiationCount: 0 }).ok,
      ).toBe(true);
      expect(
        resumed({
          ...base,
          role: 'guest',
          peer: { participantId: OTHER_PARTICIPANT_ID, role: 'host', signaling: 'RECONNECTING' },
        }).ok,
      ).toBe(true);
    });

    it('never carries a credential, description, candidate, or address', () => {
      for (const extra of [
        { inviteSecret: INVITE_SECRET },
        { resumeSecret: RESUME_SECRET },
        { sdp: SDP },
        { candidate: 'candidate:1' },
        { address: '192.0.2.1' },
      ]) {
        expectInvalidPayload(resumed({ ...base, ...extra }));
      }
    });

    it('enforces role, peer, and negotiation consistency', () => {
      const guestPeer = {
        participantId: OTHER_PARTICIPANT_ID,
        role: 'guest',
        signaling: 'CONNECTED',
      };
      for (const payload of [
        { ...base, role: 'admin' },
        // A guest's peer is the host, and a guest always has one.
        { ...base, role: 'guest' },
        { ...base, role: 'guest', peer: null, activeNegotiationId: null, negotiationCount: 0 },
        { ...base, peer: { ...guestPeer, role: 'host' } },
        { ...base, peer: { ...guestPeer, participantId: PARTICIPANT_ID } },
        { ...base, peer: { ...guestPeer, signaling: 'OFFLINE' } },
        { ...base, peer: { ...guestPeer, extra: 1 } },
        // A host without a guest has no negotiation.
        { ...base, peer: null },
        // The active ID is present exactly when the count is not zero.
        { ...base, activeNegotiationId: null },
        { ...base, negotiationCount: 0 },
        { ...base, negotiationCount: MAX_NEGOTIATIONS_PER_MEMBERSHIP + 1 },
        { ...base, negotiationCount: -1 },
        { ...base, negotiationCount: 1.5 },
        { ...base, activeNegotiationId: ROOM_ID },
        { ...base, sessionId: ROOM_ID },
        { ...base, expiresAt: -1 },
      ]) {
        expectInvalidPayload(resumed(payload));
      }
      expect(resumed({ ...base, negotiationCount: MAX_NEGOTIATIONS_PER_MEMBERSHIP }).ok).toBe(true);
    });
  });

  it('ROOM_PARTICIPANT_CONNECTION is presence only, with a consistent negotiation snapshot', () => {
    const base = VALID_SERVER_PAYLOADS.ROOM_PARTICIPANT_CONNECTION;
    const notice = (payload: object) =>
      parseServerMessage(envelope('ROOM_PARTICIPANT_CONNECTION', payload));
    for (const signaling of ['CONNECTED', 'RECONNECTING']) {
      expect(notice({ ...base, signaling }).ok).toBe(true);
    }
    expect(notice({ ...base, activeNegotiationId: null, negotiationCount: 0 }).ok).toBe(true);
    for (const payload of [
      { ...base, signaling: 'connected' },
      { ...base, signaling: 'LEFT' },
      { ...base, participantId: ROOM_ID },
      { ...base, activeNegotiationId: null },
      { ...base, negotiationCount: 0 },
      { ...base, negotiationCount: MAX_NEGOTIATIONS_PER_MEMBERSHIP + 1 },
      { ...base, address: '192.0.2.1' },
      { ...base, sdp: SDP },
    ]) {
      expectInvalidPayload(notice(payload));
    }
  });

  it('adds the reconnect timeout reasons and the session error', () => {
    expect(
      parseServerMessage(
        envelope('ROOM_PARTICIPANT_LEFT', {
          participantId: OTHER_PARTICIPANT_ID,
          reason: 'RECONNECT_TIMEOUT',
        }),
      ).ok,
    ).toBe(true);
    expect(
      parseServerMessage(envelope('ROOM_CLOSED', { reason: 'HOST_RECONNECT_TIMEOUT' })).ok,
    ).toBe(true);
    expect(
      parseServerMessage(
        envelope('ERROR', {
          code: 'SESSION_UNAVAILABLE',
          message: 'The room session is not available.',
          recoverable: true,
        }),
      ).ok,
    ).toBe(true);
  });

  it('room replies carry the session ID and the recipient’s own resume secret', () => {
    for (const type of ['ROOM_CREATED', 'ROOM_JOINED'] as const) {
      const payload = VALID_SERVER_PAYLOADS[type];
      expectInvalidPayload(
        parseServerMessage(envelope(type, { ...payload, resumeSecret: INVITE_SECRET })),
      );
      expectInvalidPayload(parseServerMessage(envelope(type, { ...payload, sessionId: ROOM_ID })));
    }
  });
});

describe('recovery messages', () => {
  const both = [
    ['client', parseClientMessage],
    ['server', parseServerMessage],
  ] as const;

  it('are relayed in both directions', () => {
    for (const type of ['RTC_RECOVERY_REQUEST', 'RTC_RECOVER']) {
      expect(CLIENT_MESSAGE_TYPES).toContain(type);
      expect(SERVER_MESSAGE_TYPES).toContain(type);
    }
  });

  it.each(both)(
    'RTC_RECOVER names two different negotiations and a bounded SDP (%s)',
    (_, parse) => {
      const recover = (payload: object) => parse(envelope('RTC_RECOVER', payload));
      const valid = {
        previousNegotiationId: OTHER_NEGOTIATION_ID,
        negotiationId: NEGOTIATION_ID,
        sdp: SDP,
      };
      expect(recover(valid).ok).toBe(true);
      expect(recover({ ...valid, sdp: 'x'.repeat(MAX_SDP_BYTES) }).ok).toBe(true);
      for (const payload of [
        { ...valid, previousNegotiationId: NEGOTIATION_ID },
        { ...valid, sdp: 'x'.repeat(MAX_SDP_BYTES + 1) },
        { ...valid, sdp: '' },
        { ...valid, previousNegotiationId: ROOM_ID },
        { ...valid, negotiationId: SESSION_ID },
        { ...valid, participantId: PARTICIPANT_ID },
        { ...valid, role: 'guest' },
        without(valid, 'previousNegotiationId'),
        without(valid, 'sdp'),
      ]) {
        expectInvalidPayload(recover(payload));
      }
    },
  );

  it.each(both)('RTC_RECOVERY_REQUEST carries only the negotiation ID (%s)', (_, parse) => {
    const request = (payload: object) => parse(envelope('RTC_RECOVERY_REQUEST', payload));
    expect(request({ negotiationId: NEGOTIATION_ID }).ok).toBe(true);
    for (const payload of [
      {},
      { negotiationId: ROOM_ID },
      { negotiationId: NEGOTIATION_ID, sdp: SDP },
      { negotiationId: NEGOTIATION_ID, role: 'host' },
    ]) {
      expectInvalidPayload(request(payload));
    }
  });
});

describe('peer handshake session binding', () => {
  it.each(Object.entries(VALID_PEER_PAYLOADS))(
    '%s requires a canonical session ID',
    (type, payload) => {
      const peer = (value: object) => parsePeerMessage(envelope(type, value));
      expect(peer(payload).ok).toBe(true);
      expectInvalidPayload(peer(without(payload, 'sessionId')));
      for (const sessionId of [ROOM_ID, NEGOTIATION_ID, RESUME_CHALLENGE, `${SESSION_ID}A`, null]) {
        expectInvalidPayload(peer({ ...payload, sessionId }));
      }
      expectInvalidPayload(peer({ ...payload, resumeSecret: RESUME_SECRET }));
    },
  );
});
