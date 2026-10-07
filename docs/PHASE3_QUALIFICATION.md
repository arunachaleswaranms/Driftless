# Phase 3 Local Sync Qualification

3A, 3B, 3C — IMPLEMENTED / REVIEW PASS (user-approved independent reviews).
3D — QUALIFICATION IN PROGRESS. Phase 3 exit gate — NOT PASSED.
Phase 2 physical/network qualification — DEFERRED / NOT CLOSED.

Starting local and origin revision, verified clean after fetch/switch/ff-only pull:
`03a19b0e22a13a37f6c4dba20aa7ba187ca134a0` (`feat: add heartbeat and drift correction`).

`QUALIFICATION_SHA`: assigned after the pre-qualification commit. The commit
containing the thresholds and tools is the code candidate; a later documentation-only
commit records its SHA and results, and is not the tested application revision.
No product behavior changes are planned. Any fix requires a new committed SHA,
full regression and requalification of the affected matrix. No PR or merge in 3D.

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

## Qualification matrix before execution

| ID | Requirement | State | Evidence |
| --- | --- | --- | --- |
| Q1 | Exact-build software regression | GAP | Await candidate regression |
| Q2 | Three consecutive full Chromium runs / focused 3C ten-repeat | GAP | Await execution |
| Q3 | Installed Chrome regression | GAP | Await execution |
| Q4 | Physical Android local-file playback | GAP | Await real-device fixture selection/preparation |
| Q5 | Two-real-device same-LAN smoke | GAP | Await physical measurement |
| Q6 | Two-real-device different-network establishment | GAP | USB/topology required |
| Q7 | Selected ICE path on both physical devices | GAP | Await real selected pairs |
| Q8 | Physical paused baseline | GAP | Await physical measurement |
| Q9 | Physical Play/Pause/Seek authority | GAP | Await command matrix |
| Q10 | Continuous physical playing drift | GAP | Await measured distributions |
| Q11 | Physical moderate behind recovery | GAP | Await −350 ms test |
| Q12 | Physical moderate ahead recovery | GAP | Await +350 ms test |
| Q13 | Physical large-drift recovery | GAP | Await ±1.5 s tests |
| Q14 | Physical paused drift recovery | GAP | Await ~500 ms test |
| Q15 | 30-minute physical long run | GAP | Await ≥95% coverage physical run |
| Q16 | Physical no-media-transfer evidence | GAP | Await physical probes and source verification |
| Q17 | Real network interruption/recovery | GAP | Await cellular disruption/restoration |
| Q18 | Fresh physical Ready/baseline after recovery | GAP | Await fresh cycle and heartbeat |
| Q19 | Physical signaling-only behavior | GAP | Exercise if practical; supplemental only |
| Q20 | Physical privacy/storage/error checks | GAP | Await physical probes |

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
