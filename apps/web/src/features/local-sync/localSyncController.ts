import { PlaybackSyncController, type PlaybackMedia } from './playbackSyncController.ts';
import { isPlaybackBody } from '@driftless/sync-engine';
import {
  encodeBase64Url,
  isMediaSelectionId,
  MEDIA_SELECTION_ID_BYTES,
  type ApplicationBody,
  type MediaSelectionId,
  type SessionId,
} from '@driftless/protocol';
import {
  fingerprintMedia,
  FingerprintError,
  initialLocalSyncState,
  reduceLocalSync,
  type LocalSyncEvent,
  type Sha256,
} from '@driftless/sync-engine';
import type { LocalMediaSelection } from '../local-media/localMediaState.ts';

export interface LocalSyncAdapters {
  readonly selectionId: () => MediaSelectionId;
  readonly sha256: Sha256;
}
const browserAdapters: LocalSyncAdapters = {
  selectionId: () => {
    const id = encodeBase64Url(crypto.getRandomValues(new Uint8Array(MEDIA_SELECTION_ID_BYTES)));
    if (!isMediaSelectionId(id)) throw new Error('Media selection generation failed.');
    return id;
  },
  sha256: async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
};
/** Owns one selected File reference, one cancellable reader, and a pure reducer. */
export class LocalSyncController {
  #video: PlaybackMedia | null = null;
  #state = initialLocalSyncState;
  readonly #listeners = new Set<() => void>();
  readonly playback: PlaybackSyncController;
  #file: File | null = null;
  #playerId: number | null = null;
  #sessionId: SessionId | null = null;
  #abort: AbortController | undefined;
  #fingerprintRunning = false;
  #send: ((body: ApplicationBody) => boolean) | undefined;
  readonly adapters: LocalSyncAdapters;
  #playback: LocalMediaSelection['status'] = 'loading';
  constructor(adapters: LocalSyncAdapters = browserAdapters) {
    this.adapters = adapters;
    this.playback = new PlaybackSyncController(this, (body) => this.#send?.(body) === true);
  }
  getState = () => this.#state;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  dispatch(event: LocalSyncEvent): void {
    const result = reduceLocalSync(this.#state, event);
    this.#state = result.state;
    for (const effect of result.effects) {
      if (this.#send?.(effect) !== true) {
        this.#send = undefined;
        this.#state = reduceLocalSync(this.#state, { type: 'channel', connected: false }).state;
        break;
      }
    }
    for (const listener of [...this.#listeners]) listener();
  }
  attachVideo(video: PlaybackMedia | null, playerId: number): void {
    if (playerId !== this.#playerId) return;
    this.#video = video;
    const id = this.#state.local?.selectionId;
    if (id) this.playback.attach(video, id);
  }
  /** Called synchronously with local-player actions, before React renders. */
  updateMedia(selection: LocalMediaSelection | null): void {
    this.#playback = selection?.status ?? 'loading';
    if (selection?.id !== this.#playerId && selection !== null) {
      if (this.#state.local) this.playback.attach(null, this.#state.local.selectionId);
      this.#video = null;
      this.#abort?.abort();
      this.#file = selection.file;
      this.#playerId = selection.id;
      this.dispatch({
        type: 'select',
        selectionId: this.adapters.selectionId(),
        byteLength: selection.file.size,
      });
      this.#startFingerprint();
    } else if (selection === null && this.#file !== null) {
      if (this.#state.local) this.playback.attach(null, this.#state.local.selectionId);
      this.#video = null;
      this.#abort?.abort();
      this.#file = null;
      this.#playerId = null;
      this.dispatch({ type: 'clear' });
    }
    if (selection && this.#state.local)
      this.dispatch({
        type: 'playback',
        selectionId: this.#state.local.selectionId,
        status: selection.status,
      });
  }
  setRoom(sessionId: SessionId | null): void {
    if (sessionId === this.#sessionId) return;
    this.#abort?.abort();
    this.setChannel(undefined);
    this.#sessionId = sessionId;
    // Private identity belongs to the room; never reuse its wire fingerprint.
    if (this.#file) {
      this.dispatch({
        type: 'select',
        selectionId: this.adapters.selectionId(),
        byteLength: this.#file.size,
      });
      if (this.#state.local)
        this.dispatch({
          type: 'playback',
          selectionId: this.#state.local.selectionId,
          status: this.#playback,
        });
      if (this.#state.local && this.#video)
        this.playback.attach(this.#video, this.#state.local.selectionId);
      this.#startFingerprint();
    }
  }
  setChannel(send: ((body: ApplicationBody) => boolean) | undefined): void {
    this.#send = send;
    this.dispatch({ type: 'channel', connected: send !== undefined });
  }
  receive(body: ApplicationBody): void {
    if (isPlaybackBody(body)) this.playback.receive(body);
    else this.dispatch({ type: 'receive', body });
  }
  shutdown(): void {
    if (this.#state.local) this.playback.attach(null, this.#state.local.selectionId);
    this.#video = null;
    this.#abort?.abort();
    this.#send = undefined;
    this.#file = null;
    this.#sessionId = null;
    this.#state = initialLocalSyncState;
    this.#playerId = null;
    for (const listener of [...this.#listeners]) listener();
  }
  #startFingerprint(): void {
    const file = this.#file;
    const local = this.#state.local;
    const sessionId = this.#sessionId;
    // Blob reads/digests cannot be physically aborted. Drain the single old
    // operation before starting the latest selection; never queue File copies.
    if (
      this.#fingerprintRunning ||
      !file ||
      !local ||
      !sessionId ||
      local.fingerprint ||
      local.failure
    )
      return;
    this.#fingerprintRunning = true;
    const abort = new AbortController();
    this.#abort = abort;
    const current = () => !abort.signal.aborted && this.#abort === abort;
    void fingerprintMedia({
      source: { size: file.size, read: (start, end) => file.slice(start, end).arrayBuffer() },
      sessionId,
      sha256: this.adapters.sha256,
      signal: abort.signal,
      onProgress: (processed, total) => {
        if (current())
          this.dispatch({
            type: 'progress',
            selectionId: local.selectionId,
            progress: Math.floor((processed / total) * 10) * 10,
          });
      },
    })
      .then(
        (fingerprint) => {
          if (current())
            this.dispatch({ type: 'fingerprint', selectionId: local.selectionId, fingerprint });
        },
        (error: unknown) => {
          if (current())
            this.dispatch({
              type: 'failure',
              selectionId: local.selectionId,
              failure: error instanceof FingerprintError ? error.category : 'HASH_FAILED',
            });
        },
      )
      .finally(() => {
        this.#fingerprintRunning = false;
        this.#startFingerprint();
      });
  }
}
