import { formatPlaybackPosition } from './playbackSyncController.ts';
import { useState, useSyncExternalStore } from 'react';
import { bothReady, mediaMatch, readinessBlock } from '@driftless/sync-engine';
import type { LocalSyncController } from './localSyncController.ts';

export function LocalSyncPanel({ controller }: { controller: LocalSyncController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const playback = useSyncExternalStore(
    controller.playback.subscribe,
    controller.playback.getState,
  );
  const [target, setTarget] = useState(0);
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
        disabled={playback.preparing || (!state.localReady && readinessBlock(state) !== null)}
        onClick={() => {
          if (state.localReady) controller.dispatch({ type: 'not-ready' });
          else void controller.playback.ready();
        }}
      >
        {state.localReady ? 'Not ready' : "I'm ready"}
      </button>
      {playback.error ? <p role="alert">{playback.error}</p> : null}
      {playback.authority.active && playback.role === 'host' ? (
        <div role="group" aria-label="Host playback controls">
          <button
            type="button"
            className="button"
            onClick={() => {
              void controller.playback.play();
            }}
          >
            Play
          </button>
          <button
            type="button"
            className="button"
            onClick={() => {
              controller.playback.pause();
            }}
          >
            Pause
          </button>
          <label>
            Seek position
            <input
              type="range"
              min="0"
              max={playback.durationMs}
              step="100"
              value={Math.min(target, playback.durationMs)}
              onChange={(event) => {
                setTarget(Number(event.currentTarget.value));
              }}
            />
          </label>
          <span>{formatPlaybackPosition(Math.min(target, playback.durationMs))}</span>
          <button
            type="button"
            className="button"
            onClick={() => {
              controller.playback.seek(Math.min(target, playback.durationMs));
            }}
          >
            Seek
          </button>
        </div>
      ) : playback.authority.pair && playback.role === 'guest' ? (
        <p>
          {playback.authority.active
            ? 'The host controls playback.'
            : 'Waiting for the host paused baseline.'}
        </p>
      ) : null}
      <p>
        Local Sync follows host Play, Pause, and Seek commands. Continuous drift correction is not
        implemented yet.
      </p>
    </section>
  );
}
