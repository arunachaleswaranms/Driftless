import type { LocalMediaErrorKind } from './mediaError.ts';

export type LocalMediaStatus = 'loading' | 'ready' | 'error';

/** Media properties reported by the browser once metadata has loaded. */
export interface MediaMetadata {
  duration: number;
  width: number;
  height: number;
}

/**
 * One chosen file. Each selection has a unique `id`; the player element and
 * the object URL bound to it belong to that selection only, and media events
 * carry the id of the selection that produced them.
 */
export interface LocalMediaSelection {
  id: number;
  file: File;
  status: LocalMediaStatus;
  metadata: MediaMetadata | null;
  error: LocalMediaErrorKind | null;
}

export interface LocalMediaState {
  lastSelectionId: number;
  selection: LocalMediaSelection | null;
}

export type LocalMediaAction =
  | { type: 'selected'; file: File }
  | { type: 'cleared' }
  | { type: 'metadataLoaded'; selectionId: number; metadata: MediaMetadata }
  | { type: 'durationChanged'; selectionId: number; duration: number }
  | { type: 'failed'; selectionId: number; error: LocalMediaErrorKind };

export const initialLocalMediaState: LocalMediaState = { lastSelectionId: 0, selection: null };

export function localMediaReducer(
  state: LocalMediaState,
  action: LocalMediaAction,
): LocalMediaState {
  switch (action.type) {
    case 'selected': {
      const id = state.lastSelectionId + 1;
      return {
        lastSelectionId: id,
        selection: { id, file: action.file, status: 'loading', metadata: null, error: null },
      };
    }
    case 'cleared':
      return state.selection ? { ...state, selection: null } : state;
    default:
      break;
  }

  // Media events from a replaced or cleared selection must not alter the
  // current one, however late they arrive.
  const { selection } = state;
  if (!selection || selection.id !== action.selectionId) {
    return state;
  }

  switch (action.type) {
    case 'metadataLoaded':
      if (selection.status === 'error') {
        return state;
      }
      return { ...state, selection: { ...selection, status: 'ready', metadata: action.metadata } };
    case 'durationChanged':
      if (!selection.metadata || Object.is(selection.metadata.duration, action.duration)) {
        return state;
      }
      return {
        ...state,
        selection: { ...selection, metadata: { ...selection.metadata, duration: action.duration } },
      };
    case 'failed':
      return { ...state, selection: { ...selection, status: 'error', error: action.error } };
  }
}
