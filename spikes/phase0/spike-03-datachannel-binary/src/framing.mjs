// Experimental Spike 0.3 framing and validation. This is laboratory framing only and is
// not the Driftless production protocol or wire format.

export const KiB = 1024;
export const MiB = 1024 * KiB;

export const FRAME_MAGIC = 0x444c5433; // "DLT3"
export const FRAME_VERSION = 1;
export const FRAME_KIND_CHUNK = 1;
export const DIGEST_BYTES = 32;
export const FIXED_HEADER_BYTES = 24;
export const HEADER_BYTES = FIXED_HEADER_BYTES + DIGEST_BYTES;

export const LIMITS = Object.freeze({
  minChunkBytes: 4 * KiB,
  maxChunkBytes: 1 * MiB,
  maxTotalBytes: 256 * MiB,
  maxTotalChunks: 65536,
  maxControlChars: 8192,
  maxReasonChars: 200,
  maxReasons: 20,
});

export const FAULT_MODES = Object.freeze([
  "none",
  "corrupt-byte",
  "drop-chunk",
  "duplicate-chunk",
  "reorder-chunks",
  "malformed-frame",
]);

const CONTROL_TYPES = new Set(["begin", "accept", "reject", "end", "result", "abort"]);

function isUint32(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function planTransfer({ totalBytes, chunkSize, maxMessageSize } = {}) {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 1 || totalBytes > LIMITS.maxTotalBytes) {
    return { ok: false, error: `total bytes must be an integer from 1 to ${LIMITS.maxTotalBytes}` };
  }
  if (
    !Number.isSafeInteger(chunkSize) ||
    chunkSize < LIMITS.minChunkBytes ||
    chunkSize > LIMITS.maxChunkBytes
  ) {
    return {
      ok: false,
      error: `chunk size must be an integer from ${LIMITS.minChunkBytes} to ${LIMITS.maxChunkBytes}`,
    };
  }

  const totalChunks = Math.ceil(totalBytes / chunkSize);
  if (totalChunks > LIMITS.maxTotalChunks) {
    return { ok: false, error: `transfer would need more than ${LIMITS.maxTotalChunks} chunks` };
  }

  const frameBytes = chunkSize + HEADER_BYTES;
  if (Number.isFinite(maxMessageSize) && maxMessageSize > 0 && frameBytes > maxMessageSize) {
    return {
      ok: false,
      error: `frame of ${frameBytes} bytes exceeds the negotiated SCTP maxMessageSize of ${maxMessageSize} bytes`,
    };
  }

  return { ok: true, plan: { totalBytes, chunkSize, totalChunks, frameBytes } };
}

export function chunkLength(plan, sequence) {
  return sequence < plan.totalChunks - 1
    ? plan.chunkSize
    : plan.totalBytes - plan.chunkSize * (plan.totalChunks - 1);
}

// Deterministic 32-bit mixer (lowbias32). Each 4-byte word of the synthetic payload is derived
// from its absolute word index and a per-transfer seed, so either peer can regenerate any range
// without materializing the whole payload.
export function mixWord(index, seed) {
  let x = ((index ^ seed) + 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

export function patternByte(offset, seed) {
  return (mixWord(Math.floor(offset / 4), seed) >>> ((offset % 4) * 8)) & 0xff;
}

export function fillPattern(target, offset, seed) {
  const length = target.length;
  let i = 0;
  for (; i < length && (offset + i) % 4 !== 0; i += 1) target[i] = patternByte(offset + i, seed);
  const view = new DataView(target.buffer, target.byteOffset, length);
  for (; i + 4 <= length; i += 4) view.setUint32(i, mixWord((offset + i) / 4, seed), true);
  for (; i < length; i += 1) target[i] = patternByte(offset + i, seed);
}

export function findPatternMismatch(bytes, offset, seed) {
  const length = bytes.length;
  let i = 0;
  for (; i < length && (offset + i) % 4 !== 0; i += 1) {
    if (bytes[i] !== patternByte(offset + i, seed)) return i;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, length);
  for (; i + 4 <= length; i += 4) {
    if (view.getUint32(i, true) !== mixWord((offset + i) / 4, seed)) {
      for (let lane = 0; lane < 4; lane += 1) {
        if (bytes[i + lane] !== patternByte(offset + i + lane, seed)) return i + lane;
      }
    }
  }
  for (; i < length; i += 1) {
    if (bytes[i] !== patternByte(offset + i, seed)) return i;
  }
  return -1;
}

export function writeChunkHeader(frame, { transferId, sequence, totalChunks, payloadBytes, digest }) {
  const view = new DataView(frame.buffer, frame.byteOffset, HEADER_BYTES);
  view.setUint32(0, FRAME_MAGIC);
  view.setUint8(4, FRAME_VERSION);
  view.setUint8(5, FRAME_KIND_CHUNK);
  view.setUint16(6, HEADER_BYTES);
  view.setUint32(8, transferId);
  view.setUint32(12, sequence);
  view.setUint32(16, totalChunks);
  view.setUint32(20, payloadBytes);
  frame.set(digest, FIXED_HEADER_BYTES);
}

export function decodeChunkFrame(data, { maxPayloadBytes = LIMITS.maxChunkBytes } = {}) {
  if (!(data instanceof ArrayBuffer)) return { ok: false, error: "binary frame must be an ArrayBuffer" };
  if (data.byteLength < HEADER_BYTES) return { ok: false, error: "frame is shorter than the header" };

  const view = new DataView(data);
  if (view.getUint32(0) !== FRAME_MAGIC) return { ok: false, error: "frame magic is invalid" };
  if (view.getUint8(4) !== FRAME_VERSION) return { ok: false, error: "frame version is unsupported" };
  if (view.getUint8(5) !== FRAME_KIND_CHUNK) return { ok: false, error: "frame kind is unsupported" };
  if (view.getUint16(6) !== HEADER_BYTES) return { ok: false, error: "frame header length is invalid" };

  const payloadBytes = view.getUint32(20);
  if (payloadBytes !== data.byteLength - HEADER_BYTES) {
    return { ok: false, error: "declared payload length does not match frame length" };
  }
  if (payloadBytes < 1 || payloadBytes > maxPayloadBytes) {
    return { ok: false, error: "payload length is outside the accepted bound" };
  }

  return {
    ok: true,
    frame: {
      transferId: view.getUint32(8),
      sequence: view.getUint32(12),
      totalChunks: view.getUint32(16),
      payloadBytes,
      digest: new Uint8Array(data, FIXED_HEADER_BYTES, DIGEST_BYTES),
      payload: new Uint8Array(data, HEADER_BYTES, payloadBytes),
    },
  };
}

export function malformedFrame() {
  const frame = new Uint8Array(HEADER_BYTES + 16);
  new DataView(frame.buffer).setUint32(0, 0xdeadbeef);
  return frame;
}

export function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function boundedReason(value) {
  return typeof value === "string" && value.length <= LIMITS.maxReasonChars;
}

function fail(error) {
  return { ok: false, error };
}

export function parseControlMessage(text) {
  if (typeof text !== "string") return fail("control message must be text");
  if (text.length > LIMITS.maxControlChars) return fail("control message exceeds the size bound");

  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return fail("control message is not valid JSON");
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return fail("control message must be a JSON object");
  }
  if (!CONTROL_TYPES.has(message.type)) return fail("control message type is unknown");
  if (!isUint32(message.transferId)) return fail("transferId must be an unsigned 32-bit integer");

  switch (message.type) {
    case "begin": {
      const planned = planTransfer(message);
      if (!planned.ok) return fail(`begin rejected: ${planned.error}`);
      if (message.totalChunks !== planned.plan.totalChunks) {
        return fail("begin totalChunks does not match totalBytes and chunkSize");
      }
      if (!isUint32(message.seed)) return fail("begin seed must be an unsigned 32-bit integer");
      if (!FAULT_MODES.includes(message.faultMode)) return fail("begin faultMode is unknown");
      break;
    }
    case "end":
      if (!isCount(message.totalChunks) || !isCount(message.totalBytes) || !isCount(message.framesSent)) {
        return fail("end counts must be non-negative integers");
      }
      if (typeof message.manifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(message.manifestSha256)) {
        return fail("end manifestSha256 must be 64 lowercase hex characters");
      }
      break;
    case "reject":
    case "abort":
      if (!boundedReason(message.reason)) return fail(`${message.type} reason must be bounded text`);
      break;
    case "result":
      if (typeof message.ok !== "boolean") return fail("result ok must be boolean");
      if (
        !Array.isArray(message.reasons) ||
        message.reasons.length > LIMITS.maxReasons ||
        !message.reasons.every(boundedReason)
      ) {
        return fail("result reasons must be a bounded array of bounded text");
      }
      for (const field of ["bytesReceived", "chunksReceived", "maxPendingBytes"]) {
        if (!isCount(message[field])) return fail(`result ${field} must be a non-negative integer`);
      }
      if (!Number.isFinite(message.receiveMs) || message.receiveMs < 0) {
        return fail("result receiveMs must be a non-negative number");
      }
      break;
    default:
      break;
  }

  return { ok: true, message };
}
