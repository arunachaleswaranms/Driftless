import type { ParticipantRole, SyncBody } from '@driftless/protocol';
import {
  SyncClock,
  SYNC_HEARTBEAT_INTERVAL_MS,
  isSyncClock,
  matchesSyncActivation,
  eligibleHeartbeat,
  projectPosition,
  driftPolicy,
  correctionRate,
  type PlaybackPair,
  type PlaybackSyncState,
  type DriftCorrection,
} from '@driftless/sync-engine';
import type { PlaybackMedia } from './playbackSyncController.ts';
/** Browser/time boundary; pure engine never reads a clock or owns a timer. */
export interface SyncAdapters {
  monotonicMs(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}
export const browserSyncAdapters: SyncAdapters = {
  monotonicMs: () => Math.round(performance.now()),
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};
export interface SyncSnapshot {
  readonly authority: PlaybackSyncState;
  readonly role: ParticipantRole | null;
  readonly video: PlaybackMedia | null;
}
/** One current-cycle scheduler and bounded estimator; no history, persistence or React. */
export class ContinuousSyncController {
  readonly #clock = new SyncClock();
  #timer: unknown;
  #scheduled = false;
  #generation = 0;
  #pair: PlaybackPair | null = null;
  #video: PlaybackMedia | null = null;
  #role: ParticipantRole | null = null;
  #sequence = 1;
  #receivedSequence = 0;
  #correction: DriftCorrection = 'NORMAL_RATE';
  #lastDriftMs: number | null = null;
  readonly snapshot: () => SyncSnapshot;
  readonly send: (body: SyncBody) => boolean;
  readonly seek: (positionMs: number) => boolean;
  readonly unavailable: () => void;
  readonly adapters: SyncAdapters;
  constructor(
    snapshot: () => SyncSnapshot,
    send: (body: SyncBody) => boolean,
    seek: (positionMs: number) => boolean,
    unavailable: () => void,
    adapters: SyncAdapters = browserSyncAdapters,
  ) {
    this.snapshot = snapshot;
    this.send = send;
    this.seek = seek;
    this.unavailable = unavailable;
    this.adapters = adapters;
  }
  getState() {
    return {
      timerCount: this.#scheduled ? 1 : 0,
      pendingCount: this.#clock.pendingCount,
      sampleCount: this.#clock.sampleCount,
      nextSyncSequence: this.#sequence,
      bestRoundTripMs: this.#clock.estimate?.roundTripMs ?? null,
      hasClockEstimate: this.#clock.estimate !== null,
      lastDriftMs: this.#lastDriftMs,
      correction: this.#correction,
    };
  }
  update(): void {
    const { authority, video, role } = this.snapshot();
    const pair = authority.active && video ? authority.pair : null;
    if (pair !== this.#pair || video !== this.#video || role !== this.#role) {
      this.reset();
      this.#pair = pair;
      this.#video = video;
      this.#role = role;
    }
    if (pair && role === 'host' && !this.#scheduled) this.#schedule();
  }
  enforceRate(): void {
    if (this.#video) {
      const rate = correctionRate(this.#correction);
      if (this.#video.playbackRate !== rate) this.#video.playbackRate = rate;
    }
  }
  resetCorrection(): void {
    this.#correction = 'NORMAL_RATE';
    this.#lastDriftMs = null;
    if (this.#video && this.#video.playbackRate !== 1) this.#video.playbackRate = 1;
  }
  reset(): void {
    this.#generation++;
    if (this.#scheduled) this.adapters.clearTimeout(this.#timer);
    this.#scheduled = false;
    this.#timer = undefined;
    this.resetCorrection();
    this.#clock.reset();
    this.#sequence = 1;
    this.#receivedSequence = 0;
    this.#pair = null;
    this.#video = null;
    this.#role = null;
  }
  #schedule(): void {
    const generation = this.#generation;
    this.#scheduled = true;
    this.#timer = this.adapters.setTimeout(() => {
      if (generation !== this.#generation) return;
      this.#timer = undefined;
      // Retain scheduler ownership during a synchronous send/reconcile callback.
      this.#heartbeat();
      if (generation !== this.#generation) return;
      this.#scheduled = false;
      if (this.#pair && this.#role === 'host') this.#schedule();
    }, SYNC_HEARTBEAT_INTERVAL_MS);
  }
  #heartbeat(): void {
    const { authority, role, video } = this.snapshot();
    if (
      !authority.active ||
      !authority.pair ||
      role !== 'host' ||
      !video ||
      authority.pair !== this.#pair
    )
      return;
    const capturedAtMs = this.adapters.monotonicMs();
    const positionMs = Math.max(0, Math.round(video.currentTime * 1000));
    if (
      !isSyncClock(capturedAtMs) ||
      !Number.isSafeInteger(positionMs) ||
      !Number.isSafeInteger(this.#sequence)
    )
      return;
    const syncSequence = this.#sequence++;
    const estimate = this.#clock.estimate;
    const payload = {
      ...authority.pair,
      phase: 'HEARTBEAT' as const,
      syncSequence,
      revision: authority.revision,
      mode: authority.mode,
      positionMs,
      capturedAtMs,
      ...(estimate
        ? { clockOffsetMs: estimate.offsetMs, roundTripMs: estimate.roundTripMs }
        : { clockOffsetMs: null, roundTripMs: null }),
    };
    this.#clock.capture(syncSequence, capturedAtMs);
    this.send({ type: 'SYNC', payload });
  }
  receive(body: SyncBody): void {
    const receivedAtMs = this.adapters.monotonicMs();
    const { authority, role, video } = this.snapshot();
    const p = body.payload;
    if (
      !authority.active ||
      !authority.pair ||
      !video ||
      !matchesSyncActivation(authority.pair, p) ||
      !isSyncClock(receivedAtMs)
    )
      return;
    if (p.phase === 'OBSERVATION') {
      if (role === 'host')
        this.#clock.observe(p.syncSequence, p.guestReceivedAtMs, p.guestSentAtMs, receivedAtMs);
      return;
    }
    if (role !== 'guest' || p.syncSequence <= this.#receivedSequence) return;
    this.#receivedSequence = p.syncSequence;
    const generation = this.#generation;
    const projected = eligibleHeartbeat(authority, p) ? projectPosition(p, receivedAtMs) : null;
    if (projected !== null) {
      const durationMs = Number.isFinite(video.duration)
        ? Math.max(0, Math.round(video.duration * 1000))
        : Number.MAX_SAFE_INTEGER;
      const expected = Math.min(projected, durationMs);
      const actual = video.currentTime * 1000;
      this.#lastDriftMs = actual - expected;
      const decision = driftPolicy(p.mode, this.#lastDriftMs, this.#correction);
      if (decision === 'SEEK') {
        this.resetCorrection();
        if (!this.seek(expected)) this.unavailable();
      } else if (decision !== 'NONE') this.#correction = decision;
      if (generation === this.#generation) video.playbackRate = correctionRate(this.#correction);
    }
    if (generation !== this.#generation) return;
    const guestSentAtMs = this.adapters.monotonicMs();
    if (!isSyncClock(guestSentAtMs) || guestSentAtMs < receivedAtMs) return;
    this.send({
      type: 'SYNC',
      payload: {
        ...authority.pair,
        phase: 'OBSERVATION',
        syncSequence: p.syncSequence,
        guestReceivedAtMs: receivedAtMs,
        guestSentAtMs,
      },
    });
  }
}
