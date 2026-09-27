// Spike 0.6 progressive MSE pipeline (laboratory code).
//
//   local File → bounded reads → Spike 0.5 plan → cut one segment → simulated arrival
//   → per-SourceBuffer append queue → MediaSource → HTMLVideoElement
//
// One session exists per loaded file. Everything a session creates (MediaSource,
// object URL, SourceBuffers, listeners, timers, frame callbacks, queued bytes,
// prepared segments, parser state) is released by reset().

import { AppendQueue } from "./append-queue.mjs";
import { DeliveryScheduler, SegmentState, profileByName } from "./delivery.mjs";
import { Recorder, ResourceTracker, displayName, round } from "./diagnostics.mjs";
import { PreparationError, openMedia } from "./preparer.mjs";
import { bufferedAhead, compareRanges, rangeIndexAt, snapshotRanges } from "./ranges.mjs";

export const PIPELINE_DEFAULTS = Object.freeze({
  bufferMode: "muxed", // "muxed": one SourceBuffer for both tracks; "separate": one per track
  targetSeconds: 2,
  blockSize: 1024 * 1024,
  profile: "NORMAL",
  initialSegments: 2,
  lookaheadSeconds: 60, // Infinity disables the cap
  backBufferSeconds: 30, // null disables trimming behind the playhead
  prepareAhead: 2,
  setDuration: true,
  autoEndOfStream: true,
  cursor: "playhead", // "playhead": next needed segment at/after the playhead; "sequential": lowest missing index
  seekAbort: false, // call SourceBuffer.abort() on the in-flight append when a seek needs other media
  sourceOpenTimeoutMs: 5000,
  sampleIntervalMs: 250,
  // A position this close before a buffered range start counts as buffered (start-of-stream offsets).
  bufferedTolerance: 0.1,
});

const MEDIA_EVENTS = ["loadstart", "durationchange", "loadedmetadata", "loadeddata", "canplay", "canplaythrough", "play", "playing", "pause", "waiting", "stalled", "suspend", "seeking", "seeked", "ended", "error", "emptied", "abort", "ratechange", "resize"];
const COUNTED_MEDIA_EVENTS = ["timeupdate", "progress"];
const TRIM_HYSTERESIS_SECONDS = 10;
// Queued (not yet issued) operations per SourceBuffer above which delivery pauses.
const APPEND_BACKPRESSURE_OPS = 4;

let sessionCounter = 0;

function waitForEvent(s, target, type, timeoutMs, signal) {
  return new Promise((resolve) => {
    const listeners = s.res.listenerGroup();
    let timer;
    const done = (value) => {
      s.res.clearTimeout(timer);
      listeners.abort();
      resolve(value);
    };
    listeners.on(target, type, () => done("event"));
    if (signal) {
      if (signal.aborted) return done("aborted");
      listeners.on(signal, "abort", () => done("aborted"));
    }
    timer = s.res.setTimeout(() => done("timeout"), timeoutMs);
  });
}

export class ProgressivePipeline {
  constructor({ video, MP4Box, now = () => performance.now(), onUpdate } = {}) {
    this.video = video;
    this.MP4Box = MP4Box;
    this.now = now;
    this.onUpdate = onUpdate;
    this.state = "idle";
    this.session = undefined;
    this.lastReport = undefined;
    this.transition = Promise.resolve();
  }

  // ---------------------------------------------------------------- lifecycle

  #serialize(operation) {
    const result = this.transition.then(operation);
    this.transition = result.then(() => undefined, () => undefined);
    return result;
  }

  load(file, opts = {}) {
    return this.#serialize(() => this.#load(file, opts));
  }

  async #load(file, opts) {
    if (this.session) await this.#reset("replaced");
    const options = { ...PIPELINE_DEFAULTS, ...opts };
    const s = this.#newSession(file, options);
    this.session = s;
    this.state = "opening";
    s.rec.event("load", { name: displayName(file.name), size: file.size, bufferMode: options.bufferMode, profile: options.profile, initialSegments: options.initialSegments, targetSeconds: options.targetSeconds });

    try {
      s.prep = await openMedia(this.MP4Box, file, { blockSize: options.blockSize, targetSeconds: options.targetSeconds, signal: s.abort.signal, now: this.now });
    } catch (e) {
      return this.#refuse(s, e);
    }
    if (s.closing || this.session !== s) return { ok: false, refusal: { code: "CLOSED" } };
    const prep = s.prep;
    s.rec.event("media-opened", { segments: prep.segmentCount, durationSeconds: round(prep.durationSeconds), mime: prep.mime, open: prep.openStats });

    const wanted = options.bufferMode === "separate" ? [prep.mime.video, prep.mime.audio] : [prep.mime.combined];
    s.capability = wanted.map((mime) => ({ mime, isTypeSupported: globalThis.MediaSource?.isTypeSupported?.(mime) === true }));
    if (!globalThis.MediaSource) return this.#refuse(s, new PreparationError("MSE_UNAVAILABLE", "MediaSource is not available", { stage: "capability" }));
    const unsupported = s.capability.filter((c) => !c.isTypeSupported);
    if (unsupported.length) return this.#refuse(s, new PreparationError("MSE_TYPE_UNSUPPORTED", `MediaSource.isTypeSupported() is false for ${unsupported.map((c) => c.mime).join(" and ")}`, { stage: "capability", capability: s.capability }));

    let inits;
    try {
      inits = prep.initSegments();
    } catch (e) {
      return this.#refuse(s, e);
    }

    // MediaSource and object URL.
    const ms = new MediaSource();
    s.ms = ms;
    for (const type of ["sourceopen", "sourceended", "sourceclose"]) s.group.on(ms, type, () => s.rec.event(`ms-${type}`, this.#state(s)));
    for (const type of MEDIA_EVENTS) s.group.on(this.video, type, () => this.#onMediaEvent(s, type));
    for (const type of COUNTED_MEDIA_EVENTS) s.group.on(this.video, type, () => this.#onCountedEvent(s, type));
    const opened = waitForEvent(s, ms, "sourceopen", options.sourceOpenTimeoutMs, s.abort.signal);
    s.url = s.res.createObjectURL(ms);
    this.video.src = s.url;
    s.rec.event("attached", { msReadyState: ms.readyState });
    const openResult = await opened;
    if (s.closing || this.session !== s) return { ok: false, refusal: { code: "CLOSED" } };
    if (openResult !== "event" || ms.readyState !== "open") return this.#fatal(s, { stage: "sourceopen", code: "SOURCEOPEN_TIMEOUT", message: `MediaSource did not open (readyState ${ms.readyState})` });
    s.milestones.sourceOpenAt = s.rec.t();
    // The URL is no longer needed once the MediaSource is attached.
    s.res.revokeObjectURL(s.url);
    s.rec.event("object-url-revoked", { after: "sourceopen" });

    // SourceBuffers.
    const layout = options.bufferMode === "separate"
      ? [{ key: "video", mime: prep.mime.video, trackIds: [prep.videoTrackId], init: inits.perTrack[prep.videoTrackId].buffer }, { key: "audio", mime: prep.mime.audio, trackIds: [prep.audioTrackId], init: inits.perTrack[prep.audioTrackId].buffer }]
      : [{ key: "muxed", mime: prep.mime.combined, trackIds: [prep.videoTrackId, prep.audioTrackId], init: inits.combined.buffer }];
    try {
      for (const l of layout) {
        const sb = ms.addSourceBuffer(l.mime);
        const entry = { ...l, sb, lastRanges: [], appendsAfterEos: 0 };
        entry.queue = new AppendQueue(sb, {
          label: l.key,
          now: this.now,
          onOpDone: (op) => this.#onOpDone(s, entry, op),
          onFailure: (f) => this.#fail(s, { stage: "append", sourceBuffer: l.key, ...f }),
          onQuotaExceeded: (op, e) => this.#onQuota(s, entry, op, e),
        });
        for (const type of ["updatestart", "update"]) s.group.on(sb, type, () => s.rec.count(`sb-${l.key}-${type}`));
        for (const type of ["error", "abort"]) s.group.on(sb, type, () => s.rec.event(`sb-${type}`, { sourceBuffer: l.key, ...this.#state(s) }));
        s.sbs.push(entry);
        for (const id of l.trackIds) s.queueByTrack.set(id, entry);
      }
    } catch (e) {
      return this.#fatal(s, { stage: "addSourceBuffer", code: e?.name ?? "ERROR", message: e?.message });
    }
    s.sourceBufferModes = s.sbs.map((e) => ({ key: e.key, mode: e.sb.mode }));

    // Initialization segment(s) first.
    for (const e of s.sbs) e.queue.append(e.init, { kind: "init", sourceBuffer: e.key });
    await Promise.all(s.sbs.map((e) => e.queue.whenIdle()));
    if (s.failure || s.closing || this.session !== s) return { ok: false, failure: s.failure };
    s.milestones.initAppendedAt = s.rec.t();
    s.initResult = {
      durationAfterInit: ms.duration,
      videoReadyState: this.video.readyState,
      videoWidth: this.video.videoWidth,
      videoHeight: this.video.videoHeight,
      loadedMetadataFired: (s.rec.counts["media-loadedmetadata"] ?? 0) > 0,
      initBytes: s.sbs.map((e) => ({ key: e.key, bytes: e.init.byteLength })),
    };
    if (options.setDuration && !s.sbs.some((e) => e.sb.updating)) {
      ms.duration = prep.durationSeconds;
      s.initResult.durationSet = ms.duration;
    }
    s.rec.event("init-appended", s.initResult);

    // Progressive delivery.
    s.segState = new SegmentState(prep.plan.segments);
    s.scheduler = new DeliveryScheduler({
      timers: { setTimeout: (fn, ms) => s.res.setTimeout(fn, ms), clearTimeout: (id) => s.res.clearTimeout(id), now: this.now },
      profile: profileByName(options.profile),
      initialSegments: options.initialSegments,
      nextIndex: () => this.#nextIndex(s),
      deliver: (k, kind) => this.#deliver(s, k, kind),
      durationOf: (k) => prep.plan.segments[k].endSeconds - prep.plan.segments[k].startSeconds,
      gate: () => this.#gate(s),
      onEvent: (e) => s.rec.event(e.type, e),
    });
    s.sampler = s.res.setInterval(() => this.#sample(s), options.sampleIntervalMs);
    this.#startFrameLoop(s);
    if (s.closing || this.session !== s) return { ok: false, refusal: { code: "CLOSED" } };
    this.state = "streaming";
    this.#fillPrepared(s);
    await s.scheduler.start();
    if (s.closing || this.session !== s) return { ok: false, refusal: { code: "CLOSED" } };
    this.#emit();
    return { ok: true, segments: prep.segmentCount, mime: s.capability, init: s.initResult };
  }

  /** Release everything the session owns and report what is left live (should be nothing). */
  reset(reason = "reset") {
    return this.#serialize(() => this.#reset(reason));
  }

  async #reset(reason) {
    const s = this.session;
    if (!s) return this.lastReport;
    const pre = this.#beginTeardown(s, reason);
    let sourceClose = "no-mediasource";
    if (s.ms) {
      const closed = s.ms.readyState === "closed" ? Promise.resolve("already-closed") : waitForEvent(s, s.ms, "sourceclose", 2000);
      this.#detach(s);
      sourceClose = await closed;
    }
    return this.#finishTeardown(s, reason, pre, sourceClose);
  }

  /** Synchronous teardown for pagehide, where nothing can be awaited. */
  teardownSync(reason = "pagehide") {
    const s = this.session;
    if (!s) return this.lastReport;
    const pre = this.#beginTeardown(s, reason);
    if (s.ms) this.#detach(s);
    return this.#finishTeardown(s, reason, pre, "not-awaited");
  }

  // ---------------------------------------------------------------- controls

  play() {
    const s = this.session;
    if (!s?.ms) return Promise.resolve({ ok: false, reason: "no-session" });
    const activation = { hasBeenActive: navigator.userActivation?.hasBeenActive, isActive: navigator.userActivation?.isActive };
    const calledAt = s.rec.t();
    s.rec.event("play-called", { ...activation, ...this.#state(s) });
    let p;
    try {
      p = this.video.play();
    } catch (e) {
      return Promise.resolve({ ok: false, name: e?.name, message: e?.message, activation });
    }
    return Promise.resolve(p).then(
      () => {
        s.rec.event("play-resolved", { afterMs: round(s.rec.t() - calledAt, 1) });
        return { ok: true, afterMs: round(s.rec.t() - calledAt, 1), activation };
      },
      (e) => {
        s.rec.event("play-rejected", { name: e?.name, message: String(e?.message).slice(0, 200) });
        return { ok: false, name: e?.name, message: String(e?.message).slice(0, 200), activation };
      },
    );
  }

  pause() {
    this.video.pause();
  }

  seek(t) {
    const s = this.session;
    if (!s?.ms) return;
    const d = Number.isFinite(this.video.duration) ? this.video.duration : s.prep.durationSeconds;
    const target = Math.max(0, Math.min(t, d - 0.001));
    s.rec.event("seek-requested", { target: round(target), ...this.#state(s) });
    this.video.currentTime = target;
  }

  hold() {
    this.session?.scheduler?.hold();
  }

  resume() {
    this.session?.scheduler?.resume();
  }

  release(n = 1) {
    return this.session?.scheduler?.release(n) ?? Promise.resolve(0);
  }

  setProfile(name) {
    const s = this.session;
    if (!s?.scheduler) return;
    s.options.profile = name;
    s.scheduler.setProfile(profileByName(name));
  }

  setLookahead(seconds) {
    if (!this.session) return;
    this.session.options.lookaheadSeconds = seconds;
    this.session.scheduler?.poke();
  }

  /**
   * Fault injection for cleanup/error-path tests: queue bytes that are not a valid
   * media segment. `kind` = "child-overrun" (moof whose child box exceeds it) or
   * "garbage" (non-box bytes).
   */
  injectCorruptAppend(kind = "child-overrun") {
    const s = this.session;
    if (!s?.sbs.length) return false;
    let bytes;
    if (kind === "garbage") {
      bytes = new Uint8Array(4096);
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 151 + 17) & 0xff;
    } else {
      bytes = new Uint8Array(64);
      const dv = new DataView(bytes.buffer);
      dv.setUint32(0, 64);
      bytes.set([0x6d, 0x6f, 0x6f, 0x66], 4); // moof
      dv.setUint32(8, 4000); // mfhd claims 4000 bytes inside a 64-byte moof
      bytes.set([0x6d, 0x66, 0x68, 0x64], 12); // mfhd
    }
    s.rec.event("fault-injected", { kind, bytes: bytes.byteLength });
    s.sbs[0].queue.append(bytes.buffer, { kind: `fault-${kind}`, sourceBuffer: s.sbs[0].key });
    return true;
  }

  /** Small digest of the currently displayed frame (evidence that frames change). */
  frameDigest() {
    const v = this.video;
    if (!v.videoWidth) return undefined;
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 36;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, 64, 36);
    const data = ctx.getImageData(0, 0, 64, 36).data;
    let h = 0x811c9dc5;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      const y = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
      sum += y;
      h ^= data[i];
      h = Math.imul(h, 0x01000193) >>> 0;
      h ^= data[i + 1];
      h = Math.imul(h, 0x01000193) >>> 0;
      h ^= data[i + 2];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    canvas.width = 0;
    return { currentTime: round(v.currentTime), digest: h.toString(16).padStart(8, "0"), meanLuma: round(sum / (data.length / 4), 2) };
  }

  // ---------------------------------------------------------------- experiments

  /**
   * MSE abort() experiment: append planned segment k's video fragment, call
   * SourceBuffer.abort() while it is updating, then append the full segment normally.
   * Reports the events and buffered ranges after each step. Delivery must be idle.
   */
  async experimentAbortAppend(k) {
    const s = this.session;
    if (!s?.segState) throw new Error("No active session");
    const seg = await this.#serialCut(s, () => s.prep.cut(k));
    const video = seg.parts.find((p) => p.kind === "video");
    const entry = s.queueByTrack.get(video.trackId);
    const countsBefore = { abort: s.rec.counts["sb-abort"] ?? 0, error: s.rec.counts["sb-error"] ?? 0 };
    const rangesBefore = snapshotRanges(entry.sb.buffered);
    entry.queue.append(video.buffer, { kind: "experiment-abort", planIndex: undefined, sourceBuffer: entry.key });
    const updatingAfterAppend = entry.sb.updating;
    const aborted = entry.queue.abortCurrent();
    const updatingAfterAbort = entry.sb.updating;
    await entry.queue.whenIdle();
    const rangesAfterAbort = snapshotRanges(entry.sb.buffered);
    const again = await this.#serialCut(s, () => s.prep.cut(k));
    s.segState.markInFlight(k);
    const attempt = { id: ++s.nextAttemptId, remaining: new Set(again.parts.map((part) => part.trackId)), abandoned: false };
    s.attempts.set(k, attempt);
    for (const part of again.parts) s.queueByTrack.get(part.trackId).queue.append(part.buffer, { planIndex: k, attemptId: attempt.id, trackId: part.trackId, kind: part.kind, sourceBuffer: s.queueByTrack.get(part.trackId).key, startSeconds: part.startDecodeSeconds, endSeconds: part.endDecodeSeconds, bytes: part.bytes, deliveredAt: s.rec.t() });
    await Promise.all(s.sbs.map((e) => e.queue.whenIdle()));
    const result = {
      k,
      videoFragmentBytes: video.bytes,
      updatingAfterAppend,
      aborted,
      updatingAfterAbort,
      abortEvents: (s.rec.counts["sb-abort"] ?? 0) - countsBefore.abort,
      errorEvents: (s.rec.counts["sb-error"] ?? 0) - countsBefore.error,
      rangesBefore,
      rangesAfterAbort,
      rangesAfterReappend: snapshotRanges(entry.sb.buffered),
      elementRangesAfterReappend: snapshotRanges(this.video.buffered),
      failure: s.failure,
      initReappended: false,
    };
    s.rec.event("experiment-abort", result);
    return result;
  }

  /**
   * Negative control: append a fragment for an arbitrary sample range of one track
   * (e.g. one that starts mid-GOP) and report what the SourceBuffer kept.
   */
  async experimentAppendFragment(trackId, first, endExclusive) {
    const s = this.session;
    if (!s?.segState) throw new Error("No active session");
    const part = await this.#serialCut(s, () => s.prep.cutSampleRange(trackId, first, endExclusive, 900_000 + first));
    const entry = s.queueByTrack.get(trackId);
    const before = snapshotRanges(entry.sb.buffered);
    entry.queue.append(part.buffer, { kind: "experiment-fragment", trackId, sourceBuffer: entry.key, startSeconds: part.startDecodeSeconds, endSeconds: part.endDecodeSeconds });
    await entry.queue.whenIdle();
    const result = {
      trackId,
      samples: [first, endExclusive],
      firstIsSync: part.firstIsSync,
      verifiedFirstSampleSync: part.verifiedFirstSampleSync,
      firstSyncSample: part.firstSyncSample,
      firstSyncPresentationSeconds: part.firstSyncPresentationSeconds,
      verifierProblems: part.problems,
      decodeRange: [part.startDecodeSeconds, part.endDecodeSeconds],
      presentationRange: [part.earliestPresentationSeconds, part.latestPresentationEndSeconds],
      bytes: part.bytes,
      rangesBefore: before,
      rangesAfter: snapshotRanges(entry.sb.buffered),
      queueState: entry.queue.state,
      failure: s.failure,
    };
    s.rec.event("experiment-fragment", result);
    return result;
  }

  // ---------------------------------------------------------------- snapshot

  snapshot() {
    const s = this.session;
    const v = this.video;
    if (!s) return { state: this.state, lastReport: this.lastReport };
    const ranges = snapshotRanges(v.buffered);
    const q = v.getVideoPlaybackQuality?.();
    const prepStats = s.prep?.stats();
    const segs = s.prep?.plan.segments;
    const frontier = (pred) => {
      if (!segs) return undefined;
      let k = s.prep.planIndexForTime(v.currentTime);
      if (!pred(k)) return undefined;
      while (k + 1 < segs.length && pred(k + 1)) k += 1;
      return segs[k].endSeconds;
    };
    return {
      state: this.state,
      sessionId: s.id,
      file: s.file,
      options: s.options,
      currentTime: v.currentTime,
      elementDuration: v.duration,
      msDuration: s.ms?.duration,
      readyState: v.readyState,
      networkState: v.networkState,
      paused: v.paused,
      ended: v.ended,
      seeking: v.seeking,
      waiting: Boolean(s.stall),
      msReadyState: s.ms?.readyState,
      buffered: ranges,
      ahead: bufferedAhead(ranges, v.currentTime, s.options.bufferedTolerance),
      sourceBuffers: s.sbs.map((e) => ({ key: e.key, mime: e.mime, mode: e.sb.mode, updating: e.sb.updating, ranges: s.ms?.readyState !== "closed" ? snapshotRanges(e.sb.buffered) : [], queue: e.queue.snapshot() })),
      plan: s.prep ? { segments: s.prep.segmentCount, targetSeconds: s.options.targetSeconds, durationSeconds: s.prep.durationSeconds } : undefined,
      segments: s.segState?.snapshot(),
      frontiers: s.segState ? {
        appendedEndSeconds: frontier((k) => s.segState.appended.has(k)),
        deliveredEndSeconds: frontier((k) => s.segState.isAvailable(k)),
        preparedEndSeconds: this.#preparedEnd(s),
      } : undefined,
      scheduler: s.scheduler?.snapshot(),
      frames: { presented: s.frames.presented, callbacks: s.frames.callbacks, lastMediaTime: s.frames.lastMediaTime, totalVideoFrames: q?.totalVideoFrames, droppedVideoFrames: q?.droppedVideoFrames },
      totals: { ...s.totals, preparedBytes: this.#preparedBytes(s), pendingBytes: s.sbs.reduce((n, e) => n + e.queue.pendingBytes, 0) },
      milestones: { ...s.milestones },
      firstPlaying: s.firstPlaying,
      source: prepStats,
      capability: s.capability,
      initResult: s.initResult,
      refusal: s.refusal,
      failure: s.failure,
      eos: s.eos,
      seeks: s.rec.seeks.entries(),
      stalls: s.rec.stalls.entries(),
      openStall: s.stall,
      anomalies: s.anomalies,
      counts: { ...s.rec.counts },
      resources: s.res.report(),
      videoError: v.error ? { code: v.error.code, message: v.error.message } : undefined,
    };
  }

  /** Bounded evidence bundle for the scenario runner. */
  evidence({ timeline = 400, appends = 400, samples = 2000 } = {}) {
    const s = this.session;
    if (!s) return { lastReport: this.lastReport };
    return {
      snapshot: this.snapshot(),
      presentation: s.prep?.presentationInfo(),
      timeline: s.rec.timeline.last(timeline),
      timelineTotal: s.rec.timeline.total,
      appendLog: appends === Infinity ? s.rec.appendLog.entries() : s.rec.appendLog.last(appends),
      appendLogTotal: s.rec.appendLog.total,
      samples: s.rec.samples.last(samples),
    };
  }

  get recorder() {
    return this.session?.rec;
  }

  get preparer() {
    return this.session?.prep;
  }

  // ---------------------------------------------------------------- internals

  #newSession(file, options) {
    sessionCounter += 1;
    const res = new ResourceTracker();
    return {
      id: sessionCounter,
      file: { name: displayName(file.name), size: file.size },
      options,
      rec: new Recorder(this.now),
      res,
      group: res.listenerGroup(),
      abort: new AbortController(),
      prep: undefined,
      ms: undefined,
      url: undefined,
      sbs: [],
      queueByTrack: new Map(),
      segState: undefined,
      prepared: new Map(),
      prepChain: Promise.resolve(),
      attempts: new Map(),
      nextAttemptId: 0,
      // Incremented on every `seeking`; a dropped prepared slot records the value at its drop.
      seekGeneration: 0,
      scheduler: undefined,
      sampler: undefined,
      frames: { presented: 0, callbacks: 0, handle: undefined, firstAt: undefined, lastMediaTime: undefined },
      milestones: {},
      firstPlaying: undefined,
      totals: { delivered: 0, deliveredBytes: 0, appendedSegments: 0, appendedBytes: 0, appendedAfterFirstPlaying: 0, deliveredAfterFirstPlaying: 0, maxPreparedBytes: 0, maxPendingBytes: 0, maxPreparedEntries: 0, staleDropped: 0, supersededPreparations: 0, removes: 0 },
      stall: undefined,
      currentSeek: undefined,
      eos: [],
      anomalies: [],
      failure: undefined,
      refusal: undefined,
      closing: false,
    };
  }

  #state(s) {
    const v = this.video;
    const ranges = snapshotRanges(v.buffered);
    return {
      ct: round(v.currentTime),
      rs: v.readyState,
      ns: v.networkState,
      paused: v.paused,
      ms: s.ms?.readyState,
      ahead: round(bufferedAhead(ranges, v.currentTime, s.options.bufferedTolerance)),
      ranges: ranges.length,
      bEnd: ranges.length ? round(ranges[ranges.length - 1][1]) : undefined,
    };
  }

  #emit() {
    try {
      this.onUpdate?.(this.snapshot());
    } catch {
      // Rendering must never break the pipeline.
    }
  }

  #refuse(s, e) {
    if (s.closing || this.session !== s) return { ok: false, refusal: { code: "CLOSED" } };
    const refusal = { code: e?.code ?? e?.name ?? "ERROR", message: String(e?.message ?? e).slice(0, 500), stage: e?.details?.stage, details: e?.details ? sanitizeDetails(e.details) : undefined };
    s.refusal = refusal;
    this.state = "refused";
    s.rec.event("refused", refusal);
    s.prep?.close();
    this.#emit();
    return { ok: false, refusal };
  }

  #fatal(s, failure) {
    this.#fail(s, failure);
    return { ok: false, failure: s.failure };
  }

  #fail(s, failure) {
    if (s.failure || s.closing || this.session !== s) return;
    s.failure = { ...failure, at: s.rec.t(), ...this.#state(s), videoError: this.video.error ? { code: this.video.error.code, message: this.video.error.message } : undefined };
    for (const attempt of s.attempts.values()) attempt.abandoned = true;
    s.attempts.clear();
    s.segState?.dropInFlight([...s.segState.inFlight]);
    this.state = "failed";
    s.rec.event("pipeline-failed", s.failure);
    s.scheduler?.stop();
    for (const e of s.sbs) if (e.queue.state !== "failed" && e.queue.state !== "closed") e.queue.clearPending("pipeline-failed");
    this.#dropPrepared(s, () => true, "pipeline-failed");
    this.#emit();
  }

  #onMediaEvent(s, type) {
    if (s.closing || this.session !== s) return;
    const st = this.#state(s);
    s.rec.event(`media-${type}`, st);
    const v = this.video;
    if (type === "playing") {
      if (!s.milestones.firstPlayingAt) {
        s.milestones.firstPlayingAt = s.rec.t();
        const avail = s.segState?.snapshot();
        s.firstPlaying = {
          at: s.milestones.firstPlayingAt,
          currentTime: round(v.currentTime),
          appendedSegments: s.segState?.appended.size,
          deliveredSegments: s.totals.delivered,
          totalSegments: s.prep?.segmentCount,
          appendedBytes: s.totals.appendedBytes,
          appendedMediaEndSeconds: this.snapshotFrontierAppended(s),
          bufferedRanges: snapshotRanges(v.buffered).map(([a, b]) => [round(a), round(b)]),
          sourceBytesRead: s.prep?.stats().bytesRead,
          sourceSize: s.file.size,
          appendedRuns: avail?.appendedRuns,
        };
        s.rec.event("first-playing", s.firstPlaying);
      }
      if (s.stall) this.#endStall(s);
      if (s.currentSeek && s.currentSeek.seekedAt !== undefined && s.currentSeek.playingAt === undefined) s.currentSeek.playingAt = s.rec.t();
    } else if (type === "waiting") {
      if (!s.stall) s.stall = { startAt: s.rec.t(), currentTime: round(v.currentTime), readyState: v.readyState, ahead: st.ahead, ranges: snapshotRanges(v.buffered).map(([a, b]) => [round(a), round(b)]), appendsAtStart: s.totals.appendedSegments, seeking: v.seeking };
    } else if (type === "seeking") {
      this.#onSeeking(s);
    } else if (type === "seeked") {
      if (s.currentSeek && s.currentSeek.seekedAt === undefined) {
        s.currentSeek.seekedAt = s.rec.t();
        s.currentSeek.seekedCurrentTime = round(v.currentTime);
        s.currentSeek.seekLatencyMs = round(s.currentSeek.seekedAt - s.currentSeek.at, 1);
        s.currentSeek.rangesAtSeeked = snapshotRanges(v.buffered).map(([a, b]) => [round(a), round(b)]);
      }
      s.scheduler?.poke();
    } else if (type === "ended") {
      s.milestones.endedAt = s.rec.t();
    } else if (type === "error") {
      this.#fail(s, { stage: "media-element", code: `MEDIA_ERR_${v.error?.code}`, message: v.error?.message });
    } else if (type === "pause" && s.stall) {
      // A stall that ends in a pause (e.g. ended or user pause) is closed here.
      this.#endStall(s, "pause");
    }
    this.#emit();
  }

  snapshotFrontierAppended(s) {
    if (!s.segState) return undefined;
    const segs = s.prep.plan.segments;
    let k = 0;
    if (!s.segState.appended.has(0)) return undefined;
    while (k + 1 < segs.length && s.segState.appended.has(k + 1)) k += 1;
    return round(segs[k].endSeconds);
  }

  #onCountedEvent(s, type) {
    if (s.closing || this.session !== s) return;
    s.rec.count(`media-${type}`);
    if (type === "timeupdate" && s.currentSeek && s.currentSeek.seekedAt !== undefined && s.currentSeek.advancedAt === undefined && !this.video.paused && this.video.currentTime > s.currentSeek.seekedCurrentTime + 0.25) {
      s.currentSeek.advancedAt = s.rec.t();
      s.currentSeek.advancedTo = round(this.video.currentTime);
    }
  }

  #endStall(s, endedBy = "playing") {
    const st = s.stall;
    s.stall = undefined;
    st.endAt = s.rec.t();
    st.durationMs = round(st.endAt - st.startAt, 1);
    st.endedBy = endedBy;
    st.appendsDuring = s.totals.appendedSegments - st.appendsAtStart;
    st.lastAppendEndedAt = s.lastSegmentAppendedAt;
    st.resumeAfterAppendMs = s.lastSegmentAppendedAt !== undefined && s.lastSegmentAppendedAt >= st.startAt ? round(st.endAt - s.lastSegmentAppendedAt, 1) : undefined;
    // "underrun": the playhead ran out of buffered media. "not-ready": media was buffered
    // at the playhead but the decoder/renderer was not yet ready (e.g. start-up).
    st.cause = st.seeking ? "seek" : st.ahead > 0.5 ? "not-ready" : "underrun";
    st.beforeFirstPlaying = st.startAt < (s.milestones.firstPlayingAt ?? Infinity);
    st.resumedAt = round(this.video.currentTime);
    s.rec.stalls.push(st);
    s.rec.event("stall-ended", st);
  }

  #onSeeking(s) {
    if (!s.segState) return;
    s.seekGeneration += 1;
    const v = this.video;
    const t = v.currentTime;
    const ranges = snapshotRanges(v.buffered);
    const buffered = rangeIndexAt(ranges, t, s.options.bufferedTolerance) >= 0;
    const k = s.prep.planIndexForTime(t);
    const seek = {
      id: s.rec.seeks.total + 1,
      at: s.rec.t(),
      target: round(t),
      planIndex: k,
      segmentStart: round(s.prep.plan.segments[k].startSeconds),
      rangesAtSeek: ranges.map(([a, b]) => [round(a), round(b)]),
      case: buffered ? "A-buffered" : "B-unbuffered",
      cursor: s.options.cursor,
      bytesReadBefore: s.prep.stats().bytesRead,
      readsBefore: s.prep.stats().reads,
    };
    if (s.currentSeek && s.currentSeek.seekedAt === undefined) s.currentSeek.supersededAt = seek.at;
    s.currentSeek = seek;
    s.rec.seeks.push(seek);
    s.rec.event("seek-classified", { case: seek.case, target: seek.target, planIndex: k });
    if (buffered || s.options.cursor === "sequential" || s.failure) return;
    // An appended label cannot stand in for browser media that has been evicted.
    if (s.segState.appended.has(k)) {
      const segment = s.prep.plan.segments[k];
      s.segState.markRemoved(segment.startSeconds, segment.endSeconds);
      s.rec.event("reconciled-missing-seek", { k });
    }

    // Case B: reprioritise. Drop queued appends that are no longer next, optionally
    // abort the in-flight append, drop stale prepared segments, then release now.
    let droppedOps = 0;
    let droppedBytes = 0;
    const droppedIdx = new Set();
    for (const e of s.sbs) {
      const d = e.queue.clearPending("seek");
      droppedOps += d.ops;
      droppedBytes += d.bytes;
      for (const m of d.metas) if (m.planIndex !== undefined) droppedIdx.add(m.planIndex);
    }
    for (const i of droppedIdx) {
      const attempt = s.attempts.get(i);
      if (attempt) {
        attempt.abandoned = true;
        s.attempts.delete(i);
        s.rec.event("segment-attempt-abandoned", { k: i, attemptId: attempt.id, reason: "seek-dropped-part" });
      }
    }
    s.segState.dropInFlight(droppedIdx);
    let aborted = false;
    if (s.options.seekAbort) for (const e of s.sbs) aborted = e.queue.abortCurrent() || aborted;
    seek.retarget = { droppedOps, droppedBytes, droppedSegments: [...droppedIdx].sort((a, b) => a - b), abortedInFlight: aborted, nextIndex: this.#nextIndex(s) };
    this.#fillPrepared(s);
    s.scheduler.urgent();
  }

  #nextIndex(s) {
    if (!s.segState || s.failure || s.closing) return undefined;
    if (s.options.cursor === "sequential") return s.segState.nextSequential();
    return s.segState.nextNeeded(s.prep.planIndexForTime(this.video.currentTime));
  }

  #gate(s) {
    // Append backpressure first: never hand more segments to a queue that cannot drain.
    if (s.sbs.some((e) => e.queue.state === "blocked" || e.queue.pendingOps >= APPEND_BACKPRESSURE_OPS)) return { open: false, reason: "append-backpressure" };
    const v = this.video;
    const t = v.currentTime;
    const ranges = snapshotRanges(v.buffered);
    if (rangeIndexAt(ranges, t, s.options.bufferedTolerance) < 0) {
      const target = s.prep.planIndexForTime(t);
      if (s.segState.inFlight.has(target)) return { open: false, reason: "target-append-pending" };
      return { open: true, reason: "playhead-unbuffered" };
    }
    const availEnd = s.segState.availableEndFrom(s.prep.planIndexForTime(t)) ?? t;
    return { open: availEnd - t < s.options.lookaheadSeconds, ahead: availEnd - t };
  }

  async #deliver(s, k, kind) {
    if (s.closing || s.failure) return false;
    // The slot stays droppable while this delivery waits for it: a later seek may drop it.
    const seekGeneration = s.seekGeneration;
    const { slot, entry, error } = await this.#takePrepared(s, k);
    if (s.closing || s.failure || this.session !== s) return false;
    const droppedError = error instanceof PreparationError && error.code === "DROPPED";
    if (error && !droppedError) {
      this.#fail(s, { stage: "prepare", index: k, code: error?.code ?? error?.name ?? "ERROR", message: String(error?.message ?? error).slice(0, 300) });
      return false;
    }
    if (slot.dropped || droppedError) {
      // Superseded (normal control flow) only when a seek after this delivery began
      // retargeted preparation away from k. Any other drop is an invariant violation.
      if (slot.dropped?.reason === "not-next" && slot.dropped.seekGeneration > seekGeneration) {
        s.totals.supersededPreparations += 1;
        s.rec.event("preparation-superseded", { k, stage: droppedError ? "before-cut" : "during-cut", seekGeneration: slot.dropped.seekGeneration, nextIndex: this.#nextIndex(s) });
        return false;
      }
      this.#fail(s, { stage: "prepare", index: k, code: "PREPARATION_DROPPED_UNSUPERSEDED", message: `Segment ${k} preparation was dropped (${slot.dropped?.reason ?? "unknown"}) without a newer seek` });
      return false;
    }
    if (s.segState.isAvailable(k) || this.#nextIndex(s) !== k) {
      // A seek moved the playhead while this segment was being prepared.
      s.totals.staleDropped += 1;
      s.rec.event("stale-delivery-dropped", { k, nextIndex: this.#nextIndex(s) });
      return false;
    }
    s.segState.markInFlight(k);
    const attempt = { id: ++s.nextAttemptId, remaining: new Set(entry.parts.map((part) => part.trackId)), abandoned: false };
    s.attempts.set(k, attempt);
    try {
      for (const part of entry.parts) {
        const target = s.queueByTrack.get(part.trackId);
        target.queue.append(part.buffer, {
          planIndex: k,
          attemptId: attempt.id,
          trackId: part.trackId,
          kind: part.kind,
          sourceBuffer: target.key,
          startSeconds: part.startDecodeSeconds,
          endSeconds: part.endDecodeSeconds,
          presentationStart: part.earliestPresentationSeconds,
          presentationEnd: part.latestPresentationEndSeconds,
          bytes: part.bytes,
          deliveredAt: s.rec.t(),
        });
        part.buffer = null;
      }
    } catch (e) {
      this.#fail(s, { stage: "enqueue", index: k, code: e?.code ?? e?.name, message: e?.message });
      return false;
    }
    s.totals.delivered += 1;
    s.totals.deliveredBytes += entry.bytes;
    if (s.milestones.firstPlayingAt !== undefined) s.totals.deliveredAfterFirstPlaying += 1;
    if (s.currentSeek && s.currentSeek.planIndex === k && s.currentSeek.deliveredAt === undefined) {
      s.currentSeek.deliveredAt = s.rec.t();
      s.currentSeek.seekCutReads = entry.reads;
      s.currentSeek.seekCutBytesRead = entry.bytesRead;
      s.currentSeek.seekCutMs = entry.ms;
    }
    s.rec.event("deliver", { k, kind, start: round(entry.startSeconds), end: round(entry.endSeconds), bytes: entry.bytes, cutMs: entry.ms, reads: entry.reads, bytesRead: entry.bytesRead, preparedAheadMs: entry.preparedAt !== undefined ? round(s.rec.t() - entry.preparedAt, 1) : undefined, ...this.#state(s) });
    this.#fillPrepared(s);
    return true;
  }

  /** Run a cut after any preparation already in progress (one source read in flight). */
  #serialCut(s, fn) {
    const p = s.prepChain.then(fn);
    s.prepChain = p.catch(() => {});
    return p;
  }

  #startPrepare(s, k) {
    const slot = { index: k, entry: undefined, dropped: false };
    slot.promise = s.prepChain.then(() => {
      if (s.closing || slot.dropped) throw new PreparationError("DROPPED", "Preparation dropped", { stage: "cut" });
      return s.prep.cut(k);
    });
    s.prepChain = slot.promise.catch(() => {});
    slot.promise.then(
      (entry) => {
        entry.preparedAt = s.rec.t();
        if (slot.dropped || s.closing) {
          for (const p of entry.parts) p.buffer = null;
          return;
        }
        slot.entry = entry;
        const bytes = this.#preparedBytes(s);
        s.totals.maxPreparedBytes = Math.max(s.totals.maxPreparedBytes, bytes);
      },
      () => {},
    );
    s.prepared.set(k, slot);
    s.totals.maxPreparedEntries = Math.max(s.totals.maxPreparedEntries, s.prepared.size);
    return slot;
  }

  /** Wait for segment k's preparation. Resolves { slot, entry } or { slot, error }. */
  async #takePrepared(s, k) {
    const slot = s.prepared.get(k) ?? this.#startPrepare(s, k);
    try {
      return { slot, entry: await slot.promise };
    } catch (error) {
      return { slot, error };
    } finally {
      if (s.prepared.get(k) === slot) s.prepared.delete(k);
    }
  }

  #fillPrepared(s) {
    if (s.closing || s.failure || !s.segState) return;
    const predicted = [];
    let k = this.#nextIndex(s);
    while (k !== undefined && predicted.length < s.options.prepareAhead) {
      predicted.push(k);
      k = s.segState.nextNeeded(k + 1);
    }
    this.#dropPrepared(s, (idx) => !predicted.includes(idx), "not-next");
    for (const idx of predicted) if (!s.prepared.has(idx)) this.#startPrepare(s, idx);
  }

  #dropPrepared(s, predicate, reason) {
    for (const [idx, slot] of s.prepared) {
      if (!predicate(idx)) continue;
      slot.dropped = { reason, seekGeneration: s.seekGeneration };
      if (slot.entry) for (const p of slot.entry.parts) p.buffer = null;
      s.prepared.delete(idx);
      s.rec.event("prepared-dropped", { k: idx, reason });
    }
  }

  #preparedBytes(s) {
    let n = 0;
    for (const slot of s.prepared.values()) if (slot.entry) n += slot.entry.bytes;
    return n;
  }

  #preparedEnd(s) {
    let end;
    for (const slot of s.prepared.values()) if (slot.entry) end = Math.max(end ?? 0, slot.entry.endSeconds);
    return end;
  }

  #onOpDone(s, entry, op) {
    if (s.closing || this.session !== s) return;
    const v = this.video;
    const m = op.meta ?? {};
    if (op.type === "append") {
      const ranges = s.ms.readyState !== "closed" ? snapshotRanges(entry.sb.buffered) : [];
      const cmp = compareRanges(entry.lastRanges, ranges);
      entry.lastRanges = ranges;
      const record = {
        k: m.planIndex,
        kind: m.kind,
        sb: entry.key,
        bytes: op.byteLength,
        media: m.startSeconds !== undefined ? [m.startSeconds, m.endSeconds] : undefined,
        presentation: m.presentationStart !== undefined ? [m.presentationStart, m.presentationEnd] : undefined,
        queuedAt: round(op.queuedAt - s.rec.t0, 1),
        startedAt: round(op.startedAt - s.rec.t0, 1),
        endedAt: round(op.endedAt - s.rec.t0, 1),
        appendMs: round(op.endedAt - op.startedAt, 2),
        sbRanges: ranges.map(([a, b]) => [round(a), round(b)]),
        elementRanges: snapshotRanges(v.buffered).map(([a, b]) => [round(a), round(b)]),
        currentTime: round(v.currentTime),
        readyState: v.readyState,
        msReadyState: s.ms.readyState,
        aborted: Boolean(op.aborted),
        error: Boolean(op.error),
        lost: cmp.lost.length ? cmp.lost.map(([a, b]) => [round(a), round(b)]) : undefined,
        endMovedBack: cmp.endMovedBack || undefined,
      };
      s.rec.appendLog.push(record);
      if (s.eos.length && s.eos[s.eos.length - 1].reopenedBy === undefined) {
        s.eos[s.eos.length - 1].reopenedBy = { k: m.planIndex, at: record.endedAt };
        entry.appendsAfterEos += 1;
      }
      if ((cmp.lost.length || cmp.endMovedBack) && s.anomalies.length < 50) s.anomalies.push({ type: "buffered-shrank-after-append", ...record });
      if (m.planIndex !== undefined) {
        const attempt = s.attempts.get(m.planIndex);
        const validAttempt = attempt && !attempt.abandoned && attempt.id === m.attemptId;
        if (op.aborted || op.error) {
          if (validAttempt) {
            attempt.abandoned = true;
            s.attempts.delete(m.planIndex);
            s.segState.dropInFlight([m.planIndex]);
          }
        } else {
          s.totals.appendedBytes += op.byteLength;
          if (validAttempt && attempt.remaining.delete(m.trackId) && attempt.remaining.size === 0) {
            s.attempts.delete(m.planIndex);
            s.segState.markAppended(m.planIndex);
            s.totals.appendedSegments += 1;
            s.lastSegmentAppendedAt = record.endedAt;
            if (s.milestones.firstPlayingAt !== undefined) s.totals.appendedAfterFirstPlaying += 1;
            if (s.currentSeek && s.currentSeek.planIndex === m.planIndex && s.currentSeek.appendedAt === undefined) s.currentSeek.appendedAt = record.endedAt;
          }
        }
      }
    } else {
      s.totals.removes += 1;
      entry.lastRanges = s.ms.readyState !== "closed" ? snapshotRanges(entry.sb.buffered) : [];
      s.rec.event("removed", { sb: entry.key, start: round(op.start), end: round(op.end), reason: m.reason, ranges: entry.lastRanges.map(([a, b]) => [round(a), round(b)]) });
    }
    s.totals.maxPendingBytes = Math.max(s.totals.maxPendingBytes, s.sbs.reduce((n, e) => n + e.queue.pendingBytes, 0));
    this.#maybeTrim(s);
    this.#maybeEndOfStream(s);
    s.scheduler?.poke();
  }

  #onQuota(s, entry, op, e) {
    if (s.closing || this.session !== s) return { defer: true };
    const t = this.video.currentTime;
    const ranges = snapshotRanges(entry.sb.buffered);
    const evictEnd = t - 2;
    const info = { sb: entry.key, k: op.meta?.planIndex, attempt: op.quotaAttempts, message: String(e?.message).slice(0, 200), currentTime: round(t), ranges: ranges.map(([a, b]) => [round(a), round(b)]), bufferedSeconds: round(ranges.reduce((n, [a, b]) => n + b - a, 0)), appendedBytesTotal: s.totals.appendedBytes };
    s.rec.event("quota-exceeded", info);
    if (ranges.length && ranges[0][0] < evictEnd - 0.5) {
      s.segState.markRemoved(ranges[0][0], evictEnd);
      return { removeStart: ranges[0][0], removeEnd: evictEnd };
    }
    // Nothing behind the playhead to evict: wait for playback to consume media, then retry.
    s.res.setTimeout(() => entry.queue.resume(), 1000);
    return { defer: true };
  }

  #maybeTrim(s) {
    const keep = s.options.backBufferSeconds;
    if (keep === null || keep === undefined || s.failure || !s.segState) return;
    const t = this.video.currentTime;
    const cutEnd = t - keep;
    if (cutEnd <= 0) return;
    let queued = false;
    for (const e of s.sbs) {
      if (e.queue.state === "failed" || e.queue.state === "closed" || e.trimPending) continue;
      const ranges = s.ms.readyState !== "closed" ? snapshotRanges(e.sb.buffered) : [];
      if (!ranges.length || ranges[0][0] >= cutEnd - TRIM_HYSTERESIS_SECONDS) continue;
      e.trimPending = true;
      e.queue.remove(ranges[0][0], cutEnd, { reason: "back-buffer" });
      queued = true;
      // Clear the flag once this remove has completed.
      const clear = () => {
        e.trimPending = false;
      };
      e.queue.whenIdle().then(clear, clear);
    }
    if (queued) s.segState.markRemoved(0, cutEnd);
  }

  #maybeEndOfStream(s) {
    if (!s.options.autoEndOfStream || s.failure || s.closing || !s.ms || !s.segState) return;
    if (s.ms.readyState !== "open") return;
    const last = s.prep.segmentCount - 1;
    if (!s.segState.appended.has(last)) return;
    if (this.#nextIndex(s) !== undefined) return;
    if (s.segState.inFlight.size) return;
    if (s.sbs.some((e) => e.queue.busy || e.sb.updating)) return;
    const before = s.ms.duration;
    try {
      s.ms.endOfStream();
    } catch (e) {
      s.rec.event("endOfStream-threw", { name: e?.name, message: e?.message });
      return;
    }
    const rec = { at: s.rec.t(), lastSegmentAppendedAt: s.lastSegmentAppendedAt, durationBefore: before, durationAfter: s.ms.duration, msReadyState: s.ms.readyState, ...this.#state(s), buffered: snapshotRanges(this.video.buffered).map(([a, b]) => [round(a), round(b)]), appendedSegments: s.segState.appended.size };
    s.eos.push(rec);
    s.milestones.endOfStreamAt = rec.at;
    s.rec.event("endOfStream", rec);
  }

  #sample(s) {
    if (s.closing || this.session !== s) return;
    const v = this.video;
    const ranges = snapshotRanges(v.buffered);
    const t = v.currentTime;
    const q = v.getVideoPlaybackQuality?.();
    const pending = s.sbs.reduce((n, e) => n + e.queue.pendingBytes, 0);
    const prepared = this.#preparedBytes(s);
    s.totals.maxPendingBytes = Math.max(s.totals.maxPendingBytes, pending);
    s.totals.maxPreparedBytes = Math.max(s.totals.maxPreparedBytes, prepared);
    const ahead = bufferedAhead(ranges, t, s.options.bufferedTolerance);
    s.rec.samples.push({
      t: s.rec.t(),
      ct: round(t),
      ahead: round(ahead),
      bEnd: ranges.length ? round(ranges[ranges.length - 1][1]) : undefined,
      nr: ranges.length,
      rs: v.readyState,
      p: v.paused ? 1 : 0,
      sk: v.seeking ? 1 : 0,
      w: s.stall ? 1 : 0,
      fr: s.frames.presented,
      tvf: q?.totalVideoFrames,
      dvf: q?.droppedVideoFrames,
      app: s.segState?.appended.size,
      dl: s.totals.delivered,
      pend: pending,
      prep: prepared,
    });
    // Browser-side eviction that this session did not request shows up as a stalled
    // playhead inside a segment marked appended: forget those segments so they are re-sent.
    if (!v.paused && !v.seeking && v.readyState < 3 && ahead === 0 && s.segState) {
      const k = s.prep.planIndexForTime(t);
      if (s.segState.appended.has(k)) {
        const seg = s.prep.plan.segments[k];
        s.segState.markRemoved(seg.startSeconds, seg.endSeconds);
        s.rec.event("reconciled-missing", { k, ct: round(t) });
        s.scheduler?.poke();
      }
    }
    this.#emit();
  }

  #startFrameLoop(s) {
    const v = this.video;
    if (typeof v.requestVideoFrameCallback !== "function") return;
    const cb = (_now, meta) => {
      s.res.releaseFrameCallback(v, s.frames.handle);
      s.frames.handle = undefined;
      if (s.closing || this.session !== s) return;
      s.frames.callbacks += 1;
      s.frames.presented = meta.presentedFrames;
      s.frames.lastMediaTime = round(meta.mediaTime);
      if (s.milestones.firstFrameAt === undefined) {
        s.milestones.firstFrameAt = s.rec.t();
        s.milestones.firstFrameMediaTime = round(meta.mediaTime);
      }
      s.frames.handle = v.requestVideoFrameCallback(cb);
      s.res.trackFrameCallback(v, s.frames.handle);
    };
    s.frames.handle = v.requestVideoFrameCallback(cb);
    s.res.trackFrameCallback(v, s.frames.handle);
  }

  #beginTeardown(s, reason) {
    s.closing = true;
    if (this.session === s) this.state = "closing";
    s.rec.event("teardown-begin", { reason });
    const pre = { preparedEntries: s.prepared.size, preparedBytes: this.#preparedBytes(s), pendingOps: s.sbs.reduce((n, e) => n + e.queue.pendingOps, 0), pendingBytes: s.sbs.reduce((n, e) => n + e.queue.pendingBytes, 0), schedulerState: s.scheduler?.state, timersBefore: s.res.report() };
    s.scheduler?.stop();
    s.res.clearInterval(s.sampler);
    s.sampler = undefined;
    s.res.releaseFrameCallback(this.video, s.frames.handle);
    s.frames.handle = undefined;
    s.abort.abort(new DOMException("Session closed", "AbortError"));
    this.#dropPrepared(s, () => true, "teardown");
    for (const e of s.sbs) {
      try {
        if (s.ms?.readyState === "open" && e.sb.updating) {
          e.sb.abort();
          pre.abortedInFlight = (pre.abortedInFlight ?? 0) + 1;
        }
      } catch (err) {
        pre.abortError = err?.name;
      }
      e.queue.close();
    }
    for (const id of [...s.res.timeouts]) s.res.clearTimeout(id);
    return pre;
  }

  #detach(s) {
    if (this.session !== s) return;
    const v = this.video;
    v.pause();
    v.removeAttribute("src");
    v.load();
  }

  #finishTeardown(s, reason, pre, sourceClose) {
    const v = this.video;
    s.res.revokeObjectURL(s.url);
    const ms = s.ms;
    const report = {
      reason,
      sessionId: s.id,
      before: pre,
      sourceClose,
      msReadyState: ms?.readyState,
      sourceBuffers: ms ? ms.sourceBuffers.length : undefined,
      activeSourceBuffers: ms ? ms.activeSourceBuffers.length : undefined,
      video: { readyState: v.readyState, networkState: v.networkState, srcAttribute: v.getAttribute("src"), currentSrc: v.currentSrc, error: v.error?.code ?? null, bufferedRanges: v.buffered.length },
      queues: s.sbs.map((e) => ({ key: e.key, state: e.queue.state, pendingOps: e.queue.pendingOps, pendingBytes: e.queue.pendingBytes })),
      preparedEntriesLive: s.prepared.size,
      schedulerTimers: s.scheduler?.timersActive ?? 0,
    };
    s.group.abort();
    s.prep?.close();
    report.preparerClosed = s.prep ? s.prep.closed : "not-opened";
    report.listenersAdded = s.group.added;
    report.listenerSignalAborted = s.group.signal.aborted;
    report.resources = s.res.report();
    report.clean = report.resources.liveObjectUrls === 0 && report.resources.liveTimeouts === 0 && report.resources.liveIntervals === 0 && report.resources.liveFrameCallbacks === 0 && report.resources.liveListenerGroups === 0 && report.preparedEntriesLive === 0 && report.queues.every((q) => q.state === "closed" && q.pendingOps === 0 && q.pendingBytes === 0) && (ms === undefined || (ms.readyState === "closed" && ms.sourceBuffers.length === 0)) && v.readyState === 0 && v.getAttribute("src") === null;
    s.rec.event("teardown-complete", { clean: report.clean });
    s.sbs = [];
    s.queueByTrack.clear();
    s.ms = undefined;
    s.prep = undefined;
    s.segState = undefined;
    s.scheduler = undefined;
    if (this.session === s) {
      this.session = undefined;
      this.state = "idle";
      this.lastReport = report;
      this.#emit();
    }
    return report;
  }
}

function sanitizeDetails(details) {
  const out = {};
  for (const [k, v] of Object.entries(details)) {
    if (k === "precheck") out.precheck = { refusal: v.refusal, layout: v.layout && { moovPlacement: v.layout.moovPlacement, firstBoxType: v.layout.firstBoxType, hasTopLevelMoof: v.layout.hasTopLevelMoof }, reads: v.reads, bytesRead: v.bytesRead };
    else out[k] = v;
  }
  return out;
}
