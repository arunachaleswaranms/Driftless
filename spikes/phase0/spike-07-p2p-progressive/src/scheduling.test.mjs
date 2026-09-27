import assert from "node:assert/strict";
import test from "node:test";
import { HostScheduler, NeedReporter, SCHEDULE, computePlaybackNeed, disjointRetained, planTrim } from "./scheduling.mjs";

const SEG = 4;
const COUNT = 75;
const records = (from, to) => new Map(Array.from({ length: to - from }, (_, i) => [from + i, { start: (from + i) * SEG, end: (from + i + 1) * SEG }]));
const host = (opts = {}) => new HostScheduler({ segmentCount: COUNT, duration: COUNT * SEG, indexForTime: (t) => Math.floor(t / SEG), segmentTimes: (k) => ({ start: k * SEG, end: (k + 1) * SEG }), ...opts });
const status = (o) => ({ type: "BUFFER_STATUS", generation: 0, seq: 1, currentTime: 0, playheadBuffered: true, contiguousBufferedEnd: 0, contiguousAhead: 0, firstMissingSegment: 0, needTime: 0, ...o });

test("playback need is the first segment missing from the playhead's contiguous run, not a received count", () => {
  // Buffered 12–36 s and a disjoint 56–300 s run; playhead 24 s.
  const segs = new Map([...records(3, 9), ...records(14, COUNT)]);
  const ranges = [[12, 36], [56, 300]];
  const need = computePlaybackNeed({ ranges, currentTime: 24, segments: segs, segmentCount: COUNT });
  assert.equal(need.firstMissingSegment, 9);
  assert.equal(need.needTime, 36);
  assert.equal(need.contiguousBufferedEnd, 36);
  assert.equal(need.contiguousAhead, 12);
  assert.equal(need.playheadBuffered, true);
  // A received-segment count would have pointed far past the gap.
  assert.notEqual(need.firstMissingSegment, segs.size);
  assert.equal(disjointRetained(ranges, 24), 244);
});

test("unbuffered playhead, missing records, eviction, and completion map to the right need", () => {
  const segs = records(0, 9);
  assert.deepEqual(
    [computePlaybackNeed({ ranges: [[0, 36]], currentTime: 43, segments: segs, segmentCount: COUNT })].map((n) => [n.playheadBuffered, n.firstMissingSegment, n.needTime]),
    [[false, null, 43]],
  );
  // MSE evicted 28–36 s behind the host's back: the frontier moves back to segment 7.
  assert.equal(computePlaybackNeed({ ranges: [[0, 28]], currentTime: 20, segments: segs, segmentCount: COUNT }).firstMissingSegment, 7);
  // Buffered without any record (e.g. appended by a superseded generation): time fallback.
  const n = computePlaybackNeed({ ranges: [[0, 36]], currentTime: 10, segments: new Map(), segmentCount: COUNT });
  assert.equal(n.firstMissingSegment, null);
  assert.equal(n.needTime, 36);
  // A stall just before the run's end still resolves to the next segment.
  assert.equal(computePlaybackNeed({ ranges: [[0, 35.98]], currentTime: 35.93, segments: records(0, 9), segmentCount: COUNT }).firstMissingSegment, 9);
  // Fully buffered to the end reports segmentCount.
  assert.equal(computePlaybackNeed({ ranges: [[280, 300]], currentTime: 290, segments: records(70, COUNT), segmentCount: COUNT }).firstMissingSegment, COUNT);
});

test("a segment whose tail was trimmed is the need even though its midpoint is still buffered", () => {
  // Chrome stress geometry: a future trim at 279 s cut segment 70 (274.23–279.67 s) while it
  // was disjoint; later the contiguous run reached 279.0 s and a disjoint 279.67 s run followed.
  const segs = new Map([[69, { start: 269.467, end: 274.233 }], [70, { start: 274.233, end: 279.667 }], [71, { start: 279.667, end: 283.033 }], [72, { start: 283.033, end: 285.567 }]]);
  const need = computePlaybackNeed({ ranges: [[245.167, 279.0], [279.667, 285.559]], currentTime: 278.946, segments: segs, segmentCount: 76 });
  assert.deepEqual([need.firstMissingSegment, need.needTime], [70, 274.233]);
  // Once 70 is re-appended the runs merge and the frontier is 72's end.
  assert.equal(computePlaybackNeed({ ranges: [[245.167, 285.559]], currentTime: 279.1, segments: segs, segmentCount: 76 }).firstMissingSegment, 73);
  // A frontier a few ms short of a segment end (audio/video intersection) means the next one.
  assert.equal(computePlaybackNeed({ ranges: [[245.167, 279.661]], currentTime: 279.1, segments: segs, segmentCount: 76 }).firstMissingSegment, 71);
});

test("a missing 67 ms segment tail is a need, while a 16 ms audio/video shortfall is not", () => {
  // Chrome regression geometry: removing [157, 162) s cut the last 67 ms (two video frames)
  // off segment 39; Chrome stalled at 156.938 s. The need is 39, not 40.
  const segs = new Map([[39, { start: 153.267, end: 157.067 }], [40, { start: 157.067, end: 162.6 }], [41, { start: 162.6, end: 166.233 }]]);
  assert.equal(computePlaybackNeed({ ranges: [[147.167, 157], [162.6, 166.232]], currentTime: 152.39, segments: segs, segmentCount: 76 }).firstMissingSegment, 39);
  // MP-02 startup: the first run ends at 34.017 s, 16 ms before segment 8's 34.033 s end.
  const start = new Map([[8, { start: 30.1, end: 34.033 }]]);
  assert.equal(computePlaybackNeed({ ranges: [[0, 34.017]], currentTime: 12, segments: start, segmentCount: 76 }).firstMissingSegment, 9);
});

test("while seeking, a target just before a segment end or buffered start is not treated as buffered", () => {
  const segs = new Map([[27, { start: 103.9, end: 107.4 }], [28, { start: 107.4, end: 111.2 }]]);
  // Unbuffered target 0.08 s before segment 27's end: 27 itself is needed, not 28.
  const cold = computePlaybackNeed({ ranges: [[228.17, 266.33]], currentTime: 107.32, segments: segs, segmentCount: 76, seeking: true });
  assert.deepEqual([cold.playheadBuffered, cold.firstMissingSegment, cold.contiguousAhead], [false, 27, 0]);
  // Buffered only from 107.4 s: tolerance must not report the seek target as buffered.
  const edge = computePlaybackNeed({ ranges: [[107.4, 130.31]], currentTime: 107.32, segments: segs, segmentCount: 76, seeking: true });
  assert.deepEqual([edge.playheadBuffered, edge.firstMissingSegment, edge.contiguousAhead], [false, 27, 0]);
  // Not seeking (e.g. startup at 0 s with a 20 ms edit-list offset) keeps the tolerance.
  assert.equal(computePlaybackNeed({ ranges: [[0.02, 2]], currentTime: 0, segments: new Map([[0, { start: 0, end: 2 }]]), segmentCount: 76 }).playheadBuffered, true);
});

test("host ignores stale generations and sequences even on an ordered channel", () => {
  const h = host();
  assert.equal(h.accept({ type: "SEEK_REQUEST", generation: 2, seq: 5, time: 250 }).newGeneration, true);
  assert.equal(h.cursor, 62);
  const stale = h.accept(status({ generation: 1, seq: 6, currentTime: 12, contiguousBufferedEnd: 36, contiguousAhead: 24, firstMissingSegment: 9, needTime: 36 }));
  assert.deepEqual([stale.accepted, stale.reason], [false, "stale"]);
  assert.equal(h.accept(status({ generation: 2, seq: 5, firstMissingSegment: 3 })).reason, "stale");
  assert.equal(h.cursor, 62);
  assert.equal(h.stats.staleNeedsIgnored, 2);
  for (const bad of [status({ generation: 3, seq: 9, firstMissingSegment: COUNT + 1 }), status({ generation: 3, seq: 9, currentTime: -1 }), status({ generation: 3, seq: 9, currentTime: Number.NaN }), status({ generation: 1.5, seq: 9 }), { type: "SEEK_REQUEST", generation: 3, seq: 9, time: COUNT * SEG }]) {
    assert.equal(h.accept(bad).accepted, false);
  }
  assert.equal(h.stats.invalidNeeds, 5);
  // A newer local-seek generation wins over the older remote seek.
  const local = h.accept(status({ generation: 3, seq: 7, currentTime: 10, contiguousBufferedEnd: 36, contiguousAhead: 26, firstMissingSegment: 9, needTime: 36 }));
  assert.deepEqual([local.accepted, local.newGeneration, local.retargeted, h.cursor], [true, true, true, 9]);
});

test("ahead cap counts only contiguous coverage, and the window bounds any runaway", () => {
  const h = host();
  // 14–34 s contiguous around 24 s plus a disjoint 58–300 s run: only 10 s ahead counts.
  h.accept(status({ seq: 1, currentTime: 24, contiguousBufferedEnd: 34, contiguousAhead: 10, firstMissingSegment: 8, needTime: 32 }));
  assert.deepEqual(h.next(), { segment: 8 });
  h.accept(status({ seq: 2, currentTime: 24, contiguousBufferedEnd: 44, contiguousAhead: SCHEDULE.aheadCapSeconds, firstMissingSegment: 11, needTime: 44 }));
  assert.deepEqual(h.next(), { wait: "ahead-cap" });
  assert.deepEqual(h.next({ held: true }), { wait: "held" });
  // Even if a need claimed little coverage, nothing beyond playhead + cap is sent.
  h.accept(status({ seq: 3, currentTime: 24, contiguousBufferedEnd: 24, contiguousAhead: 0, firstMissingSegment: 40, needTime: 160 }));
  assert.deepEqual(h.next(), { wait: "outside-window" });
  h.accept(status({ seq: 4, currentTime: 290, contiguousBufferedEnd: 300, contiguousAhead: 10, firstMissingSegment: COUNT, needTime: 300 }));
  assert.deepEqual(h.next(), { wait: "complete" });
});

test("cursor advances optimistically only when no newer need rebased it during delivery", () => {
  const h = host();
  h.accept(status({ seq: 1, currentTime: 12, contiguousBufferedEnd: 20, contiguousAhead: 8, firstMissingSegment: 5, needTime: 20 }));
  h.begin(5);
  // Receiver reports segment 5 complete before its final ACK: progress, not a retarget.
  assert.equal(h.accept(status({ seq: 2, currentTime: 12, contiguousBufferedEnd: 24, contiguousAhead: 12, firstMissingSegment: 6, needTime: 24 })).retargeted, false);
  h.delivered(0, 5);
  assert.equal(h.cursor, 6);
  h.begin(6);
  // Eviction behind the host: the need moves back to 3 while 6 is in flight.
  assert.equal(h.accept(status({ seq: 3, currentTime: 12, contiguousBufferedEnd: 12, contiguousAhead: 0, firstMissingSegment: 3, needTime: 12 })).retargeted, true);
  h.delivered(0, 6);
  assert.equal(h.cursor, 3);
  assert.equal(h.inFlight, null);
  h.begin(3); h.delivered(0, 3); h.begin(4); h.delivered(0, 4); h.begin(5); h.delivered(0, 5);
  assert.equal(h.stats.redeliveries, 1);
  // A segment that cannot fill its gap is not re-sent without bound within one generation.
  h.accept(status({ seq: 4, currentTime: 12, contiguousBufferedEnd: 12, contiguousAhead: 0, firstMissingSegment: 3, needTime: 12 }));
  h.begin(3); h.delivered(0, 3);
  h.accept(status({ seq: 5, currentTime: 12, contiguousBufferedEnd: 12, contiguousAhead: 0, firstMissingSegment: 3, needTime: 12 }));
  h.begin(3); h.delivered(0, 3);
  h.accept(status({ seq: 6, currentTime: 12, contiguousBufferedEnd: 12, contiguousAhead: 0, firstMissingSegment: 3, needTime: 12 }));
  assert.deepEqual(h.next(), { wait: "delivery-limit" });
  assert.equal(h.stats.deliveryLimitWaits, 1);
  // Deliveries from a superseded generation do not move the cursor.
  h.accept(status({ generation: 1, seq: 7, currentTime: 100, contiguousBufferedEnd: 100, contiguousAhead: 0, firstMissingSegment: null, needTime: 100, playheadBuffered: false }));
  h.delivered(0, 25);
  assert.equal(h.cursor, 25);
});

test("MSE window trims while stalled, keeps the playable run, and waits during seeking", () => {
  // Stalled at 33.9 s with far-future disjoint media: must trim despite no playhead motion.
  const stalled = planTrim({ ranges: [[4, 34], [58, 300]], currentTime: 33.9, contiguousBufferedEnd: 34, duration: 300, seeking: false });
  assert.deepEqual(stalled, { back: null, future: [64, 300] });
  assert.equal(planTrim({ ranges: [[4, 34], [58, 300]], currentTime: 33.9, contiguousBufferedEnd: 34, duration: 300, seeking: true }), null);
  // The contiguous run is never cut, even when it reaches beyond the nominal window.
  assert.equal(planTrim({ ranges: [[20, 62]], currentTime: 25, contiguousBufferedEnd: 62, duration: 300, seeking: false }), null);
  // Back trim needs 10 s of hysteresis beyond the 30 s history.
  assert.equal(planTrim({ ranges: [[5, 60]], currentTime: 44, contiguousBufferedEnd: 60, duration: 300, seeking: false }), null);
  assert.deepEqual(planTrim({ ranges: [[5, 60]], currentTime: 46, contiguousBufferedEnd: 60, duration: 300, seeking: false }), { back: [0, 16], future: null });
});

test("need reporter sends changes at once, rate-limits repeats, and stamps a monotonic sequence", () => {
  let now = 0;
  const r = new NeedReporter({ now: () => now });
  const need = (first, t = 10) => ({ currentTime: t, playheadBuffered: true, contiguousBufferedEnd: 20, contiguousAhead: 20 - t, firstMissingSegment: first, needTime: 20 });
  const a = r.next(need(5), { generation: 0, reason: "segment-ready" });
  assert.equal(a.seq, 1);
  assert.equal(r.next(need(5, 10.1), { generation: 0, reason: "timeupdate" }), null);
  now = 50;
  assert.equal(r.next(need(5), { generation: 0, reason: "waiting", force: true }), null);
  now = 150;
  assert.equal(r.next(need(5), { generation: 0, reason: "waiting", force: true }).seq, 2);
  assert.equal(r.next(need(6), { generation: 0, reason: "segment-ready" }).seq, 3);
  assert.equal(r.claimSeq(), 4);
  assert.equal(r.next(need(6), { generation: 1, reason: "local-seek", force: true }).seq, 5);
  now = 400;
  assert.equal(r.next(need(6, 12), { generation: 1, reason: "timeupdate" }).seq, 6);
  assert.deepEqual(r.stats, { needsSent: 5, needsSuppressed: 2 });
});
