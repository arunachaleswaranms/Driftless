import { describe, expect, it } from 'vitest';
import type { MediaSelectionId, MediaFingerprint, PlaybackBody } from '@driftless/protocol';
import {
  initialPlaybackState,
  playbackReadiness,
  hostPlayback,
  guestPlayback,
  reduceLocalSync,
  type LocalSyncState,
} from '../src/index.js';
const local = 'A'.repeat(22) as MediaSelectionId;
const remote = ('B'.repeat(21) + 'A') as MediaSelectionId;
const fingerprint = 'A'.repeat(43) as MediaFingerprint;
const ready: LocalSyncState = {
  connected: true,
  local: {
    selectionId: local,
    byteLength: 1,
    playback: 'ready',
    fingerprint,
    progress: 100,
    failure: null,
  },
  remote: { selectionId: remote, byteLength: 1, fingerprintVersion: 1, fingerprint },
  peerMatched: true,
  localReady: true,
  remoteReady: true,
};
const waiting = () => playbackReadiness(initialPlaybackState, ready);
const baseline = () => hostPlayback(waiting(), 'host', 'PAUSE', 2500);
const incoming = (
  type: PlaybackBody['type'],
  revision: number,
  positionMs = 3000,
): PlaybackBody => ({
  type,
  payload: { localSelectionId: remote, remoteSelectionId: local, revision, positionMs },
});
describe('pure playback authority', () => {
  it('initial inactive, no commands or readiness resurrection', () => {
    expect(initialPlaybackState.active).toBe(false);
    expect(hostPlayback(initialPlaybackState, 'host', 'PAUSE', 0).command).toBeNull();
    expect(guestPlayback(initialPlaybackState, incoming('PLAY', 5))).toBe(initialPlaybackState);
  });
  it('host activation establishes PAUSE revision 1 at current position', () => {
    expect(baseline()).toEqual({
      state: {
        active: true,
        pair: { localSelectionId: local, remoteSelectionId: remote },
        revision: 1,
        mode: 'paused',
        positionMs: 2500,
      },
      command: {
        type: 'PAUSE',
        payload: {
          localSelectionId: local,
          remoteSelectionId: remote,
          revision: 1,
          positionMs: 2500,
        },
      },
    });
  });
  it('guest waits for exact PAUSE revision 1 baseline', () => {
    const s = waiting();
    expect(s.active).toBe(false);
    for (const cmd of [incoming('PLAY', 1), incoming('SEEK', 1), incoming('PAUSE', 2)])
      expect(guestPlayback(s, cmd)).toBe(s);
    expect(guestPlayback(s, incoming('PAUSE', 1)).active).toBe(true);
  });
  it.each(['PLAY', 'PAUSE', 'SEEK'] as const)(
    'host %s increments; guest is never authority',
    (type) => {
      const s = baseline().state;
      expect(hostPlayback(s, 'host', type, 4000).state.revision).toBe(2);
      expect(hostPlayback(s, 'guest', type, 4000).command).toBeNull();
    },
  );
  it.each(['paused', 'playing'] as const)('SEEK preserves %s', (mode) => {
    const s = { ...baseline().state, mode };
    expect(hostPlayback(s, 'host', 'SEEK', 5000).state.mode).toBe(mode);
    expect(guestPlayback(s, incoming('SEEK', 2)).mode).toBe(mode);
  });
  it('stale revisions cannot pause newer authority; gaps need no repair', () => {
    const playing = guestPlayback(baseline().state, incoming('PLAY', 5));
    expect(guestPlayback(playing, incoming('PAUSE', 4))).toBe(playing);
    expect(guestPlayback(playing, incoming('SEEK', 5))).toBe(playing);
    expect(guestPlayback(playing, incoming('PAUSE', 9)).revision).toBe(9);
  });
  it('stale pair ignored', () => {
    const s = baseline().state;
    expect(
      guestPlayback(s, {
        ...incoming('PLAY', 2),
        payload: { ...incoming('PLAY', 2).payload, localSelectionId: local },
      }),
    ).toBe(s);
  });
  it.each(['localReady', 'remoteReady', 'connected', 'peerMatched'] as const)(
    '%s loss deactivates, reactivation starts revision 1',
    (field) => {
      const s = playbackReadiness(baseline().state, { ...ready, [field]: false });
      expect(s).toBe(initialPlaybackState);
      expect(guestPlayback(s, incoming('PLAY', 10))).toBe(s);
      expect(hostPlayback(playbackReadiness(s, ready), 'host', 'PAUSE', 6000).state.revision).toBe(
        1,
      );
    },
  );
  it('fresh peer resets while same healthy channel/signaling preservation has no effect', () => {
    const s = baseline().state;
    const preserved = reduceLocalSync(ready, { type: 'channel', connected: true }).state;
    expect(playbackReadiness(s, preserved)).toBe(s);
    const failed = reduceLocalSync(ready, { type: 'channel', connected: false }).state;
    expect(playbackReadiness(s, failed)).toBe(initialPlaybackState);
  });
  it('PLAYBACK_UNAVAILABLE withdraws only readiness and preserves matching identity', () => {
    const s = reduceLocalSync(ready, {
      type: 'receive',
      body: {
        type: 'NOT_READY',
        payload: { localSelectionId: remote, reason: 'PLAYBACK_UNAVAILABLE' },
      },
    }).state;
    expect(s.remote).toBe(ready.remote);
    expect(s.peerMatched).toBe(true);
    expect(s.localReady).toBe(true);
    expect(s.remoteReady).toBe(false);
  });
  it('rejects invalid host positions and revision exhaustion without history or timers', () => {
    for (const n of [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
      expect(hostPlayback(baseline().state, 'host', 'PLAY', n).command).toBeNull();
    expect(
      hostPlayback({ ...baseline().state, revision: Number.MAX_SAFE_INTEGER }, 'host', 'PLAY', 0)
        .command,
    ).toBeNull();
    expect(playbackReadiness(baseline().state, ready)).toEqual(baseline().state);
  });
});
