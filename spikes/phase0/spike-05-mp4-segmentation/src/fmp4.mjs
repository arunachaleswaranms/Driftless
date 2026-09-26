// Independent verification of fragmented-MP4 output. It re-reads what MP4Box.js
// produced (init segment, moof/mdat media segments) with a strict walker, so segment
// timing and random-access claims are checked against the emitted bytes rather than
// taken from the library's own bookkeeping.

import { BoxFormatError, childBoxes, readBoxHeader } from "./boxes.mjs";

export const FMP4_LIMITS = Object.freeze({ maxSamplesPerTrun: 200_000, maxFragmentsPerSegment: 1024 });

const NON_SYNC_FLAG = 0x0001_0000;

function u64(view, pos) {
  const v = view.getUint32(pos) * 2 ** 32 + view.getUint32(pos + 4);
  if (!Number.isSafeInteger(v)) throw new BoxFormatError("SIZE_UNSAFE", "64-bit field exceeds the safe integer range", pos);
  return v;
}

function need(box, bytes) {
  if (box.endPos - box.payloadPos < bytes) throw new BoxFormatError("SHORT_BOX", `'${box.type}' payload shorter than ${bytes} bytes`, box.start);
}

function children(view, box) {
  return [...childBoxes(view, box.payloadPos, box.endPos)];
}

function only(list, type, parent) {
  const found = list.filter((b) => b.type === type);
  if (found.length !== 1) throw new BoxFormatError("STRUCTURE", `Expected one '${type}' in '${parent}', found ${found.length}`, 0);
  return found[0];
}

function fourCCAt(view, pos) {
  return String.fromCharCode(view.getUint8(pos), view.getUint8(pos + 1), view.getUint8(pos + 2), view.getUint8(pos + 3));
}

/** Parse an initialization segment (ftyp + moov with mvex and empty sample tables). */
export function parseInitSegment(buffer) {
  const view = new DataView(buffer);
  const top = [...childBoxes(view, 0, buffer.byteLength)];
  const types = top.map((b) => b.type);
  const ftyp = only(top, "ftyp", "init");
  const moov = only(top, "moov", "init");
  need(ftyp, 8);
  const brands = [fourCCAt(view, ftyp.payloadPos)];
  for (let p = ftyp.payloadPos + 8; p + 4 <= ftyp.endPos; p += 4) brands.push(fourCCAt(view, p));

  const moovChildren = children(view, moov);
  const mvexBox = moovChildren.find((b) => b.type === "mvex");
  const trex = new Map();
  if (mvexBox) {
    for (const b of children(view, mvexBox)) {
      if (b.type !== "trex") continue;
      need(b, 24);
      const p = b.payloadPos + 4;
      trex.set(view.getUint32(p), {
        defaultSampleDescriptionIndex: view.getUint32(p + 4),
        defaultSampleDuration: view.getUint32(p + 8),
        defaultSampleSize: view.getUint32(p + 12),
        defaultSampleFlags: view.getUint32(p + 16),
      });
    }
  }

  const tracks = [];
  for (const trak of moovChildren.filter((b) => b.type === "trak")) {
    const tc = children(view, trak);
    const tkhd = only(tc, "tkhd", "trak");
    need(tkhd, 24);
    const tkhdVersion = view.getUint8(tkhd.payloadPos);
    const trackId = view.getUint32(tkhd.payloadPos + (tkhdVersion === 1 ? 20 : 12));
    const mdia = only(tc, "mdia", "trak");
    const mc = children(view, mdia);
    const mdhd = only(mc, "mdhd", "mdia");
    need(mdhd, 24);
    const mdhdVersion = view.getUint8(mdhd.payloadPos);
    const timescale = view.getUint32(mdhd.payloadPos + (mdhdVersion === 1 ? 20 : 12));
    const hdlr = only(mc, "hdlr", "mdia");
    need(hdlr, 12);
    const handler = fourCCAt(view, hdlr.payloadPos + 8);
    const minf = only(mc, "minf", "mdia");
    const stbl = only(children(view, minf), "stbl", "minf");
    const sc = children(view, stbl);
    const stsd = only(sc, "stsd", "stbl");
    need(stsd, 16);
    const entryCount = view.getUint32(stsd.payloadPos + 4);
    const entry = readBoxHeader(new DataView(buffer, stsd.payloadPos + 8, stsd.endPos - stsd.payloadPos - 8), 0, { absoluteStart: stsd.payloadPos + 8, limit: stsd.endPos });
    const stts = sc.find((b) => b.type === "stts");
    const stsz = sc.find((b) => b.type === "stsz");
    const sttsEntries = stts && stts.endPos - stts.payloadPos >= 8 ? view.getUint32(stts.payloadPos + 4) : undefined;
    const stszSamples = stsz && stsz.endPos - stsz.payloadPos >= 12 ? view.getUint32(stsz.payloadPos + 8) : undefined;
    tracks.push({ trackId, timescale, handler, sampleEntry: entry.type, sampleEntryCount: entryCount, sampleTablesEmpty: sttsEntries === 0 && stszSamples === 0, trex: trex.get(trackId) });
  }
  const problems = [];
  if (!mvexBox) problems.push("moov has no mvex (not a fragmented init segment)");
  for (const t of tracks) {
    if (!t.trex) problems.push(`track ${t.trackId} has no trex`);
    if (!t.sampleTablesEmpty) problems.push(`track ${t.trackId} sample tables are not empty`);
  }
  if (types.includes("mdat") || types.includes("moof")) problems.push("init segment contains media boxes");
  return { byteLength: buffer.byteLength, topLevelTypes: types, brands, tracks, hasMvex: Boolean(mvexBox), problems };
}

function parseTraf(view, traf, moofStart, init) {
  const tc = children(view, traf);
  const tfhd = only(tc, "tfhd", "traf");
  need(tfhd, 8);
  const tfhdFlags = view.getUint32(tfhd.payloadPos) & 0xffffff;
  const trackId = view.getUint32(tfhd.payloadPos + 4);
  const defaults = init?.tracks.find((t) => t.trackId === trackId)?.trex ?? {};
  let p = tfhd.payloadPos + 8;
  let baseDataOffset;
  if (tfhdFlags & 0x01) { need(tfhd, p - tfhd.payloadPos + 8); baseDataOffset = u64(view, p); p += 8; }
  if (tfhdFlags & 0x02) p += 4;
  let defaultDuration = defaults.defaultSampleDuration;
  let defaultSize = defaults.defaultSampleSize;
  let defaultFlags = defaults.defaultSampleFlags;
  if (tfhdFlags & 0x08) { need(tfhd, p - tfhd.payloadPos + 4); defaultDuration = view.getUint32(p); p += 4; }
  if (tfhdFlags & 0x10) { need(tfhd, p - tfhd.payloadPos + 4); defaultSize = view.getUint32(p); p += 4; }
  if (tfhdFlags & 0x20) { need(tfhd, p - tfhd.payloadPos + 4); defaultFlags = view.getUint32(p); p += 4; }

  const tfdt = tc.find((b) => b.type === "tfdt");
  let baseMediaDecodeTime;
  if (tfdt) {
    need(tfdt, 8);
    baseMediaDecodeTime = view.getUint8(tfdt.payloadPos) === 1 ? (need(tfdt, 12), u64(view, tfdt.payloadPos + 4)) : view.getUint32(tfdt.payloadPos + 4);
  }

  const runs = [];
  for (const trun of tc.filter((b) => b.type === "trun")) {
    need(trun, 8);
    const version = view.getUint8(trun.payloadPos);
    const flags = view.getUint32(trun.payloadPos) & 0xffffff;
    const sampleCount = view.getUint32(trun.payloadPos + 4);
    if (sampleCount > FMP4_LIMITS.maxSamplesPerTrun) throw new BoxFormatError("TOO_MANY_SAMPLES", `trun declares ${sampleCount} samples`, trun.start);
    let q = trun.payloadPos + 8;
    let dataOffset;
    let firstSampleFlags;
    if (flags & 0x01) { need(trun, q - trun.payloadPos + 4); dataOffset = view.getInt32(q); q += 4; }
    if (flags & 0x04) { need(trun, q - trun.payloadPos + 4); firstSampleFlags = view.getUint32(q); q += 4; }
    const perSample = ((flags & 0x100) ? 4 : 0) + ((flags & 0x200) ? 4 : 0) + ((flags & 0x400) ? 4 : 0) + ((flags & 0x800) ? 4 : 0);
    need(trun, q - trun.payloadPos + perSample * sampleCount);
    let durationSum = 0;
    let sizeSum = 0;
    let syncCount = 0;
    let firstIsSync;
    let hasCompositionOffsets = false;
    for (let i = 0; i < sampleCount; i += 1) {
      let duration = defaultDuration;
      let size = defaultSize;
      let sflags = i === 0 && firstSampleFlags !== undefined ? firstSampleFlags : defaultFlags;
      if (flags & 0x100) { duration = view.getUint32(q); q += 4; }
      if (flags & 0x200) { size = view.getUint32(q); q += 4; }
      if (flags & 0x400) { sflags = view.getUint32(q); q += 4; }
      if (flags & 0x800) { const cto = version === 0 ? view.getUint32(q) : view.getInt32(q); if (cto !== 0) hasCompositionOffsets = true; q += 4; }
      if (duration === undefined || size === undefined) throw new BoxFormatError("STRUCTURE", `Track ${trackId}: no duration/size for sample ${i}`, trun.start);
      const sync = sflags === undefined ? true : (sflags & NON_SYNC_FLAG) === 0;
      if (i === 0) firstIsSync = sync;
      if (sync) syncCount += 1;
      durationSum += duration;
      sizeSum += size;
    }
    runs.push({ sampleCount, dataOffset, durationSum, sizeSum, syncCount, firstIsSync, hasCompositionOffsets });
  }
  if (runs.length === 0) throw new BoxFormatError("STRUCTURE", `traf for track ${trackId} has no trun`, traf.start);
  const dataBase = baseDataOffset ?? moofStart; // default-base-is-moof or first-traf rule
  return {
    trackId,
    baseMediaDecodeTime,
    sampleCount: runs.reduce((n, r) => n + r.sampleCount, 0),
    durationSum: runs.reduce((n, r) => n + r.durationSum, 0),
    sizeSum: runs.reduce((n, r) => n + r.sizeSum, 0),
    syncCount: runs.reduce((n, r) => n + r.syncCount, 0),
    firstIsSync: runs[0].firstIsSync,
    hasCompositionOffsets: runs.some((r) => r.hasCompositionOffsets),
    dataRanges: runs.map((r) => ({ start: dataBase + (r.dataOffset ?? 0), length: r.sizeSum })),
  };
}

/**
 * Parse a media segment made of one or more moof+mdat pairs. `init` (from
 * parseInitSegment) supplies trex defaults. Throws BoxFormatError on malformed input.
 */
export function parseMediaSegment(buffer, init) {
  const view = new DataView(buffer);
  const top = [...childBoxes(view, 0, buffer.byteLength)];
  const fragments = [];
  const problems = [];
  for (let i = 0; i < top.length; i += 1) {
    const box = top[i];
    if (box.type === "styp" || box.type === "sidx" || box.type === "free") continue;
    if (box.type !== "moof") throw new BoxFormatError("STRUCTURE", `Unexpected top-level '${box.type}' in media segment`, box.start);
    if (fragments.length >= FMP4_LIMITS.maxFragmentsPerSegment) throw new BoxFormatError("TOO_MANY_BOXES", "Too many fragments", box.start);
    const mdat = top[i + 1];
    if (!mdat || mdat.type !== "mdat") throw new BoxFormatError("STRUCTURE", "moof not followed by mdat", box.start);
    i += 1;
    const mc = children(view, box);
    const mfhd = only(mc, "mfhd", "moof");
    need(mfhd, 8);
    const sequenceNumber = view.getUint32(mfhd.payloadPos + 4);
    const trafs = mc.filter((b) => b.type === "traf").map((t) => parseTraf(view, t, box.start, init));
    const mdatPayload = { start: mdat.start + mdat.headerSize, end: mdat.start + mdat.size };
    for (const t of trafs) {
      for (const r of t.dataRanges) {
        if (r.start < mdatPayload.start || r.start + r.length > mdatPayload.end) {
          problems.push(`track ${t.trackId} sample data [${r.start}, ${r.start + r.length}) lies outside mdat payload [${mdatPayload.start}, ${mdatPayload.end})`);
        }
      }
    }
    const claimed = trafs.reduce((n, t) => n + t.sizeSum, 0);
    if (claimed !== mdatPayload.end - mdatPayload.start) problems.push(`trun sizes total ${claimed} but mdat payload is ${mdatPayload.end - mdatPayload.start}`);
    fragments.push({ sequenceNumber, moofSize: box.size, mdatSize: mdat.size, trafs: trafs.map(({ dataRanges, ...rest }) => rest) });
  }
  if (fragments.length === 0) throw new BoxFormatError("STRUCTURE", "Media segment contains no moof", 0);
  return { byteLength: buffer.byteLength, fragments, problems };
}

/** Flatten a parsed segment into one entry per track, in fragment order. */
export function summariseSegmentTracks(parsed) {
  const byTrack = new Map();
  for (const f of parsed.fragments) {
    for (const t of f.trafs) {
      const cur = byTrack.get(t.trackId);
      if (!cur) {
        byTrack.set(t.trackId, { ...t, firstSequenceNumber: f.sequenceNumber, contiguous: true });
      } else {
        if (t.baseMediaDecodeTime !== undefined && cur.baseMediaDecodeTime !== undefined && t.baseMediaDecodeTime !== cur.baseMediaDecodeTime + cur.durationSum) cur.contiguous = false;
        cur.sampleCount += t.sampleCount;
        cur.durationSum += t.durationSum;
        cur.sizeSum += t.sizeSum;
        cur.syncCount += t.syncCount;
        cur.hasCompositionOffsets ||= t.hasCompositionOffsets;
      }
    }
  }
  return [...byTrack.values()];
}
