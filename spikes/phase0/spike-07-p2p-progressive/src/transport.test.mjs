import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import { LIMITS, Reassembly, decodeFrame, encodeFrame, sha256 } from "./transport.mjs";

globalThis.crypto ??= webcrypto;
test("a bounded fragment reassembles only after every chunk and validates digest", async () => {
  const bytes = new Uint8Array(LIMITS.chunkBytes + 17).map((_, i) => i % 251);
  const info = { type: "PART_INFO", transferId: 42, generation: 0, segment: 7, track: 1, bytes: bytes.length, chunks: 2, sha256: await sha256(bytes), start: 14, end: 16 };
  const r = new Reassembly({ transferId: 42, generation: 0, trackIds: [1, 2], segmentCount: 100 });
  r.begin(info);
  const first = encodeFrame({ ...info, sequence: 0, bytes: bytes.subarray(0, LIMITS.chunkBytes) });
  const last = encodeFrame({ ...info, sequence: 1, bytes: bytes.subarray(LIMITS.chunkBytes) });
  assert.equal(r.accept(first.buffer), false);
  await assert.rejects(() => r.complete(), /missing chunks/);
  assert.throws(() => r.accept(first.buffer), /duplicate/);
  assert.equal(r.accept(last.buffer), true);
  assert.deepEqual((await r.complete()).bytes, bytes);
  assert.equal(r.maxHeldBytes, bytes.length);
});
test("declarations, identities, sizes, corruption, and stale generations are rejected", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const info = { type: "PART_INFO", transferId: 1, generation: 2, segment: 3, track: 4, bytes: 3, chunks: 1, sha256: await sha256(bytes), start: 6, end: 8 };
  const r = new Reassembly({ transferId: 1, generation: 2, trackIds: [4, 5], segmentCount: 10 });
  assert.throws(() => r.begin({ ...info, bytes: LIMITS.maxPartBytes + 1 }), /size/);
  assert.throws(() => r.begin({ ...info, generation: 1 }), /generation/);
  r.begin(info);
  assert.throws(() => r.accept(new Uint8Array([1, 2]).buffer), /frame size/);
  const frame = encodeFrame({ ...info, sequence: 0, bytes });
  assert.equal(decodeFrame(frame.buffer).sequence, 0);
  const wrong = encodeFrame({ ...info, generation: 1, sequence: 0, bytes });
  assert.throws(() => r.accept(wrong.buffer), /identity/);
  frame[frame.length - 1] ^= 1;
  r.accept(frame.buffer);
  await assert.rejects(() => r.complete(), /digest/);
  r.reset(3);
  assert.equal(r.part, null);
});
