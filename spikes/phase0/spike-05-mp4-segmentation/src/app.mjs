// Spike 0.5 page controller: file selection, experiment orchestration, diagnostics.
// All parsing/segmentation logic lives in session.mjs; this file only drives and renders.

import { builtinSegments, inspect, plannedSegments, precheck } from "./session.mjs";

const $ = (id) => document.getElementById(id);
const controls = ["run-inspect", "run-builtin", "run-planned", "run-seek", "run-all", "clear"].map($);
const MAX_LOG = 200;
const EVIDENCE_ROWS_HEAD = 20;
const EVIDENCE_ROWS_TAIL = 5;

const state = {
  file: undefined,
  running: false,
  abort: undefined,
  heapPeak: 0,
  runs: [],
  evidence: undefined,
  plannedHashes: new Map(),
  duration: undefined,
};

let MP4Box;
try {
  MP4Box = await import("../node_modules/mp4box/dist/mp4box.all.mjs");
} catch (e) {
  $("status").textContent = "MP4Box.js is not installed. Run `npm ci` in spikes/phase0/spike-05-mp4-segmentation/ and reload.";
  for (const b of controls) b.disabled = true;
}

// ---------- formatting (untrusted values are rendered only via textContent) ----------

function displayName(name) {
  const clean = String(name ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "�");
  return clean.length > 120 ? `${clean.slice(0, 117)}…` : clean;
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
  return u === 0 ? `${n} B` : `${v.toFixed(2)} ${units[u]} (${n.toLocaleString("en-US")} B)`;
}

function fmtSec(s) {
  if (!Number.isFinite(s)) return "—";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(3).padStart(6, "0");
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${sec}`;
}

const fmtMs = (ms) => (Number.isFinite(ms) ? (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`) : "—");

function heapNow() {
  const used = performance.memory?.usedJSHeapSize;
  if (Number.isFinite(used)) state.heapPeak = Math.max(state.heapPeak, used);
  return used;
}

function renderHeap() {
  const used = heapNow();
  $("heap").textContent = Number.isFinite(used) ? `${fmtBytes(used)} / ${fmtBytes(state.heapPeak)}` : "Unavailable";
}

function log(message) {
  const list = $("event-log");
  const li = document.createElement("li");
  li.textContent = `${new Date().toISOString()} — ${message}`;
  list.prepend(li);
  while (list.children.length > MAX_LOG) list.lastElementChild.remove();
}

function setStatus(text) {
  $("status").textContent = text;
}

function fillRow(tbody, cells, okIndex, ok) {
  const tr = document.createElement("tr");
  cells.forEach((text, i) => {
    const td = document.createElement("td");
    td.textContent = text ?? "—";
    if (i === okIndex && ok !== undefined) td.dataset.ok = String(ok);
    tr.append(td);
  });
  tbody.append(tr);
}

// ---------- evidence ----------

function newEvidence(file) {
  return {
    spike: "0.5 — MP4 Parsing & Segmentation",
    userAgent: navigator.userAgent,
    startedAt: new Date().toISOString(),
    file: { name: displayName(file.name), size: file.size, type: displayName(file.type) },
    blockSize: Number($("block-size").value),
    precheck: undefined,
    inspect: undefined,
    runs: [],
    comparisons: [],
    heapPeakBytes: 0,
  };
}

function trimRecords(records) {
  if (records.length <= EVIDENCE_ROWS_HEAD + EVIDENCE_ROWS_TAIL) return records;
  return [...records.slice(0, EVIDENCE_ROWS_HEAD), { omitted: records.length - EVIDENCE_ROWS_HEAD - EVIDENCE_ROWS_TAIL }, ...records.slice(-EVIDENCE_ROWS_TAIL)];
}

function publishEvidence() {
  if (!state.evidence) return;
  state.evidence.heapPeakBytes = state.heapPeak;
  $("results-json").textContent = JSON.stringify(state.evidence, null, 2);
}

// ---------- rendering ----------

function renderPrecheck(pre) {
  const l = pre.layout;
  $("layout").textContent = `${l.topLevelTypes.map((t) => (t.count > 1 ? `${t.type}×${t.count}` : t.type)).join(", ")} — moov ${l.moovPlacement}${l.hasTopLevelMoof ? ", fragmented (moof)" : ""}${l.usesLargeSize ? ", 64-bit box sizes" : ""}`;
  $("moov").textContent = l.moovOffset !== undefined
    ? `offset ${fmtBytes(l.moovOffset)} (${(l.moovPositionFraction * 100).toFixed(2)}% into file), size ${fmtBytes(l.moovSize)}; located with ${pre.scanReads} header reads (${pre.scanBytes} B)`
    : "not found";
  if (pre.refusal) $("classification").textContent = `REFUSED — ${pre.refusal.code}: ${pre.refusal.message}`;
}

function renderInspect(r) {
  state.duration = r.movie.durationSeconds;
  $("duration").textContent = `${fmtSec(r.movie.durationSeconds)} (${r.movie.trackCount} tracks, ${r.movie.isFragmented ? "fragmented" : "non-fragmented"} source)`;
  const c = r.classification;
  $("classification").textContent = `${c.verdict}${c.reasons.length ? ` — ${c.reasons.join("; ")}` : ""}${c.notes.length ? ` (${c.notes.join("; ")})` : ""}`;
  $("moov").textContent += ` — parser had moov after ${r.ready.reads} reads / ${fmtBytes(r.ready.bytesRead)}`;
  const body = $("tracks-body");
  body.replaceChildren();
  for (const t of c.tracks) {
    const ra = r.randomAccess[t.id] ?? {};
    const size = t.type === "video" ? `${t.width}×${t.height}` : t.type === "audio" ? `${t.channels} ch @ ${t.sampleRate} Hz` : "—";
    const iv = ra.syncIntervalSeconds;
    fillRow(body, [t.id, t.type, t.codec, size, t.timescale, fmtSec(t.durationSeconds), t.samples, ra.syncSamples, iv ? `${iv.min} / ${iv.median} / ${iv.max}` : "—", t.hasEditList ? `${t.editCount} entr${t.editCount === 1 ? "y" : "ies"}` : "none"]);
  }
  const later = $("later-body");
  later.replaceChildren();
  for (const lp of r.laterPosition) {
    for (const t of lp.tracks) {
      fillRow(later, [fmtSec(lp.targetSeconds), t.trackId, `#${t.randomAccessSample} (${fmtSec(t.randomAccessSeconds)})`, `${t.decodeLeadSeconds} s / ${t.samplesToDecodeBeforeTarget} samples`, fmtBytes(t.randomAccessOffset), `[${t.gopSourceRange[0]}, ${t.gopSourceRange[1]})`, fmtBytes(t.gopSampleBytes)]);
    }
  }
}

function videoStats(result) {
  const vid = result.classificationSelected ?? result.trackIds?.[0];
  const pt = result.segments?.perTrack ?? {};
  const v = pt[vid];
  const a = Object.entries(pt).find(([id]) => Number(id) !== vid)?.[1];
  return { v, a };
}

function renderRun(run) {
  const { v, a } = videoStats(run.result);
  const d = v?.durationSeconds;
  const r = run.result;
  const verdict = r.failure ? `FAIL — ${r.failure.code}` : r.segments?.problemCount ? `PROBLEMS (${r.segments.problemCount})` : "OK";
  fillRow($("runs-body"), [
    run.index,
    run.label,
    verdict,
    `${v?.segments ?? "—"} / ${a?.segments ?? "—"}`,
    d ? `${d.min} / ${d.median} / ${d.max}` : "—",
    v ? (v.verifiedAllStartWithSync ? "all" : "NOT all") : "—",
    r.source?.reads,
    fmtBytes(r.source?.bytesRead),
    fmtBytes(r.memory?.max?.retainedBytes),
    fmtMs(r.ms),
    run.note ?? "",
  ], 2, !r.failure && !r.segments?.problemCount);
  $("segments").textContent = r.segments ? `${r.segments.count} (${fmtBytes(r.segments.totalBytes)}), verification problems: ${r.segments.problemCount}` : "—";
  if (r.init) $("init").textContent = `generated, ${fmtBytes(r.init.bytes)}, tracks ${r.init.tracks.map((t) => `${t.trackId}:${t.sampleEntry}`).join(", ")}, ${r.init.problems.length ? `problems: ${r.init.problems.join("; ")}` : "structure verified"}${r.initSha256 ? `, sha256 ${r.initSha256.slice(0, 16)}…` : ""}`;
  $("retained").textContent = r.memory ? `${fmtBytes(r.memory.max.retainedBytes)} (stream ${fmtBytes(r.memory.max.streamBytes)}, sample data ${fmtBytes(r.memory.max.sampleDataBytes)})` : "—";
  $("errors").textContent = r.parserErrors?.length ? r.parserErrors.map((e) => `${e.module}: ${e.message}`).join("; ") : r.failure ? `${r.failure.code}: ${r.failure.message}` : "none";
  const seg = $("segments-body");
  seg.replaceChildren();
  const rows = r.records.length > 16 ? [...r.records.slice(0, 12), ...r.records.slice(-4)] : r.records;
  for (const x of rows) {
    fillRow(seg, [x.index, x.trackId, `${x.firstSample}–${x.endSample - 1}`, x.startSeconds, x.durationSeconds, x.bytes, `${x.startsWithSync} / ${x.verifiedFirstSampleSync}`, `[${x.sourceRange[0]}, ${x.sourceRange[1]})`, x.sha256 ? x.sha256.slice(0, 12) : "—", x.problems.length ? x.problems.join("; ") : "none"], 6, x.verifiedFirstSampleSync);
  }
}

// ---------- experiment runners ----------

function options(extra = {}) {
  return {
    blockSize: Number($("block-size").value),
    signal: state.abort.signal,
    memorySampler: heapNow,
    onProgress: (p) => {
      $("progress").textContent = `${fmtBytes(p.bytesRead)} read in ${p.reads} reads; next offset ${p.offset.toLocaleString("en-US")} of ${p.size.toLocaleString("en-US")}`;
      renderHeap();
    },
    ...extra,
  };
}

function laterTarget() {
  const raw = $("later").value.trim();
  const v = raw === "" ? NaN : Number(raw);
  if (Number.isFinite(v) && v >= 0) return v;
  return state.duration ? Math.floor(state.duration / 2) : undefined;
}

function recordRun(label, result, note) {
  const index = state.runs.length + 1;
  const run = { index, label, note, result };
  state.runs.push(run);
  const selected = state.evidence.inspect?.classification?.selected?.videoTrackId;
  result.classificationSelected = selected;
  renderRun(run);
  const { records, keptSegments, classificationSelected, ...rest } = result;
  state.evidence.runs.push({ index, label, note, ...rest, records: trimRecords(records) });
  publishEvidence();
  log(`${label}: ${result.failure ? `FAIL ${result.failure.code}` : `${result.segments?.count ?? 0} segments, ${result.segments?.problemCount ?? 0} problems`} (${fmtMs(result.ms)})`);
  return run;
}

async function stepPrecheck() {
  $("operation").textContent = "pre-check (box headers + moov budget)";
  const pre = await precheck(state.file, { signal: state.abort.signal });
  state.evidence.precheck = pre;
  renderPrecheck(pre);
  publishEvidence();
  log(`pre-check: moov ${pre.layout.moovPlacement}${pre.refusal ? `; REFUSED ${pre.refusal.code}` : ""}`);
  return pre;
}

async function stepInspect() {
  $("operation").textContent = "inspect (parse until moov)";
  // Blank target: inspect() defaults to 50% of the movie duration.
  const r = await inspect(MP4Box, state.file, options({ laterPositionSeconds: $("later").value.trim() ? [laterTarget()] : undefined }));
  state.evidence.inspect = r;
  renderInspect(r);
  publishEvidence();
  log(`inspect: ${r.classification.verdict}; moov parsed after ${r.ready.reads} reads`);
  return r;
}

async function stepBuiltin(target, extra = {}, note) {
  $("operation").textContent = `built-in segmentation ≈${target} s`;
  const r = await builtinSegments(MP4Box, state.file, options({ targetSeconds: target, hash: $("hash").checked, ...extra }));
  return recordRun(`built-in ≈${target} s${extra.seekSeconds !== undefined ? ` seek ${fmtSec(extra.seekSeconds)}${extra.useRap === false ? " (no RAP)" : ""}` : ""}${extra.drainUnselectedTracks === false ? " (no drain)" : ""}`, r, note);
}

async function stepPlanned(target, extra = {}, note) {
  $("operation").textContent = `planned segmentation ≈${target} s`;
  const r = await plannedSegments(MP4Box, state.file, options({ targetSeconds: target, hash: $("hash").checked, ...extra }));
  if (extra.atSeconds === undefined) {
    const map = new Map();
    for (const rec of r.records) if (rec.sha256) map.set(`${rec.trackId}:${rec.planIndex}`, rec.sha256);
    state.plannedHashes.set(target, map);
  }
  return recordRun(`planned ≈${target} s${extra.atSeconds !== undefined ? ` random access @ ${fmtSec(extra.atSeconds)}` : ""}`, r, note);
}

async function stepLater(target) {
  const t = laterTarget();
  if (t === undefined) { log("later-position: run Inspect first or enter a target"); return; }
  const planned = await stepPlanned(target, { atSeconds: t, indices: [] }, "moov + one planned window only");
  const seq = state.plannedHashes.get(target);
  if (seq && planned.result.records.length) {
    const matches = planned.result.records.map((rec) => ({ trackId: rec.trackId, planIndex: rec.planIndex, randomAccess: rec.sha256, sequential: seq.get(`${rec.trackId}:${rec.planIndex}`) }));
    const identical = matches.every((m) => m.randomAccess && m.randomAccess === m.sequential);
    state.evidence.comparisons.push({ kind: "planned random access vs sequential", target, atSeconds: t, identical, matches });
    log(`planned random-access segment ${matches[0]?.planIndex} ${identical ? "byte-identical to" : "DIFFERS from"} the sequential cut`);
  }
  const rap = await stepBuiltin(target, { seekSeconds: t, useRap: true, maxSegmentsPerTrack: 3 }, "MP4Box.js seek(t, true)");
  await stepBuiltin(target, { seekSeconds: t, useRap: false, maxSegmentsPerTrack: 3 }, "negative control: seek(t, false)");
  const full = state.evidence.runs.find((x) => x.strategy?.kind === "builtin" && x.strategy.targetSeconds === target && x.strategy.seekSeconds === undefined && !x.failure);
  if (full && rap.result.seek?.firstSegment) {
    const vid = state.evidence.inspect?.classification?.selected?.videoTrackId;
    const first = rap.result.seek.firstSegment[vid];
    const seqRows = state.runs.find((x) => x.result.strategy?.kind === "builtin" && x.result.strategy.targetSeconds === target && x.result.strategy.seekSeconds === undefined)?.result.records.filter((x) => x.trackId === vid) ?? [];
    const aligned = seqRows.some((x) => x.firstSample === first?.startSample);
    state.evidence.comparisons.push({ kind: "built-in seek segment vs sequential built-in boundaries", target, atSeconds: t, seekStartSample: first?.startSample, matchesSequentialBoundary: aligned });
    log(`built-in seek started at sample ${first?.startSample}; ${aligned ? "matches" : "does NOT match"} a sequential built-in boundary`);
  }
  publishEvidence();
}

async function guarded(label, fn) {
  if (!state.file || state.running) return;
  state.running = true;
  state.abort = new AbortController();
  for (const b of controls) b.disabled = true;
  $("cancel").disabled = false;
  setStatus(`${label}…`);
  const t0 = performance.now();
  try {
    if (!state.evidence) state.evidence = newEvidence(state.file);
    await fn();
    setStatus(`${label} finished in ${fmtMs(performance.now() - t0)}.`);
  } catch (e) {
    const msg = e?.name === "AbortError" ? "cancelled" : `${e?.code ?? e?.name ?? "Error"}: ${e?.message ?? e}`;
    setStatus(`${label} stopped — ${msg}`);
    log(`${label} stopped — ${msg}`);
    if (state.evidence) { state.evidence.aborted = { label, message: msg }; publishEvidence(); }
  } finally {
    state.running = false;
    $("cancel").disabled = true;
    for (const b of controls) b.disabled = !MP4Box;
    $("operation").textContent = "idle";
    renderHeap();
  }
}

async function ensureInspected() {
  if (!state.evidence.precheck) {
    const pre = await stepPrecheck();
    if (pre.refusal) return false;
  } else if (state.evidence.precheck.refusal) {
    return false;
  }
  if (!state.evidence.inspect) await stepInspect();
  return true;
}

async function runAll() {
  const pre = await stepPrecheck();
  if (pre.refusal) { log("full analysis stopped at the pre-check (input refused before parsing)"); return; }
  const ins = await stepInspect();
  const targets = $("all-targets").checked ? [1, 2, 4] : [Number($("target").value)];
  const isTarget = ins.classification.verdict === "TARGET COMPATIBLE";
  if (!isTarget) {
    await stepBuiltin(2, {}, "experimental: non-target media");
    if (ins.classification.tracks.filter((t) => t.type === "audio" || t.type === "video").length > 2) {
      await stepBuiltin(2, { drainUnselectedTracks: false }, "unselected track not drained");
    }
    return;
  }
  for (const t of targets) await stepBuiltin(t);
  for (const t of targets) await stepPlanned(t);
  await stepLater(targets.includes(2) ? 2 : targets[0]);
}

// ---------- wiring ----------

$("user-agent").textContent = navigator.userAgent;
renderHeap();

$("file").addEventListener("change", () => {
  const file = $("file").files?.[0];
  state.file = file;
  state.evidence = file ? newEvidence(file) : undefined;
  state.plannedHashes.clear();
  state.duration = undefined;
  $("file-name").textContent = file ? displayName(file.name) : "—";
  $("source-size").textContent = file ? fmtBytes(file.size) : "—";
  $("read-block").textContent = `${fmtBytes(Number($("block-size").value))} / one read in flight`;
  for (const id of ["layout", "moov", "duration", "classification", "init", "segments", "retained", "progress"]) $(id).textContent = "—";
  $("errors").textContent = "none";
  for (const id of ["tracks-body", "runs-body", "segments-body", "later-body"]) $(id).replaceChildren();
  state.runs = [];
  publishEvidence();
  setStatus(file ? "File selected. Nothing has been read yet." : "Select a file.");
  if (file) log(`selected ${displayName(file.name)} (${fmtBytes(file.size)})`);
});

$("block-size").addEventListener("change", () => {
  $("read-block").textContent = `${fmtBytes(Number($("block-size").value))} / one read in flight`;
  if (state.evidence) state.evidence.blockSize = Number($("block-size").value);
});

$("run-inspect").addEventListener("click", () => guarded("Inspect", async () => { await stepPrecheck(); if (!state.evidence.precheck.refusal) await stepInspect(); }));
$("run-builtin").addEventListener("click", () => guarded("Built-in segmentation", async () => { if (await ensureInspected()) await stepBuiltin(Number($("target").value)); }));
$("run-planned").addEventListener("click", () => guarded("Planned segmentation", async () => { if (await ensureInspected()) await stepPlanned(Number($("target").value)); }));
$("run-seek").addEventListener("click", () => guarded("Later-position experiments", async () => { if (await ensureInspected()) await stepLater(Number($("target").value)); }));
$("run-all").addEventListener("click", () => guarded("Full analysis", runAll));
$("cancel").addEventListener("click", () => state.abort?.abort(new DOMException("Cancelled by user", "AbortError")));
$("clear").addEventListener("click", () => {
  state.runs = [];
  state.plannedHashes.clear();
  state.evidence = state.file ? newEvidence(state.file) : undefined;
  for (const id of ["tracks-body", "runs-body", "segments-body", "later-body"]) $(id).replaceChildren();
  publishEvidence();
  log("results cleared (no segment data was retained)");
});
