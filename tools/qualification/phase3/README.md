# Phase 3 external qualification

These tools do not ship in the web app. They neither grant authority nor alter
protocol, readiness, production thresholds or security. Read the frozen gate in
[PHASE3_QUALIFICATION.md](../../../docs/PHASE3_QUALIFICATION.md).

```sh
node --test tools/qualification/phase3/metrics.test.mjs
FFMPEG=/path/to/ffmpeg node tools/qualification/phase3/generate-fixture.mjs fixtures/local
DRIFTLESS_BUILD_REVISION=<full-committed-sha> npm run build
DRIFTLESS_BUILD_REVISION=<same-sha> caffeinate -i node tools/qualification/phase3/soak.mjs fixtures/local/synthetic-320x180-35m-h264-aac.mp4 /private/tmp/phase3-soak.json 1800
```

Generator requires FFmpeg with libx264/AAC/lavfi, produces 2100 s synthetic color
and tone at 320×180/30fps, H.264 High/yuv420p, AAC-LC stereo/48kHz. Encoding is
single-threaded/bitexact/no personal metadata. Same encoder build is reproducible;
other versions may differ. Share the generated exact bytes out of band and verify
SHA-256 on both devices. Never commit MP4/raw data. Generator prints filename,
byte length and SHA-256 only. Record codec/duration verification from encoder,
browser metadata and independent inspection if available.

`soak.mjs` uses installed desktop Chrome, independent contexts, loopback signaling
and real media for 10 s warm-up plus 1800 s continuous playing. It verifies displayed
SHA, records every scheduled observation/rejection, privacy counters and CDP metrics.
Ports 4183/8793 must be free. Runs are real time, not accelerated. External browser
probe retains fixed-size counters and only the latest sanitized heartbeat. It is
injected by tooling into disposable contexts; no production window hook exists.
It counts seek events, not classified hard corrections. Root E2E owns detailed
command/correction/recovery tests. Its result is **AUTOMATED SAME-HOST DEVELOPMENT
BROWSER EVIDENCE** and cannot close a physical gate.

For already-playing physical browser pages with separate local CDP endpoints:

```sh
DRIFTLESS_BUILD_REVISION=<same-sha> node tools/qualification/phase3/sample-cdp.mjs HOST_CDP GUEST_USB_CDP /private/tmp/physical-samples.json 1800
```

Use USB ADB forwarding for Android (Wi-Fi off). Requires exactly one video page
per endpoint, already on the confirmed exact build/topology, matching independent
local files and explicit Ready/Play. Sampler is observational only. It disconnects
CDP after the run and does not close the participants' browser processes. Raw output
is deliberately UNCLASSIFIED until the operator records topology, build, transitions,
continuous playing, errors and no-transfer evidence. Statistics alone are insufficient.
The sampler contains no secrets or network identifiers in output.

Near-simultaneous evaluations use one external monotonic clock, project observations
to a common midpoint epoch using media rate/paused state, reject RTT>100 ms or
effective separation>200 ms and retain rejection reasons. Math tests cover projection,
boundaries/rejections, percentiles, explicit exclusions, consecutive violations,
coverage and PASS/FAIL/GAP. Missing/rejected observations cannot silently pass.

Do not rebuild/edit code during gate collection. A fix requires new commit/full
regression/requalification. Only concise sanitized summaries belong in Git.
