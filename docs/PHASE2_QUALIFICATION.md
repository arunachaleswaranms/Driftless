# Phase 2 Qualification — Internet P2P Foundation

## Status

**NOT CLOSED — the 2026-10-08 Phase 3D re-evaluation obtained phone inventory but no physical/cellular establishment or recovery. G1–G5 remain GAP; public forced-relay T3/T4 remain GAP / DEFERRED. The 2026-10-04 attempt is retained below.**

Phase 2 software implementation is **MERGED / COMPLETE / REVIEW PASS** at
`2dd7dea8798bcfc742c8902e853cef69c053eecd` (PR #4). Physical/network qualification
remains **DEFERRED / NOT CLOSED**, literal gate **NOT PASSED**. Phase 3 implementation
is COMPLETE / REVIEW PASS; its physical/network qualification is NOT CLOSED.
No later software or same-host result closes these release-level gates. Historical
2026-10-04 and 2026-10-02 attempts below retain their original facts/status snapshots.

## Phase 3D debt re-evaluation — 2026-10-08

Candidate `778de3a839d468527ad4789ebdc24fda42b06453` (`test: prepare Local Sync
qualification`), built with that exact `DRIFTLESS_BUILD_REVISION`. Full root tests,
serial browser repeats and the real 30-minute same-host Local Sync supplement PASS;
both audits 0 vulnerabilities. See [Phase 3 qualification](PHASE3_QUALIFICATION.md).

Live phone inventory: physical OnePlus CPH2707, Android 16/SDK 36, active
Chrome 154.0.8037.126, wireless ADB and Wi-Fi ON. No USB transport or exposed Chrome
CDP socket; phone absent from ADB at final inspection. Cellular/Wi-Fi OFF/no tethering,
phone public deployment, authenticated cross-network join, physical channel, selected
paths and genuine interruption/recovery were not observed. No physical product failure
is inferred from unavailable instrumentation. No public TURN endpoint configured or
supplied/verified; no paid infrastructure/account or local-relay substitution.

| Criterion | State | New exact-candidate evidence / gap |
| --- | --- | --- |
| G1 | GAP | No public HTTPS/WSS reachability on both physical devices in this attempt |
| G2 | GAP | No authenticated physical different-network create/join |
| G3 | GAP | Only same-host channels; no physical bidirectional handshake |
| G4 | GAP | Same-host DIRECT/DIRECT only; no paths on real cross-network peers |
| G5 | GAP | No genuine phone interruption and usable recovery |
| T1 | PASS | Current full software tests reconfirm authenticated short-lived issuance; no public relay |
| T2 | PASS | Current software tests/source reconfirm no long-lived browser TURN secret/persistence |
| T3 | GAP | No public forced-relay real-device channel; DEFERRED |
| T4 | GAP | No real cross-network TURN_RELAY diagnostics; DEFERRED |

`DEFERRED-PHYSICAL-001` remains OPEN: no physical local selection/playback, pause/
resume/seeks/lifecycle/error and representative large-file resource evidence.
`002` remains OPEN; `003`–`007` remain OPEN. No OPFS/MSE/binary-transfer/Progressive
Watch inference or compatibility change. Phase 2 physical/network qualification
**DEFERRED / NOT CLOSED**, G1–G5 GAP; public TURN T3/T4 **GAP / DEFERRED**, OPEN
release-level debt. A future DIRECT Phase 3 gate may pass without closing T3/T4.

## Latest attempt — 2026-10-04

`QUALIFICATION_SHA` = `3a5922200ab0a77a1dd55d9d911a79a492971874` (`docs: record Phase 2 qualification`), on `phase/2-internet-p2p-foundation`. After fetch, branch selection, and fast-forward-only pull, local and remote HEAD matched this exact SHA and the worktree was clean. No runtime source or repository configuration changed during this attempt.

### Device and network inventory

| Device | Safe facts obtained | Network evidence |
| --- | --- | --- |
| A | Development Mac, model identifier `Mac17,2`; macOS 26.6.2 (25G83); Google Chrome **154.0.8037.97** | Default route uses the Wi-Fi interface. Public smoke exercised Mac Wi-Fi; fixed-broadband service category was not independently established. |
| B | Operator identifies the physical phone as OnePlus Nord 5; ADB reports manufacturer **OnePlus**, model **CPH2707**, Android **16**, SDK **36**; active Google Chrome **154.0.8037.92** (version code 803709204) | ADB transport was **wireless**, state **device**. USB transport was not observed. Cellular operation, Wi-Fi OFF, and absence of tethering have **not been confirmed**. |

The Chrome package also lists a preinstalled system copy, 143.0.7499.192; it is not the active updated application. An Android emulator was present and excluded from qualification evidence. No ADB serial, complete build fingerprint, address, or credential is recorded. The phone's market-name property was empty; the product name above is operator-provided, with the actual model code recorded separately.

### Regression at the latest qualification SHA

macOS 26.6.2, Node.js 26.3.0, npm 11.16.0, from root `npm ci`:

| Check | Result |
| --- | --- |
| `npm ci` | Completed; 234 packages installed. npm reported a pending install-script policy warning for `fsevents@2.3.3`; no policy was changed. |
| `npm run check` | PASS: typecheck, lint, format, unit tests, builds, and both built-package smoke tests. |
| Protocol Vitest | **234 passed**, 0 failed, 0 skipped. |
| Signaling Vitest | **206 passed**, 0 failed, 0 skipped. |
| Web Vitest | **330 passed**, 0 failed, 0 skipped. |
| Phase 0 Node tests (`node --test spikes/phase0/spike-*/src/*.test.mjs`) | **120 passed**, 0 failed, 0 skipped, 0 cancelled. Supplemental regression; no physical gate evidence. |
| Playwright Chromium **153.0.8010.12**, retries 0 | **50 passed**, 0 failed, 0 skipped (46.4 s). |
| Installed-Chrome opt-in, retries 0 | **100 passed**, 0 failed, 0 skipped (1.2 min): 50 Chromium tests plus 50 Google Chrome **154.0.8037.97** tests. |
| `npm audit` | 0 vulnerabilities. |
| `npm audit --omit=dev` | 0 vulnerabilities. |

The initial sandboxed check failed 44 signaling integration tests because loopback listeners were refused with `listen EPERM`; protocol 234 and the other signaling 162 tests passed. The complete check then passed with loopback access allowed. Initial sandboxed audit DNS access failed; both audits completed successfully with network access allowed. These were execution-environment failures, not waived product tests. No intermittent Phase 1 test failed in either completed browser run.

### Exact-build public smoke from Device A

The candidate was rebuilt with `DRIFTLESS_BUILD_REVISION=3a5922200ab0a77a1dd55d9d911a79a492971874` after the regressions. Deployment category: **development Mac behind an account-free Cloudflare quick tunnel**, `cloudflared` 2026.9.3; Vite preview served `apps/web/dist` and forwarded signaling and health to the loopback service. Scratch infrastructure remained outside Git. The service ran in production mode with exactly the tunnel's HTTPS origin allowed, runtime Google's public STUN configured, and **no TURN**. This is not production hosting. The random hostname is omitted.

Installed desktop Chrome verified HTTPS 200, secure context true, the deployment guidance's security headers, `/healthz` 200 with its minimal body, and two WSS connections at `/v1/signaling` without query strings. Two Mac browser contexts created/joined a room and each showed **Peer data channel is connected.** Both diagnostics displayed the exact full candidate SHA, signaling connected, peer connected, ICE connected, channel open, policy All, negotiation 1 of 4, and TURN Not configured. Same-host selected pairs were classified Direct (not relayed), with host / host or host / prflx candidates over UDP. These pairs are **not cross-network G4 evidence**. There were 0 console errors/warnings, 0 page errors, and 0 insecure requests during the HTTPS smoke. Rooms were left after each smoke session.

**HTTP deviation:** a raw HTTP request returned 200 with no redirect. Chrome's HTTP navigation upgraded to HTTPS, even in a fresh browser; therefore this attempt did **not** independently exercise the current build's insecure-context room refusal at the public hostname. The earlier revision's refusal result below is historical only. The development tunnel still differs from the deployment guidance's HTTP redirect requirement.

### Physical and TURN outcome

A visible installed-Chrome Mac host room was prepared with the exact SHA and remained waiting for a guest. Operator confirmation of phone cellular / Wi-Fi-off topology, exact-build diagnostics, and join was requested; none was obtained during this recorded attempt. No phone session, two-real-device handshake, selected candidate pair, or genuine cellular disruption/recovery was observed. No heartbeat or retry value was changed; the known timing limitation remains **not evaluated on a real cross-network interruption**. The host room was left and the host browser, tunnel, preview server, and signaling service were stopped afterwards. No listener remained on the qualification or browser-test ports (8787, 4180, 8790, 4173).

The existing record reports no public TURN host. Available public-host/service details were requested for this attempt, but none were supplied or verified. No host was provisioned, no paid account was created, and no forced-relay deployment or real relay session was attempted. **TURN closure blocked — no publicly reachable TURN infrastructure available to this attempt.** This is an infrastructure gap, not an observed relay failure.

| Criterion | Latest result | Evidence / remaining action |
| --- | --- | --- |
| G1 | **GAP** | Mac HTTPS/WSS passed; phone cellular public reachability unobserved. |
| G2 | **GAP** | No authenticated Mac / physical Android join on distinct networks observed. |
| G3 | **GAP** | Same-host handshake only; real-device channel unobserved. |
| G4 | **GAP** | Same-host direct diagnostics only; selected path on both real cross-network peers required. |
| G5 | **GAP** | Genuine Android network interruption and authenticated recovery unobserved; current post-recovery diagnostics required. |
| T1 | **PASS — software** | Complete protocol/signaling/web regression reconfirmed authenticated short-lived issuance and room-expiry bounds; no public TURN service exercised. |
| T2 | **PASS — software** | Code inspection and complete regression reconfirmed STUN-only build inputs, runtime in-memory TURN credentials, and no long-lived browser TURN secret. |
| T3 | **GAP** | Public TURN endpoint and forced-relay real cross-network channel required. |
| T4 | **GAP** | TURN_RELAY diagnostics on both real relay peers required. |

`DEFERRED-PHYSICAL-002` remains **OPEN**. `001` and `003`–`007` remain **OPEN**. No compatibility status changed. The qualification attempt itself made no closure commit, push, milestone PR, merge, or Phase 3 implementation change. Remaining qualification action: operate the physical phone on cellular with Wi-Fi off against the exact build, collect both devices' establishment and recovery evidence, and provide compatible publicly reachable TURN infrastructure for T3/T4. These gaps are deferred release-level gates; they do not prevent the completed software milestone from being merged after independent PR review.

## Historical evaluation — 2026-10-02

## Scope

Phase 2 — Internet P2P Foundation only: signaling, rooms, WebRTC negotiation, STUN, TURN, the control `RTCDataChannel`, disconnect and reconnect, and diagnostics. No Local Sync, playback synchronization, media transfer, or Progressive Watch behavior exists or was evaluated. No [compatibility](COMPATIBILITY.md) status is changed by this record.

## Exit gate

From [ROADMAP.md](ROADMAP.md):

> Two real devices on different networks establish and recover an authenticated WebRTC data-channel session. Evidence records whether the selected path is direct P2P or TURN relay.

Evaluated as five criteria (G1–G5) plus four Phase 2D TURN criteria (T1–T4) below. All five G criteria are required for the literal gate.

## Evaluated revision

`QUALIFICATION_SHA` = `aeb7f9630d2b3ffa8a12b1ca5a94012b081da859` (`fix: classify a selected pair during connectivity re-checks`), on `phase/2-internet-p2p-foundation`.

| Commit    | Role                                                                                                                                                        |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `df21cad` | Starting point: reviewed Phase 2C (`fix: make reconnecting room leave terminal`).                                                                           |
| `f46616c` | First Phase 2D software candidate (`feat: add WebRTC diagnostics and TURN support`). Superseded: its installed-Chrome regression run found defect D1 below. |
| `aeb7f96` | Fix for D1, with a regression test. The revision built, deployed, and evaluated here.                                                                       |

The deployed bundle was built from the clean committed tree with `DRIFTLESS_BUILD_REVISION=aeb7f9630d2b3ffa8a12b1ca5a94012b081da859`; both browser pages showed exactly that value under **Connection diagnostics → Build**. No source changed during the evaluation.

## Deployment

| Item            | Value                                                                                                                                                                                                                                                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Category        | **Development host behind a third-party TLS tunnel.** Not a production deployment.                                                                                                                                                                                                                                                        |
| Public endpoint | An account-free Cloudflare quick tunnel (`cloudflared` 2026.9.3) with a random `trycloudflare.com` host name, chosen by the operator. TLS is terminated at Cloudflare's edge with Cloudflare's certificate. The host name is not recorded; it no longer exists.                                                                           |
| Origin server   | Vite 8 preview server (a development tool) on a loopback port of Device A's machine, serving the exact build, adding the [DEPLOYMENT.md](DEPLOYMENT.md) response headers, and forwarding `/v1/signaling` (WebSocket) and `/healthz` to the signaling service. A scratch configuration outside the repository; no repository file changed. |
| Signaling       | `services/signaling/dist/main.js` at the same revision, `NODE_ENV=production`, bound to loopback, `SIGNALING_ALLOWED_ORIGINS` = exactly the tunnel's `https` origin. No secret was configured (no TURN).                                                                                                                                  |
| STUN            | Third-party: Google's public STUN service, given to members at run time through `SIGNALING_STUN_URLS` for this test only; not built into the bundle and not a project dependency. Configured 2026-10-02. It was not exercised across networks (no second real device).                                                                    |
| TURN            | **None.** The operator has no publicly reachable host for a TURN server; a TURN server on Device A's machine behind its home NAT would not be reachable from a cellular device.                                                                                                                                                           |
| Duration        | The tunnel, preview server, and signaling service ran only for the smoke test and were stopped afterwards; nothing remained listening.                                                                                                                                                                                                    |

## Devices

| Device | Status                      | Model                                                              | OS                   | Browser                     | Network                                      |
| ------ | --------------------------- | ------------------------------------------------------------------ | -------------------- | --------------------------- | -------------------------------------------- |
| A      | Exercised (smoke test only) | Mac, model identifier `Mac17,2` (as reported by `sysctl hw.model`) | macOS 26.6.2 (25G83) | Google Chrome 154.0.8037.92 | Wi-Fi (default route on the Wi-Fi interface) |
| B      | **Not available**           | OnePlus Nord 5 (expected)                                          | not read             | not read                    | none                                         |

Device B was not available on the qualification date. Its Android and Chrome versions were therefore not read and are not recorded. No emulator, device emulation, second browser profile, or second tab was substituted for it.

## Networks

Only Device A's network (Wi-Fi) was exercised. No second Internet access network was used, so no different-network evidence exists. No public or private address is recorded.

## Deployment smoke test

Run from Device A over its Wi-Fi to the public `https` origin, in Google Chrome 154.0.8037.92 driven by Playwright (fresh profiles), plus `curl` and a Node WebSocket client. These are deployment checks, not gate evidence.

| Check                                 | Result                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `https://<host>/`                     | HTTP/2 200; `Strict-Transport-Security`, `Content-Security-Policy` (with `frame-ancestors 'none'`), `X-Content-Type-Options`, `Referrer-Policy`, and `Permissions-Policy` present; the build's meta CSP present.                                                                                                                                                           |
| `https://<host>/healthz`              | 200, `Cache-Control: no-store`, body exactly `{"status":"ok"}`.                                                                                                                                                                                                                                                                                                            |
| Secure context                        | `window.isSecureContext` true on both pages.                                                                                                                                                                                                                                                                                                                               |
| WSS                                   | Each page opened exactly one `wss:` socket to its own host, path `/v1/signaling`, no query.                                                                                                                                                                                                                                                                                |
| Upgrade policy over the public origin | Allowed origin: opened. Another origin: 403. Any query string: 400. Plain `http` origin: 403.                                                                                                                                                                                                                                                                              |
| Room create and join                  | Two Chrome contexts on Device A: created, joined, "Peer data channel is connected." on both, then both left cleanly.                                                                                                                                                                                                                                                       |
| Diagnostics                           | Build `aeb7f96…`; Path `Direct (not relayed)`, host/host, UDP; TURN configuration `Not configured`; ICE policy `All`; negotiation 1 of 4; no address shown. Same machine: **not path evidence**.                                                                                                                                                                           |
| Console, CSP, mixed content           | 0 console errors or warnings, 0 page errors, 0 cross-origin requests, 0 plain-HTTP requests.                                                                                                                                                                                                                                                                               |
| URL                                   | No room ID or invite secret ever in the page URL.                                                                                                                                                                                                                                                                                                                          |
| Service log                           | Only the fixed event shapes (`server_started`, `connection_*`, `room_created`, `participant_*`, `negotiation_relayed`, `rtc_config_issued` with `turn: "not_configured"`, `upgrade_rejected`, `transport_error`, `room_closed`); no identifier, secret, credential, payload, or client address.                                                                            |
| Plain `http://<host>/`                | **Deviation:** the quick tunnel serves the application over plain HTTP too (200, no redirect), which [DEPLOYMENT.md](DEPLOYMENT.md) forbids for a deployment. The application's own controls held: the page is not a secure context, **Create room** shows "Rooms need a secure connection. Open Driftless over HTTPS to create or join a room.", and no socket is opened. |

## Establishment

**Not evaluated.** No second real device was available, so no room was created and joined across different networks, and no cross-network data channel, handshake, or selected path was observed. The same-machine smoke session above is not establishment evidence.

## Recovery

**Not evaluated.** No genuine network disruption on a real cross-network path was possible without Device B.

### Known limitation: heartbeat detection versus the resume schedule

The Phase 2C limitation — a silently dead path is detected by the service only after one or two 15-second ping intervals, while the browser's resume schedule has about 16 s of delays — was **not evaluated on a real dead path**, and no timing value was changed. What was observed:

- Through this deployment's proxy chain (Cloudflare edge → `cloudflared` → preview server → service), the service's WebSocket protocol pings do reach the client: a client configured never to answer received one ping at 8.9 s after connecting and was terminated by the service at 23.9 s (`transport_error` `liveness_timeout`), its membership entering the reconnect grace period (`participant_disconnected`). The 15–30 s detection horizon therefore holds through this proxy; the proxy does not answer pings on the client's behalf.
- The browser's schedule makes at most eight attempts with 15.75 s of delays. Each attempt waits up to 5 s only when it gets no answer; while the service still holds the old, dead connection as live, each resume is refused at once with `SESSION_UNAVAILABLE`, so the schedule can be exhausted in roughly 16 s plus round trips — before the service's detection at up to 30 s. Stranding after a silent path loss therefore remains plausible. Whether it happens on a real mobile network, and how to tune the ping interval, schedule, attempt timeout, or grace period, still needs real-network evidence.

## TURN

**TURN qualification blocked — no deployable TURN endpoint/credential source available.** No forced-relay run on real devices or networks was possible.

Supplemental evidence (not real-network evidence; same machine, loopback interface; recorded in [PROJECT_STATE.md](../PROJECT_STATE.md#phase-2d--diagnostics--real-network-closure-implemented--qualification-not-closed)): a loopback pion/turn v4.1.4 server using its TURN REST shared-secret handler — the same scheme coturn's `use-auth-secret` implements — accepted credentials issued by the signaling service. With a relay-only build, two Chromium contexts connected and both diagnostics reported `TURN relay` with relay/relay candidates over UDP. With the normal policy and TURN offered, a direct pair won. A credential derived from a mismatched secret did not connect. pion's authentication hook only looks up the key after checking the username's expiry, so acceptance is shown by the relay-only connection succeeding, and refusal by the mismatched-secret connection failing — not by the hook's counts.

## Defects found

- **D1 — selected pair classified `UNKNOWN` during re-checks (fixed in `aeb7f96`).** The installed-Chrome regression of `f46616c` failed one diagnostics browser test: Chrome 154 reported the transport's selected, nominated, working candidate pair as `state: "in-progress"` while a periodic connectivity re-check was outstanding. Sampling a connected pair for 12 s found it `in-progress` in 9 of 1,958 samples in Chrome 154.0.8037.92 and in none of 1,956 in Playwright Chromium 153.0.8010.12; every such sample had `nominated: true` and responses received. The first rule required `succeeded`, so diagnostics could report `UNKNOWN` for a working connection, more often as round-trip times grow. The fix accepts `in-progress` only with at least one connectivity-check response received; `failed`, `waiting`, `frozen`, an absent state, and `in-progress` without responses remain `UNKNOWN`. A unit regression test fails against the old rule.
- **Intermittent Phase 1 test failure (not a Phase 2D change).** In the first full Chromium run at `aeb7f96`, immediately after `npm ci` and the full check, at a load average near 14.5, "keeps local media on the device" timed out after 90 s waiting for the service worker to control the reloaded page. The service worker, its registration, and that test are unchanged since `df21cad`. The test then passed 20 of 20 repetitions at a load average of 13–14, and in four further consecutive full runs and both installed-Chrome runs. Recorded, not waived, and not attributed to Phase 2D; it may be a timing sensitivity of the Phase 1 test under host load.

## Automated results at `aeb7f96`

macOS 26.6.2, Node.js 26.3.0, npm 11.16.0, from `npm ci` at the repository root. Automated evidence is Node, loopback, jsdom, and browser contexts on one machine; it is not device, NAT-traversal, TURN-relay, or real-network evidence.

| Check                                            | Result                                                                                                                                                |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                                  | Pass: typecheck, lint, format, tests, builds, and both built-package smoke tests (the signaling smoke test now includes `RTC_CONFIG` after a resume). |
| `@driftless/protocol`                            | 234 Vitest tests passed, 0 failed, 0 skipped.                                                                                                         |
| `@driftless/signaling`                           | 206 passed, 0 failed, 0 skipped.                                                                                                                      |
| `@driftless/web`                                 | 330 passed, 0 failed, 0 skipped.                                                                                                                      |
| Playwright Chromium 153.0.8010.12, `--retries=0` | Run 1: 49 passed, 1 failed (the intermittent Phase 1 test above). Runs 2–5: 50/50 each — four consecutive clean full runs.                            |
| `DRIFTLESS_E2E_CHROME=1`, `--retries=0`          | Two runs: 100/100 each, adding Google Chrome 154.0.8037.92.                                                                                           |
| `npm audit`, `npm audit --omit=dev`              | 0 vulnerabilities.                                                                                                                                    |
| Servers after runs                               | Nothing left listening on 8790 or 4173.                                                                                                               |

No browser test contacts a public STUN, TURN, or other service.

## Security and privacy

- **HTTPS/WSS:** the public origin served the application over HTTPS and signaling over WSS only; a plain-HTTP page could not create or join a room, and a plain-HTTP origin's upgrade was refused (see the deviation above).
- **No long-lived browser secret:** the bundle contains no TURN credential or secret; the only build-time ICE inputs accept STUN URLs and the `all`/`relay` policy. TURN credentials are issued at run time to authenticated members only.
- **Credential lifetime:** at most `SIGNALING_TURN_CREDENTIAL_TTL_SECONDS` (default 3600 s) and never past the room; not exercised against a deployed TURN server.
- **No raw network data:** diagnostics showed and copied no address, candidate string, SDP, ICE username fragment, or fingerprint; the service log contained no identifier or address of a client.
- **No telemetry:** diagnostics stayed in the browser; no signaling frame carried them.
- **No media:** no media was captured, sent, relayed, or stored; the service handled only signaling messages.

## Limitations and non-claims

- No physical Android device, no second real device, no second Internet access network, and no cellular network were exercised. Nothing here is Android, cross-network, NAT-traversal, carrier, or recovery evidence.
- The deployment was a development host behind a third-party tunnel, not a production deployment: the origin was a development preview server, TLS was Cloudflare's, plain HTTP was also served, and the signaling service ran on Device A's machine. In such a topology a network disruption of Device A's machine would also disrupt signaling, so a future recovery test on it must disrupt the other device's network only.
- No TURN server was deployed; T3 and T4 have only supplemental loopback evidence.
- The third-party STUN service was configured but not exercised across networks.
- No compatibility status changes. No `DEFERRED-PHYSICAL` debt is closed.

## Historical gate matrix — 2026-10-02

| Criterion | Requirement                                                                | Result  | Evidence                                                                       |
| --------- | -------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------ |
| G1        | Public HTTPS/WSS signaling reachable by both real devices                  | **GAP** | Public HTTPS/WSS verified from Device A over Wi-Fi only; Device B unavailable. |
| G2        | Authenticated room create and join across different networks               | **GAP** | No second real device or network.                                              |
| G3        | Ordered, reliable `RTCDataChannel` opens; bidirectional handshake          | **GAP** | Same-machine only.                                                             |
| G4        | Diagnostics prove `DIRECT` or `TURN_RELAY` on a real cross-network session | **GAP** | Same-machine host/host only.                                                   |
| G5        | Genuine real-network disruption, then recovery per Phase 2 semantics       | **GAP** | Not possible without Device B.                                                 |

## Historical TURN matrix — 2026-10-02

| Criterion | Requirement                                   | Result   | Evidence                                                                                                                                                                                                                                                                          |
| --------- | --------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1        | Secure short-lived credential issuance exists | **PASS** | Implemented at `aeb7f96`: authenticated-member-only issuance, derived TURN REST credentials, lifetime capped by the room, secret from file or environment, sanitized logs; unit, loopback, and supplemental loopback-TURN evidence. Not exercised against a deployed TURN server. |
| T2        | No long-lived browser secret exists           | **PASS** | The bundle carries no TURN credential or secret; build-time ICE inputs are STUN-only and the policy; credentials arrive at run time, in memory.                                                                                                                                   |
| T3        | Forced relay establishes a real data channel  | **GAP**  | No publicly reachable TURN endpoint; loopback supplemental evidence only.                                                                                                                                                                                                         |
| T4        | Diagnostics confirm `TURN_RELAY`              | **GAP**  | Loopback supplemental evidence only.                                                                                                                                                                                                                                              |

## Blocking findings

Current blockers as of 2026-10-04 remain blockers to physical/network qualification and final product/release qualification. Administrative closure of the software implementation milestone does not reduce their severity or satisfy them.

1. Physical Android was identified, but cellular / Wi-Fi-off cross-network operation was not executed.
2. Real-device RTCDataChannel establishment was not observed.
3. Genuine real-network recovery was not exercised; the heartbeat/retry timing limitation remains unqualified.
4. The selected path from a real cross-network connection was not observed on either real peer.
5. No publicly reachable TURN endpoint was available for T3/T4; both remain **GAP / DEFERRED**. Local pion/turn remains supplemental software evidence only.

| ID  | Requirement                                         | Gap                                                          | Required next action                                                                                                                                                                                                                                  |
| --- | --------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | Two real devices on different networks (G1–G5)      | Physical OnePlus Nord 5 identified on 2026-10-04, but cellular / Wi-Fi-off session, real-device channel, and selected path unobserved. | With the phone on cellular data (Wi-Fi off) and Device A on Wi-Fi, redeploy one exact committed revision, confirm both builds and device versions, and run the establishment and recovery procedure below. |
| B2  | TURN forced relay on real networks (T3, T4)         | No publicly reachable host for a TURN server.                | Provide a host with a public IP (and TLS certificate for `turns:`), deploy coturn with `use-auth-secret` per [DEPLOYMENT.md](DEPLOYMENT.md), configure the same secret on the service, and run a relay-only qualification build on a separate origin. |
| B3  | Recovery evidence and the heartbeat limitation (G5) | Real-device interruption and recovery not exercised; same-host automation does not qualify the timing limitation. | Disrupt Device B's network only (mobile data off and on, then a network switch), record signaling and peer behavior, the post-recovery path, and whether resume was stranded before the service's liveness detection. |

## Procedure for the next qualification

1. Build and deploy one committed SHA with `DRIFTLESS_BUILD_REVISION` set; confirm **Build** on both devices.
2. Run the [deployment smoke test](DEPLOYMENT.md#deployment-smoke-test) from both devices.
3. Device A: the Mac in desktop Chrome on Wi-Fi. Device B: the OnePlus Nord 5 in Chrome on cellular data, Wi-Fi off, not tethered to Device A. Read model, OS, and browser versions on each device.
4. ICE policy `all`: A creates, B joins; both connected; copy both diagnostics. Record `DIRECT`, `TURN_RELAY`, or `UNKNOWN` as reported.
5. With TURN: repeat with the relay-only build; both diagnostics must say `TURN_RELAY` with relay candidates.
6. Disrupt Device B's network; observe recovery; copy fresh diagnostics on both.
7. Record results here in a documentation-only commit naming the evaluated SHA. Any code fix requires a new commit and a new run.

## Deferred physical debt

`DEFERRED-PHYSICAL-002` (two real peers on genuinely separate Internet networks, including a physical Android participant, with the selected direct or relay path recorded) is **not satisfied** and remains **OPEN**. `DEFERRED-PHYSICAL-001` and `003`–`007` remain **OPEN**; none was evaluated.

## Current conclusion — 2026-10-04

**Physical/network qualification: DEFERRED / NOT CLOSED.** The physical phone's model, Android, and active Chrome version were obtained. Automated regressions and the Mac exact-build public smoke passed. Actual cellular / Wi-Fi-off establishment, selected path on both real devices, and genuine network recovery remain unobserved (G1–G5 GAP); public forced-relay evidence remains unavailable (T3/T4 GAP / DEFERRED; T1/T2 software PASS). Phase 2 software implementation is **COMPLETE / READY TO MERGE**; its literal physical exit gate is **NOT PASSED**. Phase 3 is **NEXT / NOT STARTED**, and may begin only after the implementation milestone merge. Deferred qualification remains mandatory before final product/release closure.
