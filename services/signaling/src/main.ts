import { loadConfig } from './config.js';
import { createJsonLogger } from './logger.js';
import { createSignalingServer } from './server.js';

const result = loadConfig(process.env);
if (!result.ok) {
  process.stderr.write(`driftless-signaling: invalid configuration: ${result.error}\n`);
  process.exit(1);
}
const { config } = result;

if (config.mode === 'development') {
  process.stderr.write(
    'driftless-signaling: development mode. Plain ws:// is a development-only exception; ' +
      'production requires HTTPS and WSS through TLS termination in front of this service.\n',
  );
}

const server = createSignalingServer({
  host: config.host,
  port: config.port,
  allowedOrigins: config.allowedOrigins,
  roomTtlMs: config.roomTtlMs,
  reconnectGraceMs: config.reconnectGraceMs,
  heartbeatIntervalMs: config.heartbeatIntervalMs,
  logger: createJsonLogger(),
});

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await server.stop();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    shutdown().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

try {
  await server.start();
} catch {
  process.stderr.write('driftless-signaling: could not listen on the configured address.\n');
  process.exit(1);
}
