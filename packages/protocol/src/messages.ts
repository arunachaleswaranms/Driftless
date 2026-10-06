import type { ErrorCode } from './errors.js';
import type {
  MediaSelectionId,
  MediaFingerprint,
  InviteSecret,
  NegotiationId,
  ParticipantId,
  ResumeChallenge,
  ResumeProof,
  ResumeSecret,
  RoomId,
  SessionId,
} from './identifiers.js';
import type { RtcIceServer } from './rtcConfig.js';
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

// Session resume: client → server
//
// A new connection, not in any room, asks to take over the membership of a
// participant whose previous connection was lost. It carries no secret. The
// service always answers with a challenge, whether or not the session and
// participant exist, and the client answers the challenge with a proof that
// it holds the participant's resume secret; see `resumeProofInput`.

/** Asks for a resume challenge for one participant of one room session. */
export type SessionResumeBeginMessage = Envelope<
  'SESSION_RESUME_BEGIN',
  { readonly sessionId: SessionId; readonly participantId: ParticipantId }
>;

/** Answers this connection's pending challenge. */
export type SessionResumeProveMessage = Envelope<
  'SESSION_RESUME_PROVE',
  { readonly challenge: ResumeChallenge; readonly proof: ResumeProof }
>;

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

/**
 * Guest → host. The guest's peer connection for the active negotiation
 * failed; it asks the host for a fresh recovery offer. The guest never offers.
 */
export type RtcRecoveryRequestMessage = Envelope<
  'RTC_RECOVERY_REQUEST',
  { readonly negotiationId: NegotiationId }
>;

/**
 * Host → guest. Replaces the active negotiation `previousNegotiationId` with
 * the fresh negotiation `negotiationId`, for a fresh peer connection, and
 * carries its offer. The previous negotiation is over.
 */
export type RtcRecoverMessage = Envelope<
  'RTC_RECOVER',
  {
    readonly previousNegotiationId: NegotiationId;
    readonly negotiationId: NegotiationId;
    /** Opaque session description text, at most `MAX_SDP_BYTES`. */
    readonly sdp: string;
  }
>;

// ICE server configuration (Phase 2D): client → server → the same client
//
// A connection that carries a room membership asks for the ICE servers to
// use for its next peer connection. The service answers that connection
// only, never another participant, and never a connection outside a room.

/** Asks for the ICE server configuration for this membership. */
export type RtcConfigRequestMessage = Envelope<'RTC_CONFIG_REQUEST', EmptyPayload>;

/**
 * The ICE servers this participant may use until `expiresAt`, on the
 * service's clock. TURN entries carry a short-lived credential derived for
 * this participant; it is used only in memory, for peer connections created
 * before it expires, and is never shown, logged, or persisted.
 */
export type RtcConfigMessage = Envelope<
  'RTC_CONFIG',
  {
    /** Server clock, milliseconds since the Unix epoch. */
    readonly expiresAt: number;
    readonly iceServers: readonly RtcIceServer[];
  }
>;

export type NegotiationMessage =
  | RtcOfferMessage
  | RtcAnswerMessage
  | IceCandidateMessage
  | IceCompleteMessage
  | RtcRecoveryRequestMessage
  | RtcRecoverMessage;

export type ClientMessage =
  | RoomCreateMessage
  | RoomJoinMessage
  | RoomLeaveMessage
  | SessionResumeBeginMessage
  | SessionResumeProveMessage
  | RtcConfigRequestMessage
  | NegotiationMessage;

// Server → client

/** Sent only to the creating connection, which becomes the host. */
export type RoomCreatedMessage = Envelope<
  'ROOM_CREATED',
  {
    readonly roomId: RoomId;
    readonly sessionId: SessionId;
    readonly inviteSecret: InviteSecret;
    /** This participant's own resume credential. Sent once, never again. */
    readonly resumeSecret: ResumeSecret;
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
    readonly sessionId: SessionId;
    /** This participant's own resume credential. Sent once, never again. */
    readonly resumeSecret: ResumeSecret;
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

/**
 * - `LEFT`: the guest sent `ROOM_LEAVE`.
 * - `DISCONNECTED`: the guest's connection ended in a way that is not
 *   resumable: it closed normally, or the service closed it for a policy or
 *   protocol violation.
 * - `RECONNECT_TIMEOUT`: the guest's connection was lost and it did not
 *   resume within the reconnect grace period.
 */
export const PARTICIPANT_LEFT_REASONS = ['LEFT', 'DISCONNECTED', 'RECONNECT_TIMEOUT'] as const;
export type ParticipantLeftReason = (typeof PARTICIPANT_LEFT_REASONS)[number];

/** Sent to the host when the guest's membership ends. */
export type RoomParticipantLeftMessage = Envelope<
  'ROOM_PARTICIPANT_LEFT',
  {
    readonly participantId: ParticipantId;
    readonly reason: ParticipantLeftReason;
  }
>;

/** Room closure reasons; `HOST_*` mirror `ParticipantLeftReason` for the host. */
export const ROOM_CLOSED_REASONS = [
  'EXPIRED',
  'HOST_LEFT',
  'HOST_DISCONNECTED',
  'HOST_RECONNECT_TIMEOUT',
] as const;
export type RoomClosedReason = (typeof ROOM_CLOSED_REASONS)[number];

/** Sent to every remaining member when the room ends. Membership has ended. */
export type RoomClosedMessage = Envelope<'ROOM_CLOSED', { readonly reason: RoomClosedReason }>;

/**
 * A participant's signaling presence: whether the service currently has a
 * connection for it, or is holding its membership while it reconnects.
 */
export const PARTICIPANT_SIGNALING_STATES = ['CONNECTED', 'RECONNECTING'] as const;
export type ParticipantSignalingState = (typeof PARTICIPANT_SIGNALING_STATES)[number];

/**
 * The service's negotiation state for the current guest membership, sent
 * whenever a participant must reconcile with it. `activeNegotiationId` is
 * the latest negotiation the service accepted, whether or not its peer
 * connection still works, and is null exactly when `negotiationCount` is 0.
 * `negotiationCount` counts the negotiations this membership has used, at
 * most `MAX_NEGOTIATIONS_PER_MEMBERSHIP`.
 */
export interface NegotiationSnapshot {
  readonly activeNegotiationId: NegotiationId | null;
  readonly negotiationCount: number;
}

/** The other member as a resume snapshot describes it. */
export interface PeerPresence<
  Role extends ParticipantRole = ParticipantRole,
> extends ParticipantSummary<Role> {
  readonly signaling: ParticipantSignalingState;
}

/**
 * Sent to a participant when the other member's signaling connection is lost
 * (`RECONNECTING`) or resumed (`CONNECTED`), with the service's negotiation
 * state. Presence only: no address, description, candidate, or secret.
 */
export type RoomParticipantConnectionMessage = Envelope<
  'ROOM_PARTICIPANT_CONNECTION',
  NegotiationSnapshot & {
    readonly participantId: ParticipantId;
    readonly signaling: ParticipantSignalingState;
  }
>;

/** Session resume: the challenge for this connection. Reveals nothing about the session. */
export type SessionResumeChallengeMessage = Envelope<
  'SESSION_RESUME_CHALLENGE',
  { readonly challenge: ResumeChallenge }
>;

/**
 * Session resume succeeded: this connection now carries the participant's
 * membership, and this authoritative snapshot is what the client reconciles
 * with. It never carries a secret, description, candidate, or address.
 */
export type SessionResumedMessage = Envelope<
  'SESSION_RESUMED',
  NegotiationSnapshot &
    (
      | {
          readonly sessionId: SessionId;
          readonly roomId: RoomId;
          readonly participantId: ParticipantId;
          readonly role: 'host';
          readonly expiresAt: number;
          /** The guest, or null if there is none. */
          readonly peer: PeerPresence<'guest'> | null;
        }
      | {
          readonly sessionId: SessionId;
          readonly roomId: RoomId;
          readonly participantId: ParticipantId;
          readonly role: 'guest';
          readonly expiresAt: number;
          readonly peer: PeerPresence<'host'>;
        }
    )
>;

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
  | RoomParticipantConnectionMessage
  | SessionResumeChallengeMessage
  | SessionResumedMessage
  | RtcConfigMessage
  | ErrorMessage
  | NegotiationMessage;

export const NEGOTIATION_MESSAGE_TYPES = [
  'RTC_OFFER',
  'RTC_ANSWER',
  'ICE_CANDIDATE',
  'ICE_COMPLETE',
  'RTC_RECOVERY_REQUEST',
  'RTC_RECOVER',
] as const satisfies readonly NegotiationMessage['type'][];

export const CLIENT_MESSAGE_TYPES = [
  'ROOM_CREATE',
  'ROOM_JOIN',
  'ROOM_LEAVE',
  'SESSION_RESUME_BEGIN',
  'SESSION_RESUME_PROVE',
  'RTC_CONFIG_REQUEST',
  ...NEGOTIATION_MESSAGE_TYPES,
] as const satisfies readonly ClientMessage['type'][];

export const SERVER_MESSAGE_TYPES = [
  'ROOM_CREATED',
  'ROOM_JOINED',
  'ROOM_LEFT',
  'ROOM_PARTICIPANT_JOINED',
  'ROOM_PARTICIPANT_LEFT',
  'ROOM_CLOSED',
  'ROOM_PARTICIPANT_CONNECTION',
  'SESSION_RESUME_CHALLENGE',
  'SESSION_RESUMED',
  'RTC_CONFIG',
  'ERROR',
  ...NEGOTIATION_MESSAGE_TYPES,
] as const satisfies readonly ServerMessage['type'][];

export type ClientMessageType = ClientMessage['type'];
export type ServerMessageType = ServerMessage['type'];
export type NegotiationMessageType = NegotiationMessage['type'];

// Peer → peer over the RTCDataChannel
//
// Only a connection handshake is defined on the control channel. The host
// sends PEER_HELLO when its channel opens; the guest answers with its own
// PEER_HELLO and a PEER_READY, and the host answers the guest's PEER_HELLO
// with PEER_READY. Each side thus receives both messages, observing delivery
// in both directions, before it treats the channel as usable. The payload carries only
// identifiers both peers already learned through authenticated signaling,
// binding the handshake to one room session, one negotiation, and both
// participants; it carries no secret, and no credential is ever used here.

/** Label of the single ordered, reliable control channel the host creates. */
export const PEER_CONTROL_CHANNEL_LABEL = 'driftless-control';

/** Upper bound, in UTF-8 bytes, on one peer message. Provisional. */
export const MAX_PEER_MESSAGE_BYTES = 1024;

export interface PeerHandshakePayload {
  /** The room session both participants belong to. */
  readonly sessionId: SessionId;
  readonly negotiationId: NegotiationId;
  /** The sending participant. */
  readonly senderId: ParticipantId;
  /** The participant the sender expects to be talking to. */
  readonly recipientId: ParticipantId;
}

export type PeerHelloMessage = Envelope<'PEER_HELLO', PeerHandshakePayload>;
export type PeerReadyMessage = Envelope<'PEER_READY', PeerHandshakePayload>;
export const MEDIA_FINGERPRINT_VERSION = 1;
export const MEDIA_FINGERPRINT_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_MEDIA_FINGERPRINT_CHUNKS = 4096;
export const MAX_MEDIA_FINGERPRINT_BYTES =
  MEDIA_FINGERPRINT_CHUNK_BYTES * MAX_MEDIA_FINGERPRINT_CHUNKS;
export const NOT_READY_REASONS = [
  'USER',
  'NO_MEDIA',
  'MEDIA_CHANGED',
  'PEER_MEDIA_CHANGED',
  'MEDIA_MISMATCH',
  'LOCAL_MEDIA_ERROR',
  'PLAYBACK_UNAVAILABLE',
] as const;
export type NotReadyReason = (typeof NOT_READY_REASONS)[number];
export interface MediaIdentity {
  readonly selectionId: MediaSelectionId;
  readonly fingerprintVersion: typeof MEDIA_FINGERPRINT_VERSION;
  readonly fingerprint: MediaFingerprint;
  readonly byteLength: number;
}
export interface MediaPair {
  readonly localSelectionId: MediaSelectionId;
  readonly remoteSelectionId: MediaSelectionId;
  readonly fingerprint: MediaFingerprint;
}
export type MediaInfoMessage = Envelope<'MEDIA_INFO', PeerHandshakePayload & MediaIdentity>;
export type MediaMatchMessage = Envelope<'MEDIA_MATCH', PeerHandshakePayload & MediaPair>;
export type MediaMismatchMessage = Envelope<
  'MEDIA_MISMATCH',
  PeerHandshakePayload & {
    readonly localSelectionId: MediaSelectionId;
    readonly remoteSelectionId: MediaSelectionId;
    readonly reason: 'IDENTITY_MISMATCH';
  }
>;
export type ReadyMessage = Envelope<'READY', PeerHandshakePayload & MediaPair>;
export type NotReadyMessage = Envelope<
  'NOT_READY',
  PeerHandshakePayload & {
    readonly localSelectionId: MediaSelectionId | null;
    readonly reason: NotReadyReason;
  }
>;
export interface PlaybackPayload {
  readonly localSelectionId: MediaSelectionId;
  readonly remoteSelectionId: MediaSelectionId;
  readonly revision: number;
  readonly positionMs: number;
}
export type PlaybackMessage =
  | Envelope<'PLAY', PeerHandshakePayload & PlaybackPayload>
  | Envelope<'PAUSE', PeerHandshakePayload & PlaybackPayload>
  | Envelope<'SEEK', PeerHandshakePayload & PlaybackPayload>;
export type PlaybackBody = {
  readonly type: PlaybackMessage['type'];
  readonly payload: PlaybackPayload;
};
export type ApplicationMessage =
  | MediaInfoMessage
  | MediaMatchMessage
  | MediaMismatchMessage
  | ReadyMessage
  | NotReadyMessage
  | PlaybackMessage;
/** Context-free body; the transport supplies the authenticated peer context. */
export type ApplicationBody = ApplicationMessage extends infer Message
  ? Message extends ApplicationMessage
    ? {
        readonly type: Message['type'];
        readonly payload: Omit<Message['payload'], keyof PeerHandshakePayload>;
      }
    : never
  : never;
export type PeerMessage = PeerHelloMessage | PeerReadyMessage | ApplicationMessage;
export type PeerMessageType = PeerMessage['type'];

export const PEER_MESSAGE_TYPES = [
  'PEER_HELLO',
  'PEER_READY',
  'MEDIA_INFO',
  'MEDIA_MATCH',
  'MEDIA_MISMATCH',
  'READY',
  'NOT_READY',
  'PLAY',
  'PAUSE',
  'SEEK',
] as const satisfies readonly PeerMessage['type'][];
