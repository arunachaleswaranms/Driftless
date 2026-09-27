// Scripted Spike 0.6 experiments (MSE-01 … MSE-12 plus supplementary observations).
//
// Each experiment drives the pipeline against the file(s) selected on the page and
// returns bounded evidence: explicit checks with their observed values, observations
// that are recorded but not graded, and a pipeline evidence bundle. An experiment's
// status is PASS only when every check passed; OBSERVED experiments have no checks
// that could fail. Playback is started with play(); the page never bypasses the
// browser's autoplay policy.

import { openMedia } from "./preparer.mjs";
import { bufferedAhead, rangeIndexAt, snapshotRanges } from "./ranges.mjs";
import { displayName, round, trimForEvidence } from "./diagnostics.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(pred, { timeoutMs = 10_000, pollMs = 50 } = {}) {
  const t0 = performance.now();
  for (;;) {
    const v = pred();
    if (v) return { ok: true, ms: round(performance.now() - t0, 1) };
    if (performance.now() - t0 >= timeoutMs) return { ok: false, ms: round(performance.now() - t0, 1) };
    await sleep(pollMs);
  }
}

function checker() {
  const checks = [];
  const check = (name, ok, observed) => {
    checks.push({ name, ok: Boolean(ok), observed });
    return Boolean(ok);
  };
  return { checks, check };
}

const r3 = (ranges) => ranges.map(([a, b]) => [round(a), round(b)]);
const snap = (p) => p.snapshot();
const ct = (video) => video.currentTime;

function requireFiles(files, n, id) {
  if (files.length < n) throw new Error(`${id} needs ${n} selected file(s); ${files.length} selected`);
}

function fileInfo(file) {
  return file ? { name: displayName(file.name), size: file.size } : undefined;
}

function baseResult(id, title, files) {
  return {
    id,
    title,
    files: files.map(fileInfo),
    userAgent: navigator.userAgent,
    startedAt: new Date().toISOString(),
    userActivation: { hasBeenActive: navigator.userActivation?.hasBeenActive, isActive: navigator.userActivation?.isActive },
    page: { visibilityState: document.visibilityState, hasFocus: document.hasFocus() },
  };
}

function finish(result, checks, { observedOnly = false } = {}) {
  result.checks = checks;
  result.status = observedOnly ? "OBSERVED" : checks.length && checks.every((c) => c.ok) ? "PASS" : "FAIL";
  result.finishedAt = new Date().toISOString();
  return result;
}

function counts(p, ...types) {
  const c = p.snapshot().counts ?? {};
  return Object.fromEntries(types.map((t) => [t, c[t] ?? 0]));
}

/** Frames presented between two snapshots, from requestVideoFrameCallback. */
const framesOf = (s) => s.frames?.presented ?? 0;

function sampleSeries(p, everyMs = 1000) {
  const samples = p.recorder?.samples.entries() ?? [];
  const out = [];
  let next = -Infinity;
  for (const x of samples) {
    if (x.t >= next) {
      out.push({ t: x.t, ct: x.ct, ahead: x.ahead, bEnd: x.bEnd, rs: x.rs, w: x.w, fr: x.fr, app: x.app });
      next = x.t + everyMs;
    }
  }
  return out;
}

// ------------------------------------------------------------------ MSE-01

async function capability({ files, video, MP4Box }) {
  const result = baseResult("mse-01-capability", "MSE-01 Capability detection", files);
  const { checks, check } = checker();
  let derived;
  if (files[0]) {
    try {
      const prep = await openMedia(MP4Box, files[0], { blockSize: 1024 * 1024 });
      derived = { ...prep.mime, tracks: prep.tracks.map((t) => ({ id: t.id, kind: t.kind, codec: t.codec })) };
      prep.close();
    } catch (e) {
      derived = { refused: e.code, message: e.message };
    }
  }
  const probes = [
    ...(derived?.combined ? [derived.combined, derived.video, derived.audio] : []),
    'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
    'video/mp4; codecs="avc1.4D401E, mp4a.40.2"',
    'video/mp4; codecs="avc1.64001F, mp4a.40.2"',
    'video/mp4; codecs="avc1.640028"',
    'audio/mp4; codecs="mp4a.40.5"',
    'video/mp4; codecs="hvc1.1.6.L63.90"',
    'video/mp4; codecs="av01.0.05M.08"',
    'video/webm; codecs="vp9, opus"',
    'audio/mp4; codecs="opus"',
    'audio/mp4; codecs="mp4a.6B"',
    'audio/mpeg',
    'video/mp4; codecs="avc1.FFFFFF"',
    'video/mp4; codecs="bogus"',
    'video/x-matroska; codecs="avc1.64001F"',
    "video/mp4",
  ];
  const matrix = [...new Set(probes)].map((mime) => ({ mime, isTypeSupported: MediaSource.isTypeSupported(mime), canPlayType: video.canPlayType(mime) }));
  result.derived = derived;
  result.matrix = matrix;
  result.api = {
    MediaSource: typeof MediaSource,
    ManagedMediaSource: typeof globalThis.ManagedMediaSource,
    canConstructInDedicatedWorker: MediaSource.canConstructInDedicatedWorker,
    changeType: typeof SourceBuffer !== "undefined" && "changeType" in SourceBuffer.prototype,
    requestVideoFrameCallback: "requestVideoFrameCallback" in HTMLVideoElement.prototype,
    getVideoPlaybackQuality: "getVideoPlaybackQuality" in HTMLVideoElement.prototype,
  };
  const get = (m) => matrix.find((x) => x.mime === m)?.isTypeSupported;
  if (derived?.combined) {
    check("derived muxed target MIME is supported", get(derived.combined) === true, derived.combined);
    check("derived video-only MIME is supported", get(derived.video) === true, derived.video);
    check("derived audio-only MIME is supported", get(derived.audio) === true, derived.audio);
  } else {
    check("a target file was selected to derive the codec strings", false, derived);
  }
  check("an invalid AVC profile string is rejected", get('video/mp4; codecs="avc1.FFFFFF"') === false, get('video/mp4; codecs="avc1.FFFFFF"'));
  check("an unknown codec is rejected", get('video/mp4; codecs="bogus"') === false, get('video/mp4; codecs="bogus"'));
  result.note = "A positive isTypeSupported() answer is capability evidence only; playback evidence comes from the other experiments.";
  return finish(result, checks);
}

// ------------------------------------------------------------------ MSE-02/03/04

async function setupAndAppend({ pipeline: p, files, video, params }) {
  requireFiles(files, 1, "mse-02-04");
  const result = baseResult("mse-02-04-setup-append", "MSE-02 MediaSource creation, MSE-03 initialization append, MSE-04 incremental append", files);
  const { checks, check } = checker();
  const steps = params.steps ?? 8;
  const load = await p.load(files[0], { profile: "MANUAL", initialSegments: 0, bufferMode: params.bufferMode ?? "muxed" });
  result.load = load;
  if (!check("load succeeded", load.ok, load.refusal ?? load.failure)) return finish(result, checks);
  const s0 = snap(p);
  const tl = p.recorder.timeline.entries();
  const attached = tl.find((e) => e.type === "attached");
  const opened = tl.find((e) => e.type === "ms-sourceopen");
  check("MSE-02: MediaSource was closed before attach and fired sourceopen", attached?.msReadyState === "closed" && opened !== undefined, { attached: attached?.msReadyState, sourceopenAt: opened?.t });
  check("MSE-02: MediaSource.readyState is open", s0.msReadyState === "open", s0.msReadyState);
  check("MSE-02: SourceBuffer(s) created in 'segments' mode", s0.sourceBuffers.length > 0 && s0.sourceBuffers.every((b) => b.mode === "segments"), s0.sourceBuffers.map((b) => [b.key, b.mime, b.mode]));
  check("MSE-02: object URL revoked after sourceopen", s0.resources.liveObjectUrls === 0 && s0.resources.totals.urlsCreated === 1, s0.resources);
  const init = s0.initResult;
  const vt = p.preparer.tracks.find((t) => t.kind === "video");
  check("MSE-03: init segment appended without error", init && !s0.failure && s0.sourceBuffers.every((b) => b.queue.stats.appendsCompleted === 1), s0.sourceBuffers.map((b) => b.queue.stats));
  // Chrome runs the init-segment metadata step after updateend, so wait for the event.
  const meta = await waitFor(() => (snap(p).counts["media-loadedmetadata"] ?? 0) > 0, { timeoutMs: 3000, pollMs: 5 });
  const tl0 = p.recorder.timeline.entries();
  const initDone = tl0.find((e) => e.type === "init-appended")?.t;
  const metaAt = tl0.find((e) => e.type === "media-loadedmetadata")?.t;
  result.init = { ...init, atUpdateEnd: { readyState: init.videoReadyState, videoWidth: init.videoWidth, loadedMetadataFired: init.loadedMetadataFired, durationAfterInit: String(init.durationAfterInit) }, loadedMetadataAfterInitMs: metaAt !== undefined && initDone !== undefined ? round(metaAt - initDone, 1) : undefined, afterLoadedMetadata: { readyState: video.readyState, videoWidth: video.videoWidth, videoHeight: video.videoHeight, msDuration: snap(p).msDuration } };
  check("MSE-03: loadedmetadata fired and readyState >= HAVE_METADATA", meta.ok && video.readyState >= 1, result.init.afterLoadedMetadata);
  check("MSE-03: decoded dimensions match the video track", video.videoWidth === vt.width && video.videoHeight === vt.height, [video.videoWidth, video.videoHeight, vt.width, vt.height]);

  const plan = p.preparer.plan.segments;
  const perStep = [];
  let firstFrameReady;
  for (let i = 0; i < steps && i < plan.length; i += 1) {
    await p.release(1);
    const w = await waitFor(() => snap(p).segments.appended >= i + 1, { timeoutMs: 5000 });
    if (i === 0) {
      const appendedAt = performance.now();
      const rs = await waitFor(() => video.readyState >= 2, { timeoutMs: 3000, pollMs: 5 });
      firstFrameReady = { reached: rs.ok, afterFirstSegmentAppendMs: round(performance.now() - appendedAt, 1), readyState: video.readyState };
    }
    const sn = snap(p);
    const ranges = sn.buffered;
    perStep.push({
      step: i + 1,
      k: i,
      appended: sn.segments.appended,
      waitMs: w.ms,
      planEnd: round(plan[i].endSeconds),
      elementRanges: r3(ranges),
      sourceBufferRanges: sn.sourceBuffers.map((b) => [b.key, r3(b.ranges)]),
      bufferedEnd: ranges.length ? round(ranges[ranges.length - 1][1]) : undefined,
      readyState: sn.readyState,
      currentTime: round(sn.currentTime),
    });
  }
  result.perStep = perStep;
  const sn = snap(p);
  const log = p.recorder.appendLog.entries();
  const media = log.filter((e) => e.k !== undefined);
  check(`MSE-04: ${steps} media segments appended one at a time`, sn.segments.appended === steps, sn.segments.appended);
  // One append per track per segment, whether the tracks share a SourceBuffer or not.
  check("MSE-04: every append completed with updateend and no error", media.length === steps * p.preparer.trackIds.length && media.every((e) => !e.error && !e.aborted), { mediaAppends: media.length });
  check("MSE-04: appendBuffer never issued while updating", sn.sourceBuffers.every((b) => b.queue.stats.invalidStateThrows === 0 && b.queue.stats.foreignUpdating === 0), sn.sourceBuffers.map((b) => b.queue.stats));
  check("MSE-04: buffered stays one contiguous range and its end grows with every segment", perStep.every((x) => x.elementRanges.length === 1) && perStep.every((x, i) => i === 0 || x.bufferedEnd > perStep[i - 1].bufferedEnd), perStep.map((x) => x.elementRanges));
  const dev = perStep.map((x) => round(x.bufferedEnd - x.planEnd));
  result.bufferedEndMinusPlanEnd = dev;
  check("MSE-04: buffered end tracks the appended segment end (within 0.25 s)", dev.every((d) => Math.abs(d) <= 0.25), dev);
  check("MSE-04: nothing played while appending (paused, currentTime 0)", sn.paused && sn.currentTime === 0, { paused: sn.paused, currentTime: sn.currentTime });
  result.firstFrameReady = firstFrameReady;
  check("MSE-04: readyState reached HAVE_CURRENT_DATA or better once the first segment was appended", firstFrameReady?.reached, { firstFrameReady, perStepReadyState: perStep.map((x) => x.readyState) });
  result.appendLog = trimForEvidence(log, 20, 5);
  result.presentation = p.preparer.presentationInfo();
  result.evidence = p.evidence({ timeline: 120, appends: 0, samples: 0 });
  result.reset = await p.reset("scenario-end");
  return finish(result, checks);
}

// ------------------------------------------------------------------ MSE-05

async function earlyPlayback({ pipeline: p, files, video, params }) {
  requireFiles(files, 1, "mse-05");
  const result = baseResult("mse-05-early-playback", "MSE-05 Early playback / initial-buffer test", files);
  const { checks, check } = checker();
  const initial = params.initialSegments ?? 2;
  const tLoad = performance.now();
  const load = await p.load(files[0], { profile: "MANUAL", initialSegments: initial, bufferMode: params.bufferMode ?? "muxed" });
  result.load = load;
  if (!check("load succeeded", load.ok, load.refusal ?? load.failure)) return finish(result, checks);
  await waitFor(() => snap(p).segments.appended >= initial, { timeoutMs: 5000 });
  const before = snap(p);
  const initialEnd = before.frontiers.appendedEndSeconds;
  result.initialSupply = { segments: before.segments.appended, total: before.plan.segments, mediaEndSeconds: initialEnd, bufferedRanges: r3(before.buffered), appendedBytes: before.totals.appendedBytes, sourceBytesRead: before.source.bytesRead, sourceSize: before.file.size, readyState: before.readyState };
  const digests = [p.frameDigest()];
  const playPromise = p.play();
  const playing = await waitFor(() => snap(p).firstPlaying, { timeoutMs: 10_000 });
  const fp = snap(p).firstPlaying;
  result.firstPlaying = fp;
  result.loadToFirstPlayingMs = fp ? round(fp.at, 1) : undefined;
  result.wallLoadToPlayingMs = round(performance.now() - tLoad, 1);
  check("'playing' fired", playing.ok, fp);
  if (!playing.ok) {
    result.play = await Promise.race([playPromise, sleep(500).then(() => "pending")]);
    result.evidence = p.evidence({ timeline: 200, appends: 50, samples: 200 });
    result.reset = await p.reset("scenario-end");
    return finish(result, checks);
  }
  check("playback began before all segments were supplied", fp.appendedSegments < fp.totalSegments && fp.deliveredSegments < fp.totalSegments, { appended: fp.appendedSegments, delivered: fp.deliveredSegments, total: fp.totalSegments });
  const f0 = framesOf(snap(p));
  const adv = await waitFor(() => ct(video) >= Math.min(1.5, initialEnd - 0.5), { timeoutMs: 8000 });
  const mid = snap(p);
  digests.push(p.frameDigest());
  check("currentTime advanced while later segments were withheld", adv.ok && mid.segments.appended === initial && mid.totals.delivered === initial, { currentTime: round(mid.currentTime), appended: mid.segments.appended, delivered: mid.totals.delivered });
  // Release the withheld segments progressively before the initial supply runs out.
  await waitFor(() => bufferedAhead(snapshotRanges(video.buffered), ct(video), 0.1) < 1.5, { timeoutMs: 15_000 });
  result.releasedAt = { currentTime: round(ct(video)), ahead: round(bufferedAhead(snapshotRanges(video.buffered), ct(video), 0.1)) };
  p.setProfile(params.releaseProfile ?? "NORMAL");
  const target = initialEnd + (params.continueSeconds ?? 8);
  const cont = await waitFor(() => ct(video) >= target, { timeoutMs: (params.continueSeconds ?? 8) * 1000 + 15_000 });
  digests.push(p.frameDigest());
  const after = snap(p);
  result.after = { currentTime: round(after.currentTime), appended: after.segments.appended, appendedAfterFirstPlaying: after.totals.appendedAfterFirstPlaying, deliveredAfterFirstPlaying: after.totals.deliveredAfterFirstPlaying, bufferedRanges: r3(after.buffered), stalls: after.stalls, openStall: after.openStall };
  check("playback continued past the end of the initial supply", cont.ok, { currentTime: round(after.currentTime), initialSupplyEnd: initialEnd, target });
  check("more segments arrived and were appended after playback began", after.totals.appendedAfterFirstPlaying >= 3, after.totals.appendedAfterFirstPlaying);
  const framesDelta = framesOf(after) - f0;
  result.frames = { presentedAtFirstPlaying: f0, presentedAtEnd: framesOf(after), delta: framesDelta, totalVideoFrames: after.frames.totalVideoFrames, droppedVideoFrames: after.frames.droppedVideoFrames, firstFrameAt: after.milestones.firstFrameAt };
  check("video frames were presented continuously (requestVideoFrameCallback)", framesDelta >= 10 * (after.currentTime - (fp.currentTime ?? 0)), result.frames);
  result.frameDigests = digests;
  check("displayed frames changed over time (canvas digests differ)", new Set(digests.filter(Boolean).map((d) => d.digest)).size >= 2, digests);
  const play = await Promise.race([playPromise, sleep(200).then(() => ({ pending: true }))]);
  result.play = play;
  check("play() resolved (no autoplay rejection)", play.ok === true, play);
  check("no pipeline failure or media error", !after.failure && !after.videoError, after.failure ?? after.videoError);
  result.series = sampleSeries(p, 1000);
  result.evidence = p.evidence({ timeline: 250, appends: 60, samples: 0 });
  result.reset = await p.reset("scenario-end");
  return finish(result, checks);
}

// ------------------------------------------------------------------ MSE-06

async function aheadBuffering({ pipeline: p, files, video, params }) {
  requireFiles(files, 1, "mse-06");
  const result = baseResult("mse-06-ahead-buffering", "MSE-06 Ahead-of-playback buffering (delivery faster than playback)", files);
  const { checks, check } = checker();
  const lookahead = params.lookaheadSeconds ?? 60;
  const load = await p.load(files[0], { profile: "FAST", initialSegments: 2, lookaheadSeconds: lookahead });
  if (!check("load succeeded", load.ok, load.refusal ?? load.failure)) return finish(result, checks);
  p.play();
  const playing = await waitFor(() => snap(p).firstPlaying, { timeoutMs: 10_000 });
  check("'playing' fired", playing.ok);
  const series = [];
  const duration = params.observeSeconds ?? 16;
  for (let i = 0; i <= duration; i += 1) {
    const sn = snap(p);
    series.push({ wall: i, currentTime: round(sn.currentTime), bufferedEnd: sn.buffered.length ? round(sn.buffered[sn.buffered.length - 1][1]) : undefined, ahead: round(sn.ahead), appended: sn.segments.appended, ranges: sn.buffered.length });
    if (i < duration) await sleep(1000);
  }
  result.series = series;
  const end = series[series.length - 1];
  const maxSeg = Math.max(...p.preparer.plan.segments.map((x) => x.endSeconds - x.startSeconds));
  result.lookaheadSeconds = lookahead;
  result.maxSegmentSeconds = round(maxSeg);
  check("currentTime advanced during the run", end.currentTime >= duration * 0.8, end.currentTime);
  check("buffered range grew well ahead of playback (≥ 30 s ahead)", Math.max(...series.map((x) => x.ahead)) >= 30, Math.max(...series.map((x) => x.ahead)));
  check("buffer ahead increased over the run", end.ahead > series[1].ahead + 10, { early: series[1].ahead, end: end.ahead });
  check("lookahead cap respected (ahead ≤ cap + one segment + 1 s)", series.every((x) => x.ahead <= lookahead + maxSeg + 1), Math.max(...series.map((x) => x.ahead)));
  const sn = snap(p);
  check("no underrun stall after playback began", sn.stalls.filter((x) => x.cause === "underrun" && x.startAt > (sn.firstPlaying?.at ?? 0)).length === 0 && !sn.openStall, sn.stalls);
  check("gating (not errors) limited delivery", (sn.scheduler.stats.gated ?? 0) > 0 && !sn.failure, sn.scheduler.stats);
  result.evidence = p.evidence({ timeline: 120, appends: 20, samples: 0 });
  result.reset = await p.reset("scenario-end");
  return finish(result, checks);
}

// ------------------------------------------------------------------ MSE-07

async function underrun({ pipeline: p, files, video, params }) {
  requireFiles(files, 1, "mse-07");
  const result = baseResult("mse-07-underrun", "MSE-07 Buffer underrun and recovery (delivery slower than playback)", files);
  const { checks, check } = checker();
  const load = await p.load(files[0], { profile: params.profile ?? "SLOW", initialSegments: params.initialSegments ?? 1 });
  if (!check("load succeeded", load.ok, load.refusal ?? load.failure)) return finish(result, checks);
  p.play();
  const playing = await waitFor(() => snap(p).firstPlaying, { timeoutMs: 10_000 });
  check("'playing' fired", playing.ok);
  await sleep((params.observeSeconds ?? 40) * 1000);
  const sn = snap(p);
  // Start-up waits (play() before the first frame was ready) are not underruns.
  const stalls = sn.stalls.filter((x) => x.cause === "underrun" && !x.beforeFirstPlaying);
  result.allStalls = sn.stalls;
  result.stalls = stalls;
  result.profile = params.profile ?? "SLOW";
  result.openStall = sn.openStall;
  result.counts = counts(p, "media-waiting", "media-stalled", "media-playing", "media-canplay", "media-canplaythrough");
  result.series = sampleSeries(p, 500);
  result.finalCurrentTime = round(sn.currentTime);
  if (params.observeOnly) {
    result.observation = { underrunStalls: stalls.length, totalStallMs: round(stalls.reduce((n, x) => n + x.durationMs, 0), 1), finalCurrentTime: result.finalCurrentTime, failure: sn.failure };
    result.evidence = p.evidence({ timeline: 120, appends: 10, samples: 0 });
    result.reset = await p.reset("scenario-end");
    return finish(result, [], { observedOnly: true });
  }
  check("playback reached the buffered end and fired 'waiting'", result.counts["media-waiting"] >= 1 && (stalls.length >= 1 || sn.openStall), result.counts);
  const recovered = stalls.filter((x) => x.endedBy === "playing" && x.appendsDuring >= 1);
  check("playback resumed ('playing') after a segment arrived during the stall", recovered.length >= 1, recovered.map((x) => ({ at: x.currentTime, ms: x.durationMs, appendsDuring: x.appendsDuring, resumeAfterAppendMs: x.resumeAfterAppendMs })));
  check("currentTime kept advancing after recovery", recovered.length >= 1 && sn.currentTime > recovered[0].currentTime + 1.5, { final: sn.currentTime, firstStallAt: recovered[0]?.currentTime });
  const stalledSamples = result.series.filter((x) => x.w === 1);
  result.readyStateWhileWaiting = [...new Set(stalledSamples.map((x) => x.rs))];
  check("readyState dropped below HAVE_FUTURE_DATA while waiting", stalledSamples.length > 0 && stalledSamples.every((x) => x.rs <= 2), result.readyStateWhileWaiting);
  check("no pipeline failure or media error", !sn.failure && !sn.videoError, sn.failure ?? sn.videoError);
  result.stalledEventNote = "'stalled' is recorded as observed; the check relies on 'waiting' and 'playing'.";
  result.evidence = p.evidence({ timeline: 200, appends: 30, samples: 0 });
  result.reset = await p.reset("scenario-end");
  return finish(result, checks);
}

// ------------------------------------------------------------------ MSE-08

async function seekBuffered({ pipeline: p, files, video }) {
  requireFiles(files, 1, "mse-08");
  const result = baseResult("mse-08-seek-buffered", "MSE-08 Seek inside the buffered range", files);
  const { checks, check } = checker();
  const load = await p.load(files[0], { profile: "FAST", initialSegments: 2, lookaheadSeconds: 60 });
  if (!check("load succeeded", load.ok, load.refusal ?? load.failure)) return finish(result, checks);
  p.play();
  await waitFor(() => snap(p).firstPlaying, { timeoutMs: 10_000 });
  const ready = await waitFor(() => snap(p).ahead >= 30 && ct(video) >= 3, { timeoutMs: 30_000 });
  check("buffer ahead reached 30 s", ready.ok, snap(p).ahead);
  const seeks = [];
  for (const [label, target] of [["forward", ct(video) + 15], ["backward", Math.max(0.5, ct(video) - 2)]]) {
    const ranges = snapshotRanges(video.buffered);
    const inside = rangeIndexAt(ranges, target, 0) >= 0;
    const appendsBefore = snap(p).segments.appended;
    const readsBefore = snap(p).source.reads;
    const t0 = performance.now();
    p.seek(target);
    const seeked = await waitFor(() => !video.seeking && snap(p).seeks.at(-1)?.seekedAt !== undefined, { timeoutMs: 5000, pollMs: 10 });
    const seekedMs = round(performance.now() - t0, 1);
    const adv = await waitFor(() => ct(video) >= target + 1, { timeoutMs: 5000 });
    const rec = snap(p).seeks.at(-1);
    seeks.push({ label, target: round(target), insideBufferAtRequest: inside, rangesAtSeek: r3(ranges), case: rec?.case, retarget: rec?.retarget, seekLatencyMs: rec?.seekLatencyMs, wallSeekedMs: seekedMs, advanced: adv.ok, currentTimeAfter: round(ct(video)), readsDuringSeek: snap(p).source.reads - readsBefore, appendsBefore });
    check(`${label} seek target was inside the buffered range`, inside, r3(ranges));
    check(`${label} seek classified as buffered (no reprioritisation)`, rec?.case === "A-buffered" && rec.retarget === undefined, rec?.case);
    check(`${label} seek completed ('seeked')`, seeked.ok, rec?.seekLatencyMs);
    check(`${label} playback resumed and advanced ≥ 1 s from the target`, adv.ok, round(ct(video)));
  }
  result.seeks = seeks;
  const sn = snap(p);
  check("no pipeline failure or media error", !sn.failure && !sn.videoError, sn.failure ?? sn.videoError);
  result.evidence = p.evidence({ timeline: 150, appends: 10, samples: 0 });
  result.reset = await p.reset("scenario-end");
  return finish(result, checks);
}

// ------------------------------------------------------------------ MSE-09

async function seekUnbuffered({ pipeline: p, files, video, params }) {
  requireFiles(files, 1, "mse-09");
  const result = baseResult("mse-09-seek-unbuffered", "MSE-09 Seek outside the buffered range (mechanism)", files);
  const { checks, check } = checker();

  // B1: playhead-priority retarget, forward then backward into an unbuffered gap.
  // Back-buffer trimming is off so that the ranges left behind by each seek stay visible.
  const load = await p.load(files[0], { profile: params.profile ?? "NORMAL", initialSegments: 2, backBufferSeconds: null });
  if (!check("load succeeded", load.ok, load.refusal ?? load.failure)) return finish(result, checks);
  p.play();
  await waitFor(() => snap(p).firstPlaying, { timeoutMs: 10_000 });
  await waitFor(() => ct(video) >= 3, { timeoutMs: 10_000 });
  const duration = p.preparer.durationSeconds;
  const forward = params.forwardTarget ?? duration * 0.6;
  const b1 = [];
  // Backward lands in the gap between the start-up range and the forward target.
  for (const [label, t] of [["forward", forward], ["backward", params.backwardTarget ?? forward / 2]]) {
    const before = snap(p);
    const ranges = before.buffered;
    const inside = rangeIndexAt(ranges, t, 0.1) >= 0;
    const f0 = framesOf(before);
    const t0 = performance.now();
    p.seek(t);
    const seeked = await waitFor(() => snap(p).seeks.at(-1)?.seekedAt !== undefined, { timeoutMs: 15_000, pollMs: 10 });
    const adv = await waitFor(() => ct(video) >= t + 1.5 && !video.paused, { timeoutMs: 10_000 });
    const sn = snap(p);
    const rec = sn.seeks.at(-1);
    const k = rec?.planIndex;
    const seg = k !== undefined ? p.preparer.segmentTimes(k) : undefined;
    b1.push({
      label,
      target: round(t),
      insideBufferAtRequest: inside,
      rangesAtSeek: r3(ranges),
      case: rec?.case,
      planIndex: k,
      segment: seg && { start: round(seg.startSeconds), end: round(seg.endSeconds) },
      retarget: rec?.retarget,
      timeline: rec && { seekingAt: rec.at, deliveredAt: rec.deliveredAt, appendedAt: rec.appendedAt, seekedAt: rec.seekedAt, playingAt: rec.playingAt, advancedAt: rec.advancedAt, seekLatencyMs: rec.seekLatencyMs },
      seekCut: rec && { reads: rec.seekCutReads, bytesRead: rec.seekCutBytesRead, ms: rec.seekCutMs },
      seekedCurrentTime: rec?.seekedCurrentTime,
      wallMs: round(performance.now() - t0, 1),
      rangesAfter: r3(sn.buffered),
      framesAfterSeek: framesOf(sn) - f0,
      advanced: adv.ok,
    });
    check(`${label}: target was outside the buffered range`, !inside, { target: round(t), ranges: r3(ranges) });
    check(`${label}: classified unbuffered and reprioritised to the target's segment`, rec?.case === "B-unbuffered" && rec.retarget?.nextIndex === k, { case: rec?.case, retarget: rec?.retarget, k });
    check(`${label}: keyframe-aligned segment start ≤ target < segment end`, seg && seg.startSeconds <= t && t < seg.endSeconds, seg);
    check(`${label}: target segment was cut from one bounded window`, rec?.seekCutReads === 1, rec?.seekCutReads);
    check(`${label}: 'seeked' fired and currentTime equals the target`, seeked.ok && Math.abs((rec?.seekedCurrentTime ?? -1) - t) < 0.01, { seeked: seeked.ok, seekedCurrentTime: rec?.seekedCurrentTime });
    check(`${label}: playback resumed and advanced past the target`, adv.ok && framesOf(sn) - f0 > 10, { currentTime: round(ct(video)), frames: framesOf(sn) - f0 });
  }
  result.b1 = b1;
  const sn1 = snap(p);
  const log = p.recorder.appendLog.entries();
  result.b1Summary = { ranges: r3(sn1.buffered), initAppends: log.filter((e) => e.kind === "init").length, removes: sn1.totals.removes, abortEvents: sn1.counts["sb-abort"] ?? 0, appendedRuns: sn1.segments.appendedRuns };
  check("no SourceBuffer reset was needed: init appended once, no abort(), no remove() for the seeks", result.b1Summary.initAppends === 1 && result.b1Summary.abortEvents === 0 && result.b1Summary.removes === 0, result.b1Summary);
  check("multiple disjoint buffered ranges coexist after out-of-order appends", sn1.buffered.length >= 2, r3(sn1.buffered));
  check("no pipeline failure or media error (B1)", !sn1.failure && !sn1.videoError, sn1.failure ?? sn1.videoError);
  result.b1Evidence = p.evidence({ timeline: 200, appends: 40, samples: 0 });
  result.b1Reset = await p.reset("scenario-b1-end");

  // B0: naive sequential cursor (negative control) — the seek waits for sequential delivery.
  const l0 = await p.load(files[0], { profile: "NORMAL", initialSegments: 2, cursor: "sequential", backBufferSeconds: null });
  if (l0.ok) {
    p.play();
    await waitFor(() => snap(p).firstPlaying, { timeoutMs: 10_000 });
    await waitFor(() => ct(video) >= 3, { timeoutMs: 10_000 });
    const t = forward;
    p.seek(t);
    await sleep(params.naiveWaitMs ?? 8000);
    const sn = snap(p);
    result.b0 = { target: round(t), waitedMs: params.naiveWaitMs ?? 8000, seeking: video.seeking, seekedFired: sn.seeks.at(-1)?.seekedAt !== undefined, readyState: sn.readyState, ranges: r3(sn.buffered), appendedRuns: sn.segments.appendedRuns, deliveredFrontierSeconds: sn.frontiers.deliveredEndSeconds };
    check("B0 control: without reprioritisation the far seek did not complete within the wait", result.b0.seeking && !result.b0.seekedFired, result.b0);
    result.b0Reset = await p.reset("scenario-b0-end");
  }

  // B2: SourceBuffer.abort() on an in-flight append, then re-append the same segment.
  const l2 = await p.load(files[0], { profile: "MANUAL", initialSegments: 0, prepareAhead: 0 });
  if (l2.ok) {
    const k = Math.min(5, p.preparer.segmentCount - 1);
    result.b2 = await p.experimentAbortAppend(k);
    check("B2: abort() while updating fired 'abort' and left nothing buffered from the aborted append", result.b2.aborted && result.b2.abortEvents >= 1 && result.b2.rangesAfterAbort.length === 0, result.b2);
    check("B2: the same segment appended normally afterwards, without re-appending the init segment", result.b2.rangesAfterReappend.length === 1 && !result.b2.failure, result.b2.rangesAfterReappend);
    result.b2Reset = await p.reset("scenario-b2-end");
  }

  // B3: video fragments that do not start on a keyframe (separate SourceBuffers, so the
  // video track buffer is observed on its own). Each variant uses a fresh session.
  const vid = async (label, pick) => {
    const l3 = await p.load(files[0], { profile: "MANUAL", initialSegments: 0, bufferMode: "separate", prepareAhead: 0 });
    if (!l3.ok) return { label, load: l3 };
    const prep = p.preparer;
    const samples = prep.tracks.find((t) => t.kind === "video").samples;
    const syncs = [];
    for (let i = 0; i < samples.length && syncs.length < 400; i += 1) if (samples[i].is_sync) syncs.push(i);
    const [first, end] = pick(syncs);
    const editShift = prep.presentationInfo().find((x) => x.kind === "video").editShiftSeconds;
    const out = { label, editShift, ...(await p.experimentAppendFragment(prep.videoTrackId, first, end)) };
    out.expectedStartIfFramesBeforeKeyframeDropped = out.firstSyncPresentationSeconds === undefined ? undefined : round(out.firstSyncPresentationSeconds - editShift, 6);
    out.reset = (await p.reset(`scenario-b3-${label}`)).clean;
    return out;
  };
  // Pick a GOP of at least 20 frames so that the cut starts well inside it.
  const gop = (syncs) => {
    for (let i = 10; i + 2 < syncs.length; i += 1) if (syncs[i + 1] - syncs[i] >= 20) return i;
    return 1;
  };
  const noKeyframe = await vid("mid-gop-no-keyframe", (sy) => { const i = gop(sy); return [sy[i] + 10, sy[i + 1]]; });
  const laterKeyframe = await vid("mid-gop-then-keyframe", (sy) => { const i = gop(sy); return [sy[i] + 10, sy[i + 2]]; });
  const aligned = await vid("keyframe-aligned", (sy) => { const i = gop(sy); return [sy[i], sy[i + 2]]; });
  result.b3 = { noKeyframe, laterKeyframe, aligned };
  check("B3: a fragment with no keyframe was accepted without error but buffered nothing", noKeyframe.firstIsSync === false && noKeyframe.firstSyncSample === undefined && noKeyframe.rangesAfter.length === 0 && !noKeyframe.failure && noKeyframe.queueState === "idle", noKeyframe);
  check("B3: a fragment starting mid-GOP buffered only from its first keyframe (frames before it dropped)", laterKeyframe.firstIsSync === false && laterKeyframe.rangesAfter.length === 1 && Math.abs(laterKeyframe.rangesAfter[0][0] - laterKeyframe.expectedStartIfFramesBeforeKeyframeDropped) < 0.05, { rangesAfter: laterKeyframe.rangesAfter, decodeRange: laterKeyframe.decodeRange, expectedStart: laterKeyframe.expectedStartIfFramesBeforeKeyframeDropped });
  check("B3: the keyframe-aligned fragment buffered from its keyframe", aligned.firstIsSync === true && aligned.rangesAfter.length === 1 && Math.abs(aligned.rangesAfter[0][0] - aligned.expectedStartIfFramesBeforeKeyframeDropped) < 0.05, { rangesAfter: aligned.rangesAfter, expectedStart: aligned.expectedStartIfFramesBeforeKeyframeDropped });
  return finish(result, checks);
}

// ------------------------------------------------------------------ MSE-10

async function endOfStream({ pipeline: p, files, video, params }) {
  requireFiles(files, 1, "mse-10");
  const result = baseResult("mse-10-end-of-stream", "MSE-10 End of stream", files);
  const { checks, check } = checker();
  const mode = params.mode ?? "playthrough";
  const load = await p.load(files[0], mode === "playthrough" ? { profile: "NORMAL", initialSegments: 2 } : { profile: "FAST", initialSegments: 4, lookaheadSeconds: Infinity, backBufferSeconds: null });
  if (!check("load succeeded", load.ok, load.refusal ?? load.failure)) return finish(result, checks);
  const total = p.preparer.segmentCount;
  if (mode === "playthrough") {
    p.play();
    await waitFor(() => snap(p).firstPlaying, { timeoutMs: 10_000 });
  } else {
    await waitFor(() => snap(p).eos.length >= 1, { timeoutMs: 120_000, pollMs: 200 });
    const d = video.duration;
    result.seekNearEnd = round(d - 5);
    p.seek(d - 5);
    await waitFor(() => !video.seeking, { timeoutMs: 5000 });
    p.play();
  }
  const ended = await waitFor(() => video.ended && snap(p).milestones.endedAt !== undefined, { timeoutMs: (params.timeoutSeconds ?? 60) * 1000, pollMs: 100 });
  const sn = snap(p);
  const log = p.recorder.appendLog.entries().filter((e) => e.k !== undefined);
  const lastAppendEnd = Math.max(...log.map((e) => e.endedAt));
  result.eos = sn.eos;
  result.firstPlaying = sn.firstPlaying;
  result.final = { currentTime: round(sn.currentTime), elementDuration: sn.elementDuration, msDuration: sn.msDuration, msReadyState: sn.msReadyState, ended: sn.ended, readyState: sn.readyState, ranges: r3(sn.buffered), counts: counts(p, "ms-sourceended", "media-ended", "media-waiting", "media-pause") };
  check("all segments appended", sn.segments.appended === total, { appended: sn.segments.appended, total });
  check("endOfStream() called exactly once", sn.eos.length === 1, sn.eos.length);
  check("endOfStream() only after the last append's updateend", sn.eos[0]?.at >= lastAppendEnd && sn.eos[0]?.appendedSegments === total, { eosAt: sn.eos[0]?.at, lastAppendEnd });
  check("no append after endOfStream()", sn.eos.length >= 1 && !sn.eos[0].reopenedBy && log.every((e) => e.endedAt <= sn.eos[0].at), sn.eos[0]?.reopenedBy);
  check("'sourceended' fired once and MediaSource.readyState is 'ended'", result.final.counts["ms-sourceended"] === 1 && sn.msReadyState === "ended", result.final);
  check("'ended' fired and video.ended is true", ended.ok && result.final.counts["media-ended"] === 1, result.final.counts);
  check("currentTime reached the duration", Math.abs(sn.currentTime - sn.elementDuration) < 0.1, { currentTime: sn.currentTime, duration: sn.elementDuration });
  if (mode === "playthrough") check("playback began before the last segment was supplied", sn.firstPlaying && sn.firstPlaying.appendedSegments < total, sn.firstPlaying);
  check("no pipeline failure or media error", !sn.failure && !sn.videoError, sn.failure ?? sn.videoError);
  result.mode = mode;
  result.evidence = p.evidence({ timeline: 200, appends: 20, samples: 0 });
  result.reset = await p.reset("scenario-end");
  return finish(result, checks);
}

// ------------------------------------------------------------------ MSE-11

async function cleanup({ pipeline: p, files, video }) {
  requireFiles(files, 3, "mse-11 (target, second target, truncated)");
  const result = baseResult("mse-11-cleanup", "MSE-11 Cleanup / reset / replace / failure paths", files);
  const { checks, check } = checker();
  const [a, b, truncated] = files;
  const phases = {};
  const expectClean = (label, report) => {
    check(`${label}: teardown report clean`, report?.clean === true, report && { resources: report.resources, queues: report.queues, msReadyState: report.msReadyState, sourceBuffers: report.sourceBuffers, video: report.video, sourceClose: report.sourceClose, preparedEntriesLive: report.preparedEntriesLive });
  };

  // 1. Reset mid-stream.
  await p.load(a, { profile: "NORMAL", initialSegments: 2 });
  p.play();
  await waitFor(() => ct(video) >= 2, { timeoutMs: 10_000 });
  const live = snap(p);
  phases.midStream = { liveBefore: live.resources, schedulerTimers: live.scheduler.timersActive, pendingBytes: live.totals.pendingBytes, preparedBytes: live.totals.preparedBytes, currentTime: round(live.currentTime) };
  phases.midStream.report = await p.reset("mid-stream");
  expectClean("reset mid-stream", phases.midStream.report);
  check("reset mid-stream: sourceclose observed, MediaSource closed, 0 SourceBuffers", phases.midStream.report.sourceClose === "event" && phases.midStream.report.msReadyState === "closed" && phases.midStream.report.sourceBuffers === 0, phases.midStream.report);

  // 2. Another test can start.
  const again = await p.load(a, { profile: "NORMAL", initialSegments: 2 });
  p.play();
  const replay = await waitFor(() => ct(video) >= 1.5, { timeoutMs: 10_000 });
  check("a new session starts and plays after reset", again.ok && replay.ok, round(ct(video)));

  // 3. Replace media while playing.
  const replaced = await p.load(b, { profile: "NORMAL", initialSegments: 2 });
  phases.replace = { report: p.lastReport, newLoad: replaced.ok };
  expectClean("replace media (previous session)", phases.replace.report);
  check("replace media: previous session torn down with reason 'replaced'", phases.replace.report?.reason === "replaced", phases.replace.report?.reason);
  p.play();
  const replacedPlays = await waitFor(() => ct(video) >= 1.5, { timeoutMs: 10_000 });
  check("replace media: the replacement plays", replaced.ok && replacedPlays.ok, round(ct(video)));

  // 4. MSE / playback failure: an invalid media segment.
  let fault;
  for (const kind of ["child-overrun", "garbage"]) {
    if (kind === "garbage") {
      await p.load(b, { profile: "NORMAL", initialSegments: 2 });
      p.play();
      await waitFor(() => ct(video) >= 1, { timeoutMs: 10_000 });
    }
    p.hold();
    await Promise.all(snap(p).sourceBuffers.map(() => sleep(50)));
    p.injectCorruptAppend(kind);
    const failed = await waitFor(() => snap(p).failure, { timeoutMs: 4000 });
    const sn = snap(p);
    fault = { kind, failed: failed.ok, failure: sn.failure, msReadyState: sn.msReadyState, videoError: sn.videoError, counts: counts(p, "sb-error", "media-error", "ms-sourceended"), queues: sn.sourceBuffers.map((x) => ({ key: x.key, state: x.queue.state, pendingOps: x.queue.pendingOps })) };
    phases[`fault-${kind}`] = fault;
    if (failed.ok) break;
    phases[`fault-${kind}`].reset = await p.reset(`fault-${kind}-not-detected`);
  }
  check("invalid media segment: SourceBuffer error detected, pipeline failed closed", fault?.failed && fault.failure?.stage === "append" && fault.counts["sb-error"] >= 1, fault);
  check("invalid media segment: queues failed/stopped, nothing further issued", fault?.queues.every((q) => q.pendingOps === 0), fault?.queues);
  phases.faultReset = await p.reset("after-mse-failure");
  expectClean("reset after MSE failure", phases.faultReset);

  // 5. Parser/preparation failure: a truncated file fails when a missing window is needed.
  const tl = await p.load(truncated, { profile: "FAST", initialSegments: 1 });
  phases.truncated = { load: tl.ok ? "ok" : tl.refusal ?? tl.failure };
  if (tl.ok) {
    p.play();
    const failed = await waitFor(() => snap(p).failure, { timeoutMs: 20_000 });
    const sn = snap(p);
    phases.truncated = { ...phases.truncated, failed: failed.ok, failure: sn.failure, appendedBeforeFailure: sn.segments.appended, total: sn.plan.segments, scheduler: sn.scheduler.state, preparedBytes: sn.totals.preparedBytes, pendingBytes: sn.totals.pendingBytes, playedTo: round(sn.currentTime), ranges: r3(sn.buffered) };
    check("truncated source: preparation failure detected (SOURCE_TRUNCATED) after partial progressive playback", failed.ok && sn.failure?.code === "SOURCE_TRUNCATED" && sn.segments.appended >= 1, phases.truncated);
    check("truncated source: delivery stopped and no prepared/queued bytes retained", sn.scheduler.state === "stopped" && sn.totals.preparedBytes === 0 && sn.totals.pendingBytes === 0, phases.truncated);
  } else {
    check("truncated source: refused cleanly at open", Boolean(tl.refusal), tl.refusal);
  }
  phases.truncatedReset = await p.reset("after-parser-failure");
  expectClean("reset after parser failure", phases.truncatedReset);

  result.phases = phases;
  result.note = "Page unload (pagehide) teardown is exercised by the browser driver, which navigates away and captures the page's pagehide console record.";
  return finish(result, checks);
}

// ------------------------------------------------------------------ MSE-12

async function unsupported({ pipeline: p, files }) {
  requireFiles(files, 1, "mse-12");
  const result = baseResult("mse-12-unsupported", "MSE-12 Unsupported / non-target media", files);
  const { checks, check } = checker();
  const rows = [];
  for (const f of files) {
    const r = await p.load(f, { profile: "MANUAL", initialSegments: 0 });
    const sn = p.snapshot();
    const codecs = r.refusal?.details?.trackCodecs;
    const diag = codecs?.map((t) => {
      const mime = t.type === "audio" ? `audio/mp4; codecs="${t.codec}"` : `video/mp4; codecs="${t.codec}"`;
      return { ...t, mime, isTypeSupported: MediaSource.isTypeSupported(mime) };
    });
    rows.push({ file: fileInfo(f), ok: r.ok, refusal: r.refusal && { code: r.refusal.code, stage: r.refusal.stage, message: r.refusal.message }, reasons: r.refusal?.details?.reasons, codecs: diag, mediaSourceCreated: sn.resources?.totals.urlsCreated > 0, state: sn.state });
    await p.reset("unsupported-next");
  }
  result.rows = rows;
  check("every selected file was refused", rows.every((r) => !r.ok && r.refusal), rows.map((r) => [r.file.name, r.refusal?.code]));
  check("no MediaSource or object URL was created for refused media", rows.every((r) => !r.mediaSourceCreated), rows.map((r) => [r.file.name, r.mediaSourceCreated]));
  check("each refusal names a stage and an explicit code", rows.every((r) => r.refusal?.stage && r.refusal?.code), rows.map((r) => [r.refusal?.stage, r.refusal?.code]));
  result.note = "Refusal is by Driftless target policy before MSE. isTypeSupported() for the refused codecs is diagnostic only; a 'true' does not make the file a Progressive Watch target.";
  return finish(result, checks);
}

// ------------------------------------------------------------------ supplementary

async function separateBuffers({ pipeline: p, files, video }) {
  requireFiles(files, 1, "s1");
  const result = baseResult("s1-buffer-layout", "Supplementary: muxed vs separate SourceBuffers and presentation start (edit lists)", files);
  const { checks, check } = checker();
  const runs = {};
  for (const mode of ["muxed", "separate"]) {
    const load = await p.load(files[0], { bufferMode: mode, profile: "FAST", initialSegments: 3, lookaheadSeconds: 30 });
    if (!check(`${mode}: load succeeded`, load.ok, load.refusal ?? load.failure)) continue;
    await waitFor(() => snap(p).segments.appended >= 3, { timeoutMs: 5000 });
    const pre = snap(p);
    // Fragments appended at the moment the ranges are snapshotted (compared below).
    const partsAtSnapshot = p.recorder.appendLog.entries().filter((e) => e.k !== undefined).map((e) => ({ k: e.k, kind: e.kind, presentation: e.presentation, media: e.media }));
    p.play();
    const pl = await waitFor(() => ct(video) >= 4, { timeoutMs: 15_000 });
    const sn = snap(p);
    runs[mode] = {
      mimes: sn.sourceBuffers.map((b) => [b.key, b.mime, b.mode]),
      initBytes: sn.initResult.initBytes,
      sourceBufferRangesBeforePlay: pre.sourceBuffers.map((b) => [b.key, r3(b.ranges)]),
      elementRangesBeforePlay: r3(pre.buffered),
      played: pl.ok,
      currentTime: round(sn.currentTime),
      frames: sn.frames,
      firstFrameMediaTime: sn.milestones.firstFrameMediaTime,
      appendedParts: partsAtSnapshot,
    };
    check(`${mode}: playback advanced ≥ 4 s`, pl.ok, round(ct(video)));
    runs[mode].reset = await p.reset("s1-next");
  }
  const prep = await openMedia(p.MP4Box, files[0], {});
  result.presentation = prep.presentationInfo();
  prep.close();
  result.runs = runs;
  const sep = runs.separate;
  if (sep?.sourceBufferRangesBeforePlay) {
    const pres = Object.fromEntries(result.presentation.map((x) => [x.kind, x]));
    const classify = (observed, without, withEdit) => (Math.abs(observed - withEdit) < 0.002 ? "edit list applied" : Math.abs(observed - without) < 0.002 ? "edit list NOT applied" : "neither");
    // Presentation start and end of the appended fragments, from the sample tables.
    result.editListComparison = ["video", "audio"].map((kind) => {
      const ranges = sep.sourceBufferRangesBeforePlay.find(([k]) => k === kind)?.[1] ?? [];
      const parts = sep.appendedParts.filter((x) => x.kind === kind);
      const shift = pres[kind].editShiftSeconds;
      const startWithout = Math.min(...parts.map((x) => x.presentation[0]));
      const endWithout = Math.max(...parts.map((x) => x.presentation[1]));
      return {
        kind,
        editShiftSeconds: shift,
        observedRange: ranges[0],
        start: { observed: ranges[0]?.[0], sampleTable: round(startWithout, 6), withEdit: round(startWithout - shift, 6), note: "a negative start is trimmed to 0 by the default appendWindowStart, so the start alone cannot discriminate" },
        end: { observed: ranges[0]?.[1], sampleTable: round(endWithout, 6), withEdit: round(endWithout - shift, 6), verdict: classify(ranges[0]?.[1], endWithout, endWithout - shift) },
      };
    });
    check("separate SourceBuffers: each track's buffered end matches its sample-table end minus the edit-list shift", result.editListComparison.every((c) => c.end.verdict === "edit list applied"), result.editListComparison.map((c) => [c.kind, c.end]));
  }
  return finish(result, checks);
}

async function continuity({ pipeline: p, files, video }) {
  requireFiles(files, 1, "s2");
  const result = baseResult("s2-continuity", "Supplementary: timestamp continuity over a complete sequential append", files);
  const { checks, check } = checker();
  const load = await p.load(files[0], { profile: "FAST", initialSegments: 4, lookaheadSeconds: Infinity, backBufferSeconds: null });
  if (!check("load succeeded", load.ok, load.refusal ?? load.failure)) return finish(result, checks);
  const total = p.preparer.segmentCount;
  const done = await waitFor(() => snap(p).eos.length >= 1, { timeoutMs: 180_000, pollMs: 200 });
  const sn = snap(p);
  const log = p.recorder.appendLog.entries().filter((e) => e.k !== undefined);
  // A muxed SourceBuffer reports the intersection of its track buffers, so it is empty
  // until both fragments of the first segment are in. Contiguity is checked from then on.
  const firstNonEmpty = log.findIndex((e) => e.sbRanges.length > 0);
  result.emptyUntilFirstCompleteSegment = log.slice(0, Math.max(0, firstNonEmpty)).map((e) => ({ k: e.k, kind: e.kind, sbRanges: e.sbRanges }));
  const multiRange = log.slice(Math.max(0, firstNonEmpty)).filter((e) => e.sbRanges.length !== 1);
  const shrink = log.filter((e) => e.lost || e.endMovedBack);
  let monotonic = true;
  for (let i = 1; i < log.length; i += 1) if (log[i].sbRanges.at(-1)?.[1] < log[i - 1].sbRanges.at(-1)?.[1]) monotonic = false;
  const pres = p.preparer.presentationInfo();
  result.summary = { total, appended: sn.segments.appended, eos: done.ok, mediaAppends: log.length, multiRangeAfterAppend: multiRange.length, shrinkAfterAppend: shrink.length, finalRanges: r3(sn.buffered), finalSourceBufferRanges: sn.sourceBuffers.map((b) => [b.key, r3(b.ranges)]), msDuration: sn.msDuration, planDuration: round(p.preparer.durationSeconds), appendedBytes: sn.totals.appendedBytes, anomalies: sn.anomalies.length, paused: sn.paused };
  result.presentation = pres;
  result.firstMultiRange = multiRange.slice(0, 5);
  check("all segments appended in order and endOfStream() reached", done.ok && sn.segments.appended === total, result.summary);
  check("one contiguous buffered range after every append (no unexplained gaps)", multiRange.length === 0, multiRange.slice(0, 5).map((e) => [e.k, e.sbRanges]));
  check("buffered end never moved backwards and no buffered data was lost", monotonic && shrink.length === 0, shrink.slice(0, 5));
  const [s, e] = sn.buffered[0] ?? [];
  const firstPres = Math.max(...pres.map((x) => x.firstPresentationSeconds));
  check("final buffered range spans the whole media (start ≤ first presentation + 0.01, end ≥ plan duration − 0.1)", s <= firstPres + 0.01 && e >= p.preparer.durationSeconds - 0.1, { start: s, end: e, firstPres, planDuration: p.preparer.durationSeconds });
  check("no SourceBuffer error during the full append", !sn.failure && !sn.videoError, sn.failure);
  result.appendLog = trimForEvidence(log, 10, 5);
  result.reset = await p.reset("scenario-end");
  return finish(result, checks);
}

async function quota({ pipeline: p, files, video, params }) {
  requireFiles(files, 1, "s3");
  const result = baseResult("s3-quota", "Supplementary: SourceBuffer quota behavior while paused (no caps)", files);
  const load = await p.load(files[0], { profile: "FAST", initialSegments: 4, lookaheadSeconds: Infinity, backBufferSeconds: null });
  if (!load.ok) return finish({ ...result, load }, [], { observedOnly: true });
  const maxWall = (params.maxSeconds ?? 120) * 1000;
  const hit = await waitFor(() => (snap(p).counts["quota-exceeded"] ?? 0) > 0 || snap(p).failure || snap(p).segments.appended >= (params.maxSegments ?? 900), { timeoutMs: maxWall, pollMs: 200 });
  const sn = snap(p);
  const quotaEvents = p.recorder.timeline.entries().filter((e) => e.type === "quota-exceeded");
  result.atQuota = { reached: (sn.counts["quota-exceeded"] ?? 0) > 0, waitedMs: hit.ms, appendedSegments: sn.segments.appended, appendedBytes: sn.totals.appendedBytes, ranges: r3(sn.buffered), sourceBufferRanges: sn.sourceBuffers.map((b) => [b.key, r3(b.ranges)]), firstQuotaEvent: quotaEvents[0], queues: sn.sourceBuffers.map((b) => ({ key: b.key, state: b.queue.state, stats: b.queue.stats })), failure: sn.failure };
  if (result.atQuota.reached) {
    // Play: once the playhead moves, media behind it can be evicted and appends resume.
    const appendedAt = sn.segments.appended;
    p.play();
    const resumed = await waitFor(() => snap(p).segments.appended > appendedAt + 2, { timeoutMs: (params.recoverSeconds ?? 30) * 1000, pollMs: 200 });
    const after = snap(p);
    result.afterPlay = { resumedAppends: resumed.ok, waitedMs: resumed.ms, currentTime: round(after.currentTime), appendedSegments: after.segments.appended, removes: after.totals.removes, ranges: r3(after.buffered), quotaEvents: after.counts["quota-exceeded"], failure: after.failure, stalls: after.stalls.length };
  }
  result.evidence = p.evidence({ timeline: 150, appends: 10, samples: 0 });
  result.reset = await p.reset("scenario-end");
  return finish(result, [], { observedOnly: true });
}

async function longRun({ pipeline: p, files, video, params }) {
  requireFiles(files, 1, "s4");
  const result = baseResult("s4-long-run", "Supplementary: long progressive run with trimming and a far seek (memory discipline)", files);
  const { checks, check } = checker();
  const rate = params.playbackRate ?? 4;
  const load = await p.load(files[0], { profile: "FAST", initialSegments: 2, lookaheadSeconds: 60, backBufferSeconds: 30 });
  if (!check("load succeeded", load.ok, load.refusal ?? load.failure)) return finish(result, checks);
  video.playbackRate = rate;
  p.play();
  await waitFor(() => snap(p).firstPlaying, { timeoutMs: 10_000 });
  const series = [];
  const sampleFor = async (seconds) => {
    for (let i = 0; i < seconds; i += 1) {
      await sleep(1000);
      const sn = snap(p);
      series.push({ currentTime: round(sn.currentTime), ranges: r3(sn.buffered), bufferedSeconds: round(sn.buffered.reduce((n, [a, b]) => n + b - a, 0)), appended: sn.segments.appended, removes: sn.totals.removes, pending: sn.totals.pendingBytes, prepared: sn.totals.preparedBytes, heap: performance.memory?.usedJSHeapSize });
    }
  };
  await sampleFor(params.firstSeconds ?? 45);
  const seekTo = params.seekTo ?? p.preparer.durationSeconds / 2;
  p.seek(seekTo);
  await waitFor(() => ct(video) > seekTo + 1, { timeoutMs: 15_000 });
  await sampleFor(params.secondSeconds ?? 30);
  const sn = snap(p);
  result.playbackRate = rate;
  result.series = series;
  result.seek = sn.seeks.at(-1);
  result.totals = sn.totals;
  result.source = sn.source;
  result.maxBufferedSeconds = Math.max(...series.map((x) => x.bufferedSeconds));
  const maxSegBytes = Math.max(...p.recorder.appendLog.entries().filter((e) => e.k !== undefined).map((e) => e.bytes));
  result.maxSegmentPartBytes = maxSegBytes;
  check("playback advanced through the run", sn.currentTime > seekTo + 20, round(sn.currentTime));
  check("back-buffer trimming ran (remove() issued)", sn.totals.removes > 0, sn.totals.removes);
  check("buffered media stayed bounded (≤ lookahead + back buffer + 20 s)", result.maxBufferedSeconds <= 60 + 30 + 20, result.maxBufferedSeconds);
  check("prepared bytes bounded by prepareAhead (2) × largest segment", sn.totals.maxPreparedBytes <= 2 * 2 * maxSegBytes + 1, { maxPreparedBytes: sn.totals.maxPreparedBytes, maxSegBytes });
  check("far seek on the large file completed and played", result.seek?.case === "B-unbuffered" && result.seek?.seekedAt !== undefined, result.seek);
  check("no pipeline failure or media error", !sn.failure && !sn.videoError, sn.failure ?? sn.videoError);
  result.note = "JS heap is sampled by the external driver (CDP Runtime.getHeapUsage); performance.memory here is coarse.";
  result.reset = await p.reset("scenario-end");
  video.playbackRate = 1;
  return finish(result, checks);
}

/**
 * Control (not MSE): play the same file through a plain File object URL for a few
 * seconds and report getVideoPlaybackQuality(), so frame counters under MSE can be
 * compared with native file playback in the same browser environment. The media
 * element reads the file itself; the page reads no media bytes.
 */
async function nativeControl({ pipeline: p, files, video, params }) {
  requireFiles(files, 1, "control-native");
  const result = baseResult("control-native-playback", "Control: native File object-URL playback (no MSE) frame counters", files);
  await p.reset("control");
  const url = URL.createObjectURL(files[0]);
  let presented = 0;
  let handle;
  const cb = (_n, meta) => {
    presented = meta.presentedFrames;
    handle = video.requestVideoFrameCallback(cb);
  };
  try {
    video.src = url;
    handle = video.requestVideoFrameCallback(cb);
    const play = await video.play().then(() => ({ ok: true }), (e) => ({ ok: false, name: e.name }));
    await sleep((params.seconds ?? 8) * 1000);
    const q = video.getVideoPlaybackQuality();
    result.native = { play, currentTime: round(video.currentTime), presentedFrames: presented, totalVideoFrames: q.totalVideoFrames, droppedVideoFrames: q.droppedVideoFrames, visibilityState: document.visibilityState };
  } finally {
    video.cancelVideoFrameCallback(handle);
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
  return finish(result, [], { observedOnly: true });
}

/** Leave a session playing so the driver can navigate away and observe pagehide cleanup. */
async function unloadProbe({ pipeline: p, files, video }) {
  requireFiles(files, 1, "unload-probe");
  const result = baseResult("unload-probe", "Page-unload probe: leave a session playing", files);
  await p.load(files[0], { profile: "NORMAL", initialSegments: 2 });
  p.play();
  const ok = await waitFor(() => ct(video) >= 2, { timeoutMs: 10_000 });
  const sn = snap(p);
  result.live = { currentTime: round(sn.currentTime), resources: sn.resources, schedulerTimers: sn.scheduler?.timersActive, state: sn.state, failure: sn.failure };
  return finish(result, [{ name: "session is live and playing", ok: ok.ok, observed: result.live }]);
}

export const SCENARIOS = [
  { id: "mse-01-capability", run: capability, files: "1 target file (codec strings are derived from it)" },
  { id: "mse-02-04-setup-append", run: setupAndAppend, files: "1 target file" },
  { id: "mse-05-early-playback", run: earlyPlayback, files: "1 target file" },
  { id: "mse-06-ahead-buffering", run: aheadBuffering, files: "1 target file ≥ 90 s" },
  { id: "mse-07-underrun", run: underrun, files: "1 target file ≥ 60 s" },
  { id: "mse-08-seek-buffered", run: seekBuffered, files: "1 target file ≥ 60 s" },
  { id: "mse-09-seek-unbuffered", run: seekUnbuffered, files: "1 target file ≥ 60 s" },
  { id: "mse-10-end-of-stream", run: endOfStream, files: "1 short target file (or params {\"mode\":\"seek-near-end\"})" },
  { id: "mse-11-cleanup", run: cleanup, files: "3 files: target, second target, truncated target" },
  { id: "mse-12-unsupported", run: unsupported, files: "any number of non-target / malformed files" },
  { id: "s1-buffer-layout", run: separateBuffers, files: "1 target file" },
  { id: "s2-continuity", run: continuity, files: "1 target file" },
  { id: "s3-quota", run: quota, files: "1 large target file" },
  { id: "s4-long-run", run: longRun, files: "1 long target file" },
  { id: "unload-probe", run: unloadProbe, files: "1 target file" },
  { id: "control-native-playback", run: nativeControl, files: "1 target file (control, not MSE)" },
];

export async function runScenario(id, ctx) {
  const sc = SCENARIOS.find((x) => x.id === id);
  if (!sc) throw new Error(`Unknown experiment '${id}'`);
  const t0 = performance.now();
  try {
    const result = await sc.run({ ...ctx, params: ctx.params ?? {} });
    result.wallMs = round(performance.now() - t0, 1);
    return result;
  } catch (e) {
    const report = await ctx.pipeline.reset("scenario-error").catch(() => undefined);
    return { id, status: "ERROR", error: `${e?.name}: ${e?.message}`, stack: String(e?.stack ?? "").split("\n").slice(0, 6), reset: report, wallMs: round(performance.now() - t0, 1) };
  }
}
