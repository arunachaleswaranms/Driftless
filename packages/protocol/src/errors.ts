/**
 * Machine-readable error codes a signaling server may send in an `ERROR`
 * message. The set is deliberately small; see docs/PROTOCOL.md.
 */
export const ERROR_CODES = [
  'INVALID_MESSAGE',
  'UNSUPPORTED_PROTOCOL',
  'INVALID_STATE',
  'ROOM_UNAVAILABLE',
  'ROOM_FULL',
  'RATE_LIMITED',
  'SERVER_ERROR',
  'SESSION_UNAVAILABLE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Upper bound on the human-readable `message` of an `ERROR` payload. */
export const MAX_ERROR_MESSAGE_LENGTH = 200;

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}
