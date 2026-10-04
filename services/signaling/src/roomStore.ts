import {
  MAX_ICE_CANDIDATES_PER_NEGOTIATION,
  MAX_NEGOTIATIONS_PER_MEMBERSHIP,
  type InviteSecret,
  type NegotiationId,
  type NegotiationSnapshot,
  type ParticipantId,
  type ParticipantRole,
  type ResumeChallenge,
  type ResumeProof,
  type ResumeSecret,
  type RoomId,
  type SessionId,
} from '@driftless/protocol';
import {
  cryptoRandom,
  deriveResumeKey,
  digestInviteSecret,
  digestsEqual,
  generateInviteSecret,
  generateParticipantId,
  generateResumeSecret,
  generateRoomId,
  generateSessionId,
  resumeProofMatches,
  type RandomSource,
} from './credentials.js';

/**
 * Opaque key for the connection that currently carries a membership. The
 * signaling controller uses its connection number; the store never sees a
 * socket.
 */
export type MemberKey = number;

/**
 * A snapshot of one stable participant. The participant's identity and role
 * belong to the room membership, not to a connection: `key` names the
 * connection carrying it now, and is undefined while the participant is
 * reconnecting after its connection was lost.
 */
export interface Member {
  readonly participantId: ParticipantId;
  readonly role: ParticipantRole;
  readonly key: MemberKey | undefined;
}

/**
 * One stable participant. It is CONNECTED while `key` is set, RECONNECTING
 * while `key` is undefined and `graceEndsAt` is set, and TERMINAL once it is
 * removed from its room.
 */
interface Participant {
  readonly participantId: ParticipantId;
  readonly role: ParticipantRole;
  /** SHA-256 of the participant's resume secret. The secret itself is not retained. */
  readonly resumeKey: Buffer;
  key: MemberKey | undefined;
  graceEndsAt: number | undefined;
}

/**
 * The legality state of the room's active WebRTC negotiation. It holds
 * counters and flags only: session descriptions and candidates are relayed
 * and dropped, never stored.
 */
interface Negotiation {
  readonly negotiationId: NegotiationId;
  answered: boolean;
  /** Whether the guest has already asked to replace this negotiation. */
  recoveryRequested: boolean;
  readonly candidates: Record<ParticipantRole, number>;
  readonly complete: Record<ParticipantRole, boolean>;
}

interface Room {
  readonly roomId: RoomId;
  readonly sessionId: SessionId;
  /** SHA-256 of the invite secret. The secret itself is not retained. */
  readonly secretDigest: Buffer;
  readonly expiresAt: number;
  readonly host: Participant;
  guest: Participant | undefined;
  /** The latest negotiation for the current guest, whether or not it still works. */
  negotiation: Negotiation | undefined;
  /**
   * Every negotiation ID the current guest membership has used, at most
   * MAX_NEGOTIATIONS_PER_MEMBERSHIP, so that none can be started again.
   */
  usedNegotiationIds: NegotiationId[];
  /** The room's most recent negotiation ID, so that a later guest cannot reuse it. */
  lastNegotiationId: NegotiationId | undefined;
}

/** One negotiation message, by what it does. */
export type NegotiationStep =
  'offer' | 'answer' | 'candidate' | 'complete' | 'recover' | 'recovery_request';

export type NegotiationResult =
  /** The message is legal; relay it to `recipient`, the sender's connected peer. */
  | { readonly ok: true; readonly recipient: Member & { readonly key: MemberKey } }
  | { readonly ok: false; readonly code: 'INVALID_STATE' };

export type CreateRoomResult =
  | {
      readonly ok: true;
      readonly roomId: RoomId;
      readonly sessionId: SessionId;
      /** Returned once, to the creator only. */
      readonly inviteSecret: InviteSecret;
      /** Returned once, to the creator only. */
      readonly resumeSecret: ResumeSecret;
      readonly host: Member;
      readonly expiresAt: number;
    }
  | { readonly ok: false; readonly code: 'INVALID_STATE' | 'SERVER_ERROR' };

export type JoinRoomResult =
  | {
      readonly ok: true;
      readonly roomId: RoomId;
      readonly sessionId: SessionId;
      /** Returned once, to the joining guest only. */
      readonly resumeSecret: ResumeSecret;
      readonly guest: Member;
      readonly host: Member;
      readonly expiresAt: number;
    }
  | { readonly ok: false; readonly code: 'INVALID_STATE' | 'ROOM_UNAVAILABLE' | 'ROOM_FULL' };

export type LeaveRoomResult =
  | { readonly ok: false; readonly code: 'INVALID_STATE' }
  /** The guest's membership ended; the room stays open for the host. */
  | {
      readonly ok: true;
      readonly kind: 'guest_left';
      readonly guest: Member;
      readonly host: Member;
    }
  /** The host's membership ended; the room is closed and its invite is invalid. */
  | {
      readonly ok: true;
      readonly kind: 'room_closed';
      readonly host: Member;
      readonly guest: Member | undefined;
    };

export type ConnectionLostResult =
  | { readonly ok: false }
  /** The membership is held for the reconnect grace period. */
  | {
      readonly ok: true;
      readonly member: Member;
      readonly peer: Member | undefined;
      readonly negotiation: NegotiationSnapshot;
      readonly graceEndsAt: number;
    };

/** The authoritative state a resumed participant reconciles with. */
export interface ResumeSnapshot {
  readonly roomId: RoomId;
  readonly sessionId: SessionId;
  readonly expiresAt: number;
  readonly member: Member;
  readonly peer: Member | undefined;
  readonly negotiation: NegotiationSnapshot;
}

export type ResumeResult =
  | ({ readonly ok: true } & ResumeSnapshot)
  /** The key already carries a membership. */
  | { readonly ok: false; readonly code: 'INVALID_STATE' }
  /** Deliberately one result for every other refusal. */
  | { readonly ok: false; readonly code: 'SESSION_UNAVAILABLE' };

export type ExpiryEvent =
  | {
      readonly kind: 'room_closed';
      readonly reason: 'EXPIRED' | 'HOST_RECONNECT_TIMEOUT';
      /** The members that still have a connection to tell. */
      readonly connected: readonly (Member & { readonly key: MemberKey })[];
    }
  | { readonly kind: 'guest_timed_out'; readonly guest: Member; readonly host: Member };

export interface RoomStoreOptions {
  /** Room lifetime from creation, in milliseconds. */
  readonly roomTtlMs: number;
  /** How long a participant whose connection was lost may resume, in milliseconds. */
  readonly reconnectGraceMs: number;
  /** Rooms held at once, including rooms whose host is reconnecting. */
  readonly maxRooms?: number;
  readonly random?: RandomSource;
}

/** Provisional bound on rooms held at once; matches the connection bound. */
export const DEFAULT_MAX_ROOMS = 256;

const MAX_ID_ATTEMPTS = 4;

/**
 * In-memory, ephemeral store of private two-person rooms. It performs
 * validated domain operations only; parsing, transport, and notification
 * delivery belong to its callers. Nothing is persisted.
 *
 * A room has one host slot and one guest slot, so it can never hold more than
 * the two participants Phase 2 allows. A participant is a stable membership
 * with its own identity, role, and resume key; a connection is only its
 * current binding, and each connection carries at most one membership. When
 * a connection is lost the participant is held, unbound, for the reconnect
 * grace period, and only a connection that proves knowledge of the
 * participant's resume secret may take it over, and only while it is
 * unbound. The host role is never transferred. A room lives until its host
 * leaves, its host's grace ends, or it expires.
 */
export class RoomStore {
  readonly #roomTtlMs: number;
  readonly #reconnectGraceMs: number;
  readonly #maxRooms: number;
  readonly #random: RandomSource;
  readonly #rooms = new Map<RoomId, Room>();
  readonly #sessions = new Map<SessionId, Room>();
  readonly #bindings = new Map<MemberKey, Room>();
  /**
   * Compared against when the requested room or participant does not exist,
   * so missing and wrong credentials take the same comparison path.
   */
  readonly #decoyDigest: Buffer;
  readonly #decoyResumeKey: Buffer;

  constructor(options: RoomStoreOptions) {
    const { roomTtlMs, reconnectGraceMs, maxRooms = DEFAULT_MAX_ROOMS } = options;
    if (!Number.isSafeInteger(roomTtlMs) || roomTtlMs <= 0) {
      throw new RangeError('roomTtlMs must be a positive safe integer');
    }
    if (!Number.isSafeInteger(reconnectGraceMs) || reconnectGraceMs <= 0) {
      throw new RangeError('reconnectGraceMs must be a positive safe integer');
    }
    if (!Number.isSafeInteger(maxRooms) || maxRooms <= 0) {
      throw new RangeError('maxRooms must be a positive safe integer');
    }
    this.#roomTtlMs = roomTtlMs;
    this.#reconnectGraceMs = reconnectGraceMs;
    this.#maxRooms = maxRooms;
    this.#random = options.random ?? cryptoRandom;
    this.#decoyDigest = digestInviteSecret(generateInviteSecret(this.#random));
    this.#decoyResumeKey = deriveResumeKey(generateResumeSecret(this.#random));
  }

  get roomCount(): number {
    return this.#rooms.size;
  }

  /** Participants in every room, connected or reconnecting. */
  get memberCount(): number {
    let count = 0;
    for (const room of this.#rooms.values()) count += room.guest === undefined ? 1 : 2;
    return count;
  }

  /** Participants that currently have a connection. */
  get connectedCount(): number {
    return this.#bindings.size;
  }

  /** Rooms with a negotiation in progress or completed, for tests. */
  get negotiationCount(): number {
    let count = 0;
    for (const room of this.#rooms.values()) if (room.negotiation !== undefined) count += 1;
    return count;
  }

  membershipOf(key: MemberKey): Member | undefined {
    const room = this.#bindings.get(key);
    const participant = room === undefined ? undefined : participantByKey(room, key);
    return participant === undefined ? undefined : member(participant);
  }

  /** The expiry of the room this connection's membership belongs to. */
  roomExpiryOf(key: MemberKey): number | undefined {
    return this.#bindings.get(key)?.expiresAt;
  }

  createRoom(key: MemberKey, now: number): CreateRoomResult {
    if (this.#bindings.has(key)) return { ok: false, code: 'INVALID_STATE' };
    if (this.#rooms.size >= this.#maxRooms) return { ok: false, code: 'SERVER_ERROR' };

    const roomId = this.#uniqueRoomId();
    const sessionId = this.#uniqueSessionId();
    const inviteSecret = generateInviteSecret(this.#random);
    const resumeSecret = generateResumeSecret(this.#random);
    const host: Participant = {
      participantId: generateParticipantId(this.#random),
      role: 'host',
      resumeKey: deriveResumeKey(resumeSecret),
      key,
      graceEndsAt: undefined,
    };
    const room: Room = {
      roomId,
      sessionId,
      secretDigest: digestInviteSecret(inviteSecret),
      expiresAt: now + this.#roomTtlMs,
      host,
      guest: undefined,
      negotiation: undefined,
      usedNegotiationIds: [],
      lastNegotiationId: undefined,
    };
    this.#rooms.set(roomId, room);
    this.#sessions.set(sessionId, room);
    this.#bindings.set(key, room);
    return {
      ok: true,
      roomId,
      sessionId,
      inviteSecret,
      resumeSecret,
      host: member(host),
      expiresAt: room.expiresAt,
    };
  }

  /**
   * Admits `key` as the guest. A missing room, an expired room, and a wrong
   * secret all return ROOM_UNAVAILABLE, so an unauthorized caller learns
   * nothing about which rooms exist. ROOM_FULL is reported only to a caller
   * that presented the correct secret; a guest that is reconnecting still
   * holds its slot.
   */
  joinRoom(
    key: MemberKey,
    roomId: RoomId,
    inviteSecret: InviteSecret,
    now: number,
  ): JoinRoomResult {
    if (this.#bindings.has(key)) return { ok: false, code: 'INVALID_STATE' };

    const room = this.#rooms.get(roomId);
    const presented = digestInviteSecret(inviteSecret);
    const authorized = digestsEqual(presented, room?.secretDigest ?? this.#decoyDigest);
    if (room === undefined || !authorized || now >= room.expiresAt) {
      return { ok: false, code: 'ROOM_UNAVAILABLE' };
    }
    if (room.guest !== undefined) return { ok: false, code: 'ROOM_FULL' };

    const resumeSecret = generateResumeSecret(this.#random);
    const guest: Participant = {
      participantId: this.#guestParticipantId(room),
      role: 'guest',
      resumeKey: deriveResumeKey(resumeSecret),
      key,
      graceEndsAt: undefined,
    };
    room.guest = guest;
    this.#bindings.set(key, room);
    return {
      ok: true,
      roomId,
      sessionId: room.sessionId,
      resumeSecret,
      guest: member(guest),
      host: member(room.host),
      expiresAt: room.expiresAt,
    };
  }

  /**
   * Ends `key`'s membership at once: an intentional leave, a normal close,
   * or a connection closed for a policy violation. None of these is
   * resumable; the participant's resume key is discarded with it.
   */
  leaveRoom(key: MemberKey): LeaveRoomResult {
    const room = this.#bindings.get(key);
    const participant = room === undefined ? undefined : participantByKey(room, key);
    if (room === undefined || participant === undefined)
      return { ok: false, code: 'INVALID_STATE' };
    if (participant.role === 'host') {
      this.#delete(room);
      return {
        ok: true,
        kind: 'room_closed',
        host: member(room.host),
        guest: room.guest === undefined ? undefined : member(room.guest),
      };
    }
    this.#removeGuest(room);
    return { ok: true, kind: 'guest_left', guest: member(participant), host: member(room.host) };
  }

  /**
   * `key`'s connection was lost. The participant keeps its room, identity,
   * role, and slot, unbound, until `now + reconnectGraceMs`; nothing is
   * queued for it meanwhile.
   */
  connectionLost(key: MemberKey, now: number): ConnectionLostResult {
    const room = this.#bindings.get(key);
    const participant = room === undefined ? undefined : participantByKey(room, key);
    if (room === undefined || participant === undefined) return { ok: false };
    this.#bindings.delete(key);
    participant.key = undefined;
    participant.graceEndsAt = now + this.#reconnectGraceMs;
    const peer = participant.role === 'host' ? room.guest : room.host;
    return {
      ok: true,
      member: member(participant),
      peer: peer === undefined ? undefined : member(peer),
      negotiation: negotiationSnapshot(room),
      graceEndsAt: participant.graceEndsAt,
    };
  }

  /**
   * Binds `key` to a reconnecting participant if `proof` answers
   * `challenge` with that participant's resume key. A missing session or
   * participant, a wrong proof, a participant that still has a connection,
   * an ended grace period, and an expired room all return the same
   * SESSION_UNAVAILABLE, after the same proof comparison.
   */
  resume(
    key: MemberKey,
    sessionId: SessionId,
    participantId: ParticipantId,
    challenge: ResumeChallenge,
    proof: ResumeProof,
    now: number,
  ): ResumeResult {
    if (this.#bindings.has(key)) return { ok: false, code: 'INVALID_STATE' };
    const room = this.#sessions.get(sessionId);
    const participant =
      room === undefined
        ? undefined
        : [room.host, room.guest].find((candidate) => candidate?.participantId === participantId);
    const proven = resumeProofMatches(
      participant?.resumeKey ?? this.#decoyResumeKey,
      sessionId,
      participantId,
      challenge,
      proof,
    );
    if (
      room === undefined ||
      participant === undefined ||
      !proven ||
      participant.key !== undefined ||
      participant.graceEndsAt === undefined ||
      now >= participant.graceEndsAt ||
      now >= room.expiresAt
    ) {
      return { ok: false, code: 'SESSION_UNAVAILABLE' };
    }
    participant.key = key;
    participant.graceEndsAt = undefined;
    this.#bindings.set(key, room);
    const peer = participant.role === 'host' ? room.guest : room.host;
    return {
      ok: true,
      roomId: room.roomId,
      sessionId: room.sessionId,
      expiresAt: room.expiresAt,
      member: member(participant),
      peer: peer === undefined ? undefined : member(peer),
      negotiation: negotiationSnapshot(room),
    };
  }

  /** The negotiation snapshot of `key`'s room. */
  negotiationOf(key: MemberKey): NegotiationSnapshot | undefined {
    const room = this.#bindings.get(key);
    return room === undefined ? undefined : negotiationSnapshot(room);
  }

  /**
   * Decides whether `key` may send one negotiation message, and to whom. The
   * room and the recipient come only from `key`'s current membership, and
   * the recipient must be connected: nothing is queued for a participant
   * that is reconnecting. Roles are fixed: only the host offers and
   * recovers, only the guest answers and requests recovery. Every message
   * must name the active negotiation; a recovery names it as the one it
   * replaces and starts a fresh one, within the per-membership bound, with
   * an ID never used before. A legal message updates only counters and
   * flags.
   */
  negotiate(
    key: MemberKey,
    step: NegotiationStep,
    negotiationId: NegotiationId,
    previousNegotiationId?: NegotiationId,
  ): NegotiationResult {
    const refused = { ok: false, code: 'INVALID_STATE' } as const;
    const room = this.#bindings.get(key);
    const guest = room?.guest;
    if (room === undefined || guest === undefined) return refused;
    const sender = room.host.key === key ? room.host : guest;
    const recipient = sender === room.host ? guest : room.host;
    const recipientKey = recipient.key;
    if (recipientKey === undefined) return refused;
    const relay = { ok: true, recipient: { ...member(recipient), key: recipientKey } } as const;
    const negotiation = room.negotiation;
    const fresh =
      !room.usedNegotiationIds.includes(negotiationId) &&
      negotiationId !== room.lastNegotiationId &&
      room.usedNegotiationIds.length < MAX_NEGOTIATIONS_PER_MEMBERSHIP;

    switch (step) {
      case 'offer':
        // The first negotiation of this guest membership.
        if (sender.role !== 'host' || negotiation !== undefined || !fresh) return refused;
        this.#startNegotiation(room, negotiationId);
        return relay;
      case 'recover':
        // Replaces the active negotiation with a fresh one; the old one is over.
        if (
          sender.role !== 'host' ||
          negotiation === undefined ||
          previousNegotiationId !== negotiation.negotiationId ||
          !fresh
        ) {
          return refused;
        }
        this.#startNegotiation(room, negotiationId);
        return relay;
      case 'recovery_request':
        // At most one request per negotiation, and only if a recovery can follow.
        if (
          sender.role !== 'guest' ||
          negotiation?.negotiationId !== negotiationId ||
          negotiation.recoveryRequested ||
          room.usedNegotiationIds.length >= MAX_NEGOTIATIONS_PER_MEMBERSHIP
        ) {
          return refused;
        }
        negotiation.recoveryRequested = true;
        return relay;
      case 'answer':
      case 'candidate':
      case 'complete':
        break;
    }

    if (negotiation?.negotiationId !== negotiationId) return refused;
    if (step === 'answer') {
      if (sender.role !== 'guest' || negotiation.answered) return refused;
      negotiation.answered = true;
      return relay;
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
    return relay;
  }

  /**
   * Applies every deadline due at `now`. Room expiry comes first and
   * overrides any grace period. A host whose grace has ended closes its
   * room; a guest whose grace has ended frees the guest slot.
   */
  expireDue(now: number): ExpiryEvent[] {
    const events: ExpiryEvent[] = [];
    for (const room of this.#rooms.values()) {
      const { host, guest } = room;
      if (now >= room.expiresAt || isGraceOver(host, now)) {
        this.#delete(room);
        events.push({
          kind: 'room_closed',
          reason: now >= room.expiresAt ? 'EXPIRED' : 'HOST_RECONNECT_TIMEOUT',
          connected: [host, guest].flatMap((participant) =>
            participant?.key === undefined
              ? []
              : [{ ...member(participant), key: participant.key }],
          ),
        });
      } else if (guest !== undefined && isGraceOver(guest, now)) {
        this.#removeGuest(room);
        events.push({ kind: 'guest_timed_out', guest: member(guest), host: member(host) });
      }
    }
    return events;
  }

  /** Drops all state, for shutdown. */
  clear(): void {
    this.#rooms.clear();
    this.#sessions.clear();
    this.#bindings.clear();
  }

  #startNegotiation(room: Room, negotiationId: NegotiationId): void {
    room.negotiation = {
      negotiationId,
      answered: false,
      recoveryRequested: false,
      candidates: { host: 0, guest: 0 },
      complete: { host: false, guest: false },
    };
    room.usedNegotiationIds.push(negotiationId);
    room.lastNegotiationId = negotiationId;
  }

  /** Ends the guest's membership; a later guest starts with no negotiation. */
  #removeGuest(room: Room): void {
    const { guest } = room;
    if (guest?.key !== undefined) this.#bindings.delete(guest.key);
    room.guest = undefined;
    room.negotiation = undefined;
    room.usedNegotiationIds = [];
  }

  #delete(room: Room): void {
    this.#rooms.delete(room.roomId);
    this.#sessions.delete(room.sessionId);
    for (const participant of [room.host, room.guest]) {
      if (participant?.key !== undefined) this.#bindings.delete(participant.key);
    }
  }

  #uniqueRoomId(): RoomId {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const roomId = generateRoomId(this.#random);
      if (!this.#rooms.has(roomId)) return roomId;
    }
    throw new Error('Could not generate a unique room ID.');
  }

  #uniqueSessionId(): SessionId {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const sessionId = generateSessionId(this.#random);
      if (!this.#sessions.has(sessionId)) return sessionId;
    }
    throw new Error('Could not generate a unique session ID.');
  }

  #guestParticipantId(room: Room): ParticipantId {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const participantId = generateParticipantId(this.#random);
      if (participantId !== room.host.participantId) return participantId;
    }
    throw new Error('Could not generate a distinct participant ID.');
  }
}

function member(participant: Participant): Member {
  return { participantId: participant.participantId, role: participant.role, key: participant.key };
}

function participantByKey(room: Room, key: MemberKey): Participant | undefined {
  if (room.host.key === key) return room.host;
  return room.guest?.key === key ? room.guest : undefined;
}

function isGraceOver(participant: Participant, now: number): boolean {
  return participant.graceEndsAt !== undefined && now >= participant.graceEndsAt;
}

function negotiationSnapshot(room: Room): NegotiationSnapshot {
  return {
    activeNegotiationId: room.negotiation?.negotiationId ?? null,
    negotiationCount: room.usedNegotiationIds.length,
  };
}
