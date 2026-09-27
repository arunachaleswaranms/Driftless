// Integration tests: real MP4Box.js 2.4.1 (from this spike's node_modules) over tiny
// in-code MP4 fixtures. Run `npm ci` in spike-05-mp4-segmentation first.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { SESSION_LIMITS, buildSegmentPlan, builtinSegments, inspect, planIndexForTime, plannedSegments, precheck } from "./session.mjs";
import { buildMp4, memorySource } from "./test-fixtures.mjs";

const MP4BOX_URL = new URL("../node_modules/mp4box/dist/mp4box.all.mjs", import.meta.url);
if (!existsSync(MP4BOX_URL)) throw new Error("MP4Box.js is not installed. Run `npm ci` in spikes/phase0/spike-05-mp4-segmentation/.");
const MP4Box = await import(MP4BOX_URL.href);

const BLOCK = 16 * 1024;
const IRREGULAR = [0, 30, 75, 90, 150, 200, 240, 270];

function videoRows(result) {
  return result.records.filter((r) => r.trackId === 1);
}

test("inspect: moov-first parses from the first block; moov-last follows the parser to the end", async () => {
  const first = buildMp4({ seconds: 10, moov: "first" });
  const a = await inspect(MP4Box, memorySource(first.bytes), { blockSize: BLOCK });
  assert.equal(a.classification.verdict, "TARGET COMPATIBLE");
  assert.deepEqual(a.classification.tracks.map((t) => t.codec), ["avc1.4d401e", "mp4a.40.2"]);
  assert.equal(a.movie.isProgressive, true);
  assert.equal(a.ready.reads, 1);
  assert.deepEqual(a.parserEvents, []);

  const last = buildMp4({ seconds: 10, moov: "last" });
  const b = await inspect(MP4Box, memorySource(last.bytes), { blockSize: BLOCK });
  assert.equal(b.movie.isProgressive, false);
  assert.equal(b.parserEvents[0].type, "parser-jump");
  assert.equal(b.parserEvents[0].next, last.layout.moovOffset);
  assert.ok(b.source.bytesRead < last.bytes.length / 2, "metadata did not require a sequential read");
  assert.ok(b.source.maxReadBytes <= BLOCK);
});

test("inspect: later-position requirements come from the sample tables alone", async () => {
  const f = buildMp4({ seconds: 10, video: { syncFrames: IRREGULAR } });
  const r = await inspect(MP4Box, memorySource(f.bytes), { blockSize: BLOCK, laterPositionSeconds: [7.1] });
  const v = r.laterPosition[0].tracks.find((t) => t.trackId === 1);
  assert.equal(v.targetSample, 213);
  assert.equal(v.randomAccessSample, 200);
  assert.equal(v.randomAccessSampleIsSync, true);
  assert.equal(v.samplesToDecodeBeforeTarget, 13);
  assert.equal(v.gopEndSample, 240);
  assert.equal(v.randomAccessOffset, f.tracks[0].samples[200].payloadOffset + f.layout.mdatOffset + 8);
  assert.equal(r.randomAccess[1].syncSamples, IRREGULAR.length);
  assert.equal(r.randomAccess[2].allSync, true);
});

test("built-in segmentation covers every sample with contiguous, verified timing", async () => {
  for (const moov of ["first", "last"]) {
    const f = buildMp4({ seconds: 10, moov, video: { syncFrames: IRREGULAR } });
    const r = await builtinSegments(MP4Box, memorySource(f.bytes), { blockSize: BLOCK, targetSeconds: 2, hash: true });
    assert.equal(r.failure, undefined);
    assert.deepEqual(r.init.problems, []);
    assert.deepEqual(r.init.trackIds, [1, 2]);
    assert.equal(r.segments.problemCount, 0, JSON.stringify(r.segments.problems));
    assert.equal(r.segments.perTrack[1].coveredSamples, 300);
    assert.equal(r.segments.perTrack[2].coveredSamples, f.tracks[1].samples.length);
    assert.ok(r.segments.perTrack[1].segments > 1);
    assert.ok(r.records.every((x) => /^[0-9a-f]{64}$/.test(x.sha256)));
    assert.equal(r.memory.final.sampleDataBytes, 0, "all sample data released");
  }
});

test("MP4Box.js 2.4.1 rapAlignement: segments end on the keyframe, so later segments start one sample after it", async () => {
  // Pins observed library behaviour; if this fails after an upgrade, re-evaluate the finding.
  const f = buildMp4({ seconds: 10, video: { syncFrames: IRREGULAR } });
  const r = await builtinSegments(MP4Box, memorySource(f.bytes), { blockSize: BLOCK, targetSeconds: 2 });
  const rows = videoRows(r);
  assert.equal(rows[0].startsWithSync, true);
  for (const row of rows.slice(1)) {
    assert.equal(row.startsWithSync, false);
    assert.equal(row.verifiedFirstSampleSync, false);
    assert.ok(IRREGULAR.includes(row.firstSample - 1), `segment starts right after keyframe ${row.firstSample - 1}`);
  }
});

test("built-in segment boundaries do not depend on the read block size", async () => {
  const f = buildMp4({ seconds: 10, video: { syncFrames: IRREGULAR } });
  const bounds = async (blockSize) => videoRows(await builtinSegments(MP4Box, memorySource(f.bytes), { blockSize, targetSeconds: 2 })).map((x) => [x.firstSample, x.endSample]);
  assert.deepEqual(await bounds(16 * 1024), await bounds(64 * 1024));
});

test("built-in seek with useRap starts video on a keyframe; without it the first sample is not decodable", async () => {
  const f = buildMp4({ seconds: 10, video: { syncFrames: IRREGULAR } });
  const rap = await builtinSegments(MP4Box, memorySource(f.bytes), { blockSize: BLOCK, targetSeconds: 2, seekSeconds: 7.1, maxSegmentsPerTrack: 2 });
  assert.equal(rap.seek.firstSegment[1].startSample, 200);
  assert.equal(rap.seek.firstSegment[1].verifiedFirstSampleSync, true);
  const noRap = await builtinSegments(MP4Box, memorySource(f.bytes), { blockSize: BLOCK, targetSeconds: 2, seekSeconds: 7.1, useRap: false, maxSegmentsPerTrack: 2 });
  assert.equal(noRap.seek.firstSegment[1].startsWithSync, false);
  assert.equal(noRap.seek.firstSegment[1].verifiedFirstSampleSync, false);
});

test("segment plan is deterministic, keyframe-aligned, and time-aligned across tracks", () => {
  const f = buildMp4({ seconds: 10, video: { syncFrames: IRREGULAR } });
  const tracks = f.tracks.map((t) => ({ id: t.id, kind: t.kind, timescale: t.timescale, samples: t.samples.map((s) => ({ ...s, cts: s.dts, is_sync: s.sync, offset: s.payloadOffset })) }));
  const plan = buildSegmentPlan(tracks, 2);
  assert.deepEqual(plan.segments.map((s) => s.tracks[1].first), [0, 75, 150, 240]);
  assert.ok(plan.segments.every((s) => s.tracks[1].firstIsSync));
  for (const s of plan.segments.slice(1)) assert.ok(Math.abs(s.tracks[2].startDts / 48000 - s.startSeconds) < 1024 / 48000);
  assert.equal(planIndexForTime(plan, 7.1), 2);
  assert.equal(planIndexForTime(plan, 0), 0);
  assert.deepEqual(buildSegmentPlan(tracks, 2), plan);
});

test("planned segments: random access to one segment is byte-identical to the sequential cut", async () => {
  for (const moov of ["first", "last"]) {
    const f = buildMp4({ seconds: 10, moov, video: { syncFrames: IRREGULAR } });
    const all = await plannedSegments(MP4Box, memorySource(f.bytes), { blockSize: BLOCK, targetSeconds: 2, hash: true });
    assert.equal(all.failure, undefined);
    assert.equal(all.segments.problemCount, 0, JSON.stringify(all.segments.problems));
    assert.ok(videoRows(all).every((x) => x.verifiedFirstSampleSync === true));
    assert.equal(all.segments.perTrack[1].coveredSamples, 300);

    const one = await plannedSegments(MP4Box, memorySource(f.bytes), { blockSize: BLOCK, targetSeconds: 2, atSeconds: 7.1, indices: [], hash: true });
    assert.equal(one.selection.planIndex, 2);
    for (const rec of one.records) {
      const seq = all.records.find((x) => x.trackId === rec.trackId && x.planIndex === rec.planIndex);
      assert.equal(rec.sha256, seq.sha256, `track ${rec.trackId} plan segment ${rec.planIndex}`);
    }
    assert.ok(one.source.bytesRead < f.bytes.length, "random access read less than the file");
  }
});

test("unselected tracks pin parser buffers unless they are drained", async () => {
  const f = buildMp4({ seconds: 30, audio: [{ oti: 0x40 }, { oti: 0x40 }] });
  const src = () => memorySource(f.bytes);
  const pinned = await builtinSegments(MP4Box, src(), { blockSize: BLOCK, targetSeconds: 2, drainUnselectedTracks: false });
  const drained = await builtinSegments(MP4Box, src(), { blockSize: BLOCK, targetSeconds: 2, drainUnselectedTracks: true });
  assert.deepEqual(drained.drainedTrackIds, [3]);
  assert.ok(pinned.memory.max.streamBytes > f.bytes.length * 0.9, `pinned ${pinned.memory.max.streamBytes}`);
  assert.ok(drained.memory.max.streamBytes <= 4 * BLOCK, `drained ${drained.memory.max.streamBytes}`);
});

test("precheck refuses non-MP4, truncated moov, oversize claims, and sample-table bombs before parsing", async () => {
  const noise = new Uint8Array(64 * 1024).map((_, i) => (i * 131 + 7) & 0xff);
  assert.equal((await precheck(memorySource(noise))).refusal.code, "NOT_ISO_BMFF");

  const last = buildMp4({ seconds: 4, moov: "last" });
  assert.equal((await precheck(memorySource(last.bytes.slice(0, last.bytes.length - 50)))).refusal.code, "MOOV_TRUNCATED");

  const claim = new Uint8Array(64);
  const dv = new DataView(claim.buffer);
  dv.setUint32(0, 16); claim.set(new TextEncoder().encode("ftypisom"), 4);
  dv.setUint32(16, 0xfffffff0); claim.set(new TextEncoder().encode("moov"), 20);
  assert.equal((await precheck(memorySource(claim))).refusal.code, "MOOV_TRUNCATED");

  const bomb = buildMp4({ seconds: 4, stszOverride: { trackIndex: 0, sampleSize: 1, count: 0xffffffff } });
  const pre = await precheck(memorySource(bomb.bytes));
  assert.equal(pre.refusal.code, "MOOV_TOO_MANY_SAMPLES");
  assert.ok(pre.bytesRead <= bomb.layout.moovSize + pre.scanBytes, "only box headers and the moov were read");

  const ok = await precheck(memorySource(buildMp4({ seconds: 4 }).bytes));
  assert.equal(ok.refusal, undefined);
  assert.equal(ok.moovBudget.trackCount, 2);
});

test("parser runs over garbage or truncated input end cleanly within the read budget", async () => {
  // MP4Box.js keeps requesting the same offset for non-BMFF input (and logs
  // "Invalid box type" to console.error); the driver's stall guard ends the run.
  const noise = new Uint8Array(200 * 1024).map((_, i) => (i * 131 + 7) & 0xff);
  const g = await builtinSegments(MP4Box, memorySource(noise), { blockSize: BLOCK });
  assert.equal(g.failure.code, "PARSER_STALLED");
  assert.equal(g.source.reads, SESSION_LIMITS.maxStalledAppends);
  assert.ok(g.source.reads <= Math.ceil(noise.length / BLOCK) * SESSION_LIMITS.readBudgetFactor + SESSION_LIMITS.readBudgetSlack);

  const f = buildMp4({ seconds: 10, moov: "first" });
  const cut = f.bytes.slice(0, Math.floor(f.bytes.length * 0.6));
  const t = await builtinSegments(MP4Box, memorySource(cut), { blockSize: BLOCK, targetSeconds: 2 });
  assert.equal(t.segments.problemCount, 0);
  assert.ok(t.segments.perTrack[1].coveredSamples < 300, "only samples present in the file are segmented");
  const p = await plannedSegments(MP4Box, memorySource(cut), { blockSize: BLOCK, targetSeconds: 2 });
  assert.equal(p.failure.code, "SOURCE_TRUNCATED");
  assert.equal(p.segments.problemCount, 0, "no malformed segment is emitted before the refusal");
});
