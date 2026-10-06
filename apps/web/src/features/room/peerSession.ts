import {
  type ApplicationBody,
  type ApplicationMessage,
  MAX_ICE_CANDIDATES_PER_NEGOTIATION,
  PEER_CONTROL_CHANNEL_LABEL,
  PROTOCOL_VERSION,
  isSessionDescription,
  parsePeerMessage,
  serializeMessage,
  toIceCandidate,
  type IceCandidate,
  type NegotiationId,
  type NegotiationMessage,
  type ParticipantId,
  type ParticipantRole,
  type PeerMessage,
  type SessionId,
} from '@driftless/protocol';
import type { StatsReportLike } from './connectionStats.ts';
import { offersTurn } from './rtcConfig.ts';

/** The part of `RTCPeerConnection` a peer session uses. */
export type PeerConnectionLike = Pick<
  RTCPeerConnection,
  | 'connectionState'
  | 'iceConnectionState'
  | 'getStats'
  | 'localDescription'
  | 'onicecandidate'
  | 'onconnectionstatechange'
  | 'ondatachannel'
  | 'createDataChannel'
  | 'createOffer'
  | 'createAnswer'
  | 'setLocalDescription'
  | 'setRemoteDescription'
  | 'addIceCandidate'
  | 'close'
>;

/** The part of `RTCDataChannel` a peer session uses. */
export type DataChannelLike = Pick<
  RTCDataChannel,
  | 'label'
  | 'ordered'
  | 'maxRetransmits'
  | 'maxPacketLifeTime'
  | 'protocol'
  | 'negotiated'
  | 'readyState'
  | 'binaryType'
  | 'onopen'
  | 'onmessage'
  | 'onclose'
  | 'onerror'
  | 'send'
  | 'close'
>;

export type CreatePeerConnection = (configuration: RTCConfiguration) => PeerConnectionLike;

/** A negotiation message without the envelope fields signaling fills in. */
export type NegotiationBody = NegotiationMessage extends infer Message
  ? Message extends NegotiationMessage
    ? Pick<Message, 'type' | 'payload'>
    : never
  : never;

/**
 * - `negotiating`: session descriptions are being exchanged.
 * - `connecting`: both descriptions are in place; ICE, DTLS, the data
 *   channel, and the peer handshake are completing.
 * - `connected`: the control channel is open and the handshake has crossed it
 *   in both directions.
 * - `failed`: the session ended without being asked to; it is torn down.
 * - `closed`: the owner closed it.
 */
export type PeerSessionState = 'negotiating' | 'connecting' | 'connected' | 'failed' | 'closed';

/** Why a session failed. Fixed tokens; no browser error text is kept. */
export type PeerFailure =
  /** Creating or applying a session description failed, or it was out of bounds. */
  | 'negotiation_failed'
  /** ICE or DTLS failed before the channel became usable. */
  | 'connection_failed'
  /** An established connection disconnected, failed, or closed. */
  | 'connection_lost'
  /** The control channel closed or reported an error. */
  | 'channel_closed'
  /** The peer opened a channel other than the one expected control channel. */
  | 'unexpected_channel'
  /** The peer sent an invalid, unexpected, or mismatched peer message. */
  | 'peer_protocol'
  /** Valid application traffic exceeded this session's receiver-local rate bound. */
  | 'application_rate_limit'
  /** The peer sent more candidates than the bounds allow. */
  | 'candidate_limit'
  /** A negotiation message could not be handed to signaling. */
  | 'signaling_unavailable'
  /** The ICE policy allows only TURN relay, and no TURN server was available. */
  | 'relay_unavailable';

/** Browser-reported states of a live session, for diagnostics. */
export interface PeerObservation {
  readonly connectionState: RTCPeerConnectionState;
  readonly iceConnectionState: RTCIceConnectionState;
  readonly channelState: RTCDataChannelState | null;
}

/**
 * Remote candidates held until the matching remote description is in place:
 * at most this many, and at most this many bytes of candidate text.
 */
export const MAX_QUEUED_REMOTE_CANDIDATES = MAX_ICE_CANDIDATES_PER_NEGOTIATION;
export const MAX_QUEUED_REMOTE_CANDIDATE_BYTES = 16_384;

/** Provisional inbound abuse protection, not a product throughput guarantee. */
export const PEER_APPLICATION_RATE_BURST = 32;
export const PEER_APPLICATION_RATE_PER_SECOND = 8;

export interface PeerSessionOptions {
  readonly onApplicationMessage?: (body: ApplicationBody) => void;
  readonly role: ParticipantRole;
  /** The room session both participants belong to; bound into the handshake. */
  readonly sessionId: SessionId;
  readonly negotiationId: NegotiationId;
  /**
   * Host only: the failed negotiation this session replaces. When set, the
   * offer is sent as an `RTC_RECOVER` naming it, rather than an `RTC_OFFER`.
   */
  readonly previousNegotiationId?: NegotiationId;
  readonly localParticipantId: ParticipantId;
  readonly remoteParticipantId: ParticipantId;
  /**
   * The peer connection configuration, or a function returning it. A
   * function is called once, when the connection is created, so a runtime
   * ICE configuration that arrived after the session was set up applies.
   */
  readonly configuration: RTCConfiguration | (() => RTCConfiguration);
  readonly createPeerConnection: CreatePeerConnection;
  /** Hands one negotiation message to signaling; false if it could not be sent. */
  readonly signal: (body: NegotiationBody) => boolean;
  /** Local millisecond clock for diagnostic `sentAt` and inbound application admission. */
  readonly clock: () => number;
  /** Called on every state change except `closed`, which only the owner causes. */
  readonly onStateChange: (state: PeerSessionState, failure?: PeerFailure) => void;
}

/**
 * One WebRTC negotiation and its single ordered, reliable control channel.
 *
 * Roles are fixed: the host creates the channel and the offer; the guest
 * accepts the offer, answers, and receives the channel. ICE is trickled both
 * ways. The session is `connected` only when the expected channel is open and
 * each peer has received the other's handshake, which shows that data crossed
 * the channel in both directions; a connected `RTCPeerConnection` alone is not
 * enough.
 *
 * Every asynchronous continuation and event handler checks that the session
 * is still live, and teardown detaches every handler, so a late callback from
 * a closed session can never act. A session is never repaired: there is no
 * ICE restart or renegotiation within it, and a failure tears it down and
 * reports once. Recovery is the owner's decision and always uses a fresh
 * session, with a fresh connection, negotiation ID, channel, and handshake.
 *
 * Once connected, a session needs no signaling: a late candidate that
 * signaling cannot carry is dropped, and the session stays connected.
 */
export class PeerSession {
  readonly #options: PeerSessionOptions;
  #state: PeerSessionState = 'negotiating';
  #connection: PeerConnectionLike | undefined;
  #channel: DataChannelLike | undefined;

  #localDescriptionSent = false;
  readonly #pendingLocal: IceCandidate[] = [];
  #localCandidates = 0;
  #localGatheringComplete = false;

  /** Remote candidates are applied only once the remote description is. */
  #remoteDescription: 'none' | 'applying' | 'applied' = 'none';
  readonly #pendingRemote: IceCandidate[] = [];
  #pendingRemoteBytes = 0;
  #remoteCandidates = 0;
  #remoteGatheringComplete = false;

  #nextPeerSequence = 0;
  #lastPeerSequence = -1;
  #helloSent = false;
  #helloReceived = false;
  #readyReceived = false;
  #applicationCallback: ((body: ApplicationBody) => void) | undefined;
  #applicationTokens = PEER_APPLICATION_RATE_BURST;
  #applicationLastRefill: number;

  constructor(options: PeerSessionOptions) {
    this.#options = options;
    this.#applicationCallback = options.onApplicationMessage;
    this.#applicationLastRefill = options.clock();
  }

  /** Only this boundary writes application JSON to the channel. */
  sendApplicationMessage(body: ApplicationBody): boolean {
    if (this.#options.role !== 'host' && ['PLAY', 'PAUSE', 'SEEK'].includes(body.type))
      return false;
    if (this.#state !== 'connected' || this.#channel?.readyState !== 'open') return false;
    const message = {
      protocolVersion: PROTOCOL_VERSION,
      type: body.type,
      sequence: this.#nextPeerSequence,
      sentAt: this.#options.clock(),
      payload: {
        ...body.payload,
        sessionId: this.#options.sessionId,
        negotiationId: this.#options.negotiationId,
        senderId: this.#options.localParticipantId,
        recipientId: this.#options.remoteParticipantId,
      },
    } as ApplicationMessage;
    const text = serializeMessage(message);
    if (!parsePeerMessage(text).ok) return false;
    this.#nextPeerSequence += 1;
    try {
      this.#channel.send(text);
      return true;
    } catch {
      this.#fail('channel_closed');
      return false;
    }
  }

  get state(): PeerSessionState {
    return this.#state;
  }

  get negotiationId(): NegotiationId {
    return this.#options.negotiationId;
  }

  /** Whether this session's offer or answer was handed to signaling. */
  get descriptionSent(): boolean {
    return this.#localDescriptionSent;
  }

  /**
   * The browser's own connection, ICE, and control-channel states, for
   * diagnostics only; undefined before the connection exists and after the
   * session ends. Reading them changes nothing.
   */
  observe(): PeerObservation | undefined {
    const connection = this.#connection;
    if (connection === undefined || !this.#live) return undefined;
    return {
      connectionState: connection.connectionState,
      iceConnectionState: connection.iceConnectionState,
      channelState: this.#channel?.readyState ?? null,
    };
  }

  /**
   * The connection's statistics, for diagnostics only. Resolves undefined,
   * and never rejects, when there is no live connection or the browser cannot
   * report them. It never affects the session: a failure here is not a
   * failure of the connection.
   */
  async getStats(): Promise<StatsReportLike | undefined> {
    const connection = this.#connection;
    if (connection === undefined || !this.#live) return undefined;
    try {
      const report = await connection.getStats();
      return this.#owns(connection) ? report : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Host: creates the connection and the control channel, and sends the
   * offer, or the recovery offer if this session replaces a failed one.
   */
  async start(): Promise<void> {
    if (this.#options.role !== 'host' || this.#connection !== undefined || !this.#live) return;
    const connection = this.#createConnection();
    if (connection === undefined) return;
    try {
      const channel = connection.createDataChannel(PEER_CONTROL_CHANNEL_LABEL, { ordered: true });
      this.#bindChannel(channel);
      const offer = await connection.createOffer();
      if (!this.#owns(connection)) return;
      await connection.setLocalDescription(offer);
      if (!this.#owns(connection)) return;
      this.#sendLocalDescription('offer', connection);
    } catch {
      if (this.#owns(connection)) this.#fail('negotiation_failed');
    }
  }

  /** Guest: applies the host's offer, then sends the answer. */
  async acceptOffer(sdp: string): Promise<void> {
    if (this.#options.role !== 'guest' || this.#connection !== undefined || !this.#live) return;
    const connection = this.#createConnection();
    if (connection === undefined) return;
    this.#remoteDescription = 'applying';
    try {
      await connection.setRemoteDescription({ type: 'offer', sdp });
      if (!this.#owns(connection)) return;
      this.#remoteDescriptionApplied(connection);
      const answer = await connection.createAnswer();
      if (!this.#owns(connection)) return;
      await connection.setLocalDescription(answer);
      if (!this.#owns(connection)) return;
      if (this.#sendLocalDescription('answer', connection)) this.#setState('connecting');
    } catch {
      if (this.#owns(connection)) this.#fail('negotiation_failed');
    }
  }

  /** Host: applies the guest's answer. */
  async acceptAnswer(sdp: string): Promise<void> {
    const connection = this.#connection;
    if (
      this.#options.role !== 'host' ||
      connection === undefined ||
      !this.#localDescriptionSent ||
      this.#remoteDescription !== 'none' ||
      !this.#live
    ) {
      return;
    }
    // Only the first answer is applied.
    this.#remoteDescription = 'applying';
    try {
      await connection.setRemoteDescription({ type: 'answer', sdp });
      if (!this.#owns(connection)) return;
      this.#remoteDescriptionApplied(connection);
      this.#setState('connecting');
    } catch {
      if (this.#owns(connection)) this.#fail('negotiation_failed');
    }
  }

  /**
   * Applies one remote candidate, or holds it, in order, until the remote
   * description is in place. The hold is bounded by count and size; a peer
   * that exceeds it, or sends after its end of candidates, fails the session.
   */
  addRemoteCandidate(candidate: IceCandidate): void {
    if (!this.#live) return;
    this.#remoteCandidates += 1;
    if (
      this.#remoteGatheringComplete ||
      this.#remoteCandidates > MAX_ICE_CANDIDATES_PER_NEGOTIATION
    ) {
      this.#fail('candidate_limit');
      return;
    }
    const connection = this.#connection;
    if (connection !== undefined && this.#remoteDescription === 'applied') {
      this.#applyRemoteCandidate(connection, candidate);
      return;
    }
    const bytes = candidateBytes(candidate);
    if (
      this.#pendingRemote.length >= MAX_QUEUED_REMOTE_CANDIDATES ||
      this.#pendingRemoteBytes + bytes > MAX_QUEUED_REMOTE_CANDIDATE_BYTES
    ) {
      this.#fail('candidate_limit');
      return;
    }
    this.#pendingRemote.push(candidate);
    this.#pendingRemoteBytes += bytes;
  }

  /**
   * The peer has sent all its candidates. It is recorded so that a later
   * candidate is refused; the browser needs no end-of-candidates signal to
   * complete ICE, so none is passed to it.
   */
  remoteCandidatesComplete(): void {
    if (this.#live) this.#remoteGatheringComplete = true;
  }

  /** Tears the session down at the owner's request. No callback follows. Idempotent. */
  close(): void {
    if (!this.#live) return;
    this.#state = 'closed';
    this.#teardown();
  }

  get #live(): boolean {
    return this.#state !== 'failed' && this.#state !== 'closed';
  }

  /** Releases the candidate hold, in arrival order, once the description is applied. */
  #remoteDescriptionApplied(connection: PeerConnectionLike): void {
    this.#remoteDescription = 'applied';
    const pending = this.#pendingRemote.splice(0);
    this.#pendingRemoteBytes = 0;
    for (const candidate of pending) this.#applyRemoteCandidate(connection, candidate);
  }

  #applyRemoteCandidate(connection: PeerConnectionLike, candidate: IceCandidate): void {
    // The browser queues candidates internally in call order. One it cannot
    // use is skipped; ICE then succeeds or fails on the others.
    connection.addIceCandidate(candidate).catch(() => undefined);
  }

  #createConnection(): PeerConnectionLike | undefined {
    let connection: PeerConnectionLike;
    try {
      const { configuration } = this.#options;
      const resolved = typeof configuration === 'function' ? configuration() : configuration;
      // A relay-only policy with no TURN server cannot gather a single
      // candidate; fail at once instead of waiting for ICE to time out.
      if (resolved.iceTransportPolicy === 'relay' && !offersTurn(resolved)) {
        this.#fail('relay_unavailable');
        return undefined;
      }
      connection = this.#options.createPeerConnection(resolved);
    } catch {
      this.#fail('negotiation_failed');
      return undefined;
    }
    this.#connection = connection;
    connection.onicecandidate = (event) => {
      if (this.#owns(connection)) this.#localCandidate(event.candidate);
    };
    connection.onconnectionstatechange = () => {
      if (this.#owns(connection)) this.#connectionStateChanged(connection.connectionState);
    };
    connection.ondatachannel = (event) => {
      if (this.#owns(connection)) this.#remoteChannel(event.channel);
      else event.channel.close();
    };
    return connection;
  }

  #owns(connection: PeerConnectionLike): boolean {
    return this.#live && this.#connection === connection;
  }

  /** Sends the local description; then any candidates gathered meanwhile. */
  #sendLocalDescription(kind: 'offer' | 'answer', connection: PeerConnectionLike): boolean {
    const sdp = connection.localDescription?.sdp;
    if (!isSessionDescription(sdp)) {
      this.#fail('negotiation_failed');
      return false;
    }
    const { negotiationId, previousNegotiationId } = this.#options;
    const body: NegotiationBody =
      kind === 'answer'
        ? { type: 'RTC_ANSWER', payload: { negotiationId, sdp } }
        : previousNegotiationId === undefined
          ? { type: 'RTC_OFFER', payload: { negotiationId, sdp } }
          : { type: 'RTC_RECOVER', payload: { previousNegotiationId, negotiationId, sdp } };
    if (!this.#signal(body)) return false;
    this.#localDescriptionSent = true;
    for (const candidate of this.#pendingLocal.splice(0)) {
      if (!this.#sendCandidate(candidate)) return false;
    }
    if (this.#localGatheringComplete) return this.#sendGatheringComplete();
    return true;
  }

  #localCandidate(native: RTCIceCandidate | null): void {
    if (native === null) {
      if (this.#localGatheringComplete) return;
      this.#localGatheringComplete = true;
      if (this.#localDescriptionSent) this.#sendGatheringComplete();
      return;
    }
    // An empty candidate marks the end of one generation, not a candidate.
    if (native.candidate === '' || this.#localGatheringComplete) return;
    // Only the four browser-defined fields cross signaling, as a validated
    // plain object. A candidate outside the shared bounds is not sent.
    const candidate = toIceCandidate({
      candidate: native.candidate,
      sdpMid: native.sdpMid,
      sdpMLineIndex: native.sdpMLineIndex,
      usernameFragment: native.usernameFragment,
    });
    if (candidate === undefined || this.#localCandidates >= MAX_ICE_CANDIDATES_PER_NEGOTIATION) {
      return;
    }
    this.#localCandidates += 1;
    if (this.#localDescriptionSent) this.#sendCandidate(candidate);
    else this.#pendingLocal.push(candidate);
  }

  #sendCandidate(candidate: IceCandidate): boolean {
    return this.#signal({
      type: 'ICE_CANDIDATE',
      payload: { negotiationId: this.#options.negotiationId, candidate },
    });
  }

  #sendGatheringComplete(): boolean {
    return this.#signal({
      type: 'ICE_COMPLETE',
      payload: { negotiationId: this.#options.negotiationId },
    });
  }

  #signal(body: NegotiationBody): boolean {
    if (this.#options.signal(body)) return true;
    // A connected session does not depend on signaling.
    if (this.#state !== 'connected') this.#fail('signaling_unavailable');
    return false;
  }

  #connectionStateChanged(state: RTCPeerConnectionState): void {
    if (state === 'disconnected' || state === 'failed' || state === 'closed') {
      // No ICE restart: any loss ends this session; recovery uses a new one.
      this.#fail(this.#state === 'connected' ? 'connection_lost' : 'connection_failed');
    }
  }

  /** Guest: accepts exactly one channel, the expected control channel. */
  #remoteChannel(channel: DataChannelLike): void {
    const expected =
      this.#options.role === 'guest' &&
      this.#channel === undefined &&
      channel.label === PEER_CONTROL_CHANNEL_LABEL &&
      channel.ordered &&
      channel.maxRetransmits === null &&
      channel.maxPacketLifeTime === null &&
      channel.protocol === '' &&
      !channel.negotiated;
    if (!expected) {
      // Never trusted: closed at once, and the session fails.
      channel.close();
      this.#fail('unexpected_channel');
      return;
    }
    this.#bindChannel(channel);
  }

  /**
   * The host greets first, when its channel opens; the guest greets only in
   * reply. A message the guest sent as soon as its announced channel was
   * open could reach the host before the host's channel had opened, and
   * same-host Chromium testing observed such a first message never being
   * delivered, leaving both handshakes waiting. Replying ensures the host's
   * channel is open before the guest sends anything.
   */
  #bindChannel(channel: DataChannelLike): void {
    this.#channel = channel;
    channel.binaryType = 'arraybuffer';
    const greetsFirst = this.#options.role === 'host';
    channel.onopen = () => {
      if (this.#channel === channel && this.#live && greetsFirst) this.#sendHello();
    };
    channel.onmessage = (event: MessageEvent) => {
      if (this.#channel === channel && this.#live) this.#peerMessage(event.data);
    };
    channel.onclose = () => {
      if (this.#channel === channel && this.#live) this.#fail('channel_closed');
    };
    channel.onerror = () => {
      if (this.#channel === channel && this.#live) this.#fail('channel_closed');
    };
    if (greetsFirst && channel.readyState === 'open') this.#sendHello();
  }

  #sendHello(): void {
    if (this.#helloSent) return;
    this.#helloSent = true;
    this.#sendPeer('PEER_HELLO');
  }

  #sendPeer(type: 'PEER_HELLO' | 'PEER_READY'): void {
    const message: PeerMessage = {
      protocolVersion: PROTOCOL_VERSION,
      type,
      sequence: this.#nextPeerSequence++,
      sentAt: this.#options.clock(),
      payload: {
        sessionId: this.#options.sessionId,
        negotiationId: this.#options.negotiationId,
        senderId: this.#options.localParticipantId,
        recipientId: this.#options.remoteParticipantId,
      },
    };
    try {
      this.#channel?.send(serializeMessage(message));
    } catch {
      this.#fail('channel_closed');
    }
  }

  /**
   * The handshake: the host sends PEER_HELLO when its channel opens; the
   * guest answers it with its own PEER_HELLO and a PEER_READY, and the host
   * answers the guest's PEER_HELLO with PEER_READY. A message must name this
   * room session and negotiation, come from the expected peer, address this
   * participant, and arrive in sequence; anything else, including a repeat,
   * a message from another session or negotiation, or binary data, fails the
   * session.
   */
  #peerMessage(data: unknown): void {
    const parsed = typeof data === 'string' ? parsePeerMessage(data) : undefined;
    if (parsed?.ok !== true) {
      this.#fail('peer_protocol');
      return;
    }
    const { message } = parsed;
    const { sessionId, negotiationId, senderId, recipientId } = message.payload;
    if (
      message.sequence <= this.#lastPeerSequence ||
      sessionId !== this.#options.sessionId ||
      negotiationId !== this.#options.negotiationId ||
      senderId !== this.#options.remoteParticipantId ||
      recipientId !== this.#options.localParticipantId
    ) {
      this.#fail('peer_protocol');
      return;
    }
    this.#lastPeerSequence = message.sequence;

    if (message.type !== 'PEER_HELLO' && message.type !== 'PEER_READY') {
      if (this.#state !== 'connected') {
        this.#fail('peer_protocol');
        return;
      }
      if (this.#options.role === 'host' && ['PLAY', 'PAUSE', 'SEEK'].includes(message.type)) {
        this.#fail('peer_protocol');
        return;
      }
      if (!this.#admitApplicationMessage()) {
        this.#fail('application_rate_limit');
        return;
      }
      // The context is checked above; upward consumers receive only domain fields.
      // Explicit projection keeps the application API context-free.
      switch (message.type) {
        case 'PLAY':
        case 'PAUSE':
        case 'SEEK':
          this.#applicationCallback?.({
            type: message.type,
            payload: {
              localSelectionId: message.payload.localSelectionId,
              remoteSelectionId: message.payload.remoteSelectionId,
              revision: message.payload.revision,
              positionMs: message.payload.positionMs,
            },
          });
          break;
        case 'MEDIA_INFO':
          this.#applicationCallback?.({
            type: message.type,
            payload: {
              selectionId: message.payload.selectionId,
              fingerprintVersion: message.payload.fingerprintVersion,
              fingerprint: message.payload.fingerprint,
              byteLength: message.payload.byteLength,
            },
          });
          break;
        case 'MEDIA_MATCH':
        case 'READY':
          this.#applicationCallback?.({
            type: message.type,
            payload: {
              localSelectionId: message.payload.localSelectionId,
              remoteSelectionId: message.payload.remoteSelectionId,
              fingerprint: message.payload.fingerprint,
            },
          });
          break;
        case 'MEDIA_MISMATCH':
          this.#applicationCallback?.({
            type: message.type,
            payload: {
              localSelectionId: message.payload.localSelectionId,
              remoteSelectionId: message.payload.remoteSelectionId,
              reason: message.payload.reason,
            },
          });
          break;
        case 'NOT_READY':
          this.#applicationCallback?.({
            type: message.type,
            payload: {
              localSelectionId: message.payload.localSelectionId,
              reason: message.payload.reason,
            },
          });
          break;
      }
      return;
    }
    if (message.type === 'PEER_HELLO') {
      if (this.#helloReceived) {
        this.#fail('peer_protocol');
        return;
      }
      this.#helloReceived = true;
      this.#sendHello();
      this.#sendPeer('PEER_READY');
    } else {
      if (!this.#helloSent || this.#readyReceived) {
        this.#fail('peer_protocol');
        return;
      }
      this.#readyReceived = true;
    }
    if (this.#live && this.#helloReceived && this.#readyReceived) this.#setState('connected');
  }

  /** Constant-space lazy refill, using only receiver time; handshake traffic is excluded. */
  #admitApplicationMessage(): boolean {
    // Keep a high-water timestamp: a backwards clock grants no refill, including
    // when it catches up. Identical timestamps likewise grant nothing.
    const now = Math.max(this.#applicationLastRefill, this.#options.clock());
    const elapsed = now - this.#applicationLastRefill;
    this.#applicationTokens = Math.min(
      PEER_APPLICATION_RATE_BURST,
      this.#applicationTokens + (elapsed * PEER_APPLICATION_RATE_PER_SECOND) / 1000,
    );
    this.#applicationLastRefill = now;
    if (this.#applicationTokens < 1) return false;
    this.#applicationTokens -= 1;
    return true;
  }

  #setState(state: 'connecting' | 'connected'): void {
    if (!this.#live || this.#state === state || this.#state === 'connected') return;
    this.#state = state;
    this.#options.onStateChange(state);
  }

  #fail(failure: PeerFailure): void {
    if (!this.#live) return;
    this.#state = 'failed';
    this.#teardown();
    this.#options.onStateChange('failed', failure);
  }

  /** Closes the channel and connection, detaches every handler, and drops queues. */
  #teardown(): void {
    this.#applicationCallback = undefined;
    const channel = this.#channel;
    const connection = this.#connection;
    this.#channel = undefined;
    this.#connection = undefined;
    this.#pendingLocal.length = 0;
    this.#pendingRemote.length = 0;
    this.#pendingRemoteBytes = 0;
    if (channel !== undefined) {
      channel.onopen = null;
      channel.onmessage = null;
      channel.onclose = null;
      channel.onerror = null;
      channel.close();
    }
    if (connection !== undefined) {
      connection.onicecandidate = null;
      connection.onconnectionstatechange = null;
      connection.ondatachannel = null;
      connection.close();
    }
  }
}

function candidateBytes(candidate: IceCandidate): number {
  // Every field is validated printable ASCII, so length is its byte count.
  return (
    candidate.candidate.length +
    (candidate.sdpMid?.length ?? 0) +
    (candidate.usernameFragment?.length ?? 0)
  );
}
