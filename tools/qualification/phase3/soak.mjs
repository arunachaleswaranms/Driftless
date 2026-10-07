// AUTOMATED SAME-HOST DEVELOPMENT BROWSER EVIDENCE; never a physical gate.
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { sample } from './sampler.mjs';
import { summarize } from './metrics.mjs';
import { installProbe } from './probe.mjs';
const [fixture, output, secondsArg = '1800'] = process.argv.slice(2);
const sha = process.env.DRIFTLESS_BUILD_REVISION;
if (
  !fixture ||
  !output ||
  !/^[a-f0-9]{40}$/.test(sha ?? '') ||
  execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== sha
)
  throw new Error('Require fixture, external output, and exact committed DRIFTLESS_BUILD_REVISION');
const seconds = Number(secondsArg);
if (!Number.isInteger(seconds) || seconds < 1) throw new Error('invalid duration');
const base = 'http://localhost:4183';
const children = [];
const errors = [];
const samples = [];
const resources = [];
let browser, startMs, endMs;
let stage = 'servers';
const result = {
  classification: 'AUTOMATED SAME-HOST DEVELOPMENT BROWSER EVIDENCE',
  qualificationSha: sha,
  seconds,
  errors,
};
const launch = (cmd, args, env) => {
  const ch = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: 'ignore' });
  children.push(ch);
  return ch;
};
async function waitServer(url) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server startup timeout');
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const panel = (p) => p.getByRole('region', { name: 'Local Sync setup' });
const state = (p) => p.evaluate(() => ({ ...window.__phase3Qualification }));
try {
  launch('node', ['services/signaling/dist/main.js'], {
    SIGNALING_HOST: '127.0.0.1',
    SIGNALING_PORT: '8793',
    SIGNALING_ALLOWED_ORIGINS: base,
    NODE_ENV: 'development',
  });
  const preview = spawn(
    'node',
    [
      '../../node_modules/vite/bin/vite.js',
      'preview',
      '--host',
      '127.0.0.1',
      '--port',
      '4183',
      '--strictPort',
    ],
    {
      cwd: 'apps/web',
      env: { ...process.env, DRIFTLESS_SIGNALING_TARGET: 'http://127.0.0.1:8793' },
      stdio: 'ignore',
    },
  );
  children.push(preview);
  await waitServer(base);
  stage = 'launch_browser';
  browser = await chromium.launch({ channel: 'chrome' });
  result.browserVersion = browser.version();
  const pages = [];
  const sessions = [];
  for (let i = 0; i < 2; i++) {
    const c = await browser.newContext();
    await c.addInitScript(installProbe);
    const p = await c.newPage();
    pages.push(p);
    p.on('pageerror', () => errors.push({ kind: 'pageerror', peer: i }));
    p.on('console', (m) => {
      if (m.type() === 'error') errors.push({ kind: 'console_error', peer: i });
    });
    p.on('request', (r) => {
      if (!['GET', 'HEAD'].includes(r.method())) errors.push({ kind: 'upload_request', peer: i });
    });
    await p.goto(base);
    const cdp = await c.newCDPSession(p);
    await cdp.send('Performance.enable');
    sessions.push(cdp);
  }
  stage = 'create_room';
  const [host, guest] = pages;
  await host.getByRole('button', { name: 'Create room', exact: true }).click();
  const invite = host.getByRole('group', { name: 'Invite' });
  await expect(invite).toBeVisible();
  const room = await invite
    .locator('dt', { hasText: 'Room ID' })
    .locator('+ dd code')
    .textContent();
  await invite.getByRole('button', { name: 'Show invite secret' }).click();
  const secret = await invite
    .locator('dt', { hasText: 'Invite secret' })
    .locator('+ dd code')
    .textContent();
  await invite.getByRole('button', { name: 'Show invite secret' }).click();
  stage = 'join_room';
  await guest.getByLabel('Room ID', { exact: true }).fill(room);
  await guest.getByLabel('Invite secret', { exact: true }).fill(secret);
  await guest.getByRole('button', { name: 'Join room', exact: true }).click();
  stage = 'connection_and_file';
  for (const p of pages) {
    await expect(p.locator('.room-status')).toHaveText('Peer data channel is connected.', {
      timeout: 20000,
    });
    const d = p.locator('details', { hasText: 'Connection diagnostics' });
    await d.locator('summary').click();
    await expect(d.locator('dt:text-is("Build") + dd')).toHaveText(sha);
    await p.locator('input[type=file]').setInputFiles(fixture);
  }
  for (const p of pages) {
    await expect(panel(p).getByRole('button', { name: "I'm ready", exact: true })).toBeEnabled({
      timeout: 60000,
    });
    await panel(p).getByRole('button', { name: "I'm ready", exact: true }).click();
  }
  await expect(panel(host).getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  stage = 'baseline';
  result.baseline = await sample(host, guest);
  await panel(host).getByRole('button', { name: 'Play', exact: true }).click();
  for (const p of pages)
    await expect.poll(() => p.locator('video').evaluate((v) => v.paused)).toBe(false);
  await delay(10000);
  startMs = performance.now();
  result.before = await Promise.all(pages.map(state));
  for (let i = 0; i < seconds; i++) {
    const wait = startMs + i * 1000 - performance.now();
    if (wait > 0) await delay(wait);
    try {
      samples.push(await sample(host, guest));
    } catch {
      samples.push({ atMs: performance.now(), valid: false, reasons: ['evaluation_failed'] });
    }
    if (i % 60 === 0) {
      const metrics = await Promise.all(sessions.map((s) => s.send('Performance.getMetrics')));
      resources.push({
        second: i,
        peers: metrics.map((m) =>
          Object.fromEntries(
            m.metrics
              .filter((x) => ['JSHeapUsedSize', 'Nodes', 'Documents'].includes(x.name))
              .map((x) => [x.name, x.value]),
          ),
        ),
      });
      console.log(`soak ${i}/${seconds} seconds; drift ${samples.at(-1).driftMs?.toFixed(1)} ms`);
    }
  }
  const remaining = startMs + seconds * 1000 - performance.now();
  if (remaining > 0) await delay(remaining);
  endMs = startMs + seconds * 1000;
  result.completedDurationMs = performance.now() - startMs;
  result.after = await Promise.all(pages.map(state));
  result.final = await sample(host, guest);
  result.path = await Promise.all(
    pages.map((p) =>
      p
        .locator('details')
        .filter({ hasText: 'Connection diagnostics' })
        .locator('dt:text-is("Path") + dd')
        .textContent(),
    ),
  );
  result.storage = await Promise.all(
    pages.map((p) =>
      p.evaluate(async () => ({
        localStorage: localStorage.length,
        sessionStorage: sessionStorage.length,
        databases: (await indexedDB.databases()).length,
        caches: (await caches.keys()).length,
        opfsEntries: await (async () => {
          let n = 0;
          for await (const unused of (await navigator.storage.getDirectory()).keys()) n++;
          return n;
        })(),
        urlState: !!(location.search || location.hash),
      })),
    ),
  );
  result.rateCounts = {
    slow: samples.filter((s) => s.guest?.playbackRate === 0.95).length,
    fast: samples.filter((s) => s.guest?.playbackRate === 1.05).length,
  };
  result.invariants = {
    noAsyncOrMediaError: result.after.every((p) => p.unhandled === 0 && p.mediaErrors === 0),
    hostAlways1x: samples.every((s) => s.host?.playbackRate === 1),
    bothAlwaysPlaying: samples.every((s) => s.host?.paused === false && s.guest?.paused === false),
    mediaErrors: samples.filter((s) => s.host?.mediaError || s.guest?.mediaError).length,
    samePeerAndChannel: result.after.every(
      (p) => p.pcs === 1 && p.channels === 1 && p.liveChannels === 1,
    ),
    guestAuthority: result.after[1].authority,
    noReadyCycling: result.after.every(
      (p, i) =>
        p.readySends === result.before[i].readySends &&
        p.notReadySends === result.before[i].notReadySends,
    ),
    noBinaryOrSignalingPlayback: result.after.every(
      (p) =>
        p.binary === 0 &&
        p.invalidControl === 0 &&
        p.privateMetadata === 0 &&
        p.signalingPlayback === 0,
    ),
    oneObjectUrlEach: result.after.every((p) => p.urlsCreated === 1 && p.urlsRevoked === 0),
  };
} catch (error) {
  errors.push({
    kind: 'runner_failure',
    stage,
    location: String(error.stack)
      .split('\n')
      .find((l) => l.includes('soak.mjs:'))
      ?.trim()
      .replace(/.*soak.mjs:/, 'soak.mjs:'),
  });
  console.error('qualification runner failed; sanitized partial evidence retained');
} finally {
  if (startMs) {
    endMs ??= performance.now();
    result.summary = summarize(samples, { startMs, endMs });
  }
  result.samples = samples;
  result.resources = resources;
  await writeFile(output, JSON.stringify(result, null, 2));
  if (browser) await browser.close();
  for (const c of children) c.kill();
}
if (
  errors.length ||
  result.summary?.state !== 'PASS' ||
  !result.invariants?.noAsyncOrMediaError ||
  !result.invariants?.hostAlways1x ||
  !result.invariants?.bothAlwaysPlaying ||
  !result.invariants?.samePeerAndChannel ||
  !result.invariants?.noReadyCycling ||
  !result.invariants?.noBinaryOrSignalingPlayback ||
  result.invariants?.guestAuthority !== 0 ||
  result.invariants?.mediaErrors !== 0
)
  process.exitCode = 1;
