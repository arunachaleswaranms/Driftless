import assert from "node:assert/strict";
import test from "node:test";

import { BOX_LIMITS, BoxFormatError, checkMoovBudget, describeLayout, readBoxHeader, scanTopLevelBoxes } from "./boxes.mjs";
import { NON_TARGET, TARGET, UNPARSEABLE, classifyMovie } from "./classify.mjs";
import { parseMediaSegment } from "./fmp4.mjs";
import { READ_LIMITS, createSourceReader } from "./source.mjs";
import { box, buildMp4, fullBox, memorySource } from "./test-fixtures.mjs";

const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const readerFor = (bytes) => (o, l) => Promise.resolve(bytes.slice(o, o + l).buffer);

function header(size32, type, extra = []) {
  const b = new Uint8Array(8 + extra.length);
  new DataView(b.buffer).setUint32(0, size32);
  b.set(new TextEncoder().encode(type), 4);
  b.set(extra, 8);
  return b;
}

test("box headers: 32-bit, 64-bit, to-end, uuid, and malformed sizes", () => {
  assert.deepEqual(
    { ...readBoxHeader(view(header(24, "ftyp")), 0, { limit: 100 }) },
    { type: "ftyp", start: 0, size: 24, headerSize: 8, extendsToEnd: false, truncated: false },
  );
  const large = header(1, "mdat", [0, 0, 0, 1, 0, 0, 0, 16]);
  const h = readBoxHeader(view(large), 0, { limit: 2 ** 33 });
  assert.equal(h.size, 2 ** 32 + 16);
  assert.equal(h.headerSize, 16);
  assert.equal(readBoxHeader(view(header(0, "mdat")), 0, { absoluteStart: 40, limit: 1000 }).size, 960);
  assert.equal(readBoxHeader(view(header(40, "uuid", new Array(16).fill(1))), 0, { limit: 100 }).headerSize, 24);
  assert.equal(readBoxHeader(view(header(200, "moov")), 0, { limit: 100 }).truncated, true);
  assert.throws(() => readBoxHeader(view(header(4, "free")), 0, { limit: 100 }), { code: "SIZE_TOO_SMALL" });
  assert.throws(() => readBoxHeader(view(header(16, "\u0001abc")), 0, { limit: 100 }), { code: "BAD_TYPE" });
  assert.throws(() => readBoxHeader(view(header(1, "mdat", [0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0])), 0, { limit: 100 }), { code: "SIZE_UNSAFE" });
  assert.throws(() => readBoxHeader(view(new Uint8Array(5)), 0, { limit: 100 }), { code: "SHORT_HEADER" });
});

test("top-level scan finds moov placement with one small read per box", async () => {
  for (const placement of ["first", "last"]) {
    const f = buildMp4({ seconds: 4, moov: placement });
    const scan = await scanTopLevelBoxes(readerFor(f.bytes), f.bytes.length);
    const layout = describeLayout(scan, f.bytes.length);
    assert.equal(scan.error, undefined);
    assert.equal(scan.headerReads, 3);
    assert.ok(scan.headerBytes <= 48);
    assert.equal(layout.moovPlacement, placement === "first" ? "before-mdat" : "after-mdat");
    assert.equal(layout.moovOffset, f.layout.moovOffset);
    assert.equal(layout.moovSize, f.layout.moovSize);
  }
});

test("top-level scan stops cleanly on truncated, non-BMFF, and runaway input", async () => {
  const f = buildMp4({ seconds: 4, moov: "last" });
  const cut = f.bytes.slice(0, f.bytes.length - 100);
  const truncated = describeLayout(await scanTopLevelBoxes(readerFor(cut), cut.length), cut.length);
  assert.equal(truncated.scanError.code, "TRUNCATED_BOX");
  const noise = new Uint8Array(4096).map((_, i) => (i * 37 + 11) & 0xff);
  const n = describeLayout(await scanTopLevelBoxes(readerFor(noise), noise.length), noise.length);
  assert.equal(n.looksIsoBmff, false);
  const many = new Uint8Array(8 * 50);
  for (let i = 0; i < 50; i += 1) many.set(header(8, "free"), i * 8);
  const capped = await scanTopLevelBoxes(readerFor(many), many.length, { maxBoxes: 10 });
  assert.equal(capped.error.code, "TOO_MANY_BOXES");
  assert.equal(capped.headerReads, 10);
});

test("moov budget check bounds declared sample tables before parsing", () => {
  const f = buildMp4({ seconds: 4 });
  const moov = f.bytes.slice(f.layout.moovOffset, f.layout.moovOffset + f.layout.moovSize).buffer;
  const budget = checkMoovBudget(moov);
  assert.equal(budget.trackCount, 2);
  assert.deepEqual(budget.tracks.map((t) => t.sampleCount), [120, 188]);

  // Constant-size stsz lets a 20-byte box claim billions of samples.
  const bomb = buildMp4({ seconds: 4, stszOverride: { trackIndex: 0, sampleSize: 1, count: 0xffffffff } });
  const bombMoov = bomb.bytes.slice(bomb.layout.moovOffset, bomb.layout.moovOffset + bomb.layout.moovSize).buffer;
  assert.throws(() => checkMoovBudget(bombMoov), { code: "TOO_MANY_SAMPLES" });

  const overrun = buildMp4({ seconds: 4, stszOverride: { trackIndex: 0, sampleSize: 0, count: 1000 } });
  const overrunMoov = overrun.bytes.slice(overrun.layout.moovOffset, overrun.layout.moovOffset + overrun.layout.moovSize).buffer;
  assert.throws(() => checkMoovBudget(overrunMoov), { code: "TABLE_OVERRUN" });

  assert.throws(() => checkMoovBudget(box("free", new Uint8Array(4)).buffer), { code: "NOT_MOOV" });
  assert.ok(BOX_LIMITS.maxSamplesPerTrack < 0xffffffff);
});

test("fMP4 verifier rejects malformed media segments", () => {
  const trun = fullBox("trun", 0, 0x201, new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 4]));
  const tfhd = fullBox("tfhd", 0, 0x020008, new Uint8Array([0, 0, 0, 1, 0, 0, 0, 10]));
  const moof = box("moof", fullBox("mfhd", 0, 0, new Uint8Array([0, 0, 0, 7])), box("traf", tfhd, fullBox("tfdt", 0, 0, new Uint8Array(4)), trun));
  const good = new Uint8Array([...moof, ...box("mdat", new Uint8Array(4))]);
  // Point data_offset at the mdat payload.
  const dv = new DataView(good.buffer);
  const dataOffsetPos = moof.length - 8;
  dv.setInt32(dataOffsetPos, moof.length + 8);
  const ok = parseMediaSegment(good.buffer);
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.fragments[0].sequenceNumber, 7);
  assert.equal(ok.fragments[0].trafs[0].sampleCount, 1);

  const short = new Uint8Array([...moof, ...box("mdat", new Uint8Array(2))]);
  new DataView(short.buffer).setInt32(dataOffsetPos, moof.length + 8);
  assert.ok(parseMediaSegment(short.buffer).problems.length >= 1);

  assert.throws(() => parseMediaSegment(moof.buffer.slice(0, moof.length - 3)), BoxFormatError);
  assert.throws(() => parseMediaSegment(box("mdat", new Uint8Array(4)).buffer), { code: "STRUCTURE" });
  const huge = fullBox("trun", 0, 0x200, new Uint8Array([0xff, 0xff, 0xff, 0xff]));
  const bad = box("moof", fullBox("mfhd", 0, 0, new Uint8Array(4)), box("traf", tfhd, huge));
  assert.throws(() => parseMediaSegment(new Uint8Array([...bad, ...box("mdat")]).buffer), { code: "TOO_MANY_SAMPLES" });
});

test("source reader bounds reads and never slices the whole source", async () => {
  const bytes = new Uint8Array(200_000).map((_, i) => i & 0xff);
  const src = memorySource(bytes);
  const reader = createSourceReader(src, { blockSize: 64 * 1024 });
  for (let o = 0; o < bytes.length; o += 64 * 1024) await reader.readBlock(o);
  await reader.readRange(1000, 5000);
  assert.equal(reader.stats.reads, 5);
  assert.equal(reader.stats.bytesRead, 205_000);
  assert.equal(reader.stats.rereadBytes, 5000);
  assert.equal(reader.stats.maxInFlightBytes, 64 * 1024);
  assert.equal(reader.stats.nonSequentialReads, 1);
  assert.ok(src.slices.every(([a, b]) => b - a <= 64 * 1024));
  await assert.rejects(reader.readRange(bytes.length + 1, 1), RangeError);
  await assert.rejects(reader.readRange(0, READ_LIMITS.maxRangeBytes + 1), RangeError);
  assert.throws(() => createSourceReader(src, { blockSize: 100 }), RangeError);
  const concurrent = createSourceReader(src, { blockSize: 64 * 1024 });
  const first = concurrent.readBlock(0);
  await assert.rejects(concurrent.readBlock(0), /one read in flight/);
  await first;
});

const track = (id, type, codec, extra = {}) => ({ id, type, codec, timescale: 1000, duration: 10_000, nb_samples: 100, size: 1000, bitrate: 800, ...extra });

test("classification distinguishes target, non-target, and unparseable media", () => {
  const ok = classifyMovie({ hasMoov: true, tracks: [track(1, "video", "avc1.64001f", { video: { width: 1280, height: 720 } }), track(2, "audio", "mp4a.40.2", { audio: { channel_count: 2, sample_rate: 48000 } })] });
  assert.equal(ok.verdict, TARGET);
  assert.deepEqual(ok.selected, { videoTrackId: 1, audioTrackId: 2 });
  assert.equal(ok.tracks[0].width, 1280);
  assert.equal(ok.tracks[1].channels, 2);

  const cases = [
    [[track(1, "video", "hvc1.1.6.L93.90"), track(2, "audio", "mp4a.40.2")], /not H.264/],
    [[track(1, "video", "avc1.42c01e"), track(2, "audio", "mp4a.6b")], /not AAC/],
    [[track(1, "video", "avc1.42c01e"), track(2, "audio", "Opus")], /not AAC/],
    [[track(1, "video", "avc1.42c01e")], /No audio track/],
    [[track(1, "video", "avc1.42c01e"), track(2, "audio", "mp4a.40.2"), track(3, "audio", "mp4a.40.2")], /2 audio tracks/],
    [[track(1, "video", "encv"), track(2, "audio", "mp4a.40.2")], /Encrypted/],
    [[track(1, "video", "avc1.42c01e", { nb_samples: 0 }), track(2, "audio", "mp4a.40.2")], /no samples/],
    [[track(1, "video", "avc1.42c01e"), track(2, "audio", "mp4a.40.2")], /already fragmented/, { isFragmented: true }],
  ];
  for (const [tracks, reason, extra] of cases) {
    const c = classifyMovie({ hasMoov: true, tracks, ...extra });
    assert.equal(c.verdict, NON_TARGET);
    assert.ok(c.reasons.some((r) => reason.test(r)), `${reason} in ${c.reasons}`);
  }
  const withText = classifyMovie({ hasMoov: true, tracks: [track(1, "video", "avc1.42c01e"), track(2, "audio", "mp4a.40.2"), track(3, "subtitles", "tx3g")] });
  assert.equal(withText.verdict, TARGET);
  assert.deepEqual(withText.unexpectedTracks, [3]);
  assert.equal(classifyMovie({ hasMoov: false }).verdict, UNPARSEABLE);
});
