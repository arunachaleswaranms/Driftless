import type { CapabilityId, MediaTypeAnswer, ObservationStatus } from './capabilityModel.ts';

interface CapabilityText {
  readonly name: string;
  readonly description: string;
}

// Wording rule: describe what was observed, never whether something is
// "supported" or "compatible". Those words carry evidence requirements in
// docs/COMPATIBILITY.md that a runtime observation cannot meet.
export const CAPABILITY_TEXT: Readonly<Record<CapabilityId, CapabilityText>> = {
  'secure-context': {
    name: 'Secure context',
    description:
      'Whether this browser treats the page as a secure context. Browsers count localhost as secure during development, so this does not show how a deployment is served.',
  },
  'file-api': {
    name: 'Local file objects',
    description:
      'The objects that represent a file chosen on this device. Only their presence is checked; no file is opened.',
  },
  'object-url': {
    name: 'Object URLs',
    description: 'The local player binds a chosen file to the video through a temporary blob: URL.',
  },
  'html-video': {
    name: 'HTML video',
    description: 'The video element and the playback methods the local player relies on.',
  },
  'service-worker': {
    name: 'Service Worker API',
    description:
      'Only the API is checked. Its presence does not show that the app is installable, works offline, or has a registered worker.',
  },
  'webrtc-peer-connection': {
    name: 'WebRTC peer connection',
    description: 'Planned for connecting two browsers. No connection is created.',
  },
  'webrtc-data-channel': {
    name: 'WebRTC data channel',
    description:
      'Planned for playback control messages and for media data in Progressive Watch. No channel is opened.',
  },
  'media-source': {
    name: 'Media Source Extensions',
    description: 'Planned for playing media while it is still arriving. Nothing is appended.',
  },
  opfs: {
    name: 'Origin private file system',
    description:
      'A candidate for keeping received media in browser storage. It is not opened, and nothing is written.',
  },
  'web-crypto': {
    name: 'Web Crypto digest',
    description: 'Planned for integrity checks. Nothing is hashed.',
  },
};

const STATUS_TEXT: Readonly<Record<ObservationStatus, string>> = {
  available: 'Available',
  'not-available': 'Not available',
  'not-evaluated': 'Not evaluated',
};

const CHECK_TEXT: Readonly<Record<ObservationStatus, string>> = {
  available: 'present',
  'not-available': 'not present',
  'not-evaluated': 'not evaluated',
};

// The secure-context entry reports a browser flag rather than an API.
const SECURE_CONTEXT_STATUS_TEXT: Readonly<Record<ObservationStatus, string>> = {
  available: 'Yes',
  'not-available': 'No',
  'not-evaluated': 'Not evaluated',
};

const SECURE_CONTEXT_CHECK_TEXT: Readonly<Record<ObservationStatus, string>> = {
  available: 'true',
  'not-available': 'false',
  'not-evaluated': 'not evaluated',
};

export function statusText(id: CapabilityId, status: ObservationStatus): string {
  return (id === 'secure-context' ? SECURE_CONTEXT_STATUS_TEXT : STATUS_TEXT)[status];
}

export function checkText(id: CapabilityId, status: ObservationStatus): string {
  return (id === 'secure-context' ? SECURE_CONTEXT_CHECK_TEXT : CHECK_TEXT)[status];
}

const ANSWER_TEXT: Readonly<Record<MediaTypeAnswer, string>> = {
  probably: 'Browser reports: probably',
  maybe: 'Browser reports: maybe',
  no: 'Browser reports: no',
  'not-evaluated': 'Not evaluated',
};

export function answerText(answer: MediaTypeAnswer): string {
  return ANSWER_TEXT[answer];
}
