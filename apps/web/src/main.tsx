import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.tsx';
import { getServiceWorkerContainer, registerServiceWorker } from './pwa/registerServiceWorker.ts';
import './app/app.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Driftless root element #root is missing.');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Only production builds register the worker; development sessions run
// without one so it cannot interfere with module reloading.
if (import.meta.env.PROD) {
  window.addEventListener(
    'load',
    () => {
      void registerServiceWorker(getServiceWorkerContainer(), import.meta.env.BASE_URL).then(
        (result) => {
          if (result.status === 'failed') {
            console.error('Driftless service worker registration failed.', result.error);
          }
        },
      );
    },
    { once: true },
  );
}
