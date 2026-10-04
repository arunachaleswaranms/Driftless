import { useSyncExternalStore } from 'react';
import { bothReady, mediaMatch, readinessBlock } from '@driftless/sync-engine';
import type { LocalSyncController } from './localSyncController.ts';

export function LocalSyncPanel({ controller }: { controller: LocalSyncController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  let status = 'Choose a local video.';
  if (state.local?.failure)
    status =
      state.local.failure === 'FILE_TOO_LARGE'
        ? 'This file exceeds the current Local Sync identity limit.'
        : 'Could not check media identity. Choose the file again.';
  else if (state.local?.playback === 'error')
    status = 'Local video could not load. Choose another file.';
  else if (state.local && !state.local.fingerprint) status = 'Checking media identity…';
  else if (state.local && !state.connected) status = 'Waiting for a healthy peer connection.';
  else if (state.local && !state.remote)
    status = 'Waiting for the other participant to choose media.';
  else if (mediaMatch(state) === 'mismatch') status = 'Media does not match.';
  else if (mediaMatch(state) === 'match') status = 'Media matches.';
  return (
    <section className="local-sync" aria-labelledby="local-sync-heading">
      <h3 id="local-sync-heading">Local Sync setup</h3>
      <p role="status">{status}</p>
      {state.local && !state.local.fingerprint && !state.local.failure ? (
        <p aria-hidden="true">{state.local.progress}% checked</p>
      ) : null}
      <p role="status">
        {bothReady(state)
          ? 'Both participants are ready.'
          : `${state.localReady ? 'You are ready.' : 'You are not ready.'} ${state.remoteReady ? 'The other participant is ready.' : 'The other participant is not ready.'}`}
      </p>
      <button
        type="button"
        className="button"
        disabled={!state.localReady && readinessBlock(state) !== null}
        onClick={() => {
          controller.dispatch({ type: state.localReady ? 'not-ready' : 'ready' });
        }}
      >
        {state.localReady ? 'Not ready' : "I'm ready"}
      </button>
      <p>Setup only. Playback remains local; becoming ready does not start playback.</p>
    </section>
  );
}
