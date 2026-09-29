import { describe, expect, it, vi } from 'vitest';
import { registerServiceWorker } from './registerServiceWorker.ts';

function fakeContainer(register: ServiceWorkerContainer['register']): ServiceWorkerContainer {
  return { register } as unknown as ServiceWorkerContainer;
}

describe('registerServiceWorker', () => {
  it('reports unsupported when no service worker container exists', async () => {
    await expect(registerServiceWorker(null, '/')).resolves.toEqual({
      status: 'unsupported',
    });
  });

  it('registers the worker at the base path with HTTP-cache bypass for updates', async () => {
    const registration = {} as ServiceWorkerRegistration;
    const register = vi.fn<ServiceWorkerContainer['register']>().mockResolvedValue(registration);

    const result = await registerServiceWorker(fakeContainer(register), '/app/');

    expect(register).toHaveBeenCalledExactlyOnceWith('/app/sw.js', {
      scope: '/app/',
      updateViaCache: 'none',
    });
    expect(result).toEqual({ status: 'registered', registration });
  });

  it('reports failure without throwing when registration is rejected', async () => {
    const error = new DOMException('Registration rejected', 'SecurityError');
    const register = vi.fn<ServiceWorkerContainer['register']>().mockRejectedValue(error);

    await expect(registerServiceWorker(fakeContainer(register), '/')).resolves.toEqual({
      status: 'failed',
      error,
    });
  });
});
