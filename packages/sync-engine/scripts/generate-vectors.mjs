// Independent oracle: Node crypto and Buffer encodings, no implementation import.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const chunkBytes = 4194304;
const digest = (input) => createHash('sha256').update(input).digest();
const session = Buffer.from(Array.from({ length: 20 }, (_, i) => i));
const specs = [
  ['one-byte', 1, -1],
  ['one-chunk', chunkBytes, -1],
  ['chunk-plus-one', chunkBytes + 1, -1],
  ['multiple', 2 * chunkBytes + 17, -1],
  ['first-difference', 2 * chunkBytes + 17, 0],
  ['middle-difference', 2 * chunkBytes + 17, chunkBytes + 10],
  ['last-difference', 2 * chunkBytes + 17, 2 * chunkBytes + 16],
];
const vectors = specs.map(([name, size, changed]) => {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 251;
  if (changed >= 0) bytes[changed] ^= 1;
  const count = Math.ceil(size / chunkBytes);
  const header = Buffer.alloc(16);
  header.writeBigUInt64BE(BigInt(size));
  header.writeUInt32BE(chunkBytes, 8);
  header.writeUInt32BE(count, 12);
  const chunks = [];
  for (let start = 0; start < size; start += chunkBytes)
    chunks.push(digest(bytes.subarray(start, Math.min(size, start + chunkBytes))));
  const root = digest(
    Buffer.concat([Buffer.from('driftless-media-content-v1\0', 'ascii'), header, ...chunks]),
  );
  const wire = (sid) =>
    digest(
      Buffer.concat([Buffer.from('driftless-local-sync-media-v1\0', 'ascii'), sid, root]),
    ).toString('base64url');
  return {
    name,
    size,
    changed,
    fingerprint: wire(session),
    otherSessionFingerprint: wire(Buffer.alloc(20, 5)),
  };
});
writeFileSync(
  new URL('../test/vectors.json', import.meta.url),
  JSON.stringify(vectors, null, 2) + '\n',
);
