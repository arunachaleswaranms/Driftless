import {
  formatBytes,
  formatMediaError,
  formatNetworkState,
  formatRanges,
  formatReadyState,
  formatTime,
  isTargetMedia,
} from "./formatters.mjs";

const fileInput = document.querySelector("#file-input");
const clearButton = document.querySelector("#clear-button");
const video = document.querySelector("#video");

const output = {
  status: document.querySelector("#status"),
  compatibilityNote: document.querySelector("#compatibility-note"),
  filename: document.querySelector("#filename"),
  fileSize: document.querySelector("#file-size"),
  mimeType: document.querySelector("#mime-type"),
  duration: document.querySelector("#duration"),
  resolution: document.querySelector("#resolution"),
  playbackPosition: document.querySelector("#playback-position"),
  userAgent: document.querySelector("#user-agent"),
  mimeSupport: document.querySelector("#mime-support"),
  readyState: document.querySelector("#ready-state"),
  networkState: document.querySelector("#network-state"),
  bufferedRanges: document.querySelector("#buffered-ranges"),
  seekableRanges: document.querySelector("#seekable-ranges"),
  mediaError: document.querySelector("#media-error"),
  objectUrlState: document.querySelector("#object-url-state"),
  eventLog: document.querySelector("#event-log"),
};

let activeObjectUrl = null;
let activeFile = null;

function setStatus(message, kind = "info") {
  output.status.textContent = message;
  output.status.dataset.kind = kind;
}

function logEvent(message) {
  const entry = document.createElement("li");
  entry.textContent = `${new Date().toISOString()} — ${message}`;
  output.eventLog.prepend(entry);

  while (output.eventLog.children.length > 40) {
    output.eventLog.lastElementChild?.remove();
  }
}

function updateDiagnostics() {
  output.duration.textContent = formatTime(video.duration);
  output.resolution.textContent =
    video.videoWidth > 0 && video.videoHeight > 0
      ? `${video.videoWidth} × ${video.videoHeight}`
      : "—";
  output.playbackPosition.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
  output.readyState.textContent = formatReadyState(video.readyState);
  output.networkState.textContent = formatNetworkState(video.networkState);
  output.bufferedRanges.textContent = formatRanges(video.buffered);
  output.seekableRanges.textContent = formatRanges(video.seekable);
  output.mediaError.textContent = formatMediaError(video.error);
  output.mediaError.dataset.empty = video.error ? "false" : "true";
}

function resetFileOutputs() {
  output.filename.textContent = "—";
  output.fileSize.textContent = "—";
  output.mimeType.textContent = "—";
  output.duration.textContent = "—";
  output.resolution.textContent = "—";
  output.playbackPosition.textContent = "—";
  output.bufferedRanges.textContent = "None";
  output.seekableRanges.textContent = "None";
  output.mediaError.textContent = "None";
  output.mediaError.dataset.empty = "true";
}

function releaseActiveMedia({ resetInput = false, announce = true } = {}) {
  if (!activeObjectUrl && !video.getAttribute("src")) {
    if (resetInput) fileInput.value = "";
    return;
  }

  video.pause();
  video.removeAttribute("src");
  video.load();

  if (activeObjectUrl) {
    URL.revokeObjectURL(activeObjectUrl);
    activeObjectUrl = null;
    output.objectUrlState.textContent = "Previous object URL revoked";
    if (announce) logEvent("Released media element source and revoked the active object URL.");
  }

  activeFile = null;
  if (resetInput) fileInput.value = "";
  clearButton.disabled = true;
  resetFileOutputs();
  updateDiagnostics();
}

function bindFile(file) {
  releaseActiveMedia({ announce: true });
  activeFile = file;

  output.filename.textContent = file.name || "Unnamed file";
  output.fileSize.textContent = `${formatBytes(file.size)} (${file.size.toLocaleString()} bytes)`;
  output.mimeType.textContent = file.type || "Not provided by browser";

  if (file.type) {
    const canPlay = video.canPlayType(file.type);
    output.mimeSupport.textContent = canPlay || "No native support reported for declared type";
  } else {
    output.mimeSupport.textContent = "Not testable — browser provided no MIME type";
  }

  if (isTargetMedia(file)) {
    output.compatibilityNote.textContent =
      "The file matches the MP4 container target by extension or MIME type. Codec compatibility still depends on native metadata/decoding.";
  } else {
    output.compatibilityNote.textContent =
      "This file is outside the initial MP4 target. Native playback is attempted only to observe clean unsupported-media behavior.";
  }

  activeObjectUrl = URL.createObjectURL(file);
  output.objectUrlState.textContent = "One active local object URL (value intentionally not displayed)";
  clearButton.disabled = false;
  setStatus("Local file bound to the native video element. Waiting for metadata.");
  logEvent(`Selected local file (${formatBytes(file.size)}, ${file.type || "MIME type unavailable"}).`);

  video.src = activeObjectUrl;
  video.load();
  updateDiagnostics();
}

fileInput.addEventListener("change", () => {
  const [file] = fileInput.files ?? [];
  if (!file) {
    setStatus("No file selected.");
    return;
  }
  bindFile(file);
});

clearButton.addEventListener("click", () => {
  releaseActiveMedia({ resetInput: true, announce: true });
  output.objectUrlState.textContent = "No active object URL";
  setStatus("Selection cleared and local media resources released.");
});

const observedEvents = [
  "loadstart",
  "loadedmetadata",
  "loadeddata",
  "canplay",
  "play",
  "playing",
  "pause",
  "seeking",
  "seeked",
  "waiting",
  "stalled",
  "suspend",
  "ended",
  "emptied",
  "durationchange",
  "progress",
  "error",
];

for (const eventName of observedEvents) {
  video.addEventListener(eventName, () => {
    updateDiagnostics();

    if (eventName === "loadedmetadata") {
      setStatus("Metadata loaded. Use the native controls to test playback, pause, resume, and seek.");
    } else if (eventName === "error") {
      setStatus(`Native media error: ${formatMediaError(video.error)}`, "error");
    }

    if (activeFile || eventName === "error") {
      logEvent(`video.${eventName}${eventName === "error" ? ` — ${formatMediaError(video.error)}` : ""}`);
    }
  });
}

video.addEventListener("timeupdate", updateDiagnostics);
window.setInterval(updateDiagnostics, 250);

window.addEventListener("pagehide", () => {
  releaseActiveMedia({ announce: false });
});

output.userAgent.textContent = navigator.userAgent;
output.mimeSupport.textContent = video.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"') || "Not reported";
output.mediaError.dataset.empty = "true";
updateDiagnostics();
