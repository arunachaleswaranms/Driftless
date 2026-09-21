# ADR-0001: Web-First PWA Architecture

## Title

Adopt a web-first Progressive Web App architecture.

## Status

Accepted

## Context

Driftless must serve people on desktop and Android without requiring separate native installations. Its core needs - local file selection, HTML5 playback, WebRTC, and browser-managed storage - have web APIs that may be suitable, but their limits differ by browser and device. Progressive media capabilities are not uniform and require runtime detection.

## Decision

Build Driftless as a TypeScript web application using React, Vite, PWA capabilities, and HTML5 video. Treat desktop browsers and Android browsers as the primary platforms. Detect optional capabilities at runtime and preserve clear fallbacks, especially between Local Sync and Progressive Watch.

This decision establishes a direction, not an implemented stack. Framework and PWA initialization occurs only in the appropriate roadmap phase.

## Rationale

- A single web client provides the lowest-friction path across target platforms.
- Browser-native media and WebRTC APIs match the planned peer-to-peer architecture.
- A PWA can improve installation and offline application-shell behavior without creating a separate native codebase.
- Shared TypeScript packages can express protocol, synchronization, and transfer behavior consistently.

## Consequences

- Browser sandbox, lifecycle, codec, storage, and API differences become core design constraints.
- Progressive Watch cannot be assumed merely because the application loads.
- Real-device Android and cross-browser testing are mandatory.
- Safari/iOS and Firefox support remain evidence-dependent.
- Native-only capabilities may require scope changes or a future architecture decision.

## Alternatives Considered

- Separate native desktop and Android applications: greater platform control but substantially more implementation and maintenance work.
- Electron or another desktop wrapper: does not address Android and adds packaging/runtime overhead.
- Native-first mobile application: weakens the desktop-web goal and splits delivery.

## Revisit Conditions

Revisit if Phase 0 or later gates show that required local-media, WebRTC, MSE, storage, or background behavior cannot provide an acceptable experience on primary targets, or if a native component becomes necessary for a clearly approved scope.

