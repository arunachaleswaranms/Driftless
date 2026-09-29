import { describe, expect, it } from 'vitest';
import { makeVideoFile } from '../../test/media.ts';
import {
  initialLocalMediaState,
  localMediaReducer,
  type LocalMediaAction,
  type LocalMediaState,
} from './localMediaState.ts';

function reduce(actions: LocalMediaAction[], state = initialLocalMediaState): LocalMediaState {
  return actions.reduce(localMediaReducer, state);
}

const metadata = { duration: 10, width: 320, height: 180 };

describe('localMediaReducer', () => {
  it('gives every selection a new id, even for the same file', () => {
    const file = makeVideoFile('a.mp4');
    const first = reduce([{ type: 'selected', file }]);
    const second = reduce([{ type: 'cleared' }, { type: 'selected', file }], first);

    expect(first.selection?.id).toBe(1);
    expect(second.selection?.id).toBe(2);
    expect(second.selection).toMatchObject({ status: 'loading', metadata: null, error: null });
  });

  it.each<LocalMediaAction>([
    { type: 'metadataLoaded', selectionId: 1, metadata },
    { type: 'durationChanged', selectionId: 1, duration: 5 },
    { type: 'failed', selectionId: 1, error: 'source' },
  ])('ignores $type for a previous selection', (action) => {
    const state = reduce([
      { type: 'selected', file: makeVideoFile('a.mp4') },
      { type: 'selected', file: makeVideoFile('b.mp4') },
    ]);

    expect(localMediaReducer(state, action)).toBe(state);
  });

  it.each<LocalMediaAction>([
    { type: 'metadataLoaded', selectionId: 1, metadata },
    { type: 'failed', selectionId: 1, error: 'source' },
  ])('ignores $type after the selection is cleared', (action) => {
    const state = reduce([{ type: 'selected', file: makeVideoFile('a.mp4') }, { type: 'cleared' }]);

    expect(localMediaReducer(state, action)).toBe(state);
  });

  it('keeps the same state when an unknown duration is reported again', () => {
    const state = reduce([
      { type: 'selected', file: makeVideoFile('a.webm') },
      { type: 'metadataLoaded', selectionId: 1, metadata: { ...metadata, duration: Number.NaN } },
    ]);

    expect(
      localMediaReducer(state, { type: 'durationChanged', selectionId: 1, duration: Number.NaN }),
    ).toBe(state);
  });

  it('ignores a duration change before metadata has loaded', () => {
    const state = reduce([{ type: 'selected', file: makeVideoFile('a.mp4') }]);

    expect(localMediaReducer(state, { type: 'durationChanged', selectionId: 1, duration: 5 })).toBe(
      state,
    );
  });
});
