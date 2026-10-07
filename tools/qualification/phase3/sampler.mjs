import { performance } from 'node:perf_hooks';
import { measure } from './metrics.mjs';
export async function read(page) {
  const beforeMs = performance.now();
  const state = await page.evaluate(() => {
    const v = document.querySelector('video');
    if (!v) throw new Error('no video');
    return {
      currentTime: v.currentTime,
      duration: v.duration,
      paused: v.paused,
      playbackRate: v.playbackRate,
      browserMonotonicMs: performance.now(),
      mediaError: v.error?.code ?? null,
      readyState: v.readyState,
      ended: v.ended,
    };
  });
  return { ...state, beforeMs, afterMs: performance.now() };
}
export async function sample(host, guest) {
  const [h, g] = await Promise.all([read(host), read(guest)]);
  return { atMs: performance.now(), host: h, guest: g, ...measure(h, g) };
}
