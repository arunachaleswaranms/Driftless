import { MAX_SYNC_CLOCK_MS, type SyncHeartbeat, type SyncActivation } from '@driftless/protocol';
import type { PlaybackPair, PlaybackSyncState } from './playback.js';
export const SYNC_HEARTBEAT_INTERVAL_MS = 500;
export const SYNC_MAX_SAMPLE_RTT_MS = 4000;
export const SYNC_MAX_PROJECTION_MS = 4000;
export const SYNC_MAX_PENDING_SAMPLES = 8;
export const SYNC_CLOCK_SAMPLE_WINDOW = 8;
export interface ClockSample {
  readonly offsetMs: number;
  readonly roundTripMs: number;
}
export function isSyncClock(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_SYNC_CLOCK_MS;
}
/** guestClock ≈ hostClock + offsetMs. Cooperative data, never host authority. */
export function clockSample(t1: number, t2: number, t3: number, t4: number): ClockSample | null {
  if (![t1, t2, t3, t4].every(isSyncClock) || t3 < t2 || t4 < t1) return null;
  const roundTripMs = t4 - t1 - (t3 - t2);
  const offsetMs = (t2 - t1 + (t3 - t4)) / 2;
  if (
    !Number.isSafeInteger(roundTripMs) ||
    roundTripMs < 0 ||
    roundTripMs > SYNC_MAX_SAMPLE_RTT_MS ||
    !Number.isFinite(offsetMs) ||
    !Number.isSafeInteger(Math.round(offsetMs))
  )
    return null;
  return { offsetMs: Math.round(offsetMs) || 0, roundTripMs: Math.round(roundTripMs) };
}
/** Fixed-size current-cycle state; a consumed (even invalid) probe cannot be reused. */
export class SyncClock {
  readonly #pending = new Map<number, number>();
  readonly #samples: ClockSample[] = [];
  get pendingCount(): number {
    return this.#pending.size;
  }
  get sampleCount(): number {
    return this.#samples.length;
  }
  get estimate(): ClockSample | null {
    return this.#samples.reduce<ClockSample | null>(
      (best, sample) => (best === null || sample.roundTripMs < best.roundTripMs ? sample : best),
      null,
    );
  }
  reset(): void {
    this.#pending.clear();
    this.#samples.length = 0;
  }
  capture(sequence: number, t1: number): void {
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      !isSyncClock(t1) ||
      this.#pending.has(sequence)
    )
      return;
    if (this.#pending.size === SYNC_MAX_PENDING_SAMPLES) {
      const oldest = this.#pending.keys().next().value;
      if (oldest !== undefined) this.#pending.delete(oldest);
    }
    this.#pending.set(sequence, t1);
  }
  observe(sequence: number, t2: number, t3: number, t4: number): void {
    const t1 = this.#pending.get(sequence);
    if (t1 === undefined) return;
    this.#pending.delete(sequence);
    const sample = clockSample(t1, t2, t3, t4);
    if (!sample) return;
    if (this.#samples.length === SYNC_CLOCK_SAMPLE_WINDOW) this.#samples.shift();
    this.#samples.push(sample);
  }
}
export function matchesSyncActivation(pair: PlaybackPair | null, p: SyncActivation): boolean {
  return (
    pair !== null &&
    p.localSelectionId === pair.remoteSelectionId &&
    p.remoteSelectionId === pair.localSelectionId &&
    p.localReadinessId === pair.remoteReadinessId &&
    p.remoteReadinessId === pair.localReadinessId
  );
}
export function eligibleHeartbeat(state: PlaybackSyncState, heartbeat: SyncHeartbeat): boolean {
  return (
    state.active &&
    matchesSyncActivation(state.pair, heartbeat) &&
    heartbeat.revision === state.revision &&
    heartbeat.mode === state.mode
  );
}
/** Unclamped authoritative position; browser adapter clamps against its local duration. */
export function projectPosition(p: SyncHeartbeat, receivedAtMs: number): number | null {
  if (!Number.isSafeInteger(p.positionMs) || p.positionMs < 0) return null;
  if (p.mode === 'paused') return p.positionMs;
  if (
    p.clockOffsetMs === null ||
    !Number.isSafeInteger(p.clockOffsetMs) ||
    !Number.isSafeInteger(p.roundTripMs) ||
    p.roundTripMs < 0 ||
    p.roundTripMs > SYNC_MAX_SAMPLE_RTT_MS ||
    !isSyncClock(p.capturedAtMs) ||
    !isSyncClock(receivedAtMs)
  )
    return null;
  const capturedInGuestClock = p.capturedAtMs + p.clockOffsetMs;
  const elapsed = receivedAtMs - capturedInGuestClock;
  const position = p.positionMs + elapsed;
  if (
    !Number.isSafeInteger(capturedInGuestClock) ||
    !Number.isSafeInteger(elapsed) ||
    elapsed < 0 ||
    elapsed > SYNC_MAX_PROJECTION_MS ||
    !Number.isSafeInteger(position)
  )
    return null;
  return position;
}
