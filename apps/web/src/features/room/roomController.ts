import {
  isInviteSecret,
  isRoomId,
  type ErrorCode,
  type InviteSecret,
  type NegotiationId,
  type ParticipantId,
  type RoomClosedReason,
  type RoomId,
  type ServerMessage,
} from '@driftless/protocol';
import type { IceServersResult } from './iceServers.ts';
import {
  PeerSession,
  type CreatePeerConnection,
  type PeerFailure,
  type PeerSessionState,
} from './peerSession.ts';
import {
  SignalingClient,
  type ClientBody,
  type CreateWebSocket,
  type SignalingCloseReason,
} from './signalingClient.ts';
import type { SignalingUrlResult } from './signalingUrl.ts';

/** Connection progress with the one peer. */
export type PeerConnectionView = 'negotiating' | 'connecting' | 'connected' | 'failed';

export interface PeerView {
  readonly participantId: ParticipantId;
  readonly connection: PeerConnectionView;
  readonly failure: PeerFailure | null;
}

/**
 * Why the room view last changed without the user asking, or why a request
 * failed. Fixed tokens; the interface maps them to sanitized text.
 */
export type RoomNotice =
  | 'left'
  | 'host_left'
  | 'host_disconnected'
  | 'room_expired'
  | 'guest_left'
  | 'guest_disconnected'
  | 'signaling_lost'
  | 'connect_failed'
  | 'protocol_error'
  | 'room_unavailable'
  | 'room_full'
  | 'rate_limited'
  | 'request_rejected'
  | 'invalid_join_details'
  | 'insecure_origin'
  | 'invalid_ice_config';

export type RoomState =
  | { readonly phase: 'idle'; readonly notice: RoomNotice | null }
  | { readonly phase: 'opening'; readonly intent: 'create' | 'join' }
  | {
      readonly phase: 'in-room';
      readonly role: 'host';
      readonly roomId: RoomId;
      /** Held only while the room exists, for the host to share. */
      readonly inviteSecret: InviteSecret;
      readonly participantId: ParticipantId;
      /** Null until a guest joins. */
      readonly peer: PeerView | null;
      readonly notice: 'guest_left' | 'guest_disconnected' | null;
    }
  | {
      readonly phase: 'in-room';
      readonly role: 'guest';
      readonly roomId: RoomId;
      readonly participantId: ParticipantId;
      readonly peer: PeerView;
    }
  | { readonly phase: 'leaving' };

export interface RoomControllerOptions {
  readonly signalingUrl: SignalingUrlResult;
  readonly iceServers: IceServersResult;
  readonly createWebSocket: CreateWebSocket;
  readonly createPeerConnection: CreatePeerConnection;
  readonly createNegotiationId: () => NegotiationId;
  readonly clock: () => number;
}

const IDLE: RoomState = { phase: 'idle', notice: null };

const CLOSED_NOTICES: Readonly<Record<RoomClosedReason, RoomNotice>> = {
  EXPIRED: 'room_expired',
  HOST_LEFT: 'host_left',
  HOST_DISCONNECTED: 'host_disconnected',
};

/**
 * Owns one room session: the signaling client, the peer session, and the
 * state the interface renders. It knows nothing about React; the interface
 * subscribes to `getState()` and calls the actions.
 *
 * Nothing touches the network until the user creates or joins a room. State
 * lives in memory only: the invite secret is held in the host's state while
 * its room exists and is dropped with it, and nothing is persisted.
 *
 * Messages that do not fit the current state, or that name a negotiation other
 * than the current one, are ignored, so a late event from an earlier room,
 * guest, or negotiation never changes the current session. Recovery is not
 * attempted: when signaling closes, everything is torn down and the user starts
 * again.
 */
export class RoomController {
  readonly #options: RoomControllerOptions;
  readonly #listeners = new Set<() => void>();
  #state: RoomState = IDLE;
  #signaling: SignalingClient | undefined;
  #peer: PeerSession | undefined;
  /** The notice to show if the service closes the connection after an error. */
  #closingNotice: RoomNotice | undefined;

  constructor(options: RoomControllerOptions) {
    this.#options = options;
  }

  getState = (): RoomState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Creates a room; this participant becomes its host. */
  createRoom(): void {
    if (this.#state.phase !== 'idle' || !this.#configured()) return;
    this.#setState({ phase: 'opening', intent: 'create' });
    void this.#request({ type: 'ROOM_CREATE', payload: {} });
  }

  /** Joins a room as its guest. Malformed details are refused without any request. */
  joinRoom(roomId: string, inviteSecret: string): void {
    if (this.#state.phase !== 'idle' || !this.#configured()) return;
    const id = roomId.trim();
    const secret = inviteSecret.trim();
    if (!isRoomId(id) || !isInviteSecret(secret)) {
      this.#setState({ phase: 'idle', notice: 'invalid_join_details' });
      return;
    }
    this.#setState({ phase: 'opening', intent: 'join' });
    void this.#request({ type: 'ROOM_JOIN', payload: { roomId: id, inviteSecret: secret } });
  }

  /** Leaves the room, or abandons a pending create or join. */
  leaveRoom(): void {
    const { phase } = this.#state;
    if (phase === 'opening') {
      // The request may already have been accepted; closing the connection
      // ends any membership it created.
      this.#closeSignaling();
      this.#setState(IDLE);
      return;
    }
    if (phase !== 'in-room') return;
    this.#closePeer();
    this.#setState({ phase: 'leaving' });
    if (this.#signaling?.send({ type: 'ROOM_LEAVE', payload: {} }) !== true) {
      this.#closeSignaling();
      this.#setState({ phase: 'idle', notice: 'left' });
    }
  }

  /** Releases every resource and returns to idle. The controller stays usable. */
  shutdown(): void {
    this.#closePeer();
    this.#closeSignaling();
    this.#setState(IDLE);
  }

  #configured(): boolean {
    const notice: RoomNotice | undefined = !this.#options.signalingUrl.ok
      ? 'insecure_origin'
      : !this.#options.iceServers.ok
        ? 'invalid_ice_config'
        : undefined;
    if (notice === undefined) return true;
    this.#setState({ phase: 'idle', notice });
    return false;
  }

  /** Opens signaling if needed, then sends a create or join request. */
  async #request(body: ClientBody): Promise<void> {
    const { signalingUrl } = this.#options;
    if (!signalingUrl.ok) return;
    let client = this.#signaling;
    if (client === undefined) {
      client = new SignalingClient({
        url: signalingUrl.url,
        createWebSocket: this.#options.createWebSocket,
        clock: this.#options.clock,
        onMessage: (message) => {
          if (this.#signaling === client) this.#receive(message);
        },
        onClose: (reason) => {
          if (this.#signaling === client) this.#signalingClosed(reason);
        },
      });
      this.#signaling = client;
      this.#closingNotice = undefined;
    }
    try {
      await client.open();
    } catch {
      if (this.#signaling === client) {
        this.#signaling = undefined;
        if (this.#state.phase === 'opening')
          this.#setState({ phase: 'idle', notice: 'connect_failed' });
      }
      return;
    }
    // The user may have abandoned the request while the connection opened.
    if (this.#signaling !== client || this.#state.phase !== 'opening') return;
    if (!client.send(body)) {
      this.#closeSignaling();
      this.#setState({ phase: 'idle', notice: 'connect_failed' });
    }
  }

  #receive(message: ServerMessage): void {
    const state = this.#state;
    switch (message.type) {
      case 'ROOM_CREATED':
        if (state.phase === 'opening' && state.intent === 'create') {
          const { roomId, inviteSecret, participantId } = message.payload;
          this.#setState({
            phase: 'in-room',
            role: 'host',
            roomId,
            inviteSecret,
            participantId,
            peer: null,
            notice: null,
          });
        }
        return;
      case 'ROOM_JOINED':
        if (state.phase === 'opening' && state.intent === 'join') {
          const { roomId, participantId, peer } = message.payload;
          // The guest waits for the host's offer; no connection exists yet.
          this.#setState({
            phase: 'in-room',
            role: 'guest',
            roomId,
            participantId,
            peer: { participantId: peer.participantId, connection: 'negotiating', failure: null },
          });
        }
        return;
      case 'ROOM_PARTICIPANT_JOINED':
        if (state.phase === 'in-room' && state.role === 'host' && state.peer === null) {
          this.#startHostNegotiation(
            state.participantId,
            message.payload.participant.participantId,
          );
        }
        return;
      case 'ROOM_PARTICIPANT_LEFT':
        if (
          state.phase === 'in-room' &&
          state.role === 'host' &&
          state.peer?.participantId === message.payload.participantId
        ) {
          this.#closePeer();
          this.#setState({
            ...state,
            peer: null,
            notice: message.payload.reason === 'LEFT' ? 'guest_left' : 'guest_disconnected',
          });
        }
        return;
      case 'ROOM_LEFT':
        if (state.phase === 'leaving') this.#setState({ phase: 'idle', notice: 'left' });
        return;
      case 'ROOM_CLOSED':
        if (state.phase === 'in-room' || state.phase === 'leaving') {
          this.#closePeer();
          this.#setState({
            phase: 'idle',
            notice: state.phase === 'leaving' ? 'left' : CLOSED_NOTICES[message.payload.reason],
          });
        }
        return;
      case 'ERROR':
        this.#error(message.payload.code, message.payload.recoverable);
        return;
      case 'RTC_OFFER':
        if (state.phase === 'in-room' && state.role === 'guest' && this.#peer === undefined) {
          const peer = this.#createPeer(
            'guest',
            message.payload.negotiationId,
            state.participantId,
            state.peer.participantId,
          );
          void peer.acceptOffer(message.payload.sdp);
        }
        return;
      case 'RTC_ANSWER': {
        const peer = this.#currentPeer(message.payload.negotiationId);
        if (peer !== undefined && state.phase === 'in-room' && state.role === 'host') {
          void peer.acceptAnswer(message.payload.sdp);
        }
        return;
      }
      case 'ICE_CANDIDATE':
        this.#currentPeer(message.payload.negotiationId)?.addRemoteCandidate(
          message.payload.candidate,
        );
        return;
      case 'ICE_COMPLETE':
        this.#currentPeer(message.payload.negotiationId)?.remoteCandidatesComplete();
        return;
    }
  }

  /**
   * The service answers a request in order, so a recoverable error while a
   * create or join is pending is that request's answer. In a room, or while
   * leaving, a recoverable error can only be the refusal of a negotiation
   * message the service considered stale, for example a candidate sent just
   * before the guest left; it is not a failure of the current session and is
   * ignored. (A leave itself cannot fail while the service still counts this
   * connection as a member, and it reports the room closing before refusing
   * a leave.) A non-recoverable error is followed by the service closing the
   * connection, which is handled when it happens.
   */
  #error(code: ErrorCode, recoverable: boolean): void {
    const notice = errorNotice(code);
    if (!recoverable) this.#closingNotice = notice;
    else if (this.#state.phase === 'opening') this.#setState({ phase: 'idle', notice });
  }

  #signalingClosed(reason: SignalingCloseReason): void {
    const wasIdle = this.#state.phase === 'idle';
    const notice =
      reason === 'protocol_error' ? 'protocol_error' : (this.#closingNotice ?? 'signaling_lost');
    this.#signaling = undefined;
    this.#closePeer();
    // In this phase a peer session does not outlive signaling: it is torn
    // down, and the user starts again. An idle connection closes quietly.
    if (!wasIdle) {
      this.#setState({ phase: 'idle', notice: this.#state.phase === 'leaving' ? 'left' : notice });
    }
  }

  #startHostNegotiation(localId: ParticipantId, guestId: ParticipantId): void {
    const state = this.#state;
    if (state.phase !== 'in-room' || state.role !== 'host') return;
    const peer = this.#createPeer('host', this.#options.createNegotiationId(), localId, guestId);
    this.#setState({
      ...state,
      peer: { participantId: guestId, connection: 'negotiating', failure: null },
      notice: null,
    });
    void peer.start();
  }

  #createPeer(
    role: 'host' | 'guest',
    negotiationId: NegotiationId,
    localParticipantId: ParticipantId,
    remoteParticipantId: ParticipantId,
  ): PeerSession {
    const { iceServers } = this.#options;
    const peer: PeerSession = new PeerSession({
      role,
      negotiationId,
      localParticipantId,
      remoteParticipantId,
      configuration: { iceServers: iceServers.ok ? [...iceServers.iceServers] : [] },
      createPeerConnection: this.#options.createPeerConnection,
      clock: this.#options.clock,
      signal: (body) => this.#peer === peer && this.#signaling?.send(body) === true,
      onStateChange: (peerState, failure) => {
        if (this.#peer === peer) this.#peerStateChanged(peerState, failure);
      },
    });
    this.#peer = peer;
    return peer;
  }

  #currentPeer(negotiationId: NegotiationId): PeerSession | undefined {
    const peer = this.#peer;
    return peer?.negotiationId === negotiationId ? peer : undefined;
  }

  #peerStateChanged(peerState: PeerSessionState, failure: PeerFailure | undefined): void {
    const state = this.#state;
    if (state.phase !== 'in-room' || state.peer === null || peerState === 'closed') return;
    // A failed session stays current, inert, so that no second negotiation
    // can start for this membership. The participant stays in the room;
    // leaving is the user's decision, and a new attempt needs a new join.
    const peer: PeerView = {
      participantId: state.peer.participantId,
      connection: peerState,
      failure: failure ?? null,
    };
    this.#setState(state.role === 'host' ? { ...state, peer } : { ...state, peer });
  }

  #closePeer(): void {
    const peer = this.#peer;
    this.#peer = undefined;
    peer?.close();
  }

  #closeSignaling(): void {
    const client = this.#signaling;
    this.#signaling = undefined;
    client?.close();
  }

  #setState(state: RoomState): void {
    if (state === this.#state) return;
    this.#state = state;
    for (const listener of [...this.#listeners]) listener();
  }
}

function errorNotice(code: ErrorCode): RoomNotice {
  switch (code) {
    case 'ROOM_UNAVAILABLE':
      return 'room_unavailable';
    case 'ROOM_FULL':
      return 'room_full';
    case 'RATE_LIMITED':
      return 'rate_limited';
    case 'UNSUPPORTED_PROTOCOL':
    case 'INVALID_MESSAGE':
      return 'protocol_error';
    case 'INVALID_STATE':
    case 'SERVER_ERROR':
      return 'request_rejected';
  }
}
