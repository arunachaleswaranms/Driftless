import { describe, expect, it } from 'vitest';
import {
  type ApplicationBody,
  type MediaFingerprint,
  type MediaSelectionId,
  type ReadinessId,
} from '@driftless/protocol';
import {
  initialLocalSyncState,
  reduceLocalSync,
  bothReady,
  mediaMatch,
  readinessBlock,
  type LocalSyncState,
  type LocalSyncEvent,
} from '../src/index.js';
const id = (n: number) => Buffer.alloc(16, n).toString('base64url') as MediaSelectionId;
const rid = (n: number) => Buffer.alloc(16, n).toString('base64url') as ReadinessId;
const readyPair = () => ({ ...peerPair, readinessId: rid(2) });
const fp = (n = 1) => Buffer.alloc(32, n).toString('base64url') as MediaFingerprint;
const info = (selectionId = id(2), fingerprint = fp()): ApplicationBody => ({
  type: 'MEDIA_INFO',
  payload: { selectionId, fingerprintVersion: 1, fingerprint, byteLength: 10 },
});
const peerPair = { localSelectionId: id(2), remoteSelectionId: id(1), fingerprint: fp() };
const apply = (state: LocalSyncState, event: LocalSyncEvent) => reduceLocalSync(state, event).state;
function matched(): LocalSyncState {
  let s = initialLocalSyncState;
  for (const event of [
    { type: 'channel', connected: true },
    { type: 'select', selectionId: id(1), byteLength: 10 },
    { type: 'fingerprint', selectionId: id(1), fingerprint: fp() },
    { type: 'playback', selectionId: id(1), status: 'ready' },
    { type: 'receive', body: info() },
    { type: 'receive', body: { type: 'MEDIA_MATCH', payload: peerPair } },
  ] as const)
    s = apply(s, event);
  return s;
}
function ready(): LocalSyncState {
  return apply(apply(matched(), { type: 'ready', readinessId: rid(1) }), {
    type: 'receive',
    body: { type: 'READY', payload: readyPair() },
  });
}
describe('Local Sync deterministic readiness', () => {
  it('starts empty and blocks Ready; disconnected input is powerless', () => {
    expect(readinessBlock(initialLocalSyncState)).toBe('PEER_DISCONNECTED');
    expect(
      reduceLocalSync(initialLocalSyncState, { type: 'ready', readinessId: rid(1) }).state,
    ).toBe(initialLocalSyncState);
    expect(apply(initialLocalSyncState, { type: 'receive', body: info() })).toBe(
      initialLocalSyncState,
    );
    expect(readinessBlock(apply(initialLocalSyncState, { type: 'channel', connected: true }))).toBe(
      'NO_MEDIA',
    );
  });
  it('fingerprinting, metadata and peer match are distinct requirements', () => {
    let s = apply(initialLocalSyncState, { type: 'channel', connected: true });
    s = apply(s, { type: 'select', selectionId: id(1), byteLength: 10 });
    expect(readinessBlock(s)).toBe('FINGERPRINTING');
    const result = reduceLocalSync(s, {
      type: 'fingerprint',
      selectionId: id(1),
      fingerprint: fp(),
    });
    s = result.state;
    expect(result.effects.map((e) => e.type)).toEqual(['MEDIA_INFO']);
    expect(readinessBlock(s)).toBe('METADATA_LOADING');
    s = apply(s, { type: 'playback', selectionId: id(1), status: 'ready' });
    expect(readinessBlock(s)).toBe('NO_REMOTE_MEDIA');
    const comparison = reduceLocalSync(s, { type: 'receive', body: info() });
    s = comparison.state;
    expect(comparison.effects).toEqual([
      {
        type: 'MEDIA_MATCH',
        payload: { localSelectionId: id(1), remoteSelectionId: id(2), fingerprint: fp() },
      },
    ]);
    expect(readinessBlock(s)).toBe('WAITING_FOR_PEER_MATCH');
    expect(reduceLocalSync(s, { type: 'ready', readinessId: rid(1) }).effects).toEqual([]);
  });
  it('mismatch (digest or byte length) blocks Ready and emits bounded reason', () => {
    for (const remote of [
      info(id(3), fp(2)),
      {
        type: 'MEDIA_INFO',
        payload: {
          ...info().payload,
          selectionId: id(3),
          fingerprintVersion: 1,
          fingerprint: fp(),
          byteLength: 11,
        },
      } as ApplicationBody,
    ]) {
      const result = reduceLocalSync(ready(), { type: 'receive', body: remote });
      expect(mediaMatch(result.state)).toBe('mismatch');
      expect(readinessBlock(result.state)).toBe('MEDIA_MISMATCH');
      expect(bothReady(result.state)).toBe(false);
      expect(result.effects.map((e) => e.type)).toEqual(['NOT_READY', 'MEDIA_MISMATCH']);
    }
  });
  it('matching does not automatically ready either user; both ready binds current pair', () => {
    const s = matched();
    expect(readinessBlock(s)).toBeNull();
    expect(bothReady(s)).toBe(false);
    const local = reduceLocalSync(s, { type: 'ready', readinessId: rid(1) });
    expect(local.effects).toEqual([
      {
        type: 'READY',
        payload: {
          localSelectionId: id(1),
          remoteSelectionId: id(2),
          fingerprint: fp(),
          readinessId: rid(1),
        },
      },
    ]);
    expect(bothReady(local.state)).toBe(false);
    expect(bothReady(ready())).toBe(true);
    expect(reduceLocalSync(local.state, { type: 'ready', readinessId: rid(1) }).effects).toEqual(
      [],
    );
  });
  it('local Not Ready withdraws without losing media or peer match', () => {
    const result = reduceLocalSync(ready(), { type: 'not-ready' });
    expect(bothReady(result.state)).toBe(false);
    expect(result.state.remoteReady).toBe(true);
    expect(readinessBlock(result.state)).toBeNull();
    expect(result.effects).toEqual([
      { type: 'NOT_READY', payload: { localSelectionId: id(1), reason: 'USER' } },
    ]);
  });
  it('peer USER withdrawal removes only its readiness', () => {
    const s = apply(ready(), {
      type: 'receive',
      body: { type: 'NOT_READY', payload: { localSelectionId: id(2), reason: 'USER' } },
    });
    expect(s.localReady).toBe(true);
    expect(s.remoteReady).toBe(false);
    expect(mediaMatch(s)).toBe('match');
  });
  it.each(['NO_MEDIA', 'MEDIA_CHANGED', 'LOCAL_MEDIA_ERROR'] as const)(
    'peer %s removes identity and invalidates dependent readiness',
    (reason) => {
      const result = reduceLocalSync(ready(), {
        type: 'receive',
        body: {
          type: 'NOT_READY',
          payload: { localSelectionId: reason === 'NO_MEDIA' ? null : id(2), reason },
        },
      });
      expect(result.state.remote).toBeNull();
      expect(result.state.localReady).toBe(false);
      expect(result.state.remoteReady).toBe(false);
      expect(result.effects[0]?.type).toBe('NOT_READY');
    },
  );
  it('local replacement sends NOT_READY first, discards identity, ignores late fingerprint/progress/error/metadata', () => {
    const result = reduceLocalSync(ready(), { type: 'select', selectionId: id(3), byteLength: 10 });
    expect(result.effects).toEqual([
      { type: 'NOT_READY', payload: { localSelectionId: id(1), reason: 'MEDIA_CHANGED' } },
    ]);
    expect(result.state.local?.fingerprint).toBeNull();
    expect(bothReady(result.state)).toBe(false);
    for (const event of [
      { type: 'fingerprint', selectionId: id(1), fingerprint: fp() },
      { type: 'progress', selectionId: id(1), progress: 100 },
      { type: 'failure', selectionId: id(1), failure: 'READ_FAILED' },
      { type: 'playback', selectionId: id(1), status: 'ready' },
    ] as const)
      expect(reduceLocalSync(result.state, event)).toEqual({ state: result.state, effects: [] });
  });
  it('remote replacement requires explicit Ready again and rejects stale MATCH/READY/MISMATCH/NOT_READY', () => {
    const s = apply(ready(), { type: 'receive', body: info(id(3)) });
    expect(s.localReady).toBe(false);
    expect(s.remoteReady).toBe(false);
    expect(s.peerMatched).toBe(false);
    for (const body of [
      { type: 'MEDIA_MATCH', payload: peerPair },
      { type: 'READY', payload: readyPair() },
      {
        type: 'MEDIA_MISMATCH',
        payload: { localSelectionId: id(2), remoteSelectionId: id(1), reason: 'IDENTITY_MISMATCH' },
      },
      { type: 'NOT_READY', payload: { localSelectionId: id(2), reason: 'NO_MEDIA' } },
    ] as const)
      expect(apply(s, { type: 'receive', body })).toBe(s);
  });
  it('clear sends no fake MEDIA_INFO, erases identity and readiness', () => {
    const result = reduceLocalSync(ready(), { type: 'clear' });
    expect(result.state.local).toBeNull();
    expect(bothReady(result.state)).toBe(false);
    expect(result.effects).toEqual([
      { type: 'NOT_READY', payload: { localSelectionId: id(1), reason: 'NO_MEDIA' } },
    ]);
  });
  it.each(['playback', 'failure'] as const)(
    '%s failure invalidates Ready and late success cannot heal it',
    (type) => {
      const s = apply(
        ready(),
        type === 'playback'
          ? { type, selectionId: id(1), status: 'error' }
          : { type, selectionId: id(1), failure: 'HASH_FAILED' },
      );
      expect(readinessBlock(s)).toBe('LOCAL_MEDIA_ERROR');
      expect(bothReady(s)).toBe(false);
      expect(
        readinessBlock(apply(s, { type: 'playback', selectionId: id(1), status: 'ready' })),
      ).toBe('LOCAL_MEDIA_ERROR');
    },
  );
  it('fresh channel clears remote state and readiness and reannounces local truth', () => {
    const down = apply(ready(), { type: 'channel', connected: false });
    expect(down.remote).toBeNull();
    expect(bothReady(down)).toBe(false);
    const up = reduceLocalSync(down, { type: 'channel', connected: true });
    expect(up.effects.map((e) => e.type)).toEqual(['MEDIA_INFO']);
    expect(up.state.localReady).toBe(false);
    expect(up.state.remoteReady).toBe(false);
  });
  it('same healthy channel does not reset/reannounce for signaling reconnection', () => {
    const s = ready();
    expect(reduceLocalSync(s, { type: 'channel', connected: true })).toEqual({
      state: s,
      effects: [],
    });
  });
  it('duplicate media info and wrong fingerprint/pair Ready cannot change readiness', () => {
    const s = matched();
    expect(apply(s, { type: 'receive', body: info() })).toBe(s);
    for (const payload of [
      { ...readyPair(), fingerprint: fp(3) },
      { ...readyPair(), remoteSelectionId: id(5) },
    ])
      expect(apply(s, { type: 'receive', body: { type: 'READY', payload } })).toBe(s);
  });
  it('cancellation is not an error and progress is clamped', () => {
    const s = matched();
    expect(apply(s, { type: 'failure', selectionId: id(1), failure: 'CANCELLED' })).toBe(s);
    expect(apply(s, { type: 'progress', selectionId: id(1), progress: 900 }).local?.progress).toBe(
      100,
    );
  });
});

it('late identity after playback error stays private and fresh peers do not announce it', () => {
  let s = apply(matched(), { type: 'playback', selectionId: id(1), status: 'error' });
  const completed = reduceLocalSync(s, {
    type: 'fingerprint',
    selectionId: id(1),
    fingerprint: fp(),
  });
  expect(completed.effects).toEqual([]);
  expect(readinessBlock(completed.state)).toBe('LOCAL_MEDIA_ERROR');
  s = apply(completed.state, { type: 'channel', connected: false });
  expect(reduceLocalSync(s, { type: 'channel', connected: true }).effects).toEqual([]);
});

it('stores one explicit Ready generation, clears it on withdrawal, and sends the fresh value on re-Ready', () => {
  const first = reduceLocalSync(matched(), { type: 'ready', readinessId: rid(10) });
  expect(first.state.localReadinessId).toBe(rid(10));
  expect(first.effects[0]).toMatchObject({ type: 'READY', payload: { readinessId: rid(10) } });
  const withdrawn = apply(first.state, { type: 'not-ready' });
  expect(withdrawn.localReadinessId).toBeNull();
  const second = apply(withdrawn, { type: 'ready', readinessId: rid(11) });
  expect(second.localReadinessId).toBe(rid(11));
  expect(second.localReadinessId).not.toBe(first.state.localReadinessId);
});
it('remote generation cannot change until withdrawn, then the new READY records it', () => {
  const s = ready();
  expect(s.remoteReadinessId).toBe(rid(2));
  const newReady = { type: 'READY', payload: { ...peerPair, readinessId: rid(12) } } as const;
  expect(apply(s, { type: 'receive', body: newReady })).toBe(s);
  const withdrawn = apply(s, {
    type: 'receive',
    body: { type: 'NOT_READY', payload: { localSelectionId: id(2), reason: 'USER' } },
  });
  expect(withdrawn.remoteReadinessId).toBeNull();
  expect(withdrawn.localReadinessId).toBe(s.localReadinessId);
  expect(apply(withdrawn, { type: 'receive', body: newReady }).remoteReadinessId).toBe(rid(12));
});
it('all invalidating transitions preserve the boolean/ID invariant', () => {
  const events: LocalSyncEvent[] = [
    { type: 'not-ready' },
    { type: 'not-ready', reason: 'PLAYBACK_UNAVAILABLE' },
    { type: 'select', selectionId: id(3), byteLength: 10 },
    { type: 'clear' },
    { type: 'playback', selectionId: id(1), status: 'error' },
    { type: 'failure', selectionId: id(1), failure: 'READ_FAILED' },
    { type: 'channel', connected: false },
    { type: 'receive', body: info(id(3)) },
    {
      type: 'receive',
      body: {
        type: 'MEDIA_MISMATCH',
        payload: { localSelectionId: id(2), remoteSelectionId: id(1), reason: 'IDENTITY_MISMATCH' },
      },
    },
    ...(
      [
        'USER',
        'PLAYBACK_UNAVAILABLE',
        'NO_MEDIA',
        'MEDIA_CHANGED',
        'LOCAL_MEDIA_ERROR',
        'PEER_MEDIA_CHANGED',
        'MEDIA_MISMATCH',
      ] as const
    ).map(
      (reason) =>
        ({
          type: 'receive',
          body: { type: 'NOT_READY', payload: { localSelectionId: id(2), reason } },
        }) as const,
    ),
  ];
  for (const event of events) {
    const s = apply(ready(), event);
    expect(s.localReady).toBe(s.localReadinessId !== null);
    expect(s.remoteReady).toBe(s.remoteReadinessId !== null);
    expect(bothReady(s)).toBe(false);
  }
  const preserved = apply(ready(), { type: 'channel', connected: true });
  expect(preserved.localReadinessId).toBe(rid(1));
  expect(preserved.remoteReadinessId).toBe(rid(2));
  const fresh = apply(apply(ready(), { type: 'channel', connected: false }), {
    type: 'channel',
    connected: true,
  });
  expect(fresh.localReadinessId).toBeNull();
  expect(fresh.remoteReadinessId).toBeNull();
});
it('bothReady refuses booleans without their corresponding current IDs', () => {
  expect(bothReady({ ...ready(), localReadinessId: null })).toBe(false);
  expect(bothReady({ ...ready(), remoteReadinessId: null })).toBe(false);
});
