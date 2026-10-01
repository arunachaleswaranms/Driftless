import {
  MAX_ICE_CANDIDATES_PER_NEGOTIATION,
  type InviteSecret,
  type NegotiationId,
  type ParticipantId,
  type ParticipantRole,
  type RoomId,
} from '@driftless/protocol';
import {
  cryptoRandom,
  digestInviteSecret,
  digestsEqual,
  generateInviteSecret,
  generateParticipantId,
  generateRoomId,
  type RandomSource,
} from './credentials.js';

/**
 * Opaque key for the party that owns a membership. The signaling controller
 * uses its connection number; the store never sees a socket.
 */
export type MemberKey = number;

export interface Member {
  readonly key: MemberKey;
  readonly participantId: ParticipantId;
  readonly role: ParticipantRole;
}

/**
 * The legality state of the room's one WebRTC negotiation. It holds counters
 * and flags only: session descriptions and candidates are relayed and
 * dropped, never stored.
 */
interface Negotiation {
  readonly negotiationId: NegotiationId;
  answered: boolean;
  readonly candidates: Record<ParticipantRole, number>;
  readonly complete: Record<ParticipantRole, boolean>;
}

interface Room {
  readonly roomId: RoomId;
  /** SHA-256 of the invite secret. The secret itself is not retained. */
  readonly secretDigest: Buffer;
  readonly expiresAt: number;
  readonly host: Member;
  guest: Member | undefined;
  /** The negotiation between the host and the current guest, if started. */
  negotiation: Negotiation | undefined;
  /** The most recent negotiation ID, so that it can never be started again. */
  lastNegotiationId: NegotiationId | undefined;
}

/** One negotiation message, by what it does. */
export type NegotiationStep = 'offer' | 'answer' | 'candidate' | 'complete';

export type NegotiationResult =
  /** The message is legal; relay it to `recipient`, the sender's peer. */
  | { readonly ok: true; readonly recipient: Member }
  | { readonly ok: false; readonly code: 'INVALID_STATE' };

export type CreateRoomResult =
  | {
      readonly ok: true;
      readonly roomId: RoomId;
      /** Returned once, to the creator only. */
      readonly inviteSecret: InviteSecret;
      readonly host: Member;
      readonly expiresAt: number;
    }
  | { readonly ok: false; readonly code: 'INVALID_STATE' };

export type JoinRoomResult =
  | {
      readonly ok: true;
      readonly roomId: RoomId;
      readonly guest: Member;
      readonly host: Member;
      readonly expiresAt: number;
    }
  | { readonly ok: false; readonly code: 'INVALID_STATE' | 'ROOM_UNAVAILABLE' | 'ROOM_FULL' };

export type LeaveRoomResult =
  | { readonly ok: false; readonly code: 'INVALID_STATE' }
  /** The guest left; the room stays open for the host. */
  | {
      readonly ok: true;
      readonly kind: 'guest_left';
      readonly guest: Member;
      readonly host: Member;
    }
  /** The host left; the room is closed and its invite is invalid. */
  | {
      readonly ok: true;
      readonly kind: 'room_closed';
      readonly host: Member;
      readonly guest: Member | undefined;
    };

export interface ClosedRoom {
  readonly members: readonly Member[];
}

export interface RoomStoreOptions {
  /** Room lifetime from creation, in milliseconds. */
  readonly roomTtlMs: number;
  readonly random?: RandomSource;
}

const MAX_ID_ATTEMPTS = 4;

/**
 * In-memory, ephemeral store of private two-person rooms. It performs
 * validated domain operations only; parsing, transport, and notification
 * delivery belong to its callers. Nothing is persisted.
 *
 * A room has one host slot and one guest slot, so it can never hold more than
 * the two active participants Phase 2 allows. Each member key belongs to at
 * most one room. A room lives until its host
 * leaves or disconnects, or until it expires; the guest's departure frees the
 * guest slot but does not close the room. The host role is never transferred.
 */
export class RoomStore {
  readonly #roomTtlMs: number;
  readonly #random: RandomSource;
  readonly #rooms = new Map<RoomId, Room>();
  readonly #memberships = new Map<MemberKey, RoomId>();
  /**
   * Compared against when the requested room does not exist, so a missing
   * room and a wrong secret take the same comparison path.
   */
  readonly #decoyDigest: Buffer;

  constructor(options: RoomStoreOptions) {
    const { roomTtlMs } = options;
    if (!Number.isSafeInteger(roomTtlMs) || roomTtlMs <= 0) {
      throw new RangeError('roomTtlMs must be a positive safe integer');
    }
    this.#roomTtlMs = roomTtlMs;
    this.#random = options.random ?? cryptoRandom;
    this.#decoyDigest = digestInviteSecret(generateInviteSecret(this.#random));
  }

  get roomCount(): number {
    return this.#rooms.size;
  }

  get memberCount(): number {
    return this.#memberships.size;
  }

  /** Rooms with a negotiation in progress or completed, for tests. */
  get negotiationCount(): number {
    let count = 0;
    for (const room of this.#rooms.values()) if (room.negotiation !== undefined) count += 1;
    return count;
  }

  membershipOf(key: MemberKey): Member | undefined {
    const room = this.#roomOf(key);
    if (room === undefined) return undefined;
    return room.host.key === key ? room.host : room.guest;
  }

  createRoom(key: MemberKey, now: number): CreateRoomResult {
    if (this.#memberships.has(key)) return { ok: false, code: 'INVALID_STATE' };

    const roomId = this.#uniqueRoomId();
    const inviteSecret = generateInviteSecret(this.#random);
    const host: Member = { key, participantId: generateParticipantId(this.#random), role: 'host' };
    const room: Room = {
      roomId,
      secretDigest: digestInviteSecret(inviteSecret),
      expiresAt: now + this.#roomTtlMs,
      host,
      guest: undefined,
      negotiation: undefined,
      lastNegotiationId: undefined,
    };
    this.#rooms.set(roomId, room);
    this.#memberships.set(key, roomId);
    return { ok: true, roomId, inviteSecret, host, expiresAt: room.expiresAt };
  }

  /**
   * Admits `key` as the guest. A missing room, an expired room, and a wrong
   * secret all return ROOM_UNAVAILABLE, so an unauthorized caller learns
   * nothing about which rooms exist. ROOM_FULL is reported only to a caller
   * that presented the correct secret.
   */
  joinRoom(
    key: MemberKey,
    roomId: RoomId,
    inviteSecret: InviteSecret,
    now: number,
  ): JoinRoomResult {
    if (this.#memberships.has(key)) return { ok: false, code: 'INVALID_STATE' };

    const room = this.#rooms.get(roomId);
    const presented = digestInviteSecret(inviteSecret);
    const authorized = digestsEqual(presented, room?.secretDigest ?? this.#decoyDigest);
    if (room === undefined || !authorized || now >= room.expiresAt) {
      return { ok: false, code: 'ROOM_UNAVAILABLE' };
    }
    if (room.guest !== undefined) return { ok: false, code: 'ROOM_FULL' };

    const guest: Member = { key, participantId: this.#guestParticipantId(room), role: 'guest' };
    room.guest = guest;
    this.#memberships.set(key, roomId);
    return { ok: true, roomId, guest, host: room.host, expiresAt: room.expiresAt };
  }

  /**
   * Ends `key`'s membership. An intentional leave and a closed connection have
   * the same effect; callers distinguish them only in notifications.
   */
  leaveRoom(key: MemberKey): LeaveRoomResult {
    const room = this.#roomOf(key);
    if (room === undefined) return { ok: false, code: 'INVALID_STATE' };

    if (room.host.key === key) {
      this.#delete(room);
      return { ok: true, kind: 'room_closed', host: room.host, guest: room.guest };
    }
    const guest = room.guest;
    if (guest === undefined) throw new Error('Membership refers to an empty guest slot.');
    room.guest = undefined;
    // The negotiation belonged to this guest; a later guest starts afresh.
    room.negotiation = undefined;
    this.#memberships.delete(key);
    return { ok: true, kind: 'guest_left', guest, host: room.host };
  }

  /**
   * Decides whether `key` may send one negotiation message, and to whom. The
   * room and the recipient come only from `key`'s current membership, and
   * the roles are fixed: only the host offers, only the guest answers, and
   * each room has at most one negotiation per guest. Every message must name
   * the active negotiation, so a stale or foreign negotiation ID is refused.
   * A legal message updates only counters and flags.
   */
  negotiate(
    key: MemberKey,
    step: NegotiationStep,
    negotiationId: NegotiationId,
  ): NegotiationResult {
    const refused = { ok: false, code: 'INVALID_STATE' } as const;
    const room = this.#roomOf(key);
    const guest = room?.guest;
    if (room === undefined || guest === undefined) return refused;
    const sender = room.host.key === key ? room.host : guest;
    const recipient = sender === room.host ? guest : room.host;

    if (step === 'offer') {
      // No renegotiation: one offer per guest, and never a reused ID.
      if (
        sender.role !== 'host' ||
        room.negotiation !== undefined ||
        negotiationId === room.lastNegotiationId
      ) {
        return refused;
      }
      room.negotiation = {
        negotiationId,
        answered: false,
        candidates: { host: 0, guest: 0 },
        complete: { host: false, guest: false },
      };
      room.lastNegotiationId = negotiationId;
      return { ok: true, recipient };
    }

    const negotiation = room.negotiation;
    if (negotiation?.negotiationId !== negotiationId) return refused;
    if (step === 'answer') {
      if (sender.role !== 'guest' || negotiation.answered) return refused;
      negotiation.answered = true;
      return { ok: true, recipient };
    }
    // The guest gathers candidates only for its answer.
    const { role } = sender;
    if ((role === 'guest' && !negotiation.answered) || negotiation.complete[role]) return refused;
    if (step === 'candidate') {
      if (negotiation.candidates[role] >= MAX_ICE_CANDIDATES_PER_NEGOTIATION) return refused;
      negotiation.candidates[role] += 1;
    } else {
      negotiation.complete[role] = true;
    }
    return { ok: true, recipient };
  }

  /** Removes every room whose lifetime has ended at `now`. */
  expireDueRooms(now: number): ClosedRoom[] {
    const closed: ClosedRoom[] = [];
    for (const room of this.#rooms.values()) {
      if (now < room.expiresAt) continue;
      this.#delete(room);
      closed.push({ members: room.guest === undefined ? [room.host] : [room.host, room.guest] });
    }
    return closed;
  }

  /** Drops all state, for shutdown. */
  clear(): void {
    this.#rooms.clear();
    this.#memberships.clear();
  }

  #roomOf(key: MemberKey): Room | undefined {
    const roomId = this.#memberships.get(key);
    return roomId === undefined ? undefined : this.#rooms.get(roomId);
  }

  #delete(room: Room): void {
    this.#rooms.delete(room.roomId);
    this.#memberships.delete(room.host.key);
    if (room.guest !== undefined) this.#memberships.delete(room.guest.key);
  }

  #uniqueRoomId(): RoomId {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const roomId = generateRoomId(this.#random);
      if (!this.#rooms.has(roomId)) return roomId;
    }
    throw new Error('Could not generate a unique room ID.');
  }

  #guestParticipantId(room: Room): ParticipantId {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const participantId = generateParticipantId(this.#random);
      if (participantId !== room.host.participantId) return participantId;
    }
    throw new Error('Could not generate a distinct participant ID.');
  }
}
