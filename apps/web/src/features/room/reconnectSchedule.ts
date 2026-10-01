/**
 * Delays before each signaling resume attempt after the connection is lost,
 * in milliseconds: the first attempt is immediate. The schedule is finite,
 * its largest step is bounded, and the whole of it (15.75 s of delays) stays
 * well inside the service's default 30-second reconnect grace period. These
 * are provisional development values, not tuned for mobile networks.
 */
export const RECONNECT_DELAYS_MS: readonly number[] = [0, 250, 500, 1000, 2000, 4000, 4000, 4000];

/**
 * How long one resume attempt may take, from opening the socket to the
 * authoritative snapshot, before it is abandoned and the next one is
 * scheduled. Provisional.
 */
export const RESUME_ATTEMPT_TIMEOUT_MS = 5000;

/**
 * How long the host waits, after its own peer session fails, before it sends
 * a recovery offer unprompted. The guest's side of a failed transport
 * normally fails too and asks for recovery at once, which starts it without
 * waiting; the wait only lets a guest's intentional departure, whose peer
 * teardown can reach the host over the data channel before the service's
 * notice does, end the room's negotiation instead of starting a pointless
 * one. Provisional.
 */
export const HOST_RECOVERY_DELAY_MS = 1000;

/** Cancels a scheduled task. Idempotent. */
export type Cancel = () => void;

/**
 * One-shot timers, injectable so tests drive time explicitly. Every timer the
 * room controller sets goes through this interface.
 */
export interface Timers {
  schedule(delayMs: number, task: () => void): Cancel;
}

export const browserTimers: Timers = {
  schedule(delayMs, task) {
    const handle = setTimeout(task, delayMs);
    return () => {
      clearTimeout(handle);
    };
  },
};
