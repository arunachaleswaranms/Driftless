import { describe, expect, it } from 'vitest';
import { MAX_SYNC_CLOCK_MS, type SyncHeartbeat } from '@driftless/protocol';
import {
  clockSample,
  SyncClock,
  projectPosition,
  driftPolicy,
  eligibleHeartbeat,
  type DriftCorrection,
  type PlaybackSyncState,
} from '../src/index.js';
const heartbeat = {
  phase: 'HEARTBEAT',
  syncSequence: 1,
  revision: 8,
  mode: 'playing',
  localSelectionId: 'A',
  remoteSelectionId: 'B',
  localReadinessId: 'H1',
  remoteReadinessId: 'G1',
  positionMs: 5000,
  capturedAtMs: 1000,
  clockOffsetMs: 5000,
  roundTripMs: 100,
} as SyncHeartbeat & { clockOffsetMs: number; roundTripMs: number };
const state = {
  active: true,
  revision: 8,
  mode: 'playing',
  positionMs: 5000,
  pair: {
    localSelectionId: heartbeat.remoteSelectionId,
    remoteSelectionId: heartbeat.localSelectionId,
    localReadinessId: heartbeat.remoteReadinessId,
    remoteReadinessId: heartbeat.localReadinessId,
  },
} satisfies PlaybackSyncState;
describe('clock math and bounded sample state', () => {
  it.each([
    [1000, 6050, 6070, 1120, 5000, 100],
    [100, 80, 90, 170, -50, 60],
    [0, 10, 10, 21, 0, 21],
    [0, 2000, 2000, 4000, 0, 4000],
  ])('independent vector %s %s %s %s', (t1, t2, t3, t4, offsetMs, roundTripMs) => {
    expect(clockSample(t1, t2, t3, t4)).toEqual({ offsetMs, roundTripMs });
  });
  it.each([
    [1000, 6050, 6049, 1120],
    [1000, 6050, 6070, 999],
    [1000, 6050, 6200, 1120],
    [1000, 6050, 6070, 5021],
    [Number.MAX_SAFE_INTEGER + 1, 0, 0, 0],
    [MAX_SYNC_CLOCK_MS + 1, 0, 0, 0],
    [0, MAX_SYNC_CLOCK_MS + 1, 0, 0],
    [0, 0, MAX_SYNC_CLOCK_MS + 1, 0],
    [0, 0, 0, MAX_SYNC_CLOCK_MS + 1],
    [-1, 0, 0, 0],
    [0, 0.5, 1, 2],
  ])('invalid sample ignored %s %s %s %s', (t1, t2, t3, t4) => {
    expect(clockSample(t1, t2, t3, t4)).toBeNull();
  });
  it('prunes oldest pending, consumes duplicate/invalid probes, ignores missing, reset cycle', () => {
    const c = new SyncClock();
    for (let seq = 1; seq <= 9; seq++) c.capture(seq, 1000);
    expect(c.pendingCount).toBe(8);
    c.observe(1, 6050, 6070, 1120);
    c.observe(99, 6050, 6070, 1120);
    expect(c.sampleCount).toBe(0);
    c.observe(2, 6050, 6070, 1120);
    c.observe(2, 7050, 7070, 1120);
    expect(c.sampleCount).toBe(1);
    expect(c.estimate?.offsetMs).toBe(5000);
    c.observe(3, 6050, 6049, 1120);
    expect(c.pendingCount).toBe(6);
    c.reset();
    c.observe(4, 6050, 6070, 1120);
    expect(c.pendingCount).toBe(0);
    expect(c.sampleCount).toBe(0);
  });
  it('lowest RTT selected, oldest valid sample evicted at eight; poor samples retain estimate', () => {
    const c = new SyncClock();
    for (const [seq, rtt, offset] of [
      [1, 100, 5000],
      [2, 40, 6000],
      [3, 80, 7000],
    ] as const) {
      c.capture(seq, 1000);
      c.observe(seq, 1000 + offset + rtt / 2, 1000 + offset + rtt / 2, 1000 + rtt);
    }
    expect(c.estimate).toEqual({ offsetMs: 6000, roundTripMs: 40 });
    for (let seq = 4; seq <= 9; seq++) {
      c.capture(seq, 1000);
      c.observe(seq, 1100, 1100, 1200);
    }
    expect(c.sampleCount).toBe(8);
    expect(c.estimate?.roundTripMs).toBe(40);
    c.capture(10, 1000);
    c.observe(10, 1100, 1100, 1200);
    expect(c.sampleCount).toBe(8);
    expect(c.estimate?.roundTripMs).toBe(80);
    c.capture(11, 1000);
    c.observe(11, 1000, 1000, 6000);
    expect(c.sampleCount).toBe(8);
    expect(c.estimate?.roundTripMs).toBe(80);
  });
});
describe('projection and authority eligibility', () => {
  it('exact guest-domain projection and paused position without estimate', () => {
    expect(projectPosition(heartbeat, 6200)).toBe(5200);
    expect(
      projectPosition(
        { ...heartbeat, mode: 'paused', clockOffsetMs: null, roundTripMs: null },
        6200,
      ),
    ).toBe(5000);
    expect(projectPosition(heartbeat, 10000)).toBe(9000);
  });
  it.each([5999, 10001, MAX_SYNC_CLOCK_MS + 1, Number.MAX_SAFE_INTEGER + 1])(
    'invalid elapsed %s',
    (t2) => {
      expect(projectPosition(heartbeat, t2)).toBeNull();
    },
  );
  it('no estimate or unsafe arithmetic means observe only', () => {
    expect(
      projectPosition({ ...heartbeat, clockOffsetMs: null, roundTripMs: null }, 6200),
    ).toBeNull();
    expect(projectPosition({ ...heartbeat, positionMs: Number.MAX_SAFE_INTEGER }, 6200)).toBeNull();
    expect(
      projectPosition({ ...heartbeat, clockOffsetMs: Number.MAX_SAFE_INTEGER }, 6200),
    ).toBeNull();
    expect(projectPosition({ ...heartbeat, roundTripMs: 4001 }, 6200)).toBeNull();
  });
  it.each([7, 8, 9])('revision %s cannot substitute for discrete command', (revision) => {
    expect(eligibleHeartbeat(state, { ...heartbeat, revision })).toBe(revision === 8);
    expect(state.revision).toBe(8);
  });
  it('mode, inactive authority and old H1/G1 against H1/G2 lose before revision', () => {
    expect(eligibleHeartbeat(state, { ...heartbeat, mode: 'paused' })).toBe(false);
    expect(eligibleHeartbeat({ ...state, mode: 'paused' }, heartbeat)).toBe(false);
    expect(eligibleHeartbeat({ ...state, active: false }, heartbeat)).toBe(false);
    expect(
      eligibleHeartbeat(
        {
          ...state,
          pair: { ...state.pair, localReadinessId: 'G2' as typeof heartbeat.remoteReadinessId },
        },
        { ...heartbeat, syncSequence: 99999 },
      ),
    ).toBe(false);
  });
});
describe('pure drift boundaries and convergence', () => {
  it.each([
    [0, 'NORMAL_RATE'],
    [50, 'NORMAL_RATE'],
    [-50, 'NORMAL_RATE'],
    [75, 'NORMAL_RATE'],
    [-75, 'NORMAL_RATE'],
    [149, 'NORMAL_RATE'],
    [-149, 'NORMAL_RATE'],
    [150, 'SLOW_DOWN'],
    [-150, 'SPEED_UP'],
    [749, 'SLOW_DOWN'],
    [-749, 'SPEED_UP'],
    [750, 'SEEK'],
    [-750, 'SEEK'],
  ] as const)('drift %s → %s', (drift, expected) => {
    expect(driftPolicy('playing', drift, 'NORMAL_RATE')).toBe(expected);
  });
  it('hysteresis retains direction below start; settles inclusively and normalizes sign crossing first', () => {
    expect(driftPolicy('playing', -76, 'SPEED_UP')).toBe('SPEED_UP');
    expect(driftPolicy('playing', 76, 'SLOW_DOWN')).toBe('SLOW_DOWN');
    expect(driftPolicy('playing', -75, 'SPEED_UP')).toBe('NORMAL_RATE');
    expect(driftPolicy('playing', 75, 'SLOW_DOWN')).toBe('NORMAL_RATE');
    expect(driftPolicy('playing', 200, 'SPEED_UP')).toBe('NORMAL_RATE');
    expect(driftPolicy('playing', -200, 'SLOW_DOWN')).toBe('NORMAL_RATE');
    expect(driftPolicy('playing', 750, 'SPEED_UP')).toBe('SEEK');
    expect(driftPolicy('playing', -750, 'SLOW_DOWN')).toBe('SEEK');
    expect(driftPolicy('playing', NaN, 'SPEED_UP')).toBe('NONE');
  });
  it.each([99, -99, 100, -100])('paused boundary %s', (drift) => {
    expect(driftPolicy('paused', drift, 'SPEED_UP')).toBe(
      Math.abs(drift) >= 100 ? 'SEEK' : 'NORMAL_RATE',
    );
  });
  it.each([-300, 300])('fake 500ms media steps converge from %s and normalize', (initial) => {
    let drift = initial;
    let correction: DriftCorrection = 'NORMAL_RATE';
    for (let tick = 0; tick < 12; tick++) {
      const decision = driftPolicy('playing', drift, correction);
      expect(decision).not.toBe('SEEK');
      if (decision === 'SPEED_UP' || decision === 'SLOW_DOWN' || decision === 'NORMAL_RATE')
        correction = decision;
      drift += correction === 'SPEED_UP' ? 25 : correction === 'SLOW_DOWN' ? -25 : 0;
    }
    expect(Math.abs(drift)).toBe(75);
    expect(correction).toBe('NORMAL_RATE');
  });
});
