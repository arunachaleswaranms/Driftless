import { useReducer, useRef, type ChangeEvent } from 'react';
import { LocalMediaPlayer } from './LocalMediaPlayer.tsx';
import { initialLocalMediaState, localMediaReducer } from './localMediaState.ts';
import { MediaDetails } from './MediaDetails.tsx';
import { describeMediaError, MEDIA_ERROR_SUMMARY } from './mediaError.ts';

const FILE_INPUT_ID = 'local-media-file';

// A hint for the file chooser, not a compatibility check: whether a file
// plays is decided only by the browser's media stack.
const ACCEPTED_FILES = 'video/*,.mp4,.m4v,.mov,.webm,.mkv';

const STATUS_TEXT = {
  empty: 'No video selected.',
  loading: 'Loading video details…',
  ready: 'Ready. Use the video controls to play, pause, and seek.',
  // A failure is announced by the alert instead. The status region stays in
  // the document, empty, so later updates are still announced.
  error: '',
} as const;

export function LocalMediaPanel({
  media,
}: {
  media?: {
    state: import('./localMediaState.ts').LocalMediaState;
    dispatch: (action: import('./localMediaState.ts').LocalMediaAction) => void;
  };
} = {}) {
  const [fallbackState, fallbackDispatch] = useReducer(localMediaReducer, initialLocalMediaState);
  const { selection } = media?.state ?? fallbackState;
  const dispatch = media?.dispatch ?? fallbackDispatch;
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    // The input keeps no selection of its own, so the same file can be chosen
    // again later. A cancelled chooser supplies no file and changes nothing.
    input.value = '';
    if (file) {
      dispatch({ type: 'selected', file });
    }
  }

  function handleClear() {
    dispatch({ type: 'cleared' });
    // The Clear button leaves the page with the selection, so return focus
    // to the file chooser rather than dropping it on the document.
    fileInputRef.current?.focus();
  }

  return (
    <section className="panel local-media" aria-labelledby="local-media-heading">
      <div>
        <h2 id="local-media-heading">Local video</h2>
        <p className="panel-status">
          Play a video file from this device. The file stays on this device and is not uploaded.
        </p>
      </div>

      <div className="local-media-actions">
        <input
          ref={fileInputRef}
          id={FILE_INPUT_ID}
          className="visually-hidden"
          type="file"
          accept={ACCEPTED_FILES}
          onChange={handleFileChange}
        />
        <label htmlFor={FILE_INPUT_ID} className="button">
          {selection ? 'Replace video file' : 'Choose video file'}
        </label>
        {selection && (
          <button type="button" className="button button-secondary" onClick={handleClear}>
            Clear video
          </button>
        )}
      </div>

      <div>
        <p role="status">{STATUS_TEXT[selection?.status ?? 'empty']}</p>
        {selection?.status === 'error' && (
          <div className="local-media-error" role="alert">
            <p className="local-media-error-summary">{MEDIA_ERROR_SUMMARY}</p>
            <p>{describeMediaError(selection.error ?? 'unknown')}</p>
          </div>
        )}
      </div>

      {selection && (
        <>
          <LocalMediaPlayer
            key={selection.id}
            file={selection.file}
            hidden={selection.status === 'error'}
            onMetadataLoaded={(metadata) => {
              dispatch({ type: 'metadataLoaded', selectionId: selection.id, metadata });
            }}
            onDurationChanged={(duration) => {
              dispatch({ type: 'durationChanged', selectionId: selection.id, duration });
            }}
            onFailed={(error) => {
              dispatch({ type: 'failed', selectionId: selection.id, error });
            }}
          />
          <MediaDetails selection={selection} />
        </>
      )}
    </section>
  );
}
