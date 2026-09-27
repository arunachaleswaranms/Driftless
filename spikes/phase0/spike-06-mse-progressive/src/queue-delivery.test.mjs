// Unit tests for the append queue, delivery scheduler, segment state, and ranges.

import assert from "node:assert/strict";
import test from "node:test";

import { AppendQueue } from "./append-queue.mjs";
import { DELIVERY_PROFILES, DeliveryScheduler, SegmentState, releaseDelayMs } from "./delivery.mjs";
import { BoundedLog, ResourceTracker } from "./diagnostics.mjs";
import { bufferedAhead, compareRanges, isNormalized, rangeIndexAt, snapshotRanges } from "./ranges.mjs";
import { FakeSourceBuffer, fakeTimers, flush } from "./test-fakes.mjs";

const bytes = (marker, n = 16) => new Uint8Array(n).fill(marker).buffer;

// ---------------------------------------------------------------- append queue

test("append queue: ordered, one operation at a time, never while updating, bytes released", async () => {
  const sb = new FakeSourceBuffer();
  const done = [];
  const q = new AppendQueue(sb, { onOpDone: (op) => done.push(op) });
  for (let i = 1; i <= 6; i += 1) q.append(bytes(i), { k: i });
  assert.equal(sb.calls.length, 1, "only the first append is issued synchronously");
  await q.whenIdle();
  assert.deepEqual(sb.calls.map((c) => c.marker), [1, 2, 3, 4, 5, 6]);
  assert.equal(sb.violations, 0);
  assert.equal(q.stats.appendsCompleted, 6);
  assert.equal(q.stats.invalidStateThrows, 0);
  assert.ok(done.every((op) => op.bytes === null), "every completed op dropped its bytes");
  assert.deepEqual(done.map((op) => op.meta.k), [1, 2, 3, 4, 5, 6]);
  assert.equal(q.state, "idle");
  assert.equal(q.pendingBytes, 0);
});

test("append queue: clearPending drops queued operations and lets the in-flight one finish", async () => {
  const sb = new FakeSourceBuffer({ auto: false });
  const done = [];
  const q = new AppendQueue(sb, { onOpDone: (op) => done.push(op.meta.k) });
  q.append(bytes(1), { k: 1 });
  q.append(bytes(2, 100), { k: 2 });
  q.append(bytes(3, 100), { k: 3 });
  const dropped = q.clearPending("seek");
  assert.deepEqual(dropped, { ops: 2, bytes: 200, metas: [{ type: "append", k: 2 }, { type: "append", k: 3 }] });
  assert.equal(sb.updating, true);
  sb.completeNow();
  await q.whenIdle();
  assert.deepEqual(done, [1]);
  assert.equal(sb.calls.length, 1);
});

test("append queue: an error event fails the queue closed and drops the rest", async () => {
  const sb = new FakeSourceBuffer();
  const failures = [];
  const q = new AppendQueue(sb, { onFailure: (f) => failures.push(f) });
  sb.failNext = true;
  q.append(bytes(1), { k: 1 });
  q.append(bytes(2), { k: 2 });
  await q.whenIdle();
  assert.equal(q.state, "failed");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, "APPEND_ERROR");
  assert.equal(failures[0].droppedOps, 1);
  assert.equal(sb.calls.length, 1, "nothing is issued after the error");
  assert.throws(() => q.append(bytes(3)), { code: "QUEUE_FAILED" });
});

test("append queue: QuotaExceededError evicts via remove() and retries the append", async () => {
  const sb = new FakeSourceBuffer();
  sb.quotaThrows = 1;
  const quota = [];
  const q = new AppendQueue(sb, { onQuotaExceeded: (op, e) => (quota.push(e.name), { removeStart: 0, removeEnd: 10 }) });
  q.append(bytes(7), { k: 7 });
  await q.whenIdle();
  assert.deepEqual(quota, ["QuotaExceededError"]);
  assert.deepEqual(sb.calls.map((c) => c.type), ["remove", "append"]);
  assert.deepEqual([sb.calls[0].start, sb.calls[0].end], [0, 10]);
  assert.equal(q.stats.appendsCompleted, 1);
  assert.equal(q.state, "idle");
});

test("append queue: QuotaExceededError can defer until resume()", async () => {
  const sb = new FakeSourceBuffer();
  sb.quotaThrows = 1;
  const q = new AppendQueue(sb, { onQuotaExceeded: () => ({ defer: true }) });
  q.append(bytes(1), { k: 1 });
  assert.equal(q.state, "blocked");
  assert.equal(sb.calls.length, 0);
  q.resume();
  await q.whenIdle();
  assert.equal(sb.calls.length, 1);
  assert.equal(q.stats.quotaExceeded, 1);
});

test("append queue: repeated QuotaExceededError fails after the attempt limit", async () => {
  const sb = new FakeSourceBuffer();
  sb.quotaThrows = 100;
  const failures = [];
  const q = new AppendQueue(sb, { limits: { maxQueuedOps: 8, maxQueuedBytes: 1e6, maxQuotaAttempts: 2 }, onFailure: (f) => failures.push(f.code), onQuotaExceeded: () => ({ defer: true }) });
  q.append(bytes(1));
  q.resume();
  q.resume();
  assert.equal(q.state, "failed");
  assert.deepEqual(failures, ["QUOTA_EXCEEDED"]);
});

test("append queue: abortCurrent() aborts the in-flight append and continues", async () => {
  const sb = new FakeSourceBuffer({ auto: false });
  const done = [];
  const q = new AppendQueue(sb, { onOpDone: (op) => done.push({ k: op.meta.k, aborted: Boolean(op.aborted) }) });
  q.append(bytes(1), { k: 1 });
  q.append(bytes(2), { k: 2 });
  assert.equal(q.abortCurrent(), true);
  assert.deepEqual(done, [{ k: 1, aborted: true }]);
  assert.equal(q.stats.aborts, 1);
  assert.equal(q.stats.appendsCompleted, 0);
  sb.completeNow();
  await q.whenIdle();
  assert.deepEqual(done[1], { k: 2, aborted: false });
});

test("append queue: waits for foreign updates and ignores events after close()", async () => {
  const sb = new FakeSourceBuffer();
  sb.updating = true;
  const done = [];
  const q = new AppendQueue(sb, { onOpDone: (op) => done.push(op.id) });
  q.append(bytes(1));
  assert.equal(sb.calls.length, 0);
  assert.equal(q.stats.foreignUpdating, 1);
  sb.updating = false;
  sb.dispatchEvent(new Event("updateend"));
  await q.whenIdle();
  assert.equal(sb.calls.length, 1);
  assert.equal(q.stats.strayUpdateEnd, 1);

  q.close();
  sb.dispatchEvent(new Event("updateend"));
  assert.equal(done.length, 1, "no callbacks after close");
  assert.equal(q.state, "closed");
  assert.throws(() => q.append(bytes(2)), { code: "QUEUE_CLOSED" });
});

test("append queue: enforces queued-operation and queued-byte bounds", () => {
  const sb = new FakeSourceBuffer({ auto: false });
  const q = new AppendQueue(sb, { limits: { maxQueuedOps: 2, maxQueuedBytes: 100, maxQuotaAttempts: 1 } });
  q.append(bytes(1, 40));
  q.append(bytes(2, 40));
  assert.throws(() => q.append(bytes(3, 40)), { code: "QUEUE_BYTES" });
  q.append(bytes(4, 10));
  assert.throws(() => q.append(bytes(5, 1)), { code: "QUEUE_FULL" });
});

// ---------------------------------------------------------------- delivery

test("release delays are deterministic multiples of media duration", () => {
  assert.equal(releaseDelayMs(DELIVERY_PROFILES.FAST, 2, 0), 250);
  assert.equal(Math.round(releaseDelayMs(DELIVERY_PROFILES.NORMAL, 2, 0)), 1333);
  assert.equal(releaseDelayMs(DELIVERY_PROFILES.SLOW, 2, 0), 4000);
  assert.deepEqual([0, 1, 2, 3, 4].map((o) => Math.round(releaseDelayMs(DELIVERY_PROFILES.BURSTY, 2, o))), [333, 333, 333, 6333, 333]);
  assert.equal(releaseDelayMs(DELIVERY_PROFILES.MANUAL, 2, 0), Infinity);
});

function harness({ profile = DELIVERY_PROFILES.NORMAL, initialSegments = 2, n = 10, gate, deliverResult } = {}) {
  const timers = fakeTimers();
  const segments = Array.from({ length: n }, (_, i) => ({ startSeconds: i * 2, endSeconds: i * 2 + 2 }));
  const state = new SegmentState(segments);
  const log = [];
  const cursor = { from: 0 };
  const scheduler = new DeliveryScheduler({
    timers,
    profile,
    initialSegments,
    nextIndex: () => state.nextNeeded(cursor.from),
    deliver: async (k, kind) => {
      if (deliverResult && !deliverResult(k)) return false;
      log.push({ k, kind, at: timers.now() });
      state.markAppended(k);
      return true;
    },
    durationOf: () => 2,
    gate: gate ?? (() => ({ open: true })),
  });
  return { timers, state, log, scheduler, cursor };
}

test("scheduler: initial burst, then one release per profile interval", async () => {
  const h = harness();
  await h.scheduler.start();
  assert.deepEqual(h.log.map((x) => [x.k, x.kind, x.at]), [[0, "burst", 0], [1, "burst", 0]]);
  await h.timers.advance(1333);
  assert.equal(h.log.length, 2, "not yet due");
  await h.timers.advance(1);
  assert.equal(h.log[2].k, 2);
  assert.equal(h.log[2].kind, "scheduled");
  assert.ok(Math.abs(h.log[2].at - 4000 / 3) < 0.01, `released at ${h.log[2].at}`);
  await h.timers.advance(20_000);
  assert.equal(h.log.length, 10);
  assert.equal(h.scheduler.state, "done");
  assert.equal(h.timers.pending, 0);
  const gaps = h.log.slice(2).map((x, i) => x.at - (i === 0 ? 0 : h.log[i + 1].at));
  assert.ok(gaps.slice(1).every((g) => Math.abs(g - 1333.33) < 1), `gaps ${gaps}`);
});

test("scheduler: MANUAL withholds after the burst; hold/resume/release are explicit", async () => {
  const h = harness({ profile: DELIVERY_PROFILES.MANUAL, initialSegments: 3 });
  await h.scheduler.start();
  await h.timers.advance(60_000);
  assert.equal(h.log.length, 3, "nothing released beyond the initial buffer");
  assert.equal(await h.scheduler.release(2), 2);
  assert.deepEqual(h.log.slice(3).map((x) => x.kind), ["manual", "manual"]);
  h.scheduler.setProfile(DELIVERY_PROFILES.FAST);
  await h.timers.advance(250);
  assert.equal(h.log.length, 6);
  h.scheduler.hold();
  await h.timers.advance(10_000);
  assert.equal(h.log.length, 6, "held");
  assert.equal(h.timers.pending, 0);
  h.scheduler.resume();
  await h.timers.advance(0);
  assert.equal(h.log.length, 7, "the overdue release happens on resume");
  await h.timers.advance(249);
  assert.equal(h.log.length, 7);
  await h.timers.advance(1);
  assert.equal(h.log.length, 8, "then the profile interval applies again");
});

test("scheduler: a closed gate defers releases without dropping them", async () => {
  let open = false;
  const h = harness({ profile: DELIVERY_PROFILES.FAST, initialSegments: 1, gate: () => ({ open }) });
  await h.scheduler.start();
  await h.timers.advance(2000);
  assert.equal(h.log.length, 1);
  assert.ok(h.scheduler.stats.gated >= 6);
  open = true;
  await h.timers.advance(300);
  assert.equal(h.log.length, 2);
});

test("scheduler: urgent() releases the new next segment without waiting; stale releases retry at once", async () => {
  const h = harness({ profile: DELIVERY_PROFILES.SLOW, initialSegments: 1 });
  await h.scheduler.start();
  h.cursor.from = 7; // playhead moved (seek)
  h.scheduler.urgent();
  await h.timers.advance(0);
  assert.deepEqual(h.log.map((x) => x.k), [0, 7]);

  let refused = false;
  const refuseOnce = (k) => {
    if (k === 1 && !refused) {
      refused = true;
      return false;
    }
    return true;
  };
  const s = harness({ profile: DELIVERY_PROFILES.FAST, initialSegments: 0, deliverResult: refuseOnce });
  await s.scheduler.start();
  await s.timers.advance(0);
  assert.deepEqual(s.log.map((x) => x.k), [0]);
  await s.timers.advance(250);
  assert.deepEqual(s.log.map((x) => [x.k, x.at]), [[0, 0], [1, 250]], "stale k=1 re-offered immediately");
  assert.equal(s.scheduler.stats.staleSkipped, 1);
});

test("scheduler: stop() cancels the pending timer", async () => {
  const h = harness({ profile: DELIVERY_PROFILES.SLOW });
  await h.scheduler.start();
  assert.equal(h.scheduler.timersActive, 1);
  h.scheduler.stop();
  assert.equal(h.scheduler.timersActive, 0);
  assert.equal(h.timers.pending, 0);
  await h.timers.advance(60_000);
  assert.equal(h.log.length, 2);
});

test("segment state: next needed from the playhead, in-flight, removal, contiguous availability", () => {
  const segs = Array.from({ length: 6 }, (_, i) => ({ startSeconds: i * 2, endSeconds: i * 2 + 2 }));
  const st = new SegmentState(segs);
  st.markAppended(0);
  st.markAppended(1);
  st.markInFlight(2);
  assert.equal(st.nextNeeded(0), 3);
  assert.equal(st.nextNeeded(4), 4);
  assert.equal(st.availableEndFrom(0), 6);
  assert.equal(st.availableEndFrom(3), undefined);
  st.dropInFlight([2]);
  assert.equal(st.nextNeeded(0), 2);
  assert.deepEqual(st.markRemoved(0, 3), [0, 1]);
  assert.equal(st.nextSequential(), 0);
  for (let k = 0; k < 6; k += 1) st.markAppended(k);
  assert.equal(st.allAppended(), true);
  assert.equal(st.nextNeeded(0), undefined);
});

// ---------------------------------------------------------------- ranges / diagnostics

test("ranges: snapshot, containment with tolerance, ahead, growth comparison", () => {
  const tr = { length: 2, start: (i) => [0.067, 40][i], end: (i) => [12.5, 44][i] };
  const r = snapshotRanges(tr);
  assert.deepEqual(r, [[0.067, 12.5], [40, 44]]);
  assert.equal(isNormalized(r), true);
  assert.equal(rangeIndexAt(r, 0, 0), -1);
  assert.equal(rangeIndexAt(r, 0, 0.1), 0);
  assert.equal(rangeIndexAt(r, 41, 0), 1);
  assert.equal(bufferedAhead(r, 10, 0), 2.5);
  assert.equal(bufferedAhead(r, 20, 0), 0);
  const grown = compareRanges([[0, 4]], [[0, 6]]);
  assert.deepEqual([grown.lost, grown.endMovedBack, grown.growthSeconds], [[], false, 2]);
  const shrunk = compareRanges([[0, 6]], [[0, 2], [3, 6]]);
  assert.deepEqual(shrunk.lost, [[0, 6]]);
  assert.equal(isNormalized([[0, 2], [1, 3]]), false);
});

test("diagnostics: bounded log keeps the head and a ring; resource tracker reports live resources", () => {
  const log = new BoundedLog(10, 3);
  for (let i = 0; i < 100; i += 1) log.push(i);
  assert.equal(log.length, 10);
  assert.deepEqual(log.entries().slice(0, 3), [0, 1, 2]);
  assert.deepEqual(log.entries().slice(-2), [98, 99]);
  assert.equal(log.total, 100);

  const env = { URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }, setTimeout, clearTimeout, setInterval, clearInterval };
  const res = new ResourceTracker(env);
  const url = res.createObjectURL({});
  const t = res.setTimeout(() => {}, 10_000);
  const iv = res.setInterval(() => {}, 10_000);
  const group = res.listenerGroup();
  const target = new EventTarget();
  let hits = 0;
  group.on(target, "x", () => (hits += 1));
  target.dispatchEvent(new Event("x"));
  assert.deepEqual([res.report().liveObjectUrls, res.report().liveTimeouts, res.report().liveIntervals, res.report().liveListenerGroups], [1, 1, 1, 1]);
  res.revokeObjectURL(url);
  res.clearTimeout(t);
  res.clearInterval(iv);
  group.abort();
  target.dispatchEvent(new Event("x"));
  assert.equal(hits, 1, "listener removed by the group abort");
  const rep = res.report();
  assert.deepEqual([rep.liveObjectUrls, rep.liveTimeouts, rep.liveIntervals, rep.liveListenerGroups], [0, 0, 0, 0]);
  assert.equal(rep.totals.listenersAdded, 1);
});

test("flush helper settles microtasks and immediates", async () => {
  let x = 0;
  queueMicrotask(() => (x += 1));
  setImmediate(() => (x += 1));
  await flush();
  await flush();
  assert.equal(x, 2);
});

test("append queue: an exception in onOpDone is recorded and does not wedge the queue", async () => {
  const sb = new FakeSourceBuffer();
  const q = new AppendQueue(sb, {
    onOpDone: () => {
      throw new TypeError("consumer bug");
    },
  });
  q.append(bytes(1));
  q.append(bytes(2));
  await q.whenIdle();
  assert.equal(q.state, "idle");
  assert.equal(q.stats.appendsCompleted, 2);
  assert.equal(q.stats.callbackErrors, 2);
  assert.match(q.snapshot().lastCallbackError, /consumer bug/);
});
