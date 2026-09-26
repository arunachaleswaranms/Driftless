// ISO BMFF box inspection that is independent of MP4Box.js.
//
// Used to (1) locate top-level boxes with header-only reads before any parser is
// involved, (2) bound the declared sample-table size of a moov before it reaches
// MP4Box.js, and (3) give the fMP4 verifier a strict box walker. All input is untrusted.

export const BOX_LIMITS = Object.freeze({
  maxTopLevelBoxes: 100_000,
  maxChildBoxes: 10_000,
  maxDepth: 12,
  // Largest moov the spike will hand to the parser. A crafted moov can claim any size;
  // MP4Box.js concatenates buffers until a box is complete, so the cap bounds that copy.
  maxMoovBytes: 128 * 1024 * 1024,
  // Largest per-track sample count the spike accepts (about 23 h at 60 fps). MP4Box.js
  // expands every sample-table entry into an object before `onReady`.
  maxSamplesPerTrack: 5_000_000,
  maxTotalSamples: 12_000_000,
});

const HEADER_PROBE_BYTES = 16;
const UINT32 = 2 ** 32;

export class BoxFormatError extends Error {
  constructor(code, message, offset) {
    super(message);
    this.name = "BoxFormatError";
    this.code = code;
    this.offset = offset;
  }
}

function isPrintableFourCC(view, pos) {
  for (let i = 0; i < 4; i += 1) {
    const c = view.getUint8(pos + i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

function fourCC(view, pos) {
  return String.fromCharCode(view.getUint8(pos), view.getUint8(pos + 1), view.getUint8(pos + 2), view.getUint8(pos + 3));
}

/**
 * Decode one box header at `pos` inside `view`. `limit` is the absolute end of the
 * enclosing range (file size or parent end) expressed in the same coordinates as
 * `absoluteStart + pos`. Returns sizes as safe integers or throws BoxFormatError.
 */
export function readBoxHeader(view, pos, { absoluteStart = 0, limit }) {
  const at = absoluteStart + pos;
  if (view.byteLength - pos < 8) throw new BoxFormatError("SHORT_HEADER", "Fewer than 8 bytes remain for a box header", at);
  const size32 = view.getUint32(pos);
  if (!isPrintableFourCC(view, pos + 4)) throw new BoxFormatError("BAD_TYPE", "Box type is not a printable four-character code", at);
  const type = fourCC(view, pos + 4);
  let headerSize = 8;
  let size;
  if (size32 === 1) {
    if (view.byteLength - pos < 16) throw new BoxFormatError("SHORT_HEADER", "Truncated 64-bit box size", at);
    const hi = view.getUint32(pos + 8);
    const lo = view.getUint32(pos + 12);
    size = hi * UINT32 + lo;
    if (!Number.isSafeInteger(size)) throw new BoxFormatError("SIZE_UNSAFE", "64-bit box size exceeds the safe integer range", at);
    headerSize = 16;
  } else if (size32 === 0) {
    size = limit - at; // box extends to the end of its container
  } else {
    size = size32;
  }
  if (type === "uuid") headerSize += 16;
  if (size < headerSize) throw new BoxFormatError("SIZE_TOO_SMALL", `Box '${type}' declares ${size} bytes, smaller than its header`, at);
  return { type, start: at, size, headerSize, extendsToEnd: size32 === 0, truncated: at + size > limit };
}

/**
 * Walk top-level boxes using one small read per box. `readRange(offset, length)` must
 * resolve to an ArrayBuffer. Stops at the first malformed or truncated box.
 */
export async function scanTopLevelBoxes(readRange, fileSize, { maxBoxes = BOX_LIMITS.maxTopLevelBoxes } = {}) {
  const boxes = [];
  let offset = 0;
  let headerReads = 0;
  let headerBytes = 0;
  let error;
  while (offset < fileSize) {
    if (boxes.length >= maxBoxes) {
      error = { code: "TOO_MANY_BOXES", message: `More than ${maxBoxes} top-level boxes`, offset };
      break;
    }
    const length = Math.min(HEADER_PROBE_BYTES, fileSize - offset);
    const buffer = await readRange(offset, length);
    headerReads += 1;
    headerBytes += buffer.byteLength;
    let box;
    try {
      box = readBoxHeader(new DataView(buffer), 0, { absoluteStart: offset, limit: fileSize });
    } catch (e) {
      if (!(e instanceof BoxFormatError)) throw e;
      error = { code: e.code, message: e.message, offset: e.offset };
      break;
    }
    boxes.push(box);
    if (box.truncated) {
      error = { code: "TRUNCATED_BOX", message: `Box '${box.type}' at ${box.start} extends ${box.start + box.size - fileSize} bytes past the end of the file`, offset: box.start };
      break;
    }
    offset = box.start + box.size;
  }
  return { boxes, headerReads, headerBytes, error };
}

/**
 * Summarise top-level layout for progressive access. Pure function of scan output.
 */
export function describeLayout(scan, fileSize) {
  const { boxes, error } = scan;
  const first = boxes[0];
  const index = (type) => boxes.findIndex((b) => b.type === type);
  const moovIndex = index("moov");
  const mdatIndex = index("mdat");
  const moov = moovIndex >= 0 ? boxes[moovIndex] : undefined;
  const hasMoof = boxes.some((b) => b.type === "moof");
  const looksIsoBmff = Boolean(first) && ["ftyp", "styp", "moov", "free", "skip", "wide", "mdat"].includes(first.type);
  let moovPlacement = "absent";
  if (moov) moovPlacement = mdatIndex === -1 || moovIndex < mdatIndex ? "before-mdat" : "after-mdat";
  const bytesBeforeMoov = moov ? moov.start : undefined;
  return {
    looksIsoBmff,
    firstBoxType: first?.type,
    topLevelTypes: summariseTypes(boxes),
    moovPlacement,
    moovOffset: moov?.start,
    moovSize: moov?.size,
    moovPositionFraction: moov && fileSize > 0 ? moov.start / fileSize : undefined,
    bytesBeforeMoov,
    hasTopLevelMoof: hasMoof,
    mdatCount: boxes.filter((b) => b.type === "mdat").length,
    usesLargeSize: boxes.some((b) => b.headerSize >= 16 && b.type !== "uuid"),
    scanError: error,
  };
}

function summariseTypes(boxes) {
  // Collapse runs (e.g. thousands of moof/mdat pairs) to keep evidence bounded.
  const out = [];
  for (const b of boxes) {
    const last = out[out.length - 1];
    if (last && last.type === b.type) last.count += 1;
    else if (out.length < 64) out.push({ type: b.type, count: 1, firstOffset: b.start });
  }
  return out;
}

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "mvex", "edts", "dinf", "moof", "traf", "udta"]);

/** Iterate direct children of a container payload within `view[begin, end)`. */
export function* childBoxes(view, begin, end, absoluteStart = 0, maxChildren = BOX_LIMITS.maxChildBoxes) {
  let pos = begin;
  let count = 0;
  while (pos < end) {
    if (count >= maxChildren) throw new BoxFormatError("TOO_MANY_BOXES", "Too many child boxes", absoluteStart + pos);
    if (end - pos < 8) throw new BoxFormatError("SHORT_HEADER", "Trailing bytes too short for a box header", absoluteStart + pos);
    const sub = new DataView(view.buffer, view.byteOffset + pos, end - pos);
    const box = readBoxHeader(sub, 0, { absoluteStart: absoluteStart + pos, limit: absoluteStart + end });
    if (box.truncated) throw new BoxFormatError("TRUNCATED_BOX", `Child box '${box.type}' exceeds its parent`, box.start);
    yield { ...box, payloadPos: pos + box.headerSize, endPos: pos + box.size };
    pos += box.size;
    count += 1;
  }
}

/**
 * Bound the declared sample tables of a complete moov payload before MP4Box.js expands
 * them. Reads only stsz/stz2/stts/stss counts. Returns per-track counts or throws.
 */
export function checkMoovBudget(moovBuffer, { limits = BOX_LIMITS } = {}) {
  const view = new DataView(moovBuffer);
  const top = readBoxHeader(view, 0, { limit: moovBuffer.byteLength });
  if (top.type !== "moov") throw new BoxFormatError("NOT_MOOV", `Expected moov, found '${top.type}'`, 0);
  if (top.size !== moovBuffer.byteLength) throw new BoxFormatError("SIZE_MISMATCH", "moov buffer length differs from its declared size", 0);
  const tracks = [];
  let hasMvex = false;
  const walk = (begin, end, depth, trackCtx) => {
    if (depth > limits.maxDepth) throw new BoxFormatError("TOO_DEEP", "Box nesting too deep", begin);
    for (const box of childBoxes(view, begin, end)) {
      if (box.type === "mvex") hasMvex = true;
      if (box.type === "trak") {
        const ctx = { sampleCount: undefined, sttsSamples: 0, syncSamples: undefined, sampleSizeConstant: undefined };
        walk(box.payloadPos, box.endPos, depth + 1, ctx);
        tracks.push(ctx);
        continue;
      }
      if (trackCtx && (box.type === "stsz" || box.type === "stz2")) {
        if (box.endPos - box.payloadPos < 12) throw new BoxFormatError("SHORT_BOX", `${box.type} too short`, box.start);
        const constant = box.type === "stsz" ? view.getUint32(box.payloadPos + 4) : 0;
        const count = view.getUint32(box.payloadPos + 8);
        trackCtx.sampleCount = count;
        trackCtx.sampleSizeConstant = constant !== 0;
        if (constant === 0 && box.type === "stsz" && (box.endPos - box.payloadPos - 12) / 4 < count) {
          throw new BoxFormatError("TABLE_OVERRUN", `stsz declares ${count} entries but holds fewer`, box.start);
        }
      } else if (trackCtx && box.type === "stts") {
        const entries = view.getUint32(box.payloadPos + 4);
        if ((box.endPos - box.payloadPos - 8) / 8 < entries) throw new BoxFormatError("TABLE_OVERRUN", "stts declares more entries than it holds", box.start);
        let total = 0;
        for (let i = 0; i < entries; i += 1) total += view.getUint32(box.payloadPos + 8 + i * 8);
        trackCtx.sttsSamples = total;
      } else if (trackCtx && box.type === "stss") {
        trackCtx.syncSamples = view.getUint32(box.payloadPos + 4);
      } else if (CONTAINERS.has(box.type)) {
        walk(box.payloadPos, box.endPos, depth + 1, trackCtx);
      }
    }
  };
  walk(top.headerSize, top.size, 0, undefined);
  let total = 0;
  for (const t of tracks) {
    const n = Math.max(t.sampleCount ?? 0, t.sttsSamples);
    if (n > limits.maxSamplesPerTrack) throw new BoxFormatError("TOO_MANY_SAMPLES", `A track declares ${n} samples (limit ${limits.maxSamplesPerTrack})`, 0);
    total += n;
  }
  if (total > limits.maxTotalSamples) throw new BoxFormatError("TOO_MANY_SAMPLES", `Tracks declare ${total} samples in total (limit ${limits.maxTotalSamples})`, 0);
  return { trackCount: tracks.length, tracks, totalSamples: total, hasMvex };
}
