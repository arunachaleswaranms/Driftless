// Spike 0.6 page controller: file selection, manual controls, rendering, and the
// scripted-experiment runner. Pipeline logic lives in pipeline.mjs. Every untrusted
// value (file names, codec strings, browser messages) is rendered with textContent.

import { displayName, fmtBytes, fmtClock, round } from "./diagnostics.mjs";
import { ProgressivePipeline } from "./pipeline.mjs";
import { fmtRanges } from "./ranges.mjs";
import { SCENARIOS, runScenario } from "./scenarios.mjs";

const $ = (id) => document.getElementById(id);
const video = $("video");
const controls = ["load", "play", "pause", "hold", "resume", "release", "seek", "reset", "run-scenario"].map($);

let MP4Box;
try {
  MP4Box = await import("../../spike-05-mp4-segmentation/node_modules/mp4box/dist/mp4box.all.mjs");
} catch {
  $("status").textContent = "MP4Box.js is not installed. Run `npm ci --ignore-scripts` in spikes/phase0/spike-05-mp4-segmentation/ and reload.";
  for (const b of controls) b.disabled = true;
}

let renderQueued = false;
let lastSlowRender = 0;
const pipeline = new ProgressivePipeline({ video, MP4Box, onUpdate: () => queueRender() });
let scenarioRunning = false;
let lastResult;

function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    render();
  }, 100);
}

function numberOr(value, fallback) {
  const raw = String(value).trim();
  if (raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function formOptions() {
  return {
    bufferMode: $("buffer-mode").value,
    profile: $("profile").value,
    initialSegments: Math.min(50, Math.floor(numberOr($("initial").value, 2))),
    targetSeconds: Number($("target").value),
    lookaheadSeconds: numberOr($("lookahead").value, Infinity),
    backBufferSeconds: String($("back-buffer").value).trim() === "" ? null : numberOr($("back-buffer").value, 30),
    cursor: $("cursor").value,
    seekAbort: $("seek-abort").checked,
  };
}

function setStatus(text) {
  $("status").textContent = text;
}

// ---------------------------------------------------------------- rendering

function renderBar(sn) {
  const d = Number.isFinite(sn.elementDuration) && sn.elementDuration > 0 ? sn.elementDuration : sn.plan?.durationSeconds;
  const bar = $("bar-buffered");
  bar.replaceChildren();
  const pct = (t) => `${Math.max(0, Math.min(100, (t / d) * 100))}%`;
  if (!d) return;
  for (const [s, e] of sn.buffered ?? []) {
    const span = document.createElement("span");
    span.style.left = pct(s);
    span.style.width = pct(e - s);
    bar.append(span);
  }
  $("bar-playhead").style.left = pct(sn.currentTime ?? 0);
  $("bar-delivered").style.left = pct(sn.frontiers?.deliveredEndSeconds ?? 0);
  $("bar-prepared").style.left = pct(sn.frontiers?.preparedEndSeconds ?? 0);
}

function renderBufferText(sn) {
  const state = sn.ended ? "ended" : sn.seeking ? "seeking" : sn.waiting ? "WAITING for data" : sn.paused ? "paused" : "playing";
  const ranges = sn.buffered ?? [];
  const containing = ranges.find(([s, e]) => sn.currentTime >= s - 0.1 && sn.currentTime < e);
  const seg = sn.segments;
  const lines = [
    `Playback:  ${fmtClock(sn.currentTime)}   (${state}; readyState ${sn.readyState})`,
    `Buffered:  ${containing ? `${fmtClock(containing[0])} ──── ${fmtClock(containing[1])}   (+${round(sn.ahead, 1)} s ahead)` : "playhead not buffered"}; ${ranges.length} range(s): ${fmtRanges(ranges, 2)}`,
    `Appended:  ${seg ? `${seg.appended} of ${seg.total} segments; contiguous to ${fmtClock(sn.frontiers?.appendedEndSeconds)}` : "—"}`,
    `Delivered: ${seg ? `to ${fmtClock(sn.frontiers?.deliveredEndSeconds)}; in flight ${seg.inFlight.length ? seg.inFlight.join(", ") : "none"}` : "—"}`,
    `Prepared:  ${sn.frontiers?.preparedEndSeconds !== undefined ? `to ${fmtClock(sn.frontiers.preparedEndSeconds)} (${fmtBytes(sn.totals.preparedBytes)} ready, not yet delivered)` : "none ready"}`,
  ];
  $("buffer-text").textContent = lines.join("\n");
}

function renderDiagnostics(sn) {
  $("d-state").textContent = sn.state;
  $("d-file").textContent = sn.file ? `${sn.file.name} (${fmtBytes(sn.file.size)})` : "—";
  $("d-mime").textContent = sn.capability ? sn.capability.map((c) => `${c.mime} → ${c.isTypeSupported}`).join("; ") : "—";
  $("d-ms").textContent = sn.msReadyState ?? "—";
  $("d-sb").textContent = sn.sourceBuffers?.length ? sn.sourceBuffers.map((b) => `${b.key}: ${b.mode}, updating ${b.updating}, queue ${b.queue.state} (${b.queue.pendingOps} queued, ${b.queue.stats.appendsCompleted} appends)`).join("; ") : "—";
  $("d-rs").textContent = sn.readyState !== undefined ? `${sn.readyState} / ${sn.networkState}` : "—";
  $("d-time").textContent = sn.currentTime !== undefined ? `${fmtClock(sn.currentTime)} / ${fmtClock(sn.elementDuration)} / ${sn.paused}` : "—";
  $("d-ranges").textContent = sn.buffered ? fmtRanges(sn.buffered) : "—";
  $("d-segs").textContent = sn.segments ? `${sn.segments.appended} / ${sn.segments.inFlight.length} / ${sn.segments.total}` : "—";
  $("d-frames").textContent = sn.frames ? `${sn.frames.presented} / ${sn.frames.totalVideoFrames ?? "—"} / ${sn.frames.droppedVideoFrames ?? "—"}` : "—";
  $("d-bytes").textContent = sn.totals ? `${fmtBytes(sn.totals.pendingBytes)} (max ${fmtBytes(sn.totals.maxPendingBytes)}) / ${fmtBytes(sn.totals.preparedBytes)} (max ${fmtBytes(sn.totals.maxPreparedBytes)})` : "—";
  $("d-source").textContent = sn.source ? `${fmtBytes(sn.source.bytesRead)} in ${sn.source.reads} reads / ${fmtBytes(sn.source.sourceSize)}` : "—";
  $("d-sched").textContent = sn.scheduler ? `${sn.scheduler.state}, ${sn.scheduler.profile}, released ${sn.scheduler.stats.released}, gated ${sn.scheduler.stats.gated}` : "—";
  $("d-stalls").textContent = sn.stalls ? `${sn.stalls.length} stall(s)${sn.openStall ? " + 1 open" : ""}; ${sn.seeks.length} seek(s)` : "—";
  $("d-res").textContent = sn.resources ? `URLs ${sn.resources.liveObjectUrls}, timeouts ${sn.resources.liveTimeouts}, intervals ${sn.resources.liveIntervals}, frame callbacks ${sn.resources.liveFrameCallbacks}, listener groups ${sn.resources.liveListenerGroups}` : sn.lastReport ? `last teardown clean: ${sn.lastReport.clean}` : "—";
  const err = sn.refusal ? `REFUSED ${sn.refusal.code}: ${sn.refusal.message}` : sn.failure ? `FAILED (${sn.failure.stage}) ${sn.failure.code}: ${sn.failure.message}` : "none";
  $("d-err").textContent = err;
}

function renderLogs() {
  const rec = pipeline.recorder;
  const body = $("append-body");
  const list = $("event-log");
  if (!rec) {
    body.replaceChildren();
    list.replaceChildren();
    return;
  }
  body.replaceChildren();
  for (const e of rec.appendLog.last(40).reverse()) {
    const tr = document.createElement("tr");
    const cells = [e.k ?? "—", e.kind ?? "—", e.sb, e.media ? `${round(e.media[0], 2)}–${round(e.media[1], 2)}` : "—", e.bytes, e.startedAt, e.endedAt, e.sbRanges.map(([a, b]) => `${a}–${b}`).join(", ") || "none", e.currentTime];
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = String(c);
      tr.append(td);
    }
    body.append(tr);
  }
  list.replaceChildren();
  for (const e of rec.timeline.last(150).reverse()) {
    const li = document.createElement("li");
    const { t, type, ...rest } = e;
    li.textContent = `${t} ms — ${type} ${JSON.stringify(rest).slice(0, 300)}`;
    list.append(li);
  }
}

function render() {
  const sn = pipeline.snapshot();
  renderBar(sn);
  renderBufferText(sn);
  renderDiagnostics(sn);
  const now = performance.now();
  if (now - lastSlowRender > 1000) {
    lastSlowRender = now;
    renderLogs();
  }
}

// ---------------------------------------------------------------- wiring

$("d-ua").textContent = navigator.userAgent;
for (const sc of SCENARIOS) {
  const opt = document.createElement("option");
  opt.value = sc.id;
  opt.textContent = `${sc.id} — ${sc.files}`;
  $("scenario").append(opt);
}

$("file").addEventListener("change", () => {
  const files = [...($("file").files ?? [])];
  setStatus(files.length ? `${files.length} file(s) selected: ${files.map((f) => `${displayName(f.name)} (${fmtBytes(f.size)})`).join(", ")}. Nothing has been read yet.` : "Select a file.");
});

$("load").addEventListener("click", async () => {
  const file = $("file").files?.[0];
  if (!file) return setStatus("Select a file first.");
  setStatus("Loading…");
  const r = await pipeline.load(file, formOptions());
  setStatus(r.ok ? `Loaded: ${r.segments} planned segments. Press Play.` : `Not loaded — ${(r.refusal ?? r.failure)?.code}: ${(r.refusal ?? r.failure)?.message}`);
  render();
});
$("play").addEventListener("click", async () => {
  const r = await pipeline.play();
  if (!r.ok) setStatus(`play() did not start: ${r.name ?? r.reason} ${r.message ?? ""}`);
});
$("pause").addEventListener("click", () => pipeline.pause());
$("hold").addEventListener("click", () => pipeline.hold());
$("resume").addEventListener("click", () => pipeline.resume());
$("release").addEventListener("click", () => pipeline.release(1));
$("seek").addEventListener("click", () => {
  const t = numberOr($("seek-to").value, NaN);
  if (Number.isFinite(t)) pipeline.seek(t);
});
$("profile").addEventListener("change", () => pipeline.setProfile($("profile").value));
$("reset").addEventListener("click", async () => {
  const report = await pipeline.reset("user-reset");
  setStatus(report ? `Reset. Teardown clean: ${report.clean}.` : "Nothing to reset.");
  render();
});

$("run-scenario").addEventListener("click", async () => {
  if (scenarioRunning) return;
  let params = {};
  const raw = $("scenario-params").value.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) params = parsed;
    } catch {
      return setStatus("Experiment parameters must be a JSON object.");
    }
  }
  const id = $("scenario").value;
  scenarioRunning = true;
  const state = $("scenario-state");
  state.dataset.state = "running";
  state.textContent = `${id}: running…`;
  for (const b of controls) b.disabled = true;
  try {
    lastResult = await runScenario(id, { pipeline, video, MP4Box, files: [...($("file").files ?? [])], params });
    $("scenario-result").textContent = JSON.stringify(lastResult, null, 2);
    state.dataset.state = lastResult.status === "ERROR" ? "error" : "done";
    state.textContent = `${id}: ${lastResult.status}${lastResult.checks ? ` (${lastResult.checks.filter((c) => c.ok).length}/${lastResult.checks.length} checks)` : ""}`;
  } finally {
    scenarioRunning = false;
    for (const b of controls) b.disabled = !MP4Box;
    render();
  }
});

// Page unload: release the session synchronously. The report is also posted on a
// same-origin BroadcastChannel so that another open spike page (?observe-unload) can
// record it; DevTools does not observe a document's pagehide output once it navigates.
const LAB_CHANNEL = "driftless-spike06-lab";
window.addEventListener("pagehide", (e) => {
  if (!pipeline.session) return;
  const r = pipeline.teardownSync("pagehide");
  const text = JSON.stringify({ persisted: e.persisted, clean: r.clean, reason: r.reason, msReadyState: r.msReadyState, sourceBuffers: r.sourceBuffers, resources: r.resources, queues: r.queues, video: r.video, preparerClosed: r.preparerClosed });
  console.info(`[spike06] pagehide teardown ${text}`);
  try {
    const bc = new BroadcastChannel(LAB_CHANNEL);
    bc.postMessage(text);
    bc.close();
  } catch {
    // BroadcastChannel unavailable: the console record is the only trace.
  }
});
if (new URLSearchParams(location.search).has("observe-unload")) {
  const bc = new BroadcastChannel(LAB_CHANNEL);
  bc.onmessage = (e) => console.info(`[spike06] observed pagehide teardown ${String(e.data).slice(0, 4000)}`);
  setStatus("Observing pagehide teardown reports from other spike pages.");
}

// Laboratory hook for the external browser driver (evidence collection only).
window.__spike06 = {
  pipeline,
  get lastResult() {
    return lastResult;
  },
  scenarios: SCENARIOS.map((s) => s.id),
  /** Autoplay negative control: load and call play() without any user activation. */
  async autoplayProbe() {
    const file = $("file").files?.[0];
    if (!file) return { error: "no file" };
    const activation = { hasBeenActive: navigator.userActivation?.hasBeenActive, isActive: navigator.userActivation?.isActive };
    const load = await pipeline.load(file, { profile: "MANUAL", initialSegments: 2 });
    const play = await Promise.race([pipeline.play(), new Promise((r) => setTimeout(() => r({ pending: true }), 3000))]);
    const sn = pipeline.snapshot();
    const out = { activation, load: load.ok, play, paused: sn.paused, currentTime: sn.currentTime, readyState: sn.readyState };
    out.reset = (await pipeline.reset("autoplay-probe")).clean;
    return out;
  },
};

render();
