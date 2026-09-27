// Serialises every mutation of one SourceBuffer (appendBuffer / remove) behind the
// SourceBuffer's own `updating` flag and `updateend` event.
//
// Invariants:
//   - at most one operation is in flight per SourceBuffer;
//   - appendBuffer()/remove() are only called when `updating` is false and no operation
//     issued by this queue is outstanding (no timing guesses);
//   - an operation's bytes are released as soon as it completes, is cleared, or fails;
//   - after an `error` event the queue fails closed and issues nothing else.
//
// The SourceBuffer is any EventTarget exposing `updating`, `appendBuffer`, `remove`, and
// `abort`, so the same code runs against the browser and against test fakes.

export const QUEUE_LIMITS = Object.freeze({
  maxQueuedOps: 64,
  maxQueuedBytes: 96 * 1024 * 1024,
  // QuotaExceededError handling: attempts per operation before the queue fails.
  maxQuotaAttempts: 30,
});

export const QUEUE_STATES = Object.freeze(["idle", "appending", "removing", "blocked", "failed", "closed"]);

export class QueueError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "QueueError";
    this.code = code;
  }
}

let nextOpId = 1;

export class AppendQueue {
  /**
   * @param {EventTarget & {updating: boolean, appendBuffer: Function, remove: Function, abort: Function}} sourceBuffer
   * @param {object} opts
   * @param {string} [opts.label]
   * @param {() => number} [opts.now]
   * @param {(op: object) => void} [opts.onOpDone] called after each completed/aborted operation
   * @param {(failure: object) => void} [opts.onFailure]
   * @param {(op: object, error: Error) => ({removeStart: number, removeEnd: number} | {defer: true} | undefined)} [opts.onQuotaExceeded]
   */
  constructor(sourceBuffer, { label = "sb", now = () => performance.now(), onOpDone, onFailure, onQuotaExceeded, limits = QUEUE_LIMITS } = {}) {
    this.sb = sourceBuffer;
    this.label = label;
    this.now = now;
    this.onOpDone = onOpDone;
    this.onFailure = onFailure;
    this.onQuotaExceeded = onQuotaExceeded;
    this.limits = limits;
    this.ops = [];
    this.current = undefined;
    this.state = "idle";
    this.failure = undefined;
    this.errorSeen = false;
    this.idleWaiters = [];
    this.stats = {
      appendsIssued: 0,
      appendsCompleted: 0,
      appendedBytes: 0,
      removesIssued: 0,
      removesCompleted: 0,
      aborts: 0,
      errorEvents: 0,
      quotaExceeded: 0,
      cleared: 0,
      clearedBytes: 0,
      strayUpdateEnd: 0,
      // Times pump() found the SourceBuffer updating with nothing of ours in flight.
      foreignUpdating: 0,
      // Synchronous InvalidStateError from appendBuffer/remove (should stay 0).
      invalidStateThrows: 0,
      // Exceptions thrown by onOpDone; recorded so a consumer bug cannot wedge the queue.
      callbackErrors: 0,
      maxQueuedOps: 0,
      maxQueuedBytes: 0,
    };
    this.listeners = new AbortController();
    const signal = this.listeners.signal;
    sourceBuffer.addEventListener("updateend", () => this.#onUpdateEnd(), { signal });
    sourceBuffer.addEventListener("error", () => this.#onError(), { signal });
    sourceBuffer.addEventListener("abort", () => this.#onAbort(), { signal });
  }

  get pendingOps() {
    return this.ops.length;
  }

  get pendingBytes() {
    return this.ops.reduce((n, op) => n + (op.bytes?.byteLength ?? 0), 0) + (this.current?.bytes?.byteLength ?? 0);
  }

  get busy() {
    return this.current !== undefined || this.ops.length > 0;
  }

  /** Queue an append. `bytes` ownership moves to the queue; it is dropped after use. */
  append(bytes, meta = {}) {
    this.#assertOpen();
    if (!(bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(bytes)) throw new TypeError("append() needs an ArrayBuffer or view");
    if (this.ops.length >= this.limits.maxQueuedOps) throw new QueueError("QUEUE_FULL", `More than ${this.limits.maxQueuedOps} queued operations`);
    if (this.pendingBytes + bytes.byteLength > this.limits.maxQueuedBytes) throw new QueueError("QUEUE_BYTES", `Queued bytes would exceed ${this.limits.maxQueuedBytes}`);
    const op = { id: nextOpId++, type: "append", bytes, byteLength: bytes.byteLength, meta, queuedAt: this.now(), quotaAttempts: 0 };
    this.ops.push(op);
    this.#noteDepth();
    this.#pump();
    return op.id;
  }

  /** Queue a remove(start, end). */
  remove(start, end, meta = {}) {
    this.#assertOpen();
    if (!(Number.isFinite(start) && end > start)) throw new RangeError(`Invalid remove range [${start}, ${end})`);
    const op = { id: nextOpId++, type: "remove", start, end, meta, queuedAt: this.now() };
    this.ops.push(op);
    this.#noteDepth();
    this.#pump();
    return op.id;
  }

  /** Drop queued (not in-flight) operations, e.g. on a seek. Returns what was dropped. */
  clearPending(reason = "cleared") {
    const dropped = this.ops.splice(0);
    let bytes = 0;
    for (const op of dropped) {
      bytes += op.bytes?.byteLength ?? 0;
      op.bytes = null;
      op.dropped = reason;
    }
    this.stats.cleared += dropped.length;
    this.stats.clearedBytes += bytes;
    if (this.state === "blocked") this.state = "idle";
    this.#resolveIfIdle();
    return { ops: dropped.length, bytes, metas: dropped.map((op) => ({ type: op.type, ...op.meta })) };
  }

  /**
   * Abort the in-flight append with SourceBuffer.abort(). Per MSE this fires `abort` then
   * `updateend` and resets the segment parser; a partially parsed append is discarded.
   */
  abortCurrent() {
    if (!this.current || !this.sb.updating || this.current.type !== "append") return false;
    this.current.abortRequested = true;
    this.sb.abort();
    return true;
  }

  /** Retry a deferred (QuotaExceededError) operation. */
  resume() {
    if (this.state !== "blocked") return;
    this.state = "idle";
    this.#pump();
  }

  /** Resolves when nothing is queued or in flight (or the queue failed/closed). */
  whenIdle() {
    if (!this.busy && !this.sb.updating) return Promise.resolve(this.state);
    if (this.state === "failed" || this.state === "closed") return Promise.resolve(this.state);
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Detach listeners and drop everything. Does not touch the SourceBuffer itself. */
  close() {
    if (this.state === "closed") return;
    this.listeners.abort();
    this.clearPending("closed");
    if (this.current) {
      this.current.bytes = null;
      this.current = undefined;
    }
    this.state = "closed";
    this.#resolveWaiters();
  }

  snapshot() {
    return {
      label: this.label,
      state: this.state,
      updating: Boolean(this.sb.updating),
      pendingOps: this.ops.length,
      pendingBytes: this.pendingBytes,
      inFlight: this.current ? { type: this.current.type, ...this.current.meta } : undefined,
      failure: this.failure,
      lastCallbackError: this.lastCallbackError,
      stats: { ...this.stats },
    };
  }

  #assertOpen() {
    if (this.state === "closed") throw new QueueError("QUEUE_CLOSED", "Queue is closed");
    if (this.state === "failed") throw new QueueError("QUEUE_FAILED", `Queue failed: ${this.failure?.code}`);
  }

  #noteDepth() {
    this.stats.maxQueuedOps = Math.max(this.stats.maxQueuedOps, this.ops.length);
    this.stats.maxQueuedBytes = Math.max(this.stats.maxQueuedBytes, this.pendingBytes);
  }

  #pump() {
    if (this.state === "failed" || this.state === "closed" || this.state === "blocked") return;
    if (this.current) return;
    if (this.sb.updating) {
      // Something else is updating this SourceBuffer; wait for its updateend.
      this.stats.foreignUpdating += 1;
      return;
    }
    const op = this.ops.shift();
    if (!op) {
      this.state = "idle";
      this.#resolveIfIdle();
      return;
    }
    this.current = op;
    op.startedAt = this.now();
    try {
      if (op.type === "append") {
        this.stats.appendsIssued += 1;
        this.state = "appending";
        this.sb.appendBuffer(op.bytes);
      } else {
        this.stats.removesIssued += 1;
        this.state = "removing";
        this.sb.remove(op.start, op.end);
      }
    } catch (e) {
      this.current = undefined;
      this.#onSyncThrow(op, e);
    }
  }

  #onSyncThrow(op, e) {
    if (e?.name === "QuotaExceededError" && op.type === "append") {
      this.stats.quotaExceeded += 1;
      op.quotaAttempts += 1;
      const plan = op.quotaAttempts <= this.limits.maxQuotaAttempts ? this.onQuotaExceeded?.(op, e) : undefined;
      if (plan && Number.isFinite(plan.removeStart) && plan.removeEnd > plan.removeStart) {
        this.ops.unshift(op);
        this.ops.unshift({ id: nextOpId++, type: "remove", start: plan.removeStart, end: plan.removeEnd, meta: { reason: "quota-eviction", forOp: op.id }, queuedAt: this.now() });
        this.state = "idle";
        this.#pump();
        return;
      }
      if (plan?.defer) {
        this.ops.unshift(op);
        this.state = "blocked";
        return;
      }
      this.#fail("QUOTA_EXCEEDED", `appendBuffer threw QuotaExceededError ${op.quotaAttempts} time(s): ${e.message}`, op);
      return;
    }
    if (e?.name === "InvalidStateError") this.stats.invalidStateThrows += 1;
    this.#fail(e?.name === "InvalidStateError" ? "INVALID_STATE" : "OPERATION_THREW", `${op.type} threw ${e?.name}: ${e?.message}`, op);
  }

  #onUpdateEnd() {
    const op = this.current;
    if (!op) {
      this.stats.strayUpdateEnd += 1;
      this.#pump();
      return;
    }
    this.current = undefined;
    op.endedAt = this.now();
    if (op.type === "append") {
      if (!op.aborted && !this.errorSeen) {
        this.stats.appendsCompleted += 1;
        this.stats.appendedBytes += op.byteLength;
      }
    } else {
      this.stats.removesCompleted += 1;
    }
    op.bytes = null;
    if (this.errorSeen) {
      op.error = true;
      this.#notifyDone(op);
      this.#fail("APPEND_ERROR", `SourceBuffer '${this.label}' fired error during ${op.type} ${op.id}`, op);
      return;
    }
    this.state = "idle";
    this.#notifyDone(op);
    this.#pump();
  }

  #notifyDone(op) {
    try {
      this.onOpDone?.(op);
    } catch (e) {
      this.stats.callbackErrors += 1;
      this.lastCallbackError = `${e?.name}: ${e?.message}`;
    }
  }

  #onError() {
    // The MSE append error algorithm fires `error`, then `updateend`, then ends the
    // MediaSource with a decode error. The failure is committed on the updateend.
    this.stats.errorEvents += 1;
    this.errorSeen = true;
    if (!this.current) this.#fail("APPEND_ERROR", `SourceBuffer '${this.label}' fired error with nothing in flight`);
  }

  #onAbort() {
    this.stats.aborts += 1;
    if (this.current) this.current.aborted = true;
  }

  #fail(code, message, op) {
    if (this.state === "failed" || this.state === "closed") return;
    this.failure = { code, message, opId: op?.id, opType: op?.type, meta: op?.meta };
    this.state = "failed";
    const dropped = this.clearPending("failed");
    this.failure.droppedOps = dropped.ops;
    this.onFailure?.(this.failure);
    this.#resolveWaiters();
  }

  #resolveIfIdle() {
    if (!this.busy && !this.sb.updating) this.#resolveWaiters();
  }

  #resolveWaiters() {
    const waiters = this.idleWaiters.splice(0);
    for (const w of waiters) w(this.state);
  }
}
