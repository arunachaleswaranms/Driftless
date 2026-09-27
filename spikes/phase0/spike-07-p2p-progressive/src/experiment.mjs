// EXPERIMENT ONLY. Host transfer and receiver playback have separate owners.
import * as MP4Box from "../../spike-05-mp4-segmentation/node_modules/mp4box/dist/mp4box.all.mjs";
import { openMedia } from "../../spike-06-mse-progressive/src/preparer.mjs";
import { AppendQueue } from "../../spike-06-mse-progressive/src/append-queue.mjs";
import { BoundedLog } from "../../spike-06-mse-progressive/src/diagnostics.mjs";
import { bufferedAhead, snapshotRanges } from "../../spike-06-mse-progressive/src/ranges.mjs";
import { parseInitSegment, parseMediaSegment, summariseSegmentTracks } from "../../spike-05-mp4-segmentation/src/fmp4.mjs";
import { LabPeer } from "./peer.mjs";
import { LIMITS, Reassembly, sendPart, sha256 } from "./transport.mjs";
import { HostScheduler, NeedReporter, computePlaybackNeed, disjointRetained, planTrim } from "./scheduling.mjs";

const PROFILES = Object.freeze({ FAST: 8, NORMAL: 1.5, CONSTRAINED: 0.4 });
const send = (channel, message) => {
  const value = JSON.stringify(message);
  if (value.length > LIMITS.maxControlChars || channel?.readyState !== "open") throw new RangeError("control message too large or channel closed");
  channel.send(value);
};
const checkControl = (data) => {
  if (typeof data !== "string" || data.length > LIMITS.maxControlChars) throw new RangeError("control size");
  const m = JSON.parse(data);
  if (!m || typeof m !== "object" || typeof m.type !== "string") throw new RangeError("control shape");
  return m;
};
const pause = (ms, signal) => new Promise((resolve) => {
  if (signal.aborted) return resolve(false);
  const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(true); }, ms);
  const stop = () => { clearTimeout(timer); resolve(false); };
  signal.addEventListener("abort", stop, { once: true });
});

export class Experiment {
  constructor({ video, onUpdate = () => {} }) {
    this.video = video;
    this.onUpdate = onUpdate;
    this.log = new BoundedLog(500, 40);
    this.state = "idle";
    this.stats = this.#freshStats();
    this.listeners = new AbortController();
  }
  #freshStats() { return { chunksSent: 0, bytesSent: 0, peakBufferedAmount: 0, backpressurePauses: 0, backpressureResumes: 0, partsSent: 0, chunksReceived: 0, bytesReceived: 0, partsReady: 0, segmentsReceived: 0, fragmentsAppended: 0, maxReassemblyBytes: 0, staleDropped: 0, rejected: 0, preparedMaxBytes: 0, sourceReads: 0, sourceBytesRead: 0, waiting: 0, recoveries: 0, seeks: 0, localSeeks: 0, remoteSeeks: 0, maxTransportQueue: 0, needsIgnored: 0, maxContiguousAhead: 0, maxDisjointRetained: 0, maxBufferedTotal: 0, trims: 0, waitingNeeds: 0 }; }
  event(type, data = {}) { this.log.push({ at: Math.round(performance.now()), type, ...data }); this.onUpdate(); }
  async start({ role, room = "lab", file, profile = "NORMAL" }) {
    await this.close();
    const owner = this.sessionId = (this.sessionId ?? 0) + 1;
    this.state = "connecting";
    this.role = role; this.room = room; this.file = file; this.profile = profile;
    this.stats = this.#freshStats(); this.log = new BoundedLog(500, 40);
    this.activeParts = 0;
    this.listeners = new AbortController();
    this.generation = 0; this.held = false; this.wantsPlay = false;
    // Per-session receiver state; a stale initReady would skip setting MediaSource.duration.
    this.initReady = false; this.waitingAt = null;
    this.scheduler = null; this.initSent = false;
    this.reporter = new NeedReporter(); this.segmentTimes = new Map();
    this.peer = new LabPeer({ role, room, onChannel: (c) => this.#channelOpen(c, owner), onState: (s) => { if (this.sessionId === owner) this.event("peer-state", { state: s }); }, onError: (e) => { if (this.sessionId === owner) this.#fail(e); } });
    this.event("start", { role, room, profile });
    if (role === "receiver") this.#listenVideo();
    return true;
  }
  async #channelOpen(channel, owner) {
    if (this.state === "idle" || this.sessionId !== owner) return;
    if (this.channel === channel && this.channelBound) return;
    if (this.channel && this.channel !== channel) { channel.close(); return; }
    this.channel = channel;
    this.channelBound = true;
    channel._pcMaxMessageSize = this.peer.pc.sctp?.maxMessageSize;
    channel.addEventListener("message", (e) => {
      const task = typeof e.data === "string" ? this.#control(e.data) : this.#binary(e.data);
      Promise.resolve(task).catch((error) => this.#reject(error));
    }, { signal: this.listeners.signal });
    this.state = "connected";
    this.event("channel-open", { maxMessageSize: channel._pcMaxMessageSize });
    if (this.role === "host") {
      try {
        this.prep = await openMedia(MP4Box, this.file, { targetSeconds: 2 });
        if (this.state === "idle" || this.sessionId !== owner) return;
        const p = this.prep;
        this.info = { type: "MEDIA_INFO", transferId: crypto.getRandomValues(new Uint32Array(1))[0], duration: p.durationSeconds, fileSize: this.file.size, videoCodec: p.tracks[0].codec, audioCodec: p.tracks[1].codec, width: p.tracks[0].width, height: p.tracks[0].height, videoTrack: p.videoTrackId, audioTrack: p.audioTrackId, segmentPlanVersion: 1, segmentCount: p.segmentCount };
        this.stats.sourceReads = p.reader.stats.reads; this.stats.sourceBytesRead = p.reader.stats.bytesRead;
        send(channel, this.info);
        this.event("media-info", { ...this.info });
      } catch (e) { this.#fail(e); }
    }
  }
  async #control(data) {
    const m = checkControl(data);
    if (this.state === "idle") return;
    if (this.role === "host") return this.#hostControl(m);
    return this.#receiverControl(m);
  }
  async #hostControl(m) {
    if (m.type === "RECEIVER_READY" && m.transferId === this.info?.transferId && !this.scheduler) {
      const p = this.prep;
      this.generation = 0;
      this.scheduler = new HostScheduler({ segmentCount: p.segmentCount, duration: this.info.duration, indexForTime: (t) => p.planIndexForTime(t), segmentTimes: (k) => ({ start: p.plan.segments[k].startSeconds, end: p.plan.segments[k].endSeconds }) });
      this.#startLoop();
    } else if (m.type === "PART_ACK" && m.transferId === this.info?.transferId) {
      this.ack?.(m);
    } else if ((m.type === "BUFFER_STATUS" || m.type === "SEEK_REQUEST") && m.transferId === this.info?.transferId && this.scheduler) {
      this.#hostNeed(m);
    }
  }
  // The newest valid receiver intent wins. A newer generation (any seek) abandons the
  // old loop at once; a same-generation change rebases the cursor after the in-flight segment.
  #hostNeed(m) {
    const r = this.scheduler.accept(m);
    if (!r.accepted) { this.stats.needsIgnored++; this.event("need-ignored", { message: m.type, reason: r.reason, generation: m.generation, seq: m.seq, hostGeneration: this.scheduler.generation }); return; }
    if (m.type === "BUFFER_STATUS") this.feedback = m;
    if (m.type === "SEEK_REQUEST") this.event("seek-request", { generation: m.generation, time: m.time, segment: r.target });
    if (r.retargeted) this.event("retarget", { message: m.type, reason: m.reason, generation: m.generation, seq: m.seq, segment: r.target, newGeneration: r.newGeneration });
    if (r.newGeneration) {
      this.generation = this.scheduler.generation;
      this.#startLoop();
    } else this.#wake();
  }
  #startLoop() {
    this.loopAbort?.abort();
    const previous = this.loopPromise ?? Promise.resolve();
    const abort = new AbortController(); this.loopAbort = abort;
    // One parser/source-reader owner: an older cut must settle before a newer
    // generation starts reading. Superseded queued generations never run.
    this.loopPromise = previous.then(() => {
      if (abort.signal.aborted || this.loopAbort !== abort || this.state === "idle") return;
      return this.#hostLoop(abort.signal);
    }).catch((e) => { if (!abort.signal.aborted) this.#fail(e); });
  }
  async #hostLoop(signal) {
    const p = this.prep; const sched = this.scheduler; const generation = this.generation;
    if (!this.initSent) {
      const inits = p.initSegments().perTrack;
      for (const track of p.trackIds) {
        if (!await this.#sendOne(inits[track].buffer, { segment: -1, track, generation }, signal)) return;
      }
      this.initSent = true;
      this.event("init-sent", { generation });
    }
    // No persistent read position: every iteration asks the scheduler, which follows the
    // latest receiver need. Waits end on a newer need, resume, profile change, or abort.
    while (!signal.aborted && generation === this.generation) {
      const next = sched.next({ held: this.held });
      if (next.wait) {
        if (!await this.#waitWake(signal)) return;
        continue;
      }
      const k = next.segment;
      const seg = p.plan.segments[k];
      sched.begin(k);
      try {
        const cut = await p.cut(k);
        if (signal.aborted || generation !== this.generation) return;
        this.stats.preparedMaxBytes = Math.max(this.stats.preparedMaxBytes, cut.bytes);
        this.stats.sourceReads = p.reader.stats.reads; this.stats.sourceBytesRead = p.reader.stats.bytesRead;
        this.event("segment-prepared", { segment: k, bytes: cut.bytes, reads: cut.reads, generation });
        for (const part of cut.parts) {
          if (!await this.#sendOne(part.buffer, { segment: k, track: part.trackId, generation, start: seg.startSeconds, end: seg.endSeconds }, signal)) return;
        }
        if (signal.aborted || generation !== this.generation) return;
        sched.delivered(generation, k);
      } finally { if (sched.inFlight === k) sched.abandon(); }
      this.event("segment-sent", { segment: k, generation });
      const delay = (seg.endSeconds - seg.startSeconds) * 1000 / PROFILES[this.profile];
      if (delay > 0 && !await pause(delay, signal)) return;
    }
  }
  async #sendOne(buffer, meta, signal) {
    if (signal.aborted || this.channel?.readyState !== "open") return false;
    this.activeParts = (this.activeParts ?? 0) + 1;
    this.stats.maxTransportQueue = Math.max(this.stats.maxTransportQueue, this.activeParts);
    try {
      const bytes = new Uint8Array(buffer);
      const info = { type: "PART_INFO", transferId: this.info.transferId, ...meta, bytes: bytes.length, chunks: Math.ceil(bytes.length / LIMITS.chunkBytes), sha256: await sha256(bytes) };
      if (signal.aborted) return false;
      send(this.channel, info);
      const accepted = await sendPart({ channel: this.channel, bytes, info, signal, stats: this.stats, isCurrent: () => this.generation === meta.generation });
      if (!accepted) return false;
      this.stats.partsSent++;
      const ack = await new Promise((resolve) => {
        const stop = () => { this.ack = null; resolve(null); };
        if (signal.aborted) return stop();
        this.ack = (m) => { if (m.generation === meta.generation && m.segment === meta.segment && m.track === meta.track) { signal.removeEventListener("abort", stop); this.ack = null; resolve(m); } };
        signal.addEventListener("abort", stop, { once: true });
      });
      if (ack && !ack.ok) throw new Error(`receiver rejected segment ${meta.segment} track ${meta.track}`);
      return Boolean(ack && !signal.aborted);
    } finally { this.activeParts--; }
  }
  #wake() { const w = this.wake; this.wake = null; w?.(); }
  #waitWake(signal) { return new Promise((resolve) => { const stop = () => { this.wake = null; resolve(false); }; if (signal.aborted) return stop(); this.wake = () => { signal.removeEventListener("abort", stop); resolve(true); }; signal.addEventListener("abort", stop, { once: true }); }); }
  async #receiverControl(m) {
    if (m.type === "MEDIA_INFO") {
      const owner = this.sessionId;
      if (this.info) throw new RangeError("unexpected second media info");
      if (!Number.isInteger(m.transferId) || !Number.isFinite(m.duration) || m.duration <= 0 || !Number.isSafeInteger(m.fileSize) || m.fileSize <= 0 || !Number.isInteger(m.segmentCount) || m.segmentCount < 1 || m.segmentCount > 100_000 || !Number.isInteger(m.videoTrack) || !Number.isInteger(m.audioTrack) || m.segmentPlanVersion !== 1) throw new RangeError("invalid media info");
      const videoMime = `video/mp4; codecs="${m.videoCodec}"`, audioMime = `audio/mp4; codecs="${m.audioCodec}"`;
      if (!MediaSource.isTypeSupported(videoMime) || !MediaSource.isTypeSupported(audioMime)) throw new RangeError("MSE codec unsupported");
      this.info = m;
      this.reassembly = new Reassembly({ transferId: m.transferId, generation: 0, trackIds: [m.videoTrack, m.audioTrack], segmentCount: m.segmentCount });
      try { await this.#openMSE(videoMime, audioMime); }
      catch (error) { this.#fail(error); return; }
      if (this.state === "idle" || this.sessionId !== owner) return;
      send(this.channel, { type: "RECEIVER_READY", transferId: m.transferId });
      this.event("media-info", { ...m });
    } else if (m.type === "PART_INFO") {
      if (!this.reassembly) throw new RangeError("part before media info");
      if (m.generation < this.generation) { this.stats.staleDropped++; return; }
      if (m.generation > this.generation) throw new RangeError("unexpected future generation");
      this.reassembly.begin(m);
      if (m.segment >= 0) this.segmentTimes.set(m.segment, { start: m.start, end: m.end });
      this.event("part-info", { segment: m.segment, track: m.track, generation: m.generation, bytes: m.bytes });
    }
  }
  async #binary(buffer) {
    if (this.role !== "receiver" || !this.reassembly) throw new RangeError("unexpected binary");
    // Old-generation frames are harmless after a seek; no old frame may enter reassembly.
    const header = buffer instanceof ArrayBuffer && buffer.byteLength >= 16 ? new DataView(buffer) : null;
    if (header && header.getUint32(12) < this.generation) { this.stats.staleDropped++; return; }
    const complete = this.reassembly.accept(buffer);
    this.stats.chunksReceived++; this.stats.bytesReceived += buffer.byteLength - LIMITS.headerBytes;
    this.stats.maxReassemblyBytes = Math.max(this.stats.maxReassemblyBytes, this.reassembly.maxHeldBytes);
    if (!complete) return;
    const info = this.reassembly.part.info;
    try {
      const result = await this.reassembly.complete();
      if (this.state === "idle" || info.generation !== this.generation) { this.stats.staleDropped++; return; }
      this.stats.partsReady++;
      await this.#appendPart(info, result.bytes);
      if (this.state === "idle" || info.generation !== this.generation) return;
      send(this.channel, { type: "PART_ACK", transferId: this.info.transferId, generation: info.generation, segment: info.segment, track: info.track, ok: true });
    } catch (error) {
      if (this.state !== "idle" && info.generation === this.generation) send(this.channel, { type: "PART_ACK", transferId: this.info.transferId, generation: info.generation, segment: info.segment, track: info.track, ok: false });
      throw error;
    }
  }
  async #openMSE(videoMime, audioMime) {
    const ms = new MediaSource(); this.ms = ms;
    const opened = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("sourceopen timeout")), 10000);
      ms.addEventListener("sourceopen", () => { clearTimeout(timeout); resolve(); }, { once: true, signal: this.listeners.signal });
      this.listeners.signal.addEventListener("abort", () => { clearTimeout(timeout); resolve(false); }, { once: true });
    });
    this.url = URL.createObjectURL(ms); this.video.src = this.url;
    const result = await opened;
    if (result === false || this.state === "idle") return;
    URL.revokeObjectURL(this.url); this.url = null;
    this.buffers = new Map();
    for (const [track, mime] of [[this.info.videoTrack, videoMime], [this.info.audioTrack, audioMime]]) {
      const sb = ms.addSourceBuffer(mime);
      const queue = new AppendQueue(sb, { label: String(track), onFailure: (e) => this.#fail(new Error(`MSE ${e.code}: ${e.message}`)) });
      this.buffers.set(track, { sb, queue, init: null });
    }
    this.event("source-open");
  }
  async #appendPart(info, bytes) {
    const owner = this.sessionId;
    const entry = this.buffers.get(info.track);
    if (!entry) throw new RangeError("unknown MSE track");
    if (info.segment === -1) {
      const parsed = parseInitSegment(bytes.buffer);
      if (parsed.problems.length || parsed.tracks.length !== 1 || parsed.tracks[0].trackId !== info.track) throw new RangeError("invalid init fragment");
      entry.init = parsed;
    } else {
      if (!entry.init || this.buffers.size !== [...this.buffers.values()].filter((b) => b.init).length) throw new RangeError("media before init");
      const parsed = parseMediaSegment(bytes.buffer, entry.init);
      const tracks = summariseSegmentTracks(parsed);
      if (parsed.problems.length || tracks.length !== 1 || tracks[0].trackId !== info.track || (info.track === this.info.videoTrack && !tracks[0].firstIsSync)) throw new RangeError("invalid media fragment");
    }
    entry.queue.append(bytes, { segment: info.segment, generation: info.generation });
    await entry.queue.whenIdle();
    if (this.sessionId !== owner || this.state === "idle" || info.generation !== this.generation) return;
    if (entry.queue.state === "failed") throw new Error("MSE append failed");
    this.stats.fragmentsAppended++;
    this.event(info.segment === -1 ? "init-appended" : "fragment-appended", { segment: info.segment, track: info.track, generation: info.generation, bytes: bytes.length });
    if (info.segment === -1) {
      if ([...this.buffers.values()].every((b) => b.init) && !this.initReady) {
        this.ms.duration = this.info.duration;
        this.initReady = true;
        this.event("init-ready", { duration: this.ms.duration });
      }
    } else {
      this.segmentParts ??= new Map();
      const got = this.segmentParts.get(info.segment) ?? new Set(); got.add(info.track); this.segmentParts.set(info.segment, got);
      if (got.size === 2) {
        this.segmentParts.delete(info.segment);
        this.stats.segmentsReceived++;
        this.event("segment-ready", { segment: info.segment, buffered: snapshotRanges(this.video.buffered) });
        this.#feedback({ reason: "segment-ready" });
        this.#trimBufferWindow();
        if (this.wantsPlay && this.stats.segmentsReceived >= 2 && this.video.paused) await this.#tryPlay();
      }
    }
  }
  #listenVideo() {
    const v = this.video;
    for (const type of ["playing", "waiting", "seeking", "seeked", "timeupdate", "error"]) v.addEventListener(type, () => this.#videoEvent(type), { signal: this.listeners.signal });
  }
  #videoEvent(type) {
    if (this.state === "idle") return;
    const v = this.video;
    if (type === "timeupdate") { this.#feedback({ reason: "timeupdate" }); this.#trimBufferWindow(); return; }
    if (type === "waiting") {
      const ranges = snapshotRanges(v.buffered);
      const ahead = bufferedAhead(ranges, v.currentTime, 0.1);
      this.stats.waiting++;
      this.waitingAt = performance.now();
      this.event("waiting", { time: v.currentTime, readyState: v.readyState, buffered: ranges, bufferAhead: ahead, seeking: v.seeking });
      // A stall is a playback need in itself: report it now rather than waiting for the
      // host to reach the gap, and let the window trim while the playhead is stuck.
      if (this.#feedback({ reason: "waiting", force: true })) this.stats.waitingNeeds++;
      this.#trimBufferWindow();
    }
    if (type === "playing") {
      if (this.waitingAt != null) { this.stats.recoveries++; this.event("recovery", { latencyMs: performance.now() - this.waitingAt, time: this.video.currentTime }); this.waitingAt = null; }
      if (!this.firstPlaying) this.firstPlaying = { at: performance.now(), currentTime: this.video.currentTime, segmentsReceived: this.stats.segmentsReceived, bytesReceived: this.stats.bytesReceived, percentTransferred: this.stats.bytesReceived / this.info.fileSize * 100, bufferedSeconds: bufferedAhead(snapshotRanges(this.video.buffered), this.video.currentTime, 0.1) };
    }
    if (type === "seeking") {
      this.stats.seeks++;
      const ranges = snapshotRanges(v.buffered);
      // Strict: a target just before the buffered start cannot resolve locally.
      const covered = ranges.some(([a, b]) => v.currentTime >= a && v.currentTime < b);
      this.event("seeking", { time: v.currentTime, buffered: covered });
      if (this.info && this.initReady) {
        // Every seek is a new playback intent. A buffered seek plays locally, but still
        // changes what the host should send next, so it too starts a new generation.
        this.generation++;
        this.reassembly.reset(this.generation);
        this.segmentParts?.clear();
        if (!covered) {
          this.stats.remoteSeeks++;
          send(this.channel, { type: "SEEK_REQUEST", transferId: this.info.transferId, generation: this.generation, seq: this.reporter.claimSeq(), time: v.currentTime });
          this.event("remote-seek", { generation: this.generation, time: v.currentTime });
        } else {
          this.stats.localSeeks++;
          this.event("local-seek", { generation: this.generation, time: v.currentTime });
        }
        this.#feedback({ reason: covered ? "local-seek" : "remote-seek", force: true });
      }
    }
    this.event(`video-${type}`, { time: v.currentTime, readyState: v.readyState, buffered: snapshotRanges(v.buffered) });
    if (type !== "seeking" && type !== "waiting") this.#feedback({ reason: type });
    if (type === "seeked") this.#trimBufferWindow();
  }
  #need() {
    const ranges = snapshotRanges(this.video.buffered);
    return { ranges, need: computePlaybackNeed({ ranges, currentTime: this.video.currentTime, segments: this.segmentTimes, segmentCount: this.info.segmentCount, seeking: this.video.seeking }) };
  }
  // Receiver -> host playback need. Returns true when a message was sent.
  #feedback({ reason, force = false } = {}) {
    if (this.role !== "receiver" || !this.info || !this.initReady || this.channel?.readyState !== "open") return false;
    const { ranges, need } = this.#need();
    const s = this.stats;
    s.maxContiguousAhead = Math.max(s.maxContiguousAhead, need.contiguousAhead);
    s.maxDisjointRetained = Math.max(s.maxDisjointRetained, disjointRetained(ranges, need.currentTime));
    s.maxBufferedTotal = Math.max(s.maxBufferedTotal, ranges.reduce((n, [a, b]) => n + b - a, 0));
    const body = this.reporter.next(need, { generation: this.generation, reason, force });
    if (!body) return false;
    send(this.channel, { type: "BUFFER_STATUS", transferId: this.info.transferId, ...body });
    this.lastNeed = body;
    if (force) this.event("need-sent", body);
    return true;
  }
  #trimBufferWindow() {
    if (!this.buffers || this.ms?.readyState !== "open" || this.trimming) return;
    const { ranges, need } = this.#need();
    const plan = planTrim({ ranges, currentTime: need.currentTime, contiguousBufferedEnd: need.contiguousBufferedEnd, duration: this.info.duration, seeking: this.video.seeking });
    if (!plan) return;
    const { back, future } = plan;
    this.trimming = true;
    this.stats.trims++;
    const owner = this.sessionId;
    try {
      for (const b of this.buffers.values()) {
        if (back) b.queue.remove(back[0], back[1], { kind: "back-buffer-trim" });
        if (future) b.queue.remove(future[0], future[1], { kind: "future-buffer-trim" });
      }
      this.event("buffer-window-trim", { time: need.currentTime, back, future, buffered: ranges });
      Promise.all([...this.buffers.values()].map((b) => b.queue.whenIdle())).finally(() => { if (this.sessionId === owner) this.trimming = false; });
    } catch (e) { this.trimming = false; this.#fail(e); }
  }
  async #tryPlay() {
    const owner = this.sessionId;
    try { await this.video.play(); if (this.sessionId === owner) this.event("play-request-accepted", { time: this.video.currentTime }); }
    catch (e) { if (this.sessionId === owner) this.event("play-rejected", { name: e.name, message: e.message }); }
  }
  play() { if (this.role !== "receiver") return; this.wantsPlay = true; if (this.stats.segmentsReceived >= 2) this.#tryPlay(); }
  setProfile(profile) { if (!(profile in PROFILES)) throw new RangeError("profile"); this.profile = profile; this.event("profile", { profile }); this.#wake(); }
  hold() { this.held = true; this.event("transfer-hold"); }
  resume() { this.held = false; this.event("transfer-resume"); this.#wake(); }
  seek(time) { if (this.role !== "receiver" || !Number.isFinite(time) || time < 0 || time >= this.info?.duration) throw new RangeError("seek time"); this.video.currentTime = time; }
  injectInvalid() { if (this.role !== "host" || this.channel?.readyState !== "open") throw new Error("host channel is not open"); this.channel.send(new Uint8Array([1, 2, 3, 4])); this.event("invalid-injected"); }
  #reject(error) { this.stats.rejected++; this.event("rejected", { message: error.message }); }
  #fail(error) { if (this.state === "idle") return; this.state = "failed"; this.event("failure", { message: error?.message ?? String(error) }); }
  snapshot() {
    const ranges = snapshotRanges(this.video.buffered);
    return { state: this.state, role: this.role, profile: this.profile, peer: this.peer?.pc.connectionState, channel: this.channel?.readyState, info: this.info, generation: this.generation, scheduler: this.scheduler?.snapshot(), reporter: this.role === "receiver" ? { ...this.reporter.stats, lastNeed: this.lastNeed } : undefined, held: this.held, stats: { ...this.stats }, firstPlaying: this.firstPlaying, time: this.video.currentTime, readyState: this.video.readyState, paused: this.video.paused, seeking: this.video.seeking, frames: this.video.getVideoPlaybackQuality?.().totalVideoFrames, buffered: ranges, bufferAhead: bufferedAhead(ranges, this.video.currentTime, 0.1), ms: this.ms?.readyState, sourceBuffers: this.buffers ? [...this.buffers.values()].map((b) => ({ updating: b.sb.updating, queue: b.queue.snapshot() })) : [], reassembly: this.reassembly?.part ? { segment: this.reassembly.part.info.segment, received: this.reassembly.part.received, chunks: this.reassembly.part.info.chunks, bytes: this.reassembly.part.heldBytes } : null, source: this.prep?.stats(), feedback: this.feedback, events: this.log.last(80), selectedPair: this.selectedPairValue, lastClose: this.lastClose };
  }
  async refreshPair() { this.selectedPairValue = await this.peer?.selectedPair(); return this.selectedPairValue; }
  async close() {
    if (this.state === "idle") return this.lastClose;
    this.loopAbort?.abort(); this.#wake();
    await this.loopPromise;
    this.listeners.abort();
    const closedChannel = this.channel && this.channel.readyState !== "closed" ? new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 2000);
      this.channel.addEventListener("close", () => { clearTimeout(timer); resolve(true); }, { once: true });
    }) : Promise.resolve(true);
    this.peer?.close();
    await closedChannel;
    for (const b of this.buffers?.values() ?? []) b.queue.close();
    if (this.ms?.readyState === "open") for (const b of this.buffers?.values() ?? []) if (!b.sb.updating) { try { this.ms.removeSourceBuffer(b.sb); } catch {} }
    this.video.pause(); this.video.removeAttribute("src"); this.video.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.prep?.close();
    this.reassembly?.reset(this.generation);
    this.segmentParts?.clear();
    this.lastClose = { clean: this.peer?.pc.signalingState === "closed" && this.channel?.readyState === "closed" && !this.url && !this.prep?.mp4, peer: this.peer?.pc.signalingState, channel: this.channel?.readyState, ms: this.ms?.readyState, queues: this.buffers ? [...this.buffers.values()].map((b) => b.queue.state) : [] };
    this.state = "idle"; this.role = null; this.peer = null; this.channel = null; this.channelBound = false; this.prep = null; this.reassembly = null; this.buffers = null; this.ms = null; this.info = null; this.segmentParts = null; this.feedback = null; this.firstPlaying = null; this.ack = null; this.trimming = false; this.scheduler = null; this.initSent = false; this.segmentTimes?.clear(); this.lastNeed = null;
    this.event("closed", this.lastClose);
    return this.lastClose;
  }
}
