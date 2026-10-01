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
  type ParticipantLeftReason,
  type ServerMessage,
} from '@driftless/protocol';
import type { Logger, RejectionDetail } from './logger.js';
import { DEFAULT_RATE_LIMIT, TokenBucket, type RateLimit } from './rateLimiter.js';
import type { LeaveRoomResult, MemberKey, NegotiationStep, RoomStore } from './roomStore.js';

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
 *   IN_ROOM --ROOM_LEAVE / ROOM_CLOSED--> NOT_IN_ROOM
 *   any --transport closed / server close--> CLOSED (terminal)
 */
export type ConnectionState = 'NOT_IN_ROOM' | 'IN_ROOM' | 'CLOSED';

export interface Connection {
  readonly id: number;
  readonly state: ConnectionState;
  /** A text message arrived. */
  receiveText(text: string): void;
  /** A binary message arrived. Signaling never accepts binary data. */
  receiveBinary(): void;
  /** The transport closed, for any reason. */
  transportClosed(code: number): void;
}

/** WebSocket close codes used by the service. */
export const CLOSE_CODES = {
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED_DATA: 1003,
  POLICY_VIOLATION: 1008,
  INTERNAL_ERROR: 1011,
} as const;

/** Invalid messages tolerated per connection before it is closed. */
export const MAX_PROTOCOL_VIOLATIONS = 5;

/** Fixed client-facing text for each error code. Never derived from input. */
export const ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  INVALID_MESSAGE: 'The message is not a valid Driftless signaling message.',
  UNSUPPORTED_PROTOCOL: 'This server supports only Driftless protocol version 1.',
  INVALID_STATE: 'The request is not allowed in the current room state.',
  ROOM_UNAVAILABLE: 'The room is not available.',
  ROOM_FULL: 'The room already has the maximum number of participants.',
  RATE_LIMITED: 'Too many messages were sent.',
  SERVER_ERROR: 'The server could not process the request.',
};

export interface SignalingControllerOptions {
  readonly store: RoomStore;
  readonly logger: Logger;
  /** Wall clock, milliseconds since the Unix epoch. */
  readonly clock: () => number;
  readonly rateLimit?: RateLimit;
  readonly maxViolations?: number;
}

const NEGOTIATION_STEPS: Readonly<Record<NegotiationMessageType, NegotiationStep>> = {
  RTC_OFFER: 'offer',
  RTC_ANSWER: 'answer',
  ICE_CANDIDATE: 'candidate',
  ICE_COMPLETE: 'complete',
};

/** A server message without the envelope fields the controller fills in. */
type ServerBody = ServerMessage extends infer Message
  ? Message extends ServerMessage
    ? Pick<Message, 'type' | 'payload'>
    : never
  : never;

interface ConnectionRecord {
  readonly id: number;
  readonly transport: ConnectionTransport;
  readonly bucket: TokenBucket;
  /** Highest accepted client sequence; -1 before the first message. */
  lastSequence: number;
  nextServerSequence: number;
  violations: number;
  closed: boolean;
}

/**
 * Per-connection signaling session logic: rate limiting, parsing, sequence
 * checks, state rules, room operations, and notifications. It knows nothing
 * about WebSockets; the server adapts sockets to `ConnectionTransport`.
 */
export class SignalingController {
  readonly #store: RoomStore;
  readonly #logger: Logger;
  readonly #clock: () => number;
  readonly #rateLimit: RateLimit;
  readonly #maxViolations: number;
  readonly #connections = new Map<number, ConnectionRecord>();
  #nextId = 1;
  #shutDown = false;

  constructor(options: SignalingControllerOptions) {
    this.#store = options.store;
    this.#logger = options.logger;
    this.#clock = options.clock;
    this.#rateLimit = options.rateLimit ?? DEFAULT_RATE_LIMIT;
    this.#maxViolations = options.maxViolations ?? MAX_PROTOCOL_VIOLATIONS;
  }

  get connectionCount(): number {
    return this.#connections.size;
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
      return this.#store.membershipOf(record.id) === undefined ? 'NOT_IN_ROOM' : 'IN_ROOM';
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
      transportClosed: (code) => {
        this.#release(record);
        this.#logger.log({ event: 'connection_closed', connection: record.id, code });
      },
    };
  }

  /** Closes rooms whose lifetime has ended and tells their members. */
  expireDueRooms(): void {
    for (const room of this.#store.expireDueRooms(this.#clock())) {
      this.#logger.log({ event: 'room_closed', reason: 'EXPIRED' });
      for (const member of room.members) {
        this.#sendTo(member.key, { type: 'ROOM_CLOSED', payload: { reason: 'EXPIRED' } });
      }
    }
  }

  /** Closes every connection, drops all room state, and refuses new connections. */
  shutdown(): void {
    this.#shutDown = true;
    this.#store.clear();
    for (const record of this.#connections.values()) {
      record.closed = true;
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
            inviteSecret: result.inviteSecret,
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
            participantId: result.guest.participantId,
            role: 'guest',
            peer: { participantId: result.host.participantId, role: 'host' },
            expiresAt: result.expiresAt,
          },
        });
        this.#sendTo(result.host.key, {
          type: 'ROOM_PARTICIPANT_JOINED',
          payload: { participant: { participantId: result.guest.participantId, role: 'guest' } },
        });
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
      case 'RTC_OFFER':
      case 'RTC_ANSWER':
      case 'ICE_CANDIDATE':
      case 'ICE_COMPLETE':
        this.#relayNegotiation(record, message);
        return;
    }
  }

  /**
   * Relays one negotiation message to the sender's peer. The room store
   * decides legality and the recipient from the sender's membership alone.
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
    const result = this.#store.negotiate(record.id, step, message.payload.negotiationId);
    if (!result.ok) {
      this.#reject(record, result.code, 'negotiation_request', true);
      return;
    }
    this.#sendTo(result.recipient.key, body);
    if (step !== 'candidate') {
      this.#logger.log({ event: 'negotiation_relayed', connection: record.id, step });
    }
  }

  /** Tells the remaining member, if any, that `key` left or disconnected. */
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
    if (result.guest !== undefined) {
      this.#sendTo(result.guest.key, { type: 'ROOM_CLOSED', payload: { reason: closedReason } });
    }
  }

  /** Ends the connection's membership and forgets it. Idempotent. */
  #release(record: ConnectionRecord): void {
    record.closed = true;
    if (!this.#connections.delete(record.id)) return;
    const result = this.#store.leaveRoom(record.id);
    if (result.ok) this.#announceDeparture(record.id, result, 'DISCONNECTED');
  }

  #terminate(record: ConnectionRecord, code: number, reason: string): void {
    this.#release(record);
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

  #sendTo(key: MemberKey, body: ServerBody): void {
    const record = this.#connections.get(key);
    if (record !== undefined) this.#send(record, body);
  }

  #send(record: ConnectionRecord, body: ServerBody): void {
    const message = withEnvelope(body, record.nextServerSequence++, this.#clock());
    record.transport.send(serializeMessage(message));
  }
}

function withEnvelope(body: ServerBody, sequence: number, sentAt: number): ServerMessage {
  return { protocolVersion: PROTOCOL_VERSION, sequence, sentAt, ...body };
}
