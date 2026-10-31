/**
 * Delays before each signaling resume attempt after the connection is lost,
 * in milliseconds: the first attempt is immediate, then the steps grow to
 * 4 seconds and stay there. The schedule is finite: 19 attempts over
 * 59.75 seconds of delays, each attempt itself bounded by
 * RESUME_ATTEMPT_TIMEOUT_MS.
 *
 * It must outlast the service noticing that the old connection is dead.
 * A mobile network can drop a socket silently; the service then still holds
 * the old binding until its liveness check removes it (within two 5-second
 * heartbeat intervals by default), and refuses every resume until then with
 * SESSION_UNAVAILABLE, which this schedule treats as retryable. Its own
 * reconnect grace starts only then, so retrying for longer than that grace
 * is safe. Provisional.
 */
export const RECONNECT_DELAYS_MS: readonly number[] = [
  0,
  250,
  500,
  1000,
  2000,
  ...Array.from({ length: 14 }, () => 4000),
];

/**
 * Delays before each attempt to reach the service after the user leaves a
 * room while its signaling connection is reconnecting. Each attempt resumes
 * the membership only to end it at once with `ROOM_LEAVE`. Shorter than the
 * reconnect schedule, because the user is waiting to leave; finite, so a
 * service that cannot be reached leaves the cleanup to its grace period.
 * Provisional.
 */
export const LEAVE_RETRY_DELAYS_MS: readonly number[] = [0, 250, 500, 1000, 2000];

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
