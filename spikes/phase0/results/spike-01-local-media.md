# Spike 0.1 Result — Large Local Browser Media Playback

## Spike

`0.1 — Large Local Browser Media Playback`

## Result

`PROVISIONAL PASS — PHYSICAL ANDROID DEFERRED`

The experiment implementation and deterministic automated checks pass. The user subsequently confirmed that desktop Chrome local-file selection, compatible local video playback, pause/resume, and seeking work, with good overall manual behavior and no issue requiring an architecture change. Physical Android Chrome is intentionally deferred to the later project-wide physical qualification stage. Exact desktop media characteristics and memory measurements were not recorded, so no resource or large-file memory claim is made.

## Experiment Scope

Validate browser-native playback of a user-selected local file without upload, application-level whole-file reads, transcoding, synchronization, signaling, or Progressive Watch behavior. Initial compatibility focus: MP4 container, H.264/AVC video, AAC audio.

## AUTOMATED

**Status:** `PASS` for the scoped non-browser logic and source checks

Environment: macOS 26.6.2 (25G83), Node.js v26.3.0.

Commands and outcomes:

```text
node --test spikes/phase0/spike-01-local-media/src/formatters.test.mjs
PASS — 5 tests passed, 0 failed.

node --check spikes/phase0/spike-01-local-media/src/app.mjs
PASS — exit 0.

node --check spikes/phase0/spike-01-local-media/src/formatters.mjs
PASS — exit 0.

git diff --check
PASS — exit 0, no whitespace errors.

curl --fail --silent --show-error http://127.0.0.1:4173/ -o /dev/null
curl --fail --silent --show-error http://127.0.0.1:4173/src/app.mjs -o /dev/null
curl --fail --silent --show-error http://127.0.0.1:4173/src/formatters.mjs -o /dev/null
PASS — all three static resources returned successful HTTP responses.
```

Automated coverage is intentionally limited to deterministic display/diagnostic helpers and JavaScript syntax. It cannot establish native decoding, playback, seeking, multi-GB browser resource behavior, or physical-device compatibility.

## MANUAL DESKTOP

**Status:** `DESKTOP MANUAL PASS` for the core local playback path

Manual environment: desktop Chrome. The exact browser version, operating-system version, and media characteristics were not recorded with the user evidence.

User evidence recorded on 2026-09-25:

- Desktop Chrome local-file selection worked.
- Compatible local video playback worked.
- Pause and resume worked.
- Seeking worked. Exact seek directions, distances, and timestamps were not recorded.
- Overall desktop manual behavior was good.
- No observed issue required an architecture change.

Separate automated smoke environment from 2026-09-21: macOS 26.6.2 (25G83), Google Chrome 153.0.8010.48. Chrome reported `probably` for `video/mp4; codecs="avc1.42E01E, mp4a.40.2"`, the page initialized cleanly, and static resources loaded. This automated smoke evidence is not treated as the user-operated playback evidence.

| Test | Status | Evidence / notes |
| --- | --- | --- |
| LM-01 Compatible MP4 selection and metadata | `DESKTOP MANUAL PASS` | User confirmed local-file selection and compatible playback. Exact file and metadata values were not recorded. |
| LM-02 Start playback | `DESKTOP MANUAL PASS` | User confirmed compatible local video playback. |
| LM-03 Pause/resume | `DESKTOP MANUAL PASS` | User confirmed pause/resume. |
| LM-04 Significant forward seek | `DESKTOP MANUAL PASS — GENERAL SEEK EVIDENCE` | User confirmed seeking worked; direction and distance were not recorded separately. |
| LM-05 Backward seek | `DESKTOP MANUAL PASS — GENERAL SEEK EVIDENCE` | User confirmed seeking worked; direction and distance were not recorded separately. |
| LM-06 Replace/clear file and clean resources | `NOT TESTED` | Cleanup path is present and source-inspected; no specific manual replacement/clear observation was supplied. |
| LM-07 Large compatible file and memory observations | `NOT TESTED` | No exact file sizes or memory measurements were recorded. |
| LM-08 Unsupported/incompatible media | `NOT TESTED` | No user evidence for an incompatible-media run was supplied. |

## MANUAL REAL ANDROID

**Status:** `DEFERRED PHYSICAL`

No physical-device result has been recorded. This is an intentional project decision to accumulate physical Android gates for the later project-wide qualification stage. Emulator or desktop device simulation does not satisfy this section.

`adb devices -l` was checked on 2026-09-21. It listed only `emulator-5554` (`sdk_gphone64_arm64`); no physical Android device was connected. The emulator was not used as LM-09 evidence.

| Test | Status | Evidence / notes |
| --- | --- | --- |
| LM-09 Physical Android Chrome | `DEFERRED PHYSICAL` | Tracked as `DEFERRED-PHYSICAL-001 — Spike 0.1 Android Chrome local media qualification` in `PROJECT_STATE.md`. |

## NOT TESTED

- Physical Android Chrome file selection, playback, pause/resume, seeks, replacement, errors, and large-file behavior (`DEFERRED-PHYSICAL-001`).
- Real compatible files around 500 MB, 1 GB, 2 GB, or larger.
- Desktop replacement/clear behavior and unsupported/incompatible media behavior.
- Renderer/decoder memory observations during large-file use and cleanup.
- Unsupported codec/profile behavior on the target browser versions.

## Security and Privacy Inspection

- The page receives a browser-provided `File` and creates a local blob URL.
- It does not contain a media upload endpoint, `fetch`, `XMLHttpRequest`, `WebSocket`, WebRTC, analytics, or telemetry.
- The Content Security Policy sets `connect-src 'none'` and permits media only from the page origin and `blob:` URLs.
- It does not call `FileReader`, `Blob.arrayBuffer()`, `File.arrayBuffer()`, or another whole-file read API.
- It displays filename and media diagnostics locally with `textContent`; it does not transmit them.
- Replacement and clear paths pause playback, remove `src`, call `load()`, and revoke the prior object URL. The page-hide path also releases the active object URL.
- `spikes/phase0/test-media/` is ignored by Git.

## Findings

- Implementation inspection shows the spike can bind the selected `File` directly to a native `<video>` element without an intentional application-level full-file copy.
- Actual desktop manual evidence accepts the core local-selection/playback/pause/resume/seek path.
- Browser and decoder memory behavior still requires runtime measurement with representative large compatible files; no exact memory evidence exists.

## Issues Discovered

- No architecture blocker is known from current evidence.
- Physical Android evidence is deliberately deferred, so Android architecture risk remains unqualified and final Android support cannot be claimed.
- Detailed desktop replacement, incompatible-media, large-file, and memory observations remain unrecorded.
- The earlier automation controller's local-file permission prevented an automated Chrome selection run. The later user-operated desktop evidence confirms that ordinary Chrome file selection works.

## Decision

Close Spike 0.1 software work provisionally as `PROVISIONAL PASS — PHYSICAL ANDROID DEFERRED`. The desktop core path is accepted from actual manual evidence. Retain `DEFERRED-PHYSICAL-001` until physical Android Chrome is validated, and reopen the spike if later findings invalidate the current conclusion.

## Manual Test Procedure

At the later physical qualification stage, follow LM-09 and the applicable LM-01 through LM-08 steps in `../spike-01-local-media/README.md`. Attach or transcribe exact observations here without adding test media to Git.

## Architecture Impact

No architecture change required.

## Follow-up

Retain `DEFERRED-PHYSICAL-001` in `PROJECT_STATE.md` until physical Android qualification is complete.
