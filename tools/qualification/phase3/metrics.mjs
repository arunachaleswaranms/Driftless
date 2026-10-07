// External qualification math. Sampler times share one monotonic clock;
// browser performance.now() values are recorded but never compared directly.
export const thresholds = Object.freeze({
  durationMs: 1800000,
  cadenceMs: 1000,
  coveragePercent: 95,
  p95Ms: 250,
  p99Ms: 500,
  maximumMs: 750,
  consecutiveOver500: 2,
  evaluationRttMs: 100,
  separationMs: 200,
});
export function percentile(values, p) {
  if (!values.length) return null;
  if (!Number.isFinite(p) || p < 0 || p > 1 || values.some((v) => !Number.isFinite(v)))
    throw new Error('invalid percentile input');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]; // nearest rank
}
export function project(observation, epochMs) {
  const { beforeMs, afterMs, currentTime, paused, playbackRate } = observation;
  if (
    ![beforeMs, afterMs, currentTime, playbackRate, epochMs].every(Number.isFinite) ||
    afterMs < beforeMs ||
    currentTime < 0 ||
    playbackRate <= 0 ||
    typeof paused !== 'boolean'
  )
    throw new Error('invalid observation');
  return currentTime * 1000 + (paused ? 0 : (epochMs - (beforeMs + afterMs) / 2) * playbackRate);
}
export function measure(host, guest) {
  try {
    const hMid = (host.beforeMs + host.afterMs) / 2;
    const gMid = (guest.beforeMs + guest.afterMs) / 2;
    const epochMs = Math.max(hMid, gMid);
    const driftMs = project(guest, epochMs) - project(host, epochMs);
    const reasons = [];
    if (host.afterMs - host.beforeMs > 100 || guest.afterMs - guest.beforeMs > 100)
      reasons.push('evaluation_rtt');
    // Worst-case separation, including both observation uncertainty intervals.
    const separationMs =
      Math.max(host.afterMs, guest.afterMs) - Math.min(host.beforeMs, guest.beforeMs);
    if (separationMs > 200) reasons.push('observation_separation');
    return { epochMs, driftMs, separationMs, valid: reasons.length === 0, reasons };
  } catch {
    return { epochMs: null, driftMs: null, valid: false, reasons: ['invalid_observation'] };
  }
}
export function excluded(timeMs, windows) {
  return windows.some((w) => timeMs >= w.startMs && timeMs < w.endMs);
}
export function summarize(samples, { startMs, endMs, exclusions = [] }) {
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs <= startMs ||
    exclusions.some(
      (w) =>
        !Number.isFinite(w.startMs) ||
        !Number.isFinite(w.endMs) ||
        w.endMs <= w.startMs ||
        !w.reason,
    )
  )
    throw new Error('invalid run interval');
  const eligible = samples.filter(
    (s) => s.atMs >= startMs && s.atMs < endMs && !excluded(s.atMs, exclusions),
  );
  const valid = eligible.filter((s) => s.valid && Number.isFinite(s.driftMs));
  let expected = 0;
  for (let t = startMs; t < endMs; t += 1000) if (!excluded(t, exclusions)) expected++;
  // One sample per scheduled slot; duplicates cannot inflate coverage.
  const occupied = new Set(valid.map((s) => Math.floor((s.atMs - startMs) / 1000)));
  const coveragePercent = expected ? (occupied.size / expected) * 100 : 0;
  let consecutive = 0,
    maximumConsecutiveOver500 = 0,
    prior = null;
  for (const s of [...eligible].sort((a, b) => a.atMs - b.atMs)) {
    // Only explicit transition windows break a sequence. Rejections/missing
    // observations never erase consecutive valid high-drift evidence.
    if (prior !== null && exclusions.some((w) => w.startMs >= prior && w.startMs <= s.atMs))
      consecutive = 0;
    if (s.valid && Number.isFinite(s.driftMs))
      consecutive = Math.abs(s.driftMs) > 500 ? consecutive + 1 : 0;
    maximumConsecutiveOver500 = Math.max(maximumConsecutiveOver500, consecutive);
    prior = s.atMs;
  }
  const absolute = valid.map((s) => Math.abs(s.driftMs));
  const stats = {
    p50Ms: percentile(absolute, 0.5),
    p95Ms: percentile(absolute, 0.95),
    p99Ms: percentile(absolute, 0.99),
    maximumMs: absolute.length ? Math.max(...absolute) : null,
  };
  const checks = {
    duration: endMs - startMs >= thresholds.durationMs,
    coverage: coveragePercent >= 95,
    p95: stats.p95Ms !== null && stats.p95Ms <= 250,
    p99: stats.p99Ms !== null && stats.p99Ms <= 500,
    maximum: stats.maximumMs !== null && stats.maximumMs <= 750,
    consecutive: maximumConsecutiveOver500 <= 2,
  };
  return {
    state: !valid.length ? 'GAP' : Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
    durationMs: endMs - startMs,
    expectedSamples: expected,
    validSamples: valid.length,
    rejectedSamples: eligible.length - valid.length,
    excludedSamples: samples.filter((s) => excluded(s.atMs, exclusions)).length,
    missingSlots: expected - occupied.size,
    coveragePercent,
    ...stats,
    over250: absolute.filter((v) => v > 250).length,
    over500: absolute.filter((v) => v > 500).length,
    over750: absolute.filter((v) => v > 750).length,
    maximumConsecutiveOver500,
    checks,
    exclusions,
  };
}
