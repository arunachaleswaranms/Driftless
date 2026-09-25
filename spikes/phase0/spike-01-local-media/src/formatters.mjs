const READY_STATE_LABELS = [
  "HAVE_NOTHING",
  "HAVE_METADATA",
  "HAVE_CURRENT_DATA",
  "HAVE_FUTURE_DATA",
  "HAVE_ENOUGH_DATA",
];

const NETWORK_STATE_LABELS = [
  "NETWORK_EMPTY",
  "NETWORK_IDLE",
  "NETWORK_LOADING",
  "NETWORK_NO_SOURCE",
];

const MEDIA_ERROR_LABELS = {
  1: "MEDIA_ERR_ABORTED",
  2: "MEDIA_ERR_NETWORK",
  3: "MEDIA_ERR_DECODE",
  4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
};

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown";
  if (bytes === 0) return "0 B";

  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  const digits = exponent === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;

  return `${value.toFixed(digits)} ${units[exponent]}`;
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";

  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;

  return [hours, minutes, remainingSeconds]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

export function formatRanges(ranges) {
  if (!ranges || ranges.length === 0) return "None";

  const formatted = [];
  for (let index = 0; index < ranges.length; index += 1) {
    try {
      formatted.push(`${formatTime(ranges.start(index))}–${formatTime(ranges.end(index))}`);
    } catch {
      formatted.push("Unavailable");
    }
  }
  return formatted.join(", ");
}

export function formatReadyState(state) {
  return `${state} (${READY_STATE_LABELS[state] ?? "UNKNOWN"})`;
}

export function formatNetworkState(state) {
  return `${state} (${NETWORK_STATE_LABELS[state] ?? "UNKNOWN"})`;
}

export function formatMediaError(error) {
  if (!error) return "None";

  const code = Number(error.code);
  const label = MEDIA_ERROR_LABELS[code] ?? "UNKNOWN_MEDIA_ERROR";
  const message = typeof error.message === "string" && error.message.trim() ? `: ${error.message}` : "";
  return `${code} (${label})${message}`;
}

export function isTargetMedia(file) {
  if (!file) return false;
  const mimeType = String(file.type || "").toLowerCase();
  const filename = String(file.name || "").toLowerCase();
  return mimeType === "video/mp4" || filename.endsWith(".mp4");
}
