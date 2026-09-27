// EXPERIMENT ONLY. Playback-need model shared by the Spike 0.7 receiver and host.
//
// Invariant: host scheduling follows the receiver's *current playback need*, never the
// host's previous transfer position. The need is the first media segment that is not
// contiguously available from the playhead, stamped with the receiver's intent
// generation (bumped on every seek, local or remote) and a session-monotonic sequence.
// Disjoint buffered media elsewhere on the timeline neither satisfies the need nor
// counts toward the ahead cap.
import { rangeIndexAt } from "../../spike-06-mse-progressive/src/ranges.mjs";

export const SCHEDULE = Object.freeze({
  aheadCapSeconds: 20,
  // Playhead-in-range tolerance (edit-list start offsets, playhead stalled just short of a run end).
  toleranceSeconds: 0.1,
  // A run ending this close to a segment end counts as reaching it: the audio/video
  // intersection ends 6–16 ms short in Chrome. Kept below two 30 fps frames (66.7 ms),
  // because Chrome does not play across a real 67 ms gap.
  segmentEndToleranceSeconds: 0.04,
  // Per generation. A segment still needed after this many deliveries cannot fill its gap
  // (for example a gap inside the media itself); the host stops rather than loop.
  maxDeliveriesPerSegment: 3,
  keepBehindSeconds: 30,
  keepAheadSeconds: 30,
  // Back trims wait for this much extra history so each remove() covers several seconds.
  backTrimHysteresisSeconds: 10,
  futureTrimHysteresisSeconds: 1,
  // Unchanged needs are re-sent at most this often; a changed need is sent at once.
  minNeedIntervalMs: 200,
  // A forced (seek/waiting) need identical to one just sent is suppressed within this window.
  forcedRepeatMs: 100,
});

/**
 * Receiver side. The need is the segment at the *contiguous frontier*: the end of the
 * buffered run containing the playhead (or the playhead itself when it is unbuffered).
 * `segments` maps segment index -> { start, end } as learned from PART_INFO; it is only a
 * time -> index map for the deterministic plan, so it stays valid when MSE media is later
 * trimmed or evicted. A segment whose tail was cut off is the need itself, even when
 * most of it (including its midpoint) is still buffered.
 *
 * While seeking, containment is strict: Chrome does not resolve a seek whose target lies
 * even a few tens of ms before the buffered start, so a start tolerance would report an
 * unplayable target as buffered.
 */
export function computePlaybackNeed({ ranges, currentTime, segments, segmentCount, seeking = false, tolerance = SCHEDULE.toleranceSeconds, endTolerance = SCHEDULE.segmentEndToleranceSeconds }) {
  const t = currentTime;
  const i = rangeIndexAt(ranges, t, seeking ? 0 : tolerance);
  const contiguousBufferedEnd = i < 0 ? t : ranges[i][1];
  const contiguousAhead = Math.max(0, contiguousBufferedEnd - t);
  const frontier = contiguousBufferedEnd;
  let first = null;
  for (const [k, s] of segments) {
    // Media at the frontier belongs to k, and k runs on past it: k is incomplete.
    const inside = i >= 0 ? s.start - endTolerance <= frontier && frontier < s.end - endTolerance : s.start <= frontier && frontier < s.end;
    if (inside && (first === null || k < first)) first = k;
  }
  if (first === null && i >= 0) {
    // The buffered run ends on a known segment end: the next segment is missing. (An
    // unbuffered playhead just before a segment end still needs that segment itself.)
    for (const [k, s] of segments) if (Math.abs(s.end - frontier) <= endTolerance && (first === null || k + 1 < first)) first = k + 1;
  }
  if (first !== null) first = Math.min(first, segmentCount);
  // With no known segment at the frontier the host maps the time through its own index.
  const needTime = first !== null && segments.get(first) ? Math.max(segments.get(first).start, 0) : frontier;
  return { currentTime: t, playheadBuffered: i >= 0, contiguousBufferedEnd, contiguousAhead, firstMissingSegment: first, needTime };
}

/** Buffered seconds outside the playhead's contiguous range (behind or disjoint ahead). */
export function disjointRetained(ranges, currentTime, tolerance = SCHEDULE.toleranceSeconds) {
  const i = rangeIndexAt(ranges, currentTime, tolerance);
  return ranges.reduce((n, [a, b], j) => (j === i ? n : n + (b - a)), 0);
}

/**
 * Receiver MSE window. Returns the ranges to remove, or null. Never removes the playhead's
 * contiguous playable run, and does nothing while seeking so a pending target is kept.
 * There is deliberately no playhead-movement precondition: a stalled playhead still trims.
 */
export function planTrim({ ranges, currentTime: t, contiguousBufferedEnd, duration, seeking }) {
  if (seeking || !ranges.length || !Number.isFinite(duration)) return null;
  const keepLow = Math.max(0, Math.floor(t - SCHEDULE.keepBehindSeconds));
  const keepHigh = Math.min(duration, Math.max(Math.ceil(t + SCHEDULE.keepAheadSeconds), contiguousBufferedEnd ?? t));
  const back = keepLow > 0 && ranges[0][0] < t - SCHEDULE.keepBehindSeconds - SCHEDULE.backTrimHysteresisSeconds ? [0, keepLow] : null;
  const future = keepHigh < duration && ranges.some(([, e]) => e > keepHigh + SCHEDULE.futureTrimHysteresisSeconds) ? [keepHigh, duration] : null;
  return back || future ? { back, future } : null;
}

/** Receiver side: stamps needs with generation/sequence and suppresses repeats. */
export class NeedReporter {
  constructor({ now = () => performance.now() } = {}) {
    this.now = now;
    this.seq = 0;
    this.lastKey = null;
    this.lastAt = -Infinity;
    this.stats = { needsSent: 0, needsSuppressed: 0 };
  }
  claimSeq() { return ++this.seq; }
  next(need, { generation, reason, force = false }) {
    const now = this.now();
    const key = `${generation}|${need.firstMissingSegment}|${need.playheadBuffered}`;
    const changed = key !== this.lastKey;
    if (!changed && now - this.lastAt < (force ? SCHEDULE.forcedRepeatMs : SCHEDULE.minNeedIntervalMs)) { this.stats.needsSuppressed++; return null; }
    this.lastKey = key;
    this.lastAt = now;
    this.stats.needsSent++;
    return { generation, seq: this.claimSeq(), reason, currentTime: need.currentTime, playheadBuffered: need.playheadBuffered, contiguousBufferedEnd: need.contiguousBufferedEnd, contiguousAhead: need.contiguousAhead, firstMissingSegment: need.firstMissingSegment, needTime: need.needTime };
  }
}

const finiteIn = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;

/**
 * Host side. Holds the latest valid receiver need and derives the next segment from it.
 * `cursor` is only the position within the current need: every accepted need rebases it.
 */
export class HostScheduler {
  constructor({ segmentCount, duration, indexForTime, segmentTimes, aheadCapSeconds = SCHEDULE.aheadCapSeconds }) {
    Object.assign(this, { segmentCount, duration, indexForTime, segmentTimes, aheadCapSeconds });
    this.generation = 0;
    this.lastSeq = 0;
    this.need = null;
    this.cursor = 0;
    this.inFlight = null;
    this.deliveries = new Map();
    this.stats = { needsAccepted: 0, staleNeedsIgnored: 0, invalidNeeds: 0, retargets: 0, generationChanges: 0, redeliveries: 0, deliveryLimitWaits: 0, aheadCapWaits: 0, windowWaits: 0, heldWaits: 0, completeWaits: 0, maxSentAheadSeconds: 0 };
  }
  #validate(m) {
    if (!Number.isInteger(m.generation) || m.generation < 0 || !Number.isInteger(m.seq) || m.seq < 1) return "generation or sequence";
    if (m.type === "SEEK_REQUEST") return finiteIn(m.time, 0, this.duration) && m.time < this.duration ? null : "seek time";
    if (!finiteIn(m.currentTime, 0, this.duration) || !finiteIn(m.contiguousBufferedEnd, 0, this.duration + 1) || !finiteIn(m.contiguousAhead, 0, this.duration + 1) || !finiteIn(m.needTime, 0, this.duration + 1) || typeof m.playheadBuffered !== "boolean") return "need fields";
    if (m.firstMissingSegment !== null && !(Number.isInteger(m.firstMissingSegment) && m.firstMissingSegment >= 0 && m.firstMissingSegment <= this.segmentCount)) return "first missing segment";
    return null;
  }
  /** Accept a SEEK_REQUEST or BUFFER_STATUS. Older generations and sequences are ignored. */
  accept(m) {
    const invalid = this.#validate(m);
    if (invalid) { this.stats.invalidNeeds++; return { accepted: false, reason: invalid }; }
    if (m.generation < this.generation || m.seq <= this.lastSeq) { this.stats.staleNeedsIgnored++; return { accepted: false, reason: "stale" }; }
    const newGeneration = m.generation > this.generation;
    this.generation = m.generation;
    this.lastSeq = m.seq;
    this.need = m.type === "SEEK_REQUEST"
      ? { generation: m.generation, seq: m.seq, currentTime: m.time, playheadBuffered: false, contiguousBufferedEnd: m.time, contiguousAhead: 0, firstMissingSegment: null, needTime: m.time }
      : { generation: m.generation, seq: m.seq, currentTime: m.currentTime, playheadBuffered: m.playheadBuffered, contiguousBufferedEnd: m.contiguousBufferedEnd, contiguousAhead: m.contiguousAhead, firstMissingSegment: m.firstMissingSegment, needTime: m.needTime };
    this.stats.needsAccepted++;
    if (newGeneration) { this.stats.generationChanges++; this.deliveries.clear(); }
    const target = this.need.firstMissingSegment ?? Math.min(this.segmentCount - 1, Math.max(0, this.indexForTime(Math.min(this.need.needTime, this.duration))));
    // Completing the in-flight segment, or asking for the one after it, is progress, not a retarget.
    const natural = this.inFlight === null ? [this.cursor] : [this.inFlight, this.inFlight + 1];
    const retargeted = newGeneration || !natural.includes(target);
    if (retargeted) this.stats.retargets++;
    this.cursor = target;
    return { accepted: true, newGeneration, retargeted, target };
  }
  /** The next action for the host transfer loop: { segment } or { wait }. */
  next({ held = false } = {}) {
    if (held) { this.stats.heldWaits++; return { wait: "held" }; }
    const k = this.cursor;
    if (k >= this.segmentCount) { this.stats.completeWaits++; return { wait: "complete" }; }
    if ((this.deliveries.get(k) ?? 0) >= SCHEDULE.maxDeliveriesPerSegment) { this.stats.deliveryLimitWaits++; return { wait: "delivery-limit" }; }
    const need = this.need;
    if (need?.playheadBuffered && need.contiguousAhead >= this.aheadCapSeconds) { this.stats.aheadCapWaits++; return { wait: "ahead-cap" }; }
    // Safety bound: never send media far beyond the reported playhead, even if a stale or
    // inconsistent need or the optimistic cursor advance would suggest it.
    const anchor = need?.currentTime ?? 0;
    const start = this.segmentTimes(k).start;
    if (start > anchor + this.aheadCapSeconds) { this.stats.windowWaits++; return { wait: "outside-window" }; }
    this.stats.maxSentAheadSeconds = Math.max(this.stats.maxSentAheadSeconds, start - anchor);
    return { segment: k };
  }
  begin(k) { this.inFlight = k; }
  abandon() { this.inFlight = null; }
  /** Record a segment delivered and acknowledged in `generation`. */
  delivered(generation, k) {
    this.inFlight = null;
    if (generation !== this.generation) return;
    const n = (this.deliveries.get(k) ?? 0) + 1;
    this.deliveries.set(k, n);
    if (n > 1) this.stats.redeliveries++;
    // Advance optimistically only if no newer need rebased the cursor during delivery.
    if (this.cursor === k) this.cursor = k + 1;
  }
  snapshot() { return { generation: this.generation, lastSeq: this.lastSeq, cursor: this.cursor, inFlight: this.inFlight, need: this.need, stats: { ...this.stats } }; }
}
