// Bounded representations of WebRTC negotiation data.
//
// Every bound below is a provisional implementation and security bound chosen
// for Phase 2B, not a limit of WebRTC itself. Data-channel-only Chromium
// sessions produce session descriptions of under 1 KiB and a few candidates
// per peer, so the bounds leave wide headroom while still capping what one
// participant can make the signaling service relay. Byte bounds count UTF-8
// bytes.
//
// Session descriptions are treated as opaque, untrusted text: endpoints check
// only type, presence, and size. The browser's WebRTC implementation is the
// only component that interprets them.

import { fitsUtf8Bytes } from './encoding.js';

/** Upper bound on one session description (offer or answer), in UTF-8 bytes. */
export const MAX_SDP_BYTES = 16_384;

/** Upper bound on one ICE candidate attribute string, in bytes. */
export const MAX_ICE_CANDIDATE_BYTES = 1024;

/** Upper bound on an ICE candidate's media stream identification tag, in bytes. */
export const MAX_SDP_MID_BYTES = 64;

/** Largest accepted media description index. A data-channel session uses 0. */
export const MAX_SDP_MLINE_INDEX = 63;

/** Upper bound on an ICE username fragment, in bytes (RFC 8445 allows 256). */
export const MAX_USERNAME_FRAGMENT_BYTES = 256;

/** Candidates one participant may send in one negotiation. */
export const MAX_ICE_CANDIDATES_PER_NEGOTIATION = 32;

/**
 * Negotiations one guest membership may use: the first, plus up to three
 * fresh recovery negotiations after its peer connection fails. Each uses a
 * new negotiation ID that is never accepted again. Provisional.
 */
export const MAX_NEGOTIATIONS_PER_MEMBERSHIP = 4;

/**
 * The browser-compatible fields of one ICE candidate, as a plain object. It
 * mirrors `RTCIceCandidateInit`; every field is always present, and a field
 * the browser did not supply is `null`. At least one of `sdpMid` and
 * `sdpMLineIndex` is non-null, as `RTCIceCandidate` requires.
 */
export interface IceCandidate {
  readonly candidate: string;
  readonly sdpMid: string | null;
  readonly sdpMLineIndex: number | null;
  readonly usernameFragment: string | null;
}

/** Candidate text is printable ASCII, as the ICE grammar defines it. */
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

/** A non-empty session description within `MAX_SDP_BYTES`. */
export function isSessionDescription(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && fitsUtf8Bytes(value, MAX_SDP_BYTES);
}

/**
 * Validates an untrusted value as an `IceCandidate` and returns a fresh plain
 * object built only from its validated fields, or undefined. The value must
 * have exactly the four `IceCandidate` fields. Never throws.
 */
export function toIceCandidate(value: unknown): IceCandidate | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return undefined;
  }
  const keys = Object.keys(value);
  // JSON.parse creates `__proto__` as an ordinary own key, so it fails here.
  if (
    keys.length !== ICE_CANDIDATE_KEYS.length ||
    !keys.every((key) => (ICE_CANDIDATE_KEYS as readonly string[]).includes(key))
  ) {
    return undefined;
  }
  const fields = value as Readonly<Record<string, unknown>>;
  const { candidate } = fields;
  const sdpMid = nullable(fields.sdpMid, (mid) => isAsciiText(mid, MAX_SDP_MID_BYTES));
  const sdpMLineIndex = nullable(fields.sdpMLineIndex, isMLineIndex);
  const usernameFragment = nullable(fields.usernameFragment, (fragment) =>
    isAsciiText(fragment, MAX_USERNAME_FRAGMENT_BYTES),
  );
  if (
    !isAsciiText(candidate, MAX_ICE_CANDIDATE_BYTES) ||
    sdpMid === INVALID ||
    sdpMLineIndex === INVALID ||
    usernameFragment === INVALID ||
    (sdpMid === null && sdpMLineIndex === null)
  ) {
    return undefined;
  }
  return { candidate, sdpMid, sdpMLineIndex, usernameFragment };
}

const ICE_CANDIDATE_KEYS = ['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment'] as const;

const INVALID = Symbol('invalid');

/** `null`, a value that passes `check`, or INVALID. */
function nullable<Value>(
  value: unknown,
  check: (value: unknown) => value is Value,
): Value | null | typeof INVALID {
  if (value === null) return null;
  return check(value) ? value : INVALID;
}

function isAsciiText(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length <= maxBytes && PRINTABLE_ASCII.test(value);
}

function isMLineIndex(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_SDP_MLINE_INDEX
  );
}
