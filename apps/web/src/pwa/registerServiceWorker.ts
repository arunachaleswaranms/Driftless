export type ServiceWorkerRegistrationResult =
  | { status: 'registered'; registration: ServiceWorkerRegistration }
  | { status: 'unsupported' }
  | { status: 'failed'; error: unknown };

/**
 * The browser's service worker container, or null where it is absent, such as
 * in insecure contexts and some browser configurations.
 */
export function getServiceWorkerContainer(): ServiceWorkerContainer | null {
  return 'serviceWorker' in navigator ? navigator.serviceWorker : null;
}

/**
 * Registers the application service worker at the root of the deployment base
 * path. A missing container is reported as unsupported rather than failed.
 */
export async function registerServiceWorker(
  container: ServiceWorkerContainer | null,
  basePath: string,
): Promise<ServiceWorkerRegistrationResult> {
  if (!container) {
    return { status: 'unsupported' };
  }
  try {
    const registration = await container.register(`${basePath}sw.js`, {
      scope: basePath,
      updateViaCache: 'none',
    });
    return { status: 'registered', registration };
  } catch (error) {
    return { status: 'failed', error };
  }
}
