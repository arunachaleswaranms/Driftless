// Reuses the unit-tested selected-pair lookup from Spike 0.2 rather than duplicating it.
import {
  chooseSelectedPair,
  classifyCandidatePath,
  formatRtt,
} from "../../spike-02-webrtc-connectivity/src/diagnostics.mjs";
import { FAULT_MODES, KiB, LIMITS, MiB, mixWord, parseControlMessage, planTransfer } from "./framing.mjs";
import { formatBytes, formatDuration, formatLabThroughput, throughputMiBps } from "./metrics.mjs";
import { TransferReceiver } from "./receiver.mjs";
import { activeBackpressureWaiters, createSenderStats, runSender } from "./sender.mjs";

const STUN_URL = "stun:stun.l.google.com:19302";
const SIGNAL_PREFIX = "driftless-spike-03";
const CHANNEL_LABEL = "binary-lab";
const ACCEPT_TIMEOUT_MS = 5000;
const RESULT_TIMEOUT_MS = 30000;
const ROOM_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

const sha256 = (data) => crypto.subtle.digest("SHA-256", data);

const labRun = (test, totalMiB, chunkKiB, extra = {}) => ({
  test,
  totalBytes: totalMiB * MiB,
  chunkSize: chunkKiB * KiB,
  highWaterBytes: MiB,
  lowWaterBytes: 256 * KiB,
  faultMode: "none",
  ...extra,
});
const CHUNK_KIB = [16, 64, 128, 256];
const MATRIX = [
  ...CHUNK_KIB.map((chunk) => labRun("BT-01 / BT-04", 1, chunk)),
  ...CHUNK_KIB.map((chunk) => labRun("BT-02 / BT-04", 16, chunk)),
  ...CHUNK_KIB.map((chunk) => labRun("BT-03 / BT-04", 64, chunk)),
  ...CHUNK_KIB.map((chunk) => labRun("BT-03 / BT-04", 128, chunk)),
  labRun("BT-05", 64, 64, { highWaterBytes: 256 * KiB, lowWaterBytes: 64 * KiB }),
  labRun("BT-05", 64, 64, { highWaterBytes: 4 * MiB, lowWaterBytes: MiB }),
  ...FAULT_MODES.filter((mode) => mode !== "none").map((faultMode) =>
    labRun("BT-06", 16, 64, { faultMode }),
  ),
];

const $ = (selector) => document.querySelector(selector);
const controls = {
  role: $("#role"),
  room: $("#room"),
  start: $("#start"),
  refresh: $("#refresh"),
  close: $("#close"),
  totalBytes: $("#total-bytes"),
  chunkSize: $("#chunk-size"),
  waterMarks: $("#water-marks"),
  faultMode: $("#fault-mode"),
  send: $("#send"),
  matrix: $("#matrix"),
  abort: $("#abort"),
};
const output = Object.fromEntries(
  [
    "status", "user-agent", "active-role", "connection-state", "channel-state", "max-message-size",
    "transfer-state", "total", "chunks", "bytes-sent", "bytes-received", "buffered-amount",
    "max-buffered", "water", "pauses", "start-end", "elapsed", "throughput", "integrity", "heap",
    "selected-pair", "path-classification", "protocol", "rtt", "channel-stats", "res-peer",
    "res-channel", "res-signal", "res-timers", "res-waiters", "res-control", "res-transfer",
    "res-verifications", "res-rejected", "results-body", "results-json", "event-log",
  ].map((id) => [id, $(`#${id}`)]),
);

let peer = null;
let dataChannel = null;
let signalChannel = null;
let role = null;
let closed = true;
let offerStarted = false;
let receiver = null;
let activeTransfer = null;
let matrixRunning = false;
let matrixStopRequested = false;
let transferCounter = 0;
let rejectedMessages = 0;
let lastPath = null;
const pendingCandidates = [];
const timers = new Set();
const controlWaiters = new Map();
const results = [];

function startInterval(callback, ms) {
  const id = window.setInterval(callback, ms);
  timers.add(id);
  return id;
}

function startTimeout(callback, ms) {
  const id = window.setTimeout(() => {
    timers.delete(id);
    callback();
  }, ms);
  timers.add(id);
  return id;
}

function stopTimer(id) {
  window.clearInterval(id);
  window.clearTimeout(id);
  timers.delete(id);
}

function heapBytes() {
  return performance.memory?.usedJSHeapSize ?? null;
}

function setStatus(message, kind = "info") {
  output.status.textContent = message;
  output.status.dataset.kind = kind;
}

function logEvent(message) {
  const entry = document.createElement("li");
  entry.textContent = `${new Date().toISOString()} — ${message}`;
  output["event-log"].prepend(entry);
  while (output["event-log"].children.length > 60) output["event-log"].lastElementChild?.remove();
}

function rejectMessage(reason) {
  rejectedMessages += 1;
  logEvent(`Rejected message: ${reason}`);
}

function sendControl(message) {
  if (dataChannel?.readyState !== "open") throw new Error("data channel is not open");
  dataChannel.send(JSON.stringify(message));
}

function waitForControl(types, transferId, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const key = String(transferId);
    let timer = null;
    const finish = (callback, value) => {
      stopTimer(timer);
      controlWaiters.delete(key);
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, signal.reason ?? new Error("transfer aborted"));
    timer = startTimeout(
      () => finish(reject, new Error(`timed out waiting for ${types.join("/")}`)),
      timeoutMs,
    );
    signal.addEventListener("abort", onAbort);
    controlWaiters.set(key, {
      types,
      resolve: (message) => finish(resolve, message),
      reject: (error) => finish(reject, error),
    });
  });
}

// ---------- Diagnostics rendering ----------

function renderSenderView() {
  const current = activeTransfer ?? results.at(-1);
  if (!current) return;
  const { plan, stats, config } = current;
  output["transfer-state"].textContent = activeTransfer ? `sending (transfer ${current.transferId})` : current.status;
  if (plan) {
    output.total.textContent = formatBytes(plan.totalBytes);
    output.chunks.textContent = `${formatBytes(plan.chunkSize)} / ${plan.totalChunks} chunks (frame ${plan.frameBytes} B)`;
  } else {
    output.total.textContent = formatBytes(config.totalBytes);
    output.chunks.textContent = `${formatBytes(config.chunkSize)} / not planned`;
  }
  output["bytes-sent"].textContent = stats ? formatBytes(stats.bytesSent) : "—";
  output["bytes-received"].textContent = current.receiver
    ? `${formatBytes(current.receiver.bytesReceived)} (receiver-reported)`
    : "awaiting receiver result";
  output["max-buffered"].textContent = stats ? formatBytes(stats.maxBufferedAmount) : "—";
  output.water.textContent = `${formatBytes(config.highWaterBytes)} / ${formatBytes(config.lowWaterBytes)}`;
  output.pauses.textContent = stats
    ? `${stats.backpressurePauses} / ${stats.backpressureResumes} (paused ${formatDuration(stats.pausedMs)})`
    : "—";
  output["start-end"].textContent = `${current.startedAt ?? "—"} → ${current.endedAt ?? "—"}`;
  const elapsed = current.elapsedMs ?? (current.startedMark ? performance.now() - current.startedMark : null);
  output.elapsed.textContent = formatDuration(elapsed);
  output.throughput.textContent = formatLabThroughput(stats?.bytesSent, elapsed);
  output.integrity.textContent = describeIntegrity(current);
  output.integrity.dataset.kind = current.integrityOk === true ? "success" : current.integrityOk === false ? "error" : "";
}

function renderReceiverView() {
  const transfer = receiver?.transfer;
  output["transfer-state"].textContent = receiver ? receiver.state : "idle";
  if (!transfer) return;
  const { plan, result } = transfer;
  output.total.textContent = formatBytes(plan.totalBytes);
  output.chunks.textContent = `${formatBytes(plan.chunkSize)} / ${transfer.chunksReceived} of ${plan.totalChunks} chunks received`;
  output["bytes-sent"].textContent = "— (receiver)";
  output["bytes-received"].textContent = `${formatBytes(transfer.bytesReceived)} of ${formatBytes(plan.totalBytes)}`;
  output["max-buffered"].textContent = `receiver max pending verification: ${formatBytes(transfer.maxPendingBytes)}`;
  const receiveMs = transfer.firstChunkAt === null ? null : transfer.lastChunkAt - transfer.firstChunkAt;
  output.elapsed.textContent = `${formatDuration(receiveMs)} (first → last chunk)`;
  output.throughput.textContent = formatLabThroughput(transfer.bytesReceived, receiveMs);
  output.integrity.textContent = result
    ? `${result.ok ? "PASS" : "FAIL"}${result.reasons.length ? ` — ${result.reasons.join("; ")}` : ""}`
    : transfer.abortReason
      ? `aborted — ${transfer.abortReason}`
      : "pending";
  output.integrity.dataset.kind = result?.ok ? "success" : result ? "error" : "";
}

function describeIntegrity(row) {
  if (row.status === "rejected-before-send") return `not run — ${row.error}`;
  if (row.integrityOk === undefined) return row.error ? `not verified — ${row.error}` : "pending";
  const verdict = row.integrityOk ? "PASS" : "FAIL";
  const reasons = row.receiver?.reasons?.length ? ` — ${row.receiver.reasons.join("; ")}` : "";
  return `${verdict}${reasons}`;
}

function renderResources() {
  output["res-peer"].textContent = peer ? peer.connectionState : "released";
  output["res-channel"].textContent = dataChannel ? dataChannel.readyState : "released";
  output["res-signal"].textContent = signalChannel ? "open" : "released";
  output["res-timers"].textContent = String(timers.size);
  output["res-waiters"].textContent = String(activeBackpressureWaiters());
  output["res-control"].textContent = String(controlWaiters.size);
  output["res-transfer"].textContent = activeTransfer ? `transfer ${activeTransfer.transferId}` : "none";
  output["res-verifications"].textContent = String(receiver?.pendingVerifications ?? 0);
  output["res-rejected"].textContent = String(rejectedMessages + (receiver?.rejectedOutsideTransfer ?? 0));
}

function render() {
  output["connection-state"].textContent = peer?.connectionState ?? "closed";
  output["channel-state"].textContent = dataChannel?.readyState ?? "not created";
  output["max-message-size"].textContent = peer?.sctp ? `${peer.sctp.maxMessageSize} bytes` : "Unavailable";
  output["buffered-amount"].textContent = dataChannel ? formatBytes(dataChannel.bufferedAmount) : "—";
  const heap = heapBytes();
  output.heap.textContent = heap === null ? "Unavailable" : formatBytes(heap);
  if (activeTransfer && heap !== null) activeTransfer.heapMaxBytes = Math.max(activeTransfer.heapMaxBytes ?? 0, heap);
  if (role === "initiator") renderSenderView();
  if (role === "responder") renderReceiverView();
  const open = dataChannel?.readyState === "open";
  controls.send.disabled = role !== "initiator" || !open || Boolean(activeTransfer) || matrixRunning;
  controls.matrix.disabled = controls.send.disabled;
  controls.abort.disabled = !activeTransfer && !matrixRunning;
  renderResources();
}

async function refreshStats() {
  render();
  if (!peer || peer.connectionState === "closed") return lastPath;
  try {
    const report = await peer.getStats();
    const selected = chooseSelectedPair(report);
    const channelStats = Array.from(report.values()).find((entry) => entry.type === "data-channel");
    lastPath = {
      selectedPairState: selected?.pair.state ?? null,
      localCandidateType: selected?.local?.candidateType ?? null,
      remoteCandidateType: selected?.remote?.candidateType ?? null,
      protocol: selected?.local?.protocol ?? selected?.remote?.protocol ?? null,
      currentRoundTripTime: selected?.pair.currentRoundTripTime ?? null,
      classification: selected
        ? classifyCandidatePath(selected.local?.candidateType, selected.remote?.candidateType)
        : "unavailable (no selected candidate pair reported)",
      dataChannel: channelStats
        ? {
            messagesSent: channelStats.messagesSent,
            bytesSent: channelStats.bytesSent,
            messagesReceived: channelStats.messagesReceived,
            bytesReceived: channelStats.bytesReceived,
          }
        : null,
    };
    output["selected-pair"].textContent = selected
      ? `reported (${lastPath.selectedPairState ?? "state unavailable"}) ${lastPath.localCandidateType ?? "?"} → ${lastPath.remoteCandidateType ?? "?"}`
      : "Unavailable";
    output["path-classification"].textContent = lastPath.classification;
    output.protocol.textContent = lastPath.protocol ?? "Unavailable";
    output.rtt.textContent = formatRtt(lastPath.currentRoundTripTime);
    output["channel-stats"].textContent = lastPath.dataChannel
      ? `sent ${lastPath.dataChannel.messagesSent} / ${formatBytes(lastPath.dataChannel.bytesSent)}; received ${lastPath.dataChannel.messagesReceived} / ${formatBytes(lastPath.dataChannel.bytesReceived)}`
      : "Unavailable";
  } catch (error) {
    output["selected-pair"].textContent = `Unavailable (${error.name || "getStats error"})`;
  }
  return lastPath;
}

function publicRow(row) {
  const { controller, startedMark, ...rest } = row;
  return rest;
}

function recordResult(row) {
  results.push(row);
  const cells = [
    row.run,
    row.test,
    formatBytes(row.config.totalBytes),
    formatBytes(row.config.chunkSize),
    `${formatBytes(row.config.highWaterBytes)} / ${formatBytes(row.config.lowWaterBytes)}`,
    row.config.faultMode,
    row.status,
    formatDuration(row.elapsedMs),
    row.throughputMiBps === null || row.throughputMiBps === undefined ? "—" : `${row.throughputMiBps.toFixed(1)} MiB/s`,
    row.stats ? formatBytes(row.stats.maxBufferedAmount) : "—",
    row.stats ? `${row.stats.backpressurePauses}/${row.stats.backpressureResumes}` : "—",
    describeIntegrity(row),
  ];
  const tr = document.createElement("tr");
  for (const [index, value] of cells.entries()) {
    const td = document.createElement("td");
    td.textContent = String(value);
    if (index === cells.length - 1 && row.integrityOk !== undefined) {
      td.dataset.ok = String(row.integrityOk === row.expectIntegrityOk);
    }
    tr.append(td);
  }
  output["results-body"].append(tr);
  output["results-json"].textContent = JSON.stringify(
    {
      environment: {
        userAgent: navigator.userAgent,
        hardwareConcurrency: navigator.hardwareConcurrency,
        maxMessageSize: peer?.sctp?.maxMessageSize ?? null,
        labelling: "AUTOMATED DESKTOP / same-host lab measurement; not Internet throughput",
      },
      runs: results.map(publicRow),
    },
    null,
    2,
  );
}

// ---------- Sender ----------

async function runTransfer(config, test = "manual") {
  const row = {
    run: results.length + 1,
    test,
    config: { ...config },
    status: "running",
    expectIntegrityOk: config.faultMode === "none",
    visibilityState: document.visibilityState,
    startedAt: null,
    endedAt: null,
  };
  const maxMessageSize = peer?.sctp?.maxMessageSize ?? null;
  const planned = planTransfer({ totalBytes: config.totalBytes, chunkSize: config.chunkSize, maxMessageSize });
  if (!planned.ok) {
    row.status = "rejected-before-send";
    row.error = planned.error;
    logEvent(`Run ${row.run} (${test}) not started: ${planned.error}`);
    recordResult(row);
    render();
    return row;
  }
  const { plan } = planned;
  if (config.faultMode !== "none" && plan.totalChunks < 2) {
    row.status = "rejected-before-send";
    row.error = "fault modes need at least two chunks";
    recordResult(row);
    return row;
  }

  transferCounter += 1;
  const transferId = transferCounter;
  const seed = mixWord(transferId, 0x5eed5eed);
  const controller = new AbortController();
  Object.assign(row, {
    transferId,
    plan,
    stats: createSenderStats(),
    controller,
    heapBeforeBytes: heapBytes(),
    heapMaxBytes: heapBytes(),
  });
  activeTransfer = row;
  render();

  try {
    const accepting = waitForControl(["accept", "reject"], transferId, ACCEPT_TIMEOUT_MS, controller.signal);
    sendControl({
      type: "begin",
      transferId,
      totalBytes: plan.totalBytes,
      chunkSize: plan.chunkSize,
      totalChunks: plan.totalChunks,
      seed,
      faultMode: config.faultMode,
    });
    const reply = await accepting;
    if (reply.type === "reject") throw new Error(`receiver rejected transfer: ${reply.reason}`);

    row.startedAt = new Date().toISOString();
    row.startedMark = performance.now();
    logEvent(`Run ${row.run} (${test}) started: ${formatBytes(plan.totalBytes)} in ${plan.totalChunks} × ${formatBytes(plan.chunkSize)}; mode ${config.faultMode}.`);
    const { manifestSha256 } = await runSender({
      channel: dataChannel,
      plan,
      transferId,
      seed,
      faultMode: config.faultMode,
      highWaterBytes: config.highWaterBytes,
      lowWaterBytes: config.lowWaterBytes,
      digest: sha256,
      signal: controller.signal,
      stats: row.stats,
    });
    row.lastChunkQueuedMs = performance.now() - row.startedMark;
    row.manifestSha256 = manifestSha256;

    const resulting = waitForControl(["result"], transferId, RESULT_TIMEOUT_MS, controller.signal);
    sendControl({
      type: "end",
      transferId,
      totalChunks: plan.totalChunks,
      totalBytes: plan.totalBytes,
      framesSent: row.stats.framesSent,
      manifestSha256,
    });
    const result = await resulting;
    row.elapsedMs = performance.now() - row.startedMark;
    row.endedAt = new Date().toISOString();
    row.throughputMiBps = throughputMiBps(row.stats.bytesSent, row.elapsedMs);
    row.receiver = result;
    row.integrityOk = result.ok;
    row.status = result.ok === row.expectIntegrityOk ? "completed-as-expected" : "completed-unexpected";
    logEvent(`Run ${row.run} finished: integrity ${result.ok ? "PASS" : "FAIL"} in ${formatDuration(row.elapsedMs)}.`);
  } catch (error) {
    row.status = controller.signal.aborted ? "aborted" : "error";
    row.error = error?.message ?? String(error);
    row.endedAt = new Date().toISOString();
    row.elapsedMs = row.startedMark ? performance.now() - row.startedMark : null;
    logEvent(`Run ${row.run} ${row.status}: ${row.error}`);
    if (dataChannel?.readyState === "open") {
      try {
        sendControl({ type: "abort", transferId, reason: row.error.slice(0, LIMITS.maxReasonChars) });
      } catch {
        // The channel closed between the check and send; the receiver resets on channel close.
      }
    }
  } finally {
    row.heapAfterBytes = heapBytes();
    row.path = await refreshStats();
    row.stats = { ...row.stats };
    activeTransfer = null;
    recordResult(row);
    render();
  }
  return row;
}

function selectedConfig() {
  const [highWaterBytes, lowWaterBytes] = controls.waterMarks.value.split(":").map(Number);
  return {
    totalBytes: Number(controls.totalBytes.value),
    chunkSize: Number(controls.chunkSize.value),
    highWaterBytes,
    lowWaterBytes,
    faultMode: controls.faultMode.value,
  };
}

async function runMatrix() {
  matrixRunning = true;
  matrixStopRequested = false;
  setStatus(`Running lab matrix (${MATRIX.length} runs).`);
  logEvent(`Lab matrix started with ${MATRIX.length} runs.`);
  try {
    for (const { test, ...config } of MATRIX) {
      if (matrixStopRequested || dataChannel?.readyState !== "open") break;
      await runTransfer(config, test);
    }
  } finally {
    matrixRunning = false;
    const unexpected = results.filter((row) => row.status === "completed-unexpected" || row.status === "error");
    setStatus(
      matrixStopRequested
        ? "Lab matrix stopped."
        : `Lab matrix finished: ${results.length} runs recorded, ${unexpected.length} unexpected.`,
      unexpected.length ? "error" : "success",
    );
    logEvent("Lab matrix finished.");
    render();
  }
}

function abortTransfer() {
  matrixStopRequested = true;
  activeTransfer?.controller.abort(new Error("transfer aborted by operator"));
}

// ---------- Receiver ----------

function handleReceiverControl(message) {
  switch (message.type) {
    case "begin": {
      const reply = receiver.begin(message);
      sendControl(reply);
      logEvent(
        reply.type === "accept"
          ? `Accepted transfer ${message.transferId}: ${formatBytes(message.totalBytes)} in ${message.totalChunks} chunks (mode ${message.faultMode}).`
          : `Rejected transfer ${message.transferId}: ${reply.reason}`,
      );
      break;
    }
    case "end":
      receiver
        .finish(message)
        .then((result) => {
          if (!result) return;
          if (dataChannel?.readyState === "open") sendControl(result);
          logEvent(`Transfer ${message.transferId} verified: ${result.ok ? "PASS" : "FAIL"}.`);
          render();
        })
        .catch(handleError);
      break;
    case "abort":
      receiver.abort(`sender aborted: ${message.reason}`);
      logEvent(`Transfer ${message.transferId} aborted by sender: ${message.reason}`);
      break;
    default:
      rejectMessage(`receiver does not accept '${message.type}' control messages`);
  }
}

// ---------- Channel ----------

function handleChannelMessage(event) {
  if (typeof event.data === "string") {
    const parsed = parseControlMessage(event.data);
    if (!parsed.ok) {
      rejectMessage(parsed.error);
      return;
    }
    const message = parsed.message;
    if (role === "responder") {
      handleReceiverControl(message);
      return;
    }
    const waiter = controlWaiters.get(String(message.transferId));
    if (!waiter || !waiter.types.includes(message.type)) {
      rejectMessage(`unexpected '${message.type}' for transfer ${message.transferId}`);
      return;
    }
    waiter.resolve(message);
    return;
  }

  if (role === "responder") {
    receiver.acceptFrame(event.data);
    return;
  }
  rejectMessage("sender does not accept binary frames");
}

function configureDataChannel(channel) {
  dataChannel = channel;
  channel.binaryType = "arraybuffer";
  logEvent(`RTCDataChannel '${channel.label}' configured (ordered=${channel.ordered}, binaryType=arraybuffer).`);

  channel.addEventListener("open", () => {
    setStatus(
      role === "initiator"
        ? "Connected. Choose a transfer or run the lab matrix."
        : "Connected. Waiting for the sender to begin a transfer.",
      "success",
    );
    logEvent(`RTCDataChannel opened; SCTP maxMessageSize ${peer?.sctp?.maxMessageSize ?? "unavailable"}.`);
    refreshStats();
  });
  channel.addEventListener("close", () => {
    receiver?.abort("data channel closed");
    activeTransfer?.controller.abort(new Error("data channel closed during transfer"));
    logEvent("RTCDataChannel closed.");
    render();
  });
  channel.addEventListener("error", (event) => {
    logEvent(`RTCDataChannel error: ${event.error?.message ?? "unspecified"}`);
  });
  channel.addEventListener("message", handleChannelMessage);
}

// ---------- Development signaling (adapted from Spike 0.2) ----------

function sendSignal(message) {
  signalChannel?.postMessage(message);
}

let announceTimer = null;
function stopAnnouncing() {
  stopTimer(announceTimer);
  announceTimer = null;
}

function plainDescription(description) {
  return description ? { type: description.type, sdp: description.sdp } : null;
}

async function flushPendingCandidates() {
  if (!peer?.remoteDescription) return;
  while (pendingCandidates.length > 0) await peer.addIceCandidate(pendingCandidates.shift());
}

async function createOffer() {
  if (!peer || offerStarted || role !== "initiator") return;
  offerStarted = true;
  stopAnnouncing();
  configureDataChannel(peer.createDataChannel(CHANNEL_LABEL, { ordered: true }));
  await peer.setLocalDescription(await peer.createOffer());
  sendSignal({ kind: "description", description: plainDescription(peer.localDescription) });
  logEvent("Offer created and sent through development signaling.");
}

async function handleSignal(message) {
  if (!peer || closed || !message || typeof message !== "object") return;
  if (message.kind === "hello" && role === "responder") {
    sendSignal({ kind: "ready" });
  } else if (message.kind === "ready" && role === "initiator") {
    await createOffer();
  } else if (message.kind === "description" && message.description) {
    const { description } = message;
    if (description.type === "offer" && role === "responder") {
      stopAnnouncing();
      await peer.setRemoteDescription(description);
      await flushPendingCandidates();
      await peer.setLocalDescription(await peer.createAnswer());
      sendSignal({ kind: "description", description: plainDescription(peer.localDescription) });
      logEvent("Offer accepted; answer sent through development signaling.");
    } else if (description.type === "answer" && role === "initiator") {
      await peer.setRemoteDescription(description);
      await flushPendingCandidates();
      logEvent("Answer accepted.");
    }
  } else if (message.kind === "candidate" && message.candidate) {
    if (peer.remoteDescription) await peer.addIceCandidate(message.candidate);
    else pendingCandidates.push(message.candidate);
  }
}

function handleError(error) {
  setStatus(`Experiment error: ${error.message || error}`, "error");
  logEvent(`Error: ${error.name || "Error"} — ${error.message || String(error)}`);
}

// ---------- Lifecycle ----------

function closePeer({ announce = true } = {}) {
  closed = true;
  matrixStopRequested = true;
  activeTransfer?.controller.abort(new Error("peer closed during transfer"));
  for (const waiter of [...controlWaiters.values()]) waiter.reject(new Error("peer closed"));
  for (const id of [...timers]) stopTimer(id);
  announceTimer = null;
  receiver?.abort("peer closed");
  signalChannel?.close();
  signalChannel = null;
  dataChannel?.close();
  peer?.close();
  dataChannel = null;
  peer = null;
  pendingCandidates.length = 0;
  controls.role.disabled = false;
  controls.room.disabled = false;
  controls.start.disabled = false;
  controls.refresh.disabled = true;
  controls.close.disabled = true;
  render();
  if (announce) {
    setStatus("Closed. Peer, data channel, signaling channel, timers, and waiters released.");
    logEvent("All experiment resources closed.");
  }
}

function startPeer() {
  const room = controls.room.value.trim();
  if (!ROOM_PATTERN.test(room)) {
    setStatus("Use a 1–64 character room label containing only letters, numbers, _ or -.", "error");
    return;
  }
  role = controls.role.value;
  document.body.dataset.role = role;
  closed = false;
  offerStarted = false;
  lastPath = null;
  receiver = role === "responder" ? new TransferReceiver({ digest: sha256 }) : null;
  output["active-role"].textContent = role === "initiator" ? "sender (initiator)" : "receiver (responder)";

  peer = new RTCPeerConnection({ iceServers: [{ urls: STUN_URL }] });
  signalChannel = new BroadcastChannel(`${SIGNAL_PREFIX}-${room}`);
  signalChannel.addEventListener("message", (event) => handleSignal(event.data).catch(handleError));
  peer.addEventListener("datachannel", (event) => configureDataChannel(event.channel));
  peer.addEventListener("icecandidate", (event) => {
    if (event.candidate) sendSignal({ kind: "candidate", candidate: event.candidate.toJSON() });
  });
  peer.addEventListener("connectionstatechange", () => {
    logEvent(`connectionstatechange: ${peer?.connectionState}`);
    render();
  });

  controls.role.disabled = true;
  controls.room.disabled = true;
  controls.start.disabled = true;
  controls.refresh.disabled = false;
  controls.close.disabled = false;
  setStatus(`Started as ${role}; waiting for the other local browser peer.`);
  logEvent(`RTCPeerConnection initialized as ${role}. Public STUN is non-production test configuration.`);

  const announce = () => sendSignal({ kind: role === "initiator" ? "hello" : "ready" });
  announce();
  announceTimer = startInterval(announce, 500);
  startInterval(render, 250);
  startInterval(() => {
    if (!activeTransfer) refreshStats();
  }, 2000);
  render();
}

controls.start.addEventListener("click", startPeer);
controls.refresh.addEventListener("click", () => refreshStats());
controls.close.addEventListener("click", () => closePeer());
controls.send.addEventListener("click", () => runTransfer(selectedConfig()).catch(handleError));
controls.matrix.addEventListener("click", () => runMatrix().catch(handleError));
controls.abort.addEventListener("click", abortTransfer);
window.addEventListener("pagehide", () => closePeer({ announce: false }));

const parameters = new URLSearchParams(window.location.search);
if (["initiator", "responder"].includes(parameters.get("role"))) controls.role.value = parameters.get("role");
if (ROOM_PATTERN.test(parameters.get("room") ?? "")) controls.room.value = parameters.get("room");
output["user-agent"].textContent = navigator.userAgent;
render();
