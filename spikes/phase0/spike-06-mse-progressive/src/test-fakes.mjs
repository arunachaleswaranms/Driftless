// Test-only fakes: a SourceBuffer that enforces the MSE `updating` contract, and a
// controllable clock/timer set for the delivery scheduler.

/**
 * Minimal SourceBuffer model. appendBuffer()/remove() throw InvalidStateError while
 * `updating` (as browsers do), and completion follows the MSE event order:
 * success → update, updateend; append error → error, updateend; abort() → abort, updateend.
 */
export class FakeSourceBuffer extends EventTarget {
  constructor({ auto = true } = {}) {
    super();
    this.updating = false;
    this.auto = auto;
    this.calls = [];
    this.violations = 0;
    this.quotaThrows = 0;
    this.failNext = false;
    this.pending = undefined;
  }

  appendBuffer(buf) {
    if (this.updating) {
      this.violations += 1;
      throw new DOMException("SourceBuffer is updating", "InvalidStateError");
    }
    if (this.quotaThrows > 0) {
      this.quotaThrows -= 1;
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    }
    this.updating = true;
    this.calls.push({ type: "append", bytes: buf.byteLength, marker: new Uint8Array(buf.buffer ?? buf, 0, Math.min(1, buf.byteLength))[0] });
    const fail = this.failNext;
    this.failNext = false;
    this.pending = () => this.#finish(fail);
    if (this.auto) queueMicrotask(() => this.completeNow());
  }

  remove(start, end) {
    if (this.updating) {
      this.violations += 1;
      throw new DOMException("SourceBuffer is updating", "InvalidStateError");
    }
    this.updating = true;
    this.calls.push({ type: "remove", start, end });
    this.pending = () => this.#finish(false);
    if (this.auto) queueMicrotask(() => this.completeNow());
  }

  abort() {
    if (!this.updating) return;
    this.pending = undefined;
    this.updating = false;
    this.dispatchEvent(new Event("abort"));
    this.dispatchEvent(new Event("updateend"));
  }

  completeNow() {
    const p = this.pending;
    this.pending = undefined;
    p?.();
  }

  #finish(fail) {
    this.updating = false;
    if (fail) this.dispatchEvent(new Event("error"));
    else this.dispatchEvent(new Event("update"));
    this.dispatchEvent(new Event("updateend"));
  }
}

export const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Virtual clock with setTimeout/clearTimeout; advance() runs due timers in order. */
export function fakeTimers() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      nextId += 1;
      timers.set(nextId, { at: now + Math.max(0, ms), fn });
      return nextId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    get pending() {
      return timers.size;
    },
    async advance(ms) {
      const end = now + ms;
      await flush();
      for (;;) {
        let dueId;
        let due;
        for (const [id, t] of timers) if (t.at <= end && (!due || t.at < due.at)) [dueId, due] = [id, t];
        if (!due) break;
        timers.delete(dueId);
        now = due.at;
        due.fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}
