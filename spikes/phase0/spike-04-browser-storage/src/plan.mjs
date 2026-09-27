// Experimental Spike 0.4 planning, bounds, and validation. These values are laboratory
// limits for a feasibility experiment and are not Driftless production cache policy.

export { KiB, MiB, fillPattern, findPatternMismatch } from "../../spike-03-datachannel-binary/src/framing.mjs";
import { KiB, MiB } from "../../spike-03-datachannel-binary/src/framing.mjs";

export const GiB = 1024 * MiB;

export const SPIKE_DIRECTORY = "driftless-spike-04";

export const LIMITS = Object.freeze({
  minTestBytes: 1 * MiB,
  maxTestBytes: 1 * GiB,
  minBlockBytes: 4 * KiB,
  maxBlockBytes: 16 * MiB,
  maxRangeBytes: 16 * MiB,
  maxMetadataChars: 4096,
  maxListedEntries: 100,
  maxDisplayNameChars: 80,
});

// Admission policy for this spike only. A write is refused unless the browser-reported headroom
// covers twice the requested bytes (Chromium's createWritable() stages writes in a swap file,
// and a keepExistingData resume copies the existing file into it) plus a fixed reserve.
export const HEADROOM_POLICY = Object.freeze({
  overheadFactor: 2,
  reserveBytes: 1 * GiB,
});

export const INSUFFICIENT_HEADROOM = "INSUFFICIENT STORAGE HEADROOM";

const ENTRY_NAME = /^(st|resume|persist|sync|probe)-[0-9]{1,5}m-[0-9a-f]{8}\.bin$/;
const METADATA_NAME = /^(st|resume|persist|sync|probe)-[0-9]{1,5}m-[0-9a-f]{8}\.meta\.json$/;

function isUint32(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

export function validateTestBytes(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < LIMITS.minTestBytes || bytes > LIMITS.maxTestBytes) {
    return { ok: false, error: `test size must be an integer from ${LIMITS.minTestBytes} to ${LIMITS.maxTestBytes} bytes` };
  }
  return { ok: true };
}

export function validateBlockBytes(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < LIMITS.minBlockBytes || bytes > LIMITS.maxBlockBytes) {
    return { ok: false, error: `block size must be an integer from ${LIMITS.minBlockBytes} to ${LIMITS.maxBlockBytes} bytes` };
  }
  return { ok: true };
}

// Returns a finite headroom figure from a StorageManager estimate, or null when the estimate
// cannot support an admission decision.
export function headroomFromEstimate(estimate) {
  if (!estimate || typeof estimate !== "object") return null;
  const { quota, usage } = estimate;
  if (!Number.isFinite(quota) || !Number.isFinite(usage) || quota < 0 || usage < 0) return null;
  return Math.max(0, quota - usage);
}

export function admitWrite({ bytes, estimate, policy = HEADROOM_POLICY }) {
  const size = validateTestBytes(bytes);
  if (!size.ok) return { ok: false, code: "SIZE OUT OF BOUNDS", reason: size.error };

  const headroom = headroomFromEstimate(estimate);
  const requiredBytes = bytes * policy.overheadFactor + policy.reserveBytes;
  if (headroom === null) {
    return {
      ok: false,
      code: INSUFFICIENT_HEADROOM,
      reason: "navigator.storage.estimate() did not report usable quota/usage; refusing large write",
      requiredBytes,
      headroomBytes: null,
    };
  }
  if (requiredBytes > headroom) {
    return {
      ok: false,
      code: INSUFFICIENT_HEADROOM,
      reason: `requires ${requiredBytes} bytes (${policy.overheadFactor}× request + ${policy.reserveBytes} reserve) but estimate reports ${headroom} bytes of headroom`,
      requiredBytes,
      headroomBytes: headroom,
    };
  }
  return { ok: true, requiredBytes, headroomBytes: headroom };
}

// Iterates [start, end) as bounded blocks. Callers generate, write, and discard one block at a time.
export function* blockRanges(start, end, blockBytes) {
  for (let offset = start; offset < end; offset += blockBytes) {
    yield { offset, length: Math.min(blockBytes, end - offset) };
  }
}

function clampRange(offset, length, size) {
  const start = Math.max(0, Math.min(offset, size));
  return { offset: start, length: Math.max(0, Math.min(length, size - start)) };
}

// Selected random-access ranges: beginning, quartiles, middle, an unaligned interior offset,
// near end, and the final bytes. They approximate a player asking for a distant segment.
export function verificationRanges(size, rangeBytes = 256 * KiB) {
  const length = Math.min(rangeBytes, LIMITS.maxRangeBytes, size);
  const candidates = [
    ["beginning", 0],
    ["quarter", Math.floor(size / 4)],
    ["middle", Math.floor(size / 2) - Math.floor(length / 2)],
    ["unaligned", Math.floor(size * 0.61) + 3],
    ["three-quarter", Math.floor((size * 3) / 4)],
    ["near-end", size - length - 4099],
    ["end", size - length],
  ];
  const seen = new Set();
  const ranges = [];
  for (const [label, offset] of candidates) {
    const range = clampRange(offset, length, size);
    const key = `${range.offset}:${range.length}`;
    if (range.length > 0 && !seen.has(key)) {
      seen.add(key);
      ranges.push({ label, ...range });
    }
  }
  return ranges;
}

// Ranges that straddle a resume boundary, including the exact boundary bytes.
export function boundaryRanges(boundary, size, radius = 64 * KiB) {
  return [
    { label: "boundary-straddle", ...clampRange(boundary - radius, radius * 2, size) },
    { label: "boundary-last-byte-before", ...clampRange(boundary - 1, 1, size) },
    { label: "boundary-first-byte-after", ...clampRange(boundary, 1, size) },
    { label: "boundary-unaligned", ...clampRange(boundary - 3, 7, size) },
  ].filter((range) => range.length > 0);
}

export function makeEntryName(kind, bytes, randomHex) {
  const mebibytes = Math.round(bytes / MiB);
  const name = `${kind}-${mebibytes}m-${randomHex}.bin`;
  if (!ENTRY_NAME.test(name)) throw new Error("generated entry name failed validation");
  return name;
}

export function metadataNameFor(entryName) {
  if (!ENTRY_NAME.test(entryName)) throw new Error("entry name failed validation");
  return entryName.replace(/\.bin$/, ".meta.json");
}

export function isSpikeEntryName(name) {
  return typeof name === "string" && ENTRY_NAME.test(name);
}

export function isSpikeMetadataName(name) {
  return typeof name === "string" && METADATA_NAME.test(name);
}

// Untrusted names found in storage are displayed only as bounded text via textContent.
export function displayName(name) {
  const text = String(name).replace(/[\u0000-\u001f\u007f]/g, "?");
  return text.length > LIMITS.maxDisplayNameChars ? `${text.slice(0, LIMITS.maxDisplayNameChars)}…` : text;
}

export function buildMetadata({ name, seed, totalBytes, blockBytes, createdAt }) {
  return JSON.stringify({ version: 1, name, seed, totalBytes, blockBytes, createdAt });
}

// Metadata read back from OPFS is treated as untrusted input and schema-checked before use.
export function parseMetadata(text) {
  if (typeof text !== "string" || text.length > LIMITS.maxMetadataChars) {
    return { ok: false, error: "metadata is missing or exceeds the size bound" };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "metadata is not valid JSON" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "metadata must be an object" };
  if (value.version !== 1) return { ok: false, error: "metadata version is unsupported" };
  if (!isSpikeEntryName(value.name)) return { ok: false, error: "metadata name is invalid" };
  if (!isUint32(value.seed)) return { ok: false, error: "metadata seed is invalid" };
  if (!validateTestBytes(value.totalBytes).ok) return { ok: false, error: "metadata totalBytes is out of bounds" };
  if (!validateBlockBytes(value.blockBytes).ok) return { ok: false, error: "metadata blockBytes is out of bounds" };
  if (typeof value.createdAt !== "string" || value.createdAt.length > 40) {
    return { ok: false, error: "metadata createdAt is invalid" };
  }
  return { ok: true, metadata: value };
}

export function randomHex32() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomSeed() {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "Unavailable";
  const sign = bytes < 0 ? "−" : "";
  const value = Math.abs(bytes);
  if (value >= GiB) return `${sign}${(value / GiB).toFixed(2)} GiB`;
  if (value >= MiB) return `${sign}${(value / MiB).toFixed(2)} MiB`;
  if (value >= KiB) return `${sign}${(value / KiB).toFixed(1)} KiB`;
  return `${sign}${value} B`;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "Unavailable";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`;
}
