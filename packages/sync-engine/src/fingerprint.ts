import {
  MEDIA_FINGERPRINT_CHUNK_BYTES,
  MAX_MEDIA_FINGERPRINT_BYTES,
  decodeBase64Url,
  encodeBase64Url,
  isMediaFingerprint,
  type MediaFingerprint,
  type SessionId,
} from '@driftless/protocol';

export type FingerprintFailure = 'FILE_TOO_LARGE' | 'READ_FAILED' | 'HASH_FAILED' | 'CANCELLED';
export class FingerprintError extends Error {
  readonly category: FingerprintFailure;
  constructor(category: FingerprintFailure) {
    super(category);
    this.category = category;
  }
}
/** Random-access local source. A read must return exactly the requested range. */
export interface FingerprintSource {
  readonly size: number;
  read(start: number, end: number): Promise<ArrayBuffer>;
}
export type Sha256 = (bytes: Uint8Array<ArrayBuffer>) => Promise<Uint8Array<ArrayBuffer>>;
export interface FingerprintOptions {
  readonly source: FingerprintSource;
  readonly sessionId: SessionId;
  readonly sha256: Sha256;
  readonly signal: { readonly aborted: boolean };
  readonly onProgress?: (processed: number, total: number) => void;
}
function ascii(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length: text.length }, (_, index) => text.charCodeAt(index));
}
/** Empty media is refused. No chunk bytes or private root leave this function. */
export async function fingerprintMedia({
  source,
  sessionId,
  sha256,
  signal,
  onProgress,
}: FingerprintOptions): Promise<MediaFingerprint> {
  const check = () => {
    if (signal.aborted) throw new FingerprintError('CANCELLED');
  };
  const hash = async (bytes: Uint8Array<ArrayBuffer>) => {
    check();
    let digest: Uint8Array<ArrayBuffer>;
    try {
      digest = await sha256(bytes);
    } catch {
      check();
      throw new FingerprintError('HASH_FAILED');
    }
    check();
    if (digest.byteLength !== 32) throw new FingerprintError('HASH_FAILED');
    return digest;
  };
  check();
  const size = source.size;
  if (!Number.isSafeInteger(size) || size > MAX_MEDIA_FINGERPRINT_BYTES || size < 0)
    throw new FingerprintError('FILE_TOO_LARGE');
  if (size === 0) throw new FingerprintError('READ_FAILED');
  const chunkCount = Math.ceil(size / MEDIA_FINGERPRINT_CHUNK_BYTES);
  const domain = ascii('driftless-media-content-v1');
  // Fixed upper bound: header plus at most 128 KiB of digests, never file bytes.
  const manifest = new Uint8Array(domain.length + 1 + 16 + chunkCount * 32);
  manifest.set(domain);
  const header = domain.length + 1;
  const view = new DataView(manifest.buffer);
  view.setBigUint64(header, BigInt(size), false);
  view.setUint32(header + 8, MEDIA_FINGERPRINT_CHUNK_BYTES, false);
  view.setUint32(header + 12, chunkCount, false);
  onProgress?.(0, size);
  for (let index = 0; index < chunkCount; index += 1) {
    check();
    const start = index * MEDIA_FINGERPRINT_CHUNK_BYTES;
    const end = Math.min(size, start + MEDIA_FINGERPRINT_CHUNK_BYTES);
    // Block scope releases the only source buffer before the next read.
    {
      let buffer: ArrayBuffer;
      try {
        buffer = await source.read(start, end);
      } catch {
        check();
        throw new FingerprintError('READ_FAILED');
      }
      check();
      if (buffer.byteLength !== end - start) throw new FingerprintError('READ_FAILED');
      manifest.set(await hash(new Uint8Array(buffer)), header + 16 + index * 32);
    }
    check();
    onProgress?.(end, size);
  }
  const root = await hash(manifest);
  const wireDomain = ascii('driftless-local-sync-media-v1');
  const session = decodeBase64Url(sessionId);
  if (session?.length !== 20) throw new FingerprintError('HASH_FAILED');
  const wire = new Uint8Array(wireDomain.length + 1 + session.length + root.length);
  wire.set(wireDomain);
  wire.set(session, wireDomain.length + 1);
  wire.set(root, wireDomain.length + 1 + session.length);
  const result = encodeBase64Url(await hash(wire));
  check();
  if (!isMediaFingerprint(result)) throw new FingerprintError('HASH_FAILED');
  return result;
}
