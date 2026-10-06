/** Provisional implementation thresholds; Phase 3D acceptance is separate. */
export const DRIFT_SETTLED_MS = 75;
export const DRIFT_RATE_START_MS = 150;
export const DRIFT_HARD_SEEK_MS = 750;
export const PAUSED_DRIFT_SEEK_MS = 100;
export const DRIFT_SPEED_UP_RATE = 1.05;
export const DRIFT_SLOW_DOWN_RATE = 0.95;
export type DriftCorrection = 'NORMAL_RATE' | 'SPEED_UP' | 'SLOW_DOWN';
export type DriftDecision = DriftCorrection | 'NONE' | 'SEEK';
export function correctionRate(correction: DriftCorrection): number {
  return correction === 'SPEED_UP'
    ? DRIFT_SPEED_UP_RATE
    : correction === 'SLOW_DOWN'
      ? DRIFT_SLOW_DOWN_RATE
      : 1;
}
/** drift = guestActual - expectedHost: negative behind, positive ahead. */
export function driftPolicy(
  mode: 'playing' | 'paused',
  driftMs: number,
  current: DriftCorrection,
): DriftDecision {
  if (!Number.isFinite(driftMs)) return 'NONE';
  const magnitude = Math.abs(driftMs);
  if (mode === 'paused') return magnitude >= PAUSED_DRIFT_SEEK_MS ? 'SEEK' : 'NORMAL_RATE';
  if (magnitude >= DRIFT_HARD_SEEK_MS) return 'SEEK';
  if (magnitude <= DRIFT_SETTLED_MS) return 'NORMAL_RATE';
  if (current === 'SPEED_UP') return driftMs > 0 ? 'NORMAL_RATE' : 'SPEED_UP';
  if (current === 'SLOW_DOWN') return driftMs < 0 ? 'NORMAL_RATE' : 'SLOW_DOWN';
  if (driftMs <= -DRIFT_RATE_START_MS) return 'SPEED_UP';
  if (driftMs >= DRIFT_RATE_START_MS) return 'SLOW_DOWN';
  return 'NORMAL_RATE';
}
