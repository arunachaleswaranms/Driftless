// UTF-8 size accounting shared by every endpoint.
//
// Message bounds are stated in encoded bytes, because that is what a WebSocket
// frame or a data-channel message carries. JavaScript string length counts
// UTF-16 code units instead, which undercounts every non-ASCII character. The
// count here is pure arithmetic over code units and uses no platform API, so
// the browser and Node apply exactly the same bound.

/**
 * Number of bytes in the UTF-8 encoding of `text`, exactly as `TextEncoder`,
 * `WebSocket.send()`, and `RTCDataChannel.send()` produce it. A lone surrogate
 * cannot be encoded and is replaced by U+FFFD, which takes 3 bytes.
 */
export function utf8ByteLength(text: string): number {
  return countUtf8Bytes(text, Number.POSITIVE_INFINITY);
}

/** Whether `text` encodes to at most `maxBytes` bytes of UTF-8. */
export function fitsUtf8Bytes(text: string, maxBytes: number): boolean {
  // Every code unit encodes to at least one byte, so a longer string can
  // never fit, and to at most three, so a short enough string always fits.
  if (text.length > maxBytes) return false;
  if (text.length * 3 <= maxBytes) return true;
  return countUtf8Bytes(text, maxBytes) <= maxBytes;
}

/** Counts encoded bytes, stopping early once the count exceeds `limit`. */
function countUtf8Bytes(text: string, limit: number): number {
  let bytes = 0;
  for (let index = 0; index < text.length && bytes <= limit; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff && isLowSurrogate(text.charCodeAt(index + 1))) {
      // A surrogate pair is one code point above U+FFFF: 4 bytes.
      bytes += 4;
      index += 1;
    } else {
      // The rest of the Basic Multilingual Plane, and lone surrogates, which
      // the encoder replaces with U+FFFD.
      bytes += 3;
    }
  }
  return bytes;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

// Canonical unpadded base64url (RFC 4648 §5), shared by every endpoint so the
// browser and Node decode identifiers and credentials identically. Pure
// arithmetic; no `atob`, `Buffer`, or other platform API.

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Encodes bytes as unpadded base64url. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let text = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const group = (first << 16) | (second << 8) | third;
    const characters = Math.min(4, Math.ceil(((bytes.length - index) * 8) / 6));
    for (let shift = 0; shift < characters; shift += 1) {
      text += BASE64URL_ALPHABET.charAt((group >> (18 - shift * 6)) & 0x3f);
    }
  }
  return text;
}

/**
 * Decodes canonical unpadded base64url, or returns undefined. A canonical
 * string has no padding, no character outside the alphabet, no impossible
 * length, and zero in any unused low bits of its final character, so each
 * accepted string has exactly one byte representation.
 */
export function decodeBase64Url(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (text.length % 4 === 1) return undefined;
  const bytes = new Uint8Array(Math.floor((text.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let written = 0;
  for (let index = 0; index < text.length; index += 1) {
    const value = BASE64URL_ALPHABET.indexOf(text.charAt(index));
    if (value === -1) return undefined;
    buffer = ((buffer << 6) | value) & 0xfff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[written] = (buffer >> bits) & 0xff;
      written += 1;
    }
  }
  // Leftover bits belong to no byte; a canonical encoding sets them to zero.
  if ((buffer & ((1 << bits) - 1)) !== 0) return undefined;
  return bytes;
}
