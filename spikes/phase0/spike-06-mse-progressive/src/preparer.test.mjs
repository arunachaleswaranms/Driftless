// Integration tests: the Spike 0.6 preparer over real MP4Box.js 2.4.1 and the Spike 0.5
// in-code MP4 fixtures. MP4Box.js is installed in spike-05-mp4-segmentation/node_modules.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import test from "node:test";

import { plannedSegments } from "../../spike-05-mp4-segmentation/src/session.mjs";
import { buildMp4, memorySource } from "../../spike-05-mp4-segmentation/src/test-fixtures.mjs";
import { parseMediaSegment, summariseSegmentTracks } from "../../spike-05-mp4-segmentation/src/fmp4.mjs";
import { PreparationError, mimeTypesFor, openMedia } from "./preparer.mjs";

const MP4BOX_URL = new URL("../../spike-05-mp4-segmentation/node_modules/mp4box/dist/mp4box.all.mjs", import.meta.url);
if (!existsSync(MP4BOX_URL)) throw new Error("MP4Box.js is not installed. Run `npm ci --ignore-scripts` in spikes/phase0/spike-05-mp4-segmentation/.");
const MP4Box = await import(MP4BOX_URL.href);

const BLOCK = 16 * 1024;
const IRREGULAR = [0, 30, 75, 90, 150, 200, 240, 270];
const sha = (buf) => createHash("sha256").update(new Uint8Array(buf)).digest("hex");

test("openMedia: target fixture is classified, planned, and described for MSE", async () => {
  for (const moov of ["first", "last"]) {
    const f = buildMp4({ seconds: 10, moov, video: { syncFrames: IRREGULAR } });
    const prep = await openMedia(MP4Box, memorySource(f.bytes), { blockSize: BLOCK, targetSeconds: 2 });
    assert.equal(prep.classification.verdict, "TARGET COMPATIBLE");
    assert.deepEqual(prep.mime, mimeTypesFor("avc1.4d401e", "mp4a.40.2"));
    assert.equal(prep.mime.combined, 'video/mp4; codecs="avc1.4d401e, mp4a.40.2"');
    assert.equal(prep.segmentCount, 4);
    assert.ok(Math.abs(prep.durationSeconds - 10) < 0.05, `duration ${prep.durationSeconds}`);
    assert.ok(prep.openStats.bytesRead < f.bytes.length, "metadata did not need the whole file");
    assert.equal(prep.planIndexForTime(7.1), 2);
    const pres = prep.presentationInfo();
    assert.deepEqual(pres.map((p) => p.kind), ["video", "audio"]);
    assert.ok(pres.every((p) => p.editShiftSeconds === 0 && p.firstPresentationSeconds === 0), "fixtures carry no edit list and no composition offsets");
    prep.close();
  }
});

test("initSegments: combined and per-track init segments are verified", async () => {
  const f = buildMp4({ seconds: 10 });
  const prep = await openMedia(MP4Box, memorySource(f.bytes), { blockSize: BLOCK });
  const inits = prep.initSegments();
  assert.deepEqual(inits.combined.summary.tracks.map((t) => t.trackId), [1, 2]);
  assert.deepEqual(inits.combined.summary.topLevelTypes, ["ftyp", "moov"]);
  assert.deepEqual(inits.perTrack[1].summary.tracks.map((t) => [t.trackId, t.handler]), [[1, "vide"]]);
  assert.deepEqual(inits.perTrack[2].summary.tracks.map((t) => [t.trackId, t.handler]), [[2, "soun"]]);
  assert.equal(prep.initSegments(), inits, "built once");
  prep.close();
});

test("cut(k) is byte-identical to the Spike 0.5 planned cut and reads one bounded window", async () => {
  for (const moov of ["first", "last"]) {
    const f = buildMp4({ seconds: 10, moov, video: { syncFrames: IRREGULAR } });
    const ref = await plannedSegments(MP4Box, memorySource(f.bytes), { blockSize: BLOCK, targetSeconds: 2, hash: true });
    assert.equal(ref.failure, undefined);
    const prep = await openMedia(MP4Box, memorySource(f.bytes), { blockSize: BLOCK, targetSeconds: 2 });
    // Out of order on purpose: identity must not depend on cut order.
    for (const k of [2, 0, 3, 1]) {
      const seg = await prep.cut(k);
      assert.equal(seg.reads, 1, `segment ${k} used one source window`);
      assert.ok(seg.bytesRead <= f.bytes.length / 2);
      assert.deepEqual(seg.parts.map((p) => p.trackId), [1, 2]);
      for (const part of seg.parts) {
        const expected = ref.records.find((r) => r.trackId === part.trackId && r.planIndex === k);
        assert.equal(sha(part.buffer), expected.sha256, `moov ${moov}, segment ${k}, track ${part.trackId}`);
        assert.deepEqual(part.problems, []);
      }
      assert.equal(seg.parts[0].verifiedFirstSampleSync, true);
    }
    assert.equal(prep.stats().parser.sampleDataBytes, 0, "sample data released after each cut");
    prep.close();
  }
});

test("refusals: non-BMFF before parsing, non-target after classification, truncated at cut time", async () => {
  const noise = new Uint8Array(64 * 1024).map((_, i) => (i * 131 + 7) & 0xff);
  await assert.rejects(openMedia(MP4Box, memorySource(noise), { blockSize: BLOCK }), (e) => e instanceof PreparationError && e.code === "NOT_ISO_BMFF" && e.details.stage === "precheck");

  const hevc = buildMp4({ seconds: 4, video: { gopFrames: 30, codec: "hvc1" } });
  await assert.rejects(openMedia(MP4Box, memorySource(hevc.bytes), { blockSize: BLOCK }), (e) => e.code === "NON_TARGET" && /not H\.264/.test(e.message) && e.details.trackCodecs.some((t) => t.codec.startsWith("hvc1")));

  const mp3 = buildMp4({ seconds: 4, audio: [{ oti: 0x6b }] });
  await assert.rejects(openMedia(MP4Box, memorySource(mp3.bytes), { blockSize: BLOCK }), (e) => e.code === "NON_TARGET" && /not AAC/.test(e.message));

  const f = buildMp4({ seconds: 10, moov: "first" });
  const cut = f.bytes.slice(0, Math.floor(f.bytes.length * 0.6));
  const prep = await openMedia(MP4Box, memorySource(cut), { blockSize: BLOCK });
  const first = await prep.cut(0);
  assert.deepEqual(first.parts.flatMap((p) => p.problems), []);
  await assert.rejects(prep.cut(prep.segmentCount - 1), (e) => e.code === "SOURCE_TRUNCATED");
  prep.close();
});

test("negative control: a fragment that starts mid-GOP is reported as not starting on a sync sample", async () => {
  const f = buildMp4({ seconds: 10, video: { gopFrames: 30 } });
  const prep = await openMedia(MP4Box, memorySource(f.bytes), { blockSize: BLOCK });
  const part = await prep.cutSampleRange(1, 45, 90, 99);
  assert.equal(part.firstIsSync, false);
  assert.equal(part.verifiedFirstSampleSync, false);
  assert.ok(part.problems.some((p) => /sync sample/.test(p)));
  const parsed = summariseSegmentTracks(parseMediaSegment(part.buffer, prep.initSegments().perTrack[1].parsed));
  assert.equal(parsed[0].baseMediaDecodeTime, 45 * 512);
  prep.close();
});

test("close() releases the parser and refuses further cuts", async () => {
  const f = buildMp4({ seconds: 4 });
  const prep = await openMedia(MP4Box, memorySource(f.bytes), { blockSize: BLOCK });
  prep.close();
  assert.equal(prep.closed, true);
  assert.equal(prep.mp4, undefined);
  assert.deepEqual(prep.stats().parser, { streamBytes: 0, sampleDataBytes: 0 });
  await assert.rejects(prep.cut(0), (e) => e.code === "CLOSED");
});
