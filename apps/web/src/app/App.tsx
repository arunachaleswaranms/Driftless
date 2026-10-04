import { CapabilityPanel } from '../features/capabilities/CapabilityPanel.tsx';
import { LocalMediaPanel } from '../features/local-media/LocalMediaPanel.tsx';
import { RoomPanel } from '../features/room/RoomPanel.tsx';

const MAIN_CONTENT_ID = 'main-content';

export function App() {
  return (
    <>
      <a className="skip-link" href={`#${MAIN_CONTENT_ID}`}>
        Skip to main content
      </a>
      <header className="app-header">
        <div className="app-container">
          <h1 className="app-title">Driftless</h1>
          <p className="app-build-status">
            Early development build. Synchronized watching is not available yet.
          </p>
        </div>
      </header>
      <main id={MAIN_CONTENT_ID} className="app-container app-main" tabIndex={-1}>
        <LocalMediaPanel />
        <CapabilityPanel />
        <RoomPanel />
      </main>
    </>
  );
}
