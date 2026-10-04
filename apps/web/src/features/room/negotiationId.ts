import { NEGOTIATION_ID_BYTES, isNegotiationId, type NegotiationId } from '@driftless/protocol';

/** Fills `bytes` with random values. */
export type RandomFill = (bytes: Uint8Array<ArrayBuffer>) => void;

/** The browser's cryptographically secure generator. */
export const cryptoRandomFill: RandomFill = (bytes) => {
  crypto.getRandomValues(bytes);
};

/**
 * Creates a fresh negotiation ID: 18 bytes from the secure generator, as
 * canonical unpadded base64url. It identifies one negotiation and is not a
 * secret. No timestamp, counter, or `Math.random` is involved.
 */
export function createNegotiationId(random: RandomFill = cryptoRandomFill): NegotiationId {
  const bytes = new Uint8Array(NEGOTIATION_ID_BYTES);
  random(bytes);
  // 18 bytes are a whole number of 3-byte groups, so there is no padding.
  const encoded = btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_');
  if (!isNegotiationId(encoded)) throw new Error('Could not encode a negotiation ID.');
  return encoded;
}
