import type {
  MediaSelectionId,
  ReadinessId,
  ParticipantRole,
  PlaybackBody,
} from '@driftless/protocol';
import { bothReady, type LocalSyncState } from './readiness.js';

/** Current activation only: selections plus both explicit Ready generations. */
export interface PlaybackPair {
  readonly localReadinessId: ReadinessId;
  readonly remoteReadinessId: ReadinessId;
  readonly localSelectionId: MediaSelectionId;
  readonly remoteSelectionId: MediaSelectionId;
}
export interface PlaybackSyncState {
  readonly active: boolean;
  readonly pair: PlaybackPair | null;
  readonly revision: number;
  readonly mode: 'paused' | 'playing';
  readonly positionMs: number;
}
export const initialPlaybackState: PlaybackSyncState = {
  active: false,
  pair: null,
  revision: 0,
  mode: 'paused',
  positionMs: 0,
};
export const isPlaybackBody = (body: { readonly type: string }): body is PlaybackBody =>
  body.type === 'PLAY' || body.type === 'PAUSE' || body.type === 'SEEK';
export function playbackReadiness(
  state: PlaybackSyncState,
  ready: LocalSyncState,
): PlaybackSyncState {
  if (
    !bothReady(ready) ||
    !ready.local ||
    !ready.remote ||
    !ready.localReadinessId ||
    !ready.remoteReadinessId
  )
    return initialPlaybackState;
  const pair = {
    localReadinessId: ready.localReadinessId,
    remoteReadinessId: ready.remoteReadinessId,
    localSelectionId: ready.local.selectionId,
    remoteSelectionId: ready.remote.selectionId,
  };
  if (
    state.pair?.localSelectionId === pair.localSelectionId &&
    state.pair.remoteSelectionId === pair.remoteSelectionId &&
    state.pair.localReadinessId === pair.localReadinessId &&
    state.pair.remoteReadinessId === pair.remoteReadinessId
  )
    return state;
  return { ...initialPlaybackState, pair };
}
export function hostPlayback(
  state: PlaybackSyncState,
  role: ParticipantRole | null,
  type: PlaybackBody['type'],
  positionMs: number,
): { state: PlaybackSyncState; command: PlaybackBody | null } {
  if (
    role !== 'host' ||
    !state.pair ||
    (!state.active && type !== 'PAUSE') ||
    !Number.isSafeInteger(positionMs) ||
    positionMs < 0 ||
    state.revision === Number.MAX_SAFE_INTEGER
  )
    return { state, command: null };
  const revision = state.revision + 1;
  const next = {
    ...state,
    active: true,
    revision,
    positionMs,
    mode:
      type === 'SEEK' ? state.mode : type === 'PLAY' ? ('playing' as const) : ('paused' as const),
  };
  return { state: next, command: { type, payload: { ...state.pair, revision, positionMs } } };
}
export function guestPlayback(state: PlaybackSyncState, body: PlaybackBody): PlaybackSyncState {
  const p = body.payload;
  if (
    !Number.isSafeInteger(p.revision) ||
    p.revision < 1 ||
    !Number.isSafeInteger(p.positionMs) ||
    p.positionMs < 0 ||
    !state.pair ||
    p.localSelectionId !== state.pair.remoteSelectionId ||
    p.remoteSelectionId !== state.pair.localSelectionId ||
    p.localReadinessId !== state.pair.remoteReadinessId ||
    p.remoteReadinessId !== state.pair.localReadinessId ||
    p.revision <= state.revision ||
    (!state.active && (body.type !== 'PAUSE' || p.revision !== 1))
  )
    return state;
  return {
    ...state,
    active: true,
    revision: p.revision,
    positionMs: p.positionMs,
    mode: body.type === 'SEEK' ? state.mode : body.type === 'PLAY' ? 'playing' : 'paused',
  };
}
