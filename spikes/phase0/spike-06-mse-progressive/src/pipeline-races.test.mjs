// Deterministic pipeline regressions: real preparation, controlled MSE completions.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { buildMp4, memorySource } from "../../spike-05-mp4-segmentation/src/test-fixtures.mjs";
import { ProgressivePipeline } from "./pipeline.mjs";
import { PreparationError } from "./preparer.mjs";
import { FakeSourceBuffer, flush } from "./test-fakes.mjs";

const MP4BOX_URL = new URL("../../spike-05-mp4-segmentation/node_modules/mp4box/dist/mp4box.all.mjs", import.meta.url);
if (!existsSync(MP4BOX_URL)) throw new Error("Install Spike 0.5's pinned MP4Box.js before running pipeline races");
const MP4Box = await import(MP4BOX_URL.href);

async function until(predicate, message) {
  for (let i = 0; i < 500; i += 1) {
    if (predicate()) return;
    await flush();
  }
  assert.fail(message);
}

function harness() {
  const original = { MediaSource: globalThis.MediaSource, create: URL.createObjectURL, revoke: URL.revokeObjectURL, navigator: globalThis.navigator };
  const urls = new Map();
  const live = new Set();
  let nextUrl = 0;
  const mediaSources = [];
  class SourceBuffer extends FakeSourceBuffer {
    constructor() {
      super({ auto: false });
      this.mode = "segments";
      this.buffered = { length: 0, start: () => 0, end: () => 0 };
    }
  }
  class MediaSource extends EventTarget {
    static isTypeSupported() { return true; }
    constructor() {
      super();
      this.readyState = "closed";
      this.sourceBuffers = [];
      this.activeSourceBuffers = this.sourceBuffers;
      this.duration = Infinity;
      this.deferClose = false;
      mediaSources.push(this);
    }
    addSourceBuffer() {
      const sb = new SourceBuffer();
      this.sourceBuffers.push(sb);
      return sb;
    }
    endOfStream() { this.readyState = "ended"; this.dispatchEvent(new Event("sourceended")); }
    closeNow() {
      if (this.readyState === "closed") return;
      this.readyState = "closed";
      this.sourceBuffers.length = 0;
      this.dispatchEvent(new Event("sourceclose"));
    }
  }
  class Video extends EventTarget {
    constructor() {
      super();
      this.readyState = 0;
      this.networkState = 0;
      this.paused = true;
      this.seeking = false;
      this.ended = false;
      this.duration = 10;
      this.currentSrc = "";
      this.range = [];
      this.source = undefined;
      this.attributes = new Map();
    }
    get buffered() { return { length: this.range.length, start: (i) => this.range[i][0], end: (i) => this.range[i][1] }; }
    get currentTime() { return this.time ?? 0; }
    set currentTime(t) { this.time = t; this.seeking = true; this.dispatchEvent(new Event("seeking")); }
    set src(url) {
      this.attributes.set("src", url);
      this.currentSrc = url;
      this.source = urls.get(url);
      queueMicrotask(() => {
        if (this.source?.readyState === "closed") {
          this.source.readyState = "open";
          this.source.dispatchEvent(new Event("sourceopen"));
        }
      });
    }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    removeAttribute(key) { this.attributes.delete(key); }
    pause() { this.paused = true; }
    play() { this.paused = false; this.dispatchEvent(new Event("playing")); return Promise.resolve(); }
    load() {
      this.readyState = 0;
      const old = this.source;
      this.source = undefined;
      this.range = [];
      if (old && !old.deferClose) queueMicrotask(() => old.closeNow());
    }
    resolveSeek(start, end) {
      this.range = [[start, end]];
      this.seeking = false;
      this.readyState = 4;
      this.dispatchEvent(new Event("seeked"));
    }
  }
  globalThis.MediaSource = MediaSource;
  URL.createObjectURL = (ms) => { const url = `blob:race-${++nextUrl}`; urls.set(url, ms); live.add(url); return url; };
  URL.revokeObjectURL = (url) => { live.delete(url); };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userActivation: { isActive: true } } });
  const video = new Video();
  const pipeline = new ProgressivePipeline({ video, MP4Box });
  const file = (name) => Object.assign(memorySource(buildMp4({ seconds: 10 }).bytes), { name });
  async function load(name, opts = {}) {
    const pending = pipeline.load(file(name), { profile: "MANUAL", initialSegments: 0, sampleIntervalMs: 1_000_000, backBufferSeconds: null, ...opts });
    await until(() => mediaSources.at(-1)?.sourceBuffers.length > 0, "load did not create SourceBuffer");
    for (const sb of mediaSources.at(-1).sourceBuffers) sb.completeNow(); // init only
    const result = await pending;
    assert.equal(result.ok, true);
    return mediaSources.at(-1);
  }
  async function cleanup() {
    for (const ms of mediaSources) ms.closeNow();
    await pipeline.reset("test-cleanup");
    if (original.MediaSource === undefined) delete globalThis.MediaSource;
    else globalThis.MediaSource = original.MediaSource;
    URL.createObjectURL = original.create;
    URL.revokeObjectURL = original.revoke;
    if (original.navigator === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, "navigator", { configurable: true, value: original.navigator });
  }
  return { pipeline, video, mediaSources, live, file, load, cleanup };
}

test("B1: a seek drops queued audio; the surviving old video cannot append the segment; a fresh attempt resolves seeking", async () => {
  const h = harness();
  try {
    const ms = await h.load("A.mp4");
    const sb = ms.sourceBuffers[0];
    assert.equal(await h.pipeline.release(1), 1);
    assert.equal(sb.updating, true, "segment 0 video is in flight");
    assert.equal(h.pipeline.snapshot().sourceBuffers[0].queue.pendingOps, 1, "audio is queued");
    h.pipeline.seek(5); // drops queued audio from attempt 1
    assert.equal(h.pipeline.snapshot().segments.appended, 0);
    assert.equal(h.pipeline.snapshot().segments.inFlight.includes(0), false);
    sb.completeNow(); // old video callback arrives after abandonment
    assert.equal(h.pipeline.snapshot().segments.appended, 0);
    assert.equal(h.pipeline.snapshot().segments.inFlight.includes(0), false);
    assert.equal(h.pipeline.recorder.timeline.entries().some((e) => e.type === "segment-attempt-abandoned" && e.k === 0), true);
    h.pipeline.seek(0);
    await until(() => sb.calls.filter((c) => c.type === "append").length >= 3, "target segment was not redelivered");
    assert.equal(h.pipeline.snapshot().segments.appended, 0);
    assert.deepEqual(h.pipeline.session.scheduler.gate(), { open: false, reason: "target-append-pending" });
    assert.equal(h.video.seeking, true);
    sb.completeNow(); // fresh video
    assert.equal(h.pipeline.snapshot().segments.appended, 0);
    assert.equal(h.video.seeking, true);
    sb.completeNow(); // fresh audio
    assert.equal(h.pipeline.snapshot().segments.appended, 1);
    h.video.resolveSeek(0, 2);
    assert.equal(h.pipeline.snapshot().seeking, false);
    assert.equal(h.pipeline.recorder.seeks.last(1)[0].seekedAt !== undefined, true);
    assert.ok(h.pipeline.snapshot().totals.delivered <= 2, "no following-segment runaway while target lacked audio");
  } finally { await h.cleanup(); }
});

test("RESET-RACE-01: B is loaded only after A closes, remains owned, plays, and resets", async () => {
  const h = harness();
  try {
    const a = await h.load("A.mp4");
    a.deferClose = true;
    const resetA = h.pipeline.reset("A-reset");
    const loadB = h.pipeline.load(h.file("B.mp4"), { profile: "MANUAL", initialSegments: 0 });
    await until(() => h.pipeline.state === "closing", "A teardown did not begin");
    assert.equal(h.mediaSources.length, 1, "B waits for A teardown");
    a.closeNow();
    assert.equal((await resetA).clean, true);
    await until(() => h.mediaSources.length === 2 && h.mediaSources[1].sourceBuffers.length === 1, "B did not open");
    h.mediaSources[1].sourceBuffers[0].completeNow();
    assert.equal((await loadB).ok, true);
    assert.equal(h.pipeline.snapshot().sessionId, h.pipeline.session.id);
    assert.equal((await h.pipeline.play()).ok, true);
    assert.equal((await h.pipeline.reset("B-reset")).clean, true);
    assert.equal(h.pipeline.state, "idle");
    assert.equal(h.live.size, 0);
  } finally { await h.cleanup(); }
});

test("RESET-RACE-02: callbacks from A after B opens leave B untouched", async () => {
  const h = harness();
  try {
    const a = await h.load("A.mp4");
    const oldQueue = h.pipeline.session.sbs[0].queue;
    await h.pipeline.reset("A-reset");
    await h.load("B.mp4");
    const b = h.pipeline.session;
    a.dispatchEvent(new Event("sourceclose"));
    a.dispatchEvent(new Event("sourceopen"));
    oldQueue.onFailure({ code: "LATE_A_FAILURE" });
    assert.equal(h.pipeline.session, b);
    assert.equal(h.pipeline.state, "streaming");
    assert.equal((await h.pipeline.reset("B-reset")).clean, true);
  } finally { await h.cleanup(); }
});

test("RESET-RACE-03: rapid load/reset/load/reset leaves no orphaned source or resources", async () => {
  const h = harness();
  try {
    const first = h.pipeline.load(h.file("A.mp4"), { profile: "MANUAL", initialSegments: 0 });
    const resetA = h.pipeline.reset("A-reset");
    const second = h.pipeline.load(h.file("B.mp4"), { profile: "MANUAL", initialSegments: 0 });
    const resetB = h.pipeline.reset("B-reset");
    await until(() => h.mediaSources[0]?.sourceBuffers.length === 1, "A init not queued");
    h.mediaSources[0].sourceBuffers[0].completeNow();
    assert.equal((await first).ok, true);
    assert.equal((await resetA).clean, true);
    await until(() => h.mediaSources[1]?.sourceBuffers.length === 1, "B init not queued");
    h.mediaSources[1].sourceBuffers[0].completeNow();
    assert.equal((await second).ok, true);
    assert.equal((await resetB).clean, true);
    assert.equal(h.pipeline.state, "idle");
    assert.equal(h.pipeline.session, undefined);
    assert.equal(h.live.size, 0);
    assert.ok(h.mediaSources.every((ms) => ms.readyState === "closed" && ms.sourceBuffers.length === 0));
    assert.deepEqual(h.pipeline.lastReport.resources.liveTimeouts, 0);
    assert.deepEqual(h.pipeline.lastReport.resources.liveListenerGroups, 0);
  } finally { await h.cleanup(); }
});

// ---------------------------------------------------------------- B3: superseded preparation

/** Hold preparer cuts until released. The pipeline runs one cut at a time. */
function gateCuts(prep) {
  const cut = prep.cut.bind(prep);
  const held = [];
  prep.cut = (k) => new Promise((resolve, reject) => held.push({ k, run: () => cut(k).then(resolve, reject) }));
  return {
    held,
    releaseNext() {
      const c = held.shift();
      c?.run();
      return c?.k;
    },
    open() {
      prep.cut = cut;
      for (const c of held.splice(0)) c.run();
    },
  };
}

const microtasks = async (n = 20) => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
const segmentMid = (prep, k) => {
  const t = prep.segmentTimes(k);
  return (t.startSeconds + t.endSeconds) / 2;
};
const timelineOf = (s, type) => s.rec.timeline.entries().filter((e) => e.type === type);

async function settleInitialPreparation(s) {
  await until(() => s.prepared.size === 2 && [...s.prepared.values()].every((slot) => slot.entry), "initial preparation did not settle");
}

async function completeUntilAppended(h, s, k) {
  const sbs = h.mediaSources.at(-1).sourceBuffers;
  for (let i = 0; i < 8 && !s.segState.appended.has(k); i += 1) {
    for (const sb of sbs) sb.completeNow();
    await flush();
  }
  assert.equal(s.segState.appended.has(k), true, `segment ${k} was not appended`);
}

/**
 * The audit scenario. Seek A holds A's cut; seek B drops A mid-cut and a delivery starts
 * waiting on B's slot, queued behind the held cut; seek C drops B's slot before its cut.
 * `path` "tick": the scheduler's own urgent release claims B. "release": release(1) does.
 */
async function b3Scenario({ bufferMode, path }) {
  const h = harness();
  try {
    await h.load("A.mp4", { bufferMode });
    const s = h.pipeline.session;
    const prep = s.prep;
    await settleInitialPreparation(s);
    if (path === "release") h.pipeline.hold();
    const gate = gateCuts(prep);

    h.pipeline.seek(segmentMid(prep, 2)); // A
    await microtasks(); // lets A's cut start; no timer can fire
    assert.deepEqual(gate.held.map((c) => c.k), [2], "A's cut is held");
    assert.equal(s.scheduler.busy, false);

    h.pipeline.seek(segmentMid(prep, 3)); // B
    assert.equal(s.prepared.has(2), false, "A dropped during its cut");
    const released = path === "release" ? h.pipeline.release(1) : undefined;
    await until(() => s.scheduler.busy, "no delivery started for B");
    assert.equal(s.prepared.get(3)?.entry, undefined, "the delivery waits on B's uncut slot");

    h.pipeline.seek(segmentMid(prep, 0)); // C
    assert.equal(s.prepared.has(3), false, "B's slot dropped before its cut");
    gate.open();

    if (released) assert.equal(await released, 1, "release() moved on to the latest target");
    await until(() => s.segState.inFlight.has(0) || s.failure, "latest target was not delivered");
    assert.equal(s.failure, undefined, `pipeline failed: ${s.failure?.code}`);
    assert.equal(h.pipeline.state, "streaming");
    assert.notEqual(s.scheduler.state, "stopped");
    assert.deepEqual(timelineOf(s, "preparation-superseded").map((e) => [e.k, e.stage]), [[3, "before-cut"]]);
    assert.equal(s.totals.supersededPreparations, 1);
    assert.equal(s.totals.delivered, 1, "only the latest target was delivered");
    assert.equal(s.segState.isAvailable(2) || s.segState.isAvailable(3), false, "superseded targets are not sticky");

    await completeUntilAppended(h, s, 0);
    assert.deepEqual([...s.segState.appended], [0]);
    h.video.resolveSeek(0, 2);
    assert.equal(h.pipeline.snapshot().seeking, false);
    const seek = s.rec.seeks.last(1)[0];
    assert.equal(seek.planIndex, 0);
    assert.ok(seek.deliveredAt !== undefined && seek.appendedAt !== undefined && seek.seekedAt !== undefined);
    await flush();
    assert.equal(s.totals.delivered, 1, "no runaway delivery after the seek storm");

    // Playback continues: the next segment can be delivered and appended.
    if (path === "release") h.pipeline.resume();
    assert.equal((await h.pipeline.play()).ok, true);
    assert.equal(await h.pipeline.release(1), 1);
    await completeUntilAppended(h, s, 1);
    assert.equal(s.failure, undefined);
    assert.equal((await h.pipeline.reset("B3")).clean, true);
  } finally {
    await h.cleanup();
  }
}

for (const bufferMode of ["muxed", "separate"]) {
  for (const path of ["tick", "release"]) {
    test(`B3 (${bufferMode}, ${path}): a preparation superseded by a later seek does not fail the pipeline; the latest target wins (×25)`, async () => {
      for (let i = 0; i < 25; i += 1) await b3Scenario({ bufferMode, path });
    });
  }
}

test("B3: a dropped preparation without a newer seek is an invariant violation, not a supersession", async () => {
  for (const reason of ["not-next", "unexpected"]) {
    const h = harness();
    try {
      await h.load("A.mp4");
      const s = h.pipeline.session;
      await settleInitialPreparation(s);
      h.pipeline.hold();
      const gate = gateCuts(s.prep);
      h.pipeline.seek(segmentMid(s.prep, 2));
      const released = h.pipeline.release(1);
      await until(() => s.scheduler.busy && gate.held.length === 1, "delivery did not wait on the held cut");
      // Simulate an internal drop of the slot being waited on, with no seek after the delivery began.
      const slot = s.prepared.get(2);
      slot.dropped = { reason, seekGeneration: s.seekGeneration };
      s.prepared.delete(2);
      gate.open();
      assert.equal(await released, 0);
      assert.equal(h.pipeline.state, "failed");
      assert.equal(s.failure.code, "PREPARATION_DROPPED_UNSUPERSEDED");
      assert.equal(s.totals.supersededPreparations, 0);
    } finally {
      await h.cleanup();
    }
  }
});

test("B3: a genuine preparation error for the current target still fails the pipeline", async () => {
  const h = harness();
  try {
    await h.load("A.mp4");
    const s = h.pipeline.session;
    await settleInitialPreparation(s);
    s.prep.cut = async (k) => {
      throw new PreparationError("SEGMENT_INVALID", `Segment ${k}: injected`, { stage: "cut", index: k });
    };
    h.pipeline.seek(segmentMid(s.prep, 3));
    await until(() => s.failure, "genuine failure was not reported");
    assert.equal(h.pipeline.state, "failed");
    assert.equal(s.failure.code, "SEGMENT_INVALID");
    assert.equal(s.failure.index, 3);
    assert.equal(s.totals.supersededPreparations, 0);
  } finally {
    await h.cleanup();
  }
});

for (const lifecycle of ["reset", "replace"]) {
  test(`B3 × B2 (${lifecycle}): superseded work from session A settling after B is active leaves B untouched`, async () => {
    const h = harness();
    try {
      await h.load("A.mp4");
      const a = h.pipeline.session;
      await settleInitialPreparation(a);
      const gate = gateCuts(a.prep);
      h.pipeline.seek(segmentMid(a.prep, 2));
      await microtasks();
      h.pipeline.seek(segmentMid(a.prep, 3));
      await until(() => a.scheduler.busy, "A delivery did not start");
      h.pipeline.seek(segmentMid(a.prep, 0));
      assert.equal(gate.held.length, 1, "A's cut is still held");

      const opts = { profile: "MANUAL", initialSegments: 0, sampleIntervalMs: 1_000_000, backBufferSeconds: null };
      const resetA = lifecycle === "reset" ? h.pipeline.reset("A-reset") : undefined;
      const loadB = h.pipeline.load(h.file("B.mp4"), opts);
      await until(() => h.mediaSources.length === 2 && h.mediaSources[1].sourceBuffers.length > 0, "B did not open");
      h.mediaSources[1].sourceBuffers[0].completeNow();
      assert.equal((await loadB).ok, true);
      if (resetA) assert.equal((await resetA).clean, true);
      const b = h.pipeline.session;
      assert.notEqual(b, a);
      assert.equal(a.closing, true);

      gate.open(); // A's held cut and its dropped successors settle now
      for (let i = 0; i < 20; i += 1) await flush();
      assert.equal(h.pipeline.session, b);
      assert.equal(h.pipeline.state, "streaming");
      assert.equal(b.failure, undefined);
      assert.equal(a.failure, undefined, "closing session A records no failure");
      assert.equal(b.totals.supersededPreparations, 0);
      assert.equal(timelineOf(b, "preparation-superseded").length, 0);
      assert.notEqual(b.scheduler.state, "stopped");

      // B remains fully usable: an unbuffered seek completes.
      await settleInitialPreparation(b);
      h.pipeline.seek(segmentMid(b.prep, 2));
      await until(() => b.segState.inFlight.has(2), "B seek target not delivered");
      await completeUntilAppended(h, b, 2);
      h.video.resolveSeek(4, 6);
      assert.equal(h.pipeline.snapshot().seeking, false);
      assert.equal((await h.pipeline.reset("B-reset")).clean, true);
      assert.equal(h.live.size, 0);
    } finally {
      await h.cleanup();
    }
  });
}

for (const bufferMode of ["muxed", "separate"]) {
  test(`B1 × B3 (${bufferMode}): successive seeks abandon a partial attempt; stale parts never promote it; the retry needs fresh parts`, async () => {
    const h = harness();
    try {
      await h.load("A.mp4", { bufferMode });
      const s = h.pipeline.session;
      const prep = s.prep;
      const sbs = h.mediaSources.at(-1).sourceBuffers;
      await settleInitialPreparation(s);
      h.pipeline.hold();
      // An interrupted attempt for segment j: some parts done or in flight, one part queued.
      let j;
      if (bufferMode === "muxed") {
        assert.equal(await h.pipeline.release(1), 1); // video 0 in flight, audio 0 queued
        j = 0;
      } else {
        assert.equal(await h.pipeline.release(2), 2); // 0 in flight on both, 1 queued on both
        const [video, audio] = sbs;
        audio.completeNow(); // audio 0
        audio.completeNow(); // audio 1: segment 1 now lacks only its queued video part
        assert.equal(video.updating, true);
        j = 1;
      }
      const attemptJ = s.attempts.get(j).id;
      h.pipeline.resume();
      await until(() => [...s.prepared.values()].every((slot) => slot.entry), "ahead preparation did not settle");
      const gate = gateCuts(prep);

      h.pipeline.seek(segmentMid(prep, 4)); // A: drops j's queued part
      assert.equal(s.attempts.has(j), false, "the partial attempt is abandoned");
      assert.equal(s.segState.isAvailable(j), false, "the partial segment is retryable");
      await microtasks();
      assert.deepEqual(gate.held.map((c) => c.k), [4]);
      h.pipeline.seek(segmentMid(prep, 3)); // B: its slot queues behind A's held cut
      await until(() => s.scheduler.busy, "no delivery started for B");
      assert.equal(s.prepared.get(3)?.entry, undefined);
      h.pipeline.seek(segmentMid(prep, j)); // C: back into the partial segment; B is superseded

      // Stale completions of the old attempt arrive after abandonment.
      for (const sb of sbs) sb.completeNow();
      await flush();
      assert.equal(s.segState.appended.has(j), false, "stale parts cannot promote the abandoned attempt");

      gate.open();
      await until(() => s.attempts.has(j) || s.failure, "the partial segment was not retried");
      assert.equal(s.failure, undefined, `pipeline failed: ${s.failure?.code}`);
      assert.deepEqual(timelineOf(s, "preparation-superseded").map((e) => [e.k, e.stage]), [[3, "before-cut"]]);
      const retry = s.attempts.get(j);
      assert.notEqual(retry.id, attemptJ, "the retry is a new attempt");
      assert.equal(retry.remaining.size, 2, "the retry requires both parts again");
      await completeUntilAppended(h, s, j);
      assert.equal(s.segState.isAvailable(3) || s.segState.isAvailable(4), false, "superseded targets are not sticky");
      const segment = prep.segmentTimes(j);
      h.video.resolveSeek(segment.startSeconds, segment.endSeconds);
      assert.equal(h.pipeline.snapshot().seeking, false);
      assert.equal(s.rec.seeks.last(1)[0].planIndex, j);
      assert.equal((await h.pipeline.reset("B1xB3")).clean, true);
    } finally {
      await h.cleanup();
    }
  });
}

// ---------------------------------------------------------------- rapid successive seeks

function prng(seed) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

/**
 * Record, for every segment promoted to APPENDED, whether the promoting completion carried
 * the current attempt ID and whether every part of that attempt completed successfully.
 */
function auditAppends(s) {
  const audit = { promoted: 0, violations: [], maxLiveAttempts: 0, abandonedByAbort: 0 };
  const completed = new Map();
  for (const e of s.sbs) {
    const onOpDone = e.queue.onOpDone;
    e.queue.onOpDone = (op) => {
      const m = op.meta ?? {};
      const attempt = m.planIndex !== undefined ? s.attempts.get(m.planIndex) : undefined;
      if ((op.aborted || op.error) && attempt && attempt.id === m.attemptId) audit.abandonedByAbort += 1;
      if (op.type === "append" && m.attemptId !== undefined && !op.aborted && !op.error) {
        if (!completed.has(m.attemptId)) completed.set(m.attemptId, new Set());
        completed.get(m.attemptId).add(m.trackId);
      }
      const before = new Set(s.segState?.appended ?? []);
      onOpDone(op);
      for (const k of s.segState?.appended ?? []) {
        if (before.has(k)) continue;
        audit.promoted += 1;
        if (k !== m.planIndex || attempt?.id !== m.attemptId) audit.violations.push({ k, why: "stale attempt", attemptId: m.attemptId, current: attempt?.id });
        if ((completed.get(m.attemptId)?.size ?? 0) !== 2) audit.violations.push({ k, why: "incomplete parts", attemptId: m.attemptId });
      }
      audit.maxLiveAttempts = Math.max(audit.maxLiveAttempts, s.attempts.size);
    };
  }
  return audit;
}

async function seekStorm({ bufferMode, seed, bursts, seekAbort }) {
  const h = harness();
  const rand = prng(seed);
  const stats = { seeks: 0, bursts: 0, seeksWhileUpdating: 0, maxDeliveredPerBurst: 0, superseded: 0, abandoned: 0, promoted: 0, maxLiveAttempts: 0 };
  try {
    await h.load("A.mp4", { bufferMode, seekAbort });
    const s = h.pipeline.session;
    const prep = s.prep;
    const sbs = h.mediaSources.at(-1).sourceBuffers;
    const audit = auditAppends(s);
    await settleInitialPreparation(s);
    const gate = gateCuts(prep);
    const duration = prep.durationSeconds;
    for (let b = 0; b < bursts; b += 1) {
      if (rand() < 0.8) h.video.range = []; // most seeks land outside the buffer
      const n = 2 + Math.floor(rand() * 5); // double, triple, and longer bursts
      const deliveredBefore = s.totals.delivered;
      let extraReleases = 0;
      let target;
      for (let i = 0; i < n; i += 1) {
        target = rand() * (duration - 0.01);
        if (sbs.some((sb) => sb.updating)) stats.seeksWhileUpdating += 1;
        h.pipeline.seek(target);
        stats.seeks += 1;
        const step = rand();
        if (step < 0.2) continue; // back-to-back
        else if (step < 0.35) await microtasks();
        else if (step < 0.55) await tick(); // timers: the scheduler may claim a slot
        else if (step < 0.75) {
          gate.releaseNext();
          await microtasks();
        } else if (step < 0.9) {
          sbs[Math.floor(rand() * sbs.length)].completeNow(); // an append/remove finishes mid-burst
          await microtasks();
        } else {
          // Deliver more while appends are outstanding, so later seeks drop queued parts.
          extraReleases += 1;
          void h.pipeline.release(1);
          await microtasks();
        }
      }
      // Settle: let preparation and appends proceed until the latest target is appended.
      const k = prep.planIndexForTime(target);
      for (let i = 0; i < 400 && !s.failure && !s.segState.appended.has(k); i += 1) {
        if (gate.held.length) gate.releaseNext();
        else for (const sb of sbs) sb.completeNow();
        await tick();
      }
      assert.equal(s.failure, undefined, `burst ${b}: pipeline failed ${s.failure?.code}`);
      assert.equal(h.pipeline.state, "streaming");
      assert.equal(s.segState.appended.has(k), true, `burst ${b}: latest target segment ${k} not appended`);
      const seek = s.rec.seeks.last(1)[0];
      assert.equal(seek.planIndex, k, "the latest seek is the current one");
      const segment = prep.segmentTimes(k);
      h.video.resolveSeek(segment.startSeconds, segment.endSeconds);
      assert.equal(h.video.seeking, false);
      stats.maxDeliveredPerBurst = Math.max(stats.maxDeliveredPerBurst, s.totals.delivered - deliveredBefore);
      assert.ok(s.totals.delivered - deliveredBefore <= n + extraReleases + 3, `burst ${b}: ${s.totals.delivered - deliveredBefore} deliveries for ${n} seeks and ${extraReleases} releases`);
      stats.bursts += 1;
    }
    assert.deepEqual(audit.violations, []);
    stats.superseded = s.totals.supersededPreparations;
    stats.abandoned = (s.rec.counts["segment-attempt-abandoned"] ?? 0) + audit.abandonedByAbort;
    stats.promoted = audit.promoted;
    stats.maxLiveAttempts = audit.maxLiveAttempts;
    gate.open();
    assert.equal((await h.pipeline.reset("storm")).clean, true);
    return stats;
  } finally {
    await h.cleanup();
  }
}

for (const bufferMode of ["muxed", "separate"]) {
  test(`B3 rapid successive seeks (${bufferMode}): seeded seek storms converge to the latest target with B1 append rules intact`, async () => {
    const totals = { seeks: 0, superseded: 0, abandoned: 0, seeksWhileUpdating: 0, promoted: 0, maxDeliveredPerBurst: 0, maxLiveAttempts: 0 };
    for (const seed of [1, 2, 3, 4]) {
      const r = await seekStorm({ bufferMode, seed, bursts: 30, seekAbort: seed % 2 === 1 });
      for (const key of ["seeks", "superseded", "abandoned", "seeksWhileUpdating", "promoted"]) totals[key] += r[key];
      totals.maxDeliveredPerBurst = Math.max(totals.maxDeliveredPerBurst, r.maxDeliveredPerBurst);
      totals.maxLiveAttempts = Math.max(totals.maxLiveAttempts, r.maxLiveAttempts);
    }
    // The storm must actually exercise supersession, abandonment, and seeks during appends.
    assert.ok(totals.superseded > 0, "no preparation was superseded");
    assert.ok(totals.abandoned > 0, "no segment attempt was abandoned");
    assert.ok(totals.seeksWhileUpdating > 0, "no seek arrived while a SourceBuffer was updating");
    assert.ok(totals.maxLiveAttempts <= 5);
    console.log(`# storm ${bufferMode}: ${JSON.stringify(totals)}`);
  });
}
