import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, measure, percentile, excluded, summarize } from './metrics.mjs';
const o = (beforeMs, afterMs, currentTime = 1, paused = false, playbackRate = 1) => ({
  beforeMs,
  afterMs,
  currentTime,
  paused,
  playbackRate,
});
const run = (samples, exclusions = []) =>
  summarize(samples, { startMs: 0, endMs: 1800000, exclusions });
const clean = () =>
  Array.from({ length: 1800 }, (_, i) => ({ atMs: i * 1000, valid: true, driftMs: 10 }));
test('projects simultaneous positions from sequential observations', () =>
  assert.equal(measure(o(0, 20, 1), o(100, 120, 1.1)).driftMs, 0));
test('paused projection stays fixed; rate scales elapsed', () => {
  assert.equal(project(o(0, 20, 1, true), 110), 1000);
  assert.equal(project(o(0, 20, 1, false, 1.05), 110), 1105);
});
test('rejects browser evaluation over 100 ms', () =>
  assert.deepEqual(measure(o(0, 101), o(0, 10)).reasons, ['evaluation_rtt']));
test('rejects effective separation over 200 ms', () =>
  assert.deepEqual(measure(o(0, 10), o(201, 211)).reasons, ['observation_separation']));
test('accepts exact rejection boundaries', () =>
  assert.equal(measure(o(0, 100), o(100, 200)).valid, true));
test('rejects invalid observations', () => assert.equal(measure(o(10, 0), o(0, 10)).valid, false));
test('nearest rank percentiles and empty input', () => {
  assert.equal(percentile([4, 1, 3, 2], 0.5), 2);
  assert.equal(percentile([4, 1, 3, 2], 0.99), 4);
  assert.equal(percentile([], 0.95), null);
});
test('exclusions are explicit, half-open and union counted', () => {
  const windows = [
    { startMs: 0, endMs: 10000, reason: 'PLAY' },
    { startMs: 0, endMs: 5000, reason: 'overlap' },
  ];
  const s = clean();
  s[0].driftMs = 1500;
  assert.equal(excluded(10000, windows), false);
  assert.equal(run(s, windows).expectedSamples, 1790);
  assert.equal(run(s, windows).over750, 0);
});
test('three consecutive over 500 fail even when percentiles pass', () => {
  const s = clean();
  for (let i = 1; i < 4; i++) s[i].driftMs = 501;
  assert.equal(run(s).maximumConsecutiveOver500, 3);
  assert.equal(run(s).state, 'FAIL');
});
test('rejections do not enter drift stats but reduce coverage', () => {
  const s = clean();
  for (let i = 0; i < 91; i++) Object.assign(s[i], { valid: false, driftMs: 9999 });
  const r = run(s);
  assert.equal(r.rejectedSamples, 91);
  assert.equal(r.maximumMs, 10);
  assert.equal(r.state, 'FAIL');
});
test('coverage counts missing slots and ignores duplicate inflation', () => {
  const s = clean().slice(90);
  const r = run([...s, s[0]]);
  assert.equal(r.coveragePercent, 95);
  assert.equal(r.missingSlots, 90);
  assert.equal(r.state, 'PASS');
});
test('summary PASS, FAIL and GAP; short real runs fail', () => {
  assert.equal(run(clean()).state, 'PASS');
  const s = clean();
  s[0].driftMs = -751;
  assert.equal(run(s).state, 'FAIL');
  assert.equal(run([]).state, 'GAP');
  assert.equal(summarize(clean(), { startMs: 0, endMs: 10000 }).state, 'FAIL');
});

test('rejected samples never erase a high-drift sequence', () => {
  const s = clean();
  s[0].driftMs = 501;
  s[1].valid = false;
  s[2].driftMs = 501;
  s[3].driftMs = 501;
  assert.equal(run(s).maximumConsecutiveOver500, 3);
  assert.equal(run(s).state, 'FAIL');
});
