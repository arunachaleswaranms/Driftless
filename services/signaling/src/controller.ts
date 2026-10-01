import {
  MAX_SIGNALING_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  fitsUtf8Bytes,
  parseClientMessage,
  serializeMessage,
  type ClientMessage,
  type ErrorCode,
  type NegotiationMessage,
  type NegotiationMessageType,
  type NegotiationSnapshot,
  type ParticipantId,
  type ParticipantLeftReason,
  type ParticipantSignalingState,
  type ResumeChallenge,
  type ServerMessage,
  type SessionResumeBeginMessage,
  type SessionResumeProveMessage,
  type SessionId,
} from '@driftless/protocol';
import { cryptoRandom, generateResumeChallenge, type RandomSource } from './credentials.js';
import type { Logger, RejectionDetail } from './logger.js';
import { DEFAULT_RATE_LIMIT, TokenBucket, type RateLimit } from './rateLimiter.js';
import type {
  LeaveRoomResult,
  Member,
  MemberKey,
  NegotiationStep,
  RoomStore,
} from './roomStore.js';

/** What the controller needs from a live transport connection. */
export interface ConnectionTransport {
  send(text: string): void;
  close(code: number, reason: string): void;
}

/**
 * Explicit connection states. IN_ROOM is derived from the room store, which is
 * the single source of truth for membership.
 *
 *   NOT_IN_ROOM --ROOM_CREATE / ROOM_JOIN--> IN_ROOM
 *   NOT_IN_ROOM --SESSION_RESUME_BEGIN--> RESUMING
 *   RESUMING --SESSION_RESUME_PROVE, accepted--> IN_ROOM
 *   RESUMING --SESSION_RESUME_PROVE, refused, or challenge expiry--> NOT_IN_ROOM
 *   IN_ROOM --ROOM_LEAVE / ROOM_CLOSED--> NOT_IN_ROOM
 *   any --transport closed / server close--> CLOSED (terminal)
 */
export type ConnectionState = 'NOT_IN_ROOM' | 'RESUMING' | 'IN_ROOM' | 'CLOSED';

export interface Connection {
  readonly id: number;
  readonly state: ConnectionState;
  /** A text message arrived. */
  receiveText(text: string): void;
  /** A binary message arrived. Signaling never accepts binary data. */
  receiveBinary(): void;
  /**
   * The transport closed, for any reason, with the close code the transport
   * reported. `policyViolation` marks a close the transport itself made
   * because the client broke the WebSocket protocol.
   */
  transportClosed(code: number, policyViolation?: boolean): void;
}

/** WebSocket close codes used by the service. */
export const CLOSE_CODES = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED_DATA: 1003,
  POLICY_VIOLATION: 1008,
  INTERNAL_ERROR: 1011,
} as const;

/** Invalid messages tolerated per connection before it is closed. */
export const MAX_PROTOCOL_VIOLATIONS = 5;

/** How long a resume challenge may be answered. Provisional. */
export const RESUME_CHALLENGE_TTL_MS = 10_000;

/**
 * Whether a closed connection's membership may be resumed. A client that
 * closes with 1000 (normal closure), 1001 (going away: the page closed or
 * navigated), or 1002 (it rejected a message from the service and gave up)
 * ended the connection on purpose; a page that goes away has lost its
 * in-memory resume secret anyway. Its membership ends at once. Every other
 * ending, above all a lost TCP connection (1006), is treated as a transport
 * loss.
 */
export function isResumableClose(code: number): boolean {
  return (
    code !== CLOSE_CODES.NORMAL &&
    code !== CLOSE_CODES.GOING_AWAY &&
    code !== CLOSE_CODES.PROTOCOL_ERROR
  );
}

/** Fixed client-facing text for each error code. Never derived from input. */
export const ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  INVALID_MESSAGE: 'The message is not a valid Driftless signaling message.',
  UNSUPPORTED_PROTOCOL: 'This server supports only Driftless protocol version 1.',
  INVALID_STATE: 'The request is not allowed in the current room state.',
  ROOM_UNAVAILABLE: 'The room is not available.',
  ROOM_FULL: 'The room already has the maximum number of participants.',
  RATE_LIMITED: 'Too many messages were sent.',
  SERVER_ERROR: 'The server could not process the request.',
  SESSION_UNAVAILABLE: 'The room session is not available.',
};

export interface SignalingControllerOptions {
  readonly store: RoomStore;
  readonly logger: Logger;
  /** Wall clock, milliseconds since the Unix epoch. */
  readonly clock: () => number;
  readonly rateLimit?: RateLimit;
  readonly maxViolations?: number;
  /** Source of resume challenges; Node's secure generator by default. */
  readonly random?: RandomSource;
  readonly challengeTtlMs?: number;
}

const NEGOTIATION_STEPS: Readonly<Record<NegotiationMessageType, NegotiationStep>> = {
  RTC_OFFER: 'offer',
  RTC_ANSWER: 'answer',
  ICE_CANDIDATE: 'candidate',
  ICE_COMPLETE: 'complete',
  RTC_RECOVER: 'recover',
  RTC_RECOVERY_REQUEST: 'recovery_request',
};

/** A server message without the envelope fields the controller fills in. */
type ServerBody = ServerMessage extends infer Message
  ? Message extends ServerMessage
    ? Pick<Message, 'type' | 'payload'>
    : never
  : never;

/** A challenge issued to one connection, answerable once, until it expires. */
interface PendingChallenge {
  readonly challenge: ResumeChallenge;
  readonly sessionId: SessionId;
  readonly participantId: ParticipantId;
  readonly expiresAt: number;
}

interface ConnectionRecord {
  readonly id: number;
  readonly transport: ConnectionTransport;
  readonly bucket: TokenBucket;
  /** Highest accepted client sequence; -1 before the first message. */
  lastSequence: number;
  nextServerSequence: number;
  violations: number;
  closed: boolean;
  challenge: PendingChallenge | undefined;
}

/**
 * Per-connection signaling session logic: rate limiting, parsing, sequence
 * checks, state rules, room operations, session resume, and notifications.
 * It knows nothing about WebSockets; the server adapts sockets to
 * `ConnectionTransport`.
 *
 * Sequences belong to one connection. A resumed participant's new connection
 * starts its own sequence space from its first message, but the reset grants
 * nothing: only an accepted resume proof binds the connection to the
 * membership, and nothing sent on or queued for the old connection is
 * replayed.
 */
export class SignalingController {
  readonly #store: RoomStore;
  readonly #logger: Logger;
  readonly #clock: () => number;
  readonly #rateLimit: RateLimit;
  readonly #maxViolations: number;
  readonly #random: RandomSource;
  readonly #challengeTtlMs: number;
  readonly #connections = new Map<number, ConnectionRecord>();
  #nextId = 1;
  #shutDown = false;

  constructor(options: SignalingControllerOptions) {
    this.#store = options.store;
    this.#logger = options.logger;
    this.#clock = options.clock;
    this.#rateLimit = options.rateLimit ?? DEFAULT_RATE_LIMIT;
    this.#maxViolations = options.maxViolations ?? MAX_PROTOCOL_VIOLATIONS;
    this.#random = options.random ?? cryptoRandom;
    this.#challengeTtlMs = options.challengeTtlMs ?? RESUME_CHALLENGE_TTL_MS;
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  /** Resume challenges awaiting an answer, for tests. */
  get pendingChallengeCount(): number {
    let count = 0;
    for (const record of this.#connections.values()) if (record.challenge !== undefined) count += 1;
    return count;
  }

  connect(transport: ConnectionTransport): Connection {
    const record: ConnectionRecord = {
      id: this.#nextId++,
      transport,
      bucket: new TokenBucket(this.#rateLimit, this.#clock()),
      lastSequence: -1,
      nextServerSequence: 0,
      violations: 0,
      closed: this.#shutDown,
      challenge: undefined,
    };
    if (this.#shutDown) {
      // Defense in depth: the server refuses upgrades once stopping begins.
      transport.close(CLOSE_CODES.GOING_AWAY, 'server shutting down');
    } else {
      this.#connections.set(record.id, record);
      this.#logger.log({ event: 'connection_opened', connection: record.id });
    }

    const state = (): ConnectionState => {
      if (record.closed) return 'CLOSED';
      if (this.#store.membershipOf(record.id) !== undefined) return 'IN_ROOM';
      return record.challenge === undefined ? 'NOT_IN_ROOM' : 'RESUMING';
    };
    return {
      id: record.id,
      get state() {
        return state();
      },
      receiveText: (text) => {
        this.#receiveText(record, text);
      },
      receiveBinary: () => {
        this.#receiveBinary(record);
      },
      transportClosed: (code, policyViolation = false) => {
        this.#release(record, !policyViolation && isResumableClose(code));
        this.#logger.log({ event: 'connection_closed', connection: record.id, code });
      },
    };
  }

  /**
   * Applies every deadline due now: room expiry, the end of reconnect grace
   * periods, and resume challenge expiry. Called by one periodic sweep.
   */
  sweep(): void {
    const now = this.#clock();
    for (const event of this.#store.expireDue(now)) {
      if (event.kind === 'room_closed') {
        if (event.reason === 'HOST_RECONNECT_TIMEOUT') {
          this.#logger.log({ event: 'reconnect_timeout', role: 'host' });
        }
        this.#logger.log({ event: 'room_closed', reason: event.reason });
        for (const member of event.connected) {
          this.#sendTo(member.key, { type: 'ROOM_CLOSED', payload: { reason: event.reason } });
        }
      } else {
        this.#logger.log({ event: 'reconnect_timeout', role: 'guest' });
        this.#sendTo(event.host.key, {
          type: 'ROOM_PARTICIPANT_LEFT',
          payload: { participantId: event.guest.participantId, reason: 'RECONNECT_TIMEOUT' },
        });
      }
    }
    for (const record of this.#connections.values()) {
      if (record.challenge !== undefined && now >= record.challenge.expiresAt) {
        record.challenge = undefined;
      }
    }
  }

  /** Closes every connection, drops all room state, and refuses new connections. */
  shutdown(): void {
    this.#shutDown = true;
    this.#store.clear();
    for (const record of this.#connections.values()) {
      record.closed = true;
      record.challenge = undefined;
      record.transport.close(CLOSE_CODES.GOING_AWAY, 'server shutting down');
    }
    this.#connections.clear();
  }

  #receiveText(record: ConnectionRecord, text: string): void {
    if (record.closed || !this.#withinRateLimit(record)) return;

    const parsed = parseClientMessage(text);
    if (!parsed.ok) {
      if (parsed.code === 'UNSUPPORTED_PROTOCOL') {
        this.#reject(record, 'UNSUPPORTED_PROTOCOL', parsed.reason, false);
        this.#terminate(record, CLOSE_CODES.PROTOCOL_ERROR, 'unsupported protocol version');
      } else {
        this.#violation(record, parsed.reason);
      }
      return;
    }

    const { message } = parsed;
    // Sequence orders messages within this connection. It authorizes nothing.
    if (message.sequence <= record.lastSequence) {
      this.#violation(record, 'stale_sequence');
      return;
    }
    record.lastSequence = message.sequence;

    try {
      this.#dispatch(record, message);
    } catch {
      // The exception is not logged or echoed: it could carry request data.
      this.#logger.log({ event: 'internal_error', context: 'dispatch' });
      this.#reject(record, 'SERVER_ERROR', 'room_request', false);
      this.#terminate(record, CLOSE_CODES.INTERNAL_ERROR, 'internal error');
    }
  }

  #receiveBinary(record: ConnectionRecord): void {
    if (record.closed || !this.#withinRateLimit(record)) return;
    this.#reject(record, 'INVALID_MESSAGE', 'binary_message', false);
    this.#terminate(record, CLOSE_CODES.UNSUPPORTED_DATA, 'binary messages are not accepted');
  }

  #withinRateLimit(record: ConnectionRecord): boolean {
    if (record.bucket.tryTake(this.#clock())) return true;
    this.#reject(record, 'RATE_LIMITED', 'rate_limited', false);
    this.#terminate(record, CLOSE_CODES.POLICY_VIOLATION, 'rate limit exceeded');
    return false;
  }

  #violation(record: ConnectionRecord, detail: RejectionDetail): void {
    record.violations += 1;
    if (record.violations < this.#maxViolations) {
      this.#reject(record, 'INVALID_MESSAGE', detail, true);
      return;
    }
    this.#reject(record, 'INVALID_MESSAGE', detail, false);
    this.#logger.log({
      event: 'message_rejected',
      connection: record.id,
      code: 'INVALID_MESSAGE',
      detail: 'violation_limit',
    });
    this.#terminate(record, CLOSE_CODES.POLICY_VIOLATION, 'too many invalid messages');
  }

  #dispatch(record: ConnectionRecord, message: ClientMessage): void {
    const now = this.#clock();
    // A connection that has asked to resume may only answer its challenge.
    if (record.challenge !== undefined && message.type !== 'SESSION_RESUME_PROVE') {
      this.#reject(record, 'INVALID_STATE', 'resume_request', true);
      return;
    }
    switch (message.type) {
      case 'ROOM_CREATE': {
        const result = this.#store.createRoom(record.id, now);
        if (!result.ok) {
          this.#reject(record, result.code, 'room_request', true);
          return;
        }
        this.#send(record, {
          type: 'ROOM_CREATED',
          payload: {
            roomId: result.roomId,
            sessionId: result.sessionId,
            inviteSecret: result.inviteSecret,
            resumeSecret: result.resumeSecret,
            participantId: result.host.participantId,
            role: 'host',
            expiresAt: result.expiresAt,
          },
        });
        this.#logger.log({ event: 'room_created', connection: record.id });
        return;
      }
      case 'ROOM_JOIN': {
        const { roomId, inviteSecret } = message.payload;
        const result = this.#store.joinRoom(record.id, roomId, inviteSecret, now);
        if (!result.ok) {
          this.#reject(record, result.code, 'room_request', true);
          return;
        }
        this.#send(record, {
          type: 'ROOM_JOINED',
          payload: {
            roomId: result.roomId,
            sessionId: result.sessionId,
            resumeSecret: result.resumeSecret,
            participantId: result.guest.participantId,
            role: 'guest',
            peer: { participantId: result.host.participantId, role: 'host' },
            expiresAt: result.expiresAt,
          },
        });
        if (result.host.key === undefined) {
          // The host is reconnecting: it learns of the guest when it resumes.
          this.#send(
            record,
            presence(result.host.participantId, 'RECONNECTING', {
              activeNegotiationId: null,
              negotiationCount: 0,
            }),
          );
        } else {
          this.#sendTo(result.host.key, {
            type: 'ROOM_PARTICIPANT_JOINED',
            payload: { participant: { participantId: result.guest.participantId, role: 'guest' } },
          });
        }
        this.#logger.log({ event: 'participant_joined', connection: record.id });
        return;
      }
      case 'ROOM_LEAVE': {
        const result = this.#store.leaveRoom(record.id);
        if (!result.ok) {
          this.#reject(record, result.code, 'room_request', true);
          return;
        }
        this.#send(record, { type: 'ROOM_LEFT', payload: {} });
        this.#announceDeparture(record.id, result, 'LEFT');
        return;
      }
      case 'SESSION_RESUME_BEGIN':
        this.#beginResume(record, message, now);
        return;
      case 'SESSION_RESUME_PROVE':
        this.#proveResume(record, message, now);
        return;
      case 'RTC_OFFER':
      case 'RTC_ANSWER':
      case 'ICE_CANDIDATE':
      case 'ICE_COMPLETE':
      case 'RTC_RECOVER':
      case 'RTC_RECOVERY_REQUEST':
        this.#relayNegotiation(record, message);
        return;
    }
  }

  /**
   * Issues a one-time challenge bound to this connection. The answer is the
   * same whether or not the session and participant exist, so it reveals
   * nothing about either.
   */
  #beginResume(record: ConnectionRecord, message: SessionResumeBeginMessage, now: number): void {
    if (this.#store.membershipOf(record.id) !== undefined) {
      this.#reject(record, 'INVALID_STATE', 'resume_request', true);
      return;
    }
    const challenge = generateResumeChallenge(this.#random);
    record.challenge = {
      challenge,
      sessionId: message.payload.sessionId,
      participantId: message.payload.participantId,
      expiresAt: now + this.#challengeTtlMs,
    };
    this.#send(record, { type: 'SESSION_RESUME_CHALLENGE', payload: { challenge } });
    this.#logger.log({ event: 'resume_challenge_issued', connection: record.id });
  }

  /**
   * Checks the proof against this connection's pending challenge, which is
   * consumed whatever the outcome. On success the connection carries the
   * participant's membership and receives the authoritative snapshot; the
   * peer, if connected, learns that the participant's signaling is back.
   */
  #proveResume(record: ConnectionRecord, message: SessionResumeProveMessage, now: number): void {
    const pending = record.challenge;
    record.challenge = undefined;
    if (pending === undefined || this.#store.membershipOf(record.id) !== undefined) {
      this.#reject(record, 'INVALID_STATE', 'resume_request', true);
      return;
    }
    const result =
      message.payload.challenge === pending.challenge && now < pending.expiresAt
        ? this.#store.resume(
            record.id,
            pending.sessionId,
            pending.participantId,
            pending.challenge,
            message.payload.proof,
            now,
          )
        : undefined;
    if (result?.ok !== true) {
      // One answer for every refusal: an unknown session or participant, a
      // wrong or stale proof, a participant that is still connected, an
      // ended grace period, and an expired room.
      this.#logger.log({ event: 'resume_rejected', connection: record.id });
      this.#send(record, {
        type: 'ERROR',
        payload: {
          code: 'SESSION_UNAVAILABLE',
          message: ERROR_MESSAGES.SESSION_UNAVAILABLE,
          recoverable: true,
        },
      });
      return;
    }
    const { member, peer, negotiation } = result;
    const common = {
      sessionId: result.sessionId,
      roomId: result.roomId,
      participantId: member.participantId,
      expiresAt: result.expiresAt,
      ...negotiation,
    };
    if (member.role === 'host') {
      this.#send(record, {
        type: 'SESSION_RESUMED',
        payload: {
          ...common,
          role: 'host',
          peer: peer === undefined ? null : peerPresence(peer, 'guest'),
        },
      });
    } else {
      if (peer === undefined) throw new Error('A guest membership without a host.');
      this.#send(record, {
        type: 'SESSION_RESUMED',
        payload: { ...common, role: 'guest', peer: peerPresence(peer, 'host') },
      });
    }
    this.#logger.log({ event: 'participant_resumed', connection: record.id });
    if (peer?.key !== undefined) {
      this.#sendTo(peer.key, presence(member.participantId, 'CONNECTED', negotiation));
    }
  }

  /**
   * Relays one negotiation message to the sender's peer. The room store
   * decides legality and the recipient from the sender's membership alone,
   * and refuses it while the recipient is reconnecting: nothing is queued.
   * The relayed message is rebuilt from the validated payload, and neither
   * the session description nor the candidate is retained or logged.
   */
  #relayNegotiation(record: ConnectionRecord, message: NegotiationMessage): void {
    const body = { type: message.type, payload: message.payload } as ServerBody;
    // The relay carries the service's own envelope, which may be longer than
    // the sender's. Refuse a message whose relay could exceed the bound
    // before any state changes, so the recipient never receives one its
    // parser must reject.
    if (
      !fitsUtf8Bytes(
        serializeMessage(withEnvelope(body, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)),
        MAX_SIGNALING_MESSAGE_BYTES,
      )
    ) {
      this.#violation(record, 'relay_too_large');
      return;
    }
    const step = NEGOTIATION_STEPS[message.type];
    const previous =
      message.type === 'RTC_RECOVER' ? message.payload.previousNegotiationId : undefined;
    const result = this.#store.negotiate(record.id, step, message.payload.negotiationId, previous);
    if (!result.ok) {
      this.#reject(record, result.code, 'negotiation_request', true);
      return;
    }
    this.#sendTo(result.recipient.key, body);
    if (step !== 'candidate') {
      this.#logger.log({ event: 'negotiation_relayed', connection: record.id, step });
    }
  }

  /** Tells the remaining member, if connected, that `key`'s membership ended. */
  #announceDeparture(
    key: MemberKey,
    result: Extract<LeaveRoomResult, { ok: true }>,
    reason: ParticipantLeftReason,
  ): void {
    this.#logger.log({ event: 'participant_left', connection: key, reason });
    if (result.kind === 'guest_left') {
      this.#sendTo(result.host.key, {
        type: 'ROOM_PARTICIPANT_LEFT',
        payload: { participantId: result.guest.participantId, reason },
      });
      return;
    }
    // The host is gone: the room closes. The guest is not promoted.
    const closedReason = reason === 'LEFT' ? 'HOST_LEFT' : 'HOST_DISCONNECTED';
    this.#logger.log({ event: 'room_closed', reason: closedReason });
    this.#sendTo(result.guest?.key, { type: 'ROOM_CLOSED', payload: { reason: closedReason } });
  }

  /**
   * Forgets the connection. A resumable loss holds its membership for the
   * reconnect grace period and tells the peer; any other ending ends the
   * membership at once. Idempotent.
   */
  #release(record: ConnectionRecord, resumable: boolean): void {
    record.closed = true;
    record.challenge = undefined;
    if (!this.#connections.delete(record.id)) return;
    if (resumable) {
      const lost = this.#store.connectionLost(record.id, this.#clock());
      if (!lost.ok) return;
      this.#logger.log({ event: 'participant_disconnected', connection: record.id });
      this.#sendTo(
        lost.peer?.key,
        presence(lost.member.participantId, 'RECONNECTING', lost.negotiation),
      );
      return;
    }
    const result = this.#store.leaveRoom(record.id);
    if (result.ok) this.#announceDeparture(record.id, result, 'DISCONNECTED');
  }

  /**
   * Closes the connection for a policy or protocol violation. Its
   * membership ends at once: such a close is never resumable, so the same
   * participant cannot return through a resume to bypass the enforcement.
   */
  #terminate(record: ConnectionRecord, code: number, reason: string): void {
    this.#release(record, false);
    record.transport.close(code, reason);
  }

  #reject(
    record: ConnectionRecord,
    code: ErrorCode,
    detail: RejectionDetail,
    recoverable: boolean,
  ): void {
    this.#logger.log({ event: 'message_rejected', connection: record.id, code, detail });
    this.#send(record, {
      type: 'ERROR',
      payload: { code, message: ERROR_MESSAGES[code], recoverable },
    });
  }

  #sendTo(key: MemberKey | undefined, body: ServerBody): void {
    const record = key === undefined ? undefined : this.#connections.get(key);
    if (record !== undefined) this.#send(record, body);
  }

  #send(record: ConnectionRecord, body: ServerBody): void {
    const message = withEnvelope(body, record.nextServerSequence++, this.#clock());
    record.transport.send(serializeMessage(message));
  }
}

function presence(
  participantId: ParticipantId,
  signaling: ParticipantSignalingState,
  negotiation: NegotiationSnapshot,
): ServerBody {
  return {
    type: 'ROOM_PARTICIPANT_CONNECTION',
    payload: { participantId, signaling, ...negotiation },
  };
}

function peerPresence<Role extends 'host' | 'guest'>(peer: Member, role: Role) {
  return {
    participantId: peer.participantId,
    role,
    signaling: peer.key === undefined ? 'RECONNECTING' : 'CONNECTED',
  } as const;
}

function withEnvelope(body: ServerBody, sequence: number, sentAt: number): ServerMessage {
  return { protocolVersion: PROTOCOL_VERSION, sequence, sentAt, ...body };
}
