const BYTE_UNITS = ['KiB', 'MiB', 'GiB', 'TiB'] as const;

/** Groups the digits of a non-negative integer with commas, independent of locale. */
function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Formats a byte count in binary units with the exact count alongside, for
 * example `1.50 MiB (1,572,864 bytes)`. Output does not depend on locale.
 */
export function formatByteSize(bytes: number): string {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    return 'Unknown';
  }
  if (bytes < 1024) {
    return bytes === 1 ? '1 byte' : `${groupDigits(bytes)} bytes`;
  }

  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  const unit = BYTE_UNITS[unitIndex] ?? 'TiB';
  return `${value.toFixed(digits)} ${unit} (${groupDigits(bytes)} bytes)`;
}

/**
 * Formats a media duration as `m:ss` or `h:mm:ss`, rounded to the nearest
 * second. Returns null when the browser reports no usable duration: NaN
 * before metadata, Infinity for unbounded or unknown-length media, or a
 * negative value.
 */
export function formatDuration(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = String(total % 60).padStart(2, '0');
  return hours > 0
    ? `${String(hours)}:${String(minutes).padStart(2, '0')}:${remainder}`
    : `${String(minutes)}:${remainder}`;
}

/** Formats video dimensions, or returns null when the browser reports none. */
export function formatDimensions(width: number, height: number): string | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return null;
  }
  return `${String(width)} × ${String(height)} pixels`;
}
