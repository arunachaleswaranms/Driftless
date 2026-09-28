import type {
  ApiCheck,
  CapabilityId,
  CapabilityObservation,
  CapabilityReport,
  FoundationCapabilityId,
  LaterPhaseCapabilityId,
  MediaTypeAnswer,
  MediaTypeDeclaration,
  ObservationStatus,
} from './capabilityModel.ts';
import { lookupPath, type CapabilityScope, type Lookup } from './capabilityScope.ts';

/**
 * How one API surface is observed:
 * - `function`: present when the path resolves to a function.
 * - `object`: present when the path resolves to an object or function.
 * - `flag`: available when the path is `true`, not available when `false`.
 */
interface ApiProbe {
  readonly api: string;
  readonly path: readonly string[];
  readonly kind: 'function' | 'object' | 'flag';
}

interface CapabilityDefinition<Id extends CapabilityId> {
  readonly id: Id;
  readonly probes: readonly ApiProbe[];
}

function probe(api: string, kind: ApiProbe['kind']): ApiProbe {
  return { api, path: api.split('.'), kind };
}

// Every probe only reads a property. None calls, constructs, or opens
// anything, so detection cannot prompt the user, touch storage, or start
// networking.
const FOUNDATION: readonly CapabilityDefinition<FoundationCapabilityId>[] = [
  {
    id: 'secure-context',
    probes: [{ api: 'window.isSecureContext', path: ['isSecureContext'], kind: 'flag' }],
  },
  { id: 'file-api', probes: [probe('File', 'function'), probe('Blob', 'function')] },
  {
    id: 'object-url',
    probes: [probe('URL.createObjectURL', 'function'), probe('URL.revokeObjectURL', 'function')],
  },
  {
    id: 'html-video',
    probes: [
      probe('HTMLVideoElement', 'function'),
      probe('HTMLMediaElement.prototype.play', 'function'),
      probe('HTMLMediaElement.prototype.pause', 'function'),
      probe('HTMLMediaElement.prototype.canPlayType', 'function'),
    ],
  },
  { id: 'service-worker', probes: [probe('navigator.serviceWorker', 'object')] },
];

const LATER_PHASE: readonly CapabilityDefinition<LaterPhaseCapabilityId>[] = [
  { id: 'webrtc-peer-connection', probes: [probe('RTCPeerConnection', 'function')] },
  {
    id: 'webrtc-data-channel',
    probes: [
      probe('RTCPeerConnection.prototype.createDataChannel', 'function'),
      probe('RTCDataChannel', 'function'),
    ],
  },
  {
    id: 'media-source',
    probes: [
      probe('MediaSource', 'function'),
      probe('MediaSource.isTypeSupported', 'function'),
      probe('SourceBuffer', 'function'),
    ],
  },
  { id: 'opfs', probes: [probe('navigator.storage.getDirectory', 'function')] },
  {
    id: 'web-crypto',
    probes: [probe('crypto.subtle', 'object'), probe('crypto.subtle.digest', 'function')],
  },
];

/**
 * Container types asked of `canPlayType()` without any codec parameter. The
 * answers are the browser's declarations about the container only. They are
 * not evidence about codecs, profiles, or any particular file, and are never
 * used to decide whether a mode is available.
 */
export const DECLARED_MEDIA_TYPES = ['video/mp4', 'video/webm'] as const;

function statusOf(found: Lookup, kind: ApiProbe['kind']): ObservationStatus {
  if (found.kind === 'blocked') {
    return 'not-evaluated';
  }
  if (kind === 'flag') {
    if (found.kind === 'found' && typeof found.value === 'boolean') {
      return found.value ? 'available' : 'not-available';
    }
    return 'not-evaluated';
  }
  if (found.kind === 'missing') {
    return 'not-available';
  }
  const { value } = found;
  const present = typeof value === 'function' || (kind === 'object' && typeof value === 'object');
  return present ? 'available' : 'not-available';
}

function check(scope: CapabilityScope, { api, path, kind }: ApiProbe): ApiCheck {
  return { api, status: statusOf(lookupPath(scope, path), kind) };
}

function summarize(checks: readonly ApiCheck[]): ObservationStatus {
  if (checks.some(({ status }) => status === 'not-available')) {
    return 'not-available';
  }
  if (checks.some(({ status }) => status === 'not-evaluated')) {
    return 'not-evaluated';
  }
  return 'available';
}

function observe<Id extends CapabilityId>(
  scope: CapabilityScope,
  { id, probes }: CapabilityDefinition<Id>,
): CapabilityObservation<Id> {
  const checks = probes.map((definition) => check(scope, definition));
  return { id, status: summarize(checks), checks };
}

/**
 * A detached, source-less video element to ask `canPlayType()`. It is never
 * inserted into the document and never given media, so it loads nothing.
 */
function createProbeVideo(scope: CapabilityScope): object | null {
  const documentLookup = lookupPath(scope, ['document']);
  const createElement = lookupPath(scope, ['document', 'createElement']);
  if (
    documentLookup.kind !== 'found' ||
    createElement.kind !== 'found' ||
    typeof createElement.value !== 'function'
  ) {
    return null;
  }
  try {
    const element: unknown = Reflect.apply(createElement.value, documentLookup.value, ['video']);
    return typeof element === 'object' && element !== null ? element : null;
  } catch {
    return null;
  }
}

function askCanPlayType(video: object | null, mimeType: string): MediaTypeAnswer {
  if (!video) {
    return 'not-evaluated';
  }
  const canPlayType = lookupPath(video, ['canPlayType']);
  if (canPlayType.kind !== 'found' || typeof canPlayType.value !== 'function') {
    return 'not-evaluated';
  }
  try {
    const answer: unknown = Reflect.apply(canPlayType.value, video, [mimeType]);
    if (answer === 'probably' || answer === 'maybe') {
      return answer;
    }
    return answer === '' ? 'no' : 'not-evaluated';
  } catch {
    return 'not-evaluated';
  }
}

function declareMediaTypes(scope: CapabilityScope): MediaTypeDeclaration[] {
  const video = createProbeVideo(scope);
  return DECLARED_MEDIA_TYPES.map((mimeType) => ({
    mimeType,
    answer: askCanPlayType(video, mimeType),
  }));
}

/**
 * Observes which browser API surfaces this page exposes. It reads properties
 * and asks `canPlayType()` of a detached element; it keeps no state, so each
 * run against the same scope gives the same report.
 *
 * The report says what exists, not what works. It is not a support or
 * compatibility result, and no mode's availability is derived from it.
 */
export function detectCapabilities(scope: CapabilityScope): CapabilityReport {
  return {
    foundation: FOUNDATION.map((definition) => observe(scope, definition)),
    laterPhase: LATER_PHASE.map((definition) => observe(scope, definition)),
    mediaTypeDeclarations: declareMediaTypes(scope),
  };
}
