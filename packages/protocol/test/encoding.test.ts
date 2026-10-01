import { describe, expect, it } from 'vitest';
import {
  MAX_PEER_MESSAGE_BYTES,
  MAX_SIGNALING_MESSAGE_BYTES,
  fitsUtf8Bytes,
  parseClientMessage,
  parsePeerMessage,
  parseServerMessage,
  utf8ByteLength,
} from '../src/index.js';
import { envelope } from './fixtures.js';

const encoder = new TextEncoder();

// ASCII, 2-byte, 3-byte, and 4-byte (surrogate pair) characters, and lone
// surrogates, which encoders replace with the 3-byte U+FFFD.
const SAMPLES = [
  '',
  'plain ascii',
  'é',
  'ü€',
  '日本語',
  '😀',
  'a😀b',
  '\ud800',
  '\udc00',
  'x\ud800y',
  '\udc00\ud800',
  '😀\ud83d',
  'mixed é € 😀 \u0000 \u007f \u0080 ߿ ࠀ ￿',
];

describe('utf8ByteLength', () => {
  it.each(SAMPLES)('matches TextEncoder for %j', (text) => {
    expect(utf8ByteLength(text)).toBe(encoder.encode(text).byteLength);
  });

  it('matches TextEncoder for every code unit and many random strings', () => {
    for (let unit = 0; unit <= 0xffff; unit += 1) {
      const text = String.fromCharCode(unit);
      expect(utf8ByteLength(text)).toBe(encoder.encode(text).byteLength);
    }
    let seed = 7;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed;
    };
    for (let round = 0; round < 500; round += 1) {
      const units = Array.from({ length: next() % 40 }, () => next() % 0x10000);
      const text = String.fromCharCode(...units);
      expect(utf8ByteLength(text)).toBe(encoder.encode(text).byteLength);
    }
  });

  it('decides fitsUtf8Bytes exactly at and around the bound', () => {
    for (const text of SAMPLES) {
      const bytes = encoder.encode(text).byteLength;
      expect(fitsUtf8Bytes(text, bytes)).toBe(true);
      if (bytes > 0) expect(fitsUtf8Bytes(text, bytes - 1)).toBe(false);
    }
    expect(fitsUtf8Bytes('é'.repeat(10), 20)).toBe(true);
    expect(fitsUtf8Bytes('é'.repeat(10), 19)).toBe(false);
    expect(fitsUtf8Bytes('😀'.repeat(10), 40)).toBe(true);
    expect(fitsUtf8Bytes('😀'.repeat(10), 39)).toBe(false);
  });
});

/** A valid message followed by insignificant whitespace, to exactly `bytes` bytes. */
function padTo(text: string, bytes: number): string {
  return `${text}${' '.repeat(bytes - encoder.encode(text).byteLength)}`;
}

describe('message size bound is enforced in UTF-8 bytes', () => {
  // A JSON string value is the only place a multi-byte character can sit in a
  // valid message, so the bound is exercised through the parser's first check:
  // the result must be 'too_large' exactly when the encoded size exceeds the
  // bound, whatever the string length.
  const multiByte = ['é', '€', '😀'];

  it('accepts a message of exactly the bound in ASCII bytes', () => {
    const text = padTo(envelope('ROOM_CREATE', {}), MAX_SIGNALING_MESSAGE_BYTES);
    expect(encoder.encode(text).byteLength).toBe(MAX_SIGNALING_MESSAGE_BYTES);
    expect(parseClientMessage(text).ok).toBe(true);
    expect(parseClientMessage(`${text} `)).toMatchObject({ ok: false, reason: 'too_large' });
  });

  it.each(multiByte)(
    'rejects %j text whose string length fits but whose bytes do not',
    (character) => {
      const bytesPer = encoder.encode(character).byteLength;
      // Fewer code units than the bound, but more encoded bytes.
      const count = Math.floor(MAX_SIGNALING_MESSAGE_BYTES / bytesPer) + 1;
      const text = character.repeat(count);
      expect(text.length).toBeLessThanOrEqual(MAX_SIGNALING_MESSAGE_BYTES);
      expect(encoder.encode(text).byteLength).toBeGreaterThan(MAX_SIGNALING_MESSAGE_BYTES);
      for (const parse of [parseClientMessage, parseServerMessage]) {
        expect(parse(text)).toStrictEqual({
          ok: false,
          code: 'INVALID_MESSAGE',
          reason: 'too_large',
        });
      }
    },
  );

  it.each(multiByte)('treats %j text exactly at the byte bound as within it', (character) => {
    const bytesPer = encoder.encode(character).byteLength;
    const count = Math.floor(MAX_SIGNALING_MESSAGE_BYTES / bytesPer);
    const text = character.repeat(count);
    expect(encoder.encode(text).byteLength).toBeLessThanOrEqual(MAX_SIGNALING_MESSAGE_BYTES);
    // Within the bound, so it reaches the JSON parser instead.
    expect(parseClientMessage(text)).toMatchObject({ ok: false, reason: 'invalid_json' });
  });

  it('counts a multi-byte character by its bytes, not its code units', () => {
    // A message exactly at the bound; replacing two of its ASCII bytes with one
    // 3-byte character shortens the string but lengthens the encoding.
    const fits = padTo(envelope('ROOM_CREATE', {}), MAX_SIGNALING_MESSAGE_BYTES);
    expect(parseClientMessage(fits).ok).toBe(true);
    const over = `${fits.slice(0, -2)}\u20ac`;
    expect(over.length).toBeLessThan(fits.length);
    expect(encoder.encode(over).byteLength).toBe(MAX_SIGNALING_MESSAGE_BYTES + 1);
    expect(parseClientMessage(over)).toMatchObject({ ok: false, reason: 'too_large' });
  });

  it('applies the smaller bound to peer messages', () => {
    expect(MAX_PEER_MESSAGE_BYTES).toBeLessThan(MAX_SIGNALING_MESSAGE_BYTES);
    const text = '€'.repeat(Math.floor(MAX_PEER_MESSAGE_BYTES / 3) + 1);
    expect(text.length).toBeLessThan(MAX_PEER_MESSAGE_BYTES);
    expect(parsePeerMessage(text)).toMatchObject({ ok: false, reason: 'too_large' });
  });
});
