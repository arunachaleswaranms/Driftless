import { KiB, MiB } from "./framing.mjs";

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "Unavailable";
  if (bytes >= MiB) return `${(bytes / MiB).toFixed(2)} MiB`;
  if (bytes >= KiB) return `${(bytes / KiB).toFixed(1)} KiB`;
  return `${bytes} B`;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "Unavailable";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`;
}

export function throughputMiBps(bytes, ms) {
  return Number.isFinite(bytes) && Number.isFinite(ms) && ms > 0 ? bytes / MiB / (ms / 1000) : null;
}

// Same-host values are laboratory observations only and must not be read as Internet throughput.
export function formatLabThroughput(bytes, ms) {
  const value = throughputMiBps(bytes, ms);
  if (value === null) return "Unavailable";
  return `${value.toFixed(1)} MiB/s (${((value * MiB * 8) / 1e6).toFixed(0)} Mbit/s) — LAB ONLY`;
}
