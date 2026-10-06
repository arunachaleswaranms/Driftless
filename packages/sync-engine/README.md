# @driftless/sync-engine

Platform-neutral Local Sync identity, readiness and playback-authority package through Phase 3C. Its only runtime dependency is the internal `@driftless/protocol` workspace. No React, DOM, WebRTC, WebSocket, filesystem, persistence, or external runtime package. Phase 3B adds pure playback authority; Phase 3C adds bounded clock estimation, projection and drift policy. No media transfer.

`src/fingerprint.ts` orchestrates bounded random-access source reads and injected SHA-256; `src/readiness.ts` owns deterministic state/effects; `src/index.ts` exports the public API. `test/` has pure state tests and independent fixed vectors; `scripts/generate-vectors.mjs` is a separate Node crypto oracle, and `scripts/smoke-dist.mjs` checks built exports and garbage collection of source buffers.

Public value exports: `fingerprintMedia`, `FingerprintError`, `initialLocalSyncState`, `reduceLocalSync`, `mediaMatch`, `readinessBlock`, `bothReady`. Public types: `FingerprintFailure`, `FingerprintSource`, `FingerprintOptions`, `Sha256`, `LocalSelection`, `LocalSyncState`, `LocalSyncEvent`, `MatchState`.

The fingerprint accepts a source `{ size, read(start, end) }`, session ID, injected `sha256`, cancellation signal `{ aborted }`, and optional byte-progress callback. It covers every byte sequentially in 4 MiB chunks, retaining one source chunk plus <=128 KiB of digests and a 43-byte header. Empty sources return READ_FAILED; over 4096 chunks / 16 GiB return FILE_TOO_LARGE before reading/allocation. Read/hash failures return READ_FAILED/HASH_FAILED; cancellation returns CANCELLED. It returns only a session-scoped wire fingerprint. Exact binary root/session-domain construction is normative in [PROTOCOL.md](../../docs/PROTOCOL.md#implemented-through-phase-3a-local-sync-setup); no root/chunk digests are exposed or persisted.

The reducer returns `{ state, effects }`; effects are context-free `ApplicationBody` control messages, never file bytes. Select, clear, playback metadata/error, fingerprint/progress/failure, channel, explicit ready/not-ready, and validated receive events update only current local/remote state. Match requires equal byte length and fingerprint; Ready additionally needs local metadata success and current peer match confirmation. Both-ready belongs to that exact pair. Structurally valid obsolete pair messages and local selection completions are ignored. Duplicate MEDIA_INFO with the same selection ID is ignored; changed media must use a fresh ID.

Fresh channels clear remote evidence and both Ready choices, announce current local identity after handshake, and require new explicit Ready choices. Re-reporting the same healthy channel changes nothing (signaling-only recovery). No selection/fingerprint history is retained. Authorized malicious peers can lie: this is cooperative evidence, not attestation or DRM.

Run from the repository root:

```sh
npm ci
npm run check -w @driftless/sync-engine
```

The check covers typecheck, strict lint, formatting, unit tests, build, and built-package import/GC smoke. Build output `dist/` is ignored and must not be committed. [Phase 3A evidence](../../docs/PHASE3A_IMPLEMENTATION.md) establishes only software and same-host development browser behavior, not the Phase 3 physical synchronization exit gate.

## Phase 3B playback authority

`playback.ts` models inactive, waiting-for-baseline and active authority with one current pair, logical revision, mode and referenced position. `playbackReadiness` requires bothReady; `hostPlayback` emits the revision-1 PAUSE baseline or a newer PLAY/PAUSE/SEEK; `guestPlayback` applies only the current reversed pair and fresh revision, beginning with PAUSE revision 1. SEEK preserves mode. Readiness/fresh-peer loss resets authority; the same healthy channel retains it. This discrete module owns no clock, timer, heartbeat, history, acknowledgement or gap repair. Browser preparation, clamping and element events stay in the web adapter. See [3B evidence](../../docs/PHASE3B_IMPLEMENTATION.md).

## Phase 3C clock and drift

`clock.ts` accepts numeric monotonic timestamps for independent NTP-style samples, bounded pending/window state (eight each), lowest-RTT estimation and guest projection. `drift.ts` is a pure correction policy with settled/start/hard-seek/paused-seek thresholds 75/150/750/100 ms and guest rates 1.05/0.95. Clock offset means guestClock ≈ hostClock + offset; drift means guestActual − expectedHost. These provisional implementation constants do not define acceptance quality. The web adapter owns the host's one 500 ms timeout, media correction and lifecycle cleanup. See [3C evidence](../../docs/PHASE3C_IMPLEMENTATION.md).
