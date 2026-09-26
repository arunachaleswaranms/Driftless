# Spike 0.5 Result — MP4 Parsing & Segmentation

## Spike

`0.5 — MP4 Parsing & Segmentation`

## Result

`PROVISIONAL PASS — PHYSICAL ANDROID DEFERRED`

Software feasibility of the media-preparation layer passed in controlled desktop testing. MP4Box.js 2.4.1, driven by bounded `File.slice()` reads in headless Chrome 153, did the following on non-fragmented MP4/H.264/AAC files from 1.2 MB to 4.53 GB:

- parsed the files incrementally;
- identified tracks, codecs, and timing;
- produced structurally verified initialization segments;
- produced complete, ordered, gap-free media segments;
- reached any later position after reading only the `moov` plus one bounded source window.

Unsupported, malformed, and hostile inputs were classified or refused cleanly. No architecture-blocking limitation was found.

The result is provisional for three reasons:

- MP-12 (physical Android Chrome) has no evidence.
- All media was synthetic (FFmpeg test sources). Behavior on real-world camera, phone, and downloaded files is `MANUAL TEST REQUIRED`.
- Browser/MSE acceptance of the generated segments is out of scope and belongs to Spike 0.6.

Several MP4Box.js behaviors conflict with naive use of its built-in segmenter and must shape later design. See [MP4Box.js Findings](#mp4boxjs-findings).

- **Built-in segmentation.** It is not keyframe-aligned for random access. Every video segment after the first starts one sample after a keyframe. Its boundaries also depend on the access path.
- **Planned segmentation.** A deterministic plan derived from the `moov`, cut with MP4Box.js `createFragment()`, is keyframe-aligned, time-aligned, and reproducible byte-for-byte under random access.
- **Sample-table cost.** Expanding the sample tables costs about 343 B of JS heap per sample, which was 142 MB for 90 minutes.
- **Fragmented sources.** Already fragmented sources are not handled with bounded memory, so they are classified `NON-TARGET / EXPERIMENTAL`.

## Experiment Scope

In scope:

```text
local MP4 → bounded reads → parse → track metadata → initialization segment → media segments (in memory, verified, released)
```

Out of scope, and not implemented: MSE playback, WebRTC or any media transfer, Progressive Watch, storage of segments, transcoding, and remuxing or rewriting user media. The page's CSP sets `connect-src 'none'` and `media-src 'none'`.

## Environment

- Date: 2026-09-26. Repository revision `72c8629` plus uncommitted Spike 0.5 files.
- Host: macOS 26.6.2 (25G83), Apple M5, 16 GB RAM. Node.js v26.3.0, npm 11.16.0.
- Browser: Google Chrome 153.0.8010.53, `--headless=new`, a throwaway temporary profile deleted after each run, and `--enable-precise-memory-info`. The User-Agent reported by the page was `HeadlessChrome/153.0.0.0`.
- A scratchpad Chrome DevTools Protocol (CDP) driver, not committed, drove the page. It selected local files with `DOM.setFileInputFiles` (a local file reference, not an upload), clicked the page controls, sampled `Runtime.getHeapUsage` every 250 ms, forced GC between steps, and recorded every network request and console message.
- Origin: `http://127.0.0.1:4176`, a static `python3 -m http.server` serving `spikes/phase0/`.
- Parser: MP4Box.js `2.4.1` from npm, pinned exactly, with lockfile integrity `sha512-0HGX7nXo…` and zero transitive dependencies. Installed with `npm ci --ignore-scripts` into the Git-ignored `node_modules/`.
- **Run A** (13:57 local) and **run B** (after the fixes listed below) executed the same matrix. Between the runs:
  - planned windows past EOF became an explicit `SOURCE_TRUNCATED` refusal;
  - fragmented sources were reclassified `NON-TARGET`;
  - the driver cleared the file input between steps;
  - the large-file later-position target moved from 45:00 (exactly on a keyframe) to 45:01, so the no-RAP control lands mid-GOP.

  Figures are from run B unless marked. All other shared figures agreed between A and B.
- No headed, normal-profile, Edge, Firefox, Safari, or Android run was performed. `adb devices` listed no device.

## Library Investigation — MP4Box.js 2.4.1

| Capability required | Available | Observed |
| --- | --- | --- |
| Incremental parsing | Yes — `appendBuffer(buf)` with `buf.fileStart` | Returns the next file offset it needs. It skips a leading `mdat` to fetch a trailing `moov`, then returns to the first sample. |
| Track inspection / codec extraction | Yes — `onReady(info)` | RFC 6381 codec strings (`avc1.64001f`, `mp4a.40.2`, `hvc1.1.6.L63.90`, `mp4a.6b`, `Opus`), dimensions, channels, sample rate, timescales, durations, and edit lists. |
| Initialization segment | Yes — `initializeSegmentation()` | `ftyp` + `moov` with `mvex`/`trex` and empty sample tables, 758–4,006 B. |
| Media segmentation | Yes — `setSegmentOptions` + `onSegment` | Works, with defects: see [MP4Box.js Findings](#mp4boxjs-findings). |
| Arbitrary fragments | Yes — `createFragment(trackId, first, last)` | Used by the planned strategy. |
| Sample / segment timing | Yes — sample tables (`dts`, `cts`, `duration`, `is_sync`, `offset`, `size`) | Available for every sample at `onReady` for non-fragmented files. |
| Seek support | Yes — `seek(t, useRap)` | Returns the source offset to feed next. It resets segmentation state at the seek sample. |
| Progressive input | Yes | The parser holds appended buffers until every byte has been consumed, then releases them in `cleanBuffers()`. |

MP4Box.js can fill the required role. No replacement library is needed, so no `ARCHITECTURE REVIEW REQUIRED` is raised. See [Risks / Issues](#risks--issues) for the constraints on how it can be used.

## AUTOMATED PASS

```text
node --test spikes/phase0/spike-0{1,2,3,4}-*/src/*.test.mjs spikes/phase0/spike-05-mp4-segmentation/src/*.test.mjs
PASS — 47 tests, 0 failed; 18 belong to Spike 0.5.

node --check on every Spike 0.5 module — PASS.
```

The Spike 0.5 tests use tiny MP4s built in code by `src/test-fixtures.mjs`, with placeholder sample bytes. No media is committed.

- `inspection.test.mjs` (7 tests) covers:
  - box-header decoding (32-bit, 64-bit, to-end, `uuid`, too-small, bad-type, unsafe-size);
  - top-level scans for `moov`-first, `moov`-last, truncated, non-BMFF, and runaway box counts;
  - the `moov` budget check, including a constant-size `stsz` claiming 4,294,967,295 samples and an overrunning `stsz` table;
  - fMP4 verifier rejection of short, overrunning, and oversized-`trun` segments;
  - reader bounds (one read in flight, range limits, reread accounting, no whole-source slice);
  - classification of target, HEVC, MP3-in-MP4, Opus, video-only, two-audio, encrypted, empty, fragmented, and extra text-track inputs.
- `segmentation.test.mjs` (11 tests) runs real MP4Box.js 2.4.1 over the fixtures and covers:
  - `moov`-first vs `moov`-last parsing (parser jump to the `moov` offset);
  - later-position requirements;
  - built-in coverage and timing;
  - a pin of the built-in off-by-one keyframe behavior;
  - block-size independence of built-in boundaries;
  - `seek` with and without RAP;
  - plan determinism;
  - byte-identical planned random access vs sequential, for both layouts;
  - unselected-track buffer pinning vs draining;
  - pre-check refusals;
  - garbage and truncated input within the read budget.

## AUTOMATED DESKTOP Browser Evidence

Both runs completed every step. The status showed `… finished`, the browser console recorded **0** messages, warnings, errors, or exceptions across all steps, and the only network requests were the 11 same-origin `GET`s for the page's own files (HTML, CSS, 6 app modules, and 3 MP4Box.js modules). No media bytes left the page.

### Test Media

All media was generated locally by `tools/make-test-media.sh` from FFmpeg 6.0 `lavfi` sources (`testsrc2`, `sine`, `noise`). The FFmpeg binary is the `ffmpeg-static` build and was used only in the scratchpad. Files live in the Git-ignored `spikes/phase0/test-media/spike-05/`. No real-world or third-party media was used.

| Media ID | File | Size (B) | Duration | Structure | Video | Audio |
| --- | --- | --- | --- | --- | --- | --- |
| MP-01 small compatible | `mp01-small-faststart.mp4` | 1,178,804 | 10.000 s | `ftyp moov free mdat` | `avc1.4d401e` 640×360, 2 s GOP, B-frames | `mp4a.40.2` 2 ch 48 kHz |
| MP-02 "normal" (synthetic) | `mp02-typical-720p-moov-last.mp4` | 110,544,641 | 300.000 s | `ftyp free mdat moov` (FFmpeg default) | `avc1.64001f` 1280×720 High, irregular GOP 0.53–5.93 s, B-frames | `mp4a.40.2` 2 ch 44.1 kHz |
| MP-03 large | `mp03-large-90min-moov-last.mp4` | 4,525,650,413 | 5,400.022 s | `ftyp mdat(64-bit) moov` | `avc1.42c01f` 1280×720, 2 s GOP | `mp4a.40.2` 2 ch 48 kHz |
| MP-05 fast-start | `mp05-typical-720p-faststart.mp4` (MP-02 remuxed), `mp03f-large-90min-faststart.mp4` (4,525,649,341 B), MP-01 | — | — | `moov` before `mdat` | as source | as source |
| MP-06 non-fast-start | MP-02, MP-03 | — | — | `moov` after `mdat` | — | — |
| MP-04 non-target | `mp04a` HEVC+AAC, `mp04b` AVC+MP3, `mp04c` AVC+Opus, `mp04d` VP9+Opus WebM, `mp04e` AVC video-only, `mp04f` AVC+2×AAC | 630,739–2,708,948 | 10–20 s | MP4 except `mp04d` | — | — |
| Extra: fragmented | `mp07-fragmented-source.mp4` | 7,064,368 | 60 s | `ftyp moov (moof mdat)×61 mfra` | `avc1.4d401e` | `mp4a.40.2` |
| Extra: malformed | `mp08a` truncated at 60 %, `mp08b` `moov`-last cut 200,000 B short, `mp08c` 1 MiB random, `mp08d` 64 B `moov` claiming 4,294,967,280 B | 64–110,344,641 | — | — | — | — |

### Media Test Matrix

Block size 1 MiB unless stated. Segment counts are video / audio for the ≈2 s run.

| File | Container / layout | Video | Audio | Parse | Classification | Init segment | Built-in segments (≈2 s) | Planned segments (≈2 s) | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MP-01 | MP4, `moov` first | `avc1.4d401e` | `mp4a.40.2` | OK, 1 read | TARGET COMPATIBLE | 1,320 B, verified | 3 / 8 | 5 / 5 | All samples covered, 0 problems |
| MP-02 | MP4, `moov` last (99.71 %) | `avc1.64001f` | `mp4a.40.2` | OK, 2 reads / 1.37 MB to metadata | TARGET COMPATIBLE | 1,325 B, verified | 75 / 216 | 76 / 76 | Irregular GOPs; 8,537 samples with composition offsets |
| MP-05 (MP-02 remux) | MP4, `moov` first | same | same | OK, 1 read | TARGET COMPATIBLE | 1,325 B, verified | 75 / 216 | 76 / 76 | Same segment timing as MP-02 |
| MP-03 | MP4, `moov` last (99.87 %), 64-bit `mdat` | `avc1.42c01f` | `mp4a.40.2` | OK, 7 reads / 7.02 MB to metadata | TARGET COMPATIBLE | 1,314 B, verified | 1,351 / 4,221 | 2,700 / 2,700 | 162,000 + 253,260 samples; 0 problems in 6 full passes |
| MP-03f | MP4, `moov` first, 64-bit `mdat` | same | same | OK, 6 reads / 6.29 MB (`moov` 5.97 MB) | TARGET COMPATIBLE | 1,314 B, verified | 1,351 / 4,221 | 2,700 / 2,700 | — |
| `mp04a` | MP4 | `hvc1.1.6.L63.90` | `mp4a.40.2` | OK | NON-TARGET: video not H.264 | 4,006 B (experimental) | 2 / 8 (experimental) | not run | — |
| `mp04b` | MP4 | `avc1.64001e` | `mp4a.6b` (MP3) | OK | NON-TARGET: audio not AAC | 1,263 B (experimental) | experimental | not run | Sample entry is `mp4a`, but the object type is MP3 |
| `mp04c` | MP4 | `avc1.64001e` | `Opus` | OK | NON-TARGET: audio not AAC | 1,300 B (experimental) | experimental | not run | — |
| `mp04d` | WebM | VP9 | Opus | Refused before the parser | `NOT_ISO_BMFF` | — | — | — | 1 read, 16 B |
| `mp04e` | MP4 | `avc1.64001e` | — | OK | NON-TARGET: no audio | 758 B (experimental) | experimental | not run | — |
| `mp04f` | MP4 | `avc1.64001e` | 2 × `mp4a.40.2` | OK | NON-TARGET: 2 audio tracks | 1,327 B (experimental) | experimental | not run | Pinning experiment; see below |
| `mp07` | fMP4, 61 `moof` + `mfra` | `avc1.4d401e` | `mp4a.40.2` | OK | NON-TARGET (run B): already fragmented | 1,154 B | 16 / 47 | run A only: covered only 300 of 1,800 samples | MP4Box.js retained the whole file ×2 |
| `mp08a` | MP4, truncated | — | — | `moov` OK; `mdat` truncated (warning) | TARGET (structure) | 1,320 B | Only samples present | `SOURCE_TRUNCATED` (run B) | Run A emitted a malformed segment that the verifier caught |
| `mp08b` | MP4, `moov` truncated | — | — | Refused before the parser | `MOOV_TRUNCATED` | — | — | — | 4 header reads, 64 B |
| `mp08c` | random | — | — | Refused before the parser | `NOT_ISO_BMFF` | — | — | — | 1 read, 16 B |
| `mp08d` | 64 B `moov` claim | — | — | Refused before the parser | `MOOV_TRUNCATED` | — | — | — | 2 reads, 32 B |

### Test Status

| Test | Status | Evidence |
| --- | --- | --- |
| MP-01 Parse compatible MP4 | `AUTOMATED DESKTOP PASS` | All five target files parsed. |
| MP-02 Track metadata | `AUTOMATED DESKTOP PASS` (synthetic media); real-world files `MANUAL TEST REQUIRED` | See [Track Metadata Findings](#track-metadata-findings). |
| MP-03 Incremental parsing | `AUTOMATED DESKTOP PASS` | See [Incremental Parsing Evidence](#incremental-parsing-evidence). |
| MP-04 Initialization segment | `AUTOMATED DESKTOP PASS` (structure); MSE acceptance deferred to Spike 0.6 | See [Initialization Segment Evidence](#initialization-segment-evidence). |
| MP-05 Media segmentation | `AUTOMATED DESKTOP PASS` | See [Segmentation Evidence](#segmentation-evidence). |
| MP-06 Timing | `AUTOMATED DESKTOP PASS` | See [Timing Evidence](#timing-evidence). |
| MP-07 Keyframe / random access | `AUTOMATED DESKTOP — DOCUMENTED` | See [Keyframe / Random Access Findings](#keyframe--random-access-findings). |
| MP-08 Unsupported media | `AUTOMATED DESKTOP PASS` | See [Unsupported Media Findings](#unsupported-media-findings). |
| MP-09 Large-file behavior | `AUTOMATED DESKTOP PASS` (non-fragmented); fragmented sources not bounded | See [Large-File / Memory Findings](#large-file--memory-findings). |
| MP-10 Fast-start behavior | `AUTOMATED DESKTOP — DOCUMENTED` | See [Fast-Start / moov Findings](#fast-start--moov-findings). |
| MP-11 Later-position analysis | `AUTOMATED DESKTOP — DOCUMENTED` | See [Later-Position Access Findings](#later-position-access-findings). |
| MP-12 Physical Android | `DEFERRED PHYSICAL` | No device attached. Tracked as `DEFERRED-PHYSICAL-005`. |

## Track Metadata Findings

- **Reported fields.** `onReady` reported the fields required by the spike for every parseable file:
  - movie duration and timescale (1,000);
  - brands and a MIME string;
  - per-track ID, type, codec string, timescale, duration, sample count, bytes, and bitrate;
  - width and height for video;
  - channels and sample rate for audio;
  - language;
  - edit lists.
- **Edit lists and composition offsets.** Every non-fragmented FFmpeg-produced MP4 carried an edit list: 1 entry per track, and 2 on the concatenated MP-03 video. B-frame files had composition offsets: 253 of 300 samples in MP-01 and 8,537 of 9,000 in MP-02. Both affect presentation timing in Spike 0.6.
- **Classification.** It requires exactly one `avc1`/`avc3` video track and exactly one AAC (`mp4a.40.2/5/29`) audio track, with no encrypted sample entries and no already fragmented source. Other A/V layouts are `NON-TARGET / EXPERIMENTAL`, and non-A/V tracks are noted and ignored. The `mp4a` sample entry alone is not enough: MP3-in-MP4 reports `mp4a.6b`.
- **Fragmented sources.** For `mp07`, `onReady` reported duration 0 and only the samples of the first buffer's fragments (300 of 1,800 video samples). The index of a fragmented file is distributed across `moof` boxes.
- **Real-world media.** Real-world metadata variation (rotation matrices, variable frame rate, `tmcd`/text/chapter tracks, QuickTime-branded files, multiple sample descriptions) was not tested: `MANUAL TEST REQUIRED`.

## Incremental Parsing Evidence

- **No whole-file read.** The page never calls `file.arrayBuffer()`. `source.mjs` issues one `slice(offset, offset + block).arrayBuffer()` at a time, with at most one block in flight. That is the configured block size, 1 MiB in the matrix. Explicit range reads are limited to 128 MiB (`moov` pre-check) and 64 MiB (planned windows). The largest window observed was 3,406,239 B.
- **Offset protocol.** The driver feeds MP4Box.js the offset returned by each `appendBuffer()` call. `appendBuffer(buf, true)` is deliberately never used, because it makes MP4Box.js emit every remaining sample as a one-sample segment. During development it produced 35 one-sample video segments on MP-01, with block-size-dependent boundaries. Runs end with `flush()`.
- **Reads per pass, MP-03 (`moov` last, 1 MiB):**
  - read 0–1 MiB;
  - the parser jumps to the `moov` at 4,519,680,978;
  - 5 reads cover the 5.97 MB `moov`, after which metadata is ready at 7 reads / 7,018,011 B;
  - the parser jumps back to 1,048,576 and reads sequentially to the end.

  A full built-in pass took 4,317 reads, 4,526,380,571 B, and 730,158 B of rereads.
- **Block-size sweep, MP-02 built-in ≈2 s** (identical segment boundaries at every block size):

| Block | Reads | Bytes read | Parser-retained max | Time (B) |
| --- | --- | --- | --- | --- |
| 64 KiB | 1,687 | 110,549,210 | 2,629,412 B | 1.19 s |
| 256 KiB | 423 | 110,680,282 | 2,765,368 B | 0.41 s |
| 1 MiB | 107 | 110,862,299 | 4,395,736 B | 0.26 s |
| 4 MiB | 28 | 110,862,299 | 10,021,191 B | 0.16 s |

Block size is a laboratory parameter here and is not selected.

## Initialization Segment Evidence

| File | Bytes | Tracks represented | SHA-256 (prefix) |
| --- | --- | --- | --- |
| MP-01 | 1,320 | 1 `avc1` (`vide`, 15,360), 2 `mp4a` (`soun`, 48,000) | `f2322a1e810a75c2` |
| MP-02 | 1,325 | 1 `avc1`, 2 `mp4a` | `0e7d3eff5712e9e7` |
| MP-05 | 1,325 | 1 `avc1`, 2 `mp4a` | `2b299fee404a03b5` |
| MP-03 | 1,314 | 1 `avc1`, 2 `mp4a` | `f31825558271b838` |
| MP-03f | 1,314 | 1 `avc1`, 2 `mp4a` | `a1ece495c5cce746` |

The independent verifier (`fmp4.mjs`) confirmed the following for every init segment:

- top-level `ftyp` + `moov` only;
- `mvex` present, with one `trex` per track;
- empty `stts`/`stsz`;
- one sample entry per track.

MP-02 and MP-05 carry the same media but produced different init bytes. The byte difference was not investigated, and init segments should not be assumed layout-independent.

No init segment was appended to MSE (Spike 0.6).

## Segmentation Evidence

**Built-in strategy.** MP4Box.js `onSegment`, `rapAlignement: true`, one shared `nbSamples = round(fps × target)`.

| File / target | Video segments | Video duration min / median / max (s) | Audio segments | Audio duration (s) |
| --- | --- | --- | --- | --- |
| MP-03 ≈1 s | 2,700 | 1.967 / 2 / 2.033 | 8,442 | 0.608 / 0.64 / 0.64 |
| MP-03 ≈2 s | 1,351 | 1.967 / 4 / 4 | 4,221 | 1.248 / 1.28 / 1.28 |
| MP-03 ≈4 s | 901 | 1.967 / 6 / 6 | 2,111 | 1.269 / 2.56 / 2.56 |
| MP-02 ≈2 s | 75 | 2.033 / 3.733 / 7.333 | 216 | 0.486 / 1.393 / 1.393 |

**Planned strategy.** A new segment starts at the first sync sample ≥ target after the current start. Other tracks are cut at the same times, and each segment is produced with `createFragment()`.

| File / target | Video segments | Video duration min / median / max (s) | Audio segments | Audio duration (s) |
| --- | --- | --- | --- | --- |
| MP-03 ≈1 s | 2,700 | 2 / 2 / 2 (GOP-bounded) | 2,700 | 1.984 / 2.005 / 2.016 |
| MP-03 ≈2 s | 2,700 | 2 / 2 / 2 | 2,700 | 1.984 / 2.005 / 2.016 |
| MP-03 ≈4 s | 1,350 | 4 / 4 / 4 | 1,350 | 3.989 / 4 / 4.021 |
| MP-02 ≈2 s | 76 | 2 / 3.667 / 7.333 | 76 | 1.997 / 3.669 / 7.314 |

The library works in sample counts. Neither strategy can make video segments shorter than the source GOP.

Per-segment evidence records the following:

- sequence/index;
- track;
- first and last sample;
- start and duration;
- earliest presentation time;
- sync at start, from the sample table and from the emitted `trun`;
- sync count;
- emitted bytes;
- sample bytes;
- source byte range;
- optional SHA-256;
- verifier problems.

All 33,226 MP-03 segments across the six full passes were verified and then released.

## Timing Evidence

For every emitted segment of every target run in both runs, the ledger checked the following:

- the `tfdt` equals the sample-table `dts` of its first sample;
- the `trun` sample count, duration sum, and size sum match the sample table;
- the `trun` data lies inside its `mdat`, and the sizes sum to the `mdat` payload;
- each segment starts exactly where the previous one on its track ended, in both sample index and `dts`;
- start times are monotonic;
- the whole track is covered.

The result was **0 problems** across all target runs in run B.

Run A's truncated-file planned run emitted segments whose declared sample bytes lay beyond EOF. The verifier flagged all four, for example "trun sizes total 192807 but mdat payload is 191744". The window is now refused before cutting.

## Keyframe / Random Access Findings

- **Sync information.** The sample tables expose `is_sync` (`stss`), `dts`, `cts`, `offset`, and `size` for every sample before any `mdat` byte is read. MP-03 has 2,700 sync samples at a fixed 2 s spacing. MP-02 has 102, at 0.533–5.933 s spacing (median 2.767 s). Audio samples are all sync.
- **Built-in segmentation is off by one.** With `rapAlignement: true`, the fragment boundary test runs on the sync sample, and that sample is then *included* as the last sample of the ending segment. The first segment starts on sample 0. Every later video segment therefore starts one sample after a keyframe, for example at samples 61, 121, and 181 when the keyframes are 60, 120, and 180.
  - The independent `trun` check confirms the emitted first-sample flags are non-sync.
  - Such segments are not independently decodable, so they are unsuitable as random-access points.
  - The segmenter also overshoots: a ≈2 s target on a 2 s GOP yields 4 s segments.
  - A unit test pins this behavior so that an upgrade that changes it is noticed.
- **Built-in seek.** `seek(t, true)` starts video on the last keyframe at or before `t`. On MP-03 at 45:01 it started at sample 81,000 (45:00.000), verified as sync. `seek(t, false)` started at non-sync sample 81,030, and the verifier flagged it as not sync. Audio seeks to its own sample nearest `t`, independently of the video keyframe.
- **Boundaries after seek.** After a seek, built-in segment boundaries restart at the seek sample and do not match the sequential run's boundaries. This held on every file (`matchesSequentialBoundary: false`). Built-in segment identity is therefore path-dependent.
- **Planned segmentation.** Every planned video segment started on a sync sample (`verifiedAllStartWithSync: true`). Planned segment *k* is the same bytes whether it is cut sequentially or directly: the SHA-256 of both tracks matched for MP-01 #2, MP-02/MP-05 #38, and MP-03/MP-03f #1350.
- **Seeking needs earlier data.** Seeking to an arbitrary timestamp requires starting at the preceding keyframe. On MP-02 at 2:30 the decode lead was 2.3 s (the keyframe is at 2:27.700). On MP-03 at 1:12:01.5 it was 1.5 s. Composition offsets (B-frames) and edit lists additionally shift presentation time relative to decode time.

## Fast-Start / moov Findings

- **Detection.** A header-only top-level scan detects the layout before parsing. It reads ≤ 16 B per box, taking 3–4 reads for ordinary files and 64 for the 61-fragment file. It reports `moov` placement, offset, and size; fragmentation; and 64-bit sizes.
- **`moov` first (MP-01, MP-05, MP-03f).** Metadata was available in the first block. For MP-03f, the 5.97 MB `moov` was ready after 6 × 1 MiB reads. Segment preparation can begin immediately.
- **`moov` last (MP-02, MP-03).** Metadata is **not** available from a prefix. MP4Box.js skips the `mdat` itself and asks for the `moov` offset. With random-access `File.slice()`, this costs one extra seek and the `moov` bytes: 1.37 MB for MP-02 and 7.02 MB for MP-03. It does **not** require a sequential read of the `mdat`.

  So "can we start preparing segments quickly?" has two answers:
  - **Host side, with the local `File`:** yes, for both layouts.
  - **Anything consuming the file as a stream** (for example, a receiver fed in source order): a `moov`-last file needs the tail first.
- **No rewriting.** No remux or rewrite of user media was performed or needed.

## Later-Position Access Findings

"User seeks to *t*: what must be prepared first?" can be answered from the `moov` alone:

1. The initialization segment, which is derived from the `moov`.
2. The random-access sample: the last sync sample at or before *t*, with its decode lead.
3. The source byte range of that planned segment for each track.

Nothing before that range needs to be parsed, and no parser state from earlier media is needed. The planned plan index is a pure function of the sample tables.

| File / *t* | Planned segment | Random-access sample | Source reads after metadata | Total reads / bytes for the run |
| --- | --- | --- | --- | --- |
| MP-02 / 2:30 (`moov` last) | #38, [2:27.167, 2:33.267) | video #4431 @ 2:27.700; audio #6459 | 1 window, 2,276,102 B | 3 / 3,642,336 B |
| MP-03 / 45:01 (`moov` last, 4.53 GB) | #1350, [45:00, 45:02) | video #81000 @ 45:00; audio #126676 | 1 window, 1,727,972 B | 8 / 8,745,983 B |
| MP-03f / 45:01 (`moov` first) | #1350 | same | 1 window, 1,727,972 B | 7 / 8,019,428 B |
| MP-03 / 1:12:01.5 (4 MiB blocks) | #2160, [1:12:00, 1:12:02) | video #129600 @ 1:12:00, lead 1.5 s | 1 window, 1,727,972 B | 4 / 11,891,711 B |

MP4Box.js built-in `seek()` reached the same keyframe on MP-03 after 9 reads / 9.1 MB. As noted, the segments it produced afterwards were not keyframe-aligned and did not match the sequential boundaries.

For **fragmented sources**, later-position access needs the distributed `moof` index: a walk of all `moof` headers, or the `mfra`/`sidx` boxes, which this spike did not implement.

## Large-File / Memory Findings

- **No whole-file buffering.** The architecture never intentionally held the whole source. MP4Box.js-retained bytes are stream buffers + `mdat` copies + sample data. At 1 MiB blocks they peaked at:
  - **6,291,408 B** in every full pass over MP-03 (`moov` last): 5 MiB of `moov` buffers plus about 1 MiB of source data;
  - 5.24 MB (built-in) and 8.03 MB (planned) on MP-03f.

  Seek runs retained up to 11.5 MB. Blocks left partly consumed before the seek are never freed; they are bounded by the metadata read. At 4 MiB blocks, seek runs retained up to 12.6 MB.
- **Throughput.** A full segmentation pass over 4.53 GB took 7.3–10.3 s across runs A and B in headless Chrome, about 440–620 MB/s on the same host. The whole MP-03 full analysis (3 built-in + 3 planned passes plus the later-position runs) took 54.9 s (run A 55.4 s). These are lab observations, not planning values.
- **Heap.** The CDP-sampled V8 heap peaked at 239.4 MB during the MP-03 analysis and fell to 11.8 MB after GC between steps. For MP-03f the figures were 240.2 MB and 5.6 MB. The page's coarse `performance.memory` readings, without forced GC, reached 543 MB (run B) and 587 MB (run A) and include garbage.
- **Sample-table cost.** MP4Box.js expands every sample-table entry into a JS object before `onReady`. Measured in Node.js with forced GC, this cost **+142.4 MB for 415,260 samples (≈ 343 B per sample)** on both MP-03 layouts. The cost scales with *duration × sample rate*, not file size. By extrapolation, a 3-hour 60 fps file with AAC would cost about 0.6 GB. This was not measured and is a significant Android risk.
- **Buffer pinning by unselected tracks.** MP4Box.js frees a source buffer only when every byte in it has been consumed. On `mp04f`, segmenting one of two audio tracks without draining the other kept **the whole file** in stream buffers (2,708,824 B; 5,391,443 B retained in total). Draining it with `setExtractionOptions` plus `releaseUsedSamples` reduced the retained bytes to 397,894 B.
- **Fragmented sources.** For `mp07`, MP4Box.js (with `keepMdatData`) retained all 7,064,368 B of stream buffers plus a 7,029,853 B `mdat` copy until the end of the run: 2× the file. Bounded-memory handling of fragmented sources is **not** demonstrated.
- **Planned-mode retention.** Planned runs keep the first parse block (≤ 1 block) because its `mdat` bytes are read again through planned windows. MP-01 reread 1.09 MB this way.
- **Segment lifetime.** Generated segments were hashed, summarised, and dropped. No segment outlived its `onSegment` or `createFragment` call except as a bounded summary row.

## Unsupported Media Findings

- **Classified after parsing.** HEVC (`hvc1`), MP3-in-MP4 (`mp4a.6b`), Opus-in-MP4, video-only, two-audio-track, and fragmented sources parsed and were classified `NON-TARGET / EXPERIMENTAL` with explicit reasons. Only one experimental built-in run was made for each, and no planned or random-access work.
- **Refused before the parser.** WebM (`mp04d`) and random bytes (`mp08c`) failed the ISO BMFF check (`NOT_ISO_BMFF`, 1 read of 16 B).
- **Structural classification only.** It does not claim browser decode support.

## Security / Robustness Findings

| Check | Result |
| --- | --- |
| No file upload | CSP `connect-src 'none'`. CDP recorded only the 11 same-origin static `GET`s, with no request bodies. |
| Local files stay local | Files are reached only through `File.slice()`. No OPFS, IndexedDB, cache, or download. |
| Parser input untrusted | A header-only scan and a `moov` budget check run before MP4Box.js sees bytes. |
| `moov` truncated or oversize claim | `MOOV_TRUNCATED` for `mp08b` (4 reads, 64 B) and `mp08d` (claim of 4,294,967,280 B; 2 reads, 32 B). |
| Sample-table bomb | A 20-byte constant-size `stsz` declaring 4,294,967,295 samples is refused (`MOOV_TOO_MANY_SAMPLES`). Unguarded, MP4Box.js would try to create that many sample objects. |
| Non-BMFF input straight into MP4Box.js (unit test) | MP4Box.js keeps asking for the same offset and logs `Invalid box type` to `console.error`, outside `onError`. The driver's stall guard ends the run (`PARSER_STALLED`) after 4 appends. |
| Parser exceptions | `appendBuffer` exceptions, `onError`, invalid next offsets, stalls, and the read budget (4 × one pass + 4,096) all become bounded `failure` records. |
| Truncated media | Built-in segments are emitted only for samples actually present. Planned mode refuses windows past EOF (`SOURCE_TRUNCATED`). |
| Output bounds | ≤ 60,000 summary rows per run, 25 per run in the JSON, and bounded error and event lists. |
| Untrusted strings | File names, codec strings, and parser messages are rendered with `textContent` only. Names are bounded to 120 characters with control characters replaced. |
| Filesystem writes | None by the page. Test media was generated by a script into the Git-ignored directory. The CDP profile was deleted. |
| Dependency | MP4Box.js 2.4.1 is pinned with lockfile integrity, installed with `--ignore-scripts`, and has no transitive dependencies. It is served same-origin. |

## Browser Evidence

| Capability | API | Behavior |
| --- | --- | --- |
| `File.slice()` + `Blob.arrayBuffer()` bounded reads | AVAILABLE | VERIFIED up to offset 4,525,650,413 (> 4 GiB) |
| ES module import of MP4Box.js 2.4.1 under the CSP | AVAILABLE | VERIFIED |
| `crypto.subtle.digest("SHA-256")` per segment | AVAILABLE | VERIFIED (≈ 11,000 digests per full MP-03 pass) |
| `performance.memory` | AVAILABLE (non-standard) | Coarse only; CDP figures used |

Node-side observation, not a browser finding: Node.js 26.3.0's `fs.openAsBlob()` reported `size` modulo 2³² for the 4.53 GB files (230,683,117 instead of 4,525,650,413). The Node lab used a `FileHandle`-based adapter instead. Chrome's `File.size` was correct.

## Physical Android Evidence

None. `adb devices` listed no device, and no emulator was used. MP-12 is `DEFERRED PHYSICAL`. Android memory headroom for the sample-table cost is the most important open question.

## Risks / Issues

1. **Built-in segmenter unusable for random access.** MP4Box.js 2.4.1's off-by-one `rapAlignement` behavior and path-dependent boundaries make its `onSegment` segmenter unsuitable as-is. The planned approach uses `createFragment()`, but it also fills `sample.data` / `alreadyRead` directly and sets `samplesDataSize` and `nextMoofNumber`. Those fields are declared in the typings but are internal in spirit. A production integration needs an upstream fix, a thin maintained wrapper, or a reviewed alternative, and must pin the library version with tests.
2. **Shared `nbSamples`.** Built-in segmentation forces one sample count across tracks, so audio and video segment durations differ.
3. **Sample-table heap.** About 343 B per sample (142 MB for 90 min) could exceed mobile budgets for long or high-frame-rate media. A compact typed-array index may be needed.
4. **Fragmented sources.** They are not handled with bounded memory, and their index is partial at `onReady`. They are classified `NON-TARGET` for now.
5. **Unselected tracks.** Any track that is not segmented must be drained, or MP4Box.js retains the whole file.
6. **Error logging.** MP4Box.js writes some malformed-input errors to `console.error` rather than `onError`, and it can stall without erroring. A driver-side stall guard is mandatory.
7. **Synthetic media only.** Real-world file variety is untested.
8. **Init segments.** They differ between layouts of the same media (MP-02 vs MP-05). The reason was not investigated.
9. **Timing values.** Throughput, heap, and timing are same-host lab values.

## Deferred Physical Tests

- `DEFERRED-PHYSICAL-001` to `DEFERRED-PHYSICAL-004` are retained unchanged in `PROJECT_STATE.md`.
- `DEFERRED-PHYSICAL-005 — Spike 0.5 Android Chrome MP4 parsing/segmentation qualification` is new. On physical Android Chrome, repeat:
  - pre-check, inspect, and built-in and planned segmentation on `moov`-first and `moov`-last target files, including a multi-GB, ≥ 90-minute file;
  - later-position planned random access with hash comparison.

  Record:
  - heap after `onReady` (sample-table cost) and peak heap;
  - parser-retained bytes;
  - `File.slice()` read behavior on content-URI and Downloads files;
  - throughput;
  - backgrounding during a long pass;
  - device model, OS, browser version, and free RAM.

## Architecture Impact

`No architecture change required`

- The accepted assumptions hold for non-fragmented target media in controlled desktop testing:
  - browser-side MP4 parsing;
  - bounded local reads;
  - MSE-oriented fMP4 segments;
  - segment/transport separation;
  - seek prioritization.
- MP4Box.js remains a viable candidate. No library replacement is proposed.
- Two findings refine the planned *design* without changing an ADR:
  - segment identity should come from a deterministic plan derived from the sample index, not from MP4Box.js's built-in segmenter state;
  - fragmented sources need separate treatment.
- These are recorded as observations in `docs/MEDIA_PIPELINE.md`.

## Follow-up

Independent review of Spike 0.5 before beginning Spike 0.6.
