# Phase 3C Implementation Evidence

**IMPLEMENTED — Heartbeat, Clock Estimation, Drift Detection & Correction. Independent GitHub review pending.** No 3C REVIEW PASS is claimed. Phase 3D is NEXT / NOT STARTED. Phase 3 exit gate is NOT PASSED. Phase 2 physical/network qualification remains DEFERRED / NOT CLOSED; all existing physical debts remain open.

Evidence classification: **AUTOMATED SAME-HOST DEVELOPMENT BROWSER EVIDENCE**. Browser contexts on one development machine, synthetic 8 s MP4/H.264/AAC, real loopback signaling and real RTCPeerConnection/ordered RTCDataChannel. No physical Android, different-network, cellular, TURN, real long-duration or final synchronization-quality qualification.

## Starting state and environment

Fetch, switch and ff-only pull verified clean local/remote `phase/3-local-sync` at exactly `9ace3833eccc560a0cecd3075c49edbf01e4f3f5`, message `fix: bind playback to readiness cycles`. User approves 3A and 3B IMPLEMENTED / REVIEW PASS. Original commits remain unchanged; one separate 3C implementation commit is intended, with no amend/force push/PR/merge.

Node **v26.3.0**, npm **11.16.0**, Playwright **1.63.0**, Playwright Chromium **153.0.8010.12**, installed Google Chrome **154.0.8037.98**, verified live. Git identity: **Arunachaleswaran M S <arunachaleswaranms@gmail.com>**, no additional attribution. No external dependency, lockfile change, signaling production change or transfer-engine change.

## Protocol and authority

One peer-only SYNC type, strict discriminated phases, exact domain shapes:

```text
HEARTBEAT {
  phase: "HEARTBEAT",
  localSelectionId, remoteSelectionId, localReadinessId, remoteReadinessId,
  syncSequence, revision, mode, positionMs, capturedAtMs,
  clockOffsetMs, roundTripMs
}
OBSERVATION {
  phase: "OBSERVATION",
  localSelectionId, remoteSelectionId, localReadinessId, remoteReadinessId,
  syncSequence, guestReceivedAtMs, guestSentAtMs
}
```

PeerSession adds authenticated sessionId/negotiationId/senderId/recipientId and the unchanged versioned envelope. Upward callbacks omit all transport context. HEARTBEAT is host-only, OBSERVATION guest-only; wrong outbound phase returns false, wrong inbound phase fails peer_protocol before application dispatch. Phase-specific missing/extra/prototype/opposite-phase fields and old/unknown shapes fail strict parsing. No SYNC_ACK/SYNC_RESULT/CLOCK_REQUEST/CLOCK_RESPONSE.

Every message binds exact sender-local media and readiness IDs. Current activation is checked before timing/revision. Peer transport sequence provides ordering/replay; Ready IDs identify activation; playback revision orders discrete authority; syncSequence correlates observations only. SYNC cannot activate/repair/advance authority or substitute for PLAY/PAUSE/SEEK. Guest correction requires existing active authority with equal revision/mode. Current-cycle ineligible revision/mode may be observed/responded to without correction; stale-cycle heartbeats receive no response. Repeated sample IDs produce no duplicate response.

Mode is playing/paused; revision and syncSequence are positive safe integers; position is nonnegative safe integer. Estimate fields are both null or both numeric (signed safe integer offset, nonnegative safe integer RTT). First sample ID is 1 per activation. Maximal legal encoded envelopes, including maximal counters/numbers: **HEARTBEAT 648 B**, **OBSERVATION 545 B**, below unchanged **1024 B**. No media/private metadata/wall-clock date in payloads.

All **nine** application families share burst **32** and refill **8/s**, including both SYNC phases; handshake remains excluded. At 500 ms interval normal traffic is about **2 inbound SYNC/s per participant**, with no bypass bucket or rate increase. The first valid excess application fails application_rate_limit and is not dispatched.

## Scheduling and lifecycle

`ContinuousSyncController` owns zero/one recursive setTimeout, using injected monotonicMs/setTimeout/clearTimeout. It starts only after host paused revision-1 baseline activates authority, continuing while playing or paused. Heartbeat captures current authority/pair/revision/mode, rounded local media position and monotonic time coherently; it never increments revision. Scheduler ownership remains held during synchronous send/reconcile callbacks, preventing duplicate timers.

Ready loss, media replacement/clear/mismatch/error, playback unavailable, peer/channel loss, room leave/end/shutdown, element or activation replacement stop scheduler immediately, clear timing/sequence/drift and restore 1×. Generation ownership makes captured old callbacks/async playback/seek work powerless. Fresh PeerSession recovery resets Ready, requires re-announcement/new explicit Ready/new paused baseline; first heartbeat is sequence 1 with null estimate. Signaling-only reconnect on the same healthy channel preserves timer, samples, estimate, sequence, IDs, revision and correction, without a new scheduler/baseline.

PlaybackSyncController retains preparation, discrete authority, HTMLMediaElement operations and internal seek suppression. Pure math/state is in sync-engine clock.ts/drift.ts. React owns no timing logic and renders conservative static copy without raw timing or 2 Hz live-region announcements. Host transport controls stay accessible.

## Clock model and bounds

Browser monotonic source: **Math.round(performance.now())**, injected once at the adapter boundary. Tests use deterministic clocks. No Date.now, system date/timezone/NTP or envelope sentAt for synchronization.

```text
t1 = host HEARTBEAT capture
t2 = guest HEARTBEAT receive
t3 = guest OBSERVATION send
t4 = host OBSERVATION receive

guestMinusHostOffsetMs = round(((t2 - t1) + (t3 - t4)) / 2)
roundTripMs = round((t4 - t1) - (t3 - t2))
guestClock ≈ hostClock + guestMinusHostOffsetMs
```

Independent vector t1=1000, t2=6050, t3=6070, t4=1120 produces offset **+5000 ms**, RTT **100 ms**. Negative offset, fractional rounding and exact RTT-bound vectors are also fixed independently.

| Bound                    |                Value |
| ------------------------ | -------------------: |
| MAX_SYNC_CLOCK_MS        | 1,000,000,000,000 ms |
| SYNC_MAX_SAMPLE_RTT_MS   |              4000 ms |
| SYNC_MAX_PROJECTION_MS   |              4000 ms |
| SYNC_MAX_PENDING_SAMPLES |                    8 |
| SYNC_CLOCK_SAMPLE_WINDOW |                    8 |

The timestamp ceiling is an arithmetic/resource bound, not a product session lifetime. Host accepts only current activation and pending sequence, bounded integer timestamps, t3≥t2, t4≥t1, finite/safe arithmetic and RTT 0–4000 inclusive. Unknown/pruned/duplicate/stale/invalid/high-RTT observations are ignored, not peer failures or Ready withdrawals. A probe is consumed once even if invalid. Pending stores only sequence/t1 and drops oldest at eight. Valid offset/RTT samples evict oldest at eight; **lowest RTT** in current window supplies the next heartbeat's estimate, a provisional symmetric-delay estimator. Invalid samples preserve previous valid current-cycle estimate. No third message or immediate observation reply.

## Projection and correction

Paused expected position = heartbeat position, independent of clock estimate. Playing projection:

```text
capturedInGuestClock = capturedAtMs + clockOffsetMs
elapsedMs = guestReceivedAtMs - capturedInGuestClock
expectedPositionMs = positionMs + elapsedMs
```

Require safe arithmetic and elapsed 0–4000 inclusive, then clamp to local duration. Missing estimate, negative/excess elapsed or invalid arithmetic means observe/respond without correction. Independent vector position=5000, capture=1000, offset=5000, receive=6200 gives capture-in-guest=6000, elapsed=200, expected=**5200 ms**. No envelope sentAt or guessed RTT/2.

Drift = **guestActual − expectedHost**; negative behind, positive ahead.

| Implementation constant    |  Value |
| -------------------------- | -----: |
| SYNC_HEARTBEAT_INTERVAL_MS | 500 ms |
| DRIFT_SETTLED_MS           |  75 ms |
| DRIFT_RATE_START_MS        | 150 ms |
| DRIFT_HARD_SEEK_MS         | 750 ms |
| PAUSED_DRIFT_SEEK_MS       | 100 ms |
| DRIFT_SPEED_UP_RATE        |   1.05 |
| DRIFT_SLOW_DOWN_RATE       |   0.95 |

Playing absolute drift≤75 normalizes to 1×; normal-rate drift≥150 starts speed up behind/slow down ahead; absolute drift≥750 seeks locally and restores 1×. Existing rate correction continues below 150 until settled≤75, sign crosses (normalize before deciding opposite correction on a later heartbeat), or hard seek. Paused absolute drift≥100 aligns by seek while remaining paused; smaller drift does not seek. Host always remains 1×. New discrete commands immediately normalize guest rate before applying authority. Guest seek correction uses existing internal suppression, emits no command, changes no revision/mode/Ready, and preserves playing/paused mode.

These are **provisional implementation thresholds, not Phase 3D acceptance criteria**. Observations never alter host media/rate/revision/readiness. An authorized malicious guest can falsify cooperative timestamps and sabotage only its own returned estimate/correction. No remote attestation or authentication is inferred from clock data.

## Root and pure verification

`npm ci` passed: **235 packages added**, unchanged optional fsevents install-script policy warning. Full root check passed typecheck, lint, formatting, tests, builds and protocol/sync-engine/signaling built-package smoke checks, including existing source-buffer GC evidence.

| Workspace   | Passed | Failed | Skipped |
| ----------- | -----: | -----: | ------: |
| protocol    |    305 |      0 |       0 |
| sync-engine |    109 |      0 |       0 |
| signaling   |    206 |      0 |       0 |
| web         |    479 |      0 |       0 |
| Total       |   1099 |      0 |       0 |

New suites: protocol SYNC **10 cases**; pure clock/drift **47 cases** (17 clock/sample cases, 10 projection/eligibility cases, 20 drift/hysteresis/convergence cases); continuous browser adapter **25 cases**; PeerSession SYNC **8 cases** plus existing all-family shared-bucket regression extended to nine. All prior identity/readiness/playback vectors and role/sequence/rate regressions pass.

Vectors cover ordering/negative RTT/RTT>4000/unsafe/above-max timestamps; pending unknown/pruned/duplicate/consumed-invalid/reset; RTT100/40/80 selection, window eviction and prior estimate retention; exact projection/invalid/no-estimate, revision7/8/9 and mode eligibility; all required drift boundaries 0/±50/±75/±149/±150/±749/±750, hysteresis/sign crossing, paused99/100 and hard seek. Controller tests cover old H1/G1 against H1/G2 (same media), stale observations with reused sample ID, host unchanged, one guest response/no loops/no echo, command overrides, lifecycle and stale callback cleanup.

Fake-time stress: **10 minutes / 1200 cycles**, interval500 ms, maximum timers **1**, maximum pending **8**, maximum valid samples **8**, monotonically increasing sequence, no production history growth; stop leaves **0 timers**, **0 pending**, **0 samples**, no estimate and sequence reset1. Periodic healthy-channel reports do not duplicate scheduler, including synchronous reconciliation within heartbeat send. Pure fake-media convergence starts at −300/+300 ms, uses ±5% correction in 500 ms steps, reaches ±75 ms and normalizes. This is simulated evidence, not real ten-minute playback qualification.

## Browser verification

All runs use **workers=1, retries=0**. Final serial browser checks use unchanged production/test sources; only documentation results are filled afterward. No failed attempt is counted as passing evidence.

| Run                                                         | Passed | Failed | Skipped | Retries | Duration |
| ----------------------------------------------------------- | -----: | -----: | ------: | ------: | -------- |
| Focused 3C suite, corrected assertion                       |      9 |      0 |       0 |       0 | 41.8 s   |
| Required root `npm run test:e2e -- --workers=1 --retries=0` |     76 |      0 |       0 |       0 | 2.1 min  |
| Focused synchronization scenario, repeat-each=10            |     10 |      0 |       0 |       0 | 55.8 s   |
| Full Chromium serial run 1                                  |     76 |      0 |       0 |       0 | 2.2 min  |
| Full Chromium serial run 2                                  |     76 |      0 |       0 |       0 | 2.1 min  |
| Full Chromium serial run 3                                  |     76 |      0 |       0 |       0 | 2.1 min  |

Installed-Chrome opt-in (`DRIFTLESS_E2E_CHROME=1`) completed: **152 passed / 0 failed / 0 skipped / 0 retries**, **4.3 min**; **76 Chromium + 76 installed Chrome**. All nine 3C scenarios and all existing 3A/3B regressions passed in both projects. Browser versions: Chromium 153.0.8010.12 and installed Chrome 154.0.8037.98.

The nine 3C scenarios cover all twelve required browser behaviors: heartbeat/observation flow and usable estimate (including eight or more heartbeat samples with measured traffic <3/s), small −30 ms drift with 1× and no correction seek, roughly −350/+350 ms drift with 1.05/0.95, +1.5 s local hard seek, paused +500 ms alignment, host position/rate/command isolation, fresh Pause/Seek normalization, stale Cycle-A SYNC with fresh transport sequence and high sample ID, fresh peer reset/rebuild, and signaling-only preservation with usable correction. Exact boundaries/settling remain pure-test evidence. Existing 67 browser tests, including 3A/3B, remain in each 76-test full suite.

The ten-repeat scenario is Ready → paused baseline → Play → usable heartbeat estimate → induced moderate behind drift → 1.05 → host Pause → guest 1×. All ten consecutive executions passed without retry.

Initial focused browser attempt: **8 passed / 1 failed / 0 skipped / 0 retries**, 43.4 s. The signaling-only test captured the last paused revision-1 heartbeat immediately after Play, then compared it with a playing revision-2 heartbeat; it now waits for a playing heartbeat before its preservation snapshot. Corrected focused run and all final full runs above pass. Development check iterations also resolved strict union/lint/format/export and old conceptual-SYNC expectations, normalized rounded negative zero, and fixed a deterministic test that reused an already-observed sample ID. Final unit results above have zero failures/skips.

Exact commands:

```bash
npm ci
npm run check
npm run test:e2e -- --workers=1 --retries=0
npm run test:e2e -- heartbeat-drift.spec.ts --grep 'repeat stability scenario' --repeat-each=10 --workers=1 --retries=0
# Execute this complete suite consecutively three times:
npm run test:e2e -- --project=chromium --workers=1 --retries=0
DRIFTLESS_E2E_CHROME=1 npm run test:e2e -- --workers=1 --retries=0
npm audit
npm audit --omit=dev
```

Local verification logs are outside the repository: `/private/tmp/driftless-3c-check-final2.log`, `driftless-3c-e2e-root.log`, `driftless-3c-repeat10.log`, `driftless-3c-chromium-{1,2,3}.log`, `driftless-3c-optin.log`, and both audit logs. Browser commands use `caffeinate -i` and external trace output directories on this macOS host. No final product acceptance threshold, physical/network or real long-duration qualification is inferred.

## Audit, privacy and scope

`npm audit`: **1 high-severity development dependency vulnerability**, exit1, existing **source-map-js@1.2.1**, [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q), event-loop denial of service through indexed source-map offsets. `npm audit --omit=dev`: **0 vulnerabilities**, exit0. No audit fix or unrelated dependency cleanup. The development advisory remains for dedicated pre-milestone/3D cleanup.

Production synchronization adds only bounded control JSON on the RTCDataChannel, no media transfer or binary sends, no media upload or playback/SYNC WebSocket signaling. SYNC contains no filename/path/MIME/object URL/fingerprint/content root/chunk digest/media byte/wall-clock date/browser exception. No persistence or raw timing history/logging: no localStorage/sessionStorage/IndexedDB/OPFS/Cache Storage/URL state. Browser privacy probes inspect every recorded control send and WebSocket frame: strings only, legal bounded JSON, no private media metadata, no guest authority, no SYNC signaling, no non-GET/HEAD upload, and empty application storage/query/hash. Static scope inspection confirms every new timing occurrence belongs to 3C, no signaling production diff, no transfer-engine diff and no lockfile/dependency churn. `git diff --check` passes; generated build/test artifacts remain ignored or outside the repository.

No transfer-engine/MSE/OPFS/MP4Box production integration/Progressive Watch/chat/reactions/third participant/server-assisted sync/audio/volume/mute manipulation or variable host speed. No Phase 3D qualification, physical Android, different-network, cellular, TURN, final acceptable quality, production quality, long-duration exit gate, Phase 3 CLOSED/PASS or 3C REVIEW PASS.

## Durable status and next step

```text
3A — IMPLEMENTED / REVIEW PASS
3B — IMPLEMENTED / REVIEW PASS
3C — IMPLEMENTED
3D — NEXT / NOT STARTED
Phase 3 exit gate — NOT PASSED
Phase 2 physical/network qualification — DEFERRED / NOT CLOSED
```

Independent GitHub review of the exact pushed Phase 3C commit. Do not begin Phase 3D before review PASS. Commit SHA is supplied by post-commit/push handoff and can be resolved with `git log -1 --format=%H -- docs/PHASE3C_IMPLEMENTATION.md`.
