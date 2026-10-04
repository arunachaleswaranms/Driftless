# Phase 3A Implementation Evidence

**IMPLEMENTED — Media Identity & Readiness Foundation**, verified 2026-10-04 on `phase/3-local-sync`, based on merged `main` at `2dd7dea8798bcfc742c8902e853cef69c053eecd` (PR #4). No playback synchronization. Independent GitHub review of the pushed commit is next; Phase 3B must not begin before review PASS.

Evidence classification: **AUTOMATED SAME-HOST DEVELOPMENT BROWSER EVIDENCE**. No Android, real external-network, long-duration playback synchronization, or physical qualification claim. Phase 2 implementation is MERGED / COMPLETE; Phase 2 physical/network qualification remains **DEFERRED / NOT CLOSED**, its literal physical gate remains NOT PASSED, and `DEFERRED-PHYSICAL-001` through `007` remain open. Phase 3 is IN PROGRESS; 3A is IMPLEMENTED; 3B is NEXT / NOT STARTED; 3C and 3D are NOT STARTED. The overall Phase 3 exit gate is unchanged and **NOT PASSED**.

## Starting state and environment

The initial working tree contained an unfinished Phase 3A draft on the already-created/published `phase/3-local-sync` branch. Work paused to report that discrepancy; the user authorized continuing that draft. HEAD, local main, origin/main, and the published Phase 3 branch were verified at the exact expected merged base. No Phase 2 history was amended. The old `phase/2-internet-p2p-foundation` branch was already absent locally and remotely; merged-branch inventories required no deletion.

Node `v26.3.0`; npm `11.16.0`; Playwright `1.63.0`; Playwright Chromium `153.0.8010.12`; installed Google Chrome `154.0.8037.97`. Git author remains `Arunachaleswaran M S <arunachaleswaranms@gmail.com>`. No new external runtime dependency; only internal workspace links for `@driftless/sync-engine` and its protocol dependency. The signaling service and transfer engine have no production changes. The master planning DOCX is unchanged.

## Implemented behavior

The application shares one current File selection between the existing native-controls local player and Local Sync setup. The pure sync-engine package owns bounded identity orchestration, current local/remote selection state, comparison, explicit readiness, and deterministic outbound effects. Browser adapters own Web Crypto, File.slice reads, cancellation, and peer integration. The player still owns deterministic object-URL cleanup and stale media-event rejection.

Every selection uses a fresh cryptographically random 16-byte MediaSelectionId, encoded as canonical unpadded base64url (22 characters). Every file byte is read sequentially in 4 MiB chunks; at most one source read/digest runs at a time, including replacement while an obsolete read is draining. The provisional maximum is 4096 chunks / 16 GiB (`17,179,869,184` bytes). Empty files fail READ_FAILED; oversized files fail FILE_TOO_LARGE before allocation/read. Fixed errors also include HASH_FAILED and CANCELLED; replaced/cancelled work cannot publish state or show an obsolete error.

Each chunk is SHA-256 hashed. The content root hashes ASCII `driftless-media-content-v1`, NUL, uint64 big-endian byte length, uint32 big-endian chunk size, uint32 big-endian chunk count, and ordered 32-byte chunk digests. The wire hash is SHA-256 of ASCII `driftless-local-sync-media-v1`, NUL, decoded SessionId bytes, and that content root, encoded as 43-character unpadded base64url. Version 1 is the only algorithm. The browser injects `crypto.subtle.digest("SHA-256", ...)`; an independent Node crypto script supplies fixed vectors. Memory retains at most one 4 MiB source chunk plus the bounded digest manifest (maximum approximately 128 KiB). The content root is 32 bytes; the wire fingerprint is a separate 32-byte SHA-256 output represented as 43 base64url characters. Fixed headers/domain inputs are small, with platform-crypto temporary allocations. No whole-file buffer or retained source chunks.

The five implemented application messages are MEDIA_INFO, MEDIA_MATCH, MEDIA_MISMATCH, READY, and NOT_READY. They are bounded text JSON on `driftless-control`, never signaling. PeerSession injects session/negotiation/sender/recipient context, serializes through the strict shared protocol, uses the same strictly increasing sequence as PEER_HELLO/PEER_READY, accepts/sends application messages only after the crossed handshake, and rejects malformed, binary, wrong-context, duplicate/lower-sequence, or premature messages. Teardown disables application and stale callbacks. MAX_PEER_MESSAGE_BYTES remains 1024; the largest legal Phase 3A envelope is 405 UTF-8 bytes with maximum sequence/timestamp values.

Match requires equal current byte lengths and session-scoped fingerprints. Explicit Ready additionally requires successful local-player metadata and peer confirmation naming that current media pair. Both-ready requires both current READY choices for that pair; no playback action follows. Replacement, clear, playback/fingerprint failure, remote selection change, and fresh channel invalidate dependent readiness. USER withdrawal preserves the peer's independent Ready choice. Structurally valid stale pair messages and local completions are ignored consistently. Duplicate MEDIA_INFO for the same selection ID is ignored; a changed selection must use a fresh ID.

A signaling reconnect with a healthy surviving data channel preserves setup state and emits no duplicate announcement. A fresh recovered PeerSession clears remote evidence/readiness, regenerates current MEDIA_INFO from local truth after handshake, restores comparison without rehashing an unchanged file, and requires both users to Ready again. No old messages or Ready choices are replayed.

Progress stays local, with visible coarse percentages excluded from live announcements. Match, mismatch, and readiness status use a restrained live region and text; Ready/Not Ready are keyboard accessible. No fingerprints or IDs appear in the normal UI. All selections, identities, and Ready state are memory-only; reload starts setup again.

## Root and package verification

`npm ci` passed (235 packages added, 240 audited, zero vulnerabilities). npm reported its existing unapproved optional fsevents install script; no dependency/script policy was changed.

`npm run check` passed with typecheck, strict lint, formatting, tests, production builds, and built-package smoke tests:

| Workspace              | Unit tests | Failed | Skipped |
| ---------------------- | ---------: | -----: | ------: |
| @driftless/protocol    |        274 |      0 |       0 |
| @driftless/sync-engine |         38 |      0 |       0 |
| @driftless/signaling   |        206 |      0 |       0 |
| @driftless/web         |        364 |      0 |       0 |
| Total                  |        882 |      0 |       0 |

Protocol adds 40 tests for canonical identifiers, exact fields, all five messages, bounds, enums, prototype keys, UTF-8 size, and signaling direction rejection. Sync-engine has 19 fingerprint tests and 19 state tests. Independent vectors cover one byte, exactly one chunk, chunk+1, multiple chunks, changes in first/middle/last chunks, and two sessions; empty input is explicitly rejected. Fake sources verify complete byte coverage, bounded single-flight reads, size rejection, cancellation, and safe errors. The built-package GC smoke confirms three source chunk buffers become collectible.

Web adds 34 tests: 17 controller, four Local Sync panel, and 13 PeerSession tests. They include late selection completion, rapid replacement while an obsolete read drains, metadata/error gating, invalidation, both-ready, session changes, fresh peer state, healthy signaling reconnect semantics, handshake ordering, automatic binding, bad context/sequence/binary/type rejection, and callback teardown. Existing Phase 1/2 unit and E2E coverage remains intact.

## Playwright verification

All runs use real signaling, RTCPeerConnection, and RTCDataChannel with two independent browser contexts. **Retries are disabled (`--retries=0`)**. Six new tests cover:

| Phase 3A test                                                                                | Result |
| -------------------------------------------------------------------------------------------- | ------ |
| Same bytes under different filenames; explicit both-ready; no autoplay; withdrawal           | PASS   |
| Different playable bytes under the same filename; mismatch blocks Ready                      | PASS   |
| Replacement invalidates readiness; fresh IDs; matching replacement needs new Ready           | PASS   |
| Clear invalidates readiness; releases video; no empty MEDIA_INFO                             | PASS   |
| Actual data-channel failure; fresh negotiation/handshake; state re-announcement; Ready reset | PASS   |
| Signaling-only disconnect/reconnect; channel, identity, and readiness survive                | PASS   |

Final consecutive repeat and regression results:

| Command (repository root)                                                                                      |                        Passed | Failed | Skipped |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------: | -----: | ------: |
| `npm run test:e2e -- local-sync.spec.ts --grep 'same media matches' --repeat-each=10 --workers=1 --retries=0`  |                            10 |      0 |       0 |
| `npm run test:e2e -- local-sync.spec.ts --grep 'fresh peer recovery' --repeat-each=10 --workers=1 --retries=0` |                            10 |      0 |       0 |
| `npm run test:e2e -- --retries=0` — complete Chromium run 1                                                    |                            56 |      0 |       0 |
| Same command — complete Chromium run 2                                                                         |                            56 |      0 |       0 |
| Same command — complete Chromium run 3                                                                         |                            56 |      0 |       0 |
| `DRIFTLESS_E2E_CHROME=1 npm run test:e2e -- --retries=0`                                                       | 112 (56 Chromium + 56 Chrome) |      0 |       0 |

The three complete Chromium runs were consecutive and serial, followed by the installed-Chrome opt-in run. Each contains the existing 50 Phase 1/2 tests plus six Phase 3A tests. Repeat durations were 22.3 s and 21.8 s; complete Chromium runs were 33.3 s, 34.4 s, and 34.7 s; the combined browser run was 1.1 minutes.

Earlier development attempts are not hidden: one full run had 55 passes / one failure because a Phase 2 test asserted that the newly implemented words "Local Sync" could not appear; that obsolete assertion was updated to verify empty setup and unavailable Ready while retaining its future-feature checks. A later full attempt had 55 passes / one page-navigation HTTP 404 because the root check rebuilt `dist` concurrently with Playwright's preview server. That scheduling mistake was corrected by running verification serially; no product workaround or retries masked it. The required final three consecutive complete runs above all passed.

## Privacy, resource, and scope checks

Browser probes are installed before app startup and forward native operations unchanged. Every observed RTCDataChannel send is a string, parses as bounded control JSON, and fits 1024 UTF-8 bytes; no Blob, ArrayBuffer, or typed-array send occurs. Wire payload checks exclude selected filenames, paths, MIME, object URLs, modification time, content roots, and chunk digests. Signaling contains no Local Sync application messages, selected filenames, or selected media payload. Browser request checks find no upload (only GET/HEAD); storage checks find no persisted identity/readiness. Browser probes observe bounded slice reads and no whole-File arrayBuffer calls; fake-source unit tests are the primary complete bounded-read evidence.

Production inspection confirms local filenames remain only in the existing local UI, object URLs remain in player lifecycle management, and identity data stays in memory. Session-scoped vectors differ for the same bytes in unrelated sessions. Late identity and stale pair evidence cannot restore readiness. No history accumulates, and no source bytes cross the control channel. Fingerprints are cooperative evidence between authorized peers, not DRM or remote attestation; a malicious authorized peer can lie.

`npm audit` and `npm audit --omit=dev` both report **zero vulnerabilities**. No external runtime dependency was added. No new PLAY, PAUSE, SEEK, SYNC, heartbeat, clock offset, drift/correction, playback-rate adjustment, chat/reactions, transfer channels/engine, MSE, OPFS, MP4Box, or Progressive Watch implementation. Existing native video controls remain usable. The three-plane architecture and Phase 3 physical exit gate are unchanged.

## Independent review correction — peer application rate bound

Original Phase 3A commit `087687e17f2b1ed350f0296ecb7ce3c1cf150f20` bounded each message and retained only current identity/readiness state, but had no finite inbound application-message rate bound. Review finding **3A-01** identified an unbounded CPU/event/outbound-response surface from an authorized peer sending valid fresh messages. The original verification totals above remain the original evidence; the correction and its additional verification are recorded here separately.

PeerSession now owns a constant-space inbound token bucket shared by MEDIA_INFO, MEDIA_MATCH, MEDIA_MISMATCH, READY and NOT_READY. `PEER_APPLICATION_RATE_BURST = 32` is both capacity and initial allowance; `PEER_APPLICATION_RATE_PER_SECOND = 8` refills lazily from the existing injected receiver-local millisecond `clock()`. Fractional tokens are retained: `min(32, tokens + elapsedMs * 8 / 1000)`, then subtract one only if at least one is available. No timers, history arrays, dependencies, or outbound scheduler are added. A high-water refill timestamp treats identical/backwards clock readings as zero elapsed and prevents double refill when a backwards clock catches up. Peer `sentAt` never grants tokens.

Enforcement follows parse → current session/negotiation/sender/recipient and strictly increasing sequence validation → handshake-completed check → rate admission → application callback. Normal PEER_HELLO/PEER_READY consume no application tokens. Invalid, wrong-context, replayed or premature traffic still fails as `peer_protocol`, including when no application allowance remains. No wire message, field, fingerprint algorithm/vector, identifier encoding, protocol version, or signaling production behavior changes.

The first valid over-limit application message is not dispatched. Fixed sanitized failure `application_rate_limit` invokes the existing idempotent failure path: detach handlers/callback, close channel/RTCPeerConnection, report failure once to RoomController, and let normal Phase 2C fresh-peer recovery decide the next action. There is no application error reply, silent drop loop, ICE restart or special Local Sync retry. The existing exhaustive failure-text map receives the corresponding fixed explanation. Each recovered PeerSession gets a full fresh burst. Existing channel-loss semantics clear remote identity, peer match, and both Ready choices; local identity remains in memory, is reannounced after the fresh handshake without rehashing, and both users must Ready again.

Added **28 PeerSession unit cases** cover exact burst/handshake exclusion, first overflow, teardown/one failure/no outbound reply/stale callbacks, full-second refill, fractional allowance and refusal below one token, one-hour capacity clamp, identical timestamps, peer timestamp independence, backwards clock and catch-up, all five types sharing one bucket, empty-bucket protocol-error precedence (binary/unknown/malformed/oversize/version/context/sequence/repeated handshake), and a genuinely fresh connection/channel/negotiation resetting allowance. Existing premature-traffic tests remain intact. One RoomController integration case drives a real PeerSession boundary with fakes from both-ready through rate failure, conservative channel-loss state, the normal delayed recovery offer, fresh handshake/reannouncement, re-match, and new Ready choices.

A seventh Local Sync Playwright test injects 33 individually valid sequential READY messages through the peer's real channel using the existing browser probe. It observes the receiver's original channel and connection close, normal recovery status, fresh negotiation/channel, unchanged fingerprint/selection without rehash, readiness reset, and new explicit Ready choices. No production debug hook is introduced. Exact admission math remains authoritative in unit tests; the browser path has already exchanged legitimate setup traffic and is tested for teardown/recovery, not an exact browser-clock threshold. Legitimate setup/mismatch checks count application traffic separately from handshake and assert fewer than **16 messages per peer**, below half the configured burst, without needing any refill.

Documentation cleanup corrects identifier representation comments without changing formats, and distinguishes the **32-byte content root**, the **32-byte wire digest / 43 base64url characters**, approximately **128 KiB maximum digest manifest**, **4 MiB maximum source chunk**, and small fixed headers/domain inputs. This is provisional bounded abuse protection, not general DoS prevention or a product throughput guarantee. Deferred physical/network qualification and the Phase 3 exit gate remain unchanged; Phase 3B remains NOT STARTED pending independent review PASS.

### Correction verification — 2026-10-05

Starting branch/remote HEAD were both exactly `087687e17f2b1ed350f0296ecb7ce3c1cf150f20` with a clean tree after fetch/switch/fast-forward pull. The correction is a separate commit on `phase/3-local-sync`; the original commit is not amended. Environment remains Node `v26.3.0`, npm `11.16.0`, Playwright `1.63.0`, Chromium `153.0.8010.12`, and installed Chrome `154.0.8037.97` (both browser versions checked live).

Focused `npm run test -w @driftless/web -- peerSession` and the direct `src/features/room/peerSession.test.ts` filter each passed **92/92**; `npm run test -w @driftless/web -- roomController` passed **27/27**. Separate protocol and sync-engine regressions passed **274/274** and **38/38** with unchanged fingerprint vectors and wire shapes. Final `npm ci` passed (235 packages added, 240 audited; zero vulnerabilities; the existing optional fsevents script policy warning remains). `npm run check` passed typecheck, strict lint, formatting, tests, production builds, built-package import/service smoke tests and source-buffer release smoke:

| Workspace | Updated unit tests | Failed | Skipped |
| --- | ---: | ---: | ---: |
| @driftless/protocol | 274 | 0 | 0 |
| @driftless/sync-engine | 38 | 0 | 0 |
| @driftless/signaling | 206 | 0 | 0 |
| @driftless/web | 393 | 0 | 0 |
| Total | 911 | 0 | 0 |

The web increase is 28 rate-bound cases and one controller integration case. During development, the first controller test run reached all recovery assertions but failed on an incorrect test cleanup method; typecheck/lint also caught test-only event types, JSON typing, and a void-arrow expression. These were corrected before the final root verification; no production workaround or relaxed check was used. The focused seven-test Local Sync Chromium browser suite passed **7/7**, including the added flood path, with no failures/skips and retries zero. Both `npm audit` and `npm audit --omit=dev` report **0 vulnerabilities**; `package-lock.json` and external dependencies are unchanged.

Final serial stress and full Chromium runs, with **retries = 0** throughout:

| Command (repository root) | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| `npm run test:e2e -- local-sync.spec.ts --grep 'same media matches' --repeat-each=10 --workers=1 --retries=0` | 10 | 0 | 0 |
| `npm run test:e2e -- local-sync.spec.ts --grep 'fresh peer recovery' --repeat-each=10 --workers=1 --retries=0` | 10 | 0 | 0 |
| `npm run test:e2e -- --retries=0` — full Chromium run 1 | 57 | 0 | 0 |
| Same command — full Chromium run 2 | 57 | 0 | 0 |
| Same command — full Chromium run 3 | 57 | 0 | 0 |

The two stress runs took 35.0 s and 33.6 s. The three full Chromium runs were consecutive and serial (1.0 minute, 54.4 s, 54.8 s), each containing all 50 existing Phase 1/2 tests and seven Local Sync tests, including same-media, fresh-peer recovery, signaling reconnect, and application-rate flooding. None needed a retry. This remains same-host development-browser evidence, not physical, external-network or TURN qualification.

`DRIFTLESS_E2E_CHROME=1 npm run test:e2e -- --retries=0` then passed **114/114** (57 Chromium + 57 installed Chrome), **0 failures / 0 skips**, in 1.8 minutes. Both browsers pass the new rate-limit recovery path as well as the existing Local Sync and signaling-reconnect flows. All correction browser runs passed without retries. Generated browser/build artifacts and temporary verification logs are excluded from the commit.

Complete diff review and `git diff --check` pass. The required playback/sync scope search found existing native/player/project-name references and unknown-PLAY rejection fixtures; no new playback synchronization implementation. The only runtime production additions are the PeerSession rate boundary and its fixed failure-text entry; protocol changes are comments only. No PLAY, PAUSE, SEEK, SYNC, heartbeat, clock estimation, drift correction, transfer, MSE, OPFS, or Progressive Watch functionality is added. Next step is independent GitHub re-review of the exact Phase 3A fix commit; Phase 3B must not begin before review PASS.
