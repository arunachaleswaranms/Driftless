// Bounded, instrumented reads from a Blob-like source (a browser File, or a Node
// adapter exposing `size` and `slice(start, end).arrayBuffer()`).
//
// The reader issues one read at a time, so at most one block is in flight. It never
// calls `arrayBuffer()` on the whole source.

export const READ_LIMITS = Object.freeze({
  minBlockBytes: 16 * 1024,
  maxBlockBytes: 16 * 1024 * 1024,
  // Largest single explicit range read (moov pre-check, planned segment windows).
  maxRangeBytes: 128 * 1024 * 1024,
});

export const BLOCK_SIZE_CHOICES = Object.freeze([64 * 1024, 256 * 1024, 1024 * 1024, 4 * 1024 * 1024]);

export function validateBlockSize(blockSize) {
  if (!Number.isInteger(blockSize) || blockSize < READ_LIMITS.minBlockBytes || blockSize > READ_LIMITS.maxBlockBytes) {
    throw new RangeError(`Block size must be an integer between ${READ_LIMITS.minBlockBytes} and ${READ_LIMITS.maxBlockBytes} bytes`);
  }
  return blockSize;
}

/**
 * Merge-on-insert interval set used to count bytes read more than once. Bounded by
 * `maxIntervals`; beyond that it stops merging precisely and reports `saturated`.
 */
class CoverageSet {
  constructor(maxIntervals = 4096) {
    this.intervals = [];
    this.maxIntervals = maxIntervals;
    this.saturated = false;
  }

  /** Adds [start, end) and returns how many of its bytes were already covered. */
  add(start, end) {
    let overlap = 0;
    let newStart = start;
    let newEnd = end;
    const kept = [];
    for (const [s, e] of this.intervals) {
      if (e < start || s > end) {
        kept.push([s, e]);
        continue;
      }
      overlap += Math.max(0, Math.min(e, end) - Math.max(s, start));
      newStart = Math.min(newStart, s);
      newEnd = Math.max(newEnd, e);
    }
    kept.push([newStart, newEnd]);
    kept.sort((a, b) => a[0] - b[0]);
    if (kept.length > this.maxIntervals) {
      this.saturated = true;
      kept.splice(0, kept.length - this.maxIntervals);
    }
    this.intervals = kept;
    return overlap;
  }

  get coveredBytes() {
    return this.intervals.reduce((n, [s, e]) => n + (e - s), 0);
  }
}

export function createSourceReader(source, { blockSize, signal } = {}) {
  if (!source || !Number.isSafeInteger(source.size) || source.size < 0 || typeof source.slice !== "function") {
    throw new TypeError("Source must expose a non-negative integer size and slice()");
  }
  validateBlockSize(blockSize);
  const size = source.size;
  const coverage = new CoverageSet();
  const stats = {
    sourceSize: size,
    blockSize,
    reads: 0,
    bytesRead: 0,
    rereadBytes: 0,
    maxReadBytes: 0,
    maxInFlightBytes: 0,
    nonSequentialReads: 0,
    readMs: 0,
    log: [], // bounded list of notable (non-sequential) reads
  };
  let inFlight = 0;
  let lastEnd = 0;

  async function read(offset, length, reason) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) throw new RangeError(`Read offset ${offset} outside source`);
    if (!Number.isSafeInteger(length) || length < 0) throw new RangeError("Read length must be a non-negative integer");
    if (length > READ_LIMITS.maxRangeBytes) throw new RangeError(`Read of ${length} bytes exceeds the ${READ_LIMITS.maxRangeBytes}-byte spike limit`);
    if (inFlight > 0) throw new Error("Reader allows one read in flight");
    const end = Math.min(size, offset + length);
    inFlight = end - offset;
    stats.maxInFlightBytes = Math.max(stats.maxInFlightBytes, inFlight);
    const t0 = performance.now();
    try {
      const buffer = await source.slice(offset, end).arrayBuffer();
      if (buffer.byteLength !== end - offset) throw new Error(`Short read at ${offset}: ${buffer.byteLength} of ${end - offset} bytes`);
      stats.reads += 1;
      stats.bytesRead += buffer.byteLength;
      stats.maxReadBytes = Math.max(stats.maxReadBytes, buffer.byteLength);
      stats.rereadBytes += coverage.add(offset, end);
      if (offset !== lastEnd) {
        stats.nonSequentialReads += 1;
        if (stats.log.length < 64) stats.log.push({ offset, length: buffer.byteLength, from: lastEnd, reason });
      }
      lastEnd = end;
      return buffer;
    } finally {
      stats.readMs += performance.now() - t0;
      inFlight = 0;
    }
  }

  return {
    size,
    stats,
    /** Read one block starting at `offset` (shorter at end of file). */
    readBlock: (offset, reason) => read(offset, blockSize, reason),
    /** Read an explicit bounded range. */
    readRange: (offset, length, reason) => read(offset, length, reason),
    coverage: () => ({ coveredBytes: coverage.coveredBytes, saturated: coverage.saturated }),
  };
}

/** Node adapter: a Blob-like view of an open FileHandle without whole-file reads. */
export function fileHandleSource(handle, size) {
  const make = (start, end) => ({
    size: end - start,
    slice: (s = 0, e = end - start) => make(start + s, start + Math.min(e, end - start)),
    async arrayBuffer() {
      const out = new Uint8Array(end - start);
      let done = 0;
      while (done < out.length) {
        const { bytesRead } = await handle.read(out, done, out.length - done, start + done);
        if (bytesRead === 0) break;
        done += bytesRead;
      }
      return out.buffer.slice(0, done);
    },
  });
  return make(0, size);
}
