// Smoke test of the built service: runs dist/main.js exactly as `npm start`
// does, with @driftless/protocol resolved from its built package. It checks
// startup logging, the health endpoint, one room round trip, configuration
// refusal, and a clean SIGTERM shutdown.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const MAIN = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const ORIGIN = 'http://localhost:5173';
const TIMEOUT_MS = 10_000;

function run(env) {
  // Only the variables under test, plus PATH; nothing else is inherited.
  return spawn(process.execPath, [MAIN], {
    env: { PATH: process.env.PATH, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function withTimeout(promise, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${what}`)), TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

// 1. Production mode without explicit origins must refuse to start.
{
  const child = run({ NODE_ENV: 'production' });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const [code] = await withTimeout(once(child, 'exit'), 'configuration refusal');
  assert.equal(code, 1);
  assert.match(stderr, /SIGNALING_ALLOWED_ORIGINS is required/);
}

// 2. Development mode on an ephemeral loopback port.
const child = run({ SIGNALING_PORT: '0' });
const lines = createInterface({ input: child.stdout });
const logs = [];
const started = new Promise((resolve) => {
  lines.on('line', (line) => {
    const event = JSON.parse(line);
    logs.push(event);
    if (event.event === 'server_started') resolve(event);
  });
});
const { host, port } = await withTimeout(started, 'server start');
assert.equal(host, '127.0.0.1');

const health = await fetch(`http://${host}:${port}/healthz`, { headers: { connection: 'close' } });
assert.equal(health.status, 200);
assert.equal(await health.text(), '{"status":"ok"}');

const socket = new WebSocket(`ws://${host}:${port}/v1/signaling`, { origin: ORIGIN });
await withTimeout(once(socket, 'open'), 'websocket open');
socket.send(
  JSON.stringify({ protocolVersion: 1, type: 'ROOM_CREATE', sequence: 0, sentAt: 0, payload: {} }),
);
const [data] = await withTimeout(once(socket, 'message'), 'ROOM_CREATED');
const created = JSON.parse(data.toString('utf8'));
assert.equal(created.type, 'ROOM_CREATED');
assert.equal(created.payload.role, 'host');
const closed = once(socket, 'close');

child.kill('SIGTERM');
const [exitCode] = await withTimeout(once(child, 'exit'), 'shutdown');
const [closeCode] = await withTimeout(closed, 'client close');
assert.equal(exitCode, 0);
assert.equal(closeCode, 1001);

const logged = JSON.stringify(logs);
assert.ok(!logged.includes(created.payload.inviteSecret), 'invite secret was logged');
assert.ok(!logged.includes(created.payload.roomId), 'room ID was logged');
assert.deepEqual(
  logs.map((event) => event.event),
  ['server_started', 'connection_opened', 'room_created', 'connection_closed', 'server_stopped'],
);

console.log('@driftless/signaling dist smoke test passed');
