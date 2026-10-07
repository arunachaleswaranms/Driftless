// Read-only physical sampler. Endpoints and output paths stay outside evidence.
import { chromium } from '@playwright/test';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { sample } from './sampler.mjs';
import { summarize } from './metrics.mjs';
const [hostEndpoint, guestEndpoint, output, secondsArg = '1800'] = process.argv.slice(2);
if (!hostEndpoint || !guestEndpoint || !output)
  throw new Error('Usage: sample-cdp HOST_CDP GUEST_CDP OUTPUT [SECONDS]');
const sha = process.env.DRIFTLESS_BUILD_REVISION;
if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Require exact DRIFTLESS_BUILD_REVISION');
const seconds = Number(secondsArg);
if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('invalid seconds');
const browsers = await Promise.all([
  chromium.connectOverCDP(hostEndpoint),
  chromium.connectOverCDP(guestEndpoint),
]);
const pages = [];
for (const b of browsers) {
  const matches = [];
  for (const c of b.contexts())
    for (const p of c.pages()) if (await p.locator('video').count()) matches.push(p);
  if (matches.length !== 1) throw new Error('Require exactly one video page per endpoint');
  pages.push(matches[0]);
}
for (const p of pages) {
  const build = await p
    .locator('details')
    .filter({ hasText: 'Connection diagnostics' })
    .locator('dt:text-is("Build") + dd')
    .textContent();
  if (build !== sha) throw new Error('candidate build mismatch');
}
const samples = [];
const startMs = performance.now();
try {
  for (let i = 0; i < seconds; i++) {
    const wait = startMs + i * 1000 - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      samples.push(await sample(...pages));
    } catch {
      samples.push({ atMs: performance.now(), valid: false, reasons: ['evaluation_failed'] });
    }
    if (i % 60 === 0) console.log(`sample ${i}/${seconds}`);
  }
  const wait = startMs + seconds * 1000 - performance.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
} finally {
  await writeFile(
    output,
    JSON.stringify(
      {
        classification: 'UNCLASSIFIED — operator must verify physical topology/build/steady state',
        samples,
        qualificationSha: sha,
        summary: summarize(samples, { startMs, endMs: startMs + seconds * 1000 }),
        completedDurationMs: performance.now() - startMs,
        continuousPlaying: samples.every(
          (s) => s.host?.paused === false && s.guest?.paused === false,
        ),
        hostAlways1x: samples.every((s) => s.host?.playbackRate === 1),
        mediaErrorSamples: samples.filter((s) => s.host?.mediaError || s.guest?.mediaError).length,
      },
      null,
      2,
    ),
  );
  // Disconnect automation only; never close a participant's browser.
  for (const b of browsers) await b.close();
}
