export interface ScheduledTask {
  cancel(): void;
}

/** Periodic task scheduling, injectable so tests can drive time explicitly. */
export interface Scheduler {
  every(intervalMs: number, task: () => void): ScheduledTask;
}

export const timerScheduler: Scheduler = {
  every(intervalMs, task) {
    const handle = setInterval(task, intervalMs);
    // The HTTP server keeps the process alive; this timer alone must not.
    handle.unref();
    return {
      cancel() {
        clearInterval(handle);
      },
    };
  },
};
