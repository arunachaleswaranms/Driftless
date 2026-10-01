import { fitsUtf8Bytes } from './encoding.js';
import { isErrorCode, MAX_ERROR_MESSAGE_LENGTH } from './errors.js';
import { isInviteSecret, isNegotiationId, isParticipantId, isRoomId } from './identifiers.js';
import {
  MAX_PEER_MESSAGE_BYTES,
  MAX_SIGNALING_MESSAGE_BYTES,
  PARTICIPANT_LEFT_REASONS,
  PROTOCOL_VERSION,
  ROOM_CLOSED_REASONS,
  type ClientMessage,
  type EmptyPayload,
  type ErrorMessage,
  type IceCandidateMessage,
  type IceCompleteMessage,
  type NegotiationMessage,
  type ParticipantRole,
  type ParticipantSummary,
  type RoomClosedMessage,
  type RoomCreatedMessage,
  type RoomJoinedMessage,
  type RoomJoinMessage,
  type RoomParticipantJoinedMessage,
  type RoomParticipantLeftMessage,
  type PeerHandshakePayload,
  type PeerMessage,
  type ServerMessage,
  type SessionDescriptionPayload,
} from './messages.js';
import { isSessionDescription, toIceCandidate } from './webrtc.js';

/**
 * Why a message was rejected. Every value is a fixed token, so it is safe to
 * log; none of them carries any part of the rejected input.
 */
export type ParseFailureReason =
  | 'too_large'
  | 'invalid_json'
  | 'not_object'
  | 'unsupported_version'
  | 'missing_field'
  | 'unknown_field'
  | 'invalid_version'
  | 'unknown_type'
  | 'invalid_sequence'
  | 'invalid_sent_at'
  | 'invalid_payload';

export interface ParseFailure {
  readonly ok: false;
  readonly code: 'INVALID_MESSAGE' | 'UNSUPPORTED_PROTOCOL';
  readonly reason: ParseFailureReason;
}

export interface ParseSuccess<Message> {
  readonly ok: true;
  readonly message: Message;
}

export type ParseResult<Message> = ParseSuccess<Message> | ParseFailure;

const ENVELOPE_KEYS = ['protocolVersion', 'type', 'sequence', 'sentAt', 'payload'] as const;

type JsonObject = Readonly<Record<string, unknown>>;

/** A payload decoder returns the validated payload, or undefined. */
type PayloadDecoder<Payload> = (value: unknown) => Payload | undefined;

type PayloadOf<Message extends { type: string; payload: unknown }, Type> = Extract<
  Message,
  { type: Type }
>['payload'];

type DecoderTable<Message extends { type: string; payload: unknown }> = {
  readonly [Type in Message['type']]: PayloadDecoder<PayloadOf<Message, Type>>;
};

/**
 * Parses one untrusted client → server signaling message. Never throws; any
 * input that is not exactly a valid client message, or that exceeds
 * `MAX_SIGNALING_MESSAGE_BYTES` of UTF-8, is rejected.
 */
export function parseClientMessage(text: string): ParseResult<ClientMessage> {
  return parseMessage(text, MAX_SIGNALING_MESSAGE_BYTES, CLIENT_DECODERS);
}

/**
 * Parses one untrusted server → client signaling message. Never throws; any
 * input that is not exactly a valid server message, or that exceeds
 * `MAX_SIGNALING_MESSAGE_BYTES` of UTF-8, is rejected.
 */
export function parseServerMessage(text: string): ParseResult<ServerMessage> {
  return parseMessage(text, MAX_SIGNALING_MESSAGE_BYTES, SERVER_DECODERS);
}

/**
 * Parses one untrusted peer → peer data-channel message. Never throws; any
 * input that is not exactly a valid peer message, or that exceeds
 * `MAX_PEER_MESSAGE_BYTES` of UTF-8, is rejected.
 */
export function parsePeerMessage(text: string): ParseResult<PeerMessage> {
  return parseMessage(text, MAX_PEER_MESSAGE_BYTES, PEER_DECODERS);
}

/** Serializes a message. Only the envelope fields are written. */
export function serializeMessage(message: ClientMessage | ServerMessage | PeerMessage): string {
  return JSON.stringify({
    protocolVersion: message.protocolVersion,
    type: message.type,
    sequence: message.sequence,
    sentAt: message.sentAt,
    payload: message.payload,
  });
}

function parseMessage<Message extends { type: string; payload: unknown }>(
  text: string,
  maxBytes: number,
  decoders: DecoderTable<Message>,
): ParseResult<Message> {
  // The bound is on encoded bytes, as the transport carries them, so a
  // string of multi-byte characters cannot exceed it.
  if (!fitsUtf8Bytes(text, maxBytes)) return failure('too_large');

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // The parser's own message is deliberately discarded.
    return failure('invalid_json');
  }
  if (!isJsonObject(value)) return failure('not_object');

  // Check the version before the field set: a different version may define a
  // different envelope, and it must be reported as unsupported, not malformed.
  if (!Object.hasOwn(value, 'protocolVersion')) return failure('missing_field');
  const version = value.protocolVersion;
  if (version !== PROTOCOL_VERSION) {
    return isWireInteger(version)
      ? { ok: false, code: 'UNSUPPORTED_PROTOCOL', reason: 'unsupported_version' }
      : failure('invalid_version');
  }

  const shape = checkKeys(value, ENVELOPE_KEYS);
  if (shape !== undefined) return failure(shape);

  const type = value.type;
  if (typeof type !== 'string' || !Object.hasOwn(decoders, type)) return failure('unknown_type');
  if (!isWireInteger(value.sequence)) return failure('invalid_sequence');
  if (!isWireInteger(value.sentAt)) return failure('invalid_sent_at');

  const decode = decoders[type as Message['type']];
  const payload = decode(value.payload);
  if (payload === undefined) return failure('invalid_payload');

  // Build the result from validated values only; nothing from the parsed
  // object is merged or spread into it.
  const message = {
    protocolVersion: PROTOCOL_VERSION,
    type,
    sequence: value.sequence,
    sentAt: value.sentAt,
    payload,
  };
  return { ok: true, message: message as unknown as Message };
}

function failure(reason: ParseFailureReason): ParseFailure {
  return { ok: false, code: 'INVALID_MESSAGE', reason };
}

/** A plain JSON object: not null, not an array, not a class instance. */
function isJsonObject(value: unknown): value is JsonObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Requires exactly the given own keys. JSON.parse creates keys such as
 * `__proto__` and `constructor` as ordinary own properties, so they are
 * rejected here as unknown fields.
 */
function checkKeys(
  value: JsonObject,
  keys: readonly string[],
): 'missing_field' | 'unknown_field' | undefined {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) return 'unknown_field';
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) return 'missing_field';
  }
  return undefined;
}

function exactObject(value: unknown, keys: readonly string[]): JsonObject | undefined {
  return isJsonObject(value) && checkKeys(value, keys) === undefined ? value : undefined;
}

/** A finite, non-negative safe integer. */
function isWireInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isOneOf<Value extends string>(value: unknown, allowed: readonly Value[]): value is Value {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function decodeEmpty(value: unknown): EmptyPayload | undefined {
  return exactObject(value, []) === undefined ? undefined : {};
}

function decodeParticipant<Role extends ParticipantRole>(
  value: unknown,
  role: Role,
): ParticipantSummary<Role> | undefined {
  const object = exactObject(value, ['participantId', 'role']);
  if (object === undefined) return undefined;
  const { participantId } = object;
  if (!isParticipantId(participantId) || object.role !== role) return undefined;
  return { participantId, role };
}

function decodeSessionDescription(value: unknown): SessionDescriptionPayload | undefined {
  const object = exactObject(value, ['negotiationId', 'sdp']);
  if (object === undefined) return undefined;
  const { negotiationId, sdp } = object;
  if (!isNegotiationId(negotiationId) || !isSessionDescription(sdp)) return undefined;
  return { negotiationId, sdp };
}

/** The same decoders serve both directions: the service relays these unchanged. */
const NEGOTIATION_DECODERS: DecoderTable<NegotiationMessage> = {
  RTC_OFFER: decodeSessionDescription,
  RTC_ANSWER: decodeSessionDescription,
  ICE_CANDIDATE: (value): IceCandidateMessage['payload'] | undefined => {
    const object = exactObject(value, ['negotiationId', 'candidate']);
    if (object === undefined) return undefined;
    const { negotiationId } = object;
    const candidate = toIceCandidate(object.candidate);
    if (!isNegotiationId(negotiationId) || candidate === undefined) return undefined;
    return { negotiationId, candidate };
  },
  ICE_COMPLETE: (value): IceCompleteMessage['payload'] | undefined => {
    const object = exactObject(value, ['negotiationId']);
    if (object === undefined) return undefined;
    const { negotiationId } = object;
    return isNegotiationId(negotiationId) ? { negotiationId } : undefined;
  },
};

function decodePeerHandshake(value: unknown): PeerHandshakePayload | undefined {
  const object = exactObject(value, ['negotiationId', 'senderId', 'recipientId']);
  if (object === undefined) return undefined;
  const { negotiationId, senderId, recipientId } = object;
  if (
    !isNegotiationId(negotiationId) ||
    !isParticipantId(senderId) ||
    !isParticipantId(recipientId) ||
    senderId === recipientId
  ) {
    return undefined;
  }
  return { negotiationId, senderId, recipientId };
}

const PEER_DECODERS: DecoderTable<PeerMessage> = {
  PEER_HELLO: decodePeerHandshake,
  PEER_READY: decodePeerHandshake,
};

const CLIENT_DECODERS: DecoderTable<ClientMessage> = {
  ...NEGOTIATION_DECODERS,
  ROOM_CREATE: decodeEmpty,
  ROOM_JOIN: (value): RoomJoinMessage['payload'] | undefined => {
    const object = exactObject(value, ['roomId', 'inviteSecret']);
    if (object === undefined) return undefined;
    const { roomId, inviteSecret } = object;
    if (!isRoomId(roomId) || !isInviteSecret(inviteSecret)) return undefined;
    return { roomId, inviteSecret };
  },
  ROOM_LEAVE: decodeEmpty,
};

const SERVER_DECODERS: DecoderTable<ServerMessage> = {
  ...NEGOTIATION_DECODERS,
  ROOM_CREATED: (value): RoomCreatedMessage['payload'] | undefined => {
    const object = exactObject(value, [
      'roomId',
      'inviteSecret',
      'participantId',
      'role',
      'expiresAt',
    ]);
    if (object === undefined) return undefined;
    const { roomId, inviteSecret, participantId, expiresAt } = object;
    if (
      !isRoomId(roomId) ||
      !isInviteSecret(inviteSecret) ||
      !isParticipantId(participantId) ||
      object.role !== 'host' ||
      !isWireInteger(expiresAt)
    ) {
      return undefined;
    }
    return { roomId, inviteSecret, participantId, role: 'host', expiresAt };
  },
  ROOM_JOINED: (value): RoomJoinedMessage['payload'] | undefined => {
    const object = exactObject(value, ['roomId', 'participantId', 'role', 'peer', 'expiresAt']);
    if (object === undefined) return undefined;
    const { roomId, participantId, expiresAt } = object;
    const peer = decodeParticipant(object.peer, 'host');
    if (
      !isRoomId(roomId) ||
      !isParticipantId(participantId) ||
      object.role !== 'guest' ||
      peer === undefined ||
      !isWireInteger(expiresAt)
    ) {
      return undefined;
    }
    return { roomId, participantId, role: 'guest', peer, expiresAt };
  },
  ROOM_LEFT: decodeEmpty,
  ROOM_PARTICIPANT_JOINED: (value): RoomParticipantJoinedMessage['payload'] | undefined => {
    const object = exactObject(value, ['participant']);
    if (object === undefined) return undefined;
    const participant = decodeParticipant(object.participant, 'guest');
    return participant === undefined ? undefined : { participant };
  },
  ROOM_PARTICIPANT_LEFT: (value): RoomParticipantLeftMessage['payload'] | undefined => {
    const object = exactObject(value, ['participantId', 'reason']);
    if (object === undefined) return undefined;
    const { participantId, reason } = object;
    if (!isParticipantId(participantId) || !isOneOf(reason, PARTICIPANT_LEFT_REASONS)) {
      return undefined;
    }
    return { participantId, reason };
  },
  ROOM_CLOSED: (value): RoomClosedMessage['payload'] | undefined => {
    const object = exactObject(value, ['reason']);
    if (object === undefined) return undefined;
    const { reason } = object;
    return isOneOf(reason, ROOM_CLOSED_REASONS) ? { reason } : undefined;
  },
  ERROR: (value): ErrorMessage['payload'] | undefined => {
    const object = exactObject(value, ['code', 'message', 'recoverable']);
    if (object === undefined) return undefined;
    const { code, message, recoverable } = object;
    if (
      !isErrorCode(code) ||
      typeof message !== 'string' ||
      message.length === 0 ||
      message.length > MAX_ERROR_MESSAGE_LENGTH ||
      typeof recoverable !== 'boolean'
    ) {
      return undefined;
    }
    return { code, message, recoverable };
  },
};
