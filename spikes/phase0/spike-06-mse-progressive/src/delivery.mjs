// Simulated progressive arrival of planned media segments.
//
// The source media is local, so without throttling every segment would be available at
// once. The scheduler releases one planned segment at a time according to a
// deterministic profile expressed as a multiple of real-time media duration. Profiles
// are laboratory parameters; they do not model any particular network.

export const DELIVERY_PROFILES = Object.freeze({
  FAST: Object.freeze({ name: "FAST", speed: 8, description: "each segment is released after 1/8 of its media duration (8× real time)" }),
  NORMAL: Object.freeze({ name: "NORMAL", speed: 1.5, description: "each segment is released after 2/3 of its media duration (1.5× real time)" }),
  SLOW: Object.freeze({ name: "SLOW", speed: 0.5, description: "each segment is released after 2× its media duration (0.5× real time)" }),
  BURSTY: Object.freeze({
    name: "BURSTY",
    burst: 4,
    burstSpeed: 6,
    pauseFactor: 3,
    description: "4 segments at 6× real time, then a pause of 3 segment durations (≈1.09× real time on average)",
  }),
  MANUAL: Object.freeze({ name: "MANUAL", description: "nothing is released except by an explicit release()" }),
});

export function profileByName(name) {
  const p = DELIVERY_PROFILES[String(name).toUpperCase()];
  if (!p) throw new RangeError(`Unknown delivery profile '${name}'`);
  return p;
}

/**
 * Delay before the segment after `ordinal` is released. `ordinal` counts scheduled
 * (non-burst) releases so that BURSTY is a fixed, reproducible pattern.
 */
export function releaseDelayMs(profile, segmentSeconds, ordinal) {
  if (!(segmentSeconds > 0)) return 0;
  if (profile.name === "MANUAL") return Infinity;
  if (profile.burst) {
    const base = (segmentSeconds * 1000) / profile.burstSpeed;
    return ordinal % profile.burst === profile.burst - 1 ? base + segmentSeconds * 1000 * profile.pauseFactor : base;
  }
  return (segmentSeconds * 1000) / profile.speed;
}

/**
 * Which plan segments are in flight (released, not yet appended) or appended, and
 * which one the playhead needs next. Indices refer to plan.segments.
 */
export class SegmentState {
  constructor(segments) {
    this.segments = segments;
    this.appended = new Set();
    this.inFlight = new Set();
  }

  get count() {
    return this.segments.length;
  }

  markInFlight(k) {
    this.inFlight.add(k);
  }

  markAppended(k) {
    this.inFlight.delete(k);
    this.appended.add(k);
  }

  /** Forget in-flight segments whose queued appends were dropped (seek, failure). */
  dropInFlight(indices) {
    for (const k of indices) this.inFlight.delete(k);
  }

  /** Un-mark appended segments overlapping a removed time range [start, end). */
  markRemoved(start, end) {
    const removed = [];
    for (const k of this.appended) {
      const s = this.segments[k];
      if (s.startSeconds < end && s.endSeconds > start) {
        this.appended.delete(k);
        removed.push(k);
      }
    }
    return removed.sort((a, b) => a - b);
  }

  isAvailable(k) {
    return this.appended.has(k) || this.inFlight.has(k);
  }

  /** First segment index >= from that is neither appended nor in flight. */
  nextNeeded(from = 0) {
    for (let k = Math.max(0, from); k < this.segments.length; k += 1) if (!this.isAvailable(k)) return k;
    return undefined;
  }

  /** Lowest missing index overall (naive sequential delivery; ignores the playhead). */
  nextSequential() {
    return this.nextNeeded(0);
  }

  /** Contiguous available media end from segment `from` (seconds), for lookahead gating. */
  availableEndFrom(from) {
    let k = Math.max(0, from);
    while (k < this.segments.length && this.isAvailable(k)) k += 1;
    return k === Math.max(0, from) ? undefined : this.segments[k - 1].endSeconds;
  }

  allAppended() {
    return this.appended.size === this.segments.length;
  }

  snapshot() {
    const appended = [...this.appended].sort((a, b) => a - b);
    return { total: this.segments.length, appended: appended.length, inFlight: [...this.inFlight].sort((a, b) => a - b), appendedRuns: runs(appended) };
  }
}

function runs(sorted) {
  const out = [];
  for (const k of sorted) {
    const last = out[out.length - 1];
    if (last && last[1] === k - 1) last[1] = k;
    else out.push([k, k]);
  }
  return out.length > 32 ? [...out.slice(0, 16), ["…", out.length - 32], ...out.slice(-16)] : out;
}

/**
 * Releases segments one at a time. `nextIndex()` decides which segment is released next
 * (the pipeline asks the SegmentState relative to the playhead). `deliver(k)` must
 * resolve once segment k has been handed to the append queues; only one delivery is in
 * progress at a time. `gate()` can hold releases (lookahead cap) without stopping.
 */
export class DeliveryScheduler {
  constructor({ timers, profile = DELIVERY_PROFILES.NORMAL, initialSegments = 0, nextIndex, deliver, durationOf, gate = () => ({ open: true }), gateRetryMs = 250, onEvent }) {
    if (!timers?.setTimeout || !timers?.clearTimeout || !timers?.now) throw new TypeError("timers must provide setTimeout, clearTimeout, and now");
    this.timers = timers;
    this.profile = profile;
    this.initialSegments = initialSegments;
    this.nextIndex = nextIndex;
    this.deliver = deliver;
    this.durationOf = durationOf;
    this.gate = gate;
    this.gateRetryMs = gateRetryMs;
    this.onEvent = onEvent;
    this.state = "idle";
    this.timer = undefined;
    this.busy = false;
    this.ordinal = 0;
    this.urgentPending = false;
    this.stats = { released: 0, burst: 0, scheduled: 0, manual: 0, urgent: 0, gated: 0, staleSkipped: 0 };
    this.lastReleaseAt = undefined;
  }

  get timersActive() {
    return this.timer === undefined ? 0 : 1;
  }

  async start() {
    if (this.state !== "idle") return;
    this.state = "running";
    this.#event("start", { profile: this.profile.name, initialSegments: this.initialSegments });
    let released = 0;
    for (let attempt = 0; released < this.initialSegments && this.state === "running" && attempt < this.initialSegments + 8; attempt += 1) {
      const r = await this.#releaseOne("burst");
      if (r === "none") break;
      if (r === "released") released += 1;
    }
    this.#scheduleNext();
  }

  setProfile(profile) {
    this.profile = profile;
    this.#event("profile", { profile: profile.name });
    if (this.state === "running" && !this.busy) this.#scheduleNext();
  }

  /** Stop automatic releases (withhold). Explicit release() still works. */
  hold() {
    if (this.state !== "running") return;
    this.#clearTimer();
    this.state = "held";
    this.#event("hold", {});
  }

  resume() {
    if (this.state !== "held") return;
    this.state = "running";
    this.#event("resume", {});
    if (!this.busy) this.#scheduleNext();
  }

  /** Release up to n segments now, regardless of profile or hold. */
  async release(n = 1) {
    let done = 0;
    for (let attempt = 0; done < n && this.state !== "stopped" && this.state !== "done" && attempt < n + 8; attempt += 1) {
      if (this.busy) await this.#waitNotBusy();
      const r = await this.#releaseOne("manual");
      if (r === "none") break;
      if (r === "released") done += 1;
    }
    if (this.state === "running" && !this.busy) this.#scheduleNext();
    return done;
  }

  /** The playhead needs data now (seek outside the buffer): release without delay. */
  urgent() {
    this.stats.urgent += 1;
    this.#event("urgent", {});
    if (this.state === "done") this.state = "running";
    if (this.state !== "running") return;
    if (this.busy) {
      this.urgentPending = true;
      return;
    }
    this.#clearTimer();
    this.#runTimer(0);
  }

  /** Re-check after appends/removals (e.g. data was evicted or a gate may have opened). */
  poke() {
    if (this.state === "done") {
      if (this.nextIndex() === undefined) return;
      this.state = "running";
    }
    if (this.state === "running" && !this.busy && this.timer === undefined && this.profile.name !== "MANUAL") this.#scheduleNext();
  }

  stop() {
    this.#clearTimer();
    this.state = "stopped";
    this.#event("stop", {});
  }

  snapshot() {
    return { state: this.state, profile: this.profile.name, busy: this.busy, timersActive: this.timersActive, ordinal: this.ordinal, stats: { ...this.stats } };
  }

  #event(type, data) {
    this.onEvent?.({ type: `delivery-${type}`, ...data });
  }

  #clearTimer() {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  #runTimer(delay) {
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.#tick();
    }, delay);
  }

  #scheduleNext() {
    if (this.state !== "running" || this.busy || this.timer !== undefined) return;
    const k = this.nextIndex();
    if (k === undefined) {
      this.state = "done";
      this.#event("done", {});
      return;
    }
    if (this.urgentPending) {
      this.urgentPending = false;
      this.#runTimer(0);
      return;
    }
    if (this.profile.name === "MANUAL") return;
    const previous = this.lastIndex;
    const delay = previous === undefined ? 0 : releaseDelayMs(this.profile, this.durationOf(previous), this.ordinal);
    const elapsed = this.lastReleaseAt === undefined ? 0 : this.timers.now() - this.lastReleaseAt;
    this.#runTimer(Math.max(0, delay - elapsed));
  }

  async #tick() {
    if (this.state !== "running" || this.busy) return;
    const gate = this.gate();
    if (!gate.open) {
      this.stats.gated += 1;
      this.#runTimer(this.gateRetryMs);
      return;
    }
    const r = await this.#releaseOne("scheduled");
    if (r === "released") this.ordinal += 1;
    // A stale release (the playhead moved) is replaced by the new next segment at once.
    if (r === "stale") this.urgentPending = true;
    this.#scheduleNext();
  }

  /** Returns "released", "stale" (deliver declined k), or "none" (nothing left). */
  async #releaseOne(kind) {
    const k = this.nextIndex();
    if (k === undefined) {
      if (this.state === "running") {
        this.state = "done";
        this.#event("done", {});
      }
      return "none";
    }
    this.busy = true;
    let ok = false;
    try {
      ok = await this.deliver(k, kind);
    } finally {
      this.busy = false;
      this.#notifyNotBusy();
    }
    if (!ok) {
      this.stats.staleSkipped += 1;
      return "stale";
    }
    this.stats.released += 1;
    this.stats[kind] += 1;
    this.lastReleaseAt = this.timers.now();
    this.lastIndex = k;
    return "released";
  }

  #waitNotBusy() {
    return new Promise((resolve) => {
      this.notBusyWaiters ??= [];
      this.notBusyWaiters.push(resolve);
    });
  }

  #notifyNotBusy() {
    const w = this.notBusyWaiters?.splice(0) ?? [];
    for (const r of w) r();
  }
}
