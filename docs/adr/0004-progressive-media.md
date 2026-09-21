# ADR-0004: Progressive Media Receiving and Playback

## Title

Pursue progressive receiving and playback instead of requiring a full-file download.

## Status

Accepted

## Context

In Progressive Watch, only the host has the media. Waiting for an entire large file before playback would create long startup delays and unnecessary storage requirements. Browser media playback requires valid container structure, codec support, decodable segment boundaries, and controlled buffering.

## Decision

Design Progressive Watch so a receiver can begin after an initial playable buffer while remaining media continues to transfer. Separate media segments from transport chunks, apply data-channel backpressure, prioritize startup and seek-critical ranges, cache received data under an explicit policy, and use MSE where runtime support and media compatibility are proven.

The initial target is MP4 with H.264/AVC video and AAC audio. MP4Box.js, MSE, OPFS, fragmentation details, and exact transport parameters remain feasibility items rather than fixed implementation choices.

## Rationale

- Progressive startup better matches the watch-together use case for large files.
- Segment-aware scheduling enables seek prioritization and bounded recovery.
- Separating media structure from transport framing permits each to evolve from evidence.
- Runtime checks prevent a nominal API from becoming a false compatibility promise.

## Consequences

- Media inspection, segmentation, reassembly, integrity verification, buffer management, and cache lifecycle are required.
- Unsupported codecs, profiles, file structures, or browsers must fail clearly.
- Memory, storage, MSE, and mobile constraints become release gates.
- Resumability must bind cached ranges to the correct media identity.
- Progressive Watch remains independent of Local Sync and may have narrower support.

## Alternatives Considered

- Require full transfer before playback: simpler but conflicts with the progressive experience and is poor for large media.
- Stream media through the backend: conflicts with peer-to-peer-first and no permanent backend media storage goals.
- Transcode all input into a standard format: operationally expensive and outside initial scope.
- Rely on a blob URL for an ever-growing full file: may require excessive memory/storage and does not establish robust seeking or MSE behavior.

## Revisit Conditions

Revisit if Phase 0 or Phase 5 shows that progressive MSE playback, segmentation, data-channel delivery, storage, seeking, or resource use is not viable on target platforms, or if another widely supported browser media pipeline offers a safer approach.

