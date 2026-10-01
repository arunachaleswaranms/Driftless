import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { MAX_SIGNALING_MESSAGE_BYTES } from '@driftless/protocol';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { SignalingController } from './controller.js';
import type { RandomSource } from './credentials.js';
import { silentLogger, type Logger } from './logger.js';
import type { RateLimit } from './rateLimiter.js';
import { RoomStore } from './roomStore.js';
import { timerScheduler, type ScheduledTask, type Scheduler } from './scheduler.js';

/** Versioned WebSocket endpoint. Room credentials never appear in the URL. */
export const SIGNALING_PATH = '/v1/signaling';
export const HEALTH_PATH = '/healthz';

/** Interval of the single expiry sweep shared by all rooms. */
export const DEFAULT_SWEEP_INTERVAL_MS = 1000;

/** Implementation bound on concurrent WebSocket connections. */
export const DEFAULT_MAX_CONNECTIONS = 256;

/** How long shutdown waits for clients to finish the close handshake. */
export const DEFAULT_SHUTDOWN_GRACE_MS = 2000;

/**
 * Provisional default reconnect grace period: how long a participant whose
 * connection was lost keeps its membership. An implementation bound, not a
 * user-experience guarantee.
 */
export const DEFAULT_RECONNECT_GRACE_MS = 30_000;

/**
 * Provisional default interval of WebSocket protocol pings. A connection that
 * has not answered the previous ping when the next one is due is treated as
 * lost, so a dead path is detected within two intervals. Not tuned for
 * mobile networks.
 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

export interface SignalingServerOptions {
  readonly host: string;
  readonly port: number;
  /** Exact origins allowed to open a WebSocket. Never a wildcard. */
  readonly allowedOrigins: readonly string[];
  readonly roomTtlMs: number;
  readonly reconnectGraceMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly maxRooms?: number;
  readonly logger?: Logger;
  readonly clock?: () => number;
  readonly random?: RandomSource;
  readonly scheduler?: Scheduler;
  readonly sweepIntervalMs?: number;
  readonly maxConnections?: number;
  readonly rateLimit?: RateLimit;
  readonly shutdownGraceMs?: number;
}

export interface SignalingServer {
  /** Starts listening. Resolves with the bound address. Rejects if stopped meanwhile. */
  start(): Promise<{ host: string; port: number }>;
  /**
   * Refuses new connections, closes every connection, stops the sweep, and
   * stops listening. Waits for a pending start. Repeated calls share one stop.
   */
  stop(): Promise<void>;
  /** Live connection count, for tests. */
  readonly connectionCount: number;
  /** Active room count, for tests. */
  readonly roomCount: number;
}

type UpgradeRejection = 'path' | 'query' | 'origin' | 'capacity' | 'stopping';

const UPGRADE_STATUS: Readonly<Record<UpgradeRejection, [number, string]>> = {
  path: [404, 'Not Found'],
  query: [400, 'Bad Request'],
  origin: [403, 'Forbidden'],
  capacity: [503, 'Service Unavailable'],
  stopping: [503, 'Service Unavailable'],
};

export function createSignalingServer(options: SignalingServerOptions): SignalingServer {
  const logger = options.logger ?? silentLogger;
  const clock = options.clock ?? Date.now;
  const scheduler = options.scheduler ?? timerScheduler;
  const allowedOrigins = new Set(options.allowedOrigins);
  if (allowedOrigins.has('*') || allowedOrigins.has('null')) {
    throw new Error('Allowed origins must be exact origins.');
  }
  const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;

  const store = new RoomStore({
    roomTtlMs: options.roomTtlMs,
    reconnectGraceMs: options.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS,
    ...(options.maxRooms === undefined ? {} : { maxRooms: options.maxRooms }),
    ...(options.random === undefined ? {} : { random: options.random }),
  });
  const controller = new SignalingController({
    store,
    logger,
    clock,
    ...(options.random === undefined ? {} : { random: options.random }),
    ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
  });

  const httpServer = createServer(handleRequest);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_SIGNALING_MESSAGE_BYTES,
    perMessageDeflate: false,
    clientTracking: false,
  });
  /** Live sockets, each with whether it answered the latest ping. */
  const sockets = new Map<WebSocket, { alive: boolean; connection: number }>();
  let sweep: ScheduledTask | undefined;
  let heartbeat: ScheduledTask | undefined;
  let starting: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  // Read through a function: stop() can begin while start() awaits, which
  // control-flow narrowing does not model.
  const isStopping = (): boolean => stopping !== undefined;

  httpServer.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => {
      // Errors on a socket that has not become a WebSocket need no handling
      // beyond discarding it; the socket is destroyed by its owner.
    });
    const rejection = checkUpgrade(request);
    if (rejection !== undefined) {
      rejectUpgrade(socket, rejection);
      return;
    }
    wss.handleUpgrade(request, socket, head, acceptConnection);
  });

  function checkUpgrade(request: IncomingMessage): UpgradeRejection | undefined {
    if (isStopping()) return 'stopping';
    const url = request.url ?? '';
    const queryStart = url.indexOf('?');
    const path = queryStart === -1 ? url : url.slice(0, queryStart);
    if (path !== SIGNALING_PATH) return 'path';
    // Refusing any query keeps credentials out of URLs, and so out of proxy
    // and access logs.
    if (queryStart !== -1) return 'query';
    // Origin is a browser-enforced policy layer, not authentication: a
    // non-browser client can send any value. A missing Origin is refused.
    const origin = request.headers.origin;
    if (origin === undefined || !allowedOrigins.has(origin)) return 'origin';
    if (sockets.size >= maxConnections) return 'capacity';
    return undefined;
  }

  function rejectUpgrade(socket: Duplex, reason: UpgradeRejection): void {
    const [status, text] = UPGRADE_STATUS[reason];
    logger.log({ event: 'upgrade_rejected', reason, status });
    // Destroy only after the response has been flushed, so the client
    // receives the status instead of a reset.
    socket.once('finish', () => {
      socket.destroy();
    });
    socket.end(
      `HTTP/1.1 ${String(status)} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  }

  function acceptConnection(ws: WebSocket): void {
    const liveness = { alive: true, connection: 0 };
    sockets.set(ws, liveness);
    // Browsers answer protocol pings themselves; no application message is involved.
    ws.on('pong', () => {
      liveness.alive = true;
    });
    // Set when ws itself closes the connection because the client broke the
    // WebSocket protocol; such a close is a policy violation, not a loss.
    let policyViolation = false;
    const connection = controller.connect({
      send(text) {
        if (ws.readyState === WebSocket.OPEN) ws.send(text);
      },
      close(code, reason) {
        ws.close(code, reason);
      },
    });
    liveness.connection = connection.id;
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) connection.receiveBinary();
      else connection.receiveText(rawDataToText(data));
    });
    ws.on('error', (error: Error & { code?: string }) => {
      // ws closes the connection itself after these errors. Only a fixed
      // classification is logged, never the error text.
      const detail =
        error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'
          ? 'oversized'
          : typeof error.code === 'string' && error.code.startsWith('WS_ERR_')
            ? 'invalid_frame'
            : 'socket';
      if (detail !== 'socket') policyViolation = true;
      logger.log({ event: 'transport_error', connection: connection.id, detail });
    });
    ws.on('close', (code: number) => {
      sockets.delete(ws);
      connection.transportClosed(code, policyViolation);
    });
  }

  /**
   * One periodic liveness pass over every socket: a socket that did not
   * answer the previous ping is terminated, which the controller treats as a
   * lost connection, so its membership enters the reconnect grace period.
   */
  function checkLiveness(): void {
    for (const [ws, liveness] of sockets) {
      if (!liveness.alive) {
        logger.log({
          event: 'transport_error',
          connection: liveness.connection,
          detail: 'liveness_timeout',
        });
        ws.terminate();
        continue;
      }
      liveness.alive = false;
      ws.ping();
    }
  }

  function handleRequest(request: IncomingMessage, response: ServerResponse): void {
    const url = request.url ?? '';
    const path = url.split('?', 1)[0];
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (path === HEALTH_PATH) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD' }).end();
        return;
      }
      // Deliberately minimal: no counts, identifiers, versions, or environment.
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(request.method === 'HEAD' ? undefined : '{"status":"ok"}');
      return;
    }
    response.writeHead(404).end();
  }

  return {
    get connectionCount() {
      return controller.connectionCount;
    },
    get roomCount() {
      return store.roomCount;
    },

    async start() {
      if (stopping !== undefined || starting !== undefined) {
        throw new Error('The server can be started only once.');
      }
      starting = new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(options.port, options.host, () => {
          httpServer.off('error', reject);
          resolve();
        });
      });
      await starting;
      // stop() was called while listening began; it now closes the server.
      if (isStopping()) throw new Error('The server was stopped during start.');
      sweep = scheduler.every(options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS, () => {
        try {
          controller.sweep();
        } catch {
          logger.log({ event: 'internal_error', context: 'sweep' });
        }
      });
      heartbeat = scheduler.every(
        options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
        checkLiveness,
      );
      const address = httpServer.address() as AddressInfo;
      logger.log({ event: 'server_started', host: options.host, port: address.port });
      return { host: options.host, port: address.port };
    },

    stop() {
      stopping ??= shutdown();
      return stopping;
    },
  };

  async function shutdown(): Promise<void> {
    // Let a pending listen settle first, so the server cannot start listening
    // after this shutdown has finished.
    await starting?.catch(() => undefined);
    sweep?.cancel();
    sweep = undefined;
    heartbeat?.cancel();
    heartbeat = undefined;
    const closing = [...sockets.keys()].map(
      (ws) =>
        new Promise<void>((resolve) => {
          ws.once('close', () => {
            resolve();
          });
        }),
    );
    controller.shutdown();
    let grace: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(closing),
      new Promise<void>((resolve) => {
        grace = setTimeout(resolve, options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS);
      }),
    ]);
    clearTimeout(grace);
    for (const ws of sockets.keys()) ws.terminate();
    await new Promise<void>((resolve) => {
      wss.close(() => {
        resolve();
      });
    });
    if (httpServer.listening) {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
        httpServer.closeAllConnections();
      });
    }
    logger.log({ event: 'server_stopped' });
  }
}

function rawDataToText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}
