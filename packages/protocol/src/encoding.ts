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
