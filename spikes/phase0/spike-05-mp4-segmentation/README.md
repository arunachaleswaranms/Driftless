# Spike 0.5 MP4 Parsing & Segmentation Experiment

This page inspects a **locally selected** MP4 with MP4Box.js 2.4.1. It reads the file in bounded `File.slice()` blocks and generates fragmented-MP4 initialization and media segments **in memory**. It verifies each segment with an independent box walker, records its timing, size, keyframe alignment, and optional SHA-256, and then releases it.

It covers only the media-preparation layer. It does not play media, use Media Source Extensions, send anything over WebRTC, store segments, or implement Progressive Watch. The page's Content Security Policy sets `connect-src 'none'` and `media-src 'none'`, so it cannot upload or play the selected file. There is no analytics or telemetry.

## Layout

| File | Responsibility |
| --- | --- |
| `src/source.mjs` | Instrumented reader over a Blob-like source. It allows one read in flight, enforces block and range bounds, and counts reads, bytes, rereads, and non-sequential reads. It also includes a Node `FileHandle` adapter. |
| `src/boxes.mjs` | Box handling independent of MP4Box.js: a strict box-header decoder, a header-only top-level scan (moov placement, fragmentation, 64-bit sizes), and a `moov` sample-table budget check. |
| `src/fmp4.mjs` | Independent verifier for the generated init segment (`mvex`/`trex`, empty sample tables) and for media segments (`mfhd`, `tfhd`, `tfdt`, `trun` flags, durations, sizes, sync flags, and mdat bounds). |
| `src/classify.mjs` | Structural classification: `TARGET COMPATIBLE` / `NON-TARGET / EXPERIMENTAL` / `NOT PARSEABLE AS MP4`. |
| `src/session.mjs` | MP4Box.js driver. It includes the pre-check, `inspect()`, `builtinSegments()` (`onSegment`, optional `seek()`), `plannedSegments()` (a deterministic time plan cut with `createFragment()`), random-access and later-position analysis, and memory accounting. |
| `src/app.mjs` | Page controller: file selection, experiment orchestration, diagnostics, and bounded evidence JSON. |
| `src/test-fixtures.mjs` | Test-only builder for tiny deterministic MP4s (placeholder sample bytes), and a Blob-like memory source. |
| `src/inspection.test.mjs` | Unit tests for boxes, the verifier, the reader, and classification. |
| `src/segmentation.test.mjs` | Integration tests that run real MP4Box.js over in-code fixtures. |
| `tools/make-test-media.sh` | Generates synthetic test media into the Git-ignored `spikes/phase0/test-media/spike-05/`. |

## Dependency

MP4Box.js is the only dependency. It is pinned to exactly `2.4.1` (BSD-3-Clause, zero transitive dependencies), and `package-lock.json` records its registry integrity hash. `node_modules/` is Git-ignored. From this directory:

```sh
npm ci --ignore-scripts
```

The page imports `../node_modules/mp4box/dist/mp4box.all.mjs` from the same origin, so no CDN is involved.

## Run

From the repository root:

```sh
python3 -m http.server 4176 --bind 127.0.0.1 --directory spikes/phase0
```

Open `http://127.0.0.1:4176/spike-05-mp4-segmentation/` and select a file.

- **Inspect** runs the pre-check and then parses until `moov` is available. It reports metadata, classification, keyframes, and later-position requirements.
- **Built-in segmentation** / **Planned segmentation** run one strategy over the whole file at the selected target.
- **Later-position experiments** cover one planned random-access segment (hash-compared with the sequential cut when available), plus MP4Box.js `seek(t, true)` and a `seek(t, false)` negative control.
- **Run full analysis** runs all of the above: 1/2/4 s strategies for target media, and one experimental run for non-target media.

The later position defaults to 50 % of the duration. Raw bounded evidence is under **Raw JSON evidence**.

## Automated Checks

```sh
npm ci --ignore-scripts
node --test src/*.test.mjs
node --check src/*.mjs
```

The integration tests import MP4Box.js from `node_modules/` and fail with an instruction if it is missing.

## Test Media

No media is committed. Generate synthetic files (FFmpeg `testsrc2`/`sine`/`noise` sources only):

```sh
FFMPEG=/path/to/ffmpeg spikes/phase0/spike-05-mp4-segmentation/tools/make-test-media.sh [--large]
```

`--large` adds two 90-minute, ~4.5 GB files (`moov` last and `moov` first). They need about 10 GB of free disk.

## Experimental Parameters (not production values)

| Parameter | Value |
| --- | --- |
| Read block | 64 KiB, 256 KiB, 1 MiB (default), 4 MiB; one read in flight |
| Explicit range read | ≤ 128 MiB (`moov` pre-check); planned-segment window ≤ 64 MiB |
| `moov` accepted | ≤ 128 MiB, ≤ 5,000,000 samples per track, ≤ 12,000,000 total |
| Stall guard | 4 identical next-offset requests end the run (`PARSER_STALLED`) |
| Read budget | 4 × a single sequential pass + 4,096 reads |
| Segment targets | ≈ 1 s, 2 s, 4 s |
| Evidence rows | ≤ 60,000 per run in memory; 20 + 5 per run in the JSON |

## Segmentation Strategies

- **Built-in (MP4Box.js `onSegment`).** `setSegmentOptions(id, user, { nbSamples, rapAlignement: true })` is called for the selected video and audio tracks. MP4Box.js 2.4.1 requires the same `nbSamples` for every track, so `nbSamples = round(videoFps × target)`, and audio segments therefore get a different duration. With `seekSeconds`, `seek(t, useRap)` is called before `start()`.
- **Planned (deterministic).** After `moov`, a plan is built from the sample tables alone:
  - a new video segment starts at the first sync sample at least `target` seconds after the current segment start;
  - every other track is cut at those times.

  Each planned segment is cut with `ISOFile.createFragment()`. Its samples are filled from one explicit source window, and the `moof` sequence number is set to `planIndex + 1`.

  The plan is a pure function of the `moov`. Any single segment can therefore be generated after reading only the `moov` and that segment's window. The result is byte-identical whether it was reached sequentially or by random access.

## Security Posture

- The selected file never leaves the page. It is not uploaded, persisted, or given to a media element.
- Parser input is untrusted. A header-only scan and a bounded `moov` budget check run first. The page refuses non-BMFF input, a missing or truncated `moov`, an oversize `moov`, and sample-table bombs before MP4Box.js sees them.
- MP4Box.js exceptions, `onError`, invalid next positions, stalls, and read-budget exhaustion become bounded `failure` records.
- File names and container strings are rendered only through `textContent`, with control characters replaced and a length bound.
- Generated segments exist only in memory. They are released after verification and hashing, and only bounded summaries are kept.

## Evidence Classification

Headless desktop Chrome automation is `AUTOMATED DESKTOP`. Timings are same-host laboratory observations, and heap figures are coarse. Physical Android is `DEFERRED PHYSICAL` (`DEFERRED-PHYSICAL-005`).
