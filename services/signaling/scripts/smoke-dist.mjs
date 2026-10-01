// Smoke test of the built service: runs dist/main.js exactly as `npm start`
// does, with @driftless/protocol resolved from its built package. It checks
// startup logging, the health endpoint, one room round trip with a relayed
// WebRTC offer, an authenticated resume after a lost guest connection,
// configuration refusal, and a clean SIGTERM shutdown.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resumeProofInput, resumeSecretBytes } from '@driftless/protocol';
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

const guest = new WebSocket(`ws://${host}:${port}/v1/signaling`, { origin: ORIGIN });
await withTimeout(once(guest, 'open'), 'guest websocket open');
const envelope = (type, sequence, payload) =>
  JSON.stringify({ protocolVersion: 1, type, sequence, sentAt: 0, payload });
guest.send(
  envelope('ROOM_JOIN', 0, {
    roomId: created.payload.roomId,
    inviteSecret: created.payload.inviteSecret,
  }),
);
const [joinedData] = await withTimeout(once(guest, 'message'), 'ROOM_JOINED');
assert.equal(JSON.parse(joinedData.toString('utf8')).type, 'ROOM_JOINED');
const [noticeData] = await withTimeout(once(socket, 'message'), 'ROOM_PARTICIPANT_JOINED');
assert.equal(JSON.parse(noticeData.toString('utf8')).type, 'ROOM_PARTICIPANT_JOINED');
const offer = { negotiationId: 'N'.repeat(24), sdp: 'v=0\r\na=ice-pwd:SMOKEMARK\r\n' };
socket.send(envelope('RTC_OFFER', 1, offer));
const [offerData] = await withTimeout(once(guest, 'message'), 'RTC_OFFER');
const relayed = JSON.parse(offerData.toString('utf8'));
assert.equal(relayed.type, 'RTC_OFFER');
assert.deepEqual(relayed.payload, offer);

// The guest's connection is lost; a new connection resumes it by proof.
const joined = JSON.parse(joinedData.toString('utf8'));
const lostNotice = once(socket, 'message');
guest.terminate();
const [lostData] = await withTimeout(lostNotice, 'RECONNECTING notice');
assert.equal(JSON.parse(lostData.toString('utf8')).payload.signaling, 'RECONNECTING');
const resumed = new WebSocket(`ws://${host}:${port}/v1/signaling`, { origin: ORIGIN });
await withTimeout(once(resumed, 'open'), 'resume websocket open');
const { sessionId, participantId, resumeSecret } = joined.payload;
resumed.send(envelope('SESSION_RESUME_BEGIN', 0, { sessionId, participantId }));
const [challengeData] = await withTimeout(once(resumed, 'message'), 'challenge');
const { challenge } = JSON.parse(challengeData.toString('utf8')).payload;
const key = createHash('sha256').update(resumeSecretBytes(resumeSecret)).digest();
const proof = createHmac('sha256', key)
  .update(resumeProofInput(sessionId, participantId, challenge))
  .digest('base64url');
const backNotice = once(socket, 'message');
resumed.send(envelope('SESSION_RESUME_PROVE', 1, { challenge, proof }));
const [resumedData] = await withTimeout(once(resumed, 'message'), 'SESSION_RESUMED');
const resumedMessage = JSON.parse(resumedData.toString('utf8'));
assert.equal(resumedMessage.type, 'SESSION_RESUMED');
assert.equal(resumedMessage.payload.participantId, participantId);
assert.equal(resumedMessage.payload.activeNegotiationId, offer.negotiationId);
const [backData] = await withTimeout(backNotice, 'CONNECTED notice');
assert.equal(JSON.parse(backData.toString('utf8')).payload.signaling, 'CONNECTED');

const closed = once(socket, 'close');
const guestClosed = once(resumed, 'close');

child.kill('SIGTERM');
const [exitCode] = await withTimeout(once(child, 'exit'), 'shutdown');
const [closeCode] = await withTimeout(closed, 'client close');
const [guestCloseCode] = await withTimeout(guestClosed, 'guest close');
assert.equal(exitCode, 0);
assert.equal(closeCode, 1001);
assert.equal(guestCloseCode, 1001);

const logged = JSON.stringify(logs);
assert.ok(!logged.includes(created.payload.inviteSecret), 'invite secret was logged');
assert.ok(!logged.includes(created.payload.roomId), 'room ID was logged');
assert.ok(!logged.includes('SMOKEMARK'), 'session description was logged');
assert.ok(!logged.includes(offer.negotiationId), 'negotiation ID was logged');
for (const value of [resumeSecret, created.payload.resumeSecret, sessionId, challenge, proof]) {
  assert.ok(!logged.includes(value), 'a resume value was logged');
}
assert.deepEqual(
  logs.map((event) => event.event),
  [
    'server_started',
    'connection_opened',
    'room_created',
    'connection_opened',
    'participant_joined',
    'negotiation_relayed',
    'participant_disconnected',
    'connection_closed',
    'connection_opened',
    'resume_challenge_issued',
    'participant_resumed',
    'connection_closed',
    'connection_closed',
    'server_stopped',
  ],
);

console.log('@driftless/signaling dist smoke test passed');
