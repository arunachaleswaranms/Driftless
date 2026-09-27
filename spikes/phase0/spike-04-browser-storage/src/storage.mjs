// Experimental Spike 0.4 OPFS operations over the File System Access handle interfaces.
// Everything here works one bounded block or range at a time; no function materializes a
// whole test file in JavaScript memory. This is laboratory code, not a production cache.

import {
  LIMITS,
  SPIKE_DIRECTORY,
  blockRanges,
  fillPattern,
  findPatternMismatch,
  isSpikeEntryName,
  isSpikeMetadataName,
} from "./plan.mjs";

const now = () => performance.now();

export function describeError(error) {
  if (!error) return "unknown error";
  const name = typeof error.name === "string" ? error.name : "Error";
  const message = typeof error.message === "string" ? error.message.slice(0, 200) : "";
  return message ? `${name}: ${message}` : name;
}

export function isQuotaError(error) {
  return error?.name === "QuotaExceededError";
}

function abortError() {
  return new DOMException("operation aborted", "AbortError");
}

export async function openSpikeDirectory(root) {
  return root.getDirectoryHandle(SPIKE_DIRECTORY, { create: true });
}

// Writes deterministic bytes for [start, end) through createWritable(). A fresh write must start
// at 0. A resume must use keepExistingData and start exactly at the stored size, so a resumed
// writer can never leave a hole or overwrite verified data.
export async function writePatternRange(
  fileHandle,
  { start = 0, end, blockBytes, seed, keepExistingData = false, signal, onProgress, onBlock } = {},
) {
  if (!Number.isSafeInteger(end) || end <= start) throw new RangeError("write range is empty or invalid");
  if (!Number.isSafeInteger(blockBytes) || blockBytes < LIMITS.minBlockBytes || blockBytes > LIMITS.maxBlockBytes) {
    throw new RangeError("block size is out of bounds");
  }

  const existingBytes = (await fileHandle.getFile()).size;
  if (keepExistingData ? start !== existingBytes : start !== 0) {
    throw new RangeError(`write must start at ${keepExistingData ? existingBytes : 0}, not ${start}`);
  }

  const startedAt = now();
  const writable = await fileHandle.createWritable({ keepExistingData });
  const openMs = now() - startedAt;
  const progress = { bytesWritten: 0, blocks: 0 };
  try {
    await writeBlocks(writable, { start, end, blockBytes, seed, signal, onProgress, onBlock, progress });
    const closeStartedAt = now();
    await writable.close();
    const closeMs = now() - closeStartedAt;
    onProgress?.(progress.bytesWritten);
    return { ...progress, existingBytes, openMs, closeMs, totalMs: now() - startedAt };
  } catch (error) {
    try {
      await writable.abort();
    } catch {
      // The stream may already be errored or closed; the original error is reported.
    }
    error.bytesWritten = progress.bytesWritten;
    throw error;
  }
}

// Generates, writes, and discards one block at a time into an open writable stream. It reuses a
// single block buffer and awaits each write before refilling it. It neither closes nor aborts.
export async function writeBlocks(writable, { start = 0, end, blockBytes, seed, signal, onProgress, onBlock, progress = { bytesWritten: 0, blocks: 0 } }) {
  if (start > 0) await writable.seek(start);
  const block = new Uint8Array(blockBytes);
  for (const { offset, length } of blockRanges(start, end, blockBytes)) {
    if (signal?.aborted) throw abortError();
    const view = length === blockBytes ? block : block.subarray(0, length);
    fillPattern(view, offset, seed);
    await writable.write(view);
    progress.bytesWritten += length;
    progress.blocks += 1;
    onBlock?.(progress.bytesWritten);
    if (progress.blocks % 16 === 0) onProgress?.(progress.bytesWritten);
  }
  return progress;
}

async function readRange(file, offset, length) {
  return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
}

// Reads only the selected ranges and compares each with the deterministic generator.
export async function verifyRanges(fileHandle, ranges, seed) {
  const file = await fileHandle.getFile();
  const results = [];
  let bytesRead = 0;
  const startedAt = now();
  for (const range of ranges) {
    if (range.length > LIMITS.maxRangeBytes) throw new RangeError("verification range exceeds the bound");
    const rangeStartedAt = now();
    const bytes = await readRange(file, range.offset, range.length);
    bytesRead += bytes.length;
    const mismatch = bytes.length === range.length ? findPatternMismatch(bytes, range.offset, seed) : -2;
    results.push({
      ...range,
      ok: mismatch === -1,
      detail:
        mismatch === -1
          ? "match"
          : mismatch === -2
            ? `short read: ${bytes.length} of ${range.length} bytes`
            : `mismatch at absolute byte ${range.offset + mismatch}`,
      ms: now() - rangeStartedAt,
    });
  }
  return { ok: results.every((result) => result.ok), fileBytes: file.size, bytesRead, results, ms: now() - startedAt };
}

// Byte-exact verification of the whole stored file, streamed in bounded blocks.
export async function verifySequential(fileHandle, { seed, expectedBytes, blockBytes, signal, onProgress } = {}) {
  const file = await fileHandle.getFile();
  const startedAt = now();
  if (file.size !== expectedBytes) {
    return { ok: false, fileBytes: file.size, bytesRead: 0, detail: `size ${file.size} ≠ expected ${expectedBytes}`, ms: 0 };
  }
  let bytesRead = 0;
  let blocks = 0;
  for (const { offset, length } of blockRanges(0, expectedBytes, blockBytes)) {
    if (signal?.aborted) throw abortError();
    const bytes = await readRange(file, offset, length);
    bytesRead += bytes.length;
    blocks += 1;
    const mismatch = bytes.length === length ? findPatternMismatch(bytes, offset, seed) : 0;
    if (mismatch !== -1) {
      return { ok: false, fileBytes: file.size, bytesRead, detail: `mismatch at absolute byte ${offset + mismatch}`, ms: now() - startedAt };
    }
    if (blocks % 16 === 0) onProgress?.(bytesRead);
  }
  onProgress?.(bytesRead);
  return { ok: true, fileBytes: file.size, bytesRead, detail: "every byte matches the generator", ms: now() - startedAt };
}

export async function writeText(directory, name, text) {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(text);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}

export async function readBoundedText(directory, name, maxChars = LIMITS.maxMetadataChars) {
  const file = await (await directory.getFileHandle(name)).getFile();
  if (file.size > maxChars * 4) throw new RangeError("stored text exceeds the size bound");
  return file.text();
}

export async function exists(directory, name) {
  try {
    await directory.getFileHandle(name);
    return true;
  } catch (error) {
    if (error?.name === "NotFoundError") return false;
    throw error;
  }
}

// Removes one spike entry and confirms that a subsequent lookup reports it absent.
export async function deleteEntry(directory, name) {
  if (!isSpikeEntryName(name) && !isSpikeMetadataName(name)) throw new RangeError("refusing to delete a non-spike entry");
  try {
    await directory.removeEntry(name);
  } catch (error) {
    if (error?.name !== "NotFoundError") throw error;
  }
  return { name, absent: !(await exists(directory, name)) };
}

export async function listEntries(directory) {
  const entries = [];
  let truncated = false;
  for await (const [name, handle] of directory.entries()) {
    if (entries.length >= LIMITS.maxListedEntries) {
      truncated = true;
      break;
    }
    const entry = { name, kind: handle.kind, recognized: isSpikeEntryName(name) || isSpikeMetadataName(name) };
    if (handle.kind === "file") {
      try {
        entry.bytes = (await handle.getFile()).size;
      } catch (error) {
        entry.error = describeError(error);
      }
    }
    entries.push(entry);
  }
  return { entries, truncated };
}

// Clear Spike Storage: removes only this experiment's directory, then confirms absence.
export async function clearSpikeStorage(root) {
  let removed = true;
  try {
    await root.removeEntry(SPIKE_DIRECTORY, { recursive: true });
  } catch (error) {
    if (error?.name !== "NotFoundError") throw error;
    removed = false;
  }
  let absent = false;
  try {
    await root.getDirectoryHandle(SPIKE_DIRECTORY);
  } catch (error) {
    if (error?.name !== "NotFoundError") throw error;
    absent = true;
  }
  const rootNames = [];
  for await (const name of root.keys()) {
    if (rootNames.length >= LIMITS.maxListedEntries) break;
    rootNames.push(name);
  }
  return { removed, absent, rootNames };
}
