// Spike 0.6 media preparation: open a local MP4 once, then cut planned fMP4 segments
// on demand, one bounded source window at a time.
//
// It reuses the Spike 0.5 building blocks unchanged (imported, not copied): the
// header-only pre-check and moov budget, target classification, the deterministic
// keyframe-aligned segment plan, the bounded source reader, and the independent fMP4
// verifier. Only the parse-until-moov loop and the single-segment cut are
// re-implemented here, because Spike 0.5 exposes them as whole-file runs.

import { buildSegmentPlan, planIndexForTime, precheck } from "../../spike-05-mp4-segmentation/src/session.mjs";
import { TARGET, classifyMovie } from "../../spike-05-mp4-segmentation/src/classify.mjs";
import { parseInitSegment, parseMediaSegment, summariseSegmentTracks } from "../../spike-05-mp4-segmentation/src/fmp4.mjs";
import { createSourceReader } from "../../spike-05-mp4-segmentation/src/source.mjs";

export const PREPARER_LIMITS = Object.freeze({
  maxStalledAppends: 4,
  // Metadata parse budget: the moov in blocks plus this many extra reads.
  metadataReadSlack: 64,
  // Largest source window read to cut one planned segment (same as Spike 0.5).
  maxWindowBytes: 64 * 1024 * 1024,
});

export class PreparationError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "PreparationError";
    this.code = code;
    this.details = details;
  }
}

const round = (n, d = 4) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : n);

function parserMemory(mp4) {
  let streamBytes = 0;
  for (const b of mp4?.stream?.buffers ?? []) streamBytes += b.byteLength;
  return { streamBytes, sampleDataBytes: mp4?.getAllocatedSampleDataSize?.() ?? 0 };
}

/** RFC 6381 MIME types for the target pair, for isTypeSupported()/addSourceBuffer(). */
export function mimeTypesFor(videoCodec, audioCodec) {
  return {
    combined: `video/mp4; codecs="${videoCodec}, ${audioCodec}"`,
    video: `video/mp4; codecs="${videoCodec}"`,
    audio: `audio/mp4; codecs="${audioCodec}"`,
  };
}

/**
 * Pre-check, parse until the moov is available, classify, and build the segment plan.
 * Throws PreparationError (with `details`) for refused, non-target, or unparseable input.
 */
export async function openMedia(MP4Box, source, { blockSize = 1024 * 1024, targetSeconds = 2, signal, now = () => performance.now() } = {}) {
  const t0 = now();
  const pre = await precheck(source, { signal });
  if (pre.refusal) throw new PreparationError(pre.refusal.code, pre.refusal.message, { stage: "precheck", precheck: pre });

  const reader = createSourceReader(source, { blockSize, signal });
  const mp4 = MP4Box.createFile(true);
  const parserErrors = [];
  let info;
  mp4.onError = (module, message) => {
    if (parserErrors.length < 50) parserErrors.push({ module, message: String(message).slice(0, 300) });
  };
  mp4.onReady = (i) => {
    info = i;
  };

  const budget = Math.ceil((pre.layout.moovSize ?? 0) / blockSize) + PREPARER_LIMITS.metadataReadSlack;
  let offset = 0;
  let stalled = 0;
  while (!info && offset < source.size) {
    if (reader.stats.reads >= budget) throw new PreparationError("METADATA_READ_BUDGET", `No moov after ${budget} reads`, { stage: "parse" });
    const buffer = await reader.readBlock(offset, "metadata");
    buffer.fileStart = offset;
    let next;
    try {
      next = mp4.appendBuffer(buffer, false);
    } catch (e) {
      throw new PreparationError("PARSER_EXCEPTION", `MP4Box.js threw at offset ${offset}: ${e?.message ?? e}`, { stage: "parse" });
    }
    if (next === undefined || next === null) next = offset + buffer.byteLength;
    if (!Number.isSafeInteger(next) || next < 0) throw new PreparationError("PARSER_BAD_POSITION", `Parser returned ${next}`, { stage: "parse" });
    stalled = next === offset ? stalled + 1 : 0;
    if (stalled >= PREPARER_LIMITS.maxStalledAppends) throw new PreparationError("PARSER_STALLED", `Parser requested offset ${offset} repeatedly`, { stage: "parse" });
    offset = next;
  }
  if (!info) throw new PreparationError("NO_MOOV_PARSED", "Reached the end of the source without a parsed moov", { stage: "parse", parserErrors });

  const classification = classifyMovie(info);
  const trackCodecs = classification.tracks.map((t) => ({ id: t.id, type: t.type, codec: t.codec }));
  if (classification.verdict !== TARGET) {
    throw new PreparationError("NON_TARGET", classification.reasons.join("; ") || classification.verdict, { stage: "classify", verdict: classification.verdict, reasons: classification.reasons, trackCodecs });
  }
  return new MediaPreparer({ mp4, reader, info, classification, precheck: pre, targetSeconds, parserErrors, openMs: now() - t0, now });
}

export class MediaPreparer {
  constructor({ mp4, reader, info, classification, precheck: pre, targetSeconds, parserErrors, openMs, now }) {
    this.mp4 = mp4;
    this.reader = reader;
    this.info = info;
    this.classification = classification;
    this.precheck = pre;
    this.parserErrors = parserErrors;
    this.now = now;
    this.closed = false;
    this.cuts = 0;
    this.openStats = { ms: round(openMs, 1), reads: reader.stats.reads, bytesRead: reader.stats.bytesRead, parser: parserMemory(mp4) };

    const { videoTrackId, audioTrackId } = classification.selected;
    this.videoTrackId = videoTrackId;
    this.audioTrackId = audioTrackId;
    this.trackIds = [videoTrackId, audioTrackId];
    const movieTimescale = info.timescale;
    this.tracks = this.trackIds.map((id) => {
      const trak = mp4.getTrackById(id);
      const meta = info.tracks.find((t) => t.id === id);
      const timescale = trak.mdia.mdhd.timescale;
      return {
        id,
        kind: meta.type,
        codec: meta.codec,
        timescale,
        firstDts: trak.first_dts || 0,
        samples: trak.samples,
        width: meta.video?.width,
        height: meta.video?.height,
        editList: (trak.edts?.elst?.entries ?? []).map((e) => ({
          segmentDurationSeconds: round(e.segment_duration / movieTimescale),
          mediaTime: e.media_time,
          mediaTimeSeconds: e.media_time < 0 ? -1 : round(e.media_time / timescale, 6),
          rate: e.media_rate_integer,
        })),
      };
    });
    this.plan = buildSegmentPlan(this.tracks, targetSeconds);
    const v = this.tracks[0];
    const a = this.tracks[1];
    this.mime = mimeTypesFor(v.codec, a.codec);
    this.durationSeconds = this.plan.segments[this.plan.segments.length - 1].endSeconds;
    this.movieDurationSeconds = info.duration / info.timescale;
    this.inits = undefined;
  }

  get segmentCount() {
    return this.plan.segments.length;
  }

  planIndexForTime(t) {
    return planIndexForTime(this.plan, t);
  }

  segmentTimes(k) {
    const s = this.plan.segments[k];
    return { index: k, startSeconds: s.startSeconds, endSeconds: s.endSeconds, durationSeconds: s.endSeconds - s.startSeconds };
  }

  /** Where each track's first presented sample lands, with and without its edit list. */
  presentationInfo() {
    return this.tracks.map((t) => {
      const firstSeg = this.plan.segments[0].tracks[t.id];
      let minCts = Infinity;
      for (let i = firstSeg.first; i < firstSeg.endExclusive; i += 1) minCts = Math.min(minCts, t.samples[i].cts);
      const last = t.samples[t.samples.length - 1];
      let maxEnd = 0;
      for (let i = Math.max(0, t.samples.length - 64); i < t.samples.length; i += 1) maxEnd = Math.max(maxEnd, t.samples[i].cts + t.samples[i].duration);
      const edit = t.editList.find((e) => e.mediaTime >= 0);
      const shift = edit ? edit.mediaTime / t.timescale : 0;
      return {
        trackId: t.id,
        kind: t.kind,
        timescale: t.timescale,
        firstDecodeSeconds: round((t.samples[0].dts - t.firstDts) / t.timescale, 6),
        firstPresentationSeconds: round((minCts - t.firstDts) / t.timescale, 6),
        lastPresentationEndSeconds: round((maxEnd - t.firstDts) / t.timescale, 6),
        lastDecodeEndSeconds: round((last.dts + last.duration - t.firstDts) / t.timescale, 6),
        editList: t.editList,
        editShiftSeconds: round(shift, 6),
        firstPresentationWithEditSeconds: round((minCts - t.firstDts) / t.timescale - shift, 6),
      };
    });
  }

  /**
   * Build and verify the initialization segments once: the combined (both tracks) init
   * for one muxed SourceBuffer, and per-track inits for separate SourceBuffers.
   */
  initSegments() {
    this.#assertOpen();
    if (this.inits) return this.inits;
    const mp4 = this.mp4;
    for (const id of this.trackIds) mp4.setSegmentOptions(id, { trackId: id }, { nbSamples: 1 });
    const combined = mp4.initializeSegmentation();
    const perTrack = mp4.initializeSegmentation("per-track");
    const verify = (buffer, ids) => {
      const parsed = parseInitSegment(buffer);
      const problems = [...parsed.problems];
      const got = parsed.tracks.map((t) => t.trackId);
      for (const id of ids) if (!got.includes(id)) problems.push(`init lacks track ${id}`);
      if (got.length !== ids.length) problems.push(`init carries tracks ${got.join(",")}; expected ${ids.join(",")}`);
      if (problems.length) throw new PreparationError("INIT_INVALID", problems.join("; "), { stage: "init" });
      return { parsed, summary: { bytes: buffer.byteLength, topLevelTypes: parsed.topLevelTypes, brands: parsed.brands, tracks: parsed.tracks.map(({ trex, ...t }) => t) } };
    };
    const combinedCheck = verify(combined.buffer, this.trackIds);
    const tracks = {};
    for (const entry of perTrack) {
      const check = verify(entry.buffer, [entry.id]);
      tracks[entry.id] = { buffer: entry.buffer, parsed: check.parsed, summary: check.summary };
    }
    this.inits = { combined: { buffer: combined.buffer, parsed: combinedCheck.parsed, summary: combinedCheck.summary }, perTrack: tracks };
    return this.inits;
  }

  /**
   * Cut planned segment k for both tracks from one bounded source window (two windows
   * if the tracks are far apart). Each fragment is verified against the sample table;
   * a fragment that fails verification is refused, never passed on.
   */
  async cut(k) {
    this.#assertOpen();
    const seg = this.plan.segments[k];
    if (!seg) throw new PreparationError("PLAN_INDEX", `No plan segment ${k}`, { stage: "cut" });
    const inits = this.initSegments();
    const t0 = this.now();
    const readsBefore = this.reader.stats.reads;
    const bytesBefore = this.reader.stats.bytesRead;
    const present = this.trackIds.filter((id) => seg.tracks[id]);
    const windowStart = Math.min(...present.map((id) => seg.tracks[id].sourceStart));
    const windowEnd = Math.max(...present.map((id) => seg.tracks[id].sourceEnd));
    const windows = windowEnd - windowStart <= PREPARER_LIMITS.maxWindowBytes
      ? [{ start: windowStart, end: windowEnd, ids: present }]
      : present.map((id) => ({ start: seg.tracks[id].sourceStart, end: seg.tracks[id].sourceEnd, ids: [id] }));
    const parts = [];
    for (const w of windows) {
      if (w.end - w.start > PREPARER_LIMITS.maxWindowBytes) throw new PreparationError("WINDOW_TOO_LARGE", `Segment ${k} needs a ${w.end - w.start}-byte window`, { stage: "cut", index: k });
      if (w.end > this.reader.size) throw new PreparationError("SOURCE_TRUNCATED", `Segment ${k} needs bytes up to ${w.end}; the source ends at ${this.reader.size}`, { stage: "cut", index: k });
      const data = new Uint8Array(await this.reader.readRange(w.start, w.end - w.start, `segment-${k}`));
      if (this.closed) throw new PreparationError("CLOSED", "Preparer closed during a read", { stage: "cut", index: k });
      for (const id of w.ids) {
        const range = seg.tracks[id];
        const part = this.#fragment(id, range.first, range.endExclusive, data, w.start, k, inits.perTrack[id].parsed);
        if (part.problems.length) throw new PreparationError("SEGMENT_INVALID", `Segment ${k} track ${id}: ${part.problems.join("; ")}`, { stage: "cut", index: k });
        parts.push(part);
      }
    }
    this.cuts += 1;
    return {
      index: k,
      startSeconds: seg.startSeconds,
      endSeconds: seg.endSeconds,
      parts,
      bytes: parts.reduce((n, p) => n + p.bytes, 0),
      reads: this.reader.stats.reads - readsBefore,
      bytesRead: this.reader.stats.bytesRead - bytesBefore,
      ms: round(this.now() - t0, 2),
    };
  }

  /**
   * Negative control only: a fragment for an arbitrary sample range of one track (for
   * example one that does not start on a keyframe). Verification is reported, not
   * enforced, so the browser's handling of an invalid random-access point can be seen.
   */
  async cutSampleRange(trackId, first, endExclusive, sequenceIndex = 0) {
    this.#assertOpen();
    const inits = this.initSegments();
    const t = this.tracks.find((x) => x.id === trackId);
    if (!t || !(first >= 0 && endExclusive > first && endExclusive <= t.samples.length)) throw new PreparationError("RANGE", "Invalid sample range", { stage: "cut" });
    let start = Infinity;
    let end = 0;
    for (let i = first; i < endExclusive; i += 1) {
      start = Math.min(start, t.samples[i].offset);
      end = Math.max(end, t.samples[i].offset + t.samples[i].size);
    }
    if (end - start > PREPARER_LIMITS.maxWindowBytes) throw new PreparationError("WINDOW_TOO_LARGE", "Range window too large", { stage: "cut" });
    if (end > this.reader.size) throw new PreparationError("SOURCE_TRUNCATED", "Range beyond EOF", { stage: "cut" });
    const data = new Uint8Array(await this.reader.readRange(start, end - start, "negative-control"));
    return this.#fragment(trackId, first, endExclusive, data, start, sequenceIndex, inits.perTrack[trackId].parsed);
  }

  #fragment(id, first, endExclusive, data, windowStart, sequenceIndex, initParsed) {
    const mp4 = this.mp4;
    const trak = mp4.getTrackById(id);
    const t = this.tracks.find((x) => x.id === id);
    for (let i = first; i < endExclusive; i += 1) {
      const s = trak.samples[i];
      s.data = data.slice(s.offset - windowStart, s.offset - windowStart + s.size);
      s.alreadyRead = s.size;
      mp4.samplesDataSize += s.size;
    }
    // Deterministic moof sequence number: plan index + 1, independent of cut order.
    mp4.nextMoofNumber = sequenceIndex;
    let buffer;
    try {
      buffer = mp4.createFragment(id, first, endExclusive - 1)?.buffer;
    } finally {
      for (let i = first; i < endExclusive; i += 1) mp4.releaseSample(trak, i);
    }
    if (!buffer) throw new PreparationError("FRAGMENT_FAILED", `createFragment returned nothing for track ${id} [${first}, ${endExclusive})`, { stage: "cut" });

    const samples = trak.samples;
    const startDts = samples[first].dts - t.firstDts;
    const endDts = samples[endExclusive - 1].dts + samples[endExclusive - 1].duration - t.firstDts;
    let minCts = Infinity;
    let maxCtsEnd = 0;
    let sampleBytes = 0;
    for (let i = first; i < endExclusive; i += 1) {
      minCts = Math.min(minCts, samples[i].cts);
      maxCtsEnd = Math.max(maxCtsEnd, samples[i].cts + samples[i].duration);
      sampleBytes += samples[i].size;
    }
    const problems = [];
    let verifiedFirstSampleSync;
    try {
      const parsed = parseMediaSegment(buffer, initParsed);
      problems.push(...parsed.problems);
      const tracks = summariseSegmentTracks(parsed);
      const p = tracks.find((x) => x.trackId === id);
      if (tracks.length !== 1 || !p) problems.push(`fragment carries tracks ${tracks.map((x) => x.trackId).join(",")}`);
      if (p) {
        verifiedFirstSampleSync = p.firstIsSync;
        if (p.baseMediaDecodeTime !== startDts) problems.push(`tfdt ${p.baseMediaDecodeTime} != sample-table dts ${startDts}`);
        if (p.sampleCount !== endExclusive - first) problems.push(`trun sample count ${p.sampleCount} != ${endExclusive - first}`);
        if (p.durationSum !== endDts - startDts) problems.push(`trun duration ${p.durationSum} != ${endDts - startDts}`);
        if (p.sizeSum !== sampleBytes) problems.push(`trun sizes ${p.sizeSum} != ${sampleBytes}`);
        if (t.kind === "video" && !p.firstIsSync) problems.push("video fragment does not start with a sync sample");
      }
    } catch (e) {
      problems.push(`verifier: ${e.message}`);
    }
    let firstSync = -1;
    for (let i = first; i < endExclusive && firstSync < 0; i += 1) if (samples[i].is_sync) firstSync = i;
    return {
      trackId: id,
      kind: t.kind,
      buffer,
      firstSyncSample: firstSync < 0 ? undefined : firstSync,
      firstSyncPresentationSeconds: firstSync < 0 ? undefined : round((samples[firstSync].cts - t.firstDts) / t.timescale, 6),
      bytes: buffer.byteLength,
      first,
      endExclusive,
      samples: endExclusive - first,
      startDecodeSeconds: round(startDts / t.timescale, 6),
      endDecodeSeconds: round(endDts / t.timescale, 6),
      earliestPresentationSeconds: round((minCts - t.firstDts) / t.timescale, 6),
      latestPresentationEndSeconds: round((maxCtsEnd - t.firstDts) / t.timescale, 6),
      firstIsSync: Boolean(samples[first].is_sync),
      verifiedFirstSampleSync,
      problems,
    };
  }

  stats() {
    return {
      cuts: this.cuts,
      reads: this.reader?.stats.reads,
      bytesRead: this.reader?.stats.bytesRead,
      rereadBytes: this.reader?.stats.rereadBytes,
      maxReadBytes: this.reader?.stats.maxReadBytes,
      maxInFlightBytes: this.reader?.stats.maxInFlightBytes,
      sourceSize: this.reader?.size,
      parser: parserMemory(this.mp4),
      parserErrors: this.parserErrors.length,
    };
  }

  #assertOpen() {
    if (this.closed) throw new PreparationError("CLOSED", "Preparer is closed", { stage: "cut" });
  }

  /** Drop the parser, sample tables, and init buffers. */
  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.mp4?.stop?.();
    } catch {
      // MP4Box.js stop() only clears sample-processing flags; nothing to recover.
    }
    if (this.mp4) {
      this.mp4.onReady = undefined;
      this.mp4.onError = undefined;
    }
    this.mp4 = undefined;
    this.tracks = [];
    this.inits = undefined;
  }
}
