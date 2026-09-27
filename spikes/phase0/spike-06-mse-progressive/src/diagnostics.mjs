// Bounded diagnostics for Spike 0.6: an event timeline, an append log, periodic
// playback samples, and accounting of every resource the pipeline owns (object URLs,
// timers, listeners, frame callbacks) so cleanup can be checked rather than assumed.

export const DIAG_LIMITS = Object.freeze({
  timeline: 4000,
  appendLog: 4000,
  appendLogHead: 64,
  samples: 20_000,
  seeks: 64,
  stalls: 256,
});

/** Fixed-capacity ring buffer that keeps the first `head` entries permanently. */
export class BoundedLog {
  constructor(capacity, head = 0) {
    this.capacity = capacity;
    this.headCapacity = head;
    this.head = [];
    this.ring = [];
    this.dropped = 0;
    this.total = 0;
  }

  push(entry) {
    this.total += 1;
    if (this.head.length < this.headCapacity) {
      this.head.push(entry);
      return entry;
    }
    this.ring.push(entry);
    if (this.ring.length > this.capacity - this.headCapacity) {
      this.ring.shift();
      this.dropped += 1;
    }
    return entry;
  }

  entries() {
    return [...this.head, ...this.ring];
  }

  last(n = 1) {
    const all = this.entries();
    return all.slice(Math.max(0, all.length - n));
  }

  get length() {
    return this.head.length + this.ring.length;
  }

  clear() {
    this.head = [];
    this.ring = [];
  }
}

/** Keep the first `head` and last `tail` items of a list for bounded JSON evidence. */
export function trimForEvidence(list, head = 20, tail = 20) {
  if (list.length <= head + tail) return list;
  return [...list.slice(0, head), { omitted: list.length - head - tail }, ...list.slice(-tail)];
}

export class Recorder {
  constructor(now = () => performance.now()) {
    this.now = now;
    this.reset();
  }

  reset() {
    this.t0 = this.now();
    this.timeline = new BoundedLog(DIAG_LIMITS.timeline, 200);
    this.appendLog = new BoundedLog(DIAG_LIMITS.appendLog, DIAG_LIMITS.appendLogHead);
    this.samples = new BoundedLog(DIAG_LIMITS.samples);
    this.seeks = new BoundedLog(DIAG_LIMITS.seeks);
    this.stalls = new BoundedLog(DIAG_LIMITS.stalls);
    this.counts = Object.create(null);
    this.listeners = new Set();
  }

  /** Milliseconds since the recorder (session) started, 0.1 ms resolution. */
  t() {
    return Math.round((this.now() - this.t0) * 10) / 10;
  }

  count(type) {
    this.counts[type] = (this.counts[type] ?? 0) + 1;
  }

  event(type, detail = {}) {
    this.count(type);
    const entry = { t: this.t(), type, ...detail };
    this.timeline.push(entry);
    for (const l of this.listeners) l(entry);
    return entry;
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * Tracks resources created on behalf of one pipeline session. Everything is created
 * through this object so a report after teardown can show that nothing is left live.
 */
export class ResourceTracker {
  constructor(env = globalThis) {
    this.env = env;
    this.urls = new Set();
    this.timeouts = new Set();
    this.intervals = new Set();
    this.frameCallbacks = new Set();
    this.totals = { urlsCreated: 0, urlsRevoked: 0, timeoutsCreated: 0, intervalsCreated: 0, listenersAdded: 0, frameCallbacks: 0 };
    this.controllers = new Set();
  }

  createObjectURL(obj) {
    const url = this.env.URL.createObjectURL(obj);
    this.urls.add(url);
    this.totals.urlsCreated += 1;
    return url;
  }

  revokeObjectURL(url) {
    if (!url || !this.urls.has(url)) return false;
    this.env.URL.revokeObjectURL(url);
    this.urls.delete(url);
    this.totals.urlsRevoked += 1;
    return true;
  }

  setTimeout(fn, ms) {
    const id = this.env.setTimeout(() => {
      this.timeouts.delete(id);
      fn();
    }, ms);
    this.timeouts.add(id);
    this.totals.timeoutsCreated += 1;
    return id;
  }

  clearTimeout(id) {
    if (id === undefined) return;
    this.env.clearTimeout(id);
    this.timeouts.delete(id);
  }

  setInterval(fn, ms) {
    const id = this.env.setInterval(fn, ms);
    this.intervals.add(id);
    this.totals.intervalsCreated += 1;
    return id;
  }

  clearInterval(id) {
    if (id === undefined) return;
    this.env.clearInterval(id);
    this.intervals.delete(id);
  }

  /** A listener group: every listener added through it is removed by abort(). */
  listenerGroup() {
    const controller = new AbortController();
    this.controllers.add(controller);
    const group = {
      signal: controller.signal,
      added: 0,
      on: (target, type, handler) => {
        target.addEventListener(type, handler, { signal: controller.signal });
        group.added += 1;
        this.totals.listenersAdded += 1;
      },
      abort: () => {
        controller.abort();
        this.controllers.delete(controller);
      },
    };
    return group;
  }

  trackFrameCallback(video, handle) {
    this.frameCallbacks.add(handle);
    this.totals.frameCallbacks += 1;
    return { video, handle };
  }

  releaseFrameCallback(video, handle) {
    if (!this.frameCallbacks.has(handle)) return;
    this.frameCallbacks.delete(handle);
    try {
      video.cancelVideoFrameCallback?.(handle);
    } catch {
      // The element may already be detached; the handle is dropped either way.
    }
  }

  report() {
    return {
      liveObjectUrls: this.urls.size,
      liveTimeouts: this.timeouts.size,
      liveIntervals: this.intervals.size,
      liveFrameCallbacks: this.frameCallbacks.size,
      liveListenerGroups: this.controllers.size,
      totals: { ...this.totals },
    };
  }
}

// ---------- formatting (all rendering goes through textContent) ----------

export function displayName(name) {
  const clean = String(name ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "�");
  return clean.length > 120 ? `${clean.slice(0, 117)}…` : clean;
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return u === 0 ? `${n} B` : `${v.toFixed(2)} ${units[u]}`;
}

export function fmtClock(s) {
  if (!Number.isFinite(s)) return "—";
  const sign = s < 0 ? "-" : "";
  const a = Math.abs(s);
  const h = Math.floor(a / 3600);
  const m = Math.floor((a % 3600) / 60);
  const sec = (a % 60).toFixed(2).padStart(5, "0");
  return h ? `${sign}${h}:${String(m).padStart(2, "0")}:${sec}` : `${sign}${String(m).padStart(2, "0")}:${sec}`;
}

export const round = (n, d = 3) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : n);
