import {
  MAX_SIGNALING_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  fitsUtf8Bytes,
  parseServerMessage,
  serializeMessage,
  type ClientMessage,
  type ServerMessage,
} from '@driftless/protocol';

/** The part of the browser `WebSocket` this client uses. */
export type WebSocketLike = Pick<
  WebSocket,
  'readyState' | 'onopen' | 'onmessage' | 'onclose' | 'onerror' | 'send' | 'close'
>;

export type CreateWebSocket = (url: string) => WebSocketLike;

/** A client message without the envelope fields this client fills in. */
export type ClientBody = ClientMessage extends infer Message
  ? Message extends ClientMessage
    ? Pick<Message, 'type' | 'payload'>
    : never
  : never;

/**
 * Why the connection ended. `protocol_error` means the service sent something
 * that is not a valid, correctly sequenced server message; the client closed
 * the connection rather than act on it.
 */
export type SignalingCloseReason = 'closed' | 'protocol_error';

export interface SignalingClientOptions {
  readonly url: string;
  readonly createWebSocket: CreateWebSocket;
  /** Wall clock for the diagnostic `sentAt` field. */
  readonly clock: () => number;
  /** A validated server message arrived. */
  readonly onMessage: (message: ServerMessage) => void;
  /** The open connection ended. Called at most once, and never after `close()`. */
  readonly onClose: (reason: SignalingCloseReason) => void;
}

const OPEN = 1;
/** Close code for a client that received an invalid message. */
const PROTOCOL_ERROR_CODE = 1002;
const NORMAL_CLOSURE_CODE = 1000;

/**
 * Close code for a connection abandoned without ending anything: a resume
 * attempt that timed out or was refused. The service treats it as a lost
 * connection, so if it had just accepted the attempt's proof, the
 * membership is held again rather than ended.
 */
export const ABANDONED_CLOSURE_CODE = 4000;

/**
 * One signaling WebSocket. It numbers outgoing messages with strictly
 * increasing sequences for the life of the connection, across room changes,
 * and validates every incoming message with the shared protocol parser
 * before anything sees it. An invalid or out-of-order server message closes
 * the connection: nothing is cast, guessed, or partially applied.
 *
 * There is no reconnect. When the connection ends, the client is finished;
 * a later room needs a new client.
 */
export class SignalingClient {
  readonly #options: SignalingClientOptions;
  #socket: WebSocketLike | undefined;
  #opening: Promise<void> | undefined;
  /** Settles a pending `open()`; undefined once it has settled. */
  #settleOpen: ((error?: Error) => void) | undefined;
  #nextSequence = 0;
  #lastServerSequence = -1;
  #finished = false;

  constructor(options: SignalingClientOptions) {
    this.#options = options;
  }

  /** Whether the connection is open and usable. */
  get isOpen(): boolean {
    return !this.#finished && this.#settleOpen === undefined && this.#socket?.readyState === OPEN;
  }

  /**
   * Opens the connection. Resolves once it is open; rejects if it cannot be
   * opened or `close()` is called first. Calling it again returns the same
   * attempt.
   */
  open(): Promise<void> {
    this.#opening ??= new Promise<void>((resolve, reject) => {
      if (this.#finished) {
        reject(new Error('The signaling client is closed.'));
        return;
      }
      let socket: WebSocketLike;
      try {
        socket = this.#options.createWebSocket(this.#options.url);
      } catch {
        this.#finished = true;
        reject(new Error('The signaling connection could not be created.'));
        return;
      }
      this.#socket = socket;
      this.#settleOpen = (error) => {
        this.#settleOpen = undefined;
        if (error === undefined) resolve();
        else reject(error);
      };
      socket.onopen = () => {
        this.#settleOpen?.();
      };
      socket.onmessage = (event: MessageEvent) => {
        this.#receive(event.data);
      };
      // Browsers fire error and then close; close carries the outcome.
      socket.onerror = () => undefined;
      socket.onclose = () => {
        const pending = this.#settleOpen;
        this.#release();
        if (pending === undefined) this.#options.onClose('closed');
        else pending(new Error('The signaling connection could not be opened.'));
      };
    });
    return this.#opening;
  }

  /**
   * Sends one message, numbering it with the next sequence. Returns false,
   * sending nothing, if the connection is not open or the encoded message
   * would exceed the shared signaling bound.
   */
  send(body: ClientBody): boolean {
    const socket = this.#socket;
    if (!this.isOpen || socket === undefined) return false;
    const message = {
      protocolVersion: PROTOCOL_VERSION,
      sequence: this.#nextSequence,
      sentAt: this.#options.clock(),
      ...body,
    } as ClientMessage;
    const text = serializeMessage(message);
    if (!fitsUtf8Bytes(text, MAX_SIGNALING_MESSAGE_BYTES)) return false;
    this.#nextSequence += 1;
    socket.send(text);
    return true;
  }

  /**
   * Closes the connection, normally by default, which ends any membership it
   * carries. No `onClose` callback runs for it. Idempotent.
   */
  close(code: number = NORMAL_CLOSURE_CODE): void {
    if (this.#finished) return;
    const socket = this.#socket;
    const pending = this.#settleOpen;
    this.#release();
    socket?.close(code);
    pending?.(new Error('The signaling client was closed.'));
  }

  #receive(data: unknown): void {
    if (this.#finished) return;
    // Binary data is never valid, and the shared parser bounds the size.
    const parsed = typeof data === 'string' ? parseServerMessage(data) : undefined;
    if (parsed?.ok !== true || parsed.message.sequence <= this.#lastServerSequence) {
      const socket = this.#socket;
      this.#release();
      socket?.close(PROTOCOL_ERROR_CODE);
      this.#options.onClose('protocol_error');
      return;
    }
    this.#lastServerSequence = parsed.message.sequence;
    this.#options.onMessage(parsed.message);
  }

  /** Detaches every handler, so no late socket event can reach the client. */
  #release(): void {
    this.#finished = true;
    this.#settleOpen = undefined;
    const socket = this.#socket;
    if (socket !== undefined) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
    }
    this.#socket = undefined;
  }
}
