import {
  candidateTypeFrom,
  chooseSelectedPair,
  classifyCandidatePath,
  formatCandidateTypes,
  formatRtt,
} from "./diagnostics.mjs";

const STUN_URL = "stun:stun.l.google.com:19302";
const SIGNAL_PREFIX = "driftless-spike-02";

const controls = {
  role: document.querySelector("#role"),
  room: document.querySelector("#room"),
  start: document.querySelector("#start"),
  send: document.querySelector("#send"),
  refresh: document.querySelector("#refresh"),
  close: document.querySelector("#close"),
};

const output = {
  status: document.querySelector("#status"),
  userAgent: document.querySelector("#user-agent"),
  activeRole: document.querySelector("#active-role"),
  signalingState: document.querySelector("#signaling-state"),
  iceGatheringState: document.querySelector("#ice-gathering-state"),
  iceConnectionState: document.querySelector("#ice-connection-state"),
  connectionState: document.querySelector("#connection-state"),
  localDescription: document.querySelector("#local-description"),
  remoteDescription: document.querySelector("#remote-description"),
  dataChannelState: document.querySelector("#data-channel-state"),
  lastMessageSent: document.querySelector("#last-message-sent"),
  lastMessageReceived: document.querySelector("#last-message-received"),
  localCandidateTypes: document.querySelector("#local-candidate-types"),
  remoteCandidateTypes: document.querySelector("#remote-candidate-types"),
  selectedPair: document.querySelector("#selected-pair"),
  selectedLocalType: document.querySelector("#selected-local-type"),
  selectedRemoteType: document.querySelector("#selected-remote-type"),
  protocol: document.querySelector("#protocol"),
  rtt: document.querySelector("#rtt"),
  pathClassification: document.querySelector("#path-classification"),
  eventLog: document.querySelector("#event-log"),
};

let peer = null;
let dataChannel = null;
let signalChannel = null;
let announceTimer = null;
let diagnosticsTimer = null;
let role = null;
let offerStarted = false;
let closed = true;
let pingSent = false;
const pendingCandidates = [];
const localCandidateTypes = new Set();
const remoteCandidateTypes = new Set();

function setStatus(message, kind = "info") {
  output.status.textContent = message;
  output.status.dataset.kind = kind;
}

function logEvent(message) {
  const entry = document.createElement("li");
  entry.textContent = `${new Date().toISOString()} — ${message}`;
  output.eventLog.prepend(entry);
  while (output.eventLog.children.length > 50) output.eventLog.lastElementChild?.remove();
}

function describeSessionDescription(description) {
  return description ? `set (${description.type})` : "not set";
}

function updateStateDiagnostics() {
  output.signalingState.textContent = peer?.signalingState ?? "closed";
  output.iceGatheringState.textContent = peer?.iceGatheringState ?? "closed";
  output.iceConnectionState.textContent = peer?.iceConnectionState ?? "closed";
  output.connectionState.textContent = peer?.connectionState ?? "closed";
  output.localDescription.textContent = describeSessionDescription(peer?.localDescription);
  output.remoteDescription.textContent = describeSessionDescription(peer?.remoteDescription);
  output.dataChannelState.textContent = dataChannel?.readyState ?? "not created";
  output.localCandidateTypes.textContent = formatCandidateTypes(localCandidateTypes);
  output.remoteCandidateTypes.textContent = formatCandidateTypes(remoteCandidateTypes);
  controls.send.disabled = dataChannel?.readyState !== "open";
}

async function updateStatsDiagnostics() {
  updateStateDiagnostics();
  if (!peer || peer.connectionState === "closed") return;

  try {
    const selected = chooseSelectedPair(await peer.getStats());
    if (!selected) {
      output.selectedPair.textContent = "Unavailable (no selected candidate pair reported yet)";
      return;
    }

    const localType = selected.local?.candidateType ?? "Unavailable";
    const remoteType = selected.remote?.candidateType ?? "Unavailable";
    const protocol = selected.local?.protocol ?? selected.remote?.protocol ?? "Unavailable";

    output.selectedPair.textContent = `reported (${selected.pair.state ?? "state unavailable"})`;
    output.selectedLocalType.textContent = localType;
    output.selectedRemoteType.textContent = remoteType;
    output.protocol.textContent = protocol;
    output.rtt.textContent = formatRtt(selected.pair.currentRoundTripTime);
    output.pathClassification.textContent = classifyCandidatePath(
      selected.local?.candidateType,
      selected.remote?.candidateType,
    );
  } catch (error) {
    output.selectedPair.textContent = `Unavailable (${error.name || "getStats error"})`;
  }
}

function sendSignal(message) {
  signalChannel?.postMessage(message);
}

function stopAnnouncing() {
  window.clearInterval(announceTimer);
  announceTimer = null;
}

function plainDescription(description) {
  return description ? { type: description.type, sdp: description.sdp } : null;
}

async function flushPendingCandidates() {
  if (!peer?.remoteDescription) return;
  while (pendingCandidates.length > 0) {
    await peer.addIceCandidate(pendingCandidates.shift());
  }
}

function configureDataChannel(channel) {
  dataChannel = channel;
  output.dataChannelState.textContent = channel.readyState;
  logEvent(`RTCDataChannel '${channel.label}' configured.`);

  channel.addEventListener("open", () => {
    updateStateDiagnostics();
    setStatus("Connected. The control data channel is open.", "success");
    logEvent("RTCDataChannel opened.");
    if (role === "initiator" && !pingSent) sendPing();
  });

  channel.addEventListener("close", () => {
    updateStateDiagnostics();
    logEvent("RTCDataChannel closed.");
  });

  channel.addEventListener("error", () => {
    updateStateDiagnostics();
    logEvent("RTCDataChannel reported an error.");
  });

  channel.addEventListener("message", (event) => {
    const message = typeof event.data === "string" ? event.data : "[non-text message rejected]";
    output.lastMessageReceived.textContent = message;
    logEvent(`Received control text: ${message}`);
    if (message === "PING" && channel.readyState === "open") {
      channel.send("PONG");
      output.lastMessageSent.textContent = "PONG";
      logEvent("Sent control text: PONG");
    }
  });
}

function sendPing() {
  if (dataChannel?.readyState !== "open") return;
  dataChannel.send("PING");
  pingSent = true;
  output.lastMessageSent.textContent = "PING";
  logEvent("Sent control text: PING");
}

async function createOffer() {
  if (!peer || offerStarted || role !== "initiator") return;
  offerStarted = true;
  stopAnnouncing();
  configureDataChannel(peer.createDataChannel("control"));
  await peer.setLocalDescription(await peer.createOffer());
  updateStateDiagnostics();
  sendSignal({ kind: "description", description: plainDescription(peer.localDescription) });
  logEvent("Offer created and sent through development signaling.");
}

async function handleSignal(message) {
  if (!peer || closed || !message || typeof message !== "object") return;

  if (message.kind === "hello" && role === "responder") {
    sendSignal({ kind: "ready" });
    return;
  }

  if (message.kind === "ready" && role === "initiator") {
    await createOffer();
    return;
  }

  if (message.kind === "description" && message.description) {
    const description = message.description;
    if (description.type === "offer" && role === "responder") {
      stopAnnouncing();
      await peer.setRemoteDescription(description);
      await flushPendingCandidates();
      await peer.setLocalDescription(await peer.createAnswer());
      updateStateDiagnostics();
      sendSignal({ kind: "description", description: plainDescription(peer.localDescription) });
      logEvent("Offer accepted; answer created and sent through development signaling.");
    } else if (description.type === "answer" && role === "initiator") {
      await peer.setRemoteDescription(description);
      await flushPendingCandidates();
      updateStateDiagnostics();
      logEvent("Answer accepted; local and remote descriptions are set.");
    }
    return;
  }

  if (message.kind === "candidate" && message.candidate) {
    const type = candidateTypeFrom(message.candidate);
    if (type) remoteCandidateTypes.add(type);
    if (peer.remoteDescription) await peer.addIceCandidate(message.candidate);
    else pendingCandidates.push(message.candidate);
    updateStateDiagnostics();
  }
}

function handleError(error) {
  setStatus(`Experiment error: ${error.message || error}`, "error");
  logEvent(`Error: ${error.name || "Error"} — ${error.message || String(error)}`);
}

function closePeer({ announce = true } = {}) {
  closed = true;
  window.clearInterval(announceTimer);
  window.clearInterval(diagnosticsTimer);
  announceTimer = null;
  diagnosticsTimer = null;
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
  controls.send.disabled = true;
  controls.refresh.disabled = true;
  controls.close.disabled = true;
  updateStateDiagnostics();
  if (announce) {
    setStatus("Closed. Peer connection, data channel, signaling channel, and timers released.");
    logEvent("All experiment resources closed.");
  }
}

function startPeer() {
  const room = controls.room.value.trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(room)) {
    setStatus("Use a 1–64 character room label containing only letters, numbers, _ or -.", "error");
    return;
  }

  role = controls.role.value;
  closed = false;
  offerStarted = false;
  pingSent = false;
  localCandidateTypes.clear();
  remoteCandidateTypes.clear();
  output.activeRole.textContent = role;
  output.lastMessageSent.textContent = "None";
  output.lastMessageReceived.textContent = "None";

  peer = new RTCPeerConnection({ iceServers: [{ urls: STUN_URL }] });
  signalChannel = new BroadcastChannel(`${SIGNAL_PREFIX}-${room}`);
  signalChannel.addEventListener("message", (event) => {
    handleSignal(event.data).catch(handleError);
  });

  peer.addEventListener("datachannel", (event) => configureDataChannel(event.channel));
  peer.addEventListener("icecandidate", (event) => {
    if (!event.candidate) {
      logEvent("ICE candidate gathering emitted its completion marker.");
      return;
    }
    const type = candidateTypeFrom(event.candidate);
    if (type) localCandidateTypes.add(type);
    sendSignal({ kind: "candidate", candidate: event.candidate.toJSON() });
    updateStateDiagnostics();
  });

  for (const eventName of [
    "signalingstatechange",
    "icegatheringstatechange",
    "iceconnectionstatechange",
    "connectionstatechange",
  ]) {
    peer.addEventListener(eventName, () => {
      updateStateDiagnostics();
      logEvent(`${eventName}: ${
        eventName === "signalingstatechange"
          ? peer.signalingState
          : eventName === "icegatheringstatechange"
            ? peer.iceGatheringState
            : eventName === "iceconnectionstatechange"
              ? peer.iceConnectionState
              : peer.connectionState
      }`);
      if (eventName === "connectionstatechange" && peer.connectionState === "connected") {
        updateStatsDiagnostics();
      }
    });
  }

  controls.role.disabled = true;
  controls.room.disabled = true;
  controls.start.disabled = true;
  controls.refresh.disabled = false;
  controls.close.disabled = false;
  setStatus(`Started as ${role}; waiting for the other local browser peer.`);
  logEvent(`RTCPeerConnection initialized as ${role}. Public STUN is non-production test configuration.`);
  updateStateDiagnostics();

  const announce = () => sendSignal({ kind: role === "initiator" ? "hello" : "ready" });
  announce();
  announceTimer = window.setInterval(announce, 500);
  diagnosticsTimer = window.setInterval(updateStatsDiagnostics, 1000);
}

controls.start.addEventListener("click", startPeer);
controls.send.addEventListener("click", sendPing);
controls.refresh.addEventListener("click", () => updateStatsDiagnostics());
controls.close.addEventListener("click", () => closePeer());
window.addEventListener("pagehide", () => closePeer({ announce: false }));

const parameters = new URLSearchParams(window.location.search);
if (["initiator", "responder"].includes(parameters.get("role"))) {
  controls.role.value = parameters.get("role");
}
if (/^[a-zA-Z0-9_-]{1,64}$/.test(parameters.get("room") ?? "")) {
  controls.room.value = parameters.get("room");
}
output.userAgent.textContent = navigator.userAgent;
