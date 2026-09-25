import assert from "node:assert/strict";
import test from "node:test";

import {
  formatBytes,
  formatMediaError,
  formatNetworkState,
  formatRanges,
  formatReadyState,
  formatTime,
  isTargetMedia,
} from "./formatters.mjs";

test("formatBytes uses bounded binary units", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1024), "1.00 KiB");
  assert.equal(formatBytes(1024 ** 3), "1.00 GiB");
  assert.equal(formatBytes(-1), "Unknown");
});

test("formatTime produces stable hour-minute-second output", () => {
  assert.equal(formatTime(0), "00:00:00");
  assert.equal(formatTime(6137.9), "01:42:17");
  assert.equal(formatTime(Number.NaN), "—");
  assert.equal(formatTime(-1), "—");
});

test("formatRanges reports all ranges and tolerates access errors", () => {
  const ranges = {
    length: 2,
    start: (index) => [0, 30][index],
    end: (index) => [10.5, 45][index],
  };
  assert.equal(formatRanges(ranges), "00:00:00–00:00:10, 00:00:30–00:00:45");
  assert.equal(formatRanges({ length: 0 }), "None");
  assert.equal(
    formatRanges({ length: 1, start: () => { throw new Error("detached"); }, end: () => 0 }),
    "Unavailable",
  );
});

test("state and error formatting preserves numeric browser diagnostics", () => {
  assert.equal(formatReadyState(4), "4 (HAVE_ENOUGH_DATA)");
  assert.equal(formatReadyState(8), "8 (UNKNOWN)");
  assert.equal(formatNetworkState(1), "1 (NETWORK_IDLE)");
  assert.equal(formatMediaError(null), "None");
  assert.equal(formatMediaError({ code: 4, message: "Unsupported" }), "4 (MEDIA_ERR_SRC_NOT_SUPPORTED): Unsupported");
});

test("target-media hint accepts MP4 MIME or extension without claiming codec support", () => {
  assert.equal(isTargetMedia({ name: "trip.bin", type: "video/mp4" }), true);
  assert.equal(isTargetMedia({ name: "TRIP.MP4", type: "" }), true);
  assert.equal(isTargetMedia({ name: "trip.webm", type: "video/webm" }), false);
  assert.equal(isTargetMedia(null), false);
});
