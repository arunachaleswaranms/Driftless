import type { ErrorCode } from './errors.js';
import type { InviteSecret, ParticipantId, RoomId } from './identifiers.js';

/** The only protocol version this package understands. */
export const PROTOCOL_VERSION = 1;

/**
 * Upper bound, in bytes, on one signaling message. Phase 2A messages are a few
 * hundred bytes; this is an implementation and security bound, not a
 * benchmark-derived limit. It must be revisited when Phase 2B forwards WebRTC
 * negotiation data.
 */
export const MAX_SIGNALING_MESSAGE_BYTES = 4096;

export type ParticipantRole = 'host' | 'guest';

/** Common versioned envelope. Every field is required; no others are allowed. */
export interface Envelope<Type extends string, Payload> {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: Type;
  /** Sender's per-connection sequence number; strictly increasing. */
  readonly sequence: number;
  /** Sender's clock in milliseconds since the Unix epoch. Diagnostic only. */
  readonly sentAt: number;
  readonly payload: Payload;
}

/** A payload with no fields. `{}` is the only valid value. */
export type EmptyPayload = Readonly<Record<string, never>>;

export interface ParticipantSummary<Role extends ParticipantRole = ParticipantRole> {
  readonly participantId: ParticipantId;
  readonly role: Role;
}

// Client → server

export type RoomCreateMessage = Envelope<'ROOM_CREATE', EmptyPayload>;

export type RoomJoinMessage = Envelope<
  'ROOM_JOIN',
  {
    readonly roomId: RoomId;
    readonly inviteSecret: InviteSecret;
  }
>;

export type RoomLeaveMessage = Envelope<'ROOM_LEAVE', EmptyPayload>;

export type ClientMessage = RoomCreateMessage | RoomJoinMessage | RoomLeaveMessage;

// Server → client

/** Sent only to the creating connection, which becomes the host. */
export type RoomCreatedMessage = Envelope<
  'ROOM_CREATED',
  {
    readonly roomId: RoomId;
    readonly inviteSecret: InviteSecret;
    readonly participantId: ParticipantId;
    readonly role: 'host';
    /** Server clock, milliseconds since the Unix epoch. */
    readonly expiresAt: number;
  }
>;

/** Sent only to the joining connection, which becomes the guest. */
export type RoomJoinedMessage = Envelope<
  'ROOM_JOINED',
  {
    readonly roomId: RoomId;
    readonly participantId: ParticipantId;
    readonly role: 'guest';
    readonly peer: ParticipantSummary<'host'>;
    readonly expiresAt: number;
  }
>;

/** Confirms to the leaving connection that its membership ended. */
export type RoomLeftMessage = Envelope<'ROOM_LEFT', EmptyPayload>;

/** Sent to the host when a guest joins. */
export type RoomParticipantJoinedMessage = Envelope<
  'ROOM_PARTICIPANT_JOINED',
  { readonly participant: ParticipantSummary<'guest'> }
>;

export const PARTICIPANT_LEFT_REASONS = ['LEFT', 'DISCONNECTED'] as const;
export type ParticipantLeftReason = (typeof PARTICIPANT_LEFT_REASONS)[number];

/** Sent to the host when the guest leaves or its connection closes. */
export type RoomParticipantLeftMessage = Envelope<
  'ROOM_PARTICIPANT_LEFT',
  {
    readonly participantId: ParticipantId;
    readonly reason: ParticipantLeftReason;
  }
>;

export const ROOM_CLOSED_REASONS = ['EXPIRED', 'HOST_LEFT', 'HOST_DISCONNECTED'] as const;
export type RoomClosedReason = (typeof ROOM_CLOSED_REASONS)[number];

/** Sent to every remaining member when the room ends. Membership has ended. */
export type RoomClosedMessage = Envelope<'ROOM_CLOSED', { readonly reason: RoomClosedReason }>;

export type ErrorMessage = Envelope<
  'ERROR',
  {
    readonly code: ErrorCode;
    readonly message: string;
    /** Whether the client may keep using this connection. */
    readonly recoverable: boolean;
  }
>;

export type ServerMessage =
  | RoomCreatedMessage
  | RoomJoinedMessage
  | RoomLeftMessage
  | RoomParticipantJoinedMessage
  | RoomParticipantLeftMessage
  | RoomClosedMessage
  | ErrorMessage;

export const CLIENT_MESSAGE_TYPES = [
  'ROOM_CREATE',
  'ROOM_JOIN',
  'ROOM_LEAVE',
] as const satisfies readonly ClientMessage['type'][];

export const SERVER_MESSAGE_TYPES = [
  'ROOM_CREATED',
  'ROOM_JOINED',
  'ROOM_LEFT',
  'ROOM_PARTICIPANT_JOINED',
  'ROOM_PARTICIPANT_LEFT',
  'ROOM_CLOSED',
  'ERROR',
] as const satisfies readonly ServerMessage['type'][];

export type ClientMessageType = ClientMessage['type'];
export type ServerMessageType = ServerMessage['type'];
