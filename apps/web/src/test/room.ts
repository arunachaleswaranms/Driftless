import {
  PROTOCOL_VERSION,
  parseClientMessage,
  parsePeerMessage,
  serializeMessage,
  type ClientMessage,
  type IceCandidate,
  type ParticipantId,
  type PeerMessage,
  type ResumeChallenge,
  type ResumeProof,
  type ResumeSecret,
  type ServerMessage,
  type SessionId,
} from '@driftless/protocol';
import type { DataChannelLike, PeerConnectionLike } from '../features/room/peerSession.ts';
import type { WebSocketLike } from '../features/room/signalingClient.ts';

/** A server message without the envelope fields, as a test supplies it. */
export type ServerBody = ServerMessage extends infer Message
  ? Message extends ServerMessage
    ? Pick<Message, 'type' | 'payload'>
    : never
  : never;

/**
 * A deterministic WebSocket. The test opens, delivers, and closes it
 * explicitly; everything the client sends is parsed strictly.
 */
export class FakeWebSocket implements WebSocketLike {
  static readonly CONNECTING = 0 as const;
  static readonly OPEN = 1 as const;
  static readonly CLOSED = 3 as const;

  readyState: WebSocketLike['readyState'] = FakeWebSocket.CONNECTING;
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;
  readonly sentText: string[] = [];
  readonly closeCalls: (number | undefined)[] = [];
  #serverSequence = 0;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  /** Every client message sent, validated by the shared parser. */
  get sent(): ClientMessage[] {
    return this.sentText.map((text) => {
      const parsed = parseClientMessage(text);
      if (!parsed.ok) throw new Error(`The client sent an invalid message: ${parsed.reason}`);
      return parsed.message;
    });
  }

  sentOfType<Type extends ClientMessage['type']>(
    type: Type,
  ): Extract<ClientMessage, { type: Type }>[] {
    return this.sent.filter((message) => message.type === type) as Extract<
      ClientMessage,
      { type: Type }
    >[];
  }

  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN)
      throw new Error('send on a socket that is not open');
    this.sentText.push(data);
  }

  close(code?: number): void {
    this.closeCalls.push(code);
    this.readyState = FakeWebSocket.CLOSED;
  }

  // Test controls.

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.call(this as unknown as WebSocket, new Event('open'));
  }

  /** Delivers a server message with the next server sequence. */
  deliver(body: ServerBody): void {
    const message = {
      protocolVersion: PROTOCOL_VERSION,
      sequence: this.#serverSequence++,
      sentAt: 0,
      ...body,
    } as ServerMessage;
    this.deliverRaw(serializeMessage(message));
  }

  deliverRaw(data: unknown): void {
    this.onmessage?.call(this as unknown as WebSocket, new MessageEvent('message', { data }));
  }

  /** The service or network ended the connection. */
  drop(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onerror?.call(this as unknown as WebSocket, new Event('error'));
    this.onclose?.call(this as unknown as WebSocket, new CloseEvent('close', { code: 1006 }));
  }
}

/** A deterministic RTCDataChannel. */
export class FakeDataChannel {
  readyState: RTCDataChannelState = 'connecting';
  binaryType: BinaryType = 'blob';
  onopen: DataChannelLike['onopen'] = null;
  onmessage: DataChannelLike['onmessage'] = null;
  onclose: DataChannelLike['onclose'] = null;
  onerror: DataChannelLike['onerror'] = null;
  readonly sentText: string[] = [];
  closed = false;

  readonly label: string;
  readonly init: RTCDataChannelInit;
  readonly overrides: Partial<
    Pick<
      DataChannelLike,
      'ordered' | 'maxRetransmits' | 'maxPacketLifeTime' | 'protocol' | 'negotiated'
    >
  >;

  constructor(
    label: string,
    init: RTCDataChannelInit = {},
    overrides: Partial<
      Pick<
        DataChannelLike,
        'ordered' | 'maxRetransmits' | 'maxPacketLifeTime' | 'protocol' | 'negotiated'
      >
    > = {},
  ) {
    this.label = label;
    this.init = init;
    this.overrides = overrides;
  }

  get ordered(): boolean {
    return this.overrides.ordered ?? this.init.ordered ?? true;
  }
  get maxRetransmits(): number | null {
    return this.overrides.maxRetransmits ?? this.init.maxRetransmits ?? null;
  }
  get maxPacketLifeTime(): number | null {
    return this.overrides.maxPacketLifeTime ?? this.init.maxPacketLifeTime ?? null;
  }
  get protocol(): string {
    return this.overrides.protocol ?? this.init.protocol ?? '';
  }
  get negotiated(): boolean {
    return this.overrides.negotiated ?? this.init.negotiated ?? false;
  }

  /** Peer messages sent, validated by the shared parser. */
  get sent(): PeerMessage[] {
    return this.sentText.map((text) => {
      const parsed = parsePeerMessage(text);
      if (!parsed.ok) throw new Error(`The session sent an invalid peer message: ${parsed.reason}`);
      return parsed.message;
    });
  }

  send(data: string): void {
    if (this.readyState !== 'open') throw new Error('send on a channel that is not open');
    this.sentText.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 'closed';
  }

  // Test controls.

  open(): void {
    this.readyState = 'open';
    this.onopen?.call(this.asChannel(), new Event('open'));
  }

  receive(data: unknown): void {
    this.onmessage?.call(this.asChannel(), new MessageEvent('message', { data }));
  }

  remoteClose(): void {
    this.readyState = 'closed';
    this.onclose?.call(this.asChannel(), new Event('close'));
  }

  asChannel(): RTCDataChannel {
    return this as unknown as RTCDataChannel;
  }
}

interface Deferred {
  resolve(): void;
  reject(): void;
}

/**
 * A deterministic RTCPeerConnection. Every description operation waits until
 * the test settles it, so races around remote-description timing can be
 * staged exactly.
 */
export class FakePeerConnection {
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  /**
   * What `getStats()` resolves with: a report, `'reject'` to make it fail,
   * or `'pending'` to hold it until `resolveStats()`.
   */
  stats: Map<string, unknown> | 'reject' | 'pending' = new Map();
  getStatsCalls = 0;
  readonly #pendingStats: ((report: Map<string, unknown>) => void)[] = [];
  localDescription: RTCSessionDescription | null = null;
  onicecandidate: PeerConnectionLike['onicecandidate'] = null;
  onconnectionstatechange: PeerConnectionLike['onconnectionstatechange'] = null;
  ondatachannel: PeerConnectionLike['ondatachannel'] = null;
  readonly channels: FakeDataChannel[] = [];
  readonly calls: string[] = [];
  readonly remoteDescriptions: RTCSessionDescriptionInit[] = [];
  readonly addedCandidates: RTCIceCandidateInit[] = [];
  readonly pending: { operation: string; deferred: Deferred }[] = [];
  closed = false;
  /** Makes the next addIceCandidate reject, as a browser does for an unusable candidate. */
  rejectNextCandidate = false;

  readonly configuration: RTCConfiguration;

  constructor(configuration: RTCConfiguration) {
    this.configuration = configuration;
  }

  createDataChannel(label: string, init?: RTCDataChannelInit): RTCDataChannel {
    this.calls.push('createDataChannel');
    const channel = new FakeDataChannel(label, init);
    this.channels.push(channel);
    return channel.asChannel();
  }

  createOffer(): Promise<RTCSessionDescriptionInit> {
    this.calls.push('createOffer');
    return this.#wait('createOffer').then(() => ({ type: 'offer', sdp: 'v=0\r\nfake-offer\r\n' }));
  }

  createAnswer(): Promise<RTCSessionDescriptionInit> {
    this.calls.push('createAnswer');
    return this.#wait('createAnswer').then(() => ({
      type: 'answer',
      sdp: 'v=0\r\nfake-answer\r\n',
    }));
  }

  setLocalDescription(description?: RTCSessionDescriptionInit): Promise<void> {
    this.calls.push('setLocalDescription');
    return this.#wait('setLocalDescription').then(() => {
      this.localDescription = description as RTCSessionDescription;
    });
  }

  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.calls.push('setRemoteDescription');
    return this.#wait('setRemoteDescription').then(() => {
      this.remoteDescriptions.push(description);
    });
  }

  addIceCandidate(candidate?: RTCIceCandidateInit | null): Promise<void> {
    this.calls.push('addIceCandidate');
    if (candidate) this.addedCandidates.push(candidate);
    if (this.rejectNextCandidate) {
      this.rejectNextCandidate = false;
      return Promise.reject(new Error('unusable candidate'));
    }
    return Promise.resolve();
  }

  getStats(): Promise<Map<string, unknown>> {
    this.getStatsCalls += 1;
    const { stats } = this;
    if (stats === 'reject') return Promise.reject(new Error('stats unavailable'));
    if (stats === 'pending') {
      return new Promise((resolve) => {
        this.#pendingStats.push(resolve);
      });
    }
    return Promise.resolve(stats);
  }

  /** Settles every held getStats() call with `report`. */
  async resolveStats(report: Map<string, unknown>): Promise<void> {
    for (const resolve of this.#pendingStats.splice(0)) resolve(report);
    await flush();
  }

  close(): void {
    this.calls.push('close');
    this.closed = true;
    this.connectionState = 'closed';
  }

  /**
   * This fake as the session sees it. The DOM type also lists legacy
   * callback overloads, which the session never uses and the fake omits.
   */
  asPeerConnection(): PeerConnectionLike {
    return this as unknown as PeerConnectionLike;
  }

  // Test controls.

  /** Settles the oldest pending operation with the given name. */
  async settle(operation: string, outcome: 'resolve' | 'reject' = 'resolve'): Promise<void> {
    const index = this.pending.findIndex((entry) => entry.operation === operation);
    const entry = index === -1 ? undefined : this.pending.splice(index, 1)[0];
    if (entry === undefined) throw new Error(`No pending ${operation}`);
    entry.deferred[outcome]();
    await flush();
  }

  hasPending(operation: string): boolean {
    return this.pending.some((entry) => entry.operation === operation);
  }

  emitCandidate(candidate: Partial<RTCIceCandidate> | null): void {
    const event = { candidate } as RTCPeerConnectionIceEvent;
    this.onicecandidate?.call(this as unknown as RTCPeerConnection, event);
  }

  setConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.onconnectionstatechange?.call(this as unknown as RTCPeerConnection, new Event('change'));
  }

  announceChannel(channel: FakeDataChannel): void {
    this.channels.push(channel);
    const event = { channel: channel.asChannel() } as RTCDataChannelEvent;
    this.ondatachannel?.call(this as unknown as RTCPeerConnection, event);
  }

  #wait(operation: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pending.push({
        operation,
        deferred: {
          resolve,
          reject: () => {
            reject(new Error(`${operation} failed`));
          },
        },
      });
    });
  }
}

/** Lets every queued promise continuation run. */
export async function flush(): Promise<void> {
  for (let round = 0; round < 10; round += 1) await Promise.resolve();
}

/** A browser-shaped local candidate. */
export function nativeCandidate(index: number): Partial<RTCIceCandidate> {
  return {
    candidate: `candidate:${String(index)} 1 udp 2122260223 host-${String(index)}.local 5000${String(index)} typ host`,
    sdpMid: '0',
    sdpMLineIndex: 0,
    usernameFragment: 'abcd',
  };
}

export function remoteCandidate(index: number): IceCandidate {
  return {
    candidate: `candidate:${String(index)} 1 udp 2122260223 remote-${String(index)}.local 6000${String(index)} typ host`,
    sdpMid: '0',
    sdpMLineIndex: 0,
    usernameFragment: 'wxyz',
  };
}

/** A peer message as the other browser would send it. */
export function peerMessage(
  type: 'PEER_HELLO' | 'PEER_READY',
  payload: import('@driftless/protocol').PeerHandshakePayload,
  sequence: number,
): string {
  return serializeMessage({
    protocolVersion: PROTOCOL_VERSION,
    type,
    sequence,
    sentAt: 0,
    payload,
  });
}

/**
 * Deterministic one-shot timers. Nothing runs until the test advances time,
 * and every pending timer is visible, so duplicate or leaked schedules show.
 */
export class FakeTimers {
  now = 0;
  readonly #pending: { at: number; order: number; task: () => void }[] = [];
  #order = 0;

  schedule(delayMs: number, task: () => void): () => void {
    const entry = { at: this.now + delayMs, order: this.#order++, task };
    this.#pending.push(entry);
    return () => {
      const index = this.#pending.indexOf(entry);
      if (index !== -1) this.#pending.splice(index, 1);
    };
  }

  /** Timers that have not run or been cancelled. */
  get pendingCount(): number {
    return this.#pending.length;
  }

  /** Delays of the pending timers, relative to now. */
  get pendingDelays(): number[] {
    return this.#pending.map((entry) => entry.at - this.now);
  }

  /** Moves time forward, running every timer due on the way, in order. */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const due = this.#pending
        .filter((entry) => entry.at <= target)
        .sort((a, b) => a.at - b.at || a.order - b.order)[0];
      if (due === undefined) break;
      this.#pending.splice(this.#pending.indexOf(due), 1);
      this.now = due.at;
      due.task();
      await flush();
    }
    this.now = target;
    await flush();
  }
}

/** A stand-in proof for controller tests; real proofs are tested in resumeProof.test.ts. */
export const FAKE_PROOF = 'A'.repeat(43) as ResumeProof;

/** A resume prover that records its calls and answers with a fixed proof. */
export function fakeProver(calls: ResumeChallenge[] = []) {
  return {
    calls,
    prove: (
      _secret: ResumeSecret,
      _sessionId: SessionId,
      _participantId: ParticipantId,
      challenge: ResumeChallenge,
    ): Promise<ResumeProof | undefined> => {
      calls.push(challenge);
      return Promise.resolve(FAKE_PROOF);
    },
  };
}

/**
 * A synthetic getStats() report whose selected pair has the given candidate
 * types. Its addresses are recognisable documentation addresses, so tests can
 * show that none of them is displayed or exported.
 */
export function statsReport(
  localType: string,
  remoteType: string,
  options: { pairId?: string; relayProtocol?: string } = {},
): Map<string, unknown> {
  const pairId = options.pairId ?? 'CP1';
  const entries: Record<string, unknown>[] = [
    { id: 'T1', type: 'transport', selectedCandidatePairId: pairId },
    {
      id: pairId,
      type: 'candidate-pair',
      state: 'succeeded',
      localCandidateId: `L-${pairId}`,
      remoteCandidateId: `R-${pairId}`,
    },
    {
      id: `L-${pairId}`,
      type: 'local-candidate',
      candidateType: localType,
      protocol: 'udp',
      address: '192.0.2.44',
      port: 50000,
      ...(options.relayProtocol === undefined ? {} : { relayProtocol: options.relayProtocol }),
    },
    {
      id: `R-${pairId}`,
      type: 'remote-candidate',
      candidateType: remoteType,
      protocol: 'udp',
      address: '198.51.100.77',
      port: 50001,
    },
  ];
  return new Map(entries.map((entry) => [String(entry.id), entry]));
}

/** Every address `statsReport` contains. */
export const STATS_ADDRESSES = ['192.0.2.44', '198.51.100.77', '50000', '50001'];
