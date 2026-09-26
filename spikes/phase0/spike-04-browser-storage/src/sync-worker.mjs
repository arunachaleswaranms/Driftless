// Experimental Spike 0.4 dedicated worker for the optional FileSystemSyncAccessHandle path.
// It writes and reads one bounded block at a time and never holds a whole test file in memory.

import { LIMITS, SPIKE_DIRECTORY, blockRanges, fillPattern, findPatternMismatch, isSpikeEntryName } from "./plan.mjs";

let held = null; // { name, handle } kept open only between "write" with hold=true and "release".

function describe(error) {
  return `${error?.name ?? "Error"}: ${String(error?.message ?? "").slice(0, 200)}`;
}

async function fileHandleFor(name, create) {
  if (!isSpikeEntryName(name)) throw new RangeError("refusing a non-spike entry name");
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle(SPIKE_DIRECTORY, { create: true });
  return directory.getFileHandle(name, { create });
}

function verifyWithHandle(handle, ranges, seed) {
  return ranges.map((range) => {
    if (range.length > LIMITS.maxRangeBytes) throw new RangeError("verification range exceeds the bound");
    const bytes = new Uint8Array(range.length);
    const read = handle.read(bytes, { at: range.offset });
    const mismatch = read === range.length ? findPatternMismatch(bytes, range.offset, seed) : -2;
    return { ...range, ok: mismatch === -1, detail: mismatch === -1 ? "match" : mismatch === -2 ? `short read ${read}` : `mismatch at ${range.offset + mismatch}` };
  });
}

const ops = {
  capabilities() {
    return {
      createSyncAccessHandle:
        typeof FileSystemFileHandle !== "undefined" &&
        typeof FileSystemFileHandle.prototype.createSyncAccessHandle === "function",
      getDirectory: typeof navigator.storage?.getDirectory === "function",
    };
  },

  // Writes [start, end) in place. A resume must start exactly at the stored size.
  async write({ name, start, end, blockBytes, seed, flushEveryBytes, hold, readBackRanges }) {
    if (held) throw new Error("a sync access handle is already held");
    if (!Number.isSafeInteger(end) || end <= start || end > LIMITS.maxTestBytes) throw new RangeError("write range is invalid");
    if (!Number.isSafeInteger(blockBytes) || blockBytes < LIMITS.minBlockBytes || blockBytes > LIMITS.maxBlockBytes) {
      throw new RangeError("block size is out of bounds");
    }
    const fileHandle = await fileHandleFor(name, true);
    const openedAt = performance.now();
    const handle = await fileHandle.createSyncAccessHandle();
    const openMs = performance.now() - openedAt;
    try {
      const existingBytes = handle.getSize();
      if (start !== existingBytes) throw new RangeError(`write must start at ${existingBytes}, not ${start}`);
      const block = new Uint8Array(blockBytes);
      let bytesWritten = 0;
      let flushes = 0;
      let sinceFlush = 0;
      for (const { offset, length } of blockRanges(start, end, blockBytes)) {
        const view = length === blockBytes ? block : block.subarray(0, length);
        fillPattern(view, offset, seed);
        const written = handle.write(view, { at: offset });
        if (written !== length) throw new Error(`short write at ${offset}: ${written} of ${length}`);
        bytesWritten += written;
        sinceFlush += written;
        if (flushEveryBytes && sinceFlush >= flushEveryBytes) {
          handle.flush();
          flushes += 1;
          sinceFlush = 0;
        }
      }
      handle.flush();
      flushes += 1;
      const readBack = readBackRanges ? verifyWithHandle(handle, readBackRanges, seed) : [];
      const result = { existingBytes, bytesWritten, sizeAfter: handle.getSize(), flushes, openMs, totalMs: performance.now() - openedAt, readBack };
      if (hold) held = { name, handle };
      else handle.close();
      return result;
    } catch (error) {
      handle.close();
      throw error;
    }
  },

  // Tries to open a second sync access handle while one is held in this worker.
  async probeSecondHandle({ name }) {
    const fileHandle = await fileHandleFor(name, false);
    try {
      const second = await fileHandle.createSyncAccessHandle();
      second.close();
      return { opened: true };
    } catch (error) {
      return { opened: false, error: describe(error) };
    }
  },

  release() {
    if (!held) return { released: false };
    held.handle.close();
    held = null;
    return { released: true };
  },
};

self.addEventListener("message", async (event) => {
  const { id, op, args } = event.data ?? {};
  if (!Object.hasOwn(ops, op)) {
    self.postMessage({ id, ok: false, error: "unknown worker operation" });
    return;
  }
  try {
    self.postMessage({ id, ok: true, result: await ops[op](args ?? {}) });
  } catch (error) {
    self.postMessage({ id, ok: false, error: describe(error) });
  }
});
