# Phase 3 Local Sync Qualification

3A, 3B, 3C — IMPLEMENTED / REVIEW PASS (user-approved independent reviews).
3D — QUALIFICATION NOT CLOSED. Phase 3 exit gate — NOT PASSED.
Phase 3 software qualification — PASS; physical/network qualification — NOT CLOSED.
Phase 2 physical/network qualification — DEFERRED / NOT CLOSED.

Starting local and origin revision, verified clean after fetch/switch/ff-only pull:
`03a19b0e22a13a37f6c4dba20aa7ba187ca134a0` (`feat: add heartbeat and drift correction`).

`QUALIFICATION_SHA` = `778de3a839d468527ad4789ebdc24fda42b06453` (`test: prepare Local Sync qualification`).
Thresholds and tooling were committed/pushed before gate measurement. No production,
test or tooling source changed during collection. The commit
containing the thresholds and tools is the code candidate; a later documentation-only
commit records its SHA and results, and is not the tested application revision.
No product behavior changes are planned. Any fix requires a new committed SHA,
full regression and requalification of the affected matrix. No PR or merge in 3D.

## USB physical qualification prerequisite attempt — 2026-10-08

This later attempt started from clean, synchronized documentation branch HEAD
`160b53df1d620e17e8f810185bb820b2f763593a`. A new clean detached worktree retained
the frozen candidate `778de3a839d468527ad4789ebdc24fda42b06453`; no source, tooling,
lockfile or threshold changed. The earlier [software/GAP summary](evidence/phase3/2026-10-08-summary.json)
is preserved. The new [prerequisite-attempt summary](evidence/phase3/2026-10-08-physical-summary.json)
records safe observations and hashes of raw artifacts kept outside Git.

**USB prerequisite — GAP; physical playback/network testing did not execute.**
After `adb kill-server` / `adb start-server`, `adb devices -l` initially listed
zero devices. Repeated `adb -d get-state` returned exit 1, `error: no devices found`.
At final inspection a wireless `CPH2707` entry was present, but `adb -d` still failed.
Wireless ADB was not used for qualification. USB cable/debugging/RSA authorization,
disabling Wireless debugging and opening phone Chrome were requested; authorized
USB transport was not established. No phone OS/browser inventory through `adb -d`,
USB Chrome CDP, phone fixture provisioning/hash verification or phone playback was
possible. This is an instrumentation/setup GAP, not an observed product FAIL.

Live Mac inventory: MacBook Pro / Mac17,2, macOS 26.6.2 (25G83), installed Chrome
154.0.8037.98; the default route was confirmed Wi-Fi. A dedicated installed-Chrome
profile exposed a usable desktop CDP endpoint. The existing fixture independently
matched **11,976,311 bytes**, SHA-256
`9947f859790ba110f37f0a02909d0fadaa99885fcda6bfa36c1f0a3c72853a67`.
Independent `ffprobe` confirmed **2100 s**, H.264 High/AVC/yuv420p/320×180/30fps
and AAC-LC/48kHz/stereo. Identical phone bytes remain unverified.

The software baseline reproduced: `npm ci`, root check, explicit qualification-tool
tests and exact-revision build PASS. Final verification: protocol **305**, sync-engine
**109**, signaling **206**, web **479** (**1099 workspace tests**), qualification tools
**14**, Chromium **76/76**, zero failures/skips and zero browser retries. Both complete
and production-only audits reported **0 vulnerabilities**. These are software results;
no new desktop soak or physical sample was collected in this attempt.

Public deployment and dual-device smoke were not executed because the phone USB
prerequisite remained unavailable. No cellular/Wi-Fi OFF/non-tethered topology,
physical peer, selected path, baseline/authority, long run, perturbation, genuine
cellular interruption/recovery or physical no-transfer/privacy inspection was observed.
Every mandatory criterion **Q4–Q18/Q20 remains GAP**; optional **Q19 remains
NOT APPLICABLE**. No statistics, recovery times or phone-session internals are inferred.
Phase 2 **G1–G5 remain GAP**, **T1/T2 PASS — software only**, **T3/T4 GAP / DEFERRED**;
`DEFERRED-PHYSICAL-001` through `007` remain OPEN. Compatibility is unchanged.

```text
Phase 3A — IMPLEMENTED / REVIEW PASS
Phase 3B — IMPLEMENTED / REVIEW PASS
Phase 3C — IMPLEMENTED / REVIEW PASS
Phase 3D — QUALIFICATION NOT CLOSED

Phase 3 software qualification — PASS
Phase 3 physical/network qualification — NOT CLOSED
Phase 3 exit gate — NOT PASSED
```

Next required physical action: establish authorized USB `adb -d` and phone Chrome
CDP, then execute the existing exact-candidate physical procedure: same-LAN smoke,
confirmed cellular/Wi-Fi OFF/no tethering, fresh cross-network room, 30-minute run,
authority/corrections, actual cellular disable/restore/fresh Ready cycle and
no-transfer/privacy checks. No milestone PR or merge.

## Phase 3 Local Sync acceptance thresholds

Frozen in the pre-qualification candidate **before qualification measurement**.
These product qualification thresholds are distinct from implementation correction
thresholds. Do not change them to convert a failure to PASS. A justified change
requires a new commit and complete requalification.

| Criterion | Fixed requirement |
| --- | --- |
| Steady playing | At least 30 continuous real minutes; approximately one sample/second |
| Valid measurement coverage | At least 95% of scheduled eligible slots |
| Absolute drift | p95 ≤250 ms; p99 ≤500 ms; maximum ≤750 ms |
| Consecutive drift | At most two consecutive valid steady-state samples >500 ms |
| Warm-up exclusions | 10 s after initial PLAY, host SEEK, fresh recovery/new Ready baseline |
| Drift injection exclusion | From injection only until its fixed recovery deadline; record explicitly |
| Pause / paused Seek | Both paused and difference ≤250 ms within 2 s |
| Paused guest perturbation | Approximately 500 ms; ≤150 ms within 2 s, still paused |
| Moderate guest perturbation | Separately −350 ms and +350 ms; ≤150 ms within 12 s; rate back to 1× within 15 s after convergence |
| Moderate correction | Only guest 1.05× / 0.95×; no guest authority; no Ready withdrawal |
| Large guest perturbation | Separately ±1.5 s; ≤250 ms within 3 s, guest 1× and authoritative playing mode |
| PLAY | Guest playing within 1 s of command receipt in normal connected conditions |
| Host isolation | Host rate always 1×; observations never change host position, revision, Ready or authority |
| Recovery | Fresh usable authenticated peer session within 30 s of genuinely restored connectivity, without reload |
| Recovery reset | Both pause, correction 1×, old heartbeat stops, identity reannounced, both explicitly Ready again, PAUSE revision 1, heartbeat sequence 1/null initial estimate, explicit host Play |
| No transfer | Matching independent local files; bounded control JSON only; no binary media channel, upload, signaling playback/SYNC or media persistence |

Implementation constants remain: heartbeat 500 ms; settled 75 ms; rate start
150 ms; hard seek 750 ms; paused seek 100 ms; guest rates 1.05/0.95;
pending timing probes ≤8; valid sample window ≤8; one heartbeat scheduler.

## Measurement method

`driftMs = guest projected position − host projected position`; negative is
behind, positive ahead. External sampler wraps each browser evaluation with one
sampler's monotonic before/after timestamps and uses their midpoint as observation
time. Read currentTime, paused, playbackRate and browser performance.now(); browser
clock origins are never directly compared. Project both positions to the later
midpoint using paused state and rate. The bounded midpoint uncertainty is recorded.

Reject individual evaluation RTT >100 ms or conservative effective observation
separation (latest after minus earliest before) >200 ms, or invalid/failed
observations. Rejections are retained with reasons and excluded only from drift
statistics. Missing/rejected slots reduce coverage; duplicates cannot increase it.
Exclusions are explicit half-open intervals with a reason, counted as a union;
only those intervals reduce the scheduled coverage denominator. Consecutive valid
high samples are not erased by measurement rejection. Percentiles use nearest rank.
Report valid/rejected/missing/excluded counts, coverage, p50/p95/p99/max,
counts >250/>500/>750 and maximum consecutive >500 ms. Rate observation counts
are not correction-event counts. Count local seek events separately from hard
corrections; do not infer hard corrections from unclassified seek events.

## Required environment and topology

- Device A: development Mac, installed Chrome, Wi-Fi; re-read model/OS/browser.
- Device B: physical OnePlus Nord 5 / CPH2707, installed Chrome; re-read Android/browser.
- Same-LAN smoke: approximately 10 minutes if practical, no cross-network claim.
- Mandatory Internet topology: Mac Wi-Fi + Android cellular, Wi-Fi OFF, no tethering.
  USB ADB/CDP is preferred. Wireless ADB is not proof of cellular topology. Loss of
  the measurement path is a GAP, not numerical physical evidence.
- Both devices confirm the same full `DRIFTLESS_BUILD_REVISION=QUALIFICATION_SHA`.
- Public HTTPS/WSS: established account-free development quick-tunnel procedure,
  exact production HTTPS origin restrictions; **development qualification deployment,
  not production hosting**. No ephemeral hostname/tunnel state in Git.
- Both peers record selected `DIRECT` or `TURN_RELAY`; unresolved `UNKNOWN` is a GAP.
- After initial warm-up, 30 continuous physical playing minutes with no induced
  perturbation in the initial segment, no refresh/reload rescue, then correction
  and command matrix. Network interruption disables Device B cellular long enough
  to observe actual old transport loss, restores it and times recovery. Separately
  exercise a genuine network switch if practical; unavailable switch is GAP.
- Forced public TURN T3/T4 remains separate release debt; DIRECT can satisfy Phase 3.

## Tooling and evidence policy

External-only tools: [tools README](../tools/qualification/phase3/README.md).
No product debug API or synchronization/authority changes. Deterministic fixture
≥35 minutes, MP4/H.264/AAC, low bitrate, independently selected identical bytes.
Generated media and large raw measurements stay outside Git/under ignored local
fixture directories. Evidence records filename, bytes, SHA-256, duration and codecs,
never a local path. Sanitized summaries omit addresses, serials, room IDs, secrets,
SDP/candidates, tunnel hostname and TURN credentials.

Software evidence uses **AUTOMATED SAME-HOST DEVELOPMENT BROWSER EVIDENCE**.
Only actual Mac + phone measurements use **PHYSICAL REAL-DEVICE EVIDENCE**;
only confirmed cellular/Wi-Fi-off uses **REAL CROSS-NETWORK EVIDENCE**.
Software and same-LAN evidence never substitute for the literal physical gate.

## Qualification matrix — 2026-10-08

PASS in Q1–Q3 is software evidence. Q4–Q18/Q20 are physical criteria; none is
replaced by the desktop supplement. Q19 is conditional and was not exercised.

| ID | Requirement | State | Evidence / exact gap |
| --- | --- | --- | --- |
| Q1 | Exact-build software regression | PASS | 1099 workspace tests + 14 qualification-tool tests; root Chromium 76; final verification below |
| Q2 | Full Chromium repeat stability / focused 3C ten-repeat | PASS | Three consecutive 76/76 runs; focused scenario 10/10; one worker, no retry |
| Q3 | Installed Chrome regression | PASS | Opt-in 152/152: Chromium 76 + installed Chrome 76 |
| Q4 | Physical Android local-file playback | GAP | Phone inventoried; fixture selection/preparation/playback and identical bytes not observed |
| Q5 | Two-real-device same-LAN smoke | GAP | No objective dual-device inspection path; phone Chrome CDP socket not exposed |
| Q6 | Two-real-device different-network establishment | GAP | No USB ADB; cellular/Wi-Fi-off/non-tethered topology not confirmed |
| Q7 | Selected ICE path on both physical devices | GAP | No physical peer session; no selected pair on either physical participant |
| Q8 | Physical paused baseline | GAP | No physical Ready pair; software baseline only |
| Q9 | Physical Play/Pause/Seek authority | GAP | No physical command-application timing; existing software authority regressions pass |
| Q10 | Continuous physical playing drift | GAP | No physical samples or distributions; same-host soak is separate |
| Q11 | Physical moderate behind recovery | GAP | No physical −350 ms recovery/deadline measurement |
| Q12 | Physical moderate ahead recovery | GAP | No physical +350 ms recovery/deadline measurement |
| Q13 | Physical large-drift recovery | GAP | No physical ±1.5 s recovery/deadline measurement |
| Q14 | Physical paused drift recovery | GAP | No physical ~500 ms recovery/deadline measurement |
| Q15 | 30-minute physical long run | GAP | No physical long run; 30-minute same-host run cannot substitute |
| Q16 | Physical no-media-transfer evidence | GAP | Source/software probes PASS; physical local selection/control/storage not observed |
| Q17 | Real network interruption/recovery | GAP | No cellular disruption/restoration or usable-session timing; no reload rescue attempted |
| Q18 | Fresh physical Ready/baseline after recovery | GAP | No physical fresh cycle; software reset regressions only |
| Q19 | Physical signaling-only behavior, if exercised | NOT APPLICABLE | Optional physical scenario not exercised because no physical peer session |
| Q20 | Physical privacy/storage/error checks | GAP | Software counters/storage PASS; no phone-session observation |

## Regression and resource procedure

Before candidate commit: npm ci; full root check; root E2E; both audits.
Three complete consecutive Chromium runs, installed Chrome opt-in and ten-repeat
3C scenario, workers=1/retries=0. Test external measurement math. Real same-host
30-minute installed-Chrome media soak supplements physical evidence; never replace
it with fake time. Record heartbeat/observation counts, rates, seek events, errors,
final state, channel/session/object-URL counts and labelled CDP runtime metrics.
Private pending/window/timer bounds are deterministic unit/source evidence unless
externally observable; do not invent physical runtime introspection.

After qualification: root check, root E2E, both audits; then documentation-only
results commit, full diff review, normal push. The code candidate is never amended.
Mandatory physical gaps keep 3D NOT CLOSED and the Phase 3 exit gate NOT PASSED.
Independent review precedes any milestone PR; no Phase 4/5 work.

## Environment, fixture and deployment results

Live inventory on 2026-10-08, without addresses or serial numbers:

| Participant | Environment | Qualification evidence |
| --- | --- | --- |
| Mac | MacBook Pro, Mac17,2, Apple M5; macOS 26.6.2 (25G83); installed Chrome 154.0.8037.98; default route confirmed Wi-Fi | Automated independent contexts on this one Mac; not a two-real-device run |
| Phone | Intended OnePlus Nord 5; ADB manufacturer OnePlus, model CPH2707; Android 16, SDK 36; active Chrome 154.0.8037.126 | Inventory only; wireless ADB, Wi-Fi ON at inspection; no USB transport; no exposed Chrome CDP socket, including after opening Chrome |

USB connection/debugging was requested during the task but not established. At final
inventory the phone was no longer visible to ADB. Mobile data being enabled is not
proof of cellular routing, Wi-Fi OFF or absence of tethering. No cellular/Wi-Fi-off
operation was attempted through a wireless ADB dependency. No phone playback failure
is inferred from unavailable measurement. Same-LAN smoke was GAP because objective
phone inspection was unavailable. No emulator or simulator was counted.

Fixture filename: **synthetic-320x180-35m-h264-aac.mp4**; **11,976,311 bytes**;
**2100 s / 35 minutes**, confirmed by FFmpeg inspection and both desktop video
metadata values. MP4, H.264 High/AVC, yuv420p, 320×180, 30fps; AAC-LC stereo,
48kHz, nominal 32kb/s audio. Encoded single-threaded/bitexact using FFmpeg **6.0**,
synthetic color + 440Hz tone; total inspected bitrate approximately 45kb/s.

```text
SHA-256 = 9947f859790ba110f37f0a02909d0fadaa99885fcda6bfa36c1f0a3c72853a67
```

The MP4 is uncommitted in an ignored local fixture directory. Both desktop contexts
independently select the same local bytes. Phone file delivery/selection and byte
verification were **not observed**. This fixture does not establish representative
large-file Android resource qualification.

Desktop deployment: loopback preview + loopback signaling, development-only, no
public service or ICE server; both diagnostics confirmed the full candidate SHA.
The detached candidate checkout isolated the soak from regression rebuilds. Installed
Chrome ran real media in headless mode, no fake time or artificial drift injection.
The complete browser repeat suite overlapped the early soak on the same Mac.

Physical public deployment: **GAP — not executed** because the phone measurement
prerequisite was unavailable. The established HTTPS/WSS account-free quick-tunnel
procedure remains the next deployment method: **development qualification deployment,
not production hosting**. Production HTTPS-origin restrictions are unchanged.
Physical selected ICE paths: **GAP / not observed** on both devices. The same-host
pair was **DIRECT / DIRECT** and is not real cross-network or TURN evidence.

## Real-duration desktop supplement

**AUTOMATED SAME-HOST DEVELOPMENT BROWSER EVIDENCE — PASS.**
Candidate `778de3a839d468527ad4789ebdc24fda42b06453`, installed Chrome
154.0.8037.98. Ten-second initial Play warm-up preceded the measured **1800-second
continuous playing interval**. Actual sampler completion duration **1800000.141 ms**.
No later transition/injection/recovery exclusion, no reload/refresh or manual rescue.
Warm-up lies before the measured interval and is not silently removed from its
coverage denominator.

| Measurement | Result |
| --- | ---: |
| Valid samples | 1800 |
| Rejected measurement samples | 0 |
| Scheduled eligible slots | 1800 |
| Covered slots | 1798 |
| Missing slots | 2 |
| Coverage | 99.888889% |
| Absolute drift p50 | 0.123666 ms |
| Absolute drift p95 | 0.439396 ms |
| Absolute drift p99 | 1.367625 ms |
| Maximum absolute drift | 8.944499 ms |
| Samples >250 / >500 / >750 ms | 0 / 0 / 0 |
| Maximum consecutive valid >500 ms | 0 |
| Guest 0.95× / 1.05× sample observations | 0 / 0 |
| Guest 1× sample observations | 1800 |
| Observed guest seek events during interval | 0 |
| Classified hard-correction count | Not instrumented; no invented count |

Two additional valid observations occurred in already-covered one-second slots;
all 1800 valid observations enter the percentiles, but duplicates never inflate
coverage. The two unoccupied slots remain visible. No rejected/inconvenient drift
sample was discarded. The sanitized [machine summary](evidence/phase3/2026-10-08-summary.json)
records the exact values and raw-artifact SHA-256. Raw JSON (1,561,815 bytes) remains
outside Git under filename `driftless-3d-soak-30m.json`; it contains no network
identifiers, invite data, filenames/paths from participants or SDP.

Host heartbeat count **3591** through final snapshot (including pre-interval
baseline/warm-up), **3571** during measurement; guest observations likewise **3571**
during measurement, about **1.984/s**. Last heartbeat sequence 3591, revision 2,
playing with a usable clock estimate. One peer connection and one open channel
per participant; no reconnection or Ready cycling during measurement, no guest
PLAY/PAUSE/SEEK, no page/console error, unhandled rejection, media error or
application-rate-limit failure. Both remained playing, host always 1× and guest 1×
at every sample and final snapshot. Both retained their single Ready choice;
host emitted only baseline PAUSE and initial PLAY. No playback command loop.

No runtime introspection of private pending/window/timer state was added.
Deterministic root tests/source verify pending≤8, valid window≤8, one scheduler,
reset cleanup/no history. Observed heartbeat rate is consistent with that scheduler;
it is not a direct count of private timers. One object URL per context, no replacement
or URL accumulation, no media transfer buffer/engine. CDP Performance metrics were
sampled at 30 one-minute checkpoints and are labelled browser/runtime observations,
not a complete memory measurement or an exact acceptance threshold:

| Metric | Host start / last / maximum | Guest start / last / maximum |
| --- | --- | --- |
| JSHeapUsedSize (bytes) | 5484284 / 4696084 / 5810676 | 5119984 / 4736144 / 5497556 |
| Nodes | 916 / 732 / 916 | 878 / 684 / 878 |
| Documents | 20 / 7 / 20 | 20 / 7 / 20 |

These checkpoints show no accumulating trend in those reported metrics. They do
not measure decoder/process/device RAM, CPU/battery or physical Android resources.

## Correction, authority and network outcomes

Existing full software tests reconfirm moderate behind/ahead rate correction, local
large seek, paused alignment, guest no authority, host isolation, command normalization,
fresh peer reset and signaling-only preservation. The required ten-repeat path is
Ready → baseline → Play → estimate → moderate behind drift → 1.05× → host Pause →1×.
These remain implementation regressions on the existing 8-second fixture. They do
not supply the missing physical ±350 ms/±1.5 s/~500 ms deadline measurements or certify
physical Play receipt/application timing. Each physical correction and command
acceptance criterion is explicitly GAP in Q8–Q14.

The physical long run has **zero observed samples**; physical sample coverage,
p50/p95/p99/max, correction counts and deadlines are **GAP / unavailable**, not the
desktop numbers above. Real cellular interruption/restoration, fresh usable-session
≤30 s, both explicit Ready choices, PAUSE revision 1/heartbeat sequence 1/null estimate,
and explicit Play after recovery are **GAP**. Genuine network-switch qualification
is **GAP**. No failure of those product behaviors was observed, and no PASS is inferred
from simulated transport closure or signaling loss. No browser reload rescued a run.

## Privacy and no-transfer outcome

**Software evidence — PASS; physical no-transfer gate — GAP.** Both desktop contexts
selected local copies and matched fingerprints; transfer-engine remains unused/empty.
External probe observed only text control, maximum sizes host **563 B**, guest **506 B**
(below 1024), no binary send, private filename/path/MIME/object URL/root/chunk digest,
playback/SYNC signaling or upload request. Full existing E2E probes additionally
validate strict peer JSON and complete signaling frames. No extra media channel.

Final storage in both contexts: localStorage 0, sessionStorage 0, IndexedDB databases 0,
Cache Storage 0, OPFS entries 0; URL query/hash absent. Source and root tests reconfirm
memory-only readiness IDs and clock samples, bounded timing state/no persisted timing
history, no invite/resume secret or TURN credential in logs/URLs/persistence, and fixed
sanitized browser-error categories. No production `window.*` debug hook was added;
qualification probes are external-only and retain fixed counters/latest safe state.
These observations do not attest a physical phone session that did not occur.

## Audit remediation and software regression

Initial diagnosis: `npm audit` reported exactly one high development advisory,
source-map-js 1.2.1 / GHSA-68fv-2mgg-jv7q; `npm audit --omit=dev` reported 0.
`npm explain` traced it through direct dev toolchains **jsdom 30.1.1** (css-tree 3.2.1)
and **Vite 8.3.1 / Vitest 5.0.2** (PostCSS 8.5.28). Both immediate consumers declare
`source-map-js: ^1.2.1`, accepting patched 1.2.2. `npm outdated` was inspected;
unrelated available updates, including a TypeScript major, were not taken.

`npm update source-map-js --package-lock-only --ignore-scripts` changed only that
package's version/resolved/integrity to 1.2.2. No direct dependency upgrade, override,
force fix, script-policy change or production behavior change. `npm ci` installed 235
packages; its existing optional fsevents script-policy warning is unchanged.
Both complete and production audits now report **0 vulnerabilities**.

| Verification | Passed | Failed | Skipped | Retries |
| --- | ---: | ---: | ---: | ---: |
| Protocol workspace | 305 | 0 | 0 | 0 |
| Sync-engine workspace | 109 | 0 | 0 | 0 |
| Signaling workspace | 206 | 0 | 0 | 0 |
| Web workspace | 479 | 0 | 0 | 0 |
| Workspace total | 1099 | 0 | 0 | 0 |
| Qualification math/probe tests | 14 | 0 | 0 | 0 |
| Pre-candidate root Chromium | 76 | 0 | 0 | 0 |
| Exact candidate Chromium consecutive 1 | 76 | 0 | 0 | 0 |
| Exact candidate Chromium consecutive 2 | 76 | 0 | 0 | 0 |
| Exact candidate Chromium consecutive 3 | 76 | 0 | 0 | 0 |
| Exact candidate Chrome opt-in (76 Chromium + 76 Chrome) | 152 | 0 | 0 | 0 |
| Exact candidate focused 3C ten-repeat | 10 | 0 | 0 | 0 |
| Post-soak exact candidate full root check | 1099 + 14 | 0 | 0 | 0 |
| Post-soak exact candidate Chromium | 76 | 0 | 0 | 0 |

Browser versions read live: Playwright 1.63.0, Chromium **153.0.8010.12**, installed
Chrome **154.0.8037.98**; Node 26.3.0/npm 11.16.0. All browser runs workers 1/retries 0,
no hidden retries. Three full Chromium runs were consecutive, 2.2 min each; Chrome
opt-in 4.3 min; ten-repeat 56.3 s. Root checks include typecheck/lint/format, unit/component/
integration tests, production builds and built-package/source-buffer-release smokes.
Tool tests cover common-epoch projection, paused/rate projection, delay rejection and
boundaries, nearest-rank percentiles, explicit exclusion union, consecutive violations
(including rejected samples), coverage/missing/duplicate slots, PASS/FAIL/GAP, and
idempotent external channel counting.

Pre-candidate instrumentation development caught the constant invite-button label
and repeated browser channel-open events; only tooling was corrected, with a probe
regression. Short five-second smokes are deliberately FAIL for the 30-minute duration
criterion and are not gate evidence. No code fix after the committed candidate and
no failed qualified browser run was hidden. Logs/traces remain outside Git.

## Phase 2 debt and compatibility impact

G1–G5 **GAP**: no physical public HTTPS/WSS, authenticated cross-network join,
real-device channel/handshake, two-peer selected paths or genuine network recovery.
T1/T2 **PASS** for software issuance/credential boundaries only; T3/T4 **GAP /
DEFERRED**, no supplied/configured/verified publicly reachable TURN infrastructure.
No paid service/account provisioned and no local TURN result reused as public relay.
These remain **OPEN release-level debt**. See the new dated section in
[PHASE2_QUALIFICATION.md](PHASE2_QUALIFICATION.md); the 2026-10-04 attempt is retained.

`DEFERRED-PHYSICAL-001` **GAP / OPEN**: no physical local selection/playback, pause/
resume/seeks/lifecycle/error coverage or representative large-file resource evidence.
`002` and `003`–`007` remain OPEN. Local Sync cannot qualify OPFS, MSE, transfer or
Progressive Watch. No compatibility status changes: all existing Local Sync/product
statuses remain unchanged, including Chrome desktop/Android NOT TESTED. Edge,
Firefox, Safari/iOS and Progressive Watch were not qualified.

## Final verdict and remaining physical actions

**Phase 3 implementation — COMPLETE / REVIEW PASS.**
**Phase 3 software qualification — PASS.**
**Phase 3 physical/network qualification — NOT CLOSED.**
**Phase 3 exit gate — NOT PASSED.**

Mandatory missing evidence: two real participants selecting identical bytes on the
same exact build; confirmed Mac Wi-Fi + Android cellular/Wi-Fi OFF/non-tethered
establishment and both selected paths; measured 30-minute physical drift and correction/
command acceptance; real cellular interruption and fresh Ready/baseline recovery;
physical privacy/no-transfer observation. Inventory and desktop playback never satisfy
those requirements. No physical product FAIL is claimed where execution was unavailable.

1. Establish USB ADB and Chrome CDP inspection on the physical phone; confirm live
   device versions and independently verify the fixture bytes. Run physical same-LAN
   smoke, then the established public HTTPS/WSS development qualification deployment.
2. Freeze/reconfirm one exact committed candidate, display its SHA on both devices,
   confirm cellular/Wi-Fi OFF/no tethering and run Q4–Q18/Q20 using the frozen thresholds.
3. Measure ≥30 continuous physical playing minutes, corrections/commands and actual
   cellular disable/restore recovery without reload; collect sanitized path/storage/
   no-transfer evidence. Exercise signaling-only/network switching when practical.
4. Separately supply publicly reachable compatible TURN infrastructure for T3/T4
   forced relay. This remains release debt even if a future DIRECT Phase 3 gate passes.

No milestone PR or merge. Independent qualification review precedes any milestone PR.
The evidence commit changes only docs/sanitized summaries; it is not the application
revision measured above and does not amend `QUALIFICATION_SHA`.

Post-soak full root check, Chromium 76/76 (2.1 min), `npm audit` and
`npm audit --omit=dev` all PASS, with both audits 0 vulnerabilities. Total browser
executions across the required pre-candidate/repeat/opt-in/focused/final runs: **542
passed / 0 failed / 0 skipped / 0 retries**. The separate soak is not included in that
E2E total. Both final commands used the exact candidate build revision.
