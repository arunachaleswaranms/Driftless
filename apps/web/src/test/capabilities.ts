import { vi } from 'vitest';

/**
 * A synthetic global scope exposing every API surface the capability report
 * observes. Every function that would have an effect if called is a spy, so
 * tests can prove that detection never calls it.
 */
export function makeFullScope() {
  const effects = {
    File: vi.fn(),
    Blob: vi.fn(),
    createObjectURL: vi.fn(),
    revokeObjectURL: vi.fn(),
    HTMLVideoElement: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    serviceWorkerRegister: vi.fn(),
    getDirectory: vi.fn(),
    persist: vi.fn(),
    RTCPeerConnection: vi.fn(),
    createDataChannel: vi.fn(),
    createOffer: vi.fn(),
    RTCDataChannel: vi.fn(),
    MediaSource: vi.fn(),
    isTypeSupported: vi.fn(),
    SourceBuffer: vi.fn(),
    digest: vi.fn(),
    getRandomValues: vi.fn(),
  };
  const canPlayType = vi.fn((mimeType: string): string =>
    mimeType === 'video/mp4' ? 'maybe' : '',
  );
  const createElement = vi.fn(() => ({ canPlayType }));

  // Methods are observed on the prototype, as in a browser.
  class FakeRTCPeerConnection {
    constructor() {
      effects.RTCPeerConnection();
    }
    createDataChannel(): unknown {
      return effects.createDataChannel();
    }
    createOffer(): unknown {
      return effects.createOffer();
    }
  }

  const scope: Record<string, unknown> = {
    isSecureContext: true,
    File: effects.File,
    Blob: effects.Blob,
    URL: { createObjectURL: effects.createObjectURL, revokeObjectURL: effects.revokeObjectURL },
    HTMLVideoElement: effects.HTMLVideoElement,
    HTMLMediaElement: {
      prototype: { play: effects.play, pause: effects.pause, canPlayType },
    },
    document: { createElement },
    navigator: {
      serviceWorker: { register: effects.serviceWorkerRegister },
      storage: { getDirectory: effects.getDirectory, persist: effects.persist },
    },
    RTCPeerConnection: FakeRTCPeerConnection,
    RTCDataChannel: effects.RTCDataChannel,
    MediaSource: Object.assign(effects.MediaSource, { isTypeSupported: effects.isTypeSupported }),
    SourceBuffer: effects.SourceBuffer,
    crypto: {
      getRandomValues: effects.getRandomValues,
      subtle: { digest: effects.digest },
    },
  };

  return { scope, effects, canPlayType, createElement };
}

/** Removes the property at a dotted path, such as `navigator.storage.getDirectory`. */
export function removeApi(scope: Record<string, unknown>, api: string): void {
  const keys = api.split('.');
  const last = keys.pop();
  let target: unknown = scope;
  for (const key of keys) {
    target = (target as Record<string, unknown>)[key];
  }
  if (last && (typeof target === 'object' || typeof target === 'function') && target !== null) {
    Reflect.deleteProperty(target, last);
  }
}
