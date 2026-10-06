import type {
  ApplicationBody,
  MediaSelectionId,
  ParticipantRole,
  PlaybackBody,
  SyncBody,
} from '@driftless/protocol';
import {
  guestPlayback,
  hostPlayback,
  initialPlaybackState,
  playbackReadiness,
  readinessBlock,
} from '@driftless/sync-engine';
import { ContinuousSyncController, type SyncAdapters } from './continuousSyncController.ts';
import type { LocalSyncController } from './localSyncController.ts';

/** Focused adapter: no File, object URL or transport context. */
export interface PlaybackMedia extends EventTarget {
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  playbackRate: number;
  controls: boolean;
  play(): Promise<void>;
  pause(): void;
}
const PREPARATION_ERROR = 'Could not prepare synchronized playback. Try Ready again.';
const PLAY_ERROR = 'Synchronized playback is unavailable. Try Ready again.';
export function positionMilliseconds(seconds: number): number {
  return Number.isFinite(seconds)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(seconds * 1000)))
    : 0;
}
export function formatPlaybackPosition(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
}
export class PlaybackSyncController {
  #state = {
    authority: initialPlaybackState,
    role: null as ParticipantRole | null,
    preparing: false,
    error: null as string | null,
    durationMs: 0,
  };
  #video: PlaybackMedia | null = null;
  #selectionId: MediaSelectionId | null = null;
  #detach: (() => void) | undefined;
  #generation = 0;
  #internalSeek = false;
  #operating = false;
  #playAttempt = 0;
  #readyEpoch = 0;
  #readyContext = '';
  readonly #listeners = new Set<() => void>();
  readonly #unsubscribe: () => void;
  readonly continuous: ContinuousSyncController;
  readonly readiness: LocalSyncController;
  readonly send: (body: ApplicationBody) => boolean;
  constructor(
    readiness: LocalSyncController,
    send: (body: ApplicationBody) => boolean,
    syncAdapters?: SyncAdapters,
  ) {
    this.readiness = readiness;
    this.send = send;
    this.continuous = new ContinuousSyncController(
      () => ({ authority: this.#state.authority, role: this.#state.role, video: this.#video }),
      (body) => {
        const sent = this.send(body);
        if (!sent) this.readiness.setChannel(undefined);
        return sent;
      },
      (position) => this.#seek(position),
      () => {
        this.#unavailable();
      },
      syncAdapters,
    );
    this.#unsubscribe = readiness.subscribe(() => {
      this.#reconcile();
    });
  }
  getState = () => this.#state;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #notify(): void {
    this.continuous.update();
    for (const listener of [...this.#listeners]) listener();
  }
  setRole(role: ParticipantRole | null): void {
    this.#state = { ...this.#state, role };
    this.#reconcile();
  }
  attach(video: PlaybackMedia | null, selectionId: MediaSelectionId): void {
    if (video === null && selectionId !== this.#selectionId) return;
    if (video && selectionId !== this.readiness.getState().local?.selectionId) return;
    if (video === this.#video && selectionId === this.#selectionId) return;
    this.continuous.reset();
    this.#detach?.();
    this.#generation++;
    this.#pause();
    this.#video = video;
    this.#selectionId = video ? selectionId : null;
    this.#internalSeek = false;
    this.#state = {
      ...this.#state,
      authority: initialPlaybackState,
      preparing: false,
      error: null,
    };
    if (video) {
      const generation = this.#generation;
      const handle = (event: Event) => {
        if (this.#video !== video || generation !== this.#generation) return;
        if (event.type === 'durationchange') {
          this.#reconcile();
          return;
        }
        if (!this.#state.authority.active || this.#state.preparing || this.#operating) return;
        if (event.type === 'ratechange') {
          if (this.#state.role === 'host') this.#normalRate();
          else this.continuous.enforceRate();
          return;
        }
        if (this.#state.role !== 'host') return;
        if (event.type === 'seeked') {
          if (this.#internalSeek) {
            this.#internalSeek = false;
            return;
          }
          this.#commit('SEEK');
        } else if (
          (event.type === 'pause' || event.type === 'ended') &&
          video.paused &&
          this.#state.authority.mode !== 'paused'
        )
          this.#commit('PAUSE');
        else if (event.type === 'play' && !video.paused && this.#state.authority.mode !== 'playing')
          this.#commit('PLAY');
      };
      const events = ['play', 'pause', 'seeked', 'ended', 'ratechange', 'durationchange'];
      for (const event of events) video.addEventListener(event, handle);
      this.#detach = () => {
        for (const event of events) video.removeEventListener(event, handle);
        video.controls = true;
      };
    } else this.#detach = undefined;
    this.#reconcile();
  }
  async ready(): Promise<void> {
    const video = this.#video,
      id = this.#selectionId,
      generation = this.#generation,
      epoch = this.#readyEpoch;
    if (
      this.#state.preparing ||
      this.readiness.getState().localReady ||
      readinessBlock(this.readiness.getState()) !== null
    )
      return;
    if (!video || id !== this.readiness.getState().local?.selectionId) {
      this.#error(PREPARATION_ERROR);
      return;
    }
    const position = video.currentTime;
    this.#state = { ...this.#state, preparing: true, error: null };
    this.#notify();
    let success = false;
    try {
      await video.play();
      success = true;
    } catch {
      /* Fixed message only. */
    }
    if (generation !== this.#generation || video !== this.#video) return;
    this.#pause();
    success = this.#seekSeconds(position) && success;
    this.#state = { ...this.#state, preparing: false, error: success ? null : PREPARATION_ERROR };
    this.#notify();
    if (success && epoch === this.#readyEpoch && readinessBlock(this.readiness.getState()) === null)
      this.readiness.dispatch({
        type: 'ready',
        readinessId: this.readiness.adapters.readinessId(),
      });
  }
  async play(): Promise<void> {
    if (!this.#canHost() || !this.#video) return;
    await this.#play(true);
  }
  pause(): void {
    if (this.#canHost()) {
      this.#pause();
      this.#commit('PAUSE');
    }
  }
  seek(positionMs: number): void {
    if (!this.#canHost()) return;
    if (this.#seek(positionMs)) this.#commit('SEEK');
    else this.#unavailable();
  }
  receiveSync(body: SyncBody): void {
    this.continuous.receive(body);
  }
  receive(body: PlaybackBody): void {
    if (this.#state.role !== 'guest' || !this.#video) return;
    const next = guestPlayback(this.#state.authority, body);
    if (next === this.#state.authority) return;
    this.continuous.resetCorrection();
    this.#state = { ...this.#state, authority: next, error: null };
    this.#video.controls = false;
    this.#normalRate();
    if (body.type === 'PAUSE') this.#pause();
    if (!this.#seek(body.payload.positionMs)) {
      this.#unavailable();
      return;
    }
    if (body.type === 'PLAY') void this.#play();
    this.#notify();
  }
  #canHost(): boolean {
    return this.#state.role === 'host' && this.#state.authority.active;
  }
  #commit(type: PlaybackBody['type']): void {
    const result = hostPlayback(
      this.#state.authority,
      this.#state.role,
      type,
      positionMilliseconds(this.#video?.currentTime ?? 0),
    );
    if (!result.command) return;
    this.#state = { ...this.#state, authority: result.state };
    this.#normalRate();
    if (!this.send(result.command)) this.readiness.setChannel(undefined);
    this.#notify();
  }
  #reconcile(): void {
    const ready = this.readiness.getState();
    const context = `${String(ready.connected)}:${ready.local?.selectionId ?? ''}:${ready.remote?.selectionId ?? ''}`;
    if (context !== this.#readyContext) {
      this.#readyEpoch++;
      this.#readyContext = context;
    }
    const validElement = this.#video && this.#selectionId === ready.local?.selectionId;
    const previous = this.#state.authority;
    const next = validElement ? playbackReadiness(previous, ready) : initialPlaybackState;
    this.#state = {
      ...this.#state,
      authority: next,
      durationMs: positionMilliseconds(this.#video?.duration ?? 0),
    };
    if (next.pair !== previous.pair && previous.pair) this.#pause();
    if (this.#video) this.#video.controls = next.pair === null;
    if (next.active && this.#state.role === 'host') this.#normalRate();
    if (next.pair && !next.active && this.#state.role === 'host') {
      this.#pause();
      this.#commit('PAUSE');
    }
    this.#notify();
  }
  #normalRate(): void {
    if (this.#video && this.#video.playbackRate !== 1) this.#video.playbackRate = 1;
  }
  #pause(): void {
    this.#playAttempt++;
    this.#operating = true;
    try {
      this.#video?.pause();
    } catch {
      /* Detaching/failed media is harmless. */
    } finally {
      this.#operating = false;
    }
  }
  #seek(ms: number): boolean {
    const video = this.#video;
    if (!video || !Number.isSafeInteger(ms) || ms < 0) return false;
    return this.#seekSeconds(ms / 1000);
  }
  #seekSeconds(seconds: number): boolean {
    const video = this.#video;
    if (!video || !Number.isFinite(seconds) || seconds < 0) return false;
    const target = Number.isFinite(video.duration)
      ? Math.min(seconds, Math.max(0, video.duration))
      : seconds;
    try {
      if (video.currentTime === target) return true;
      this.#internalSeek = true;
      video.currentTime = target;
      return true;
    } catch {
      this.#internalSeek = false;
      return false;
    }
  }
  async #play(hostCommand = false): Promise<void> {
    const video = this.#video,
      generation = this.#generation;
    if (!video) return;
    const pair = this.#state.authority.pair;
    const attempt = ++this.#playAttempt;
    let promise: Promise<void>;
    this.#operating = true;
    try {
      promise = video.play();
    } catch {
      this.#operating = false;
      this.#unavailable();
      return;
    }
    this.#operating = false;
    if (hostCommand) this.#commit('PLAY');
    try {
      await promise;
    } catch {
      if (
        video === this.#video &&
        generation === this.#generation &&
        attempt === this.#playAttempt &&
        pair === this.#state.authority.pair &&
        this.#state.authority.active &&
        this.#state.authority.mode === 'playing'
      )
        this.#unavailable();
    }
    if (
      video === this.#video &&
      pair === this.#state.authority.pair &&
      (!this.#state.authority.active || this.#state.authority.mode === 'paused')
    )
      this.#pause();
  }
  #error(error: string): void {
    this.#state = { ...this.#state, error };
    this.#notify();
  }
  #unavailable(): void {
    this.readiness.dispatch({ type: 'not-ready', reason: 'PLAYBACK_UNAVAILABLE' });
    this.#error(PLAY_ERROR);
  }
  shutdown(): void {
    this.continuous.reset();
    this.#unsubscribe();
    this.#detach?.();
    this.#generation++;
    this.#pause();
    this.#video = null;
    this.#state = { ...this.#state, authority: initialPlaybackState };
    this.#notify();
    this.#listeners.clear();
  }
}
