import { useRef, useState } from 'react';
import {
  localMediaReducer,
  initialLocalMediaState,
  type LocalMediaAction,
} from '../features/local-media/localMediaState.ts';
import { createBrowserRoomController } from '../features/room/browserRoomController.ts';
import { CapabilityPanel } from '../features/capabilities/CapabilityPanel.tsx';
import { LocalMediaPanel } from '../features/local-media/LocalMediaPanel.tsx';
import { RoomPanel } from '../features/room/RoomPanel.tsx';

const MAIN_CONTENT_ID = 'main-content';

export function App() {
  const [controller] = useState(createBrowserRoomController);
  const [media, setMedia] = useState(initialLocalMediaState);
  const current = useRef(media);
  function dispatch(action: LocalMediaAction) {
    const next = localMediaReducer(current.current, action);
    current.current = next;
    controller.localSync.updateMedia(next.selection);
    setMedia(next);
  }
  return (
    <>
      <a className="skip-link" href={`#${MAIN_CONTENT_ID}`}>
        Skip to main content
      </a>
      <header className="app-header">
        <div className="app-container">
          <h1 className="app-title">Driftless</h1>
          <p className="app-build-status">
            Early development build. Local Sync follows host playback controls; continuous drift
            correction is still in development.
          </p>
        </div>
      </header>
      <main id={MAIN_CONTENT_ID} className="app-container app-main" tabIndex={-1}>
        <LocalMediaPanel localSync={controller.localSync} media={{ state: media, dispatch }} />
        <CapabilityPanel />
        <RoomPanel controller={controller} />
      </main>
    </>
  );
}
