// EXPERIMENT ONLY. One bounded binary frame carries one part of an fMP4 fragment.
// The accompanying PART_INFO control message declares its exact size and SHA-256.
import { waitForBufferedAmountLow } from "../../spike-03-datachannel-binary/src/sender.mjs";

export const LIMITS = Object.freeze({
  chunkBytes: 64 * 1024,
  headerBytes: 32,
  maxPartBytes: 16 * 1024 * 1024,
  maxChunks: 256,
  highWaterBytes: 512 * 1024,
  lowWaterBytes: 128 * 1024,
  maxControlChars: 8192,
});
const MAGIC = 0x44534b37; // DSK7
const VERSION = 1;
const isU32 = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;

export function partKey(generation, segment, track) {
  return `${generation}:${segment}:${track}`;
}

export function validatePartInfo(m, transferId, generation, trackIds, segmentCount) {
  if (m?.type !== "PART_INFO" || m.transferId !== transferId || m.generation !== generation) return "unexpected transfer or generation";
  if (!Number.isInteger(m.segment) || m.segment < -1 || m.segment >= segmentCount) return "invalid segment";
  if (!trackIds.includes(m.track)) return "invalid track";
  if (!Number.isInteger(m.bytes) || m.bytes < 1 || m.bytes > LIMITS.maxPartBytes) return "invalid part size";
  if (m.chunks !== Math.ceil(m.bytes / LIMITS.chunkBytes) || m.chunks > LIMITS.maxChunks) return "invalid chunk count";
  if (typeof m.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.sha256)) return "invalid digest";
  if (m.segment >= 0 && (!(Number.isFinite(m.start) && Number.isFinite(m.end)) || m.start < 0 || m.end <= m.start)) return "invalid time range";
  return null;
}

export function encodeFrame({ transferId, generation, segment, track, sequence, chunks, bytes }) {
  if (![transferId, generation, track].every(isU32) || !Number.isInteger(segment) || segment < -1 || !isU32(sequence) || !isU32(chunks) || !(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > LIMITS.chunkBytes) throw new RangeError("invalid transport frame");
  const out = new Uint8Array(LIMITS.headerBytes + bytes.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, MAGIC); v.setUint8(4, VERSION); v.setUint8(5, 0); v.setUint16(6, LIMITS.headerBytes);
  v.setUint32(8, transferId); v.setUint32(12, generation); v.setInt32(16, segment);
  v.setUint32(20, track); v.setUint16(24, sequence); v.setUint16(26, chunks); v.setUint32(28, bytes.length);
  out.set(bytes, LIMITS.headerBytes);
  return out;
}

export function decodeFrame(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < LIMITS.headerBytes || buffer.byteLength > LIMITS.headerBytes + LIMITS.chunkBytes) throw new RangeError("frame size");
  const v = new DataView(buffer);
  if (v.getUint32(0) !== MAGIC || v.getUint8(4) !== VERSION || v.getUint8(5) !== 0 || v.getUint16(6) !== LIMITS.headerBytes) throw new RangeError("frame header");
  const length = v.getUint32(28);
  if (length !== buffer.byteLength - LIMITS.headerBytes || length < 1) throw new RangeError("frame payload size");
  return { transferId: v.getUint32(8), generation: v.getUint32(12), segment: v.getInt32(16), track: v.getUint32(20), sequence: v.getUint16(24), chunks: v.getUint16(26), bytes: new Uint8Array(buffer, LIMITS.headerBytes) };
}

export async function sha256(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (n) => n.toString(16).padStart(2, "0")).join("");
}

export class Reassembly {
  constructor({ transferId, generation, trackIds, segmentCount }) {
    Object.assign(this, { transferId, generation, trackIds, segmentCount });
    this.part = null;
    this.duplicates = 0;
    this.rejected = 0;
    this.maxHeldBytes = 0;
  }
  begin(info) {
    const error = validatePartInfo(info, this.transferId, this.generation, this.trackIds, this.segmentCount);
    if (error) { this.rejected++; throw new RangeError(error); }
    if (this.part) { this.rejected++; throw new RangeError("part already in progress"); }
    this.part = { info, chunks: new Array(info.chunks), received: 0, heldBytes: 0 };
  }
  accept(buffer) {
    let frame;
    try { frame = decodeFrame(buffer); } catch (e) { this.rejected++; throw e; }
    const p = this.part;
    if (!p || frame.transferId !== this.transferId || frame.generation !== this.generation || frame.segment !== p.info.segment || frame.track !== p.info.track || frame.chunks !== p.info.chunks || frame.sequence >= p.info.chunks) { this.rejected++; throw new RangeError("unexpected chunk identity or sequence"); }
    const expected = Math.min(LIMITS.chunkBytes, p.info.bytes - frame.sequence * LIMITS.chunkBytes);
    if (frame.bytes.length !== expected) { this.rejected++; throw new RangeError("unexpected chunk length"); }
    if (p.chunks[frame.sequence]) { this.duplicates++; throw new RangeError("duplicate chunk"); }
    p.chunks[frame.sequence] = frame.bytes.slice();
    p.received++;
    p.heldBytes += frame.bytes.length;
    this.maxHeldBytes = Math.max(this.maxHeldBytes, p.heldBytes);
    return p.received === p.info.chunks;
  }
  async complete() {
    const p = this.part;
    if (!p || p.received !== p.info.chunks || p.heldBytes !== p.info.bytes || p.chunks.some((c) => !c)) throw new RangeError("missing chunks or incorrect byte count");
    const bytes = new Uint8Array(p.info.bytes);
    let offset = 0;
    for (const chunk of p.chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    this.part = null;
    if (await sha256(bytes) !== p.info.sha256) { this.rejected++; throw new RangeError("part digest mismatch"); }
    return { info: p.info, bytes };
  }
  reset(generation) { this.part = null; this.generation = generation; }
}

export async function sendPart({ channel, bytes, info, signal, stats, isCurrent = () => true }) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== info.bytes || bytes.length > LIMITS.maxPartBytes) throw new RangeError("part size");
  const maxMessage = channel._pcMaxMessageSize;
  if (Number.isFinite(maxMessage) && maxMessage > 0 && LIMITS.chunkBytes + LIMITS.headerBytes > maxMessage) throw new RangeError("negotiated maxMessageSize too small");
  channel.bufferedAmountLowThreshold = LIMITS.lowWaterBytes;
  for (let sequence = 0; sequence < info.chunks; sequence++) {
    if (signal?.aborted || !isCurrent()) return false;
    if (channel.bufferedAmount > LIMITS.highWaterBytes) {
      stats.backpressurePauses++;
      await waitForBufferedAmountLow(channel, signal);
      stats.backpressureResumes++;
    }
    if (signal?.aborted || !isCurrent()) return false;
    const frame = encodeFrame({ ...info, sequence, bytes: bytes.subarray(sequence * LIMITS.chunkBytes, Math.min(bytes.length, (sequence + 1) * LIMITS.chunkBytes)) });
    channel.send(frame);
    stats.chunksSent++;
    stats.bytesSent += frame.byteLength - LIMITS.headerBytes;
    stats.peakBufferedAmount = Math.max(stats.peakBufferedAmount, channel.bufferedAmount);
  }
  return true;
}
