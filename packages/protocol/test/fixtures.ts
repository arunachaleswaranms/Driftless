import { Buffer } from 'node:buffer';

/** Canonical base64url of `length` bytes counting up from `start`. */
export function encodedBytes(length: number, start = 0): string {
  return Buffer.from(Array.from({ length }, (_, index) => (start + index) % 256)).toString(
    'base64url',
  );
}

export const ROOM_ID = encodedBytes(16);
export const OTHER_ROOM_ID = encodedBytes(16, 100);
export const INVITE_SECRET = encodedBytes(32);
export const PARTICIPANT_ID = encodedBytes(12);
export const OTHER_PARTICIPANT_ID = encodedBytes(12, 50);
export const NEGOTIATION_ID = encodedBytes(18);
export const OTHER_NEGOTIATION_ID = encodedBytes(18, 200);
export const SESSION_ID = encodedBytes(20, 7);
export const OTHER_SESSION_ID = encodedBytes(20, 90);
export const RESUME_SECRET = encodedBytes(33, 11);
export const RESUME_CHALLENGE = encodedBytes(24, 33);
export const RESUME_PROOF = encodedBytes(32, 77);

/** A small session description shaped like a real data-channel offer. */
export const SDP = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=mid:0',
  'a=sctp-port:5000',
  '',
].join('\r\n');

export const CANDIDATE = {
  candidate: 'candidate:1 1 udp 2122260223 192.0.2.10 54400 typ host generation 0',
  sdpMid: '0',
  sdpMLineIndex: 0,
  usernameFragment: 'abcd',
} as const;

/** One valid raw payload for every negotiation message type, in either direction. */
export const VALID_NEGOTIATION_PAYLOADS = {
  RTC_OFFER: { negotiationId: NEGOTIATION_ID, sdp: SDP },
  RTC_ANSWER: { negotiationId: NEGOTIATION_ID, sdp: SDP },
  ICE_CANDIDATE: { negotiationId: NEGOTIATION_ID, candidate: CANDIDATE },
  ICE_COMPLETE: { negotiationId: NEGOTIATION_ID },
  RTC_RECOVERY_REQUEST: { negotiationId: NEGOTIATION_ID },
  RTC_RECOVER: {
    previousNegotiationId: OTHER_NEGOTIATION_ID,
    negotiationId: NEGOTIATION_ID,
    sdp: SDP,
  },
} as const;

/** One valid raw payload for every peer message type. */
export const VALID_PEER_PAYLOADS = {
  PEER_HELLO: {
    sessionId: SESSION_ID,
    negotiationId: NEGOTIATION_ID,
    senderId: PARTICIPANT_ID,
    recipientId: OTHER_PARTICIPANT_ID,
  },
  PEER_READY: {
    sessionId: SESSION_ID,
    negotiationId: NEGOTIATION_ID,
    senderId: OTHER_PARTICIPANT_ID,
    recipientId: PARTICIPANT_ID,
  },
} as const;

export function envelope(type: string, payload: unknown, overrides: object = {}): string {
  return JSON.stringify({
    protocolVersion: 1,
    type,
    sequence: 0,
    sentAt: 1_760_000_000_000,
    payload,
    ...overrides,
  });
}

/** One valid raw payload for every client message type. */
export const VALID_CLIENT_PAYLOADS = {
  ROOM_CREATE: {},
  ROOM_JOIN: { roomId: ROOM_ID, inviteSecret: INVITE_SECRET },
  ROOM_LEAVE: {},
  SESSION_RESUME_BEGIN: { sessionId: SESSION_ID, participantId: PARTICIPANT_ID },
  SESSION_RESUME_PROVE: { challenge: RESUME_CHALLENGE, proof: RESUME_PROOF },
  RTC_CONFIG_REQUEST: {},
  ...VALID_NEGOTIATION_PAYLOADS,
} as const;

/** A STUN and a TURN entry, shaped as the service issues them. */
export const RTC_ICE_SERVERS = [
  { urls: ['stun:stun.example.org:3478'], username: null, credential: null },
  {
    urls: ['turn:turn.example.org:3478?transport=udp', 'turns:turn.example.org:5349?transport=tcp'],
    username: '1760003600:AAECAwQFBgcICQoL',
    credential: 'bm90LWEtcmVhbC1jcmVkZW50aWFsLXh4eA==',
  },
] as const;

/** One valid raw payload for every server message type. */
export const VALID_SERVER_PAYLOADS = {
  ROOM_CREATED: {
    roomId: ROOM_ID,
    sessionId: SESSION_ID,
    inviteSecret: INVITE_SECRET,
    resumeSecret: RESUME_SECRET,
    participantId: PARTICIPANT_ID,
    role: 'host',
    expiresAt: 1_760_000_600_000,
  },
  ROOM_JOINED: {
    roomId: ROOM_ID,
    sessionId: SESSION_ID,
    resumeSecret: RESUME_SECRET,
    participantId: OTHER_PARTICIPANT_ID,
    role: 'guest',
    peer: { participantId: PARTICIPANT_ID, role: 'host' },
    expiresAt: 1_760_000_600_000,
  },
  ROOM_LEFT: {},
  ROOM_PARTICIPANT_JOINED: { participant: { participantId: OTHER_PARTICIPANT_ID, role: 'guest' } },
  ROOM_PARTICIPANT_LEFT: { participantId: OTHER_PARTICIPANT_ID, reason: 'LEFT' },
  ROOM_CLOSED: { reason: 'EXPIRED' },
  ROOM_PARTICIPANT_CONNECTION: {
    participantId: OTHER_PARTICIPANT_ID,
    signaling: 'RECONNECTING',
    activeNegotiationId: NEGOTIATION_ID,
    negotiationCount: 1,
  },
  SESSION_RESUME_CHALLENGE: { challenge: RESUME_CHALLENGE },
  SESSION_RESUMED: {
    sessionId: SESSION_ID,
    roomId: ROOM_ID,
    participantId: PARTICIPANT_ID,
    role: 'host',
    expiresAt: 1_760_000_600_000,
    peer: { participantId: OTHER_PARTICIPANT_ID, role: 'guest', signaling: 'CONNECTED' },
    activeNegotiationId: NEGOTIATION_ID,
    negotiationCount: 2,
  },
  RTC_CONFIG: { expiresAt: 1_760_003_600_000, iceServers: RTC_ICE_SERVERS },
  ERROR: { code: 'ROOM_UNAVAILABLE', message: 'The room is not available.', recoverable: true },
  ...VALID_NEGOTIATION_PAYLOADS,
} as const;
