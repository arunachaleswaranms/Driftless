// MP4Box.js-driven inspection and segmentation over a bounded source reader.
//
// Three experiments share one driver:
//   inspect()            pre-check + parse until moov (metadata, layout, keyframes)
//   builtinSegments()    MP4Box.js onSegment segmentation, optionally after seek()
//   plannedSegments()    deterministic time-based segment plan from the sample tables,
//                        cut with ISOFile.createFragment() from explicit source ranges
//
// The MP4Box.js module is passed in so the same code runs in the browser and in Node.

import { BOX_LIMITS, BoxFormatError, checkMoovBudget, describeLayout, scanTopLevelBoxes } from "./boxes.mjs";
import { classifyMovie } from "./classify.mjs";
import { parseInitSegment, parseMediaSegment, summariseSegmentTracks } from "./fmp4.mjs";
import { READ_LIMITS, createSourceReader } from "./source.mjs";

export const SESSION_LIMITS = Object.freeze({
  // A parser that asks for the same offset this many times in a row is treated as stalled.
  maxStalledAppends: 4,
  // Upper bound on reads per run relative to a single sequential pass.
  readBudgetFactor: 4,
  readBudgetSlack: 4096,
  maxSegmentRecords: 60_000,
  // Largest source window read to cut one planned segment.
  maxPlannedWindowBytes: 64 * 1024 * 1024,
  yieldEveryBytes: 32 * 1024 * 1024,
});

export class SessionError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "SessionError";
    this.code = code;
    this.details = details;
  }
}

const now = () => performance.now();
const round = (n, d = 3) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : n);

function yieldToEventLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parserMemory(mp4) {
  let streamBytes = 0;
  let streamBuffers = 0;
  for (const b of mp4.stream?.buffers ?? []) { streamBytes += b.byteLength; streamBuffers += 1; }
  let mdatStreamBytes = 0;
  for (const m of mp4.mdats ?? []) for (const b of m.stream?.buffers ?? []) mdatStreamBytes += b.byteLength;
  return { streamBuffers, streamBytes, mdatStreamBytes, sampleDataBytes: mp4.getAllocatedSampleDataSize?.() ?? 0 };
}

class MemoryTracker {
  constructor(sampler) {
    this.sampler = sampler;
    this.max = { streamBuffers: 0, streamBytes: 0, mdatStreamBytes: 0, sampleDataBytes: 0, retainedBytes: 0, jsHeapBytes: 0 };
  }

  sample(mp4) {
    const m = parserMemory(mp4);
    const retainedBytes = m.streamBytes + m.mdatStreamBytes + m.sampleDataBytes;
    for (const k of ["streamBuffers", "streamBytes", "mdatStreamBytes", "sampleDataBytes"]) this.max[k] = Math.max(this.max[k], m[k]);
    this.max.retainedBytes = Math.max(this.max.retainedBytes, retainedBytes);
    const heap = this.sampler?.();
    if (Number.isFinite(heap)) this.max.jsHeapBytes = Math.max(this.max.jsHeapBytes, heap);
    return { ...m, retainedBytes };
  }
}

/** Pre-parse safety gate: header-only top-level scan plus a bounded moov budget check. */
export async function precheck(source, { signal } = {}) {
  const reader = createSourceReader(source, { blockSize: READ_LIMITS.minBlockBytes, signal });
  const t0 = now();
  const scan = await scanTopLevelBoxes((o, l) => reader.readRange(o, l, "box-header"), source.size);
  const layout = describeLayout(scan, source.size);
  const result = { layout, scanReads: scan.headerReads, scanBytes: scan.headerBytes, refusal: undefined, moovBudget: undefined };
  const refuse = (code, message) => { result.refusal = { code, message }; };
  if (!layout.looksIsoBmff) refuse("NOT_ISO_BMFF", `First box is not an ISO BMFF box (${scan.error?.message ?? layout.firstBoxType ?? "empty"})`);
  else if (layout.moovPlacement === "absent") refuse("NO_MOOV", scan.error ? `No complete moov before scan stopped: ${scan.error.message}` : "File has no moov box");
  else if (scan.error && scan.error.offset === layout.moovOffset) refuse("MOOV_TRUNCATED", scan.error.message);
  else if (layout.moovSize > BOX_LIMITS.maxMoovBytes) refuse("MOOV_TOO_LARGE", `moov declares ${layout.moovSize} bytes (limit ${BOX_LIMITS.maxMoovBytes})`);
  else {
    const moov = await reader.readRange(layout.moovOffset, layout.moovSize, "moov-precheck");
    try {
      result.moovBudget = checkMoovBudget(moov);
    } catch (e) {
      if (!(e instanceof BoxFormatError)) throw e;
      refuse(`MOOV_${e.code}`, e.message);
    }
  }
  if (!result.refusal && scan.error) result.warning = `Scan stopped early: ${scan.error.message}`;
  result.reads = reader.stats.reads;
  result.bytesRead = reader.stats.bytesRead;
  result.ms = round(now() - t0, 1);
  return result;
}

/** Keyframe / random-access facts from MP4Box.js sample tables. */
export function analyseRandomAccess(samples, timescale) {
  const n = samples.length;
  if (!n) return { samples: 0 };
  let sync = 0;
  let firstSync = -1;
  let prevSync = -1;
  const intervals = [];
  let compositionOffsets = 0;
  let maxCtsLead = 0;
  let leading = 0;
  for (let i = 0; i < n; i += 1) {
    const s = samples[i];
    if (s.cts !== s.dts) { compositionOffsets += 1; maxCtsLead = Math.max(maxCtsLead, s.cts - s.dts); }
    if (s.is_leading) leading += 1;
    if (s.is_sync) {
      sync += 1;
      if (firstSync < 0) firstSync = i;
      if (prevSync >= 0) intervals.push((s.dts - samples[prevSync].dts) / timescale);
      prevSync = i;
    }
  }
  const sorted = [...intervals].sort((a, b) => a - b);
  const pick = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : undefined);
  return {
    samples: n,
    syncSamples: sync,
    allSync: sync === n,
    firstSampleIsSync: Boolean(samples[0].is_sync),
    firstSyncIndex: firstSync,
    syncIntervalSeconds: sorted.length ? { min: round(sorted[0]), median: round(pick(0.5)), p95: round(pick(0.95)), max: round(sorted[sorted.length - 1]) } : undefined,
    samplesWithCompositionOffset: compositionOffsets,
    maxCompositionOffsetSeconds: round(maxCtsLead / timescale, 4),
    leadingSamples: leading,
  };
}

/** Index of the last sample (decode order) whose dts is <= t seconds. */
function sampleAtTime(samples, timescale, t) {
  let lo = 0;
  let hi = samples.length - 1;
  const target = t * timescale;
  if (!samples.length || samples[0].dts > target) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (samples[mid].dts <= target) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function byteRange(samples, first, endExclusive) {
  let start = Infinity;
  let end = 0;
  let bytes = 0;
  for (let i = first; i < endExclusive; i += 1) {
    const s = samples[i];
    start = Math.min(start, s.offset);
    end = Math.max(end, s.offset + s.size);
    bytes += s.size;
  }
  return { start, end, span: end - start, sampleBytes: bytes };
}

/**
 * Answer "user seeks to t: which source region must be prepared first?" from the
 * moov sample tables alone (no mdat access).
 */
export function laterPositionRequirements(mp4, trackIds, t) {
  const out = { targetSeconds: t, tracks: [] };
  for (const id of trackIds) {
    const trak = mp4.getTrackById(id);
    const samples = trak.samples;
    const ts = trak.mdia.mdhd.timescale;
    const at = sampleAtTime(samples, ts, t);
    let rap = at;
    while (rap > 0 && !samples[rap].is_sync) rap -= 1;
    let nextSync = at + 1;
    while (nextSync < samples.length && !samples[nextSync].is_sync) nextSync += 1;
    const toTarget = byteRange(samples, rap, at + 1);
    const gop = byteRange(samples, rap, nextSync);
    out.tracks.push({
      trackId: id,
      targetSample: at,
      targetSampleSeconds: round(samples[at].dts / ts),
      randomAccessSample: rap,
      randomAccessSampleIsSync: Boolean(samples[rap].is_sync),
      randomAccessSeconds: round(samples[rap].dts / ts),
      decodeLeadSeconds: round((samples[at].dts - samples[rap].dts) / ts),
      samplesToDecodeBeforeTarget: at - rap,
      randomAccessOffset: samples[rap].offset,
      bytesRapToTarget: toTarget.sampleBytes,
      sourceSpanRapToTarget: toTarget.span,
      gopEndSample: nextSync,
      gopSourceRange: [gop.start, gop.end],
      gopSampleBytes: gop.sampleBytes,
    });
  }
  const starts = out.tracks.map((t) => t.randomAccessOffset);
  out.earliestSourceOffset = Math.min(...starts);
  return out;
}

/**
 * Deterministic time-based plan. Video segments start at sync samples; a new segment
 * starts at the first sync sample at least `targetSeconds` after the current segment
 * start. Other tracks are cut at the video boundary times. Pure function of the tables.
 */
export function buildSegmentPlan(tracks, targetSeconds, { maxSegments = SESSION_LIMITS.maxSegmentRecords } = {}) {
  if (!(targetSeconds > 0)) throw new RangeError("targetSeconds must be positive");
  const lead = tracks.find((t) => t.kind === "video") ?? tracks[0];
  const boundaries = [];
  {
    const { samples, timescale } = lead;
    let segStart = 0;
    boundaries.push(samples[0].dts / timescale);
    for (let i = 1; i < samples.length; i += 1) {
      const s = samples[i];
      if ((lead.kind !== "video" || s.is_sync) && (s.dts - samples[segStart].dts) / timescale >= targetSeconds) {
        segStart = i;
        boundaries.push(s.dts / timescale);
        if (boundaries.length > maxSegments) throw new SessionError("PLAN_TOO_LARGE", `Plan exceeds ${maxSegments} segments`);
      }
    }
  }
  const segments = boundaries.map((startSeconds, index) => ({ index, startSeconds, endSeconds: boundaries[index + 1], tracks: {} }));
  for (const t of tracks) {
    const { samples, timescale } = t;
    let i = 0;
    for (let k = 0; k < segments.length; k += 1) {
      const endT = segments[k].endSeconds;
      const first = i;
      while (i < samples.length && (endT === undefined || samples[i].dts / timescale < endT - 1e-9)) i += 1;
      if (i > first) {
        const r = byteRange(samples, first, i);
        segments[k].tracks[t.id] = { first, endExclusive: i, startDts: samples[first].dts, endDts: samples[i - 1].dts + samples[i - 1].duration, firstIsSync: Boolean(samples[first].is_sync), sourceStart: r.start, sourceEnd: r.end, sampleBytes: r.sampleBytes };
      }
    }
  }
  const last = segments[segments.length - 1];
  last.endSeconds = Math.max(...tracks.map((t) => { const s = t.samples[t.samples.length - 1]; return (s.dts + s.duration) / t.timescale; }));
  return { targetSeconds, leadTrackId: lead.id, segments };
}

export function planIndexForTime(plan, t) {
  const segs = plan.segments;
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid].startSeconds <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Parser driver: follows the next-position hints that MP4Box.js returns from
 * appendBuffer(), reading one bounded block at a time.
 */
class ParserRun {
  constructor(MP4Box, source, { blockSize, signal, memorySampler, onProgress }) {
    this.MP4Box = MP4Box;
    this.source = source;
    this.reader = createSourceReader(source, { blockSize, signal });
    this.mp4 = MP4Box.createFile(true);
    this.memory = new MemoryTracker(memorySampler);
    this.errors = [];
    this.events = [];
    this.onProgress = onProgress;
    this.offset = 0;
    this.stop = false;
    this.readyAt = undefined;
    this.moovStartAt = undefined;
    this.appends = 0;
    this.lastYieldBytes = 0;
    this.mp4.onError = (module, message) => { if (this.errors.length < 100) this.errors.push({ source: "mp4box", module, message: String(message).slice(0, 500) }); };
    this.mp4.onMoovStart = () => { this.moovStartAt = { offset: this.offset, reads: this.reader.stats.reads, bytesRead: this.reader.stats.bytesRead }; };
  }

  event(type, data) {
    if (this.events.length < 200) this.events.push({ type, t: round(now(), 1), ...data });
  }

  async pump(until) {
    const size = this.source.size;
    const budget = Math.ceil(size / this.reader.stats.blockSize) * SESSION_LIMITS.readBudgetFactor + SESSION_LIMITS.readBudgetSlack;
    let stalled = 0;
    while (!this.stop && !until()) {
      if (this.offset >= size) break;
      if (this.reader.stats.reads >= budget) throw new SessionError("READ_BUDGET", `Parser needed more than ${budget} reads`);
      const at = this.offset;
      const buffer = await this.reader.readBlock(at, "parser");
      buffer.fileStart = at;
      let next;
      try {
        // `last` is deliberately never passed: appendBuffer(buf, true) makes MP4Box.js
        // flush every remaining sample as its own one-sample segment. Callers flush().
        next = this.mp4.appendBuffer(buffer, false);
      } catch (e) {
        throw new SessionError("PARSER_EXCEPTION", `MP4Box.js threw at offset ${at}: ${e?.message ?? e}`);
      }
      this.appends += 1;
      this.memory.sample(this.mp4);
      if (next === undefined || next === null) next = at + buffer.byteLength;
      if (!Number.isSafeInteger(next) || next < 0) throw new SessionError("PARSER_BAD_POSITION", `Parser returned invalid next position ${next}`);
      if (next !== at + buffer.byteLength) this.event("parser-jump", { from: at, readEnd: at + buffer.byteLength, next });
      stalled = next === at ? stalled + 1 : 0;
      if (stalled >= SESSION_LIMITS.maxStalledAppends) throw new SessionError("PARSER_STALLED", `Parser requested offset ${at} repeatedly without progress`);
      this.offset = next;
      if (this.reader.stats.bytesRead - this.lastYieldBytes >= SESSION_LIMITS.yieldEveryBytes) {
        this.lastYieldBytes = this.reader.stats.bytesRead;
        this.onProgress?.(this.progress());
        await yieldToEventLoop();
      }
    }
  }

  progress() {
    return { offset: this.offset, reads: this.reader.stats.reads, bytesRead: this.reader.stats.bytesRead, size: this.source.size };
  }

  markReady(info) {
    this.readyAt = { offset: this.offset, reads: this.reader.stats.reads, bytesRead: this.reader.stats.bytesRead, ms: round(now() - this.t0, 1) };
    this.info = info;
  }

  sourceStats() {
    const s = this.reader.stats;
    return {
      sourceSize: s.sourceSize,
      blockSize: s.blockSize,
      reads: s.reads,
      bytesRead: s.bytesRead,
      rereadBytes: s.rereadBytes,
      maxReadBytes: s.maxReadBytes,
      maxInFlightBytes: s.maxInFlightBytes,
      nonSequentialReads: s.nonSequentialReads,
      readMs: round(s.readMs, 1),
      notableReads: s.log.slice(0, 16),
      coverage: this.reader.coverage(),
    };
  }
}

function selectTracks(classification, { segmentAllTracks = false } = {}) {
  if (segmentAllTracks) return classification.tracks.filter((t) => t.type === "video" || t.type === "audio").map((t) => t.id);
  return [classification.selected?.videoTrackId, classification.selected?.audioTrackId].filter((id) => id !== undefined);
}

function frameRate(info, id) {
  const t = info.tracks.find((x) => x.id === id);
  return t && t.samples_duration ? t.nb_samples / (t.samples_duration / t.timescale) : undefined;
}

function commonSummary(run, t0) {
  return {
    source: run.sourceStats(),
    moovStart: run.moovStartAt,
    ready: run.readyAt,
    parserAppends: run.appends,
    parserEvents: run.events,
    parserErrors: run.errors,
    memory: { max: run.memory.max, final: parserMemory(run.mp4) },
    ms: round(now() - t0, 1),
  };
}

/** Parse until moov is available and report metadata, layout, and random access. */
export async function inspect(MP4Box, source, { blockSize, signal, memorySampler, laterPositionSeconds, heapBeforeReady } = {}) {
  const t0 = now();
  const run = new ParserRun(MP4Box, source, { blockSize, signal, memorySampler });
  run.t0 = t0;
  const heap0 = heapBeforeReady?.();
  run.mp4.onReady = (info) => run.markReady(info);
  await run.pump(() => run.readyAt !== undefined);
  if (!run.info) throw new SessionError("NO_MOOV_PARSED", "Reached the end of the source without a parsed moov", { ...commonSummary(run, t0) });
  const heap1 = heapBeforeReady?.();
  const classification = classifyMovie(run.info);
  const randomAccess = {};
  for (const t of classification.tracks) {
    const trak = run.mp4.getTrackById(t.id);
    randomAccess[t.id] = analyseRandomAccess(trak.samples, trak.mdia.mdhd.timescale);
  }
  const ids = selectTracks(classification);
  const later = [];
  const duration = run.info.duration / run.info.timescale;
  for (const target of laterPositionSeconds ?? [duration / 2]) {
    if (target >= 0 && target < duration && ids.length) later.push(laterPositionRequirements(run.mp4, ids, target));
  }
  const totalSamples = classification.tracks.reduce((n, t) => n + (t.samples ?? 0), 0);
  return {
    movie: {
      durationSeconds: round(duration),
      timescale: run.info.timescale,
      brands: run.info.brands,
      mime: run.info.mime,
      isFragmented: run.info.isFragmented,
      isProgressive: run.info.isProgressive,
      trackCount: run.info.tracks.length,
      totalSamples,
    },
    classification,
    randomAccess,
    laterPosition: later,
    sampleTableHeap: Number.isFinite(heap0) && Number.isFinite(heap1) ? { before: heap0, after: heap1, delta: heap1 - heap0, perSample: totalSamples ? round((heap1 - heap0) / totalSamples, 1) : undefined } : undefined,
    ...commonSummary(run, t0),
  };
}

function verifyInit(buffer, trackIds) {
  const parsed = parseInitSegment(buffer);
  const ids = parsed.tracks.map((t) => t.trackId);
  const problems = [...parsed.problems];
  for (const id of trackIds) if (!ids.includes(id)) problems.push(`init segment lacks track ${id}`);
  return { parsed, summary: { bytes: buffer.byteLength, topLevelTypes: parsed.topLevelTypes, brands: parsed.brands, tracks: parsed.tracks.map(({ trex, ...t }) => t), problems } };
}

class SegmentLedger {
  constructor(initParsed, hash) {
    this.initParsed = initParsed;
    this.hash = hash;
    this.records = [];
    this.byTrack = new Map();
    this.problems = [];
    this.hashes = [];
    this.truncated = false;
    this.totalBytes = 0;
    this.count = 0;
  }

  add({ trackId, first, endExclusive, samples, timescale, firstDts, buffer, sequence }) {
    const count = this.count;
    this.count += 1;
    this.totalBytes += buffer.byteLength;
    const expectStartDts = samples[first].dts - firstDts;
    const endDts = samples[endExclusive - 1].dts + samples[endExclusive - 1].duration - firstDts;
    let earliestCts = Infinity;
    let sync = 0;
    for (let i = first; i < endExclusive; i += 1) { earliestCts = Math.min(earliestCts, samples[i].cts - firstDts); if (samples[i].is_sync) sync += 1; }
    const range = byteRange(samples, first, endExclusive);
    const problems = [];
    let parsedTrack;
    try {
      const parsed = parseMediaSegment(buffer, this.initParsed);
      problems.push(...parsed.problems);
      const tracks = summariseSegmentTracks(parsed);
      parsedTrack = tracks.find((t) => t.trackId === trackId);
      if (tracks.length !== 1 || !parsedTrack) problems.push(`segment carries tracks ${tracks.map((t) => t.trackId).join(",")} (expected ${trackId})`);
      if (parsedTrack) {
        if (parsedTrack.baseMediaDecodeTime !== expectStartDts) problems.push(`tfdt ${parsedTrack.baseMediaDecodeTime} != sample-table dts ${expectStartDts}`);
        if (parsedTrack.sampleCount !== endExclusive - first) problems.push(`trun sample count ${parsedTrack.sampleCount} != ${endExclusive - first}`);
        if (parsedTrack.durationSum !== endDts - expectStartDts) problems.push(`trun duration ${parsedTrack.durationSum} != ${endDts - expectStartDts}`);
        if (parsedTrack.sizeSum !== range.sampleBytes) problems.push(`trun sizes ${parsedTrack.sizeSum} != sample bytes ${range.sampleBytes}`);
        if (!parsedTrack.contiguous) problems.push("fragments inside the segment are not contiguous");
      }
    } catch (e) {
      problems.push(`verifier: ${e.message}`);
    }
    const prev = this.byTrack.get(trackId);
    if (prev) {
      if (first !== prev.endExclusive) problems.push(`sample gap/overlap: starts at ${first}, previous ended at ${prev.endExclusive}`);
      if (expectStartDts !== prev.endDts) problems.push(`timing gap: dts ${expectStartDts} != previous end ${prev.endDts}`);
      if (expectStartDts < prev.startDts) problems.push("non-monotonic start time");
    }
    const perTrackIndex = prev ? prev.perTrackIndex + 1 : 0;
    const record = {
      index: count,
      sequence,
      trackId,
      perTrackIndex,
      firstSample: first,
      endSample: endExclusive,
      samples: endExclusive - first,
      startSeconds: round(expectStartDts / timescale, 4),
      durationSeconds: round((endDts - expectStartDts) / timescale, 4),
      earliestPresentationSeconds: round(earliestCts / timescale, 4),
      startsWithSync: Boolean(samples[first].is_sync),
      verifiedFirstSampleSync: parsedTrack?.firstIsSync,
      syncSamples: sync,
      bytes: buffer.byteLength,
      sampleBytes: range.sampleBytes,
      sourceRange: [range.start, range.end],
      problems,
    };
    this.byTrack.set(trackId, { perTrackIndex, endExclusive, endDts, startDts: expectStartDts, count: perTrackIndex + 1 });
    if (problems.length && this.problems.length < 200) this.problems.push({ index: count, trackId, problems });
    if (this.records.length < SESSION_LIMITS.maxSegmentRecords) this.records.push(record);
    else this.truncated = true;
    if (this.hash) this.hashes.push(sha256Hex(buffer).then((h) => { record.sha256 = h; }));
    return record;
  }

  async summary() {
    await Promise.all(this.hashes);
    this.hashes = [];
    const perTrack = {};
    for (const [id, st] of this.byTrack) {
      const rows = this.records.filter((r) => r.trackId === id);
      const durations = rows.map((r) => r.durationSeconds).sort((a, b) => a - b);
      perTrack[id] = {
        segments: st.count,
        coveredSamples: st.endExclusive - (rows[0]?.firstSample ?? 0),
        allStartWithSync: rows.every((r) => r.startsWithSync),
        verifiedAllStartWithSync: rows.every((r) => r.verifiedFirstSampleSync === true),
        durationSeconds: durations.length ? { min: durations[0], median: durations[Math.floor(durations.length / 2)], max: durations[durations.length - 1] } : undefined,
        bytes: { min: Math.min(...rows.map((r) => r.bytes)), max: Math.max(...rows.map((r) => r.bytes)) },
        firstStartSeconds: rows[0]?.startSeconds,
        lastEndSeconds: rows.length ? round(rows[rows.length - 1].startSeconds + rows[rows.length - 1].durationSeconds, 4) : undefined,
      };
    }
    return {
      count: this.count,
      totalBytes: this.totalBytes,
      perTrack,
      problemCount: this.problems.length,
      problems: this.problems.slice(0, 20),
      recordsTruncated: this.truncated,
    };
  }
}

/**
 * MP4Box.js built-in segmentation (setSegmentOptions + onSegment). With `seekSeconds`
 * the run calls seek(time, useRap) before start() and stops after `maxSegmentsPerTrack`.
 */
export async function builtinSegments(MP4Box, source, opts = {}) {
  const { blockSize, targetSeconds = 2, seekSeconds, useRap = true, maxSegmentsPerTrack, hash = false, signal, memorySampler, onProgress, segmentAllTracks = false, drainUnselectedTracks = true, keepSegments = 0 } = opts;
  const t0 = now();
  const run = new ParserRun(MP4Box, source, { blockSize, signal, memorySampler, onProgress });
  run.t0 = t0;
  const mp4 = run.mp4;
  const ctx = { ids: [], firstDts: new Map(), start: new Map(), init: undefined, ledger: undefined, nbSamples: undefined, seek: undefined, drained: [] };
  const kept = [];
  let setupError;

  mp4.onReady = (info) => {
    run.markReady(info);
    try {
      const classification = classifyMovie(info);
      ctx.classification = classification;
      ctx.ids = selectTracks(classification, { segmentAllTracks });
      if (!ctx.ids.length) throw new SessionError("NO_TRACKS", "No audio/video tracks to segment");
      const lead = classification.selected.videoTrackId ?? ctx.ids[0];
      const rate = frameRate(info, lead);
      // MP4Box.js requires one nbSamples value for every segmented track.
      ctx.nbSamples = Math.max(1, Math.round((rate ?? 1) * targetSeconds));
      for (const id of ctx.ids) mp4.setSegmentOptions(id, { trackId: id }, { nbSamples: ctx.nbSamples, rapAlignement: true });
      if (drainUnselectedTracks) {
        for (const t of info.tracks) {
          if (ctx.ids.includes(t.id)) continue;
          mp4.setExtractionOptions(t.id, { trackId: t.id }, { nbSamples: 1000 });
          ctx.drained.push(t.id);
        }
      }
      const init = mp4.initializeSegmentation();
      const verified = verifyInit(init.buffer, ctx.ids);
      ctx.init = { ...verified.summary, trackIds: init.tracks.map((t) => t.id) };
      ctx.initBuffer = init.buffer;
      ctx.ledger = new SegmentLedger(verified.parsed, hash);
      for (const id of ctx.ids) ctx.firstDts.set(id, mp4.getTrackById(id).first_dts || 0);
      if (seekSeconds !== undefined) {
        const r = mp4.seek(seekSeconds, useRap);
        ctx.seek = { requestedSeconds: seekSeconds, useRap, returnedOffset: r.offset, returnedTimeSeconds: round(r.time, 4), readsBefore: run.reader.stats.reads, bytesReadBefore: run.reader.stats.bytesRead };
      }
      for (const id of ctx.ids) ctx.start.set(id, mp4.getTrackById(id).nextSample ?? 0);
      mp4.start();
    } catch (e) {
      setupError = e;
      run.stop = true;
    }
  };

  mp4.onSamples = (id, user, samples) => {
    if (samples.length) mp4.releaseUsedSamples(id, samples[samples.length - 1].number + 1);
  };

  mp4.onSegment = (id, user, buffer, nextSample) => {
    const trak = mp4.getTrackById(id);
    const first = ctx.start.get(id);
    const rec = ctx.ledger.add({ trackId: id, first, endExclusive: nextSample, samples: trak.samples, timescale: trak.mdia.mdhd.timescale, firstDts: ctx.firstDts.get(id), buffer, sequence: undefined });
    if (ctx.seek && rec.perTrackIndex === 0) {
      ctx.seek.firstSegment ??= {};
      ctx.seek.firstSegment[id] = { reads: run.reader.stats.reads, bytesRead: run.reader.stats.bytesRead, bytesReadSinceSeek: run.reader.stats.bytesRead - ctx.seek.bytesReadBefore, startSample: first, startSeconds: rec.startSeconds, startsWithSync: rec.startsWithSync, verifiedFirstSampleSync: rec.verifiedFirstSampleSync };
    }
    if (kept.length < keepSegments) kept.push({ trackId: id, index: rec.index, buffer });
    ctx.start.set(id, nextSample);
    mp4.releaseUsedSamples(id, nextSample);
    if (maxSegmentsPerTrack && ctx.ids.every((tid) => (ctx.ledger.byTrack.get(tid)?.count ?? 0) >= maxSegmentsPerTrack)) {
      run.stop = true;
      mp4.stop();
    }
  };

  let failure;
  try {
    await run.pump(() => false);
    if (setupError) throw setupError;
    if (!run.info) throw new SessionError("NO_MOOV_PARSED", "Reached the end of the source without a parsed moov");
    if (!run.stop) { mp4.flush(); run.memory.sample(mp4); }
  } catch (e) {
    failure = { code: e.code ?? "EXCEPTION", message: e.message };
  }
  const result = {
    strategy: { kind: "builtin", targetSeconds, nbSamples: ctx.nbSamples, rapAlignement: true, seekSeconds, useRap, maxSegmentsPerTrack },
    trackIds: ctx.ids,
    drainedTrackIds: ctx.drained,
    classification: ctx.classification ? { verdict: ctx.classification.verdict, reasons: ctx.classification.reasons } : undefined,
    init: ctx.init,
    initSha256: ctx.initBuffer && hash ? await sha256Hex(ctx.initBuffer) : undefined,
    seek: ctx.seek,
    segments: ctx.ledger ? await ctx.ledger.summary() : undefined,
    records: ctx.ledger?.records ?? [],
    failure,
    ...commonSummary(run, t0),
  };
  if (keepSegments) result.keptSegments = { init: ctx.initBuffer, media: kept };
  return result;
}

/**
 * Deterministic planned segmentation. Parses only until moov, builds the time-based
 * plan, then cuts the requested plan segments from explicit source windows with
 * ISOFile.createFragment(). `indices` selects segments (default: all, in order).
 */
export async function plannedSegments(MP4Box, source, opts = {}) {
  const { blockSize, targetSeconds = 2, indices, atSeconds, hash = false, signal, memorySampler, onProgress } = opts;
  const t0 = now();
  const run = new ParserRun(MP4Box, source, { blockSize, signal, memorySampler, onProgress });
  run.t0 = t0;
  const mp4 = run.mp4;
  run.mp4.onReady = (info) => run.markReady(info);
  let failure;
  let plan;
  let ids = [];
  let ledger;
  let initSummary;
  let initSha256;
  let selection;
  const cut = [];
  try {
    await run.pump(() => run.readyAt !== undefined);
    if (!run.info) throw new SessionError("NO_MOOV_PARSED", "Reached the end of the source without a parsed moov");
    const classification = classifyMovie(run.info);
    ids = selectTracks(classification);
    if (!ids.length) throw new SessionError("NO_TRACKS", "No audio/video tracks to segment");
    const tracks = ids.map((id) => {
      const trak = mp4.getTrackById(id);
      return { id, kind: run.info.tracks.find((t) => t.id === id).type, samples: trak.samples, timescale: trak.mdia.mdhd.timescale };
    });
    plan = buildSegmentPlan(tracks, targetSeconds);
    for (const id of ids) mp4.setSegmentOptions(id, { trackId: id }, { nbSamples: 1 });
    const init = mp4.initializeSegmentation();
    const verified = verifyInit(init.buffer, ids);
    initSummary = verified.summary;
    initSha256 = hash ? await sha256Hex(init.buffer) : undefined;
    ledger = new SegmentLedger(verified.parsed, hash);
    const bytesAfterMoov = run.reader.stats.bytesRead;
    const readsAfterMoov = run.reader.stats.reads;

    let wanted = indices ?? plan.segments.map((s) => s.index);
    if (atSeconds !== undefined) {
      const k = planIndexForTime(plan, atSeconds);
      wanted = [k, ...(indices ?? []).filter((i) => i !== k)];
      selection = { atSeconds, planIndex: k, segmentStartSeconds: round(plan.segments[k].startSeconds, 4), segmentEndSeconds: round(plan.segments[k].endSeconds, 4) };
    }
    for (const k of wanted) {
      const seg = plan.segments[k];
      if (!seg) throw new SessionError("PLAN_INDEX", `No plan segment ${k}`);
      const windowStart = Math.min(...Object.values(seg.tracks).map((t) => t.sourceStart));
      const windowEnd = Math.max(...Object.values(seg.tracks).map((t) => t.sourceEnd));
      const windows = windowEnd - windowStart <= SESSION_LIMITS.maxPlannedWindowBytes
        ? [{ start: windowStart, end: windowEnd, ids }]
        : ids.map((id) => ({ start: seg.tracks[id].sourceStart, end: seg.tracks[id].sourceEnd, ids: [id] }));
      for (const w of windows) {
        if (w.end - w.start > SESSION_LIMITS.maxPlannedWindowBytes) throw new SessionError("WINDOW_TOO_LARGE", `Segment ${k} needs a ${w.end - w.start}-byte window`);
        // The moov can describe samples that a truncated file no longer contains.
        if (w.end > source.size) throw new SessionError("SOURCE_TRUNCATED", `Segment ${k} needs bytes up to ${w.end}; the source ends at ${source.size}`);
        const data = new Uint8Array(await run.reader.readRange(w.start, w.end - w.start, `plan-${k}`));
        for (const id of w.ids) {
          const t = seg.tracks[id];
          if (!t) continue;
          const trak = mp4.getTrackById(id);
          for (let i = t.first; i < t.endExclusive; i += 1) {
            const s = trak.samples[i];
            s.data = data.slice(s.offset - w.start, s.offset - w.start + s.size);
            s.alreadyRead = s.size;
            mp4.samplesDataSize += s.size;
          }
          run.memory.sample(mp4);
          // Deterministic sequence number: plan index + 1, independent of cut order.
          mp4.nextMoofNumber = k;
          const stream = mp4.createFragment(id, t.first, t.endExclusive - 1);
          const buffer = stream.buffer;
          for (let i = t.first; i < t.endExclusive; i += 1) mp4.releaseSample(trak, i);
          const rec = ledger.add({ trackId: id, first: t.first, endExclusive: t.endExclusive, samples: trak.samples, timescale: trak.mdia.mdhd.timescale, firstDts: trak.first_dts || 0, buffer, sequence: k + 1 });
          rec.planIndex = k;
          if (cut.length < 16) cut.push({ planIndex: k, trackId: id, readsSoFar: run.reader.stats.reads, bytesReadSinceMoov: run.reader.stats.bytesRead - bytesAfterMoov, readsSinceMoov: run.reader.stats.reads - readsAfterMoov });
        }
      }
      if (run.reader.stats.bytesRead - run.lastYieldBytes >= SESSION_LIMITS.yieldEveryBytes) {
        run.lastYieldBytes = run.reader.stats.bytesRead;
        onProgress?.(run.progress());
        await yieldToEventLoop();
      }
    }
  } catch (e) {
    failure = { code: e.code ?? "EXCEPTION", message: e.message };
  }
  const planSummary = plan ? summarisePlan(plan, ids) : undefined;
  return {
    strategy: { kind: "planned", targetSeconds, atSeconds, requested: indices ? indices.length : "all" },
    trackIds: ids,
    plan: planSummary,
    selection,
    init: initSummary,
    initSha256,
    cutProgress: cut,
    segments: ledger ? await ledger.summary() : undefined,
    records: ledger?.records ?? [],
    failure,
    ...commonSummary(run, t0),
  };
}

function summarisePlan(plan, ids) {
  const segs = plan.segments;
  const durs = segs.map((s) => s.endSeconds - s.startSeconds).sort((a, b) => a - b);
  const perTrackBytes = {};
  for (const id of ids) {
    const sizes = segs.map((s) => s.tracks[id]?.sampleBytes ?? 0).filter(Boolean);
    const spans = segs.map((s) => (s.tracks[id] ? s.tracks[id].sourceEnd - s.tracks[id].sourceStart : 0)).filter(Boolean);
    perTrackBytes[id] = { minSampleBytes: Math.min(...sizes), maxSampleBytes: Math.max(...sizes), maxSourceSpan: Math.max(...spans), allStartWithSync: segs.every((s) => !s.tracks[id] || s.tracks[id].firstIsSync) };
  }
  return {
    targetSeconds: plan.targetSeconds,
    leadTrackId: plan.leadTrackId,
    segmentCount: segs.length,
    durationSeconds: { min: round(durs[0]), median: round(durs[Math.floor(durs.length / 2)]), max: round(durs[durs.length - 1]) },
    perTrack: perTrackBytes,
    first: segs.slice(0, 3).map((s) => ({ index: s.index, start: round(s.startSeconds, 4), end: round(s.endSeconds, 4) })),
  };
}
