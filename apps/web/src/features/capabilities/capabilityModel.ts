/**
 * What the capability report observed about one API surface or runtime flag
 * on this page. These are observations of the running browser only. They are
 * not support or compatibility statuses: those are defined, with their
 * evidence requirements, in docs/COMPATIBILITY.md, and API presence alone
 * never changes one.
 *
 * - `available`: the API surface is present (or the flag is true).
 * - `not-available`: the API surface is absent (or the flag is false).
 * - `not-evaluated`: nothing could be observed, for example because the
 *   browser blocked the check or reported no value.
 */
export type ObservationStatus = 'available' | 'not-available' | 'not-evaluated';

/** Capabilities used by the current application foundation. */
export type FoundationCapabilityId =
  'secure-context' | 'file-api' | 'object-url' | 'html-video' | 'service-worker';

/** API surfaces that later phases plan to use. This build does not use them. */
export type LaterPhaseCapabilityId =
  'webrtc-peer-connection' | 'webrtc-data-channel' | 'media-source' | 'opfs' | 'web-crypto';

export type CapabilityId = FoundationCapabilityId | LaterPhaseCapabilityId;

/** One named API surface and what was observed about it. */
export interface ApiCheck {
  /** The API as a script would name it, such as `URL.createObjectURL`. */
  readonly api: string;
  readonly status: ObservationStatus;
}

export interface CapabilityObservation<Id extends CapabilityId = CapabilityId> {
  readonly id: Id;
  /** `available` only when every check is available. */
  readonly status: ObservationStatus;
  readonly checks: readonly ApiCheck[];
}

/**
 * The browser's own answer from `HTMLMediaElement.canPlayType()`. It is a
 * declaration, not a test: `probably` and `maybe` do not show that any
 * particular file will play, and `no` is the empty-string answer.
 */
export type MediaTypeAnswer = 'probably' | 'maybe' | 'no' | 'not-evaluated';

export interface MediaTypeDeclaration {
  readonly mimeType: string;
  readonly answer: MediaTypeAnswer;
}

export interface CapabilityReport {
  readonly foundation: readonly CapabilityObservation<FoundationCapabilityId>[];
  readonly laterPhase: readonly CapabilityObservation<LaterPhaseCapabilityId>[];
  readonly mediaTypeDeclarations: readonly MediaTypeDeclaration[];
}
