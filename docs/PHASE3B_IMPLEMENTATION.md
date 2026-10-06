# Phase 3B Implementation Evidence

Current review status: **IMPLEMENTED / REVIEW PASS** for the implementation and Ready-cycle correction through `9ace3833eccc560a0cecd3075c49edbf01e4f3f5`, as approved by the user before Phase 3C authorization. The records below retain historical implementation-time evidence and pre-review wording; current status is in PROJECT_STATE.md. Phase 3C evidence is separate.

**IMPLEMENTED — Host-Authoritative Playback Controls. Independent GitHub review pending.**

Evidence classification: **AUTOMATED SAME-HOST DEVELOPMENT BROWSER EVIDENCE**. This is command synchronization only. No heartbeat/drift correction, continuous synchronization accuracy, physical-device, Android autoplay, different-network or public TURN qualification is claimed. Phase 3 remains IN PROGRESS, exit gate NOT PASSED. Phase 2 physical/network qualification remains **DEFERRED / NOT CLOSED**; its literal physical gate is NOT PASSED. All existing deferred physical debts remain OPEN.

The sections below, up to the separate independent-review correction, preserve the original implementation evidence for `8b11ae7ca8a0989a3d676420d184c12a80192cba`. Current Ready/playback wire shapes and verification are recorded in the correction section and [PROTOCOL.md](PROTOCOL.md).

## Starting state and candidate identity

Verified after fetch, branch switch and fast-forward pull on `phase/3-local-sync`:

- Clean worktree; local and origin branch HEAD both `7ce7aba332c9941a7ed5c87b2fa0d3b0cc495fd3`, `fix: bound peer application message rate`.
- Exactly two commits ahead / zero behind merged origin/main `2dd7dea8798bcfc742c8902e853cef69c053eecd`.
- Phase 3A IMPLEMENTED / REVIEW PASS, supplied by the user for `087687e17f2b1ed350f0296ecb7ce3c1cf150f20` and `7ce7aba332c9941a7ed5c87b2fa0d3b0cc495fd3`. Neither is amended.

The original Phase 3B implementation is `8b11ae7ca8a0989a3d676420d184c12a80192cba`, `feat: add host-authoritative playback controls`, the direct child of approved Phase 3A `7ce7aba332c9941a7ed5c87b2fa0d3b0cc495fd3`. The correction is a separate child commit; neither original commit is amended.

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


## Independent review correction — Ready-cycle playback binding

Starting state verified on 2026-10-06 after fetch, branch switch and ff-only pull: local and origin `phase/3-local-sync` both exactly `8b11ae7ca8a0989a3d676420d184c12a80192cba`, clean worktree. Verification continued on 2026-10-07. One separate fix commit, `fix: bind playback to readiness cycles`, preserves original 3B and approved 3A history. No amend, force push, PR, merge, or phase advancement.

**3B-01 root cause:** media IDs remain unchanged when a participant withdraws/re-readies. Revision resets to 1, so delayed Cycle-A PAUSE revision 1 could activate Cycle B and block its genuine revision-1 baseline. Guest→host NOT_READY/READY and host→guest PAUSE are opposite directions; ordered per-sender transport sequence cannot order this cross-direction application state.

`ReadinessId` is 16 cryptographically random bytes (128 bits), canonical unpadded base64url (22 characters, canonical trailing bits), with exported byte/length constants and fixed guard. It is a fresh participant-local identity for one explicit Ready intent, generated through an injectable browser `crypto.getRandomValues` adapter exactly once after successful preparation. Failed preparation consumes/stores no current generation; every explicit re-Ready is fresh.

Exact coordinated peer-domain wire changes (PeerSession still adds sessionId, negotiationId, senderId, recipientId):

```text
READY { localSelectionId, remoteSelectionId, fingerprint, readinessId }
PLAY / PAUSE / SEEK {
  localSelectionId, remoteSelectionId,
  localReadinessId, remoteReadinessId,
  revision, positionMs
}
```

Host commands use the stored current activation context. Guest validates flipped sender-local media **and readiness** IDs before revision ordering. Only both Ready with both non-null IDs can establish an activation. PAUSE revision 1 still begins every fresh cycle; H1/G1 differs from H1/G2, so old revision 1 cannot activate the new cycle. No history. PeerSession sequence is the transport ordering/replay boundary, readiness IDs identify cycles, playback revisions order authority within one cycle. Authentication remains PeerSession/session context; ReadinessId is not a credential.

NOT_READY remains unchanged: ordered same-direction delivery and sequence checks ensure withdrawal precedes that sender's later READY. A READY cannot replace a still-current remote ID; after withdrawal it can record a fresh one. Playback IDs solve the opposite-direction race without withdrawal history. PROTOCOL_VERSION stays 1 because pre-release endpoints ship together. Strict old shapes are rejected. All eight application families still share burst 32/refill 8/s and MAX_PEER_MESSAGE_BYTES = 1024.

Local ID is cleared on Not Ready/PLAYBACK_UNAVAILABLE and every local readiness invalidation; remote ID is cleared whenever remote Ready ends. Replacement, clear, mismatch/errors and fresh peer transitions clear affected IDs. Fresh peer recovery clears both; the same healthy channel during signaling reconnect preserves readiness IDs, activation, revision and playback. IDs are random, ephemeral, memory-only, peer-only, never media/time/room/participant-derived, persisted, displayed, logged, placed in URLs or added to signaling/resume/room storage. No dependency/lockfile or signaling-production change.

Mandatory deterministic controller test `3B-01 opposite-direction old H1/G1 rev1 baseline cannot activate H1/G2`: capture PAUSE revision 1 at **2000 ms**, do not deliver; guest withdraws G1 and re-readies G2 while retaining H1. Old baseline is ignored: waiting/inactive, revision **0**, currentTime unchanged at **2.5 s**, never **2 s**. Genuine H1/G2 PAUSE revision 1 at **6000 ms** activates, revision **1**, paused at exactly **6 s**. Separate PLAYBACK_UNAVAILABLE regression ends G1 after rejected PLAY, re-readies G2, rejects delayed old PLAY/PAUSE/SEEK, and accepts the fresh 6 s baseline. Late old PLAY promises cannot affect a new cycle. Pure state tests cover both incorrect readiness orientations and same-media fresh-cycle revision reset.

Supplemental browser regression uses the existing real-channel probe: capture Cycle A, withdraw/re-ready the same media, establish Cycle B paused at 6 s, then inject old readiness IDs with fresh envelope sequence and revision 50 at 2 s. Guest remains paused at 6 s with controls hidden/current authority intact and channel connected. No production test hook.

### Correction root/unit verification

`npm ci` passed, **235 packages added**, with the unchanged optional fsevents install-script policy warning. Full `npm run check` passed typecheck, lint, formatting, all unit/component/integration tests, builds, and protocol/sync-engine/signaling built-package smoke checks. Final root results:

| Workspace | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| protocol | 295 | 0 | 0 |
| sync-engine | 62 | 0 | 0 |
| signaling | 206 | 0 | 0 |
| web | 446 | 0 | 0 |
| Total | 1009 | 0 | 0 |

Focused readiness/playback tests passed **43/43**; LocalSyncPanel/controller, PlaybackSyncController, PeerSession and room-controller focused tests passed **193/193**, no skips. Protocol Local Sync/identifier focused tests passed **82/82** on the final sources (**295/295** overall). The correction adds seven protocol, seven sync-engine and five web cases. Existing fingerprint vectors and all role/sequence/rate tests pass.

Largest legal envelopes with maximal sequence/sentAt/revision/position values: READY **438 B**, PLAY **485 B**, PAUSE **486 B**, SEEK **485 B**. Strict required readiness fields, malformed IDs, missing/extra keys and old shapes are tested. All are below **1024 B**. SYNC remains unknown.

Environment verified live: Node **v26.3.0**, npm **11.16.0**, Playwright **1.63.0**, Playwright Chromium **153.0.8010.12**, installed Chrome **154.0.8037.98**. Browser versions read from installed app bundles. Serial runs use workers=1/retries=0; temporary caffeinate prevents idle system sleep. Same-host contexts/real channels/synthetic MP4 remain development-browser evidence, not physical, Android, different-network, or TURN qualification.

### Correction audit and failed-run evidence

`npm audit` on 2026-10-07 returned **1 high-severity development dependency vulnerability**, exit 1: existing `source-map-js@1.2.1`, advisory [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q). `npm explain source-map-js` identifies it as dev. `npm audit --omit=dev` returned **0 vulnerabilities**, exit 0. No audit fix/dependency/lockfile change was made in this targeted correction. Historical zero-audit results above describe the earlier implementation, not this current registry result.

Development typecheck/test failures from outdated shapes/projections/fixtures and a duplicate test import were corrected. One focused web run had **187 passed / 1 failed** due to the old exact-state fixture omitting readiness IDs; corrected rerun passed **193/193** after adding regressions. Root attempt 1 failed the outdated protocol export smoke assertion. Restricted root attempt 2 hit signaling loopback `listen EPERM`: **162 passed / 44 failed**. The first unrestricted root run caught a test-adapter require-await lint issue; the next caught formatting; final root rerun passed. Restricted audit DNS failures (`ENOTFOUND registry.npmjs.org`) were rerun with registry access. These failures are not passing results and no retry setting hid them.

Durable local logs are retained under `/private/tmp/driftless-3b-fix-*.log`: `check-attempt1`, `check-attempt2`, `check-unrestricted`, `check-final`, `check-final2` (passing final root), `npm-ci`, `audit`, `audit-prod`, `audit-unrestricted`, `audit-prod-unrestricted`. Browser logs and separate per-run trace directories use the same prefix; failed evidence is not deleted or committed as generated data.

### Correction browser verification

| Required correction run | Passed | Failed | Skipped | Reported elapsed |
| --- | ---: | ---: | ---: | --- |
| Full root Playwright Chromium regression | 67 | 0 | 0 | 1.5 min |
| Phase 3B baseline → Play → Pause → Seek → Play → Pause, 10 consecutive executions | 10 | 0 | 0 | 24.1 s |
| Full Chromium run 1 | 67 | 0 | 0 | 1.5 min |
| Full Chromium run 2 | 67 | 0 | 0 | 1.5 min |
| Full Chromium run 3 | 67 | 0 | 0 | 1.5 min |
| Installed Chrome opt-in: 67 Chromium + 67 Chrome | 134 | 0 | 0 | 3.1 min |
| Total browser executions | 412 | 0 | 0 | |

Every run used **workers=1/retries=0**. Three required Chromium full runs were consecutive, with no implementation/test edits between them. Each full browser run includes the new same-media stale-readiness regression; it passed in both Chromium and installed Chrome. All existing Phase 3B/Local Sync/room/media/diagnostic/recovery/browser regression cases remain passing. No correction browser run failed or was skipped. Logs are `e2e-root`, `repeat10`, `chromium-1`, `chromium-2`, `chromium-3`, and `optin` under `/private/tmp/driftless-3b-fix-*.log`; separate trace/output directories are `root-traces`, `repeat-traces`, `chromium-{1,2,3}-traces`, and `optin-traces` under that prefix. Historical failed-run evidence above remains intact.

Commands (each browser run also used a separate `--output=/private/tmp/driftless-3b-fix-...-traces` directory):

```bash
npm ci
npm run check
npm run test:e2e -- --workers=1 --retries=0
npm run test:e2e -- playback-sync.spec.ts --grep 'repeated command sequence' --repeat-each=10 --workers=1 --retries=0
npm run test:e2e -- --project=chromium --workers=1 --retries=0 # three consecutive runs
DRIFTLESS_E2E_CHROME=1 npm run test:e2e -- --workers=1 --retries=0
npm audit
npm audit --omit=dev
```

Final scope search and diff review find no new SYNC, heartbeat, timers/polling/animation-frame synchronization, clock offset, RTT/delay compensation, drift detection/correction, transfer, MSE, OPFS, MP4Box or Progressive Watch implementation. Only existing module/domain names and explanatory UI/type references match the requested search. No signaling-production/dependency/lockfile changes. The staged changes contain source, tests, built-import smoke expectations and documentation only, no secrets or generated evidence.

The exact separate fix SHA is supplied by the post-commit/push handoff and can be resolved with `git log -1 --format=%H -- docs/PHASE3B_IMPLEMENTATION.md`. Author identity remains **Arunachaleswaran M S <arunachaleswaranms@gmail.com>** with no additional attribution.

Status remains **3B — IMPLEMENTED; independent review pending**. Phase 3C/3D are NOT STARTED, overall Phase 3 exit gate NOT PASSED, and Phase 2 physical/network qualification DEFERRED / NOT CLOSED.


Independent GitHub re-review of the exact Phase 3B fix commit. Do not begin Phase 3C before review PASS.
