import {
  MEDIA_FINGERPRINT_VERSION,
  type ApplicationBody,
  type MediaIdentity,
  type MediaSelectionId,
  type MediaFingerprint,
  type NotReadyReason,
} from '@driftless/protocol';
import type { FingerprintFailure } from './fingerprint.js';

export interface LocalSelection {
  readonly selectionId: MediaSelectionId;
  readonly byteLength: number;
  readonly playback: 'loading' | 'ready' | 'error';
  readonly fingerprint: MediaFingerprint | null;
  readonly progress: number;
  readonly failure: FingerprintFailure | null;
}
export interface LocalSyncState {
  readonly connected: boolean;
  readonly local: LocalSelection | null;
  readonly remote: MediaIdentity | null;
  readonly peerMatched: boolean;
  readonly localReady: boolean;
  readonly remoteReady: boolean;
}
export const initialLocalSyncState: LocalSyncState = {
  connected: false,
  local: null,
  remote: null,
  peerMatched: false,
  localReady: false,
  remoteReady: false,
};
export type LocalSyncEvent =
  | { readonly type: 'channel'; readonly connected: boolean }
  | { readonly type: 'select'; readonly selectionId: MediaSelectionId; readonly byteLength: number }
  | { readonly type: 'clear' }
  | {
      readonly type: 'playback';
      readonly selectionId: MediaSelectionId;
      readonly status: LocalSelection['playback'];
    }
  | {
      readonly type: 'fingerprint';
      readonly selectionId: MediaSelectionId;
      readonly fingerprint: MediaFingerprint;
    }
  | { readonly type: 'progress'; readonly selectionId: MediaSelectionId; readonly progress: number }
  | {
      readonly type: 'failure';
      readonly selectionId: MediaSelectionId;
      readonly failure: FingerprintFailure;
    }
  | { readonly type: 'ready' }
  | { readonly type: 'not-ready'; readonly reason?: 'USER' | 'PLAYBACK_UNAVAILABLE' }
  | { readonly type: 'receive'; readonly body: ApplicationBody };
export type MatchState = 'waiting' | 'match' | 'mismatch';
export function mediaMatch(state: LocalSyncState): MatchState {
  const { local, remote } = state;
  if (!local?.fingerprint || local.failure || !remote) return 'waiting';
  return local.byteLength === remote.byteLength && local.fingerprint === remote.fingerprint
    ? 'match'
    : 'mismatch';
}
export function readinessBlock(state: LocalSyncState): string | null {
  if (!state.connected) return 'PEER_DISCONNECTED';
  if (!state.local) return 'NO_MEDIA';
  if (state.local.playback === 'error' || state.local.failure) return 'LOCAL_MEDIA_ERROR';
  if (!state.local.fingerprint) return 'FINGERPRINTING';
  if (state.local.playback !== 'ready') return 'METADATA_LOADING';
  if (!state.remote) return 'NO_REMOTE_MEDIA';
  if (mediaMatch(state) !== 'match') return 'MEDIA_MISMATCH';
  if (!state.peerMatched) return 'WAITING_FOR_PEER_MATCH';
  return null;
}
export function bothReady(state: LocalSyncState): boolean {
  return readinessBlock(state) === null && state.localReady && state.remoteReady;
}
/** Pure transitions; stale selection evidence is ignored without mutating current truth. */
export function reduceLocalSync(
  state: LocalSyncState,
  event: LocalSyncEvent,
): { state: LocalSyncState; effects: readonly ApplicationBody[] } {
  let next = state;
  const effects: ApplicationBody[] = [];
  const notReady = (reason: NotReadyReason) => {
    if (state.connected)
      effects.push({
        type: 'NOT_READY',
        payload: { localSelectionId: state.local?.selectionId ?? null, reason },
      });
  };
  const invalidate = () => ({ localReady: false, remoteReady: false, peerMatched: false });
  const announce = () => {
    if (
      next.connected &&
      next.local?.fingerprint &&
      !next.local.failure &&
      next.local.playback !== 'error'
    )
      effects.push({
        type: 'MEDIA_INFO',
        payload: {
          selectionId: next.local.selectionId,
          fingerprintVersion: MEDIA_FINGERPRINT_VERSION,
          fingerprint: next.local.fingerprint,
          byteLength: next.local.byteLength,
        },
      });
  };
  const compare = () => {
    if (
      !next.connected ||
      !next.local?.fingerprint ||
      !next.remote ||
      next.local.playback === 'error'
    )
      return;
    const pair = {
      localSelectionId: next.local.selectionId,
      remoteSelectionId: next.remote.selectionId,
    };
    if (mediaMatch(next) === 'match')
      effects.push({
        type: 'MEDIA_MATCH',
        payload: { ...pair, fingerprint: next.local.fingerprint },
      });
    else if (mediaMatch(next) === 'mismatch')
      effects.push({ type: 'MEDIA_MISMATCH', payload: { ...pair, reason: 'IDENTITY_MISMATCH' } });
  };
  if (
    'selectionId' in event &&
    event.type !== 'select' &&
    event.selectionId !== state.local?.selectionId
  )
    return { state, effects };
  switch (event.type) {
    case 'channel':
      if (state.connected === event.connected) break;
      next = { ...state, connected: event.connected, remote: null, ...invalidate() };
      if (event.connected) announce();
      break;
    case 'select':
      notReady('MEDIA_CHANGED');
      next = {
        ...state,
        local: {
          selectionId: event.selectionId,
          byteLength: event.byteLength,
          playback: 'loading',
          fingerprint: null,
          progress: 0,
          failure: null,
        },
        ...invalidate(),
      };
      break;
    case 'clear':
      notReady('NO_MEDIA');
      next = { ...state, local: null, ...invalidate() };
      break;
    case 'playback':
      if (!state.local || state.local.playback === 'error') break;
      next = { ...state, local: { ...state.local, playback: event.status } };
      if (event.status === 'error') {
        notReady('LOCAL_MEDIA_ERROR');
        next = { ...next, localReady: false, remoteReady: false };
      }
      break;
    case 'progress':
      if (state.local && Number.isFinite(event.progress))
        next = {
          ...state,
          local: { ...state.local, progress: Math.min(100, Math.max(0, event.progress)) },
        };
      break;
    case 'fingerprint':
      if (!state.local || state.local.failure) break;
      next = { ...state, local: { ...state.local, fingerprint: event.fingerprint, progress: 100 } };
      announce();
      compare();
      break;
    case 'failure':
      if (!state.local || event.failure === 'CANCELLED') break;
      notReady('LOCAL_MEDIA_ERROR');
      next = {
        ...state,
        local: { ...state.local, fingerprint: null, failure: event.failure },
        ...invalidate(),
      };
      break;
    case 'ready':
      if (
        readinessBlock(state) !== null ||
        !state.local?.fingerprint ||
        !state.remote ||
        state.localReady
      )
        break;
      next = { ...state, localReady: true };
      effects.push({
        type: 'READY',
        payload: {
          localSelectionId: state.local.selectionId,
          remoteSelectionId: state.remote.selectionId,
          fingerprint: state.local.fingerprint,
        },
      });
      break;
    case 'not-ready':
      notReady(event.reason ?? 'USER');
      next = { ...state, localReady: false };
      break;
    case 'receive': {
      if (!state.connected) break;
      const { body } = event;
      const p = body.payload;
      if (body.type === 'MEDIA_INFO') {
        const identity = body.payload;
        // Repeated IDs cannot replace identity. Changes require a fresh ID.
        if (state.remote?.selectionId === identity.selectionId) break;
        if (state.localReady) notReady('PEER_MEDIA_CHANGED');
        next = { ...state, remote: identity, ...invalidate() };
        compare();
        break;
      }
      if (body.type === 'NOT_READY') {
        const { localSelectionId, reason } = body.payload;
        if (localSelectionId !== null && localSelectionId !== state.remote?.selectionId) break;
        const removed =
          reason === 'NO_MEDIA' || reason === 'MEDIA_CHANGED' || reason === 'LOCAL_MEDIA_ERROR';
        if (removed && state.localReady) notReady('PEER_MEDIA_CHANGED');
        next = {
          ...state,
          remoteReady: false,
          ...(removed ? { remote: null, localReady: false, peerMatched: false } : {}),
        };
        break;
      }
      if (
        !('remoteSelectionId' in p) ||
        p.localSelectionId !== state.remote?.selectionId ||
        p.remoteSelectionId !== state.local?.selectionId
      )
        break;
      if (body.type === 'MEDIA_MISMATCH') {
        if (state.localReady) notReady('MEDIA_MISMATCH');
        next = { ...state, ...invalidate() };
        break;
      }
      if (
        !('fingerprint' in p) ||
        p.fingerprint !== state.local.fingerprint ||
        mediaMatch(state) !== 'match'
      )
        break;
      if (body.type === 'MEDIA_MATCH') next = { ...state, peerMatched: true };
      if (body.type === 'READY' && readinessBlock(state) === null)
        next = { ...state, remoteReady: true };
      break;
    }
  }
  return { state: next, effects };
}
