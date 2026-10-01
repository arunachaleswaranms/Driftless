import type { ErrorCode } from './errors.js';
import type { InviteSecret, NegotiationId, ParticipantId, RoomId } from './identifiers.js';
import type { IceCandidate } from './webrtc.js';

/** The only protocol version this package understands. */
export const PROTOCOL_VERSION = 1;

/**
 * Upper bound, in UTF-8 bytes, on one signaling WebSocket message in either
 * direction. Room messages are a few hundred bytes; the bound exists so that
 * a session description of up to `MAX_SDP_BYTES`, JSON-escaped and enveloped,
 * fits. This is a provisional implementation and security bound, not a
 * benchmark-derived limit.
 */
export const MAX_SIGNALING_MESSAGE_BYTES = 32_768;

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

// WebRTC negotiation: client → server → the other participant
//
// The same four messages travel from the sender to the service and from the
// service to the sender's peer, unchanged. They name no destination room or
// participant: the service routes each one from the sender's current room
// membership, so a client cannot address another room. Roles are fixed: the
// host sends the offer and the guest the answer; both send ICE.

export interface SessionDescriptionPayload {
  readonly negotiationId: NegotiationId;
  /** Opaque session description text, at most `MAX_SDP_BYTES`. */
  readonly sdp: string;
}

/** Host → guest. Starts the negotiation identified by `negotiationId`. */
export type RtcOfferMessage = Envelope<'RTC_OFFER', SessionDescriptionPayload>;

/** Guest → host. Answers the active offer. */
export type RtcAnswerMessage = Envelope<'RTC_ANSWER', SessionDescriptionPayload>;

/** Either participant → the other. One trickled ICE candidate. */
export type IceCandidateMessage = Envelope<
  'ICE_CANDIDATE',
  { readonly negotiationId: NegotiationId; readonly candidate: IceCandidate }
>;

/** Either participant → the other. The sender has gathered all its candidates. */
export type IceCompleteMessage = Envelope<
  'ICE_COMPLETE',
  { readonly negotiationId: NegotiationId }
>;

export type NegotiationMessage =
  RtcOfferMessage | RtcAnswerMessage | IceCandidateMessage | IceCompleteMessage;

export type ClientMessage =
  RoomCreateMessage | RoomJoinMessage | RoomLeaveMessage | NegotiationMessage;

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
  | ErrorMessage
  | NegotiationMessage;

export const NEGOTIATION_MESSAGE_TYPES = [
  'RTC_OFFER',
  'RTC_ANSWER',
  'ICE_CANDIDATE',
  'ICE_COMPLETE',
] as const satisfies readonly NegotiationMessage['type'][];

export const CLIENT_MESSAGE_TYPES = [
  'ROOM_CREATE',
  'ROOM_JOIN',
  'ROOM_LEAVE',
  ...NEGOTIATION_MESSAGE_TYPES,
] as const satisfies readonly ClientMessage['type'][];

export const SERVER_MESSAGE_TYPES = [
  'ROOM_CREATED',
  'ROOM_JOINED',
  'ROOM_LEFT',
  'ROOM_PARTICIPANT_JOINED',
  'ROOM_PARTICIPANT_LEFT',
  'ROOM_CLOSED',
  'ERROR',
  ...NEGOTIATION_MESSAGE_TYPES,
] as const satisfies readonly ServerMessage['type'][];

export type ClientMessageType = ClientMessage['type'];
export type ServerMessageType = ServerMessage['type'];
export type NegotiationMessageType = NegotiationMessage['type'];

// Peer → peer over the RTCDataChannel
//
// Phase 2B defines only a connection handshake on the control channel. Each
// peer sends PEER_HELLO when the channel opens and answers the other's valid
// PEER_HELLO with PEER_READY, so each side observes delivery in both
// directions before it treats the channel as usable. The payload carries only
// identifiers both peers already learned through authenticated signaling;
// it carries no secret, and the invite secret is never used here.

/** Label of the single ordered, reliable control channel the host creates. */
export const PEER_CONTROL_CHANNEL_LABEL = 'driftless-control';

/** Upper bound, in UTF-8 bytes, on one peer message. Provisional. */
export const MAX_PEER_MESSAGE_BYTES = 1024;

export interface PeerHandshakePayload {
  readonly negotiationId: NegotiationId;
  /** The sending participant. */
  readonly senderId: ParticipantId;
  /** The participant the sender expects to be talking to. */
  readonly recipientId: ParticipantId;
}

export type PeerHelloMessage = Envelope<'PEER_HELLO', PeerHandshakePayload>;
export type PeerReadyMessage = Envelope<'PEER_READY', PeerHandshakePayload>;
export type PeerMessage = PeerHelloMessage | PeerReadyMessage;
export type PeerMessageType = PeerMessage['type'];

export const PEER_MESSAGE_TYPES = [
  'PEER_HELLO',
  'PEER_READY',
] as const satisfies readonly PeerMessage['type'][];
