import { describe, expect, it } from 'vitest';
import type { SyncHeartbeat, SyncObservation, SyncBody } from '@driftless/protocol';
import { playbackHarness, readinessId } from '../../test/playback.ts';
import type { SyncAdapters } from './continuousSyncController.ts';
function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('Missing test fixture.');
  return value;
}
class FakeTime implements SyncAdapters {
  now = 1000;
  next = 0;
  maxTimers = 0;
  readonly timers = new Map<number, () => void>();
  monotonicMs = () => this.now;
  setTimeout = (callback: () => void, delay: number) => {
    expect(delay).toBe(500);
    const id = ++this.next;
    this.timers.set(id, callback);
    this.maxTimers = Math.max(this.maxTimers, this.timers.size);
    return id;
  };
  clearTimeout = (handle: unknown) => {
    this.timers.delete(handle as number);
  };
  tick() {
    this.now += 500;
    const entries = [...this.timers];
    this.timers.clear();
    for (const [, cb] of entries) cb();
  }
}
const syncSends = (h: ReturnType<typeof playbackHarness>) =>
  h.sends.filter((b): b is SyncBody => b.type === 'SYNC');
function heartbeat(
  h: ReturnType<typeof playbackHarness>,
  overrides: Partial<SyncHeartbeat> = {},
): SyncHeartbeat {
  return {
    ...h.command('PLAY', 2, 2500).payload,
    phase: 'HEARTBEAT',
    mode: 'playing',
    syncSequence: 1,
    capturedAtMs: 1000,
    clockOffsetMs: 0,
    roundTripMs: 0,
    ...overrides,
  } as SyncHeartbeat;
}
function observation(p: SyncHeartbeat, received: number, sent = received): SyncObservation {
  return {
    phase: 'OBSERVATION',
    localSelectionId: p.remoteSelectionId,
    remoteSelectionId: p.localSelectionId,
    localReadinessId: p.remoteReadinessId,
    remoteReadinessId: p.localReadinessId,
    syncSequence: p.syncSequence,
    guestReceivedAtMs: received,
    guestSentAtMs: sent,
  };
}
describe('continuous browser adapter', () => {
  it('baseline starts one host timer, coherent first null estimate, next heartbeat returns estimate; host untouched', async () => {
    const time = new FakeTime();
    const h = playbackHarness('host', time);
    time.tick();
    expect(syncSends(h)).toEqual([]);
    await h.activate();
    expect(time.timers.size).toBe(1);
    time.tick();
    const p = required(syncSends(h)[0]).payload as SyncHeartbeat;
    expect(p).toMatchObject({
      syncSequence: 1,
      revision: 1,
      mode: 'paused',
      positionMs: 2500,
      capturedAtMs: 2000,
      clockOffsetMs: null,
      roundTripMs: null,
    });
    const authority = h.c.playback.getState().authority;
    const plays = h.video.plays;
    const pauses = h.video.pauses;
    time.now = 2120;
    h.c.receive({ type: 'SYNC', payload: observation(p, 7050, 7070) });
    expect(h.c.playback.continuous.getState()).toMatchObject({
      pendingCount: 0,
      sampleCount: 1,
      bestRoundTripMs: 100,
    });
    time.tick();
    expect(syncSends(h).at(-1)?.payload).toMatchObject({
      clockOffsetMs: 5000,
      roundTripMs: 100,
      revision: 1,
      syncSequence: 2,
    });
    expect(h.c.playback.getState().authority).toBe(authority);
    expect(h.video.currentTime).toBe(2.5);
    expect(h.video.playbackRate).toBe(1);
    expect(h.video.plays).toBe(plays);
    expect(h.video.pauses).toBe(pauses);
    expect(h.commands()).toHaveLength(1);
    h.c.shutdown();
    expect(time.timers.size).toBe(0);
  });
  it('ten simulated minutes / 1200 heartbeats bound timer, pending and sample state, signaling preserves; final cleanup', async () => {
    const time = new FakeTime();
    const h = playbackHarness('host', time);
    await h.activate();
    let maxPending = 0,
      maxSamples = 0;
    for (let tick = 1; tick <= 1200; tick++) {
      time.tick();
      const p = required(syncSends(h).at(-1)).payload as SyncHeartbeat;
      expect(p.syncSequence).toBe(tick);
      maxPending = Math.max(maxPending, h.c.playback.continuous.getState().pendingCount);
      // First 20 probes deliberately unanswered to exercise prune bound.
      if (tick > 20) {
        time.now += 20;
        h.c.receive({ type: 'SYNC', payload: observation(p, p.capturedAtMs + 5010) });
        time.now -= 20;
      }
      maxSamples = Math.max(maxSamples, h.c.playback.continuous.getState().sampleCount);
      if (tick % 10 === 0)
        h.c.setChannel((body) => {
          h.sends.push(body);
          return true;
        });
      expect(time.timers.size).toBe(1);
    }
    expect(syncSends(h)).toHaveLength(1200);
    expect(time.maxTimers).toBe(1);
    expect(maxPending).toBe(8);
    expect(maxSamples).toBe(8);
    h.c.dispatch({ type: 'not-ready' });
    expect(time.timers.size).toBe(0);
    expect(h.c.playback.continuous.getState()).toMatchObject({
      pendingCount: 0,
      sampleCount: 0,
      nextSyncSequence: 1,
      hasClockEstimate: false,
      correction: 'NORMAL_RATE',
    });
    await h.c.playback.ready();
    time.tick();
    expect(syncSends(h).at(-1)?.payload).toMatchObject({ syncSequence: 1, clockOffsetMs: null });
    h.c.shutdown();
    expect(time.timers.size).toBe(0);
  });
  it.each([-50, 50, -350, 350, -1500, 1500])(
    'guest perturbation %s applies only local correction and one observation',
    async (drift) => {
      const time = new FakeTime();
      const h = playbackHarness('guest', time);
      await h.activate();
      h.c.receive(h.command('PLAY', 2, 2500));
      h.video.currentTime = 2.5 + drift / 1000;
      const authority = h.c.playback.getState().authority;
      h.c.receive({ type: 'SYNC', payload: heartbeat(h) });
      expect(h.video.playbackRate).toBe(
        Math.abs(drift) >= 750 || Math.abs(drift) <= 75 ? 1 : drift < 0 ? 1.05 : 0.95,
      );
      if (Math.abs(drift) >= 750) expect(h.video.currentTime).toBe(2.5);
      expect(h.video.paused).toBe(false);
      expect(h.commands()).toEqual([]);
      expect(syncSends(h)).toHaveLength(1);
      expect(syncSends(h)[0]?.payload).toMatchObject({
        phase: 'OBSERVATION',
        guestReceivedAtMs: 1000,
        guestSentAtMs: 1000,
        syncSequence: 1,
      });
      expect(h.c.playback.getState().authority).toBe(authority);
      expect(time.timers.size).toBe(0);
      h.video.emit('seeked');
      expect(h.commands()).toEqual([]);
    },
  );
  it.each([99, 100, -100])(
    'paused drift %s aligns only at threshold without play',
    async (drift) => {
      const h = playbackHarness('guest', new FakeTime());
      await h.activate();
      h.video.currentTime = 2.5 + drift / 1000;
      const plays = h.video.plays;
      h.c.receive({
        type: 'SYNC',
        payload: heartbeat(h, {
          revision: 1,
          mode: 'paused',
          clockOffsetMs: null,
          roundTripMs: null,
        }),
      });
      expect(h.video.currentTime).toBe(Math.abs(drift) >= 100 ? 2.5 : 2.599);
      expect(h.video.paused).toBe(true);
      expect(h.video.plays).toBe(plays);
      expect(h.video.playbackRate).toBe(1);
    },
  );
  it('playing without estimate/invalid projection observes once but cannot correct; duplicate powerless', async () => {
    const h = playbackHarness('guest', new FakeTime());
    await h.activate();
    h.c.receive(h.command('PLAY', 2, 2500));
    h.video.currentTime = 1;
    for (const [i, overrides] of [
      { clockOffsetMs: null, roundTripMs: null },
      { clockOffsetMs: 5000 },
      { capturedAtMs: 0, clockOffsetMs: -5000 },
    ].entries()) {
      h.c.receive({ type: 'SYNC', payload: heartbeat(h, { syncSequence: i + 1, ...overrides }) });
      expect(h.video.currentTime).toBe(1);
      expect(h.video.playbackRate).toBe(1);
    }
    expect(syncSends(h)).toHaveLength(3);
    h.c.receive({ type: 'SYNC', payload: heartbeat(h, { syncSequence: 3 }) });
    expect(syncSends(h)).toHaveLength(3);
  });
  it.each(['PLAY', 'PAUSE', 'SEEK'] as const)(
    'new %s immediately overrides correction',
    async (type) => {
      const h = playbackHarness('guest', new FakeTime());
      await h.activate();
      h.c.receive(h.command('PLAY', 2, 2500));
      h.video.currentTime = 2.15;
      h.c.receive({ type: 'SYNC', payload: heartbeat(h) });
      expect(h.video.playbackRate).toBe(1.05);
      h.c.receive(h.command(type, 3, 4000));
      expect(h.video.playbackRate).toBe(1);
      expect(h.video.currentTime).toBe(4);
    },
  );
  it.each(['withdraw', 'clear', 'replace', 'error', 'mismatch', 'peer', 'shutdown'] as const)(
    '%s clears timer/estimate/rate and stale callback powerless',
    async (kind) => {
      const time = new FakeTime();
      const h = playbackHarness('host', time);
      await h.activate();
      const callback = required([...time.timers.values()][0]);
      const lose = (h: ReturnType<typeof playbackHarness>) => {
        if (kind === 'withdraw') h.c.dispatch({ type: 'not-ready' });
        if (kind === 'clear') h.c.dispatch({ type: 'clear' });
        if (kind === 'replace')
          h.c.playback.attach(null, required(h.c.getState().local).selectionId);
        if (kind === 'error')
          h.c.dispatch({
            type: 'playback',
            selectionId: required(h.c.getState().local).selectionId,
            status: 'error',
          });
        if (kind === 'peer') h.c.setChannel(undefined);
        if (kind === 'shutdown') h.c.shutdown();
        if (kind === 'mismatch') {
          const pair = h.command('PAUSE', 1, 0).payload;
          h.c.receive({
            type: 'MEDIA_MISMATCH',
            payload: {
              localSelectionId: pair.localSelectionId,
              remoteSelectionId: pair.remoteSelectionId,
              reason: 'IDENTITY_MISMATCH',
            },
          });
        }
      };
      lose(h);
      expect(time.timers.size).toBe(0);
      callback();
      expect(syncSends(h)).toEqual([]);
      expect(h.c.playback.continuous.getState()).toMatchObject({
        pendingCount: 0,
        sampleCount: 0,
        hasClockEstimate: false,
      });
      const guest = playbackHarness('guest', new FakeTime());
      await guest.activate();
      guest.c.receive(guest.command('PLAY', 2, 2500));
      guest.video.currentTime = 2.15;
      guest.c.receive({ type: 'SYNC', payload: heartbeat(guest) });
      expect(guest.video.playbackRate).toBe(1.05);
      lose(guest);
      expect(guest.video.playbackRate).toBe(1);
      expect(guest.video.paused).toBe(true);
    },
  );
  it('stale H1/G1 heartbeat and observation cannot cross H1/G2; revision/mode mismatch does not advance state', async () => {
    const h = playbackHarness('guest', new FakeTime());
    await h.activate();
    const old = heartbeat(h, { mode: 'paused', revision: 1, syncSequence: 999, positionMs: 6000 });
    h.c.dispatch({ type: 'not-ready' });
    await h.c.playback.ready();
    h.c.receive(h.command('PAUSE', 1, 2500));
    h.c.receive({ type: 'SYNC', payload: old });
    expect(h.video.currentTime).toBe(2.5);
    expect(syncSends(h)).toHaveLength(0);
    for (const [index, overrides] of [
      { revision: 2 },
      { revision: 3 },
      { mode: 'playing' as const },
    ].entries())
      h.c.receive({
        type: 'SYNC',
        payload: heartbeat(h, {
          revision: 1,
          mode: 'paused',
          positionMs: 6000,
          syncSequence: index + 1,
          ...overrides,
        }),
      });
    expect(h.video.currentTime).toBe(2.5);
    expect(h.c.playback.getState().authority.revision).toBe(1);
    h.c.receive({
      type: 'SYNC',
      payload: heartbeat(h, { revision: 1, mode: 'paused', positionMs: 6000, syncSequence: 4 }),
    });
    expect(h.video.currentTime).toBe(6);
    const time = new FakeTime();
    const host = playbackHarness('host', time);
    await host.activate();
    time.tick();
    const p = required(syncSends(host).at(-1)).payload as SyncHeartbeat;
    const obs = observation(p, time.now);
    host.c.receive({ type: 'SYNC', payload: { ...obs, localReadinessId: readinessId(99) } });
    expect(host.c.playback.continuous.getState().sampleCount).toBe(0);
    host.c.dispatch({ type: 'not-ready' });
    await host.c.playback.ready();
    time.tick();
    host.c.receive({ type: 'SYNC', payload: obs });
    expect(host.c.playback.continuous.getState().sampleCount).toBe(0);
    host.c.shutdown();
  });
});

it('synchronous healthy-channel reconciliation inside heartbeat send retains one scheduler', async () => {
  const time = new FakeTime();
  const h = playbackHarness('host', time);
  await h.activate();
  const sender = (body: import('@driftless/protocol').ApplicationBody) => {
    h.sends.push(body);
    if (body.type === 'SYNC') h.c.setChannel(sender);
    return true;
  };
  h.c.setChannel(sender);
  time.tick();
  expect(time.timers.size).toBe(1);
  expect(time.maxTimers).toBe(1);
  h.c.shutdown();
  expect(time.timers.size).toBe(0);
});

it('healthy-channel signaling report preserves an active guest rate correction and current Ready IDs/revision', async () => {
  const h = playbackHarness('guest', new FakeTime());
  await h.activate();
  h.c.receive(h.command('PLAY', 2, 2500));
  h.video.currentTime = 2.15;
  h.c.receive({ type: 'SYNC', payload: heartbeat(h) });
  const diagnostic = h.c.playback.continuous.getState();
  const authority = h.c.playback.getState().authority;
  const ids = [h.c.getState().localReadinessId, h.c.getState().remoteReadinessId];
  h.c.setChannel((body) => {
    h.sends.push(body);
    return true;
  });
  expect(h.c.playback.continuous.getState()).toEqual(diagnostic);
  expect(h.c.playback.getState().authority).toBe(authority);
  expect([h.c.getState().localReadinessId, h.c.getState().remoteReadinessId]).toEqual(ids);
  expect(h.video.playbackRate).toBe(1.05);
  expect(h.video.paused).toBe(false);
  h.video.currentTime = 2.4;
  h.c.receive({ type: 'SYNC', payload: heartbeat(h, { syncSequence: 2 }) });
  expect(h.video.playbackRate).toBe(1.05);
  h.c.shutdown();
  expect(h.video.playbackRate).toBe(1);
});
