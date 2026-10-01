import { Buffer } from 'node:buffer';
import {
  INVITE_SECRET_BYTES,
  MAX_ICE_CANDIDATES_PER_NEGOTIATION,
  RESUME_SECRET_BYTES,
  isInviteSecret,
  isParticipantId,
  isResumeSecret,
  isRoomId,
  isSessionId,
  MAX_NEGOTIATIONS_PER_MEMBERSHIP,
  type InviteSecret,
  type NegotiationId,
  type ParticipantId,
  type ResumeChallenge,
  type ResumeSecret,
  type RoomId,
  type SessionId,
} from '@driftless/protocol';
import { describe, expect, it } from 'vitest';
import type { RandomSource } from '../src/credentials.js';
import { RoomStore, type CreateRoomResult } from '../src/roomStore.js';
import { flipped, proofFor, sequentialRandom } from './support.js';

const TTL = 60_000;
const GRACE = 30_000;
const T0 = 1_000_000;
const HOST = 1;
const GUEST = 2;
const THIRD = 3;

function created(result: CreateRoomResult): Extract<CreateRoomResult, { ok: true }> {
  if (!result.ok) throw new Error('expected a room');
  return result;
}

function newStore(random: RandomSource = sequentialRandom()): RoomStore {
  return new RoomStore({ roomTtlMs: TTL, reconnectGraceMs: GRACE, random });
}

function wrongSecret(secret: InviteSecret): InviteSecret {
  const bytes = Buffer.from(secret, 'base64url');
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  return bytes.toString('base64url') as InviteSecret;
}

describe('RoomStore creation', () => {
  it('creates a room with the creator as host', () => {
    const store = newStore();
    const room = created(store.createRoom(HOST, T0));
    expect(room.host).toStrictEqual({
      key: HOST,
      participantId: room.host.participantId,
      role: 'host',
    });
    expect(isRoomId(room.roomId)).toBe(true);
    expect(isInviteSecret(room.inviteSecret)).toBe(true);
    expect(isParticipantId(room.host.participantId)).toBe(true);
    expect(room.expiresAt).toBe(T0 + TTL);
    expect(store.membershipOf(HOST)).toStrictEqual(room.host);
    expect(store.roomCount).toBe(1);
    expect(store.memberCount).toBe(1);
  });

  it('generates distinct, full-entropy credentials with the crypto source', () => {
    const count = 500;
    const store = new RoomStore({ roomTtlMs: TTL, reconnectGraceMs: GRACE, maxRooms: count });
    const roomIds = new Set<string>();
    const secrets = new Set<string>();
    const sessions = new Set<string>();
    const resumeSecrets = new Set<string>();
    let setBits = 0;
    for (let key = 0; key < count; key += 1) {
      const room = created(store.createRoom(key, T0));
      expect(isSessionId(room.sessionId)).toBe(true);
      expect(isResumeSecret(room.resumeSecret)).toBe(true);
      expect(Buffer.from(room.resumeSecret, 'base64url').byteLength).toBe(RESUME_SECRET_BYTES);
      sessions.add(room.sessionId);
      resumeSecrets.add(room.resumeSecret);
      const secretBytes = Buffer.from(room.inviteSecret, 'base64url');
      expect(secretBytes.byteLength).toBe(INVITE_SECRET_BYTES);
      expect(Buffer.from(room.roomId, 'base64url').byteLength).toBe(16);
      expect(room.roomId).not.toBe(room.inviteSecret);
      expect(room.inviteSecret.includes(room.roomId)).toBe(false);
      roomIds.add(room.roomId);
      secrets.add(room.inviteSecret);
      for (const byte of secretBytes) setBits += byte.toString(2).replaceAll('0', '').length;
    }
    expect(roomIds.size).toBe(count);
    expect(secrets.size).toBe(count);
    expect(sessions.size).toBe(count);
    expect(resumeSecrets.size).toBe(count);
    for (const secret of resumeSecrets) expect(secrets.has(secret)).toBe(false);
    // Uniform random bits are set half the time; allow a wide tolerance.
    const ratio = setBits / (count * INVITE_SECRET_BYTES * 8);
    expect(ratio).toBeGreaterThan(0.48);
    expect(ratio).toBeLessThan(0.52);
  });

  it('rejects a second room for the same member', () => {
    const store = newStore();
    created(store.createRoom(HOST, T0));
    expect(store.createRoom(HOST, T0)).toStrictEqual({ ok: false, code: 'INVALID_STATE' });
    expect(store.roomCount).toBe(1);
  });

  it('validates the room lifetime', () => {
    for (const roomTtlMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
      expect(() => new RoomStore({ roomTtlMs, reconnectGraceMs: GRACE })).toThrow(RangeError);
    }
  });

  it('retries a colliding room ID and fails safely if collisions persist', () => {
    const fixed = new Uint8Array(33).fill(7);
    let calls = 0;
    const collideOnce: RandomSource = (size) => {
      calls += 1;
      // Calls: 1–2 decoy secrets; room 1 (3 id, 4 session, 5 invite, 6 resume,
      // 7 participant); then room 2's id (call 8) collides with room 1's.
      if (calls === 3 || calls === 8) return fixed.slice(0, size);
      return new Uint8Array(size).fill(calls);
    };
    const store = newStore(collideOnce);
    const first = created(store.createRoom(HOST, T0));
    const second = created(store.createRoom(GUEST, T0));
    expect(second.roomId).not.toBe(first.roomId);

    const constant: RandomSource = (size) => new Uint8Array(size).fill(9);
    const stuck = newStore(constant);
    created(stuck.createRoom(HOST, T0));
    expect(() => stuck.createRoom(GUEST, T0)).toThrow('Could not generate a unique room ID.');
    expect(stuck.roomCount).toBe(1);
    expect(stuck.membershipOf(GUEST)).toBeUndefined();
  });

  it('rejects a random source that returns the wrong length', () => {
    expect(
      () =>
        new RoomStore({ roomTtlMs: TTL, reconnectGraceMs: GRACE, random: () => new Uint8Array(3) }),
    ).toThrow();
  });
});

describe('RoomStore joining', () => {
  it('admits a guest with the correct secret', () => {
    const store = newStore();
    const room = created(store.createRoom(HOST, T0));
    const result = store.joinRoom(GUEST, room.roomId, room.inviteSecret, T0 + 1);
    if (!result.ok) throw new Error('expected join');
    expect(result.guest.role).toBe('guest');
    expect(result.guest.key).toBe(GUEST);
    expect(result.guest.participantId).not.toBe(room.host.participantId);
    expect(result.host).toStrictEqual(room.host);
    expect(result.roomId).toBe(room.roomId);
    expect(result.expiresAt).toBe(room.expiresAt);
    expect(store.membershipOf(GUEST)).toStrictEqual(result.guest);
    expect(store.memberCount).toBe(2);
  });

  it('returns the same ROOM_UNAVAILABLE for a wrong secret, a missing room, and an expired room', () => {
    const store = newStore();
    const room = created(store.createRoom(HOST, T0));
    const other = created(store.createRoom(THIRD, T0));
    const missing = 'AAAAAAAAAAAAAAAAAAAAAA' as RoomId;
    const unavailable = { ok: false, code: 'ROOM_UNAVAILABLE' };

    expect(store.joinRoom(GUEST, room.roomId, wrongSecret(room.inviteSecret), T0)).toStrictEqual(
      unavailable,
    );
    expect(store.joinRoom(GUEST, missing, room.inviteSecret, T0)).toStrictEqual(unavailable);
    // Cross-room: a valid secret for one room does not open another.
    expect(store.joinRoom(GUEST, other.roomId, room.inviteSecret, T0)).toStrictEqual(unavailable);
    expect(store.joinRoom(GUEST, room.roomId, room.inviteSecret, T0 + TTL)).toStrictEqual(
      unavailable,
    );
    expect(store.membershipOf(GUEST)).toBeUndefined();
  });

  it('admits no third participant, and reveals fullness only to secret holders', () => {
    const store = newStore();
    const room = created(store.createRoom(HOST, T0));
    expect(store.joinRoom(GUEST, room.roomId, room.inviteSecret, T0).ok).toBe(true);
    expect(store.joinRoom(THIRD, room.roomId, room.inviteSecret, T0)).toStrictEqual({
      ok: false,
      code: 'ROOM_FULL',
    });
    expect(store.joinRoom(THIRD, room.roomId, wrongSecret(room.inviteSecret), T0)).toStrictEqual({
      ok: false,
      code: 'ROOM_UNAVAILABLE',
    });
    expect(store.membershipOf(THIRD)).toBeUndefined();
    expect(store.memberCount).toBe(2);
  });

  it('rejects join by a member of any room', () => {
    const store = newStore();
    const room = created(store.createRoom(HOST, T0));
    const other = created(store.createRoom(THIRD, T0));
    expect(store.joinRoom(HOST, room.roomId, room.inviteSecret, T0)).toStrictEqual({
      ok: false,
      code: 'INVALID_STATE',
    });
    expect(store.joinRoom(GUEST, room.roomId, room.inviteSecret, T0).ok).toBe(true);
    expect(store.joinRoom(GUEST, room.roomId, room.inviteSecret, T0)).toStrictEqual({
      ok: false,
      code: 'INVALID_STATE',
    });
    expect(store.joinRoom(GUEST, other.roomId, other.inviteSecret, T0)).toStrictEqual({
      ok: false,
      code: 'INVALID_STATE',
    });
    expect(store.createRoom(GUEST, T0)).toStrictEqual({ ok: false, code: 'INVALID_STATE' });
  });

  it('gives the guest a participant ID distinct from the host even if randomness repeats', () => {
    let calls = 0;
    const repeating: RandomSource = (size) => {
      calls += 1;
      // Call 7 is the host participant ID (after 2 decoys and the room's ID,
      // session ID, invite secret, and resume secret); the join draws the
      // guest's resume secret (call 8), then call 9 repeats the host's ID.
      return new Uint8Array(size).fill(calls === 9 ? 7 : calls);
    };
    const store = newStore(repeating);
    const room = created(store.createRoom(HOST, T0));
    const joined = store.joinRoom(GUEST, room.roomId, room.inviteSecret, T0);
    if (!joined.ok) throw new Error('expected join');
    expect(joined.guest.participantId).not.toBe(room.host.participantId);
  });
});

describe('RoomStore leaving', () => {
  it('keeps the room open for the host when the guest leaves', () => {
    const store = newStore();
    const room = created(store.createRoom(HOST, T0));
    const joined = store.joinRoom(GUEST, room.roomId, room.inviteSecret, T0);
    if (!joined.ok) throw new Error('expected join');

    expect(store.leaveRoom(GUEST)).toStrictEqual({
      ok: true,
      kind: 'guest_left',
      guest: joined.guest,
      host: room.host,
    });
    expect(store.membershipOf(GUEST)).toBeUndefined();
    expect(store.membershipOf(HOST)).toStrictEqual(room.host);
    expect(store.memberCount).toBe(1);

    // The invite stays valid for the room's lifetime; a new guest gets a new ID.
    const rejoined = store.joinRoom(THIRD, room.roomId, room.inviteSecret, T0);
    if (!rejoined.ok) throw new Error('expected rejoin');
    expect(rejoined.guest.participantId).not.toBe(joined.guest.participantId);
  });

  it('closes the room when the host leaves and never promotes the guest', () => {
    const store = newStore();
    const room = created(store.createRoom(HOST, T0));
    const joined = store.joinRoom(GUEST, room.roomId, room.inviteSecret, T0);
    if (!joined.ok) throw new Error('expected join');

    expect(store.leaveRoom(HOST)).toStrictEqual({
      ok: true,
      kind: 'room_closed',
      host: room.host,
      guest: joined.guest,
    });
    expect(store.membershipOf(GUEST)).toBeUndefined();
    expect(store.roomCount).toBe(0);
    expect(store.memberCount).toBe(0);
    expect(store.joinRoom(THIRD, room.roomId, room.inviteSecret, T0)).toStrictEqual({
      ok: false,
      code: 'ROOM_UNAVAILABLE',
    });
  });

  it('closes a host-only room on host departure', () => {
    const store = newStore();
    const room = created(store.createRoom(HOST, T0));
    expect(store.leaveRoom(HOST)).toStrictEqual({
      ok: true,
      kind: 'room_closed',
      host: room.host,
      guest: undefined,
    });
    expect(store.roomCount).toBe(0);
  });

  it('rejects leave by a non-member', () => {
    const store = newStore();
    expect(store.leaveRoom(HOST)).toStrictEqual({ ok: false, code: 'INVALID_STATE' });
    created(store.createRoom(HOST, T0));
    expect(store.leaveRoom(GUEST)).toStrictEqual({ ok: false, code: 'INVALID_STATE' });
    expect(store.leaveRoom(HOST).ok).toBe(true);
    expect(store.leaveRoom(HOST)).toStrictEqual({ ok: false, code: 'INVALID_STATE' });
  });

  it('retains no state after many room cycles', () => {
    const store = newStore();
    for (let cycle = 0; cycle < 1000; cycle += 1) {
      const room = created(store.createRoom(HOST, T0));
      expect(store.joinRoom(GUEST, room.roomId, room.inviteSecret, T0).ok).toBe(true);
      expect(store.leaveRoom(cycle % 2 === 0 ? GUEST : HOST).ok).toBe(true);
      if (cycle % 2 === 0) expect(store.leaveRoom(HOST).ok).toBe(true);
    }
    expect(store.roomCount).toBe(0);
    expect(store.memberCount).toBe(0);
  });
});

describe('RoomStore expiry', () => {
  it('expires rooms exactly at their lifetime and removes their members', () => {
    const store = newStore();
    const room = created(store.createRoom(HOST, T0));
    expect(store.joinRoom(GUEST, room.roomId, room.inviteSecret, T0 + TTL - 1).ok).toBe(true);

    expect(store.expireDue(T0 + TTL - 1)).toStrictEqual([]);
    expect(store.roomCount).toBe(1);

    const closed = store.expireDue(T0 + TTL);
    expect(closed).toHaveLength(1);
    const [event] = closed;
    if (event?.kind !== 'room_closed') throw new Error('expected a closed room');
    expect(event.reason).toBe('EXPIRED');
    expect(event.connected.map((member) => member.key)).toStrictEqual([HOST, GUEST]);
    expect(store.roomCount).toBe(0);
    expect(store.memberCount).toBe(0);
    expect(store.membershipOf(HOST)).toBeUndefined();
    expect(store.expireDue(T0 + TTL * 10)).toStrictEqual([]);
  });

  it('refuses joins after expiry even before the sweep runs', () => {
    const store = newStore();
    const room = created(store.createRoom(HOST, T0));
    expect(store.joinRoom(GUEST, room.roomId, room.inviteSecret, T0 + TTL)).toStrictEqual({
      ok: false,
      code: 'ROOM_UNAVAILABLE',
    });
    store.expireDue(T0 + TTL);
    expect(store.joinRoom(GUEST, room.roomId, room.inviteSecret, T0 + TTL)).toStrictEqual({
      ok: false,
      code: 'ROOM_UNAVAILABLE',
    });
  });

  it('expires only due rooms and lets former members start again', () => {
    const store = newStore();
    created(store.createRoom(HOST, T0));
    const later = created(store.createRoom(GUEST, T0 + 30_000));
    const closed = store.expireDue(T0 + TTL);
    expect(
      closed.map((event) =>
        event.kind === 'room_closed' ? event.connected.map((member) => member.key) : [],
      ),
    ).toStrictEqual([[HOST]]);
    expect(store.membershipOf(GUEST)?.participantId).toBe(later.host.participantId);
    expect(store.createRoom(HOST, T0 + TTL).ok).toBe(true);
  });

  it('clear drops everything', () => {
    const store = newStore();
    created(store.createRoom(HOST, T0));
    store.clear();
    expect(store.roomCount).toBe(0);
    expect(store.memberCount).toBe(0);
  });
});

describe('RoomStore negotiation', () => {
  const FIRST = 'A'.repeat(24) as NegotiationId;
  const SECOND = 'B'.repeat(24) as NegotiationId;

  function pair(store = newStore()) {
    const room = created(store.createRoom(HOST, T0));
    const joined = store.joinRoom(GUEST, room.roomId, room.inviteSecret, T0);
    if (!joined.ok) throw new Error('expected a guest');
    return { store, room, guest: joined.guest };
  }

  it('routes each step to the sender peer, derived from membership alone', () => {
    const { store, room, guest } = pair();
    expect(store.negotiate(HOST, 'offer', FIRST)).toStrictEqual({ ok: true, recipient: guest });
    expect(store.negotiate(HOST, 'candidate', FIRST)).toStrictEqual({ ok: true, recipient: guest });
    expect(store.negotiate(GUEST, 'answer', FIRST)).toStrictEqual({
      ok: true,
      recipient: room.host,
    });
    expect(store.negotiate(GUEST, 'candidate', FIRST)).toStrictEqual({
      ok: true,
      recipient: room.host,
    });
    expect(store.negotiate(GUEST, 'complete', FIRST).ok).toBe(true);
    expect(store.negotiate(HOST, 'complete', FIRST).ok).toBe(true);
  });

  it('refuses every step for a non-member and for a host without a guest', () => {
    const store = newStore();
    for (const step of ['offer', 'answer', 'candidate', 'complete'] as const) {
      expect(store.negotiate(THIRD, step, FIRST)).toStrictEqual({
        ok: false,
        code: 'INVALID_STATE',
      });
    }
    created(store.createRoom(HOST, T0));
    expect(store.negotiate(HOST, 'offer', FIRST).ok).toBe(false);
    expect(store.negotiationCount).toBe(0);
  });

  it('enforces roles, the active ID, and one offer and answer per guest', () => {
    const { store } = pair();
    expect(store.negotiate(GUEST, 'offer', FIRST).ok).toBe(false);
    expect(store.negotiate(GUEST, 'answer', FIRST).ok).toBe(false);
    expect(store.negotiate(HOST, 'offer', FIRST).ok).toBe(true);
    expect(store.negotiate(HOST, 'offer', SECOND).ok).toBe(false);
    expect(store.negotiate(HOST, 'answer', FIRST).ok).toBe(false);
    expect(store.negotiate(GUEST, 'answer', SECOND).ok).toBe(false);
    expect(store.negotiate(GUEST, 'candidate', FIRST).ok).toBe(false);
    expect(store.negotiate(GUEST, 'answer', FIRST).ok).toBe(true);
    expect(store.negotiate(GUEST, 'answer', FIRST).ok).toBe(false);
    expect(store.negotiate(HOST, 'candidate', SECOND).ok).toBe(false);
  });

  it('bounds candidates per participant and closes each side at completion', () => {
    const { store } = pair();
    store.negotiate(HOST, 'offer', FIRST);
    store.negotiate(GUEST, 'answer', FIRST);
    for (let index = 0; index < MAX_ICE_CANDIDATES_PER_NEGOTIATION; index += 1) {
      expect(store.negotiate(HOST, 'candidate', FIRST).ok).toBe(true);
    }
    expect(store.negotiate(HOST, 'candidate', FIRST).ok).toBe(false);
    expect(store.negotiate(GUEST, 'candidate', FIRST).ok).toBe(true);
    expect(store.negotiate(GUEST, 'complete', FIRST).ok).toBe(true);
    expect(store.negotiate(GUEST, 'complete', FIRST).ok).toBe(false);
    expect(store.negotiate(GUEST, 'candidate', FIRST).ok).toBe(false);
    expect(store.negotiate(HOST, 'complete', FIRST).ok).toBe(true);
  });

  it('gives a replacement guest a fresh negotiation and never reuses an ID', () => {
    const { store, room } = pair();
    store.negotiate(HOST, 'offer', FIRST);
    store.leaveRoom(GUEST);
    expect(store.negotiationCount).toBe(0);
    const next = store.joinRoom(THIRD, room.roomId, room.inviteSecret, T0);
    expect(next.ok).toBe(true);
    expect(store.negotiate(THIRD, 'answer', FIRST).ok).toBe(false);
    expect(store.negotiate(HOST, 'candidate', FIRST).ok).toBe(false);
    expect(store.negotiate(HOST, 'offer', FIRST).ok).toBe(false);
    expect(store.negotiate(HOST, 'offer', SECOND).ok).toBe(true);
    expect(store.negotiate(THIRD, 'answer', SECOND).ok).toBe(true);
    // The departed guest can no longer take part.
    expect(store.negotiate(GUEST, 'candidate', SECOND).ok).toBe(false);
  });

  it('retains no negotiation after the room ends', () => {
    const { store } = pair();
    store.negotiate(HOST, 'offer', FIRST);
    expect(store.negotiationCount).toBe(1);
    store.leaveRoom(HOST);
    expect(store.negotiationCount).toBe(0);
    expect(store.negotiate(GUEST, 'answer', FIRST).ok).toBe(false);

    const expiring = pair();
    expiring.store.negotiate(HOST, 'offer', FIRST);
    expiring.store.expireDue(T0 + TTL);
    expect(expiring.store.negotiationCount).toBe(0);
  });
});

describe('RoomStore stable membership and resume', () => {
  const CHALLENGE = 'C'.repeat(32) as ResumeChallenge;
  const OTHER_CHALLENGE = 'D'.repeat(32) as ResumeChallenge;
  const NEW_HOST = 11;
  const NEW_GUEST = 12;
  const INTRUDER = 13;

  function pair(store = newStore()) {
    const room = created(store.createRoom(HOST, T0));
    const joined = store.joinRoom(GUEST, room.roomId, room.inviteSecret, T0);
    if (!joined.ok) throw new Error('expected a guest');
    return { store, room, joined };
  }

  function resume(
    store: RoomStore,
    key: number,
    sessionId: SessionId,
    participantId: ParticipantId,
    secret: ResumeSecret,
    now: number,
    challenge = CHALLENGE,
  ) {
    return store.resume(
      key,
      sessionId,
      participantId,
      challenge,
      proofFor(secret, sessionId, participantId, challenge),
      now,
    );
  }

  it('creates a session ID for the room and a separate resume secret for each participant', () => {
    const { room, joined } = pair();
    expect(isSessionId(room.sessionId)).toBe(true);
    expect(joined.sessionId).toBe(room.sessionId);
    expect(isResumeSecret(room.resumeSecret)).toBe(true);
    expect(isResumeSecret(joined.resumeSecret)).toBe(true);
    expect(new Set([room.resumeSecret, joined.resumeSecret, room.inviteSecret]).size).toBe(3);
  });

  it('holds a participant whose connection was lost, with the same identity and role', () => {
    const { store, room, joined } = pair();
    const lost = store.connectionLost(GUEST, T0 + 5);
    expect(lost).toStrictEqual({
      ok: true,
      member: { participantId: joined.guest.participantId, role: 'guest', key: undefined },
      peer: room.host,
      negotiation: { activeNegotiationId: null, negotiationCount: 0 },
      graceEndsAt: T0 + 5 + GRACE,
    });
    // The membership is kept, the slot is held, and the old key is unbound.
    expect(store.memberCount).toBe(2);
    expect(store.connectedCount).toBe(1);
    expect(store.membershipOf(GUEST)).toBeUndefined();
    expect(store.joinRoom(THIRD, room.roomId, room.inviteSecret, T0 + 6)).toStrictEqual({
      ok: false,
      code: 'ROOM_FULL',
    });
    expect(store.connectionLost(GUEST, T0 + 7)).toStrictEqual({ ok: false });
  });

  it('resumes the same participant on a new key, keeping its ID and role', () => {
    const { store, room, joined } = pair();
    store.connectionLost(GUEST, T0);
    const result = resume(
      store,
      NEW_GUEST,
      room.sessionId,
      joined.guest.participantId,
      joined.resumeSecret,
      T0 + GRACE - 1,
    );
    expect(result).toStrictEqual({
      ok: true,
      roomId: room.roomId,
      sessionId: room.sessionId,
      expiresAt: room.expiresAt,
      member: { participantId: joined.guest.participantId, role: 'guest', key: NEW_GUEST },
      peer: room.host,
      negotiation: { activeNegotiationId: null, negotiationCount: 0 },
    });
    expect(store.membershipOf(NEW_GUEST)?.participantId).toBe(joined.guest.participantId);
    expect(store.membershipOf(GUEST)).toBeUndefined();
    expect(store.connectedCount).toBe(2);
  });

  it('resumes the host without promoting or replacing anyone', () => {
    const { store, room, joined } = pair();
    store.connectionLost(HOST, T0);
    expect(store.roomCount).toBe(1);
    expect(store.membershipOf(GUEST)?.role).toBe('guest');
    const result = resume(
      store,
      NEW_HOST,
      room.sessionId,
      room.host.participantId,
      room.resumeSecret,
      T0 + 1,
    );
    expect(result.ok && result.member).toStrictEqual({
      participantId: room.host.participantId,
      role: 'host',
      key: NEW_HOST,
    });
    expect(result.ok && result.peer).toStrictEqual(joined.guest);
    expect(store.membershipOf(GUEST)?.role).toBe('guest');
  });

  it('refuses every unusable resume with one indistinguishable result', () => {
    const { store, room, joined } = pair();
    const unavailable = { ok: false, code: 'SESSION_UNAVAILABLE' };
    const guestId = joined.guest.participantId;
    // Still connected: no takeover, even with a valid proof.
    expect(resume(store, INTRUDER, room.sessionId, guestId, joined.resumeSecret, T0)).toStrictEqual(
      unavailable,
    );
    expect(store.membershipOf(GUEST)?.key).toBe(GUEST);

    store.connectionLost(GUEST, T0);
    const attempts = [
      // Wrong proof: the host's secret, and the guest's secret with one bit flipped.
      resume(store, INTRUDER, room.sessionId, guestId, room.resumeSecret, T0),
      resume(store, INTRUDER, room.sessionId, guestId, flipped(joined.resumeSecret), T0),
      // Unknown session and unknown participant.
      resume(store, INTRUDER, flipped(room.sessionId), guestId, joined.resumeSecret, T0),
      resume(store, INTRUDER, room.sessionId, flipped(guestId), joined.resumeSecret, T0),
      // A proof for another challenge.
      store.resume(
        INTRUDER,
        room.sessionId,
        guestId,
        CHALLENGE,
        proofFor(joined.resumeSecret, room.sessionId, guestId, OTHER_CHALLENGE),
        T0,
      ),
      // The other participant's identity with this participant's secret.
      resume(store, INTRUDER, room.sessionId, room.host.participantId, joined.resumeSecret, T0),
    ];
    for (const attempt of attempts) expect(attempt).toStrictEqual(unavailable);
    expect(store.membershipOf(INTRUDER)).toBeUndefined();
    // The real participant can still resume afterwards.
    expect(resume(store, NEW_GUEST, room.sessionId, guestId, joined.resumeSecret, T0).ok).toBe(
      true,
    );
  });

  it('allows one binding: a resumed participant cannot be resumed again while connected', () => {
    const { store, room, joined } = pair();
    const guestId = joined.guest.participantId;
    store.connectionLost(GUEST, T0);
    expect(resume(store, NEW_GUEST, room.sessionId, guestId, joined.resumeSecret, T0).ok).toBe(
      true,
    );
    expect(
      resume(store, INTRUDER, room.sessionId, guestId, joined.resumeSecret, T0, OTHER_CHALLENGE),
    ).toStrictEqual({ ok: false, code: 'SESSION_UNAVAILABLE' });
    // A key that already carries a membership cannot resume another.
    store.connectionLost(HOST, T0);
    expect(
      resume(store, NEW_GUEST, room.sessionId, room.host.participantId, room.resumeSecret, T0),
    ).toStrictEqual({ ok: false, code: 'INVALID_STATE' });
  });

  it('frees the guest slot when the guest grace ends, exactly at the deadline', () => {
    const { store, room, joined } = pair();
    store.negotiate(HOST, 'offer', 'A'.repeat(24) as NegotiationId);
    store.connectionLost(GUEST, T0);
    expect(store.expireDue(T0 + GRACE - 1)).toStrictEqual([]);
    expect(
      resume(
        store,
        NEW_GUEST,
        room.sessionId,
        joined.guest.participantId,
        joined.resumeSecret,
        T0 + GRACE,
      ),
    ).toStrictEqual({ ok: false, code: 'SESSION_UNAVAILABLE' });
    expect(store.expireDue(T0 + GRACE)).toStrictEqual([
      {
        kind: 'guest_timed_out',
        guest: { ...joined.guest, key: undefined },
        host: room.host,
      },
    ]);
    expect(store.memberCount).toBe(1);
    expect(store.negotiationCount).toBe(0);
    // The slot is free for a new guest, with a new identity.
    const next = store.joinRoom(THIRD, room.roomId, room.inviteSecret, T0 + GRACE);
    expect(next.ok && next.guest.participantId).not.toBe(joined.guest.participantId);
  });

  it('closes the room when the host grace ends, invalidating the invite', () => {
    const { store, room } = pair();
    store.connectionLost(HOST, T0);
    expect(store.expireDue(T0 + GRACE - 1)).toStrictEqual([]);
    expect(
      resume(
        store,
        NEW_HOST,
        room.sessionId,
        room.host.participantId,
        room.resumeSecret,
        T0 + GRACE,
      ).ok,
    ).toBe(false);
    const events = store.expireDue(T0 + GRACE);
    expect(events).toStrictEqual([
      {
        kind: 'room_closed',
        reason: 'HOST_RECONNECT_TIMEOUT',
        connected: [{ participantId: expect.any(String) as unknown, role: 'guest', key: GUEST }],
      },
    ]);
    expect(store.roomCount).toBe(0);
    expect(store.memberCount).toBe(0);
    expect(store.joinRoom(THIRD, room.roomId, room.inviteSecret, T0 + GRACE)).toStrictEqual({
      ok: false,
      code: 'ROOM_UNAVAILABLE',
    });
  });

  it('holds both participants independently when both connections are lost', () => {
    const { store, room, joined } = pair();
    store.connectionLost(GUEST, T0);
    store.connectionLost(HOST, T0 + 10_000);
    expect(store.connectedCount).toBe(0);
    expect(store.roomCount).toBe(1);
    // The guest's grace ends first; the host may still resume.
    expect(store.expireDue(T0 + GRACE)).toStrictEqual([
      {
        kind: 'guest_timed_out',
        guest: { ...joined.guest, key: undefined },
        host: { ...room.host, key: undefined },
      },
    ]);
    const host = resume(
      store,
      NEW_HOST,
      room.sessionId,
      room.host.participantId,
      room.resumeSecret,
      T0 + GRACE,
    );
    expect(host.ok && host.peer).toBeUndefined();

    // Both lost again: the host's expiry closes the room whatever the guest's state.
    const second = pair();
    second.store.connectionLost(HOST, T0);
    second.store.connectionLost(GUEST, T0 + 1);
    expect(second.store.expireDue(T0 + GRACE)).toStrictEqual([
      { kind: 'room_closed', reason: 'HOST_RECONNECT_TIMEOUT', connected: [] },
    ]);
    expect(second.store.roomCount).toBe(0);
  });

  it('lets room expiry override any grace period', () => {
    const { store, room, joined } = pair();
    store.connectionLost(GUEST, T0 + TTL - 100);
    expect(
      resume(
        store,
        NEW_GUEST,
        room.sessionId,
        joined.guest.participantId,
        joined.resumeSecret,
        T0 + TTL,
      ),
    ).toStrictEqual({ ok: false, code: 'SESSION_UNAVAILABLE' });
    expect(store.expireDue(T0 + TTL)).toStrictEqual([
      { kind: 'room_closed', reason: 'EXPIRED', connected: [room.host] },
    ]);
    expect(store.memberCount).toBe(0);
  });

  it('ends membership at once on leave: no grace, and the resume key is gone', () => {
    const { store, room, joined } = pair();
    store.leaveRoom(GUEST);
    expect(
      resume(store, NEW_GUEST, room.sessionId, joined.guest.participantId, joined.resumeSecret, T0),
    ).toStrictEqual({ ok: false, code: 'SESSION_UNAVAILABLE' });
    store.leaveRoom(HOST);
    expect(
      resume(store, NEW_HOST, room.sessionId, room.host.participantId, room.resumeSecret, T0),
    ).toStrictEqual({ ok: false, code: 'SESSION_UNAVAILABLE' });
    expect(store.roomCount).toBe(0);
  });

  it('bounds rooms held at once, including rooms whose host is reconnecting', () => {
    const store = new RoomStore({
      roomTtlMs: TTL,
      reconnectGraceMs: GRACE,
      maxRooms: 2,
      random: sequentialRandom(),
    });
    created(store.createRoom(1, T0));
    created(store.createRoom(2, T0));
    store.connectionLost(1, T0);
    expect(store.createRoom(3, T0)).toStrictEqual({ ok: false, code: 'SERVER_ERROR' });
    store.expireDue(T0 + GRACE);
    expect(store.createRoom(3, T0 + GRACE).ok).toBe(true);
    for (const bound of [0, -1, 1.5]) {
      expect(
        () => new RoomStore({ roomTtlMs: TTL, reconnectGraceMs: GRACE, maxRooms: bound }),
      ).toThrow(RangeError);
    }
    for (const grace of [0, -1, Number.NaN]) {
      expect(() => new RoomStore({ roomTtlMs: TTL, reconnectGraceMs: grace })).toThrow(RangeError);
    }
  });

  it('retains no state after many lose, resume, and timeout cycles', () => {
    const store = newStore();
    let key = 100;
    for (let cycle = 0; cycle < 200; cycle += 1) {
      const host = (key += 1);
      const guest = (key += 1);
      const room = created(store.createRoom(host, T0));
      const joined = store.joinRoom(guest, room.roomId, room.inviteSecret, T0);
      if (!joined.ok) throw new Error('expected a guest');
      store.connectionLost(guest, T0);
      const resumed = (key += 1);
      resume(store, resumed, room.sessionId, joined.guest.participantId, joined.resumeSecret, T0);
      store.connectionLost(resumed, T0);
      store.connectionLost(host, T0);
      store.expireDue(T0 + GRACE);
    }
    expect(store.roomCount).toBe(0);
    expect(store.memberCount).toBe(0);
    expect(store.connectedCount).toBe(0);
  });
});

describe('RoomStore recovery negotiation', () => {
  const ids = ['A', 'B', 'C', 'D', 'E', 'F'].map((c) => c.repeat(24) as NegotiationId);
  const [A, B, C, D, E] = ids as [
    NegotiationId,
    NegotiationId,
    NegotiationId,
    NegotiationId,
    NegotiationId,
  ];

  function negotiated() {
    const store = newStore();
    const room = created(store.createRoom(HOST, T0));
    const joined = store.joinRoom(GUEST, room.roomId, room.inviteSecret, T0);
    if (!joined.ok) throw new Error('expected a guest');
    expect(store.negotiate(HOST, 'offer', A).ok).toBe(true);
    expect(store.negotiate(GUEST, 'answer', A).ok).toBe(true);
    return { store, room, joined };
  }

  it('replaces the active negotiation only from the host, naming it, with a fresh ID', () => {
    const { store } = negotiated();
    expect(store.negotiate(GUEST, 'recover', B, A).ok).toBe(false);
    expect(store.negotiate(HOST, 'recover', B, C).ok).toBe(false);
    expect(store.negotiate(HOST, 'recover', B).ok).toBe(false);
    expect(store.negotiate(HOST, 'recover', A, A).ok).toBe(false);
    expect(store.negotiate(HOST, 'recover', B, A).ok).toBe(true);
    expect(store.negotiationOf(HOST)).toStrictEqual({
      activeNegotiationId: B,
      negotiationCount: 2,
    });
    // The old negotiation is over: its answer, ICE, and completion are refused.
    for (const step of ['answer', 'candidate', 'complete'] as const) {
      expect(store.negotiate(GUEST, step, A).ok).toBe(false);
      expect(store.negotiate(HOST, step === 'answer' ? 'candidate' : step, A).ok).toBe(false);
    }
    // Candidate counters and flags start afresh for the new one.
    expect(store.negotiate(GUEST, 'candidate', B).ok).toBe(false);
    expect(store.negotiate(GUEST, 'answer', B).ok).toBe(true);
    for (let index = 0; index < MAX_ICE_CANDIDATES_PER_NEGOTIATION; index += 1) {
      expect(store.negotiate(GUEST, 'candidate', B).ok).toBe(true);
    }
    // Neither an old ID nor a second plain offer is accepted.
    expect(store.negotiate(HOST, 'recover', A, B).ok).toBe(false);
    expect(store.negotiate(HOST, 'offer', C).ok).toBe(false);
  });

  it(`bounds a membership to ${String(MAX_NEGOTIATIONS_PER_MEMBERSHIP)} negotiations`, () => {
    const { store } = negotiated();
    expect(store.negotiate(HOST, 'recover', B, A).ok).toBe(true);
    expect(store.negotiate(HOST, 'recover', C, B).ok).toBe(true);
    expect(store.negotiate(HOST, 'recover', D, C).ok).toBe(true);
    expect(store.negotiationOf(HOST)?.negotiationCount).toBe(MAX_NEGOTIATIONS_PER_MEMBERSHIP);
    expect(store.negotiate(HOST, 'recover', E, D).ok).toBe(false);
    // No request can be accepted either, since no recovery could follow.
    expect(store.negotiate(GUEST, 'recovery_request', D).ok).toBe(false);
  });

  it('accepts one guest recovery request per negotiation, naming the active one', () => {
    const { store, room } = negotiated();
    expect(store.negotiate(HOST, 'recovery_request', A).ok).toBe(false);
    expect(store.negotiate(GUEST, 'recovery_request', B).ok).toBe(false);
    expect(store.negotiate(GUEST, 'recovery_request', A)).toStrictEqual({
      ok: true,
      recipient: room.host,
    });
    expect(store.negotiate(GUEST, 'recovery_request', A).ok).toBe(false);
    expect(store.negotiate(HOST, 'recover', B, A).ok).toBe(true);
    expect(store.negotiate(GUEST, 'recovery_request', B).ok).toBe(true);
  });

  it('refuses every negotiation step towards a reconnecting participant', () => {
    const { store } = negotiated();
    store.connectionLost(GUEST, T0);
    expect(store.negotiate(HOST, 'recover', B, A).ok).toBe(false);
    expect(store.negotiate(HOST, 'candidate', A).ok).toBe(false);
    expect(store.negotiate(HOST, 'complete', A).ok).toBe(false);
    // Refusals change nothing.
    expect(store.negotiationOf(HOST)).toStrictEqual({
      activeNegotiationId: A,
      negotiationCount: 1,
    });

    const other = negotiated();
    other.store.connectionLost(HOST, T0);
    expect(other.store.negotiate(GUEST, 'recovery_request', A).ok).toBe(false);
    expect(other.store.negotiate(GUEST, 'candidate', A).ok).toBe(false);
  });

  it('keeps the negotiation across a resume so the snapshot can be reconciled', () => {
    const { store, room, joined } = negotiated();
    store.negotiate(HOST, 'recover', B, A);
    store.connectionLost(GUEST, T0);
    const challenge = 'C'.repeat(32) as ResumeChallenge;
    const result = store.resume(
      40,
      room.sessionId,
      joined.guest.participantId,
      challenge,
      proofFor(joined.resumeSecret, room.sessionId, joined.guest.participantId, challenge),
      T0,
    );
    expect(result.ok && result.negotiation).toStrictEqual({
      activeNegotiationId: B,
      negotiationCount: 2,
    });
    expect(store.negotiate(40, 'answer', B).ok).toBe(true);
  });

  it('starts a later guest with a fresh budget and never accepts an earlier ID', () => {
    const { store, room } = negotiated();
    store.negotiate(HOST, 'recover', B, A);
    store.negotiate(HOST, 'recover', C, B);
    store.leaveRoom(GUEST);
    expect(store.joinRoom(THIRD, room.roomId, room.inviteSecret, T0).ok).toBe(true);
    expect(store.negotiationOf(HOST)).toStrictEqual({
      activeNegotiationId: null,
      negotiationCount: 0,
    });
    // The room's most recent ID stays unusable; a fresh one is accepted.
    expect(store.negotiate(HOST, 'offer', C).ok).toBe(false);
    expect(store.negotiate(HOST, 'offer', D).ok).toBe(true);
    expect(store.negotiate(HOST, 'recover', E, D).ok).toBe(true);
  });
});
