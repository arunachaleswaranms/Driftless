import { describe, expect, it } from 'vitest';
import { makeFullScope, removeApi } from '../../test/capabilities.ts';
import type { CapabilityId, CapabilityReport, ObservationStatus } from './capabilityModel.ts';
import { DECLARED_MEDIA_TYPES, detectCapabilities } from './detectCapabilities.ts';

function observation(report: CapabilityReport, id: CapabilityId) {
  const found = [...report.foundation, ...report.laterPhase].find((entry) => entry.id === id);
  if (!found) {
    throw new Error(`No observation for ${id}.`);
  }
  return found;
}

function statusOf(report: CapabilityReport, id: CapabilityId): ObservationStatus {
  return observation(report, id).status;
}

function checkStatus(report: CapabilityReport, id: CapabilityId, api: string) {
  return observation(report, id).checks.find((check) => check.api === api)?.status;
}

function detectWithout(...apis: string[]) {
  const { scope } = makeFullScope();
  for (const api of apis) {
    removeApi(scope, api);
  }
  return detectCapabilities(scope);
}

describe('detectCapabilities', () => {
  it('reports every API surface as available in a fully populated scope', () => {
    const report = detectCapabilities(makeFullScope().scope);

    expect(report.foundation.map(({ id, status }) => [id, status])).toEqual([
      ['secure-context', 'available'],
      ['file-api', 'available'],
      ['object-url', 'available'],
      ['html-video', 'available'],
      ['service-worker', 'available'],
    ]);
    expect(report.laterPhase.map(({ id, status }) => [id, status])).toEqual([
      ['webrtc-peer-connection', 'available'],
      ['webrtc-data-channel', 'available'],
      ['media-source', 'available'],
      ['opfs', 'available'],
      ['web-crypto', 'available'],
    ]);
    expect(
      [...report.foundation, ...report.laterPhase].flatMap(({ checks }) =>
        checks.map(({ api }) => api),
      ),
    ).toEqual([
      'window.isSecureContext',
      'File',
      'Blob',
      'URL.createObjectURL',
      'URL.revokeObjectURL',
      'HTMLVideoElement',
      'HTMLMediaElement.prototype.play',
      'HTMLMediaElement.prototype.pause',
      'HTMLMediaElement.prototype.canPlayType',
      'navigator.serviceWorker',
      'RTCPeerConnection',
      'RTCPeerConnection.prototype.createDataChannel',
      'RTCDataChannel',
      'MediaSource',
      'MediaSource.isTypeSupported',
      'SourceBuffer',
      'navigator.storage.getDirectory',
      'crypto.subtle',
      'crypto.subtle.digest',
    ]);
  });

  it('reports every API surface as not available in an empty scope without throwing', () => {
    const report = detectCapabilities({});

    expect(statusOf(report, 'secure-context')).toBe('not-evaluated');
    for (const { id, status } of [...report.foundation, ...report.laterPhase]) {
      if (id !== 'secure-context') {
        expect(status, id).toBe('not-available');
      }
    }
    expect(report.mediaTypeDeclarations.map(({ answer }) => answer)).toEqual([
      'not-evaluated',
      'not-evaluated',
    ]);
  });

  describe('current foundation', () => {
    it('observes the secure-context flag as reported', () => {
      const secure = makeFullScope().scope;
      const insecure = { ...makeFullScope().scope, isSecureContext: false };
      const unreported = { ...makeFullScope().scope, isSecureContext: 'yes' };

      expect(statusOf(detectCapabilities(secure), 'secure-context')).toBe('available');
      expect(statusOf(detectCapabilities(insecure), 'secure-context')).toBe('not-available');
      expect(statusOf(detectCapabilities(unreported), 'secure-context')).toBe('not-evaluated');
    });

    it.each(['File', 'Blob'])('reports the File API as not available without %s', (api) => {
      const report = detectWithout(api);

      expect(statusOf(report, 'file-api')).toBe('not-available');
      expect(checkStatus(report, 'file-api', api)).toBe('not-available');
    });

    it.each(['URL.createObjectURL', 'URL.revokeObjectURL'])(
      'reports object URLs as not available without %s',
      (api) => {
        const report = detectWithout(api);

        expect(statusOf(report, 'object-url')).toBe('not-available');
        expect(checkStatus(report, 'object-url', api)).toBe('not-available');
      },
    );

    it('reports object URLs as not available when URL itself is absent', () => {
      const report = detectWithout('URL');

      expect(observation(report, 'object-url').checks.map(({ status }) => status)).toEqual([
        'not-available',
        'not-available',
      ]);
    });

    it.each([
      'HTMLVideoElement',
      'HTMLMediaElement.prototype.play',
      'HTMLMediaElement.prototype.pause',
      'HTMLMediaElement.prototype.canPlayType',
    ])('reports HTML video as not available without %s', (api) => {
      const report = detectWithout(api);

      expect(statusOf(report, 'html-video')).toBe('not-available');
      expect(checkStatus(report, 'html-video', api)).toBe('not-available');
    });

    it('reports the Service Worker API as absent or present', () => {
      expect(statusOf(detectWithout('navigator.serviceWorker'), 'service-worker')).toBe(
        'not-available',
      );
      expect(statusOf(detectWithout('navigator'), 'service-worker')).toBe('not-available');
      expect(statusOf(detectWithout(), 'service-worker')).toBe('available');
    });

    it('reports a check the browser blocks as not evaluated instead of throwing', () => {
      const { scope } = makeFullScope();
      Object.defineProperty(scope.navigator, 'serviceWorker', {
        get() {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        },
      });

      const report = detectCapabilities(scope);

      expect(statusOf(report, 'service-worker')).toBe('not-evaluated');
      expect(statusOf(report, 'opfs')).toBe('available');
    });

    it('treats a value of the wrong type as not available', () => {
      const report = detectCapabilities({
        ...makeFullScope().scope,
        URL: { createObjectURL: 'not a function', revokeObjectURL: {} },
        navigator: { serviceWorker: 'not an object' },
      });

      expect(statusOf(report, 'object-url')).toBe('not-available');
      expect(statusOf(report, 'service-worker')).toBe('not-available');
    });
  });

  describe('later-phase prerequisites', () => {
    it('reports RTCPeerConnection absence, and with it the data channel surface', () => {
      const report = detectWithout('RTCPeerConnection');

      expect(statusOf(report, 'webrtc-peer-connection')).toBe('not-available');
      expect(statusOf(report, 'webrtc-data-channel')).toBe('not-available');
      expect(
        checkStatus(report, 'webrtc-data-channel', 'RTCPeerConnection.prototype.createDataChannel'),
      ).toBe('not-available');
    });

    it('reports a peer connection without data channel creation separately', () => {
      const report = detectWithout('RTCPeerConnection.prototype.createDataChannel');

      expect(statusOf(report, 'webrtc-peer-connection')).toBe('available');
      expect(statusOf(report, 'webrtc-data-channel')).toBe('not-available');
    });

    it.each(['MediaSource', 'MediaSource.isTypeSupported', 'SourceBuffer'])(
      'reports Media Source Extensions as not available without %s',
      (api) => {
        const report = detectWithout(api);

        expect(statusOf(report, 'media-source')).toBe('not-available');
        expect(checkStatus(report, 'media-source', api)).toBe('not-available');
      },
    );

    it.each(['navigator.storage.getDirectory', 'navigator.storage'])(
      'reports the OPFS entry point as not available without %s',
      (api) => {
        expect(statusOf(detectWithout(api), 'opfs')).toBe('not-available');
      },
    );

    it.each(['crypto', 'crypto.subtle', 'crypto.subtle.digest'])(
      'reports Web Crypto digest as not available without %s',
      (api) => {
        expect(statusOf(detectWithout(api), 'web-crypto')).toBe('not-available');
      },
    );

    it('keeps the foundation report intact when every later-phase API is absent', () => {
      const report = detectWithout(
        'RTCPeerConnection',
        'RTCDataChannel',
        'MediaSource',
        'SourceBuffer',
        'navigator.storage',
        'crypto',
      );

      expect(report.foundation.every(({ status }) => status === 'available')).toBe(true);
      expect(report.laterPhase.every(({ status }) => status === 'not-available')).toBe(true);
    });
  });

  describe('media type declarations', () => {
    it('records canPlayType answers for container types only', () => {
      const { scope, canPlayType, createElement } = makeFullScope();
      canPlayType.mockImplementation((mimeType) =>
        mimeType === 'video/mp4' ? 'probably' : 'maybe',
      );

      const report = detectCapabilities(scope);

      expect(DECLARED_MEDIA_TYPES).toEqual(['video/mp4', 'video/webm']);
      expect(report.mediaTypeDeclarations).toEqual([
        { mimeType: 'video/mp4', answer: 'probably' },
        { mimeType: 'video/webm', answer: 'maybe' },
      ]);
      expect(createElement).toHaveBeenCalledExactlyOnceWith('video');
      // No codec parameter is ever asked about.
      expect(canPlayType.mock.calls.flat().every((mimeType) => !mimeType.includes(';'))).toBe(true);
    });

    it('maps the empty answer to no, and anything unexpected to not evaluated', () => {
      const { scope, canPlayType } = makeFullScope();
      canPlayType.mockImplementation((mimeType) => (mimeType === 'video/mp4' ? '' : 'yes'));

      expect(detectCapabilities(scope).mediaTypeDeclarations.map(({ answer }) => answer)).toEqual([
        'no',
        'not-evaluated',
      ]);
    });

    it('reports not evaluated when canPlayType throws or no element can be created', () => {
      const throwing = makeFullScope();
      throwing.canPlayType.mockImplementation(() => {
        throw new Error('canPlayType failed');
      });
      const withoutDocument = makeFullScope();
      removeApi(withoutDocument.scope, 'document');
      const failingCreate = makeFullScope();
      failingCreate.createElement.mockImplementation(() => {
        throw new Error('createElement failed');
      });

      for (const { scope } of [throwing, withoutDocument, failingCreate]) {
        expect(detectCapabilities(scope).mediaTypeDeclarations.map(({ answer }) => answer)).toEqual(
          ['not-evaluated', 'not-evaluated'],
        );
      }
    });
  });

  describe('side effects and repeatability', () => {
    it('never calls, constructs, or opens the APIs it observes', () => {
      const { scope, effects } = makeFullScope();

      detectCapabilities(scope);
      detectCapabilities(scope);

      for (const [name, spy] of Object.entries(effects)) {
        expect(spy, name).not.toHaveBeenCalled();
      }
    });

    it('gives the same report on every run and leaves the scope unchanged', () => {
      const { scope, createElement } = makeFullScope();
      const keysBefore = Object.keys(scope);

      const first = detectCapabilities(scope);
      const runs = Array.from({ length: 5 }, () => detectCapabilities(scope));

      for (const report of runs) {
        expect(report).toEqual(first);
      }
      expect(Object.keys(scope)).toEqual(keysBefore);
      // Each run uses its own detached element and keeps none.
      expect(createElement).toHaveBeenCalledTimes(6);
    });

    it('observes a real jsdom global scope without throwing', () => {
      const report = detectCapabilities(globalThis);

      expect(report.foundation).toHaveLength(5);
      expect(report.laterPhase).toHaveLength(5);
      expect(statusOf(report, 'file-api')).toBe(
        typeof File === 'function' && typeof Blob === 'function' ? 'available' : 'not-available',
      );
    });
  });
});
