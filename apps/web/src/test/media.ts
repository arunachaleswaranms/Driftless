import { fireEvent } from '@testing-library/react';
import { onTestFinished, vi } from 'vitest';

export interface ObjectUrlRegistry {
  /** Every URL created, in order. */
  readonly created: readonly string[];
  /** Every revocation, in order, including any repeated or unknown URL. */
  readonly revoked: readonly string[];
  /** URLs created and not yet revoked. */
  active(): string[];
  /** The object a URL was created for. */
  objectFor(url: string): unknown;
  /** Runs `listener` at the moment each revocation is requested. */
  onRevoke(listener: (url: string) => void): void;
}

/**
 * Replaces `URL.createObjectURL` and `URL.revokeObjectURL`, which jsdom does
 * not implement, with a recording fake for the current test.
 */
export function installObjectUrlRegistry(): ObjectUrlRegistry {
  const created: string[] = [];
  const revoked: string[] = [];
  const objects = new Map<string, unknown>();
  const revokeListeners: ((url: string) => void)[] = [];
  const originals = {
    createObjectURL: Object.getOwnPropertyDescriptor(URL, 'createObjectURL'),
    revokeObjectURL: Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL'),
  };

  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: (object: unknown) => {
      const url = `blob:http://localhost:3000/object-${String(created.length + 1)}`;
      created.push(url);
      objects.set(url, object);
      return url;
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: (url: string) => {
      for (const listener of revokeListeners) {
        listener(url);
      }
      revoked.push(url);
    },
  });

  onTestFinished(() => {
    for (const [name, descriptor] of Object.entries(originals)) {
      if (descriptor) {
        Object.defineProperty(URL, name, descriptor);
      } else {
        Reflect.deleteProperty(URL, name);
      }
    }
  });

  return {
    created,
    revoked,
    active: () => created.filter((url) => !revoked.includes(url)),
    objectFor: (url) => objects.get(url),
    onRevoke: (listener) => {
      revokeListeners.push(listener);
    },
  };
}

/**
 * Stubs the media element methods jsdom does not implement, so tests can
 * observe how the player detaches its media.
 */
export function stubMediaElementMethods() {
  return {
    pause: vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined),
    load: vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined),
    play: vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined),
  };
}

function defineReadonly(target: object, name: string, value: unknown) {
  Object.defineProperty(target, name, { configurable: true, value });
}

/** Makes the element report metadata, then fires `loadedmetadata`. */
export function reportLoadedMetadata(
  video: HTMLVideoElement,
  metadata: { duration: number; width: number; height: number },
) {
  defineReadonly(video, 'duration', metadata.duration);
  defineReadonly(video, 'videoWidth', metadata.width);
  defineReadonly(video, 'videoHeight', metadata.height);
  fireEvent.loadedMetadata(video);
}

/** Makes the element report a new duration, then fires `durationchange`. */
export function reportDurationChange(video: HTMLVideoElement, duration: number) {
  defineReadonly(video, 'duration', duration);
  fireEvent.durationChange(video);
}

/** Makes the element report a `MediaError`, then fires `error`. */
export function reportMediaError(video: HTMLVideoElement, code: number, message = '') {
  defineReadonly(video, 'error', { code, message });
  fireEvent.error(video);
}

/** A small in-memory file standing in for a user's local video. */
export function makeVideoFile(name: string, size = 1024, type = 'video/mp4'): File {
  return new File([new Uint8Array(size)], name, { type });
}
