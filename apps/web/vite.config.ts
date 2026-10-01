import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import type { Plugin, ProxyOptions } from 'vite';
import { defineConfig } from 'vitest/config';

// Applied to production builds only. The development server relies on inline
// scripts for React Fast Refresh, which this policy would block. Every
// directive not listed falls back to default-src 'self', so the application
// cannot load or contact any other origin. That includes connect-src: 'self'
// also matches ws: and wss: on the page's own host and port, which is how the
// client reaches signaling (see the proxy below). media-src additionally
// allows blob: so the video element can play a file chosen on this device
// through its object URL. A blob: URL refers only to data created within this
// origin.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'driftless-content-security-policy',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: CONTENT_SECURITY_POLICY },
        injectTo: 'head-prepend',
      },
    ],
  };
}

// The client opens its signaling WebSocket on its own origin, at
// /v1/signaling, so a deployment can route that path to the signaling service
// and the CSP needs no other origin. The development and preview servers do
// the same here, forwarding the path to a local signaling service. The
// target defaults to the service's development address and may be changed,
// for the browser tests, with DRIFTLESS_SIGNALING_TARGET. It must be a
// loopback http URL: this proxy is a development convenience only.
const SIGNALING_TARGET = loopbackTarget(
  process.env.DRIFTLESS_SIGNALING_TARGET ?? 'http://127.0.0.1:8787',
);

function loopbackTarget(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new Error('DRIFTLESS_SIGNALING_TARGET must be a loopback http origin.');
  }
  return url.origin;
}

// The Origin header is forwarded unchanged, so the signaling service applies
// its own origin policy to the browser's real origin.
const signalingProxy: Record<string, ProxyOptions> = {
  '/v1/signaling': { target: SIGNALING_TARGET, ws: true, changeOrigin: false },
};

export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: signalingProxy,
  },
  preview: {
    port: 4173,
    strictPort: true,
    proxy: signalingProxy,
  },
  test: {
    // Unit tests run against the protocol sources, so they need no prior
    // build. Builds and the development server use the built package through
    // its exports map, which `tsc -b` produces first.
    alias: {
      '@driftless/protocol': fileURLToPath(
        new URL('../../packages/protocol/src/index.ts', import.meta.url),
      ),
    },
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
