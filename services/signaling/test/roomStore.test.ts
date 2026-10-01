import { Buffer } from 'node:buffer';
import {
  INVITE_SECRET_BYTES,
  MAX_ICE_CANDIDATES_PER_NEGOTIATION,
  isInviteSecret,
  isParticipantId,
  isRoomId,
  type InviteSecret,
  type NegotiationId,
  type RoomId,
} from '@driftless/protocol';
import { describe, expect, it } from 'vitest';
import type { RandomSource } from '../src/credentials.js';
import { RoomStore, type CreateRoomResult } from '../src/roomStore.js';
import { sequentialRandom } from './support.js';

const TTL = 60_000;
const T0 = 1_000_000;
const HOST = 1;
const GUEST = 2;
const THIRD = 3;

function created(result: CreateRoomResult): Extract<CreateRoomResult, { ok: true }> {
  if (!result.ok) throw new Error('expected a room');
  return result;
}

function newStore(random: RandomSource = sequentialRandom()): RoomStore {
  return new RoomStore({ roomTtlMs: TTL, random });
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
    const store = new RoomStore({ roomTtlMs: TTL });
    const roomIds = new Set<string>();
    const secrets = new Set<string>();
    let setBits = 0;
    const count = 500;
    for (let key = 0; key < count; key += 1) {
      const room = created(store.createRoom(key, T0));
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
      expect(() => new RoomStore({ roomTtlMs })).toThrow(RangeError);
    }
  });

  it('retries a colliding room ID and fails safely if collisions persist', () => {
    const fixed = new Uint8Array(32).fill(7);
    let calls = 0;
    const collideOnce: RandomSource = (size) => {
      calls += 1;
      // Calls: 1 decoy secret, then room 1 (id, secret, participant), then room 2's id collides.
      if (calls === 5) return fixed.slice(0, size);
      if (calls === 2) return fixed.slice(0, size);
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
    expect(() => new RoomStore({ roomTtlMs: TTL, random: () => new Uint8Array(3) })).toThrow();
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
      // Call 4 is the host participant ID; call 5 repeats it for the guest.
      return new Uint8Array(size).fill(calls === 5 ? 4 : calls);
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

    expect(store.expireDueRooms(T0 + TTL - 1)).toStrictEqual([]);
    expect(store.roomCount).toBe(1);

    const closed = store.expireDueRooms(T0 + TTL);
    expect(closed).toHaveLength(1);
    expect(closed[0]?.members.map((member) => member.key)).toStrictEqual([HOST, GUEST]);
    expect(store.roomCount).toBe(0);
    expect(store.memberCount).toBe(0);
    expect(store.membershipOf(HOST)).toBeUndefined();
    expect(store.expireDueRooms(T0 + TTL * 10)).toStrictEqual([]);
  });

  it('refuses joins after expiry even before the sweep runs', () => {
    const store = newStore();
    const room = created(store.createRoom(HOST, T0));
    expect(store.joinRoom(GUEST, room.roomId, room.inviteSecret, T0 + TTL)).toStrictEqual({
      ok: false,
      code: 'ROOM_UNAVAILABLE',
    });
    store.expireDueRooms(T0 + TTL);
    expect(store.joinRoom(GUEST, room.roomId, room.inviteSecret, T0 + TTL)).toStrictEqual({
      ok: false,
      code: 'ROOM_UNAVAILABLE',
    });
  });

  it('expires only due rooms and lets former members start again', () => {
    const store = newStore();
    created(store.createRoom(HOST, T0));
    const later = created(store.createRoom(GUEST, T0 + 30_000));
    const closed = store.expireDueRooms(T0 + TTL);
    expect(closed.map((room) => room.members.map((member) => member.key))).toStrictEqual([[HOST]]);
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
    expiring.store.expireDueRooms(T0 + TTL);
    expect(expiring.store.negotiationCount).toBe(0);
  });
});
