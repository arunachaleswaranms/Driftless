# Compatibility Policy

## Status Vocabulary

| Status | Meaning |
| --- | --- |
| `NOT TESTED` | No current evidence supports a compatibility claim. |
| `SPIKE ONLY` | A limited experiment worked under recorded conditions; no product support claim. |
| `PARTIAL` | Some defined flows work, with documented limitations or failed gates. |
| `SUPPORTED` | The documented test gate passes on listed versions/devices and is maintained. |
| `UNSUPPORTED` | The combination is intentionally excluded or has evidence of a blocking incompatibility. |

API presence alone does not change a status. Versions, operating systems, devices, media characteristics, direct/TURN path, and evidence dates must accompany future changes.

Phase 0 used desktop Chrome as its primary controlled software environment. Its spike results are recorded in [Phase 0 evidence](../spikes/phase0/) and do not change the product statuses below. Physical Android, Edge, Firefox, and Safari each require their own qualification; Progressive Watch remains capability-detected even on a browser where Local Sync later passes.

## Target Tiers

- **Tier 1:** Chrome desktop, Edge desktop, Chrome Android.
- **Tier 2:** Firefox desktop, Firefox Android.
- **Tier 3:** Safari macOS, Safari/iOS, other browsers.

Tiers express validation priority, not current support.

## Application and Browser Compatibility

| Browser/platform | Tier | Initial status | Notes |
| --- | --- | --- | --- |
| Chrome desktop | 1 | `NOT TESTED` | Primary desktop target. |
| Edge desktop | 1 | `NOT TESTED` | Primary desktop target. |
| Chrome Android | 1 | `NOT TESTED` | Real-device testing is mandatory. |
| Firefox desktop | 2 | `NOT TESTED` | Requires independent capability and lifecycle validation. |
| Firefox Android | 2 | `NOT TESTED` | Requires physical-device validation. |
| Safari macOS | 3 | `NOT TESTED` | Feasibility and browser-specific behavior are unresolved. |
| Safari/iOS | 3 | `NOT TESTED` | Mobile lifecycle, storage, MSE, and PWA behavior are unresolved. |
| Other browsers | 3 | `NOT TESTED` | No support promise. |

## Local Sync Compatibility

Local Sync depends on local-file playback, WebRTC control messaging, timing behavior, and the ability to identify matching media. It does not depend on Progressive Watch support.

| Browser/platform | Status | Notes |
| --- | --- | --- |
| Chrome desktop | `NOT TESTED` | Planned Tier 1 validation. |
| Edge desktop | `NOT TESTED` | Planned Tier 1 validation. |
| Chrome Android | `NOT TESTED` | Must pass real-device and cross-network gates. |
| Firefox desktop | `NOT TESTED` | Planned Tier 2 investigation. |
| Firefox Android | `NOT TESTED` | Planned Tier 2 investigation on a real device. |
| Safari macOS | `NOT TESTED` | Tier 3 investigation. |
| Safari/iOS | `NOT TESTED` | Tier 3 investigation; no feasibility claim. |
| Other browsers | `NOT TESTED` | Capability detection must fail clearly. |

## Progressive Watch Compatibility

Progressive Watch has additional dependencies on binary data-channel behavior, file parsing, transport backpressure, browser storage, MSE, and the exact media structure. It is always runtime-detected, even on a browser where Local Sync is supported.

| Browser/platform | Status | Notes |
| --- | --- | --- |
| Chrome desktop | `NOT TESTED` | Phase 0 and Phase 5 investigation target. |
| Edge desktop | `NOT TESTED` | Phase 0 and Phase 5 investigation target. |
| Chrome Android | `NOT TESTED` | Real-device memory, storage, MSE, and lifecycle evidence required. |
| Firefox desktop | `NOT TESTED` | Progressive playback behavior is an open question. |
| Firefox Android | `NOT TESTED` | No support claim; physical-device evidence required. |
| Safari macOS | `NOT TESTED` | Feasibility unresolved. |
| Safari/iOS | `NOT TESTED` | Feasibility unresolved; do not infer support from desktop results. |
| Other browsers | `NOT TESTED` | No support promise. |

## Codec and Container Compatibility

| Container / video / audio | Progressive Watch status | Policy |
| --- | --- | --- |
| MP4 / H.264 (AVC) / AAC | `NOT TESTED` | Initial target only; actual profiles, levels, track layouts, and file structures require validation. |
| MP4 with other codecs | `UNSUPPORTED` | Outside the initial target unless a later ADR and test evidence expand scope. |
| Non-MP4 containers | `UNSUPPORTED` | Outside the initial Progressive Watch target. |
| Encrypted or DRM-protected media | `UNSUPPORTED` | Driftless will not bypass DRM or rebroadcast protected services. |
| Arbitrary media requiring transcoding | `UNSUPPORTED` | Transcoding is an initial non-goal. |

MP4 is a container, not a codec guarantee. Browser decoding may vary with operating-system media support. A file rejected for Progressive Watch may still work in Local Sync when both participants have matching, locally playable copies.

## Capability Evaluation

Before enabling a mode, the client should evaluate the necessary browser APIs, negotiated protocol features, codec declarations, actual media inspection results, storage conditions, and runtime errors. Positive feature detection is necessary but not sufficient; known-bad combinations and measured limitations may still require a safe fallback.

## Changing a Status

Compatibility status changes require evidence from [TEST_PLAN.md](TEST_PLAN.md), including exact versions, physical device details where applicable, media fixtures, network matrix coverage, and direct P2P versus TURN usage. A `SUPPORTED` entry must state its supported range and limitations. Evidence must be refreshed when material browser, operating-system, protocol, or media-pipeline changes occur.

