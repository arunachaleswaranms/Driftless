# Phase 3A Implementation Evidence

**IMPLEMENTED — Media Identity & Readiness Foundation**, verified 2026-10-04 on `phase/3-local-sync`, based on merged `main` at `2dd7dea8798bcfc742c8902e853cef69c053eecd` (PR #4). No playback synchronization. Independent GitHub review of the pushed commit is next; Phase 3B must not begin before review PASS.

Evidence classification: **AUTOMATED SAME-HOST DEVELOPMENT BROWSER EVIDENCE**. No Android, real external-network, long-duration playback synchronization, or physical qualification claim. Phase 2 implementation is MERGED / COMPLETE; Phase 2 physical/network qualification remains **DEFERRED / NOT CLOSED**, its literal physical gate remains NOT PASSED, and `DEFERRED-PHYSICAL-001` through `007` remain open. Phase 3 is IN PROGRESS; 3A is IMPLEMENTED; 3B is NEXT / NOT STARTED; 3C and 3D are NOT STARTED. The overall Phase 3 exit gate is unchanged and **NOT PASSED**.

## Starting state and environment

The initial working tree contained an unfinished Phase 3A draft on the already-created/published `phase/3-local-sync` branch. Work paused to report that discrepancy; the user authorized continuing that draft. HEAD, local main, origin/main, and the published Phase 3 branch were verified at the exact expected merged base. No Phase 2 history was amended. The old `phase/2-internet-p2p-foundation` branch was already absent locally and remotely; merged-branch inventories required no deletion.

Node `v26.3.0`; npm `11.16.0`; Playwright `1.63.0`; Playwright Chromium `153.0.8010.12`; installed Google Chrome `154.0.8037.97`. Git author remains `Arunachaleswaran M S <arunachaleswaranms@gmail.com>`. No new external runtime dependency; only internal workspace links for `@driftless/sync-engine` and its protocol dependency. The signaling service and transfer engine have no production changes. The master planning DOCX is unchanged.

## Implemented behavior

The application shares one current File selection between the existing native-controls local player and Local Sync setup. The pure sync-engine package owns bounded identity orchestration, current local/remote selection state, comparison, explicit readiness, and deterministic outbound effects. Browser adapters own Web Crypto, File.slice reads, cancellation, and peer integration. The player still owns deterministic object-URL cleanup and stale media-event rejection.

Every selection uses a fresh cryptographically random 16-byte MediaSelectionId, encoded as canonical unpadded base64url (22 characters). Every file byte is read sequentially in 4 MiB chunks; at most one source read/digest runs at a time, including replacement while an obsolete read is draining. The provisional maximum is 4096 chunks / 16 GiB (`17,179,869,184` bytes). Empty files fail READ_FAILED; oversized files fail FILE_TOO_LARGE before allocation/read. Fixed errors also include HASH_FAILED and CANCELLED; replaced/cancelled work cannot publish state or show an obsolete error.

Each chunk is SHA-256 hashed. The content root hashes ASCII `driftless-media-content-v1`, NUL, uint64 big-endian byte length, uint32 big-endian chunk size, uint32 big-endian chunk count, and ordered 32-byte chunk digests. The wire hash is SHA-256 of ASCII `driftless-local-sync-media-v1`, NUL, decoded SessionId bytes, and that content root, encoded as 43-character unpadded base64url. Version 1 is the only algorithm. The browser injects `crypto.subtle.digest("SHA-256", ...)`; an independent Node crypto script supplies fixed vectors. Memory retains at most one 4 MiB source chunk plus the bounded 128 KiB digest manifest and 43-byte root header, with platform-crypto temporary allocations. No whole-file buffer or retained source chunks.

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
