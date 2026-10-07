# Media Pipeline

## Status

This document defines the intended media-flow boundaries for Driftless. Phase 1 local playback and Local Sync identity/readiness plus host command synchronization through Phase 3C include heartbeat, clock observation, drift detection and guest correction. The production Progressive Watch pipeline remains future work. MP4Box.js, Media Source Extensions (MSE), and Origin Private File System (OPFS) are Phase 0 and Phase 5 feasibility items rather than proven implementation choices. Laboratory observations from Spikes 0.5, 0.6, and 0.7 are recorded separately below. They do not change the planned behavior below.

## Mode A - Local Sync

In Local Sync, each participant selects a local copy of the same media. The browser plays each participant's own file. Driftless exchanges identity evidence and control/state messages, never media bytes.

```text
Host local file  --> host HTML5 video ----+
                                           +--> synchronization plane
Guest local file --> guest HTML5 video ---+    (state and controls only)
```

Implemented through Phase 3C:

1. Select a local file using the existing player/input; wait for successful browser metadata loading.
2. Generate a fresh random selection ID and hash **every byte** sequentially with one 4 MiB slice/read/digest active at a time. Refuse empty files and files above 4096 chunks (16 GiB, provisional).
3. Derive a session-scoped fingerprint using the canonical algorithm in [PROTOCOL.md](PROTOCOL.md#implemented-through-phase-3a-local-sync-setup). Exchange only bounded identity evidence on the sync plane: no media bytes, filename, MIME, path, object URL, private root, or chunk digests.
4. Compare fingerprints and byte lengths, confirm the current media pair, and require an explicit Ready choice from each user. Ready prepares the element without moving its saved position or starting synchronized playback. Both-ready begins a paused host-position baseline at revision 1.
5. Apply host Play/Pause/Seek; periodic SYNC reports current authority without advancing revision. Guest projection/correction follows the exact readiness pair and applied revision/mode.
6. Cancel obsolete identity work and invalidate readiness on replacement, clear, errors, remote changes, or fresh peer recovery. Reannounce current truth after a fresh handshake; both users must Ready again. Signaling-only reconnect preserves a healthy channel's setup state.

Phase 1 playback itself binds File → object URL → native video and performs no application-level whole-file read. Phase 3A identity intentionally adds a bounded sequential full-file read; it never materializes or uploads the entire file. Progress stays local, errors are fixed categories, and no identity/readiness state is persisted.

Phase 3B applies host Play, Pause, and committed Seek with current-pair binding and monotonic revisions. Position is integer milliseconds, safely clamped to local finite duration. Phase 3C adds monotonic clock estimation and guest-only compensation; no media transfer. Readiness loss pauses; fresh peer recovery requires new Ready choices and a fresh paused baseline; signaling-only recovery preserves active playback. An active cycle emits host heartbeats every 500 ms, returns guest observations, estimates clock offset from a bounded lowest-RTT window, detects drift and applies temporary guest rate correction or local hard seek. Phase 3D has frozen acceptance thresholds and passed software/long-duration same-host checks; physical-device and real-network qualification remains NOT CLOSED. See [PHASE3_QUALIFICATION.md](PHASE3_QUALIFICATION.md). Provisional implementation thresholds do not pass acceptance gates. Local Sync must work independently of transfer-engine, MSE, segmentation, and cache support.

## Mode B - Progressive Watch

In Progressive Watch, the host has a compatible local file and the receiver does not. The receiver should be able to start after a sufficient initial playable range arrives, rather than waiting for the full file.

### Host Pipeline

```text
local file
    |
    v
compatibility inspection
    |
    v
MP4 parsing
    |
    v
media segmentation
    |
    v
transport fragmentation
    |
    v
RTCDataChannel
```

The host is expected to:

- Confirm that the file's container, tracks, codecs, and structure fit the negotiated target.
- Extract only metadata needed for playback planning, transfer, and integrity checks.
- Produce or identify MSE-usable initialization and media segments.
- Divide transfer work into bounded transport chunks.
- Respect data-channel backpressure rather than enqueueing the whole file.
- Prioritize startup and seek-critical ranges over speculative future ranges.
- Retain enough transfer state to resume safely after an eligible reconnect.

MP4Box.js is a candidate for MP4 inspection and fragmentation. It is not selected until feasibility, maintenance, security, performance, and browser behavior are evaluated.

### Receiver Pipeline

```text
RTCDataChannel
    |
    v
transport reassembly
    |
    v
integrity and order handling
    |
    v
local cache
    |
    v
media segment availability
    |
    v
Media Source Extensions
    |
    v
HTML5 video
```

The receiver is expected to:

- Validate transfer framing and enforce allocation limits before accepting data.
- Reassemble chunks by transfer, media segment, offset, and declared length.
- Detect missing, duplicate, overlapping, or inconsistent data.
- Verify required integrity evidence before promoting data for playback.
- Track complete media segments separately from partially received chunks.
- Store data according to an explicit memory/disk/cache policy.
- Append valid segments to MSE in a legal order and handle MSE errors.
- Report available buffered ranges and playback demand to the sender.

MSE is the planned playback integration where supported. Its codec, append, quota, eviction, and mobile behavior must be measured; support is not assumed from API presence alone.

## Media Segment vs. Transport Chunk

A **media segment** is a container-level unit intended for decoding and playback, such as an initialization segment or fragmented MP4 media segment. Its boundaries are determined by media structure and playback needs.

A **transport chunk** is a bounded network delivery unit used to carry part or all of a media segment over the data channel. Its boundaries are determined by transport behavior, memory limits, acknowledgement strategy, and measured performance.

```text
media segment 17
+----------------------+----------------------+---------+
| transport chunk A    | transport chunk B    | chunk C |
+----------------------+----------------------+---------+
```

The terms are not interchangeable. A received chunk is not automatically playable. Chunk size will not be chosen until benchmarking establishes safe behavior across target devices and network paths.

## Buffer Management

The planned buffer manager coordinates playback demand without owning playback authority. It tracks:

- Complete and partial local ranges.
- MSE-appended and browser-reported buffered ranges.
- The current playhead and pending seek target.
- Startup readiness and risk of near-term underrun.
- In-flight, missing, verified, and evictable data.
- Memory, storage, and data-channel pressure.

Its scheduler should prioritize an initialization segment, the startup range, the range immediately ahead of playback, and then future ranges. Thresholds for startup, low-water, high-water, and prefetch are deliberately unspecified until testing provides evidence. Buffer state is advisory to transfer scheduling and must not grant host playback authority.

## Seek Prioritization

When the host performs a seek or the guest needs an unbuffered authoritative position:

1. Map the target time to the required decodable media range, including initialization and dependency data.
2. Elevate required segments ahead of obsolete sequential prefetch.
3. Cancel, pause, or deprioritize work that is no longer useful, without corrupting resumable state.
4. Reassemble and verify the new range.
5. Append it through a legal MSE sequence and report readiness.
6. Resume forward buffering from the new position.

The exact keyframe, fragment, and append-window strategy depends on the selected fragmentation approach and must be proven in spikes.

## Spike 0.5 Observations (MP4 Parsing and Segmentation)

These observations come from `AUTOMATED DESKTOP` evidence: MP4Box.js 2.4.1, headless Chrome 153 and Node.js 26 on macOS, and synthetic media only. See the [Spike 0.5 result record](../spikes/phase0/results/spike-05-mp4-segmentation.md). They inform later design but are not production decisions, and physical Android behavior is unqualified.

### Observed in Spike 0.5

- **Parsing.** A non-fragmented MP4 can be parsed through bounded `File.slice()` reads that follow MP4Box.js's `appendBuffer()` next-offset hints. When `moov` is after `mdat`, the parser skips the `mdat` and asks for the `moov` directly. A 4.53 GB, 90-minute file had metadata after 7 reads and 7.0 MB, with no sequential pass.
- **Layout detection.** A header-only top-level box scan detects `moov` placement, fragmentation, and 64-bit box sizes in 3–64 reads of ≤ 16 bytes each.
- **Initialization segments.** MP4Box.js `initializeSegmentation()` produced a structurally valid init segment (`ftyp` + `moov` with `mvex`/`trex` and empty sample tables) for H.264 + AAC tracks. MSE acceptance was not tested.
- **Built-in segmentation.** In MP4Box.js 2.4.1, built-in segmentation (`onSegment`, `rapAlignement: true`) ends each video segment on a keyframe instead of starting the next segment with it. As a result, every segment after the first begins with a non-sync sample. The same `nbSamples` must be used for every track, and segment boundaries after `seek()` do not match the boundaries of a sequential run.
- **Planned segmentation.** A deterministic plan built from the `moov` sample tables alone, cut with `ISOFile.createFragment()`, produced keyframe-aligned, time-aligned video and audio segments. Any single planned segment could be generated from the `moov` plus one bounded source window. On the 4.53 GB file, the segment at 45:00 needed 8.7 MB of reads. It was byte-identical to the same segment produced sequentially.
- **Memory.**
  - MP4Box.js retained ≤ 6.3 MB of source data during full passes over the 4.53 GB file at 1 MiB blocks.
  - Expanding the sample tables cost about 343 B of JS heap per sample, which was 142 MB for 415,260 samples.
- **Buffer pinning.** Unselected tracks pin every source buffer unless they are drained.
- **Fragmented sources.** An already fragmented source made MP4Box.js retain the whole file plus an `mdat` copy. Its sample index was only partial at `onReady`.

### Planned Production Behavior (Unchanged, Pending Later Evidence)

The pipeline above remains the plan. No segment duration, block size, parser integration, or index representation has been selected. The observations point toward:

- deriving segment boundaries deterministically from the sample index rather than from sequential parser state;
- a compact sample index;
- explicit handling of fragmented sources and non-target tracks.

These still require production design review and target-device qualification. Spike 0.6 supplied controlled desktop MSE evidence below.

## Spike 0.6 Observations (MSE Progressive Playback)

These observations come from `AUTOMATED DESKTOP` evidence: Chrome 153 on macOS (headless, plus one headed smoke run), with audio muted at the browser level, synthetic media only, and local media paced by a deterministic arrival simulator rather than a network. See the [Spike 0.6 result record](../spikes/phase0/results/spike-06-mse-progressive.md). They inform later design but are not production decisions. Android, other browsers, and real-world media are unqualified.

### Observed in Spike 0.6

- **Progressive start.** Playback began from an initial buffer of 2 planned segments and continued as further segments arrived. On a 4.53 GB, 90-minute `moov`-last file, playback began when 0.31 % of the file had been read.
- **Segment consumption.** The Spike 0.5 planned segments (one `traf` per `moof`, per track) were appended unchanged. Both SourceBuffer layouts worked:
  - one muxed SourceBuffer with the combined init segment;
  - separate video and audio SourceBuffers with MP4Box.js per-track init segments.

  A muxed SourceBuffer reports the intersection of its tracks, so a segment becomes playable only when both of its fragments have been appended.
- **Append discipline.** Appends were serialised on `updating`/`updateend` per SourceBuffer. An invalid segment fired `error` and then `updateend`, ended the MediaSource with a decode error, and failed the queue closed.
- **Initialization.**
  - The init segment's `updateend` fires before `loadedmetadata`.
  - MP4Box.js init segments for non-fragmented sources carry no duration (`Infinity` until `duration` is set).
  - `endOfStream()` resets the duration to the highest buffered end.
- **Timestamps.** Chrome applied the source edit lists (`elst` `media_time`) in MSE, so both tracks start at 0. Default `appendWindowStart` trimmed audio that would have fallen before 0. A full sequential append of 76 segments kept one contiguous range ending at [0, 300.000].
- **Random access.** A fragment that does not start on a keyframe raised no error. Frames up to its first keyframe were silently dropped, and a fragment with no keyframe buffered nothing. Keyframe-aligned segments buffered from their start.
- **Buffering and underrun.** Buffer ahead grew to the lookahead cap when delivery exceeded playback. With delivery slower than playback, each underrun fired `waiting` (never `stalled`), and playback resumed within about 10 ms of the next append's `updateend`.
- **Seeking.**
  - A seek inside the buffered range needed no action.
  - A seek outside it needed reprioritisation. Mapping the target to its planned segment (whose start is the preceding keyframe) and appending that segment next was enough: no `abort()`, `remove()`, init re-append, `changeType()`, or `timestampOffset` change. Disjoint buffered ranges coexisted.
  - Naive sequential delivery left a far seek pending.
  - `abort()` of an in-flight append discarded it cleanly, and later appends needed no new init segment.
  - Rapid successive unbuffered seeks routinely supersede segment preparation that is queued or in progress. Superseded work must be treated as cancellation, with delivery re-targeted to the latest seek, not as a pipeline failure. Only genuine preparation errors are fatal.
- **Quota.** Appending far ahead with no cap reached `QuotaExceededError` after about 159 MB (190 s of 720p media) in this headless profile. Chrome evicted nothing ahead of the playhead, and appends resumed only after playback advanced, when Chrome evicted played media.
- **Lifecycle.**
  - A tab that had never been shown did not open its MediaSource until it was shown.
  - A playing session in a hidden tab kept playing and appending over 10 s.
  - `pagehide` teardown released every pipeline resource.

### Planned Production Behavior (Unchanged, Pending Later Evidence)

The receiver pipeline and buffer management above remain the plan. No startup, low-water, high-water, lookahead, or quota threshold has been selected, and no SourceBuffer layout has been chosen. The observations point toward:

- keeping keyframe-aligned segments and independent verification, because misalignment fails silently;
- a buffer manager that reprioritises to the playhead or seek target, cancels work superseded by a newer seek without failing, and treats `QuotaExceededError` as backpressure;
- explicit handling of receivers in background or never-shown tabs;
- verifying edit-list and timeline behavior on other browsers before relying on it for synchronization.

These still require design review and physical Android qualification. Spike 0.7 provides controlled-desktop integration evidence below.

## Spike 0.7 Observations (P2P Progressive Watch)

### Observed in Phase 0

In `AUTOMATED DESKTOP / CONTROLLED NETWORK` Chrome 153 on one macOS host, two same-origin tabs connected by a host/host UDP WebRTC path. The receiver did not select a file. The host incrementally indexed an ignored synthetic 110,544,641 B, 300 s MP4/H.264/AAC source, sent separate verified init and keyframe-aligned media fragments as bounded RTCDataChannel chunks, and waited for each receiver append acknowledgment. See the [Spike 0.7 result record](../spikes/phase0/results/spike-07-p2p-progressive.md).

- **Early playback:** the receiver's real `playing` event occurred after 2 of 76 planned segments, 3,218,827 B including init (2.911789% of source size), with 8.730701 s buffered. Frames and `currentTime` advanced while later binary fragments arrived.
- **Pressure and pacing:** the sender's event-driven data-channel queue stayed below its 512 KiB high-water mark plus one frame. Buffer feedback stopped scheduling when ahead approached an experimental 20 s cap. Deliberate constrained pacing and complete transfer hold caused non-seeking `waiting` near the buffered end; appending later fragments resumed playback.
- **Remote seek:** a seek to unbuffered 150 s requested a new generation, the host used its deterministic index to send segment 38, and playback resumed near the target. Overlapping seek bursts discarded old-generation chunks and converged on the latest target. A development race showed that merely aborting a seek's transport is insufficient: the host must **join its old source read before starting a new cut**, because the bounded reader allows only one read in flight.
- **Transfer scheduling (found by independent review):** a host that keeps its own sequential read position stalls playback permanently. After a remote seek moved the host forward, a later *buffered* seek back was handled locally, the host kept streaming far-ahead media, and playback stopped for good at the old buffer end while a disjoint future range grew. The fixed experiment schedules from the receiver's current playback need: the first segment at the end of the playhead's contiguous buffered run, stamped with an intent generation that every seek (local or remote) advances. Only that contiguous coverage counts toward the ahead cap. A buffered seek still changes transfer priority; a `waiting` stall reports its need immediately; and the host ignores older generations. Development findings while fixing: a window trim that cuts the tail off a segment makes *that* segment the need even though its midpoint is still buffered; Chrome does not resolve a seek whose target is even 80 ms before the buffered start; and it does not play across a 67 ms (two-frame) gap, while the audio/video intersection routinely ends 6–16 ms short of a segment end. Time tolerances around segment boundaries therefore need care. A production buffer manager needs the same need-driven, contiguity-aware model.
- **Receive memory:** the receiver held only one reassembly part (2,382,977 B maximum observed), appended it, then released the JavaScript bytes. The MSE experiment removed old and isolated future ranges outside an approximate 30 s window around the playhead. Browser-managed decoder/MSE memory and long-run mobile heap were not measured. OPFS was not integrated.
- **Integrity and cleanup:** declared IDs/counts/bytes and SHA-256 were checked before append, followed by independent fMP4 structural checks. A malformed binary frame was rejected while later media continued. Both peers and MSE closed cleanly, and a second run played in the same tabs without refresh.

### Planned production behavior (unchanged)

The architecture above remains a plan. The two-segment startup threshold, 64 KiB transport payload, 20 s ahead cap, 30 s MSE window, one-part acknowledgement loop, `BUFFER_STATUS` need fields, and BroadcastChannel signaling are laboratory choices, not product parameters. Durable cache, reconnect, authentication, real external-network/TURN behavior, physical Android, other browsers, real-world media, and measured device memory remain future work. `Spike 0.7 demonstrates bounded streaming pipeline; durable cache integration remains productionization work.`

## Resumability and Interruption Recovery

Transfer state should distinguish identity, metadata, verified local ranges, unverified partial chunks, acknowledgements, and current priorities. After a connection interruption, peers must re-authenticate the room/session, re-establish media identity, reconcile verified ranges, and resume only valid missing work.

Resume metadata must not permit one file's cached data to be applied to another. A changed file, incompatible protocol, expired room, failed integrity check, or invalid cache record causes safe invalidation rather than speculative reuse.

## Cache and Browser Storage

OPFS is a candidate for receiving large sequential or random-access data without retaining the entire file in memory. Alternatives or layered approaches may be needed when OPFS is unavailable, quota is insufficient, persistence is denied, or browser lifecycle behavior is unsuitable.

Storage design must:

- Query capacity and usage where supported, while treating estimates as non-guarantees.
- Estimate required bytes from transfer metadata plus overhead before promising availability.
- Reserve headroom for browser and application operation.
- Avoid duplicating large data across memory, cache, and MSE when practical.
- Respond to quota errors and eviction without corrupting session state.
- Keep cache entries scoped to a privacy-safe media identity and version.
- Expose cleanup and cancellation behavior to the user.
- Remove expired, canceled, invalid, or user-cleared entries.
- Avoid retaining filenames and local paths unless strictly needed and safely handled.

Multi-GB behavior is a required investigation. OPFS does not guarantee capacity, persistence, uniform performance, or identical behavior across browsers.

## Storage Estimation

Before transfer, the receiver should compare the declared media size and expected working overhead with browser-reported storage estimates and current policy. During transfer it should track verified bytes, partial assembly space, queued data, and MSE occupancy. Because reported quota can change and eviction may occur, admission is a risk estimate rather than a guarantee.

No fixed reserve ratio or maximum file size is defined yet; both require device evidence and security limits.

## Integrity and Ordering

The pipeline requires identifiers and integrity checks at appropriate levels so it can detect corruption, incorrect reassembly, stale cache reuse, and wrong-media data. The exact algorithm and granularity are unresolved. Integrity success does not establish that content is safe, legal, or trusted; container parsing and browser decoding remain security boundaries.

## Unsupported Media Behavior

Progressive Watch must fail clearly before expensive transfer whenever the container, codec, profile, track layout, encryption/DRM state, or file structure is incompatible. It must not claim that all MP4 files are supported: MP4 is a container, and the initial target is H.264/AVC video with AAC audio.

An unsupported Progressive Watch file may still be usable in Local Sync if each participant has a locally playable matching file. Driftless will not transcode arbitrary media, bypass DRM, or rebroadcast protected services.

## Feasibility Questions

Phase 0 establishes whether representative large local files, binary data channels, browser storage, MP4 parsing/segmentation, and MSE playback of received fragments can form a viable architecture. Phase 5 revisits the pipeline as an integrated Progressive Watch technical spike, including backpressure, caching, and seeking. Passing one browser experiment does not establish production or cross-browser support.
