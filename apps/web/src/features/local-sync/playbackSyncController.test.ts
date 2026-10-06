import { describe, expect, it } from 'vitest';
import { command, FakePlaybackMedia, localId, playbackHarness } from '../../test/playback.ts';
import { formatPlaybackPosition, positionMilliseconds } from './playbackSyncController.ts';

describe('browser playback authority adapter', () => {
  it('preview events send no commands; prepare preserves position and leaves paused', async () => {
    const h = playbackHarness();
    await h.video.play();
    h.video.currentTime = 3.125;
    h.video.emit('seeked');
    h.video.pause();
    expect(h.commands()).toEqual([]);
    await h.c.playback.ready();
    expect(h.video.paused).toBe(true);
    expect(h.video.currentTime).toBe(3.125);
    expect(h.c.getState().localReady).toBe(true);
    expect(h.commands()).toEqual([]);
  });
  it('preparation rejection is sanitized and READY never sent', async () => {
    const h = playbackHarness();
    h.video.rejectPlay = true;
    await h.c.playback.ready();
    expect(h.c.getState().localReady).toBe(false);
    expect(h.sends.some((b) => b.type === 'READY')).toBe(false);
    expect(h.c.playback.getState().error).toBe(
      'Could not prepare synchronized playback. Try Ready again.',
    );
    expect(JSON.stringify(h.c.playback.getState())).not.toContain('private');
  });
  it('host baseline pauses current preview, revision 1, no duplicate internal event', async () => {
    const h = playbackHarness();
    await h.video.play();
    h.video.currentTime = 4;
    await h.activate();
    expect(h.video.paused).toBe(true);
    expect(h.video.currentTime).toBe(4);
    expect(h.commands()).toEqual([
      {
        type: 'PAUSE',
        payload: {
          localSelectionId: localId,
          remoteSelectionId: command('PAUSE', 1, 0).payload.localSelectionId,
          revision: 1,
          positionMs: 4000,
        },
      },
    ]);
    h.video.emit('pause');
    h.video.emit('seeked');
    expect(h.commands()).toHaveLength(2); // external committed seek
  });
  it('host Play Pause Seek produce one command each, preserve mode, no timeupdate traffic', async () => {
    const h = playbackHarness();
    await h.activate();
    await h.c.playback.play();
    expect(h.video.paused).toBe(false);
    h.c.playback.seek(5000);
    h.video.emit('seeked');
    expect(h.c.playback.getState().authority.mode).toBe('playing');
    h.c.playback.pause();
    h.c.playback.seek(3000);
    h.video.emit('seeked');
    expect(h.video.paused).toBe(true);
    expect(h.commands().map((b) => b.type)).toEqual(['PAUSE', 'PLAY', 'SEEK', 'PAUSE', 'SEEK']);
    h.video.emit('timeupdate');
    expect(h.commands()).toHaveLength(5);
  });
  it('host media-key play/pause/seek and ended observed once', async () => {
    const h = playbackHarness();
    await h.activate();
    await h.video.play();
    h.video.currentTime = 6;
    h.video.emit('seeked');
    h.video.pause();
    await h.video.play();
    h.video.currentTime = 10;
    h.video.paused = true;
    h.video.emit('ended');
    h.video.emit('pause');
    expect(h.commands().map((b) => b.type)).toEqual([
      'PAUSE',
      'PLAY',
      'SEEK',
      'PAUSE',
      'PLAY',
      'PAUSE',
    ]);
  });
  it('guest PLAY PAUSE and SEEK in both modes never echo', async () => {
    const h = playbackHarness('guest');
    await h.activate();
    h.c.receive(command('SEEK', 2, 4000));
    expect(h.video.paused).toBe(true);
    h.c.receive(command('PLAY', 3, 5000));
    await Promise.resolve();
    expect(h.video.paused).toBe(false);
    h.c.receive(command('SEEK', 4, 6000));
    expect(h.video.paused).toBe(false);
    h.c.receive(command('PAUSE', 5, 3000));
    expect(h.video.paused).toBe(true);
    expect(h.video.currentTime).toBe(3);
    for (const e of ['play', 'pause', 'seeking', 'seeked', 'ended']) h.video.emit(e);
    await h.c.playback.play();
    h.c.playback.pause();
    h.c.playback.seek(7000);
    expect(h.commands()).toEqual([]);
    expect(h.video.currentTime).toBe(3);
  });
  it('stale revision, stale pair and inactive commands cannot alter element', async () => {
    const h = playbackHarness('guest');
    await h.activate();
    h.c.receive(command('PLAY', 5, 5000));
    h.c.receive(command('PAUSE', 4, 1000));
    expect(h.video.paused).toBe(false);
    const old = command('SEEK', 6, 2000);
    h.c.receive({
      ...old,
      payload: {
        ...old.payload,
        remoteSelectionId: command('PLAY', 1, 0).payload.localSelectionId,
      },
    });
    expect(h.video.currentTime).toBe(5);
    h.c.dispatch({ type: 'not-ready' });
    h.c.receive(command('PLAY', 7, 7000));
    expect(h.video.paused).toBe(true);
    expect(h.video.currentTime).toBe(5);
  });
  it.each([10, 0, -10, Infinity, NaN])('duration %s clamps safely', async (duration) => {
    const h = playbackHarness('guest');
    await h.activate();
    h.video.duration = duration;
    h.c.receive(command('SEEK', 2, Number.MAX_SAFE_INTEGER));
    expect(Number.isFinite(h.video.currentTime)).toBe(true);
    expect(h.video.currentTime).toBeGreaterThanOrEqual(0);
    if (Number.isFinite(duration)) expect(h.video.currentTime).toBe(Math.max(0, duration));
  });
  it('DOM seek exception fails safe without retaining browser text', async () => {
    const h = playbackHarness('guest');
    await h.activate();
    Object.defineProperty(h.video, 'currentTime', {
      get: () => 2,
      set: () => {
        throw new Error('private path');
      },
    });
    expect(() => {
      h.c.receive(command('SEEK', 2, 4000));
    }).not.toThrow();
    expect(h.c.getState().localReady).toBe(false);
    expect(JSON.stringify(h.c.playback.getState())).not.toContain('private');
  });
  it('1x restored only in synchronized session; controls return on withdrawal', async () => {
    const h = playbackHarness();
    h.video.playbackRate = 2;
    h.video.emit('ratechange');
    expect(h.video.playbackRate).toBe(2);
    await h.activate();
    expect(h.video.playbackRate).toBe(1);
    expect(h.video.controls).toBe(false);
    h.video.playbackRate = 0.5;
    h.video.emit('ratechange');
    expect(h.video.playbackRate).toBe(1);
    h.c.dispatch({ type: 'not-ready' });
    expect(h.video.controls).toBe(true);
    h.video.playbackRate = 2;
    h.video.emit('ratechange');
    expect(h.video.playbackRate).toBe(2);
  });
  it.each(['withdraw', 'remote', 'clear', 'replace', 'error', 'peer'] as const)(
    '%s loss pauses immediately without authority command',
    async (kind) => {
      const h = playbackHarness();
      await h.activate();
      await h.c.playback.play();
      const before = h.commands().length;
      if (kind === 'withdraw') h.c.dispatch({ type: 'not-ready' });
      if (kind === 'remote')
        h.c.receive({
          type: 'NOT_READY',
          payload: {
            localSelectionId: command('PLAY', 1, 0).payload.localSelectionId,
            reason: 'PLAYBACK_UNAVAILABLE',
          },
        });
      if (kind === 'clear') h.c.dispatch({ type: 'clear' });
      if (kind === 'replace')
        h.c.dispatch({
          type: 'select',
          selectionId: command('PLAY', 1, 0).payload.localSelectionId,
          byteLength: 1,
        });
      if (kind === 'error')
        h.c.dispatch({ type: 'playback', selectionId: localId, status: 'error' });
      if (kind === 'peer') h.c.setChannel(undefined);
      expect(h.video.paused).toBe(true);
      expect(h.c.playback.getState().authority.active).toBe(false);
      expect(h.commands()).toHaveLength(before);
    },
  );
  it('remote PLAY rejection withdraws PLAYBACK_UNAVAILABLE and pauses', async () => {
    const h = playbackHarness('guest');
    await h.activate();
    h.video.rejectPlay = true;
    h.c.receive(command('PLAY', 2, 3000));
    await Promise.resolve();
    expect(h.video.paused).toBe(true);
    expect(h.c.playback.getState().authority.active).toBe(false);
    expect(h.sends.at(-1)).toEqual({
      type: 'NOT_READY',
      payload: { localSelectionId: localId, reason: 'PLAYBACK_UNAVAILABLE' },
    });
    expect(h.c.getState().local?.playback).toBe('ready');
    expect(JSON.stringify(h.c.playback.getState())).not.toContain('private');
  });
  it('detached stale callbacks and asynchronous play completion powerless', async () => {
    const h = playbackHarness();
    let resolve: (() => void) | undefined;
    h.video.pendingPlay = new Promise<void>((r) => {
      resolve = r;
    });
    const preparation = h.c.playback.ready();
    h.c.playback.attach(null, localId);
    const newer = new FakePlaybackMedia();
    h.c.playback.attach(newer, localId);
    resolve?.();
    await preparation;
    h.video.emit('play');
    h.video.emit('seeked');
    expect(h.commands()).toEqual([]);
    expect(h.c.getState().localReady).toBe(false);
    expect(newer.paused).toBe(true);
    h.c.playback.shutdown();
    newer.emit('play');
    expect(h.commands()).toEqual([]);
  });
  it('same healthy channel preserves authority and preparation without additional play calls', async () => {
    const h = playbackHarness();
    await h.activate();
    await h.c.playback.play();
    const state = h.c.playback.getState().authority;
    const count = h.video.plays;
    h.c.setChannel((body) => {
      h.sends.push(body);
      return true;
    });
    expect(h.c.playback.getState().authority).toBe(state);
    expect(h.video.plays).toBe(count);
    expect(h.video.paused).toBe(false);
  });
  it('re-ready establishes a new revision 1 paused baseline', async () => {
    const h = playbackHarness();
    await h.activate();
    await h.c.playback.play();
    h.c.dispatch({ type: 'not-ready' });
    await h.c.playback.ready();
    expect(h.c.playback.getState().authority.revision).toBe(1);
    expect(h.video.paused).toBe(true);
    expect(h.commands().at(-1)?.type).toBe('PAUSE');
  });
  it('conversion and time formatting are deterministic', () => {
    expect(positionMilliseconds(1.2346)).toBe(1235);
    expect(positionMilliseconds(NaN)).toBe(0);
    expect(positionMilliseconds(Infinity)).toBe(0);
    expect(positionMilliseconds(-1)).toBe(0);
    expect(formatPlaybackPosition(61001)).toBe('1:01');
  });
});

it('pending PLAY rejection after a newer SEEK still withdraws the playing intent', async () => {
  const h = playbackHarness('guest');
  await h.activate();
  let reject: ((error: Error) => void) | undefined;
  h.video.pendingPlay = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  h.c.receive(command('PLAY', 2, 3000));
  h.c.receive(command('SEEK', 3, 4000));
  reject?.(new Error('private'));
  await Promise.resolve();
  expect(h.c.getState().localReady).toBe(false);
  expect(h.video.paused).toBe(true);
});
it('old PLAY rejection cannot withdraw a newer Ready cycle with reused revisions', async () => {
  const h = playbackHarness('guest');
  await h.activate();
  let reject: ((error: Error) => void) | undefined;
  h.video.pendingPlay = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  h.c.receive(command('PLAY', 2, 3000));
  h.c.dispatch({ type: 'not-ready' });
  h.video.pendingPlay = null;
  await h.c.playback.ready();
  h.c.receive(command('PAUSE', 1, 4000));
  h.c.receive(command('PLAY', 2, 4000));
  reject?.(new Error('private'));
  await Promise.resolve();
  expect(h.c.getState().localReady).toBe(true);
  expect(h.c.playback.getState().error).toBeNull();
  expect(h.video.paused).toBe(false);
});
it('late PLAY fulfillment after PAUSE stays paused with no echo or retry', async () => {
  const h = playbackHarness('guest');
  await h.activate();
  let resolve: (() => void) | undefined;
  h.video.pendingPlay = new Promise<void>((done) => {
    resolve = done;
  });
  h.c.receive(command('PLAY', 2, 3000));
  h.c.receive(command('PAUSE', 3, 4000));
  resolve?.();
  await Promise.resolve();
  expect(h.video.paused).toBe(true);
  expect(h.commands()).toEqual([]);
});

it('guest baseline wait preserves preview rate until authority activates', async () => {
  const h = playbackHarness('guest');
  h.video.playbackRate = 2;
  await h.c.playback.ready();
  h.peerReady();
  expect(h.c.playback.getState().authority.active).toBe(false);
  expect(h.video.playbackRate).toBe(2);
  h.c.receive(command('PAUSE', 1, 2500));
  expect(h.video.playbackRate).toBe(1);
});
