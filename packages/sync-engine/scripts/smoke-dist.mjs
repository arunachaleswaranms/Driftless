import assert from 'node:assert/strict';
import {
  bothReady,
  initialLocalSyncState,
  reduceLocalSync,
  fingerprintMedia,
} from '@driftless/sync-engine';
assert.equal(bothReady(initialLocalSyncState), false);
assert.equal(reduceLocalSync(initialLocalSyncState, { type: 'ready' }).effects.length, 0);
assert.equal(typeof fingerprintMedia, 'function');
console.info('Built sync-engine import smoke passed.');

// Actual garbage-collection evidence: the engine retains digest bytes only.
// Run with --expose-gc; this is test tooling, never a production dependency.
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
const buffers = [];
await fingerprintMedia({
  source: {
    size: 2 * 4194304 + 1,
    read: async (start, end) => {
      const buffer = new ArrayBuffer(end - start);
      buffers.push(new WeakRef(buffer));
      return buffer;
    },
  },
  sessionId: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA',
  signal: { aborted: false },
  sha256: async (bytes) => Uint8Array.from(createHash('sha256').update(bytes).digest()),
});
assert.equal(typeof global.gc, 'function');
for (let pass = 0; pass < 5; pass++) {
  await setImmediate();
  global.gc();
}
assert.equal(buffers.length, 3);
assert.equal(
  buffers.every((ref) => ref.deref() === undefined),
  true,
);
console.info('Source buffer release smoke passed (three chunk buffers collected).');
