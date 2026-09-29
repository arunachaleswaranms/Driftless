import { request } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  MAX_SIGNALING_MESSAGE_BYTES,
  type ServerMessage,
  type ServerMessageType,
} from '@driftless/protocol';
import { WebSocket } from 'ws';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryLogger, type LogEvent } from '../src/logger.js';
import {
  createSignalingServer,
  SIGNALING_PATH,
  type SignalingServer,
  type SignalingServerOptions,
} from '../src/server.js';
import { FakeClock, ManualScheduler, clientMessage, expectType, parseStrict } from './support.js';

const HOST = '127.0.0.1';
const ORIGIN = 'http://localhost:5173';
const TTL = 60_000;
const WAIT_MS = 3000;

interface Running {
  readonly server: SignalingServer;
  readonly port: number;
  readonly logs: LogEvent[];
  readonly clock: FakeClock;
  readonly scheduler: ManualScheduler;
}

const running: Running[] = [];
const clients: TestClient[] = [];

async function startServer(overrides: Partial<SignalingServerOptions> = {}): Promise<Running> {
  const logger = createMemoryLogger();
  const clock = new FakeClock(Date.now());
  const scheduler = new ManualScheduler();
  const server = createSignalingServer({
    host: HOST,
    port: 0,
    allowedOrigins: [ORIGIN],
    roomTtlMs: TTL,
    logger,
    clock: clock.read,
    scheduler,
    ...overrides,
  });
  const { port } = await server.start();
  const instance = { server, port, logs: logger.events, clock, scheduler };
  running.push(instance);
  return instance;
}

/** Resolves when `predicate` holds, polling briefly; fails after WAIT_MS. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class TestClient {
  readonly messages: ServerMessage[] = [];
  readonly raw: string[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  #read = 0;
  #sequence = 0;
  #waiters: (() => void)[] = [];

  readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      expect(isBinary).toBe(false);
      const text = data.toString('utf8');
      this.raw.push(text);
      this.messages.push(parseStrict(text));
      for (const wake of this.#waiters.splice(0)) wake();
    });
    this.closed = new Promise((resolve) => {
      socket.on('close', (code: number, reason: Buffer) => {
        resolve({ code, reason: reason.toString('utf8') });
        for (const wake of this.#waiters.splice(0)) wake();
      });
    });
  }

  static async open(port: number, origin = ORIGIN): Promise<TestClient> {
    const socket = new WebSocket(`ws://${HOST}:${String(port)}${SIGNALING_PATH}`, { origin });
    const client = new TestClient(socket);
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        resolve();
      });
      socket.once('error', reject);
    });
    return client;
  }

  send(type: string, payload: unknown = {}, extra: object = {}): void {
    this.socket.send(clientMessage(type, payload, this.#sequence++, extra));
  }

  sendRaw(data: string | Buffer): void {
    this.socket.send(data);
  }

  /** The next unread message, waiting for it if necessary. */
  async next(): Promise<ServerMessage> {
    const deadline = Date.now() + WAIT_MS;
    while (this.#read >= this.messages.length) {
      if (this.socket.readyState === WebSocket.CLOSED) throw new Error('Socket closed');
      if (Date.now() > deadline) throw new Error('Timed out waiting for a message');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, WAIT_MS);
        this.#waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    const message = this.messages[this.#read];
    this.#read += 1;
    if (message === undefined) throw new Error('unreachable');
    return message;
  }

  async expect<Type extends ServerMessageType>(
    type: Type,
  ): Promise<Extract<ServerMessage, { type: Type }>> {
    return expectType(await this.next(), type);
  }

  async expectError(code: string, recoverable: boolean): Promise<void> {
    const error = await this.expect('ERROR');
    expect(error.payload.code).toBe(code);
    expect(error.payload.recoverable).toBe(recoverable);
  }
}

/** Attempts a WebSocket upgrade that should be refused; returns the status. */
function refusedUpgrade(port: number, path: string, origin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `ws://${HOST}:${String(port)}${path}`,
      origin === undefined ? {} : { origin },
    );
    socket.on('unexpected-response', (req, res) => {
      resolve(res.statusCode ?? 0);
      req.destroy();
    });
    socket.on('open', () => {
      socket.terminate();
      reject(new Error('upgrade was accepted'));
    });
    socket.on('error', () => {
      // Expected after the request is destroyed.
    });
  });
}

/** Sends a hand-built upgrade request and returns the response status. */
function rawUpgradeStatus(port: number, path: string, origin: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: HOST,
      port,
      path,
      agent: false,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        Origin: origin,
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64'),
      },
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Completes a WebSocket handshake by hand and returns the raw socket. It never
 * answers the server's close frame, so it holds shutdown in its grace period.
 */
function silentWebSocket(port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: HOST,
      port,
      path: SIGNALING_PATH,
      agent: false,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        Origin: ORIGIN,
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from('fedcba9876543210').toString('base64'),
      },
    });
    req.on('upgrade', (_res, socket) => {
      socket.on('error', () => {
        // The server terminates this socket at the end of shutdown.
      });
      resolve(socket);
    });
    req.on('response', () => {
      reject(new Error('upgrade refused'));
    });
    req.on('error', reject);
    req.end();
  });
}

function httpRequest(
  port: number,
  path: string,
  method = 'GET',
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: HOST, port, path, method, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function roomPair(instance: Running) {
  const host = await TestClient.open(instance.port);
  host.send('ROOM_CREATE');
  const created = await host.expect('ROOM_CREATED');
  const guest = await TestClient.open(instance.port);
  guest.send('ROOM_JOIN', {
    roomId: created.payload.roomId,
    inviteSecret: created.payload.inviteSecret,
  });
  const joined = await guest.expect('ROOM_JOINED');
  const notice = await host.expect('ROOM_PARTICIPANT_JOINED');
  return { host, guest, created, joined, notice };
}

const NETWORK_RESOURCES = new Set(['TCPServerWrap', 'TCPSocketWrap', 'TCPWrap']);
function networkResources(): number {
  return process.getActiveResourcesInfo().filter((type) => NETWORK_RESOURCES.has(type)).length;
}
let baselineNetwork = 0;
let baselineTimers = 0;

beforeAll(() => {
  baselineNetwork = networkResources();
  baselineTimers = process.getActiveResourcesInfo().filter((type) => type === 'Timeout').length;
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.socket.terminate();
  for (const instance of running.splice(0)) {
    await instance.server.stop();
    expect(instance.scheduler.tasks.size).toBe(0);
    expect(instance.server.connectionCount).toBe(0);
    expect(instance.server.roomCount).toBe(0);
  }
});

afterAll(async () => {
  // No server, socket, or timer may outlive the suite.
  await until(() => networkResources() <= baselineNetwork, 'sockets to close');
  const timers = process.getActiveResourcesInfo().filter((type) => type === 'Timeout').length;
  expect(timers).toBeLessThanOrEqual(baselineTimers);
});

describe('HTTP endpoints', () => {
  it('serves a minimal health response', async () => {
    const { port } = await startServer();
    const response = await httpRequest(port, '/healthz');
    expect(response.status).toBe(200);
    expect(response.body).toBe('{"status":"ok"}');
    expect(response.headers['content-type']).toBe('application/json');
    expect(response.headers['cache-control']).toBe('no-store');
    expect((await httpRequest(port, '/healthz', 'HEAD')).status).toBe(200);
    expect((await httpRequest(port, '/healthz', 'POST')).status).toBe(405);
    expect((await httpRequest(port, '/')).status).toBe(404);
    expect((await httpRequest(port, SIGNALING_PATH)).status).toBe(404);
  });

  it('reveals nothing about rooms in the health response', async () => {
    const instance = await startServer();
    const { created, joined } = await roomPair(instance);
    const { body } = await httpRequest(instance.port, '/healthz');
    expect(body).toBe('{"status":"ok"}');
    for (const value of [
      created.payload.inviteSecret,
      created.payload.roomId,
      created.payload.participantId,
      joined.payload.participantId,
    ]) {
      expect(body).not.toContain(value);
    }
  });
});

describe('WebSocket upgrade policy', () => {
  it('accepts an allowed origin', async () => {
    const { port } = await startServer();
    const client = await TestClient.open(port, ORIGIN);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('refuses disallowed, look-alike, null, and missing origins', async () => {
    const instance = await startServer();
    for (const origin of [
      'http://evil.example',
      'http://localhost:5174',
      'https://localhost:5173',
      'http://localhost:5173.evil.example',
      'null',
    ]) {
      expect(await refusedUpgrade(instance.port, SIGNALING_PATH, origin)).toBe(403);
    }
    expect(await refusedUpgrade(instance.port, SIGNALING_PATH)).toBe(403);
    expect(instance.logs.filter((e) => e.event === 'upgrade_rejected')).toHaveLength(6);
    expect(instance.server.connectionCount).toBe(0);
  });

  it('refuses other paths and any query string', async () => {
    const instance = await startServer();
    expect(await refusedUpgrade(instance.port, '/', ORIGIN)).toBe(404);
    expect(await refusedUpgrade(instance.port, '/v1/signaling/extra', ORIGIN)).toBe(404);
    expect(await refusedUpgrade(instance.port, '/v2/signaling', ORIGIN)).toBe(404);
    expect(await refusedUpgrade(instance.port, `${SIGNALING_PATH}?roomId=x`, ORIGIN)).toBe(400);
    // WebSocket clients drop a bare '?', so send that upgrade request by hand.
    expect(await rawUpgradeStatus(instance.port, `${SIGNALING_PATH}?`, ORIGIN)).toBe(400);
    expect(await rawUpgradeStatus(instance.port, SIGNALING_PATH, ORIGIN)).toBe(101);
  });

  it('refuses connections beyond the connection bound', async () => {
    const { port } = await startServer({ maxConnections: 1 });
    await TestClient.open(port);
    expect(await refusedUpgrade(port, SIGNALING_PATH, ORIGIN)).toBe(503);
  });

  it('rejects a wildcard origin configuration', () => {
    expect(() =>
      createSignalingServer({ host: HOST, port: 0, allowedOrigins: ['*'], roomTtlMs: TTL }),
    ).toThrow();
  });
});

describe('room flows', () => {
  it('creates a room and joins a guest with sanitized events on both sides', async () => {
    const instance = await startServer();
    const { created, joined, notice } = await roomPair(instance);
    expect(created.payload.role).toBe('host');
    expect(created.payload.expiresAt).toBe(instance.clock.now + TTL);
    expect(joined.payload.role).toBe('guest');
    expect(joined.payload.peer).toStrictEqual({
      participantId: created.payload.participantId,
      role: 'host',
    });
    expect(notice.payload.participant).toStrictEqual({
      participantId: joined.payload.participantId,
      role: 'guest',
    });
    expect(instance.server.roomCount).toBe(1);
  });

  it('refuses a third participant', async () => {
    const instance = await startServer();
    const { created } = await roomPair(instance);
    const third = await TestClient.open(instance.port);
    third.send('ROOM_JOIN', {
      roomId: created.payload.roomId,
      inviteSecret: created.payload.inviteSecret,
    });
    await third.expectError('ROOM_FULL', true);
  });

  it('refuses a bad secret without revealing whether the room exists', async () => {
    const instance = await startServer();
    const host = await TestClient.open(instance.port);
    host.send('ROOM_CREATE');
    const created = await host.expect('ROOM_CREATED');
    const probe = await TestClient.open(instance.port);
    const secret = created.payload.inviteSecret;
    const wrong = `${secret.startsWith('A') ? 'B' : 'A'}${secret.slice(1)}`;
    probe.send('ROOM_JOIN', { roomId: created.payload.roomId, inviteSecret: wrong });
    probe.send('ROOM_JOIN', { roomId: 'AAAAAAAAAAAAAAAAAAAAAA', inviteSecret: wrong });
    const first = await probe.next();
    const second = await probe.next();
    expect(first.payload).toStrictEqual(second.payload);
    expect(expectType(first, 'ERROR').payload.code).toBe('ROOM_UNAVAILABLE');
    expect(probe.raw.join('')).not.toContain(created.payload.roomId);
    expect(host.messages).toHaveLength(1);
  });

  it('prevents a connection from creating or joining a second room', async () => {
    const instance = await startServer();
    const { host, guest, created } = await roomPair(instance);
    host.send('ROOM_CREATE');
    await host.expectError('INVALID_STATE', true);
    guest.send('ROOM_JOIN', {
      roomId: created.payload.roomId,
      inviteSecret: created.payload.inviteSecret,
    });
    await guest.expectError('INVALID_STATE', true);
    expect(instance.server.roomCount).toBe(1);
  });

  it('notifies the host when the guest leaves', async () => {
    const instance = await startServer();
    const { host, guest, joined } = await roomPair(instance);
    guest.send('ROOM_LEAVE');
    await guest.expect('ROOM_LEFT');
    const left = await host.expect('ROOM_PARTICIPANT_LEFT');
    expect(left.payload).toStrictEqual({
      participantId: joined.payload.participantId,
      reason: 'LEFT',
    });
  });

  it('closes the room for the guest when the host leaves', async () => {
    const instance = await startServer();
    const { host, guest } = await roomPair(instance);
    host.send('ROOM_LEAVE');
    await host.expect('ROOM_LEFT');
    expect((await guest.expect('ROOM_CLOSED')).payload.reason).toBe('HOST_LEFT');
    expect(instance.server.roomCount).toBe(0);
  });

  it('cleans up membership when a guest or host disconnects abruptly', async () => {
    const instance = await startServer();
    const first = await roomPair(instance);
    first.guest.socket.terminate();
    expect((await first.host.expect('ROOM_PARTICIPANT_LEFT')).payload.reason).toBe('DISCONNECTED');
    await until(() => instance.server.connectionCount === 1, 'guest release');

    first.host.socket.terminate();
    await until(() => instance.server.roomCount === 0, 'room removal');

    const second = await roomPair(instance);
    second.host.socket.terminate();
    expect((await second.guest.expect('ROOM_CLOSED')).payload.reason).toBe('HOST_DISCONNECTED');
    await until(() => instance.server.roomCount === 0, 'room removal');
  });

  it('expires rooms through the periodic sweep', async () => {
    const instance = await startServer();
    const { host, guest, created } = await roomPair(instance);
    instance.clock.advance(TTL - 1);
    instance.scheduler.tick();
    expect(instance.server.roomCount).toBe(1);
    instance.clock.advance(1);
    instance.scheduler.tick();
    expect((await host.expect('ROOM_CLOSED')).payload.reason).toBe('EXPIRED');
    expect((await guest.expect('ROOM_CLOSED')).payload.reason).toBe('EXPIRED');
    expect(instance.server.roomCount).toBe(0);

    const late = await TestClient.open(instance.port);
    late.send('ROOM_JOIN', {
      roomId: created.payload.roomId,
      inviteSecret: created.payload.inviteSecret,
    });
    await late.expectError('ROOM_UNAVAILABLE', true);
  });

  it('refuses new connections while shutting down', async () => {
    const instance = await startServer({ shutdownGraceMs: 1000 });
    running.splice(running.indexOf(instance), 1);
    const silent = await silentWebSocket(instance.port);
    await until(() => instance.server.connectionCount === 1, 'silent connection');
    const stopped = instance.server.stop();
    // The silent client holds shutdown in its grace period; the listener is still open.
    expect(await refusedUpgrade(instance.port, SIGNALING_PATH, ORIGIN)).toBe(503);
    await stopped;
    silent.destroy();
    expect(instance.logs).toContainEqual({
      event: 'upgrade_rejected',
      reason: 'stopping',
      status: 503,
    });
    expect(instance.logs.filter((event) => event.event === 'room_created')).toHaveLength(0);
  });

  it('shares one stop between callers and waits for a pending start', async () => {
    const logger = createMemoryLogger();
    const scheduler = new ManualScheduler();
    const server = createSignalingServer({
      host: HOST,
      port: 0,
      allowedOrigins: [ORIGIN],
      roomTtlMs: TTL,
      logger,
      scheduler,
    });
    const starting = server.start();
    const first = server.stop();
    expect(server.stop()).toBe(first);
    await expect(starting).rejects.toThrow('stopped during start');
    await first;
    expect(scheduler.tasks.size).toBe(0);
    expect(logger.events.filter((event) => event.event === 'server_stopped')).toHaveLength(1);
    expect(logger.events.filter((event) => event.event === 'server_started')).toHaveLength(0);
    await expect(server.start()).rejects.toThrow('only once');
  });

  it('closes open connections on shutdown', async () => {
    const instance = await startServer();
    const { host, guest } = await roomPair(instance);
    running.splice(running.indexOf(instance), 1);
    await instance.server.stop();
    expect((await host.closed).code).toBe(1001);
    expect((await guest.closed).code).toBe(1001);
    expect(instance.scheduler.tasks.size).toBe(0);
  });
});

describe('malformed and abusive input', () => {
  it('rejects invalid JSON safely', async () => {
    const { port } = await startServer();
    const client = await TestClient.open(port);
    client.sendRaw('{"protocolVersion":1,');
    await client.expectError('INVALID_MESSAGE', true);
    expect(client.raw.join('')).not.toMatch(/Unexpected|JSON|position/);
  });

  it('rejects unknown versions and closes the connection', async () => {
    const { port } = await startServer();
    const client = await TestClient.open(port);
    client.send('ROOM_CREATE', {}, { protocolVersion: 2 });
    await client.expectError('UNSUPPORTED_PROTOCOL', false);
    expect((await client.closed).code).toBe(1002);
  });

  it('rejects unknown and out-of-scope message types', async () => {
    const { port } = await startServer();
    const client = await TestClient.open(port);
    for (const type of ['ROOM_DELETE', 'OFFER', 'ICE_CANDIDATE']) {
      client.send(type, {});
      await client.expectError('INVALID_MESSAGE', true);
    }
  });

  it('rejects extra fields', async () => {
    const { port } = await startServer();
    const client = await TestClient.open(port);
    client.send('ROOM_CREATE', {}, { extra: true });
    await client.expectError('INVALID_MESSAGE', true);
    client.send('ROOM_CREATE', { role: 'host' });
    await client.expectError('INVALID_MESSAGE', true);
  });

  it('rejects duplicate and stale sequence numbers', async () => {
    const { port } = await startServer();
    const client = await TestClient.open(port);
    client.sendRaw(clientMessage('ROOM_LEAVE', {}, 10));
    await client.expectError('INVALID_STATE', true);
    client.sendRaw(clientMessage('ROOM_CREATE', {}, 10));
    await client.expectError('INVALID_MESSAGE', true);
    client.sendRaw(clientMessage('ROOM_CREATE', {}, 3));
    await client.expectError('INVALID_MESSAGE', true);
    client.sendRaw(clientMessage('ROOM_CREATE', {}, 11));
    await client.expect('ROOM_CREATED');
  });

  it('accepts a message at the size bound and closes on one above it', async () => {
    const { port } = await startServer();
    const client = await TestClient.open(port);
    const message = clientMessage('ROOM_CREATE', {}, 0);
    client.sendRaw(message.padEnd(MAX_SIGNALING_MESSAGE_BYTES, ' '));
    await client.expect('ROOM_CREATED');
    client.sendRaw('x'.repeat(MAX_SIGNALING_MESSAGE_BYTES + 1));
    expect((await client.closed).code).toBe(1009);
  });

  it('refuses binary messages and closes the connection', async () => {
    const instance = await startServer();
    const { host, guest } = await roomPair(instance);
    guest.sendRaw(Buffer.from([0, 1, 2, 3]));
    await guest.expectError('INVALID_MESSAGE', false);
    expect((await guest.closed).code).toBe(1003);
    expect((await host.expect('ROOM_PARTICIPANT_LEFT')).payload.reason).toBe('DISCONNECTED');
  });

  it('bounds a flooding sender', async () => {
    const { port } = await startServer({ rateLimit: { burst: 5, perSecond: 1 } });
    const client = await TestClient.open(port);
    for (let index = 0; index < 100; index += 1) client.send('ROOM_LEAVE');
    const { code } = await client.closed;
    expect(code).toBe(1008);
    expect(client.messages.length).toBeLessThanOrEqual(6);
    const last = client.messages.at(-1);
    expect(expectType(last, 'ERROR').payload.code).toBe('RATE_LIMITED');
  });

  it('closes a connection that keeps sending invalid messages', async () => {
    const { port } = await startServer();
    const client = await TestClient.open(port);
    for (let index = 0; index < 10; index += 1) client.sendRaw('nope');
    expect((await client.closed).code).toBe(1008);
    expect(client.messages).toHaveLength(5);
  });
});

describe('logging', () => {
  it('logs bounded events without secrets, identifiers, or payloads', async () => {
    const instance = await startServer();
    const { host, guest, created, joined } = await roomPair(instance);
    guest.send('ROOM_JOIN', {
      roomId: created.payload.roomId,
      inviteSecret: created.payload.inviteSecret,
    });
    await guest.expectError('INVALID_STATE', true);
    guest.sendRaw(`{"leak":"${created.payload.inviteSecret}"}`);
    await guest.expectError('INVALID_MESSAGE', true);
    host.send('ROOM_LEAVE');
    await guest.expect('ROOM_CLOSED');
    await refusedUpgrade(
      instance.port,
      `${SIGNALING_PATH}?secret=${created.payload.inviteSecret}`,
      ORIGIN,
    );

    const logged = JSON.stringify(instance.logs);
    for (const value of [
      created.payload.inviteSecret,
      created.payload.roomId,
      created.payload.participantId,
      joined.payload.participantId,
      ORIGIN,
      '"leak"',
    ]) {
      expect(logged).not.toContain(value);
    }
    const kinds = instance.logs.map((event) => event.event);
    expect(kinds).toContain('server_started');
    expect(kinds).toContain('room_created');
    expect(kinds).toContain('participant_joined');
    expect(kinds).toContain('message_rejected');
    expect(kinds).toContain('room_closed');
    expect(kinds).toContain('upgrade_rejected');
  });
});
