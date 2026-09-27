import assert from "node:assert/strict";
import test from "node:test";

import {
  GiB,
  HEADROOM_POLICY,
  INSUFFICIENT_HEADROOM,
  KiB,
  LIMITS,
  MiB,
  SPIKE_DIRECTORY,
  admitWrite,
  blockRanges,
  boundaryRanges,
  buildMetadata,
  displayName,
  formatBytes,
  headroomFromEstimate,
  isSpikeEntryName,
  isSpikeMetadataName,
  makeEntryName,
  metadataNameFor,
  parseMetadata,
  validateTestBytes,
  verificationRanges,
} from "./plan.mjs";
import {
  clearSpikeStorage,
  deleteEntry,
  exists,
  listEntries,
  openSpikeDirectory,
  verifyRanges,
  verifySequential,
  writePatternRange,
} from "./storage.mjs";

// In-memory stand-ins for the OPFS handle interfaces, used only for small unit-test sizes.
// Like Chromium, createWritable() stages into a private buffer that replaces the file on close().
class FakeWritable {
  #handle;
  #buffer;
  #length;
  #position = 0;

  constructor(handle, keepExistingData) {
    this.#handle = handle;
    this.#buffer = keepExistingData ? handle.bytes.slice() : new Uint8Array(0);
    this.#length = this.#buffer.length;
    this.sourceBuffers = new Set();
    this.maxWriteBytes = 0;
    handle.lastWritable = this;
  }

  async seek(position) {
    this.#position = position;
  }

  async write(chunk) {
    let data = chunk;
    if (chunk && typeof chunk === "object" && chunk.type === "write") {
      this.#position = chunk.position ?? this.#position;
      data = chunk.data;
    }
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength);
    if (data.buffer) this.sourceBuffers.add(data.buffer);
    this.maxWriteBytes = Math.max(this.maxWriteBytes, bytes.length);
    const end = this.#position + bytes.length;
    if (end > this.#handle.quotaBytes) throw new DOMException("quota exceeded", "QuotaExceededError");
    if (end > this.#buffer.length) {
      const grown = new Uint8Array(Math.max(end, this.#buffer.length * 2));
      grown.set(this.#buffer.subarray(0, this.#length));
      this.#buffer = grown;
    }
    this.#buffer.set(bytes, this.#position);
    this.#position = end;
    this.#length = Math.max(this.#length, end);
  }

  async close() {
    this.#handle.bytes = this.#buffer.slice(0, this.#length);
    this.closed = true;
  }

  async abort() {
    this.aborted = true;
  }
}

class FakeFileHandle {
  kind = "file";
  bytes = new Uint8Array(0);
  quotaBytes = Infinity;

  constructor(name) {
    this.name = name;
  }

  async getFile() {
    return new Blob([this.bytes]);
  }

  async createWritable({ keepExistingData = false } = {}) {
    return new FakeWritable(this, keepExistingData);
  }
}

const notFound = () => new DOMException("not found", "NotFoundError");

class FakeDirectoryHandle {
  kind = "directory";
  children = new Map();

  constructor(name) {
    this.name = name;
  }

  async getFileHandle(name, { create = false } = {}) {
    const existing = this.children.get(name);
    if (existing?.kind === "file") return existing;
    if (existing || !create) throw notFound();
    const handle = new FakeFileHandle(name);
    this.children.set(name, handle);
    return handle;
  }

  async getDirectoryHandle(name, { create = false } = {}) {
    const existing = this.children.get(name);
    if (existing?.kind === "directory") return existing;
    if (existing || !create) throw notFound();
    const handle = new FakeDirectoryHandle(name);
    this.children.set(name, handle);
    return handle;
  }

  async removeEntry(name, { recursive = false } = {}) {
    const existing = this.children.get(name);
    if (!existing) throw notFound();
    if (existing.kind === "directory" && existing.children.size > 0 && !recursive) {
      throw new DOMException("not empty", "InvalidModificationError");
    }
    this.children.delete(name);
  }

  async *entries() {
    yield* this.children.entries();
  }

  async *keys() {
    yield* this.children.keys();
  }
}

const SEED = 0x5eed1234;

async function freshDirectory() {
  const root = new FakeDirectoryHandle("");
  return { root, directory: await openSpikeDirectory(root) };
}

test("size bounds and headroom admission refuse unsafe requests", () => {
  assert.equal(validateTestBytes(1 * MiB).ok, true);
  assert.equal(validateTestBytes(1 * GiB).ok, true);
  for (const bad of [0, 1 * MiB - 1, 1 * GiB + 1, 2 * GiB, 1.5, Number.NaN, "64"]) assert.equal(validateTestBytes(bad).ok, false);

  const roomy = { quota: 100 * GiB, usage: 1 * GiB };
  const admitted = admitWrite({ bytes: 512 * MiB, estimate: roomy });
  assert.equal(admitted.ok, true);
  assert.equal(admitted.requiredBytes, 512 * MiB * HEADROOM_POLICY.overheadFactor + HEADROOM_POLICY.reserveBytes);

  const tight = admitWrite({ bytes: 256 * MiB, estimate: { quota: 2 * GiB, usage: 1.2 * GiB } });
  assert.equal(tight.ok, false);
  assert.equal(tight.code, INSUFFICIENT_HEADROOM);

  for (const estimate of [null, {}, { quota: 10 * GiB }, { quota: Number.NaN, usage: 0 }, { quota: -1, usage: 0 }]) {
    const refused = admitWrite({ bytes: 1 * MiB, estimate });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, INSUFFICIENT_HEADROOM);
  }

  const oversize = admitWrite({ bytes: 2 * GiB, estimate: roomy });
  assert.equal(oversize.ok, false);
  assert.equal(oversize.code, "SIZE OUT OF BOUNDS");

  assert.equal(headroomFromEstimate({ quota: 10, usage: 20 }), 0);
});

test("block and verification ranges stay within the file and bounds", () => {
  const blocks = [...blockRanges(0, 5 * MiB + 3, 2 * MiB)];
  assert.deepEqual(blocks.map((block) => block.length), [2 * MiB, 2 * MiB, 1 * MiB + 3]);
  assert.equal(blocks.at(-1).offset + blocks.at(-1).length, 5 * MiB + 3);

  for (const size of [1 * MiB, 64 * MiB, 256 * MiB, 512 * MiB, 1 * GiB]) {
    const ranges = verificationRanges(size, 256 * KiB);
    assert.ok(ranges.length >= 5, `expected several ranges for ${size}`);
    assert.equal(ranges[0].offset, 0);
    assert.ok(ranges.some((range) => range.offset + range.length === size), "covers the final byte");
    assert.ok(ranges.some((range) => range.offset % 4 !== 0), "includes an unaligned offset");
    for (const range of ranges) {
      assert.ok(range.offset >= 0 && range.offset + range.length <= size);
      assert.ok(range.length <= LIMITS.maxRangeBytes);
    }
    assert.equal(new Set(ranges.map((range) => range.offset)).size, ranges.length);
  }

  const boundary = boundaryRanges(64 * MiB, 128 * MiB);
  assert.ok(boundary.some((range) => range.offset === 64 * MiB - 1 && range.length === 1));
  assert.ok(boundary.some((range) => range.offset === 64 * MiB && range.length === 1));
  assert.ok(boundary.some((range) => range.offset < 64 * MiB && range.offset + range.length > 64 * MiB));
});

test("entry names, metadata, and display text are validated", () => {
  const name = makeEntryName("st", 256 * MiB, "0a1b2c3d");
  assert.equal(name, "st-256m-0a1b2c3d.bin");
  assert.equal(isSpikeEntryName(name), true);
  assert.equal(metadataNameFor(name), "st-256m-0a1b2c3d.meta.json");
  assert.equal(isSpikeMetadataName(metadataNameFor(name)), true);
  for (const bad of ["../st-1m-0a1b2c3d.bin", "st-1m-0a1b2c3d.bin/x", "st-1m-ZZZZZZZZ.bin", "evil.bin", "", null, "st-1m-0a1b2c3d.bin\u0000"]) {
    assert.equal(isSpikeEntryName(bad), false, String(bad));
  }
  assert.throws(() => makeEntryName("../x", 1 * MiB, "0a1b2c3d"));
  assert.throws(() => metadataNameFor("<img src=x>.bin"));

  assert.equal(displayName("a\u0000b\u001fc"), "a?b?c");
  assert.ok(displayName("x".repeat(500)).length <= LIMITS.maxDisplayNameChars + 1);

  const text = buildMetadata({ name, seed: SEED, totalBytes: 256 * MiB, blockBytes: 1 * MiB, createdAt: "2026-09-26T00:00:00.000Z" });
  assert.equal(parseMetadata(text).ok, true);
  const valid = JSON.parse(text);
  const invalid = [
    "{",
    "[]",
    "x".repeat(LIMITS.maxMetadataChars + 1),
    JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, name: "../../etc/passwd" }),
    JSON.stringify({ ...valid, seed: -1 }),
    JSON.stringify({ ...valid, totalBytes: 4 * GiB }),
    JSON.stringify({ ...valid, blockBytes: 1 }),
    JSON.stringify({ ...valid, createdAt: 7 }),
  ];
  for (const bad of invalid) assert.equal(parseMetadata(bad).ok, false, bad.slice(0, 60));

  assert.equal(formatBytes(1 * GiB), "1.00 GiB");
  assert.equal(formatBytes(-2 * MiB), "−2.00 MiB");
});

test("incremental write reuses one bounded block and verifies byte-exactly", async () => {
  const { directory } = await freshDirectory();
  const handle = await directory.getFileHandle(makeEntryName("st", 2 * MiB, "00000001"), { create: true });
  const size = 2 * MiB + 123;
  const progress = [];
  const write = await writePatternRange(handle, { end: size, blockBytes: 64 * KiB, seed: SEED, onProgress: (done) => progress.push(done) });

  assert.equal(write.bytesWritten, size);
  assert.equal(write.blocks, Math.ceil(size / (64 * KiB)));
  assert.equal(handle.bytes.length, size);
  assert.equal(handle.lastWritable.sourceBuffers.size, 1, "one reusable block buffer");
  assert.equal(handle.lastWritable.maxWriteBytes, 64 * KiB);
  assert.equal(progress.at(-1), size);

  const ranges = await verifyRanges(handle, verificationRanges(size, 16 * KiB), SEED);
  assert.equal(ranges.ok, true);
  const sequential = await verifySequential(handle, { seed: SEED, expectedBytes: size, blockBytes: 256 * KiB });
  assert.equal(sequential.ok, true);
  assert.equal(sequential.bytesRead, size);

  assert.equal((await verifySequential(handle, { seed: SEED, expectedBytes: size + 1, blockBytes: 256 * KiB })).ok, false);
  assert.equal((await verifyRanges(handle, [{ label: "wrong seed", offset: 0, length: 4096 }], SEED + 1)).ok, false);
});

test("resume from the stored size keeps the boundary intact and refuses wrong offsets", async () => {
  const { directory } = await freshDirectory();
  const handle = await directory.getFileHandle(makeEntryName("resume", 3 * MiB, "00000002"), { create: true });
  const boundary = 1 * MiB + 4099;
  const total = 3 * MiB;
  await writePatternRange(handle, { end: boundary, blockBytes: 64 * KiB, seed: SEED });
  assert.equal(handle.bytes.length, boundary);

  await assert.rejects(writePatternRange(handle, { start: boundary + 1, end: total, blockBytes: 64 * KiB, seed: SEED, keepExistingData: true }), RangeError);
  await assert.rejects(writePatternRange(handle, { start: 4096, end: total, blockBytes: 64 * KiB, seed: SEED }), RangeError);

  const resumed = await writePatternRange(handle, { start: boundary, end: total, blockBytes: 64 * KiB, seed: SEED, keepExistingData: true });
  assert.equal(resumed.existingBytes, boundary);
  assert.equal(resumed.bytesWritten, total - boundary);
  assert.equal((await verifyRanges(handle, boundaryRanges(boundary, total, 8 * KiB), SEED)).ok, true);
  assert.equal((await verifySequential(handle, { seed: SEED, expectedBytes: total, blockBytes: 128 * KiB })).ok, true);
});

test("quota failure and abort stop cleanly without committing partial data", async () => {
  const { directory } = await freshDirectory();
  const handle = await directory.getFileHandle(makeEntryName("st", 4 * MiB, "00000003"), { create: true });
  handle.quotaBytes = 1 * MiB + 1;
  await assert.rejects(
    writePatternRange(handle, { end: 4 * MiB, blockBytes: 256 * KiB, seed: SEED }),
    (error) => error.name === "QuotaExceededError" && error.bytesWritten === 1 * MiB,
  );
  assert.equal(handle.lastWritable.aborted, true);
  assert.equal(handle.bytes.length, 0, "nothing committed");

  handle.quotaBytes = Infinity;
  const controller = new AbortController();
  await assert.rejects(
    writePatternRange(handle, {
      end: 4 * MiB,
      blockBytes: 256 * KiB,
      seed: SEED,
      signal: controller.signal,
      onBlock: (done) => done >= 1 * MiB && controller.abort(),
    }),
    (error) => error.name === "AbortError",
  );
  assert.equal(handle.lastWritable.aborted, true);
  assert.equal(handle.bytes.length, 0);
});

test("a single corrupted stored byte is detected at its exact offset", async () => {
  const { directory } = await freshDirectory();
  const handle = await directory.getFileHandle(makeEntryName("probe", 1 * MiB, "00000004"), { create: true });
  await writePatternRange(handle, { end: 1 * MiB, blockBytes: 64 * KiB, seed: SEED });
  handle.bytes[500_001] ^= 0xff;
  const ranges = await verifyRanges(handle, [{ label: "covers", offset: 499_000, length: 4096 }], SEED);
  assert.equal(ranges.results[0].detail, "mismatch at absolute byte 500001");
  const sequential = await verifySequential(handle, { seed: SEED, expectedBytes: 1 * MiB, blockBytes: 64 * KiB });
  assert.equal(sequential.detail, "mismatch at absolute byte 500001");
});

test("deletion confirms absence, refuses foreign names, and clear removes only the spike directory", async () => {
  const { root, directory } = await freshDirectory();
  await root.getFileHandle("unrelated-app-file", { create: true });
  const name = makeEntryName("st", 1 * MiB, "00000005");
  await writePatternRange(await directory.getFileHandle(name, { create: true }), { end: 1 * MiB, blockBytes: 1 * MiB, seed: SEED });
  assert.equal(await exists(directory, name), true);

  assert.deepEqual(await deleteEntry(directory, name), { name, absent: true });
  assert.deepEqual(await deleteEntry(directory, name), { name, absent: true }, "idempotent");
  await assert.rejects(deleteEntry(directory, "unrelated-app-file"), RangeError);
  await assert.rejects(deleteEntry(directory, "../st-1m-00000005.bin"), RangeError);

  await writePatternRange(await directory.getFileHandle(makeEntryName("st", 1 * MiB, "00000006"), { create: true }), { end: 1 * MiB, blockBytes: 1 * MiB, seed: SEED });
  const cleared = await clearSpikeStorage(root);
  assert.equal(cleared.removed, true);
  assert.equal(cleared.absent, true);
  assert.deepEqual(cleared.rootNames, ["unrelated-app-file"]);
  assert.equal((await clearSpikeStorage(root)).removed, false);
  assert.equal(root.children.has(SPIKE_DIRECTORY), false);
});

test("entry listing is bounded and flags unrecognized names", async () => {
  const { directory } = await freshDirectory();
  for (let i = 0; i < LIMITS.maxListedEntries + 5; i += 1) {
    await directory.getFileHandle(i === 0 ? "<script>alert(1)</script>" : makeEntryName("st", 1 * MiB, i.toString(16).padStart(8, "0")), { create: true });
  }
  const listing = await listEntries(directory);
  assert.equal(listing.entries.length, LIMITS.maxListedEntries);
  assert.equal(listing.truncated, true);
  assert.equal(listing.entries[0].recognized, false);
  assert.equal(listing.entries[1].recognized, true);
  assert.equal(listing.entries[1].bytes, 0);
});
