// Deterministic discrete-event model of the Spike 0.7 host/receiver scheduling loop.
// The fixed policy runs the real scheduling.mjs code. The legacy policy reproduces the
// pre-fix scheduler (persistent cursor, remote-only generations, count-based need,
// movement-gated trim) so each regression is shown to fail against the old behavior.
import assert from "node:assert/strict";
import test from "node:test";
import { bufferedAhead, rangeIndexAt } from "../../spike-06-mse-progressive/src/ranges.mjs";
import { HostScheduler, NeedReporter, SCHEDULE, computePlaybackNeed, disjointRetained, planTrim } from "./scheduling.mjs";

const SEG = 4;
const COUNT = 75;
const DURATION = SEG * COUNT;
const indexForTime = (t) => Math.min(COUNT - 1, Math.max(0, Math.floor(t / SEG)));

function addRange(ranges, [a, b]) {
  const out = [];
  for (const r of [...ranges, [a, b]].sort((x, y) => x[0] - y[0])) {
    const last = out.at(-1);
    if (last && r[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], r[1]);
    else out.push([...r]);
  }
  return out;
}
function removeRange(ranges, [a, b]) {
  const out = [];
  for (const [s, e] of ranges) {
    if (e <= a || s >= b) out.push([s, e]);
    else { if (s < a) out.push([s, a]); if (e > b) out.push([b, e]); }
  }
  return out;
}

class Lab {
  constructor({ legacy = false, profile = 8, transferMs = 60, latencyMs = 2, appendMs = 10, timeupdateNeeds = true } = {}) {
    Object.assign(this, { legacy, profile, transferMs, latencyMs, appendMs, timeupdateNeeds });
    this.now = 0; this.queue = []; this.order = 0; this.toHostAt = 0; this.toRecvAt = 0;
    this.m = { sent: 0, sentAfterMark: [], aborted: 0, staleDropped: 0, waiting: 0, recoveries: 0, maxDisjoint: 0, maxDisjointAfterMark: 0, maxContiguousAhead: 0, maxSentAhead: -Infinity, raceSends: 0, retargets: 0, needs: 0 };
    this.r = { t: 0, playing: false, seeking: null, waiting: false, waitingSince: null, ranges: [], records: new Map(), gen: 0, reporter: new NeedReporter({ now: () => this.now }), segments: 0, trimCenter: null };
    this.h = legacy ? { cursor: 0, gen: 0, seekTarget: null, feedback: null } : { sched: new HostScheduler({ segmentCount: COUNT, duration: DURATION, indexForTime, segmentTimes: (k) => ({ start: k * SEG, end: (k + 1) * SEG }) }), gen: 0 };
    this.h.inflight = null; this.h.pacing = null; this.h.held = false;
    this.every(50, () => this.tick());
    this.every(250, () => this.timeupdate());
    this.pump();
  }
  at(ms, fn) {
    const e = { t: this.now + ms, o: this.order++, fn };
    let lo = 0, hi = this.queue.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; const q = this.queue[mid]; if (q.t < e.t || (q.t === e.t && q.o < e.o)) lo = mid + 1; else hi = mid; }
    this.queue.splice(lo, 0, e);
  }
  every(ms, fn) { const loop = () => { fn(); this.at(ms, loop); }; this.at(ms, loop); }
  run(ms) { const until = this.now + ms; while (this.queue.length && this.queue[0].t <= until) { const e = this.queue.shift(); this.now = e.t; e.fn(); } this.now = until; }
  runUntil(pred, maxMs = 120_000) { const end = this.now + maxMs; while (!pred() && this.now < end) this.run(50); return pred(); }
  mark() { this.m.sentAfterMark = []; this.m.maxDisjointAfterMark = 0; this.markAt = this.now; }
  // Ordered, reliable channels in both directions.
  toHost(msg) { this.toHostAt = Math.max(this.toHostAt, this.now + this.latencyMs); this.at(this.toHostAt - this.now, () => this.hostMessage(msg)); }
  toRecv(ms, fn) { this.toRecvAt = Math.max(this.toRecvAt, this.now + ms); this.at(this.toRecvAt - this.now, fn); }

  // ---------------- receiver ----------------
  play() { this.r.playing = true; }
  // Chrome resolves a seek only when the target itself is buffered (no start tolerance).
  covered(t) { return this.r.ranges.some(([a, b]) => t >= a && t < b); }
  legacyCovered(t) { return this.r.ranges.some(([a, b]) => t >= a - 0.1 && t < b); }
  need() { return computePlaybackNeed({ ranges: this.r.ranges, currentTime: this.r.t, segments: this.r.records, segmentCount: COUNT, seeking: this.r.seeking !== null }); }
  feedback(reason, force = false) {
    const r = this.r;
    if (this.legacy) { this.m.needs++; this.toHost({ type: "BUFFER_STATUS", generation: r.gen, currentTime: r.t, bufferAhead: bufferedAhead(r.ranges, r.t, 0.1), nextNeededSegment: r.segments }); return; }
    const body = r.reporter.next(this.need(), { generation: r.gen, reason, force });
    if (body) { this.m.needs++; this.toHost({ type: "BUFFER_STATUS", ...body }); }
  }
  trim() {
    const r = this.r;
    if (this.legacy) {
      if (r.seeking !== null || (r.trimCenter != null && Math.abs(r.t - r.trimCenter) < 10)) return;
      const low = Math.max(0, Math.floor(r.t - 30)), high = Math.min(DURATION, Math.ceil(r.t + 30));
      const back = low > 0 && r.ranges.some(([s]) => s < low), future = high < DURATION && r.ranges.some(([, e]) => e > high);
      if (!back && !future) return;
      r.trimCenter = r.t;
      if (back) r.ranges = removeRange(r.ranges, [0, low]);
      if (future) r.ranges = removeRange(r.ranges, [high, DURATION]);
      return;
    }
    const n = this.need();
    const plan = planTrim({ ranges: r.ranges, currentTime: r.t, contiguousBufferedEnd: n.contiguousBufferedEnd, duration: DURATION, seeking: r.seeking !== null });
    if (plan?.back) r.ranges = removeRange(r.ranges, plan.back);
    if (plan?.future) r.ranges = removeRange(r.ranges, plan.future);
  }
  seek(time) {
    const r = this.r;
    const covered = this.legacy ? this.legacyCovered(time) : this.covered(time);
    if (!this.legacy || !covered) r.gen++;
    if (!covered) this.toHost({ type: "SEEK_REQUEST", generation: r.gen, seq: this.legacy ? undefined : r.reporter.claimSeq(), time });
    r.t = time; r.seeking = time; r.waiting = false; r.waitingSince = null;
    this.feedback(covered ? "local-seek" : "remote-seek", true);
  }
  evict(a, b) { this.r.ranges = removeRange(this.r.ranges, [a, b]); }
  arrive(k, gen) {
    const r = this.r;
    if (gen < r.gen) { this.m.staleDropped++; return; }
    // Plan times are learned from the part declaration.
    r.records.set(k, { start: k * SEG, end: (k + 1) * SEG });
    this.at(this.appendMs, () => {
      r.ranges = addRange(r.ranges, [k * SEG, (k + 1) * SEG]);
      if (gen !== r.gen) { this.m.staleDropped++; return; }
      r.segments++;
      this.feedback("segment-ready");
      this.trim();
      this.toHost({ type: "PART_ACK", generation: gen, segment: k });
    });
  }
  tick() {
    const r = this.r;
    if (r.seeking !== null) {
      if (this.covered(r.seeking)) { r.seeking = null; this.feedback("seeked"); this.trim(); }
    } else if (r.playing && r.t < DURATION - 0.06) {
      const i = rangeIndexAt(r.ranges, r.t, 0.1);
      const end = i < 0 ? r.t : r.ranges[i][1];
      if (end - r.t > 0.06) {
        if (r.waiting) { r.waiting = false; r.waitingSince = null; this.m.recoveries++; }
        r.t = Math.min(r.t + 0.05, end - 0.05);
      } else if (!r.waiting) {
        r.waiting = true; r.waitingSince = this.now; this.m.waiting++;
        this.feedback("waiting", true);
        this.trim();
      }
    }
    const d = disjointRetained(r.ranges, r.t);
    this.m.maxDisjoint = Math.max(this.m.maxDisjoint, d);
    this.m.maxDisjointAfterMark = Math.max(this.m.maxDisjointAfterMark, d);
    this.m.maxContiguousAhead = Math.max(this.m.maxContiguousAhead, bufferedAhead(r.ranges, r.t, 0.1));
  }
  timeupdate() {
    const r = this.r;
    if (!r.playing || r.seeking !== null || r.waiting) return;
    if (this.timeupdateNeeds) this.feedback("timeupdate");
    this.trim();
  }
  stalledFor() { return this.r.waitingSince === null ? 0 : this.now - this.r.waitingSince; }

  // ---------------- host ----------------
  hostMessage(m) {
    const h = this.h;
    if (m.type === "PART_ACK") {
      if (!h.inflight || h.inflight.k !== m.segment || h.inflight.gen !== m.generation || h.inflight.aborted) return;
      const k = h.inflight.k;
      h.inflight = null;
      if (this.legacy) { h.cursor = k + 1; h.seekTarget = null; } else h.sched.delivered(m.generation, k);
      const token = {}; h.pacing = token;
      this.at(SEG * 1000 / this.profile, () => { if (h.pacing === token) { h.pacing = null; this.pump(); } });
      return;
    }
    if (this.legacy) {
      if (m.type === "BUFFER_STATUS") { h.feedback = m; this.pump(); return; }
      if (m.generation > h.gen) { h.gen = m.generation; h.cursor = indexForTime(m.time); h.seekTarget = m.time; this.abortHost(); this.pump(); }
      return;
    }
    const a = h.sched.accept(m);
    if (!a.accepted) return;
    if (a.retargeted) this.m.retargets++;
    // The real host starts a new generation's loop only after joining the old cut, so
    // messages queued behind the intent change are applied before it schedules.
    if (a.newGeneration) { h.gen = h.sched.generation; this.abortHost(); const token = {}; h.pacing = token; this.at(5, () => { if (h.pacing === token) { h.pacing = null; this.pump(); } }); return; }
    this.pump();
  }
  abortHost() {
    const h = this.h;
    if (h.inflight) { h.inflight.aborted = true; h.inflight = null; this.m.aborted++; if (!this.legacy) h.sched.abandon(); }
    h.pacing = null;
  }
  pump() {
    const h = this.h;
    if (h.inflight || h.pacing) return;
    let k;
    if (this.legacy) {
      if (h.cursor >= COUNT || h.held || (h.feedback && h.seekTarget === null && h.feedback.bufferAhead >= 20)) return;
      k = h.cursor;
    } else {
      const next = h.sched.next({ held: h.held });
      if (next.wait) return;
      k = next.segment;
      h.sched.begin(k);
    }
    const job = { k, gen: h.gen, aborted: false };
    h.inflight = job;
    this.m.sent++;
    this.m.sentAfterMark.push(k);
    // Relative to the playhead the host last heard about; a newer seek may still be in flight.
    if (job.gen === this.r.gen) this.m.maxSentAhead = Math.max(this.m.maxSentAhead, k * SEG - this.r.t);
    else this.m.raceSends++;
    // Chunks stop at once when the host abandons the part, so an aborted part never completes.
    this.at(this.transferMs, () => { if (!job.aborted) this.toRecv(this.latencyMs, () => this.arrive(job.k, job.gen)); });
  }
}

function startedAt(t, opts) {
  const lab = new Lab(opts);
  lab.runUntil(() => lab.r.segments >= 2);
  lab.play();
  assert.ok(lab.runUntil(() => lab.r.t >= t));
  return lab;
}
const PERMANENT_MS = 15_000;
const crossesGap = (lab, gapTime) => lab.runUntil(() => lab.r.t > gapTime + 20 || lab.stalledFor() > PERMANENT_MS, 90_000) && lab.r.t > gapTime + 20;

for (const legacy of [false, true]) {
  const label = legacy ? "pre-fix model" : "fixed scheduler";
  test(`regression A (${label}): remote seek, then local buffered seek, then play across the old buffer end`, () => {
    const lab = startedAt(12, { legacy });
    const initialEnd = lab.r.ranges[0][1];
    assert.ok(initialEnd >= 32 && initialEnd <= 40, `initial buffer ${JSON.stringify(lab.r.ranges)}`);
    lab.seek(43);
    assert.ok(lab.runUntil(() => lab.r.seeking === null && lab.r.t >= 43, 10_000));
    lab.run(2000);
    lab.mark();
    const retargetsBefore = lab.m.retargets;
    lab.seek(24);
    assert.equal(lab.r.seeking, 24);
    const crossed = crossesGap(lab, initialEnd);
    if (legacy) {
      // The old host kept sending from its far-ahead cursor: permanent stall at the gap
      // while far-future media kept growing.
      assert.equal(crossed, false);
      assert.ok(lab.stalledFor() > PERMANENT_MS && Math.abs(lab.r.t - initialEnd) < 0.2);
      assert.ok(lab.m.maxDisjointAfterMark > 100, `legacy disjoint ${lab.m.maxDisjointAfterMark}`);
      return;
    }
    assert.equal(crossed, true);
    // The local seek produced a new generation and an immediate retarget to the gap.
    assert.ok(lab.m.retargets > retargetsBefore);
    assert.equal(lab.m.sentAfterMark[0], Math.round(initialEnd / SEG));
    assert.equal(lab.h.sched.generation, lab.r.gen);
    assert.ok(lab.m.maxDisjointAfterMark <= SCHEDULE.keepBehindSeconds + SCHEDULE.backTrimHysteresisSeconds + SCHEDULE.keepAheadSeconds, `disjoint ${lab.m.maxDisjointAfterMark}`);
    assert.ok(Math.max(...lab.m.sentAfterMark.map((k) => k * SEG)) <= lab.r.t + SCHEDULE.aheadCapSeconds + SEG);
    assert.ok(lab.m.maxSentAhead <= SCHEDULE.aheadCapSeconds + SEG);
  });

  test(`regression B (${label}): remote seek to 250 s, then a local buffered seek 20 ms later`, () => {
    const lab = startedAt(12, { legacy });
    const initialEnd = lab.r.ranges[0][1];
    lab.seek(250);
    lab.run(20);
    lab.mark();
    lab.seek(10);
    const crossed = crossesGap(lab, initialEnd);
    if (legacy) {
      assert.equal(crossed, false);
      assert.ok(lab.m.sentAfterMark.some((k) => k * SEG >= 250), "legacy kept serving the obsolete remote target");
      return;
    }
    assert.equal(crossed, true);
    assert.equal(lab.r.gen, 2);
    assert.equal(lab.h.sched.generation, 2);
    // Nothing from the obsolete 250 s target is scheduled after the newer local intent.
    assert.ok(lab.m.sentAfterMark.every((k) => k * SEG < 200), JSON.stringify(lab.m.sentAfterMark));
    assert.ok(lab.m.sentAfterMark.length <= Math.ceil((lab.r.t + SCHEDULE.aheadCapSeconds + SEG - initialEnd) / SEG) + 2);
  });

  test(`waiting at a gap with no seek (${label}): the stall itself reports the need`, () => {
    const lab = startedAt(20, { legacy });
    lab.run(1000);
    assert.ok(lab.r.ranges[0][1] >= 40, JSON.stringify(lab.r.ranges));
    // Browser-side eviction of 28–36 s after the host has already moved past it. Periodic
    // status is then disabled so only the waiting event can tell the host.
    lab.timeupdateNeeds = false;
    lab.evict(28, 36);
    const retargetsBefore = lab.m.retargets;
    const needsBefore = lab.m.needs;
    assert.ok(lab.runUntil(() => lab.r.waiting, 20_000));
    const crossed = crossesGap(lab, 28);
    if (legacy) { assert.equal(crossed, false); return; }
    assert.equal(crossed, true);
    assert.ok(lab.m.needs > needsBefore && lab.m.retargets > retargetsBefore);
    assert.ok(lab.m.recoveries >= 1);
    assert.equal(lab.r.gen, 0);
  });
}

test("a future trim that cuts a disjoint segment's tail is refilled when the frontier reaches it", () => {
  const lab = startedAt(12, {});
  lab.seek(50);
  assert.ok(lab.runUntil(() => lab.r.seeking === null && lab.r.ranges.some(([a, b]) => a <= 52 && b >= 60), 10_000));
  // Back to 24.5 s: the window keeps up to ceil(54.5) = 55 s, cutting segment 13 (52–56 s)
  // after its midpoint.
  lab.seek(24.5);
  lab.run(300);
  assert.ok(lab.r.ranges.some(([a, b]) => Math.abs(b - 55) < 1e-6), JSON.stringify(lab.r.ranges));
  assert.ok(crossesGap(lab, 56), `stuck at ${lab.r.t} in ${JSON.stringify(lab.r.ranges)}`);
  assert.ok(lab.h.sched.stats.deliveryLimitWaits === 0 && lab.h.sched.stats.redeliveries <= 1, JSON.stringify(lab.h.sched.stats));
});

test("a seek just before a buffered segment start fetches the segment containing the target", () => {
  // Chrome stress geometry: target 107.32 s, 0.08 s before a segment boundary, while the
  // following segment is already buffered. Here: 47.95 s, with 48–72 s buffered.
  const lab = startedAt(12, {});
  lab.seek(50);
  assert.ok(lab.runUntil(() => lab.r.seeking === null && lab.r.ranges.some(([a, b]) => a === 48 && b >= 60), 10_000), JSON.stringify(lab.r.ranges));
  lab.seek(20);
  assert.ok(lab.runUntil(() => lab.r.seeking === null, 5000));
  lab.mark();
  lab.seek(47.95);
  assert.ok(lab.runUntil(() => lab.r.seeking === null && lab.r.t > 49, 15_000), `seeking ${lab.r.seeking} at ${lab.r.t} in ${JSON.stringify(lab.r.ranges)}`);
  assert.equal(lab.m.sentAfterMark[0], 11);
});

const PATTERNS = {
  "remote→local": ["u:200", "b"],
  "local→remote": ["b", "u:150"],
  "remote→local→remote": ["u:200", "b", "u:120"],
  "remote→remote→local": ["u:200", "u:100", "b"],
};
function bufferedTarget(lab) {
  const r = lab.r;
  const i = rangeIndexAt(r.ranges, r.t, 0.1);
  const [a, b] = i >= 0 && r.seeking === null ? r.ranges[i] : r.ranges.reduce((x, y) => (y[1] - y[0] > x[1] - x[0] ? y : x));
  return +Math.max(a + 0.5, Math.min(b - 6, (a + b) / 2)).toFixed(2);
}
for (const [name, steps] of Object.entries(PATTERNS)) {
  for (const [spacing, gap] of [["rapid", 20], ["spaced", 3000]]) {
    test(`mixed seeks ${name} (${spacing}): latest intent wins and playback continues`, () => {
      const lab = startedAt(12, {});
      let last;
      steps.forEach((s, n) => {
        if (n) lab.run(gap);
        last = s === "b" ? bufferedTarget(lab) : Number(s.slice(2));
        if (s === "b") assert.ok(lab.covered(last), `target ${last} should be buffered in ${JSON.stringify(lab.r.ranges)}`);
        lab.mark();
        lab.seek(last);
      });
      assert.ok(lab.runUntil(() => lab.r.t > last + 30 || lab.stalledFor() > PERMANENT_MS, 90_000));
      assert.ok(lab.r.t > last + 30, `stuck at ${lab.r.t} after target ${last}`);
      assert.equal(lab.h.sched.generation, lab.r.gen);
      assert.equal(lab.r.gen, steps.length);
      assert.ok(lab.m.sentAfterMark.every((k) => k * SEG >= last - SEG && k * SEG <= lab.r.t + SCHEDULE.aheadCapSeconds + SEG), JSON.stringify({ last, sent: lab.m.sentAfterMark }));
    });
  }
}

test("seeded mixed-seek stress: 300+ seeks, no permanent hang, bounded transfer and window", (t) => {
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const lab = startedAt(5, {});
  const spacings = [0, 5, 20, 100, 1500];
  const out = { seeks: 0, bursts: 0, hangs: 0, buffered: 0, unbuffered: 0 };
  while (out.seeks < 300) {
    const n = 1 + Math.floor(rand() * 3);
    let last;
    for (let i = 0; i < n; i++) {
      if (i) lab.run(spacings[Math.floor(rand() * spacings.length)]);
      const wantBuffered = rand() < 0.5 && lab.r.ranges.length;
      last = wantBuffered ? bufferedTarget(lab) : +(rand() * (DURATION - 10)).toFixed(2);
      if (lab.covered(last)) out.buffered++; else out.unbuffered++;
      lab.seek(last);
      out.seeks++;
    }
    out.bursts++;
    // Converged means: not seeking, and playing forward from the latest target.
    const ok = lab.runUntil(() => lab.r.seeking === null && !lab.r.waiting && lab.r.t >= last + 1, 15_000);
    if (!ok) out.hangs++;
    assert.equal(lab.h.sched.generation, lab.r.gen);
    // Every tenth burst also plays long enough to cross a contiguous buffer end.
    if (out.bursts % 10 === 0) { const from = lab.r.t; lab.runUntil(() => lab.r.t > Math.min(DURATION - 1, from + 40) || lab.stalledFor() > PERMANENT_MS, 90_000); if (lab.stalledFor() > PERMANENT_MS) out.hangs++; }
  }
  assert.equal(out.hangs, 0);
  assert.ok(out.buffered > 60 && out.unbuffered > 60, JSON.stringify(out));
  // A backward buffered seek can turn retained history into ahead coverage; the host's own
  // additions stay capped (maxSentAhead below).
  assert.ok(lab.m.maxContiguousAhead <= SCHEDULE.keepBehindSeconds + SCHEDULE.backTrimHysteresisSeconds + SCHEDULE.aheadCapSeconds + SEG, `contiguous ${lab.m.maxContiguousAhead}`);
  assert.ok(lab.m.maxDisjoint <= SCHEDULE.keepBehindSeconds + SCHEDULE.backTrimHysteresisSeconds + SCHEDULE.keepAheadSeconds + SEG, `disjoint ${lab.m.maxDisjoint}`);
  assert.ok(lab.m.maxSentAhead <= SCHEDULE.aheadCapSeconds + SEG, `sent ahead ${lab.m.maxSentAhead}`);
  assert.ok(lab.h.sched.stats.maxSentAheadSeconds <= SCHEDULE.aheadCapSeconds);
  // Sends that raced a newer seek on the wire were abandoned or dropped as stale.
  assert.ok(lab.m.raceSends > 0 && lab.m.raceSends <= lab.m.aborted + lab.m.staleDropped, JSON.stringify(lab.m));
  const { sentAfterMark, ...m } = lab.m;
  t.diagnostic(JSON.stringify({ ...out, ...m, host: lab.h.sched.stats, reporter: lab.r.reporter.stats }));
});

test("steady playback: ahead cap pauses transfer and total transfer tracks the playhead", () => {
  const lab = startedAt(1, {});
  lab.runUntil(() => lab.r.t >= 120, 200_000);
  const sentSeconds = lab.m.sent * SEG;
  assert.ok(sentSeconds <= lab.r.t + SCHEDULE.aheadCapSeconds + 2 * SEG, `sent ${sentSeconds}s at ${lab.r.t}s`);
  assert.ok(lab.h.sched.stats.aheadCapWaits > 0);
  assert.ok(lab.m.maxContiguousAhead <= SCHEDULE.aheadCapSeconds + SEG + 0.5);
  assert.equal(lab.h.sched.stats.redeliveries, 0);
  assert.equal(lab.h.sched.stats.deliveryLimitWaits, 0);
  lab.h.held = true;
  const held = lab.m.sent;
  lab.run(30_000);
  assert.ok(lab.m.sent <= held + 1);
  assert.ok(lab.r.waiting, "hold must reach a real underrun");
  lab.h.held = false;
  lab.pump();
  assert.ok(lab.runUntil(() => !lab.r.waiting && lab.m.recoveries > 0, 10_000));
});
