# Project Charter

## Problem Statement

People in different locations often want to watch a privately held video together without uploading it to a public service. Existing approaches commonly require both people to start manually, upload media to an intermediary, or use a service that cannot access local files. Network conditions, browser differences, and playback drift make a reliable private experience difficult.

## Vision

Driftless will provide a small, private, web-first room in which two people can watch together with synchronized controls. It will support both a no-transfer mode for matching local files and, where runtime capabilities permit, progressive peer-to-peer delivery from the participant who has the media.

## Intended Users

- Two people in different locations who each possess the same local video.
- Two people where only one has a compatible, legitimately accessible local video.
- Technically comfortable early users willing to use an experimental browser application and report interoperability issues.

The long-term room limit is three participants, but three-person behavior is not part of the initial product path.

## Primary Use Cases

1. **Local Sync:** host and guest select matching local files, become ready, and watch under host-authoritative playback control without transferring media.
2. **Progressive Watch:** the host selects compatible local media and the guest begins watching after enough peer-delivered data is buffered.
3. **Lightweight social interaction:** participants exchange room chat messages and reactions without disrupting playback.
4. **Recovery:** a participant reconnects after a temporary network interruption and recovers session state, and in Progressive Watch resumes eligible transfer work.

## Scope

- Desktop and Android browsers through a web-first/PWA architecture.
- Private rooms, initially for exactly two active participants.
- Host-authoritative playback synchronization.
- Peer-to-peer control, state, chat, and reaction messages.
- Local Sync using media identity checks without media transfer.
- Progressive Watch investigation and, if viable, support for MP4 with H.264/AVC and AAC.
- Minimal signaling and TURN fallback when required for connectivity.
- Runtime feature and compatibility detection.
- Browser-local temporary cache/storage investigation.

## Non-Goals

The initial product will not:

- Build a replacement for Netflix, YouTube, or other media platforms.
- Host public media or provide public room discovery.
- Permanently store user media in the cloud.
- Transcode arbitrary codecs or containers.
- Support large-group conferencing.
- Include voice or video calling in the MVP.
- Bypass DRM or access controls.
- Rebroadcast protected streaming services.
- Guarantee Progressive Watch on every browser that can run Local Sync.
- Remove the need for users to have lawful access to the media they use.

## Design Principles

- **Privacy by architecture:** avoid backend media custody and minimize retained metadata.
- **Peer-to-peer first:** prefer direct paths while treating TURN as a necessary, visible fallback.
- **Capability over assumption:** detect browser and media capabilities at runtime.
- **Independent planes:** signaling, synchronization, and media transfer must fail and evolve independently where practical.
- **Progressive value:** playback should not require a complete transfer when Progressive Watch is available.
- **Evidence before commitment:** resolve storage, fragmentation, transport, and compatibility choices through technical spikes.
- **Small-room reliability:** optimize two-person behavior before adding topology complexity.
- **Explicit gates:** each roadmap phase has measurable exit conditions.
- **Safe failure:** reject unsupported media and malformed input without exhausting device resources.

## Success Criteria

- Local Sync maintains usable synchronization during long sessions on supported real devices and real networks.
- A direct or relayed WebRTC session can be diagnosed without exposing media contents.
- Progressive Watch, if its feasibility gates pass, starts from an initial buffer and continues receiving data during playback.
- Temporary interruption and reconnect behavior is understandable and recoverable.
- Unsupported browsers or media receive accurate, actionable messages instead of false compatibility claims.
- Backend services do not permanently store media in the normal architecture.
- Security and resource bounds are enforced for rooms, messages, transfers, and storage.

Exact performance thresholds will be defined from Phase 0 measurements rather than invented in advance.

## MVP Definition

The MVP is a reliable two-person Local Sync experience on validated Tier 1 browsers. It includes private room entry, matching local media selection, readiness, host-authoritative play/pause/seek, heartbeat-based drift management, reconnect handling, basic chat/reactions, capability messaging, and diagnostics.

Progressive Watch is not automatically part of the MVP. It enters product scope only if the feasibility and productionization gates demonstrate an acceptable experience and operating cost.

## Assumptions

- Participants are permitted to access and use the selected media.
- At least one participant can act as host and source of authoritative playback state.
- Browsers expose sufficient WebRTC functionality for control-plane communication.
- Direct peer-to-peer connectivity will not always be possible, so TURN fallback is required.
- Media compatibility varies by browser, operating system, codec profile, and file structure.
- Mobile browsers can impose backgrounding, storage, memory, and power constraints.

## Constraints

- Web security and browser sandbox rules apply to local files and storage.
- WebRTC connectivity depends on NAT, firewall, carrier, STUN, and TURN behavior.
- TURN relay of media can create significant bandwidth and cost.
- Browser memory and storage capacity cannot be treated as unlimited.
- MSE, OPFS, and MP4 parsing behavior must be validated per target platform.
- Initial Progressive Watch compatibility is limited to the MP4/H.264/AAC target.
- No production signaling host, STUN/TURN provider, chunk size, or fragmentation strategy has been selected.

