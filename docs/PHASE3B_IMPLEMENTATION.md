# Phase 3B Implementation Evidence

**IMPLEMENTED — Host-Authoritative Playback Controls. Independent GitHub review pending.**

Evidence classification: **AUTOMATED SAME-HOST DEVELOPMENT BROWSER EVIDENCE**. This is command synchronization only. No heartbeat/drift correction, continuous synchronization accuracy, physical-device, Android autoplay, different-network or public TURN qualification is claimed. Phase 3 remains IN PROGRESS, exit gate NOT PASSED. Phase 2 physical/network qualification remains **DEFERRED / NOT CLOSED**; its literal physical gate is NOT PASSED. All existing deferred physical debts remain OPEN.

## Starting state and candidate identity

Verified after fetch, branch switch and fast-forward pull on `phase/3-local-sync`:

- Clean worktree; local and origin branch HEAD both `7ce7aba332c9941a7ed5c87b2fa0d3b0cc495fd3`, `fix: bound peer application message rate`.
- Exactly two commits ahead / zero behind merged origin/main `2dd7dea8798bcfc742c8902e853cef69c053eecd`.
- Phase 3A IMPLEMENTED / REVIEW PASS, supplied by the user for `087687e17f2b1ed350f0296ecb7ce3c1cf150f20` and `7ce7aba332c9941a7ed5c87b2fa0d3b0cc495fd3`. Neither is amended.

The Phase 3B candidate is the single new direct-child commit introducing this record, with message `feat: add host-authoritative playback controls`. Its exact SHA is captured in the post-commit/push handoff. Resolve that exact evidence-bearing commit with `git log -1 --format=%H -- docs/PHASE3B_IMPLEMENTATION.md`; the SHA cannot be embedded in its own committed contents.

Environment checked live on 2026-10-05; final verification continued on 2026-10-06: Node **v26.3.0**, npm **11.16.0**, Playwright **1.63.0**, Playwright Chromium **153.0.8010.12**, installed Google Chrome **154.0.8037.97**. Browser versions are from their installed app bundles. Git identity remains **Arunachaleswaran M S <arunachaleswaranms@gmail.com>**. No new dependency, lockfile change, signaling production change or transfer-engine change.

## Protocol and authority

Exactly three new application types: **PLAY, PAUSE, SEEK**. SYNC remains conceptual Phase 3C and is rejected by the current parser. Each is a string JSON envelope on `driftless-control`, never signaling:

```text
{
  protocolVersion: 1,
  type: PLAY | PAUSE | SEEK,
  sequence,
  sentAt,
  payload: {
    sessionId, negotiationId, senderId, recipientId,
    localSelectionId, remoteSelectionId,
    revision, positionMs
  }
}
```

PeerSession injects authenticated context and projects only the four domain fields upward. Sender-local/receiver-local media orientation is retained. Selection IDs are canonical 16-byte/22-character values. Revision is a positive safe integer, 1 through 9,007,199,254,740,991; positionMs is a nonnegative safe integer, 0 through that same maximum. Envelope sequence and sentAt retain their existing nonnegative-safe-integer bounds. Exact fields, missing/extra/prototype keys, malformed IDs/numbers and UTF-8 size are strictly checked. Largest legal playback envelopes with all numeric values maximal: PLAY **396 B**, PAUSE **397 B**, SEEK **396 B**; MAX_PEER_MESSAGE_BYTES remains **1024 B**.

Host outbound is allowed; guest outbound returns false without a send. Guest inbound host commands are validated and rate-admitted. Host inbound guest playback commands fail closed as **peer_protocol**, before application dispatch. A real-channel forged guest PLAY browser scenario confirms channel teardown and normal fresh-peer recovery; units assert the exact failure category for all three types.

Every command binds the current matching media pair. At the guest, sender localSelectionId equals current remote selection, and sender remoteSelectionId equals current local selection. Stale pair/inactive commands are safely ignored and never restore Ready. Transport sequence remains independent from domain playback revision.

The same application bucket covers **MEDIA_INFO, MEDIA_MATCH, MEDIA_MISMATCH, READY, NOT_READY, PLAY, PAUSE, SEEK**: burst **32**, lazy receiver-clock refill **8/s**. Handshake excluded; overflow remains application_rate_limit. No playback allowance, outbound scheduler, timers, acknowledgement or replay queue. The bounded rapid test emits 19 playback commands plus setup, below one 32-message application burst; ordinary committed user actions are low frequency.

## Playback state and browser adapter

The pure engine retains only active/waiting/inactive state, one current local/remote pair, latest revision, playing/paused mode and referenced position. Only bothReady can establish the pair. Host activation pauses at its current position, then emits **PAUSE revision 1**; guest waits for that baseline, pauses and seeks, then activates. Independent previews need not start at zero; the browser baseline scenario starts host at 2 s and guest at 5 s.

Host Play starts local playback and emits the next revision; Pause pauses and emits; committed Seek moves locally and emits while preserving mode. Host play/pause/seeked/ended media events are observed; explicit ownership and state checks prevent internal-event duplicates. The guest seeks/plays for PLAY, pauses before seeking for PAUSE, and seeks without mode changes for SEEK. Guest events never emit authority. Host ended converges through one PAUSE; no replay is automatic.

Positions use Math.round(currentTime * 1000) on the wire; receivers divide by 1000, clamp against max(0, finite local duration), and catch DOM assignment failure. No NaN/Infinity/negative target from wire data and no **sentAt compensation**. An authorized host can intentionally issue disruptive commands; clamping and cooperative media matching do not make it trustworthy.

The playback controller owns no File bytes or object URL. The existing player retains element/object-URL lifecycle ownership; a controlled current-selection callback attaches the element. Replacement/clear synchronously disable the old attachment before rendering; generation-owned listeners/completions cannot affect a new element. Detach/shutdown remove element listeners. LocalSync shutdown remains reusable for React StrictMode.

Ready first attempts native play during the explicit user gesture, pauses, and restores the exact saved local position. Only success sends READY. Preparation sends no PLAY/PAUSE/SEEK, does not silently mute or change volume, and replacement requires new preparation. Fresh peer recovery still needs explicit Ready, which harmlessly prepares again. Preparation failure keeps Not Ready and displays only **Could not prepare synchronized playback. Try Ready again.**

Later native play rejection withdraws local readiness with **PLAYBACK_UNAVAILABLE**, pauses and deactivates, preserving usable media identity/match. UI displays only **Synchronized playback is unavailable. Try Ready again.** No raw browser exception is retained or displayed. Promise ownership rejects stale completion/failure across detach, newer Play/Pause and new Ready cycles; a failure after a newer SEEK still withdraws the pending playing intent. No retry loop.

## UI and lifecycle

Host controls appear only after successful active baseline for the current both-ready pair: **Play**, **Pause**, labelled **Seek position** range and separate **Seek** commit button. Slider edits send nothing. Buttons and labelled input are keyboard operable. Guest sees **The host controls playback.** and no authoritative Play/Pause/Seek controls. Native transport controls are hidden during authority (including guest baseline wait); local preview controls return on inactivity. Volume/mute stay local; dedicated volume/mute UI is a temporary limitation while native controls are hidden. Active synchronized playback restores 1× on ratechange; ordinary preview rate is not constrained. Position formatting is deterministic and no rapidly changing time is announced through aria-live.

Any both-ready loss immediately pauses and discards authority/revision: local/remote Not Ready, media replacement/clear/mismatch, local error, PLAYBACK_UNAVAILABLE or peer failure. No authoritative PAUSE is sent after invalidation. Re-ready establishes a fresh paused revision-1 baseline; explicit host Play is required.

Actual RTCDataChannel failure while playing pauses both participants; Phase 2C replaces the peer, reannounces retained local identity without rehash, resets both Ready choices and replays no playback command. Both users Ready again, host PAUSE revision 1, then explicit Play. Signaling-only reconnect preserves the same healthy channel, readiness, authority/revision and playing state, with no baseline, duplicate command or repeated preparation.

## Root and unit verification

`npm ci` passed: **235 packages added**; existing optional fsevents install-script policy warning, no policy/dependency change. `npm run check` passed typecheck, strict lint, formatting, tests, builds, protocol built-package smoke, sync-engine built-import/GC smoke and signaling built-service smoke.

| Workspace | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| protocol | 288 | 0 | 0 |
| sync-engine | 55 | 0 | 0 |
| signaling | 206 | 0 | 0 |
| web | 441 | 0 | 0 |
| Total | 990 | 0 | 0 |

Additions: 14 protocol cases extend existing legal/missing/extra/prototype/context/selection/direction/bounds checks; 17 pure playback cases; 17 PeerSession authority/rate cases; 29 deterministic playback adapter cases; two added Ready/guest UI cases plus the existing Ready success test updated to prepare first. No regression is skipped. Existing fingerprint vectors are unchanged. Fake media adapters cover browser failures and synchronous media events; browser tests additionally cover actual asynchronous element events.

## Browser verification

All pairs use independent contexts, real local signaling, real RTCPeerConnection and real ordered/reliable RTCDataChannel. Synthetic 8 s MP4/H.264/AAC fixture only. No new autoplay-disable launch flag is added. A forwarding native play probe confirms one preparation call per Ready gesture with active user activation, unmuted volume unchanged, and no extra call on signaling reconnect. Chromium automation can permit playback differently from normal/mobile browsers; deterministic failure policy is established by adapter/Ready unit tests. No mobile autoplay qualification.

Paused baseline/Pause/Seek comparisons use **250 ms** command-application tolerance. Playing seek-region observation uses **1 s**. These are browser test tolerances, not continuous drift criteria or Phase 3 exit-gate acceptance thresholds.

| Phase 3B browser scenario | Result |
| --- | --- |
| Different preview positions → PAUSE revision 1, paused alignment; Ready preparation | PASS |
| Host Play/Pause; current pair and increasing revisions; guest no authority | PASS |
| Committed Seek paused; one command per commit | PASS |
| Seek playing; no introduced PAUSE | PASS |
| Not Ready while playing → pause; re-ready fresh baseline, no automatic resume | PASS |
| Replacement while playing; old real-channel pair ignored | PASS |
| Actual channel recovery while playing; no replay/rehash; explicit Ready again | PASS |
| Signaling-only recovery while playing; same channel/revision/preparation | PASS |
| Bounded rapid sequence repeated three times; final guest state and increasing revisions | PASS |
| Correctly structured forged guest PLAY → failed old peer, recovery | PASS |

Final candidate verification is serial: **workers=1 / retries=0**, no test skips.

| Required run | Passed | Failed | Skipped | Reported elapsed |
| --- | ---: | ---: | ---: | --- |
| Repeated command scenario, 10 consecutive Chromium executions | 10 | 0 | 0 | 40.2 s |
| Full Chromium run 1 | 66 | 0 | 0 | 1.7 min |
| Full Chromium run 2 | 66 | 0 | 0 | 1.7 min |
| Full Chromium run 3 | 66 | 0 | 0 | 1.9 min |
| Installed Chrome opt-in: 66 Chromium + 66 Chrome | 132 | 0 | 0 | 4.2 min |

Installed Chrome opt-in verification passed on the final files: **132/132**, one worker, retries 0, no skips. The initial combined opt-in run reported **100 passed / 32 failed / 0 skipped**, retries 0, over **6.1 hours**. Chromium passed all 66; Chrome passed 34 and failed 32. macOS power logs confirm repeated sleep/maintenance-wake cycles during that run. Failures include an existing preview lifecycle and peer-connection timeouts before playback activation, including existing Phase 2 tests. Failed traces are retained locally; a fresh Chrome-only connection/baseline diagnostic run passed **2/2** in **13.1 s** after wake, without code changes. The next combined rerun was interrupted by an execution-environment change before a final result; it is not counted. The complete opt-in verification restarted with a durable log and passed **132/132** in **4.5 min** (66 Chromium plus 66 Chrome), with no code/policy change to address the failures. Final room-panel/web-README wording was then corrected, and root/ten-repeat/three-consecutive-full/Chrome verification passed again on those exact files; the final results are in the table above. The failed run is not a passing qualification result.

Exact root and final-browser commands:

```bash
npm ci
npm run check
npm run test:e2e -- playback-sync.spec.ts --grep 'repeated command sequence' --repeat-each=10 --workers=1 --retries=0
npm run test:e2e -- --workers=1 --retries=0 # three consecutive full Chromium runs
DRIFTLESS_E2E_CHROME=1 npm run test:e2e -- --workers=1 --retries=0
npm audit
npm audit --omit=dev
```

The ten repeated runs include paused baseline → Play → Pause → committed Seek → Play → Pause, with exact command types and revisions 1–6, current-pair binding, final paused alignment, and privacy assertions. Each full run includes all nine new Phase 3B scenarios plus all 57 existing browser regressions. The three required Chromium full runs are consecutive with no intervening implementation edits.

## Privacy and scope

Observed data-channel sends are strings, parse as bounded JSON and contain only control state: no Blob/ArrayBuffer/typed-array/media send, filename/path, MIME, object URL, digest metadata, duration, browser error or playback clock data. Signaling frames contain no Local Sync playback types. Request probes show only GET/HEAD, no upload. Browser snapshots show empty localStorage/sessionStorage/IndexedDB/OPFS/Cache Storage and no playback state in URL/navigation; production inspection finds no playback persistence/history writes. The pre-existing no-transfer identity slice/whole-file probes remain passing.

Both **npm audit** and **npm audit --omit=dev** report **0 vulnerabilities**. No dependency or lockfile change. No services/signaling production or packages/transfer-engine change. No SYNC, heartbeat, playback clock offset/RTT/delay estimation, drift detection/correction, rate correction, sync polling/interval/animation-frame loop, buffering coordination, media transfer, MSE, OPFS, MP4Box, chat/reactions or Progressive Watch implementation. Only new playbackRate behavior enforces active 1×.

Development failures were corrected before final verification: protocol exhaustive-type expectations still rejected PLAY as unknown; controller construction initially subscribed before instance callbacks initialized; lint/format caught adapter/test details; the first browser seek tests omitted evaluate arguments (13 passed / 3 test failures). Sandbox loopback listen EPERM caused existing signaling integration failures and browser-server startup refusal; the same checks passed outside that restriction. Later probe lint was fixed using the repository's existing Reflect/call forwarding pattern. No retries or skipped assertions hide failures.

## Durable status and handoff

```text
Phase 3 — IN PROGRESS
3A — IMPLEMENTED / REVIEW PASS
3B — IMPLEMENTED (independent review pending)
3C — NEXT / NOT STARTED
3D — NOT STARTED
Phase 3 exit gate — NOT PASSED
Phase 2 physical/network qualification — DEFERRED / NOT CLOSED
```

Independent GitHub review of the exact pushed Phase 3B commit. Do not begin Phase 3C before review PASS.
