// TimeRanges helpers. MSE reports buffered media as a TimeRanges object; the spike
// snapshots it into plain [start, end] pairs so that growth, gaps, and overlap can be
// compared between appends without holding live browser objects.

export const RANGE_LIMITS = Object.freeze({ maxRanges: 256 });

/** Snapshot a TimeRanges-like object ({ length, start(i), end(i) }) into [[s, e], ...]. */
export function snapshotRanges(timeRanges) {
  const out = [];
  const n = Math.min(timeRanges?.length ?? 0, RANGE_LIMITS.maxRanges);
  for (let i = 0; i < n; i += 1) out.push([timeRanges.start(i), timeRanges.end(i)]);
  return out;
}

/** True when ranges are sorted, non-overlapping, and each has start < end. */
export function isNormalized(ranges) {
  for (let i = 0; i < ranges.length; i += 1) {
    const [s, e] = ranges[i];
    if (!(Number.isFinite(s) && Number.isFinite(e) && s < e)) return false;
    if (i > 0 && s <= ranges[i - 1][1]) return false;
  }
  return true;
}

/** Index of the range containing t (start - tolerance <= t < end), or -1. */
export function rangeIndexAt(ranges, t, tolerance = 0) {
  for (let i = 0; i < ranges.length; i += 1) {
    if (t >= ranges[i][0] - tolerance && t < ranges[i][1]) return i;
  }
  return -1;
}

/** Seconds of contiguous buffered media ahead of t (0 when t is not buffered). */
export function bufferedAhead(ranges, t, tolerance = 0) {
  const i = rangeIndexAt(ranges, t, tolerance);
  return i < 0 ? 0 : ranges[i][1] - t;
}

export function bufferedEnd(ranges) {
  return ranges.length ? ranges[ranges.length - 1][1] : undefined;
}

export function totalBuffered(ranges) {
  return ranges.reduce((n, [s, e]) => n + (e - s), 0);
}

/** Does `ranges` fully cover [start, end] (within tolerance at both edges)? */
export function covers(ranges, start, end, tolerance = 0) {
  return ranges.some(([s, e]) => s <= start + tolerance && e >= end - tolerance);
}

/**
 * Compare two snapshots taken before and after an append. Reports whether anything
 * that was buffered before is missing afterwards (data loss or eviction), whether the
 * number of ranges changed, and whether the last buffered end moved backwards.
 */
export function compareRanges(before, after, tolerance = 1e-3) {
  const lost = [];
  for (const [s, e] of before) {
    if (!covers(after, s, e, tolerance)) lost.push([s, e]);
  }
  const endBefore = bufferedEnd(before);
  const endAfter = bufferedEnd(after);
  return {
    rangesBefore: before.length,
    rangesAfter: after.length,
    normalized: isNormalized(after),
    lost,
    endMovedBack: endBefore !== undefined && endAfter !== undefined && endAfter < endBefore - tolerance,
    growthSeconds: totalBuffered(after) - totalBuffered(before),
  };
}

export function fmtRanges(ranges, digits = 3) {
  if (!ranges.length) return "none";
  return ranges.map(([s, e]) => `${s.toFixed(digits)}–${e.toFixed(digits)}`).join(", ");
}
