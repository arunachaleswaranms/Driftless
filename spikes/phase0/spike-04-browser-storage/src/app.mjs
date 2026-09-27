// Spike 0.4 page controller. Laboratory code only: it stores generated synthetic bytes in this
// origin's private file system and never reads user files, uploads, or contacts a network.

import {
  GiB,
  HEADROOM_POLICY,
  KiB,
  LIMITS,
  MiB,
  SPIKE_DIRECTORY,
  admitWrite,
  boundaryRanges,
  buildMetadata,
  displayName,
  formatBytes,
  formatDuration,
  headroomFromEstimate,
  isSpikeEntryName,
  isSpikeMetadataName,
  makeEntryName,
  metadataNameFor,
  parseMetadata,
  randomHex32,
  randomSeed,
  validateBlockBytes,
  verificationRanges,
} from "./plan.mjs";
import {
  clearSpikeStorage,
  deleteEntry,
  describeError,
  exists,
  isQuotaError,
  listEntries,
  openSpikeDirectory,
  readBoundedText,
  verifyRanges,
  verifySequential,
  writeBlocks,
  writePatternRange,
  writeText,
} from "./storage.mjs";

const VERIFY_BLOCK_BYTES = 1 * MiB;
const RANGE_BYTES = 256 * KiB;
const MAX_LOG_ENTRIES = 200;
const WORKER_TIMEOUT_MS = 120_000;

const $ = (id) => document.getElementById(id);
const output = new Proxy({}, { get: (_, id) => $(id) });

const state = {
  busy: false,
  controller: null,
  results: [],
  sessionWritten: 0,
  sessionRead: 0,
  heapPeak: 0,
  root: null,
  directory: null,
  worker: null,
  workerSeq: 0,
  workerPending: new Map(),
  capabilities: {},
};

// ---------------------------------------------------------------------------------------------
// Diagnostics rendering

const CAPABILITIES = [
  ["secureContext", "Secure context"],
  ["storageManager", "StorageManager (navigator.storage)"],
  ["estimate", "navigator.storage.estimate()"],
  ["opfs", "OPFS navigator.storage.getDirectory()"],
  ["createWritable", "FileSystemFileHandle.createWritable()"],
  ["seek", "FileSystemWritableFileStream.seek() (resume offset)"],
  ["randomRead", "File.slice() random-access read"],
  ["removeEntry", "FileSystemDirectoryHandle.removeEntry()"],
  ["persisted", "navigator.storage.persisted()"],
  ["persist", "navigator.storage.persist()"],
  ["syncAccessHandle", "createSyncAccessHandle() in dedicated worker"],
  ["reload", "OPFS entry survives page reload"],
];

function setCapability(key, patch) {
  state.capabilities[key] = { api: "unknown", verified: "NOT YET", evidence: "", ...state.capabilities[key], ...patch };
  renderCapabilities();
}

function renderCapabilities() {
  const body = output["capabilities-body"];
  body.replaceChildren(
    ...CAPABILITIES.map(([key, label]) => {
      const entry = state.capabilities[key] ?? { api: "unknown", verified: "NOT YET", evidence: "" };
      const row = document.createElement("tr");
      const cells = [
        label,
        entry.api === true ? "API AVAILABLE" : entry.api === false ? "API MISSING" : String(entry.api),
        entry.verified,
        entry.evidence,
      ];
      cells.forEach((text, index) => {
        const cell = document.createElement("td");
        cell.textContent = text;
        if (index === 1 && typeof entry.api === "boolean") cell.dataset.ok = String(entry.api);
        if (index === 2 && entry.verified !== "NOT YET") cell.dataset.ok = String(entry.verified === "BEHAVIOR VERIFIED");
        row.append(cell);
      });
      return row;
    }),
  );
}

function setStatus(message, kind = "info") {
  output.status.textContent = message;
  output.status.dataset.kind = kind;
}

function log(message) {
  const entry = document.createElement("li");
  entry.textContent = `${new Date().toISOString()} — ${message}`;
  output["event-log"].prepend(entry);
  while (output["event-log"].children.length > MAX_LOG_ENTRIES) output["event-log"].lastElementChild.remove();
}

function sampleHeap() {
  const used = performance.memory?.usedJSHeapSize;
  if (!Number.isFinite(used)) return null;
  if (used > state.heapPeak) state.heapPeak = used;
  return used;
}

function renderHeap() {
  const used = sampleHeap();
  output.heap.textContent = used === null ? "Unavailable" : `${formatBytes(used)} / ${formatBytes(state.heapPeak)}`;
}

function setOperation(text) {
  output.operation.textContent = text;
  renderHeap();
}

function setProgress(id, done, total) {
  output[id].textContent = Number.isFinite(total) && total > 0 ? `${formatBytes(done)} of ${formatBytes(total)} (${((done / total) * 100).toFixed(1)}%)` : "—";
}

function addSessionBytes({ written = 0, read = 0 }) {
  state.sessionWritten += written;
  state.sessionRead += read;
  output["bytes-written"].textContent = formatBytes(state.sessionWritten);
  output["bytes-read"].textContent = formatBytes(state.sessionRead);
}

function setBusy(busy) {
  state.busy = busy;
  for (const id of ["run-single", "run-matrix", "write-persist", "verify-stored", "clear", "refresh-entries", "request-persist"]) {
    $(id).disabled = busy;
  }
  $("abort").disabled = !busy;
  for (const button of output["entries-body"].querySelectorAll("button")) button.disabled = busy;
}

function renderResults() {
  const body = output["results-body"];
  body.replaceChildren(
    ...state.results.map((result, index) => {
      const row = document.createElement("tr");
      const ok = result.status === "PASS" ? "true" : result.status === "REFUSED" ? "refused" : result.status === "INFO" ? "" : "false";
      const cells = [
        String(index + 1),
        result.test,
        Number.isFinite(result.requestedBytes) ? formatBytes(result.requestedBytes) : "—",
        Number.isFinite(result.bytesWritten) ? formatBytes(result.bytesWritten) : "—",
        Number.isFinite(result.blockBytes) ? formatBytes(result.blockBytes) : "—",
        Number.isFinite(result.writeMs) ? formatDuration(result.writeMs) : "—",
        result.verifySummary ?? "—",
        Number.isFinite(result.usageDeltaBytes) ? formatBytes(result.usageDeltaBytes) : "—",
        Number.isFinite(result.heapPeakBytes) ? formatBytes(result.heapPeakBytes) : "—",
        result.status,
        result.notes ?? "",
      ];
      cells.forEach((text, cellIndex) => {
        const cell = document.createElement("td");
        cell.textContent = text;
        if (cellIndex === 9 && ok) cell.dataset.ok = ok;
        row.append(cell);
      });
      return row;
    }),
  );
  output["results-json"].textContent = JSON.stringify(state.results, null, 2);
}

function record(result) {
  state.results.push({ recordedAt: new Date().toISOString(), ...result });
  renderResults();
  log(`${result.test}: ${result.status}${result.notes ? ` — ${result.notes}` : ""}`);
  return result;
}

// ---------------------------------------------------------------------------------------------
// Storage estimate and persistence

async function realEstimate() {
  if (typeof navigator.storage?.estimate !== "function") return null;
  const estimate = await navigator.storage.estimate();
  return {
    quota: estimate.quota,
    usage: estimate.usage,
    usageDetails: estimate.usageDetails ? { ...estimate.usageDetails } : undefined,
  };
}

// ST-11 uses simulated estimates so refusal logic is exercised without filling real storage.
async function admissionEstimate(source) {
  const real = await realEstimate();
  if (source === "simulated-low") return { quota: (real?.usage ?? 0) + 900 * MiB, usage: real?.usage ?? 0, simulated: true };
  if (source === "simulated-none") return { simulated: true };
  return real;
}

async function refreshEstimate() {
  const estimate = await realEstimate();
  if (!estimate) {
    output.quota.textContent = output.usage.textContent = output.headroom.textContent = "Unavailable";
    return null;
  }
  output.quota.textContent = formatBytes(estimate.quota);
  output.usage.textContent = formatBytes(estimate.usage);
  output.headroom.textContent = formatBytes(headroomFromEstimate(estimate));
  output["usage-details"].textContent = estimate.usageDetails
    ? Object.entries(estimate.usageDetails).map(([key, value]) => `${key}: ${formatBytes(value)}`).join(", ") || "{}"
    : "not reported";
  if (typeof navigator.storage?.persisted === "function") {
    output.persisted.textContent = String(await navigator.storage.persisted());
  }
  return estimate;
}

async function requestPersistence() {
  if (typeof navigator.storage?.persist !== "function") {
    output["persist-result"].textContent = "persist() unavailable";
    return record({ test: "ST-09 persistence request", status: "INFO", notes: "persist() is not available" });
  }
  const before = await navigator.storage.persisted();
  const startedAt = performance.now();
  const granted = await navigator.storage.persist();
  const ms = performance.now() - startedAt;
  const after = await navigator.storage.persisted();
  output["persist-result"].textContent = `requested → ${granted ? "granted" : "not granted"} (${formatDuration(ms)})`;
  output.persisted.textContent = String(after);
  setCapability("persist", { api: true, verified: "BEHAVIOR VERIFIED", evidence: `persist() resolved ${granted}; persisted() ${before} → ${after}` });
  return record({
    test: "ST-09 persistence request",
    status: "INFO",
    persistedBefore: before,
    persistGranted: granted,
    persistedAfter: after,
    persistMs: ms,
    notes: `persisted() before ${before}; persist() → ${granted}; persisted() after ${after}. A denial is not a failure.`,
  });
}

// ---------------------------------------------------------------------------------------------
// OPFS handles and worker

async function spikeDirectory() {
  state.root ??= await navigator.storage.getDirectory();
  state.directory = await openSpikeDirectory(state.root);
  return state.directory;
}

function ensureWorker() {
  if (state.worker) return state.worker;
  const worker = new Worker(new URL("./sync-worker.mjs", import.meta.url), { type: "module" });
  worker.addEventListener("message", (event) => {
    const { id, ok, result, error } = event.data ?? {};
    const pending = state.workerPending.get(id);
    if (!pending) return;
    state.workerPending.delete(id);
    clearTimeout(pending.timer);
    if (ok) pending.resolve(result);
    else pending.reject(new Error(String(error).slice(0, 300)));
  });
  worker.addEventListener("error", (event) => {
    for (const pending of state.workerPending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`worker error: ${event.message ?? "unknown"}`));
    }
    state.workerPending.clear();
  });
  state.worker = worker;
  return worker;
}

function workerCall(op, args) {
  const worker = ensureWorker();
  const id = ++state.workerSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.workerPending.delete(id);
      reject(new Error(`worker ${op} timed out`));
    }, WORKER_TIMEOUT_MS);
    state.workerPending.set(id, { resolve, reject, timer });
    worker.postMessage({ id, op, args });
  });
}

// ---------------------------------------------------------------------------------------------
// Tests

function beginTest(label, name) {
  output["current-test"].textContent = label;
  output["current-file"].textContent = name ? displayName(name) : "—";
  output.integrity.textContent = "—";
  output["write-progress"].textContent = "—";
  output["read-progress"].textContent = "—";
  state.heapPeak = 0;
  return { heapStart: sampleHeap(), startedAt: performance.now() };
}

function finishTest(context) {
  const ms = performance.now() - context.startedAt;
  output.duration.textContent = formatDuration(ms);
  renderHeap();
  return { durationMs: ms, heapStartBytes: context.heapStart, heapPeakBytes: state.heapPeak || null };
}

function summarizeVerify(ranges, sequential) {
  const parts = [];
  if (ranges) parts.push(`ranges ${ranges.results.filter((r) => r.ok).length}/${ranges.results.length}`);
  if (sequential) parts.push(`full ${sequential.ok ? "match" : "FAIL"}`);
  return parts.join(", ");
}

async function cleanupEntry(directory, name, alsoMetadata = false) {
  const results = [await deleteEntry(directory, name)];
  if (alsoMetadata) results.push(await deleteEntry(directory, metadataNameFor(name)));
  const absent = results.every((result) => result.absent);
  output.cleanup.textContent = absent ? `deleted ${displayName(name)}; absence confirmed` : `deletion of ${displayName(name)} NOT confirmed`;
  return { absent, deleted: results };
}

// Write → verify selected ranges → verify every byte → optional extra probe → delete.
async function runWriteTest({ test, kind = "st", bytes, blockBytes, headroomSource = "real", keep = false, probe } = {}) {
  const directory = await spikeDirectory();
  const admissionInput = await admissionEstimate(headroomSource);
  const admission = admitWrite({ bytes, estimate: admissionInput });
  if (!admission.ok) {
    output["current-test"].textContent = test;
    output.integrity.textContent = admission.code;
    return record({
      test,
      status: "REFUSED",
      requestedBytes: bytes,
      blockBytes,
      admission,
      headroomSource,
      notes: `${admission.code}: ${admission.reason}`,
    });
  }

  const name = makeEntryName(kind, bytes, randomHex32());
  const seed = randomSeed();
  const context = beginTest(test, name);
  const usageBefore = (await realEstimate())?.usage;
  const signal = state.controller?.signal;
  const fileHandle = await directory.getFileHandle(name, { create: true });
  const result = { test, requestedBytes: bytes, blockBytes, name, seed, admission, headroomSource };

  try {
    setOperation("writing");
    const write = await writePatternRange(fileHandle, {
      end: bytes,
      blockBytes,
      seed,
      signal,
      onBlock: sampleHeap,
      onProgress: (done) => {
        setProgress("write-progress", done, bytes);
        renderHeap();
      },
    });
    addSessionBytes({ written: write.bytesWritten });
    Object.assign(result, { bytesWritten: write.bytesWritten, blocks: write.blocks, writeMs: write.totalMs, openMs: write.openMs, closeMs: write.closeMs });
    result.writeHeapPeakBytes = state.heapPeak || null;
    result.usageAfterWrite = (await realEstimate())?.usage;
    result.usageDeltaBytes = Number.isFinite(usageBefore) && Number.isFinite(result.usageAfterWrite) ? result.usageAfterWrite - usageBefore : null;

    setOperation("verifying selected ranges");
    result.ranges = await verifyRanges(fileHandle, verificationRanges(bytes, RANGE_BYTES), seed);
    addSessionBytes({ read: result.ranges.bytesRead });

    setOperation("verifying every byte (streamed)");
    result.sequential = await verifySequential(fileHandle, {
      seed,
      expectedBytes: bytes,
      blockBytes: VERIFY_BLOCK_BYTES,
      signal,
      onProgress: (done) => {
        setProgress("read-progress", done, bytes);
        sampleHeap();
      },
    });
    addSessionBytes({ read: result.sequential.bytesRead });

    if (probe) {
      setOperation("probe");
      result.probe = await probe({ fileHandle, name, seed, bytes });
    }
  } catch (error) {
    result.error = describeError(error);
    result.quotaError = isQuotaError(error);
    result.bytesWritten ??= error.bytesWritten;
  }

  if (!keep || result.error) {
    setOperation("deleting");
    result.cleanup = await cleanupEntry(directory, name);
    result.usageAfterDelete = (await realEstimate())?.usage;
  }
  Object.assign(result, finishTest(context));

  const verified = result.ranges?.ok && result.sequential?.ok && (!result.probe || result.probe.ok !== false);
  result.status = result.error ? (result.quotaError ? "QUOTA ERROR" : "ERROR") : verified && (keep || result.cleanup?.absent) ? "PASS" : "FAIL";
  result.verifySummary = summarizeVerify(result.ranges, result.sequential);
  result.notes = result.error ?? result.probe?.summary ?? "";
  output.integrity.textContent = result.status === "PASS" ? `PASS — ${result.verifySummary}` : `${result.status} — ${result.error ?? result.verifySummary}`;
  setOperation("idle");

  if (result.status === "PASS") {
    const largest = Math.max(bytes, state.capabilities.createWritable?.largest ?? 0);
    setCapability("createWritable", { verified: "BEHAVIOR VERIFIED", evidence: `largest verified write ${formatBytes(largest)}`, largest });
    setCapability("randomRead", { verified: "BEHAVIOR VERIFIED", evidence: `${result.ranges.results.length} ranges verified in a ${formatBytes(bytes)} file` });
    if (!keep) setCapability("removeEntry", { verified: "BEHAVIOR VERIFIED", evidence: "delete + NotFoundError on lookup confirmed" });
  }
  return record(result);
}

// Measures what reopening an existing file for a keepExistingData resume costs, then aborts.
function resumeOpenProbe() {
  return async ({ fileHandle, seed, bytes }) => {
    const usageBefore = (await realEstimate())?.usage;
    const keepStartedAt = performance.now();
    const writable = await fileHandle.createWritable({ keepExistingData: true });
    const keepExistingOpenMs = performance.now() - keepStartedAt;
    const usageWhileOpen = (await realEstimate())?.usage;
    await writable.abort();
    const freshStartedAt = performance.now();
    const fresh = await fileHandle.createWritable({ keepExistingData: false });
    const freshOpenMs = performance.now() - freshStartedAt;
    await fresh.abort();
    const after = await verifyRanges(fileHandle, verificationRanges(bytes, RANGE_BYTES), seed);
    addSessionBytes({ read: after.bytesRead });
    const usageDeltaWhileOpen = Number.isFinite(usageBefore) && Number.isFinite(usageWhileOpen) ? usageWhileOpen - usageBefore : null;
    return {
      ok: after.ok && after.fileBytes === bytes,
      keepExistingOpenMs,
      freshOpenMs,
      usageDeltaWhileOpen,
      intactAfterAbort: after.ok && after.fileBytes === bytes,
      summary: `keepExistingData open ${formatDuration(keepExistingOpenMs)} vs fresh open ${formatDuration(freshOpenMs)}; usage Δ while open ${formatBytes(usageDeltaWhileOpen)}; intact after abort ${after.ok}`,
    };
  };
}

// ST-06: write, close, reopen from the directory, resume at the stored size, verify the boundary.
async function runResumeTest({ test, totalBytes, boundaryBytes, blockBytes }) {
  const admission = admitWrite({ bytes: totalBytes, estimate: await realEstimate() });
  if (!admission.ok) return record({ test, status: "REFUSED", requestedBytes: totalBytes, notes: `${admission.code}: ${admission.reason}` });

  const directory = await spikeDirectory();
  const name = makeEntryName("resume", totalBytes, randomHex32());
  const seed = randomSeed();
  const context = beginTest(test, name);
  const result = { test, requestedBytes: totalBytes, boundaryBytes, blockBytes, name, seed };
  const signal = state.controller?.signal;
  try {
    setOperation("writing initial portion");
    const first = await writePatternRange(await directory.getFileHandle(name, { create: true }), {
      end: boundaryBytes,
      blockBytes,
      seed,
      signal,
      onBlock: sampleHeap,
      onProgress: (done) => setProgress("write-progress", done, totalBytes),
    });
    addSessionBytes({ written: first.bytesWritten });

    // Re-open through a fresh root/directory lookup so the resume does not reuse the first handle.
    const reopenedDirectory = await openSpikeDirectory(await navigator.storage.getDirectory());
    const reopened = await reopenedDirectory.getFileHandle(name);
    const storedBytes = (await reopened.getFile()).size;

    let wrongOffsetRefused = false;
    try {
      await writePatternRange(reopened, { start: storedBytes + 4096, end: totalBytes, blockBytes, seed, keepExistingData: true });
    } catch (error) {
      wrongOffsetRefused = error instanceof RangeError;
    }

    setOperation("resuming");
    const second = await writePatternRange(reopened, {
      start: storedBytes,
      end: totalBytes,
      blockBytes,
      seed,
      keepExistingData: true,
      signal,
      onBlock: sampleHeap,
      onProgress: (done) => setProgress("write-progress", storedBytes + done, totalBytes),
    });
    addSessionBytes({ written: second.bytesWritten });

    setOperation("verifying resume boundary");
    const boundary = await verifyRanges(reopened, boundaryRanges(boundaryBytes, totalBytes), seed);
    const ranges = await verifyRanges(reopened, verificationRanges(totalBytes, RANGE_BYTES), seed);
    const sequential = await verifySequential(reopened, {
      seed,
      expectedBytes: totalBytes,
      blockBytes: VERIFY_BLOCK_BYTES,
      signal,
      onProgress: (done) => setProgress("read-progress", done, totalBytes),
    });
    addSessionBytes({ read: boundary.bytesRead + ranges.bytesRead + sequential.bytesRead });
    Object.assign(result, {
      bytesWritten: first.bytesWritten + second.bytesWritten,
      writeMs: first.totalMs + second.totalMs,
      first: { bytesWritten: first.bytesWritten, openMs: first.openMs, closeMs: first.closeMs, totalMs: first.totalMs },
      storedBytesAfterReopen: storedBytes,
      wrongOffsetRefused,
      second: { existingBytes: second.existingBytes, bytesWritten: second.bytesWritten, openMs: second.openMs, closeMs: second.closeMs, totalMs: second.totalMs },
      boundary,
      ranges,
      sequential,
    });
  } catch (error) {
    result.error = describeError(error);
  }
  setOperation("deleting");
  result.cleanup = await cleanupEntry(directory, name);
  Object.assign(result, finishTest(context));
  const ok = !result.error && result.storedBytesAfterReopen === boundaryBytes && result.wrongOffsetRefused && result.boundary?.ok && result.ranges?.ok && result.sequential?.ok && result.cleanup.absent;
  result.status = result.error ? "ERROR" : ok ? "PASS" : "FAIL";
  result.verifySummary = result.error ? "—" : `boundary ${result.boundary.results.filter((r) => r.ok).length}/${result.boundary.results.length}, ${summarizeVerify(result.ranges, result.sequential)}`;
  result.notes = result.error ?? `reopened size ${formatBytes(result.storedBytesAfterReopen)}; resume open ${formatDuration(result.second.openMs)}; wrong offset refused ${result.wrongOffsetRefused}`;
  output.integrity.textContent = `${result.status} — ${result.verifySummary}`;
  if (ok) setCapability("seek", { verified: "BEHAVIOR VERIFIED", evidence: `resume at ${formatBytes(boundaryBytes)} verified across boundary` });
  setOperation("idle");
  return record(result);
}

// Supplementary: when does createWritable() data become visible, and what does abort() keep?
async function runCommitSemanticsTest() {
  const test = "ST-S1 createWritable commit semantics";
  const directory = await spikeDirectory();
  const bytes = 16 * MiB;
  const name = makeEntryName("probe", bytes, randomHex32());
  const seed = randomSeed();
  const context = beginTest(test, name);
  const result = { test, requestedBytes: bytes, blockBytes: 1 * MiB, name };
  try {
    const handle = await directory.getFileHandle(name, { create: true });
    const usageBefore = (await realEstimate())?.usage;
    const writable = await handle.createWritable();
    await writeBlocks(writable, { end: bytes, blockBytes: 1 * MiB, seed });
    result.sizeWhileOpen = (await handle.getFile()).size;
    result.usageDeltaWhileOpen = ((await realEstimate())?.usage ?? NaN) - usageBefore;
    await writable.close();
    result.sizeAfterClose = (await handle.getFile()).size;

    const extend = await handle.createWritable({ keepExistingData: true });
    await writeBlocks(extend, { start: bytes, end: bytes + 8 * MiB, blockBytes: 1 * MiB, seed });
    result.sizeWhileExtending = (await handle.getFile()).size;
    await extend.abort();
    result.sizeAfterAbort = (await handle.getFile()).size;
    result.sequential = await verifySequential(handle, { seed, expectedBytes: bytes, blockBytes: VERIFY_BLOCK_BYTES });
    result.bytesWritten = bytes + 8 * MiB;
    addSessionBytes({ written: result.bytesWritten, read: result.sequential.bytesRead });
  } catch (error) {
    result.error = describeError(error);
  }
  result.cleanup = await cleanupEntry(directory, name);
  Object.assign(result, finishTest(context));
  result.status = result.error ? "ERROR" : "INFO";
  result.verifySummary = result.sequential ? summarizeVerify(null, result.sequential) : "—";
  result.notes =
    result.error ??
    `size while open ${formatBytes(result.sizeWhileOpen)} → after close ${formatBytes(result.sizeAfterClose)}; while extending ${formatBytes(result.sizeWhileExtending)} → after abort ${formatBytes(result.sizeAfterAbort)}; usage Δ while open ${formatBytes(result.usageDeltaWhileOpen)}`;
  return record(result);
}

// Supplementary: in-place writes through FileSystemSyncAccessHandle in a dedicated worker.
async function runSyncAccessTest() {
  const test = "ST-S2 sync access handle (worker)";
  let capabilities;
  try {
    capabilities = await workerCall("capabilities");
  } catch (error) {
    setCapability("syncAccessHandle", { api: false, verified: "NOT VERIFIED", evidence: describeError(error) });
    return record({ test, status: "ERROR", notes: `worker unavailable: ${describeError(error)}` });
  }
  setCapability("syncAccessHandle", { api: capabilities.createSyncAccessHandle });
  if (!capabilities.createSyncAccessHandle) return record({ test, status: "INFO", notes: "createSyncAccessHandle() is not available in a worker" });

  const directory = await spikeDirectory();
  const half = 64 * MiB;
  const total = 128 * MiB;
  const admission = admitWrite({ bytes: total, estimate: await realEstimate() });
  if (!admission.ok) return record({ test, status: "REFUSED", requestedBytes: total, notes: `${admission.code}: ${admission.reason}` });
  const name = makeEntryName("sync", total, randomHex32());
  const seed = randomSeed();
  const context = beginTest(test, name);
  const result = { test, requestedBytes: total, blockBytes: 1 * MiB, name, seed };
  let holding = false;
  try {
    setOperation("worker: writing first half and holding the handle");
    const writeStartedAt = performance.now();
    result.first = await workerCall("write", {
      name,
      start: 0,
      end: half,
      blockBytes: 1 * MiB,
      seed,
      flushEveryBytes: 16 * MiB,
      hold: true,
      readBackRanges: verificationRanges(half, RANGE_BYTES),
    });
    holding = true;
    const handle = await directory.getFileHandle(name);
    try {
      const whileHeld = await verifyRanges(handle, verificationRanges(half, RANGE_BYTES), seed);
      result.mainThreadReadWhileHeld = { ok: whileHeld.ok, fileBytes: whileHeld.fileBytes, bytesRead: whileHeld.bytesRead, ranges: whileHeld.results.length };
    } catch (error) {
      result.mainThreadReadWhileHeld = { ok: false, error: describeError(error) };
    }
    try {
      const writable = await handle.createWritable({ keepExistingData: true });
      await writable.abort();
      result.mainThreadWritableWhileHeld = { opened: true };
    } catch (error) {
      result.mainThreadWritableWhileHeld = { opened: false, error: describeError(error) };
    }
    result.secondSyncHandleWhileHeld = await workerCall("probeSecondHandle", { name });
    result.release = await workerCall("release");
    holding = false;

    setOperation("worker: resuming second half in place");
    result.second = await workerCall("write", { name, start: half, end: total, blockBytes: 1 * MiB, seed, flushEveryBytes: 16 * MiB, hold: false });
    result.writeMs = performance.now() - writeStartedAt;
    result.bytesWritten = result.first.bytesWritten + result.second.bytesWritten;
    addSessionBytes({ written: result.bytesWritten });

    setOperation("main thread: verifying");
    result.boundary = await verifyRanges(handle, boundaryRanges(half, total), seed);
    result.ranges = await verifyRanges(handle, verificationRanges(total, RANGE_BYTES), seed);
    result.sequential = await verifySequential(handle, {
      seed,
      expectedBytes: total,
      blockBytes: VERIFY_BLOCK_BYTES,
      onProgress: (done) => setProgress("read-progress", done, total),
    });
    addSessionBytes({ read: result.boundary.bytesRead + result.ranges.bytesRead + result.sequential.bytesRead });
  } catch (error) {
    result.error = describeError(error);
  }
  if (holding) await workerCall("release").catch(() => {});
  result.cleanup = await cleanupEntry(directory, name);
  Object.assign(result, finishTest(context));
  const readBackOk = result.first?.readBack?.every((range) => range.ok);
  const ok = !result.error && readBackOk && result.mainThreadReadWhileHeld?.ok && result.boundary?.ok && result.ranges?.ok && result.sequential?.ok && result.cleanup.absent;
  result.status = result.error ? "ERROR" : ok ? "PASS" : "FAIL";
  result.verifySummary = result.error ? "—" : `in-handle read-back ${readBackOk}, boundary ${result.boundary.ok}, ${summarizeVerify(result.ranges, result.sequential)}`;
  result.notes =
    result.error ??
    `while held: main-thread getFile ranges ${result.mainThreadReadWhileHeld.ok ? `verified (${result.mainThreadReadWhileHeld.ranges} ranges, file ${formatBytes(result.mainThreadReadWhileHeld.fileBytes)})` : result.mainThreadReadWhileHeld.error ?? "FAILED"}; main createWritable ${result.mainThreadWritableWhileHeld.opened ? "opened" : result.mainThreadWritableWhileHeld.error}; second sync handle ${result.secondSyncHandleWhileHeld.opened ? "opened" : result.secondSyncHandleWhileHeld.error}`;
  if (ok) setCapability("syncAccessHandle", { verified: "BEHAVIOR VERIFIED", evidence: `128 MiB in-place write + resume at 64 MiB verified` });
  setOperation("idle");
  return record(result);
}

// Supplementary negative control: a single flipped stored byte must be detected at its offset.
async function runCorruptionControl() {
  const test = "ST-S3 corruption negative control";
  const directory = await spikeDirectory();
  const bytes = 1 * MiB;
  const corruptAt = 500_001;
  const name = makeEntryName("probe", bytes, randomHex32());
  const seed = randomSeed();
  const context = beginTest(test, name);
  const result = { test, requestedBytes: bytes, blockBytes: 64 * KiB, name, corruptAt };
  try {
    const handle = await directory.getFileHandle(name, { create: true });
    await writePatternRange(handle, { end: bytes, blockBytes: 64 * KiB, seed });
    const original = new Uint8Array(await (await handle.getFile()).slice(corruptAt, corruptAt + 1).arrayBuffer())[0];
    const writable = await handle.createWritable({ keepExistingData: true });
    await writable.write({ type: "write", position: corruptAt, data: new Uint8Array([original ^ 0xff]) });
    await writable.close();
    result.bytesWritten = bytes + 1;
    result.ranges = await verifyRanges(handle, [{ label: "covers-corruption", offset: corruptAt - 1000, length: 4096 }], seed);
    result.sequential = await verifySequential(handle, { seed, expectedBytes: bytes, blockBytes: 64 * KiB });
  } catch (error) {
    result.error = describeError(error);
  }
  result.cleanup = await cleanupEntry(directory, name);
  Object.assign(result, finishTest(context));
  const expected = `mismatch at absolute byte ${corruptAt}`;
  const detected = result.ranges?.results[0]?.detail === expected && result.sequential?.detail === expected;
  result.status = result.error ? "ERROR" : detected ? "PASS" : "FAIL";
  result.verifySummary = detected ? "corruption detected by range and full checks" : "corruption NOT detected";
  result.notes = result.error ?? `range: ${result.ranges.results[0].detail}; full: ${result.sequential.detail}`;
  return record(result);
}

// ST-11: refusal paths. Simulated estimates avoid ever filling real storage.
async function runHeadroomRefusalTests() {
  const directory = await spikeDirectory();
  const before = (await listEntries(directory)).entries.length;
  const outcomes = [];
  for (const source of ["simulated-low", "simulated-none"]) {
    const refused = await runWriteTest({ test: `ST-11 refusal (${source})`, bytes: 256 * MiB, blockBytes: 1 * MiB, headroomSource: source });
    outcomes.push(refused.status === "REFUSED");
  }
  const oversize = admitWrite({ bytes: 2 * GiB, estimate: await realEstimate() });
  outcomes.push(!oversize.ok);
  record({ test: "ST-11 refusal (2 GiB request > spike cap)", status: oversize.ok ? "FAIL" : "REFUSED", requestedBytes: 2 * GiB, admission: oversize, notes: `${oversize.code}: ${oversize.reason}` });
  const after = (await listEntries(directory)).entries.length;
  return record({
    test: "ST-11 summary",
    status: outcomes.every(Boolean) && after === before ? "PASS" : "FAIL",
    notes: `${outcomes.filter(Boolean).length}/${outcomes.length} oversize/insufficient requests refused; entries before ${before}, after ${after} (no file created)`,
  });
}

// ST-10: create a data file and its metadata, delete both, confirm absence, then clear the directory.
async function runDeletionTest() {
  const test = "ST-10 explicit deletion";
  const directory = await spikeDirectory();
  const name = makeEntryName("st", 1 * MiB, randomHex32());
  const seed = randomSeed();
  const handle = await directory.getFileHandle(name, { create: true });
  await writePatternRange(handle, { end: 1 * MiB, blockBytes: 1 * MiB, seed });
  await writeText(directory, metadataNameFor(name), buildMetadata({ name, seed, totalBytes: 1 * MiB, blockBytes: 1 * MiB, createdAt: new Date().toISOString() }));
  const presentBefore = (await exists(directory, name)) && (await exists(directory, metadataNameFor(name)));
  const cleanup = await cleanupEntry(directory, name, true);
  let refusedForeign = false;
  try {
    await deleteEntry(directory, "../not-a-spike-entry");
  } catch (error) {
    refusedForeign = error instanceof RangeError;
  }
  return record({
    test,
    status: presentBefore && cleanup.absent && refusedForeign ? "PASS" : "FAIL",
    requestedBytes: 1 * MiB,
    bytesWritten: 1 * MiB,
    presentBefore,
    cleanup,
    refusedForeign,
    notes: `present before ${presentBefore}; data + metadata absent after delete ${cleanup.absent}; non-spike name refused ${refusedForeign}`,
  });
}

async function clearStorage(test = "Clear Spike Storage") {
  if (!state.root && typeof navigator.storage?.getDirectory === "function") state.root = await navigator.storage.getDirectory();
  if (!state.root) return record({ test, status: "ERROR", notes: "OPFS unavailable" });
  if (state.worker) await workerCall("release").catch(() => {});
  const usageBefore = (await realEstimate())?.usage;
  const cleared = await clearSpikeStorage(state.root);
  state.directory = null;
  const usageAfter = (await realEstimate())?.usage;
  output.cleanup.textContent = cleared.absent ? "spike directory removed; absence confirmed" : "spike directory NOT confirmed absent";
  await refreshEntries();
  await refreshEstimate();
  return record({
    test,
    status: cleared.absent ? "PASS" : "FAIL",
    cleared,
    usageBefore,
    usageAfter,
    usageDeltaBytes: Number.isFinite(usageBefore) && Number.isFinite(usageAfter) ? usageAfter - usageBefore : null,
    notes: `directory removed ${cleared.removed}; absent ${cleared.absent}; OPFS root entries now [${cleared.rootNames.map(displayName).join(", ")}]`,
  });
}

// ST-07 part 1: write a known entry plus schema-checked metadata and keep it for a reload.
async function writePersistenceEntry() {
  const bytes = 64 * MiB;
  const blockBytes = 1 * MiB;
  const directory = await spikeDirectory();
  const result = await runWriteTest({ test: "ST-07 write persistence entry", kind: "persist", bytes, blockBytes, keep: true });
  if (result.status === "PASS") {
    await writeText(directory, metadataNameFor(result.name), buildMetadata({ name: result.name, seed: result.seed, totalBytes: bytes, blockBytes, createdAt: new Date().toISOString() }));
    log(`persistence entry ${displayName(result.name)} and metadata stored; reload the page, then verify stored entries`);
  }
  await refreshEntries();
  return result;
}

// ST-07 part 2: after a reload, locate entries through metadata and verify them.
async function verifyStoredEntries() {
  const test = "ST-07 verify after reload";
  const navigationType = performance.getEntriesByType("navigation")[0]?.type ?? "unknown";
  const directory = await spikeDirectory();
  const { entries } = await listEntries(directory);
  const metadataFiles = entries.filter((entry) => entry.kind === "file" && isSpikeMetadataName(entry.name));
  if (metadataFiles.length === 0) return record({ test, status: "FAIL", navigationType, notes: "no stored metadata entries were found" });
  const context = beginTest(test, null);
  const verified = [];
  for (const entry of metadataFiles) {
    const parsed = parseMetadata(await readBoundedText(directory, entry.name));
    if (!parsed.ok) {
      verified.push({ metadata: entry.name, ok: false, detail: parsed.error });
      continue;
    }
    const { metadata } = parsed;
    output["current-file"].textContent = displayName(metadata.name);
    try {
      const handle = await directory.getFileHandle(metadata.name);
      const ranges = await verifyRanges(handle, verificationRanges(metadata.totalBytes, RANGE_BYTES), metadata.seed);
      const sequential = await verifySequential(handle, {
        seed: metadata.seed,
        expectedBytes: metadata.totalBytes,
        blockBytes: VERIFY_BLOCK_BYTES,
        onProgress: (done) => setProgress("read-progress", done, metadata.totalBytes),
      });
      addSessionBytes({ read: ranges.bytesRead + sequential.bytesRead });
      verified.push({ name: metadata.name, createdAt: metadata.createdAt, totalBytes: metadata.totalBytes, fileBytes: ranges.fileBytes, ok: ranges.ok && sequential.ok, ranges, sequential });
    } catch (error) {
      verified.push({ name: metadata.name, ok: false, detail: describeError(error) });
    }
  }
  const ok = verified.every((entry) => entry.ok);
  const reloaded = navigationType === "reload";
  if (ok && reloaded) setCapability("reload", { api: "n/a", verified: "BEHAVIOR VERIFIED", evidence: `${verified.length} entr${verified.length === 1 ? "y" : "ies"} verified after navigation type "reload"` });
  output.integrity.textContent = ok ? "PASS — stored entries verified" : "FAIL — see results";
  return record({
    test,
    status: ok && reloaded ? "PASS" : ok ? "INFO" : "FAIL",
    navigationType,
    verified,
    ...finishTest(context),
    verifySummary: verified.map((entry) => (entry.ok ? summarizeVerify(entry.ranges, entry.sequential) : "FAIL")).join("; "),
    notes: `navigation type "${navigationType}"; ${verified.filter((entry) => entry.ok).length}/${verified.length} stored entries verified${reloaded ? "" : " (not a reload: evidence does not count for ST-07)"}`,
  });
}

// ST-01 / ST-08 / ST-09 baseline plus the capability table.
async function detectCapabilities() {
  const storage = navigator.storage;
  setCapability("secureContext", { api: window.isSecureContext, verified: window.isSecureContext ? "BEHAVIOR VERIFIED" : "NOT VERIFIED", evidence: location.origin });
  setCapability("storageManager", { api: typeof storage === "object" && storage !== null });
  setCapability("estimate", { api: typeof storage?.estimate === "function" });
  setCapability("opfs", { api: typeof storage?.getDirectory === "function" });
  setCapability("createWritable", { api: typeof globalThis.FileSystemFileHandle?.prototype?.createWritable === "function" });
  setCapability("seek", { api: typeof globalThis.FileSystemWritableFileStream?.prototype?.seek === "function" });
  setCapability("randomRead", { api: typeof Blob.prototype.slice === "function" && typeof Blob.prototype.arrayBuffer === "function" });
  setCapability("removeEntry", { api: typeof globalThis.FileSystemDirectoryHandle?.prototype?.removeEntry === "function" });
  setCapability("persisted", { api: typeof storage?.persisted === "function" });
  setCapability("persist", { api: typeof storage?.persist === "function" });
  setCapability("syncAccessHandle", { api: "checked in worker" });
  setCapability("reload", { api: "n/a" });
  output["user-agent"].textContent = navigator.userAgent;
  output["navigation-type"].textContent = performance.getEntriesByType("navigation")[0]?.type ?? "unknown";

  if (typeof storage?.estimate === "function") {
    const estimate = await refreshEstimate();
    const usable = Number.isFinite(estimate?.quota) && Number.isFinite(estimate?.usage);
    setCapability("estimate", { verified: usable ? "BEHAVIOR VERIFIED" : "NOT VERIFIED", evidence: usable ? `quota ${formatBytes(estimate.quota)}, usage ${formatBytes(estimate.usage)}` : "no numeric quota/usage" });
    setCapability("storageManager", { verified: usable ? "BEHAVIOR VERIFIED" : "NOT VERIFIED", evidence: "estimate() returned numeric values" });
  }
  if (typeof storage?.persisted === "function") {
    const persisted = await storage.persisted();
    setCapability("persisted", { verified: "BEHAVIOR VERIFIED", evidence: `persisted() → ${persisted}` });
  }
  if (typeof storage?.getDirectory === "function") {
    try {
      await spikeDirectory();
      setCapability("opfs", { verified: "BEHAVIOR VERIFIED", evidence: `root + "${state.directory.name}" directory opened` });
    } catch (error) {
      setCapability("opfs", { verified: "NOT VERIFIED", evidence: describeError(error) });
    }
  }
}

async function runMatrix() {
  const include1GiB = $("include-1gib").checked;
  await detectCapabilities();
  const estimate = await realEstimate();
  record({
    test: "ST-01 OPFS availability",
    status: state.capabilities.opfs?.verified === "BEHAVIOR VERIFIED" ? "PASS" : "FAIL",
    notes: `getDirectory ${state.capabilities.opfs?.api}; createWritable ${state.capabilities.createWritable?.api}; seek ${state.capabilities.seek?.api}; ${state.capabilities.opfs?.evidence}`,
  });
  record({
    test: "ST-08 quota reporting (start)",
    status: Number.isFinite(estimate?.quota) ? "PASS" : "FAIL",
    estimate,
    notes: estimate ? `quota ${formatBytes(estimate.quota)}; usage ${formatBytes(estimate.usage)}; headroom ${formatBytes(headroomFromEstimate(estimate))}; usageDetails ${JSON.stringify(estimate.usageDetails ?? null)}` : "estimate() unavailable",
  });
  const persisted = await navigator.storage.persisted?.();
  record({ test: "ST-09 persisted() baseline", status: "INFO", persisted, notes: `persisted() → ${persisted} (no request made by the matrix)` });

  const steps = [
    () => runWriteTest({ test: "ST-02 small write", bytes: 1 * MiB, blockBytes: 1 * MiB }),
    () => runWriteTest({ test: "ST-03 medium write", bytes: 64 * MiB, blockBytes: 64 * KiB }),
    () => runWriteTest({ test: "ST-03 medium write", bytes: 64 * MiB, blockBytes: 1 * MiB }),
    () => runWriteTest({ test: "ST-03 medium write", bytes: 64 * MiB, blockBytes: 4 * MiB }),
    () => runWriteTest({ test: "ST-04/05 large write + ranges", bytes: 256 * MiB, blockBytes: 1 * MiB, probe: resumeOpenProbe() }),
    () => runWriteTest({ test: "ST-04/05 large write + ranges", bytes: 512 * MiB, blockBytes: 1 * MiB, probe: resumeOpenProbe() }),
    ...(include1GiB ? [() => runWriteTest({ test: "ST-04 optional 1 GiB write", bytes: 1 * GiB, blockBytes: 1 * MiB, probe: resumeOpenProbe() })] : []),
    () => runResumeTest({ test: "ST-06 resume (aligned)", totalBytes: 128 * MiB, boundaryBytes: 64 * MiB, blockBytes: 1 * MiB }),
    () => runResumeTest({ test: "ST-06 resume (unaligned)", totalBytes: 32 * MiB, boundaryBytes: 16 * MiB + 4099, blockBytes: 64 * KiB }),
    runCommitSemanticsTest,
    runSyncAccessTest,
    runCorruptionControl,
    runHeadroomRefusalTests,
    runDeletionTest,
  ];
  for (const step of steps) {
    if (state.controller?.signal.aborted) break;
    setStatus(`Lab matrix running (${state.results.length} results so far)…`);
    await step();
    await refreshEntries();
  }
  const final = await clearStorage("Matrix final cleanup");
  const end = await realEstimate();
  record({
    test: "ST-08 quota reporting (end)",
    status: Number.isFinite(end?.quota) ? "PASS" : "FAIL",
    estimate: end,
    usageDeltaBytes: Number.isFinite(end?.usage) && Number.isFinite(estimate?.usage) ? end.usage - estimate.usage : null,
    notes: end ? `usage ${formatBytes(end.usage)} (start ${formatBytes(estimate?.usage)}); final cleanup ${final.status}` : "estimate() unavailable",
  });
}

// ---------------------------------------------------------------------------------------------
// Entries table and wiring

async function refreshEntries() {
  const body = output["entries-body"];
  if (typeof navigator.storage?.getDirectory !== "function") {
    body.replaceChildren();
    return;
  }
  let listing;
  try {
    const root = (state.root ??= await navigator.storage.getDirectory());
    const directory = await root.getDirectoryHandle(SPIKE_DIRECTORY).catch((error) => {
      if (error?.name === "NotFoundError") return null;
      throw error;
    });
    listing = directory ? await listEntries(directory) : { entries: [], truncated: false };
  } catch (error) {
    log(`entry listing failed: ${describeError(error)}`);
    return;
  }
  const rows = listing.entries.map((entry) => {
    const row = document.createElement("tr");
    for (const text of [displayName(entry.name), entry.kind, Number.isFinite(entry.bytes) ? formatBytes(entry.bytes) : entry.error ?? "—", String(entry.recognized)]) {
      const cell = document.createElement("td");
      cell.textContent = text;
      row.append(cell);
    }
    const action = document.createElement("td");
    if (entry.recognized) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Delete";
      button.dataset.name = entry.name;
      button.disabled = state.busy;
      action.append(button);
    }
    row.append(action);
    return row;
  });
  if (listing.entries.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = "No spike entries stored.";
    row.append(cell);
    rows.push(row);
  }
  body.replaceChildren(...rows);
}

function guarded(label, action) {
  return async () => {
    if (state.busy) return;
    setBusy(true);
    state.controller = new AbortController();
    setStatus(`${label}…`);
    try {
      await action();
      setStatus(`${label} finished.`, "success");
    } catch (error) {
      setStatus(`${label} stopped: ${describeError(error)}`, "error");
      log(`${label} error: ${describeError(error)}`);
    } finally {
      state.controller = null;
      setOperation("idle");
      setBusy(false);
      await refreshEntries().catch(() => {});
      await refreshEstimate().catch(() => {});
    }
  };
}

function selectedNumber(id) {
  return Number.parseInt($(id).value, 10);
}

$("refresh-estimate").addEventListener("click", () => refreshEstimate().catch((error) => log(describeError(error))));
$("request-persist").addEventListener("click", guarded("Persistence request", requestPersistence));
$("run-single").addEventListener(
  "click",
  guarded("Write + verify test", async () => {
    const bytes = selectedNumber("test-size");
    const blockBytes = selectedNumber("block-size");
    if (!validateBlockBytes(blockBytes).ok) throw new RangeError("block size is out of bounds");
    await runWriteTest({ test: "Single write test", bytes, blockBytes, headroomSource: $("headroom-source").value });
  }),
);
$("run-matrix").addEventListener("click", guarded("Lab matrix", runMatrix));
$("write-persist").addEventListener("click", guarded("Write persistence entry", writePersistenceEntry));
$("verify-stored").addEventListener("click", guarded("Verify stored entries", verifyStoredEntries));
$("clear").addEventListener("click", guarded("Clear Spike Storage", () => clearStorage()));
$("refresh-entries").addEventListener("click", () => refreshEntries());
$("abort").addEventListener("click", () => {
  state.controller?.abort();
  log("abort requested");
});
output["entries-body"].addEventListener("click", (event) => {
  const button = event.target.closest("button[data-name]");
  if (!button) return;
  const name = button.dataset.name;
  if (!isSpikeEntryName(name) && !isSpikeMetadataName(name)) return;
  guarded("Delete entry", async () => {
    const result = await deleteEntry(await spikeDirectory(), name);
    record({ test: "Manual delete", status: result.absent ? "PASS" : "FAIL", notes: `${displayName(name)} absent ${result.absent}` });
  })();
});
window.addEventListener("pagehide", () => {
  state.controller?.abort();
  state.worker?.terminate();
});

renderCapabilities();
detectCapabilities()
  .then(() => refreshEntries())
  .then(() => setStatus(`Ready. Spike bounds: ${formatBytes(LIMITS.minTestBytes)}–${formatBytes(LIMITS.maxTestBytes)} per test; admission needs ${HEADROOM_POLICY.overheadFactor}× request + ${formatBytes(HEADROOM_POLICY.reserveBytes)} headroom.`))
  .catch((error) => setStatus(`Capability detection failed: ${describeError(error)}`, "error"));
