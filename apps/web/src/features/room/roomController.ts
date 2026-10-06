import { LocalSyncController } from '../local-sync/localSyncController.ts';
import {
  MAX_NEGOTIATIONS_PER_MEMBERSHIP,
  isInviteSecret,
  isRoomId,
  type ErrorCode,
  type InviteSecret,
  type NegotiationId,
  type NegotiationSnapshot,
  type ParticipantId,
  type ParticipantLeftReason,
  type ParticipantSignalingState,
  type ResumeSecret,
  type RoomClosedReason,
  type RoomId,
  type ServerMessage,
  type SessionId,
  type RtcConfigMessage,
  type SessionResumedMessage,
} from '@driftless/protocol';
import { classifySelectedPath } from './connectionStats.ts';
import {
  NO_DIAGNOSTICS,
  type ConnectionDiagnostics,
  type TurnAvailability,
} from './diagnostics.ts';
import type {
  IceServersResult,
  IceTransportPolicy,
  IceTransportPolicyResult,
} from './iceServers.ts';
import {
  PeerSession,
  type CreatePeerConnection,
  type PeerFailure,
  type PeerSessionState,
} from './peerSession.ts';
import {
  HOST_RECOVERY_DELAY_MS,
  LEAVE_RETRY_DELAYS_MS,
  RECONNECT_DELAYS_MS,
  RESUME_ATTEMPT_TIMEOUT_MS,
  browserTimers,
  type Cancel,
  type Timers,
} from './reconnectSchedule.ts';
import type { ProveResume } from './resumeProof.ts';
import {
  RTC_CONFIG_REFRESH_MARGIN_MS,
  RTC_CONFIG_WAIT_MS,
  acceptRtcConfig,
  type RuntimeIceConfig,
} from './rtcConfig.ts';
import {
  ABANDONED_CLOSURE_CODE,
  SignalingClient,
  type ClientBody,
  type CreateWebSocket,
  type SignalingCloseReason,
} from './signalingClient.ts';
import type { SignalingUrlResult } from './signalingUrl.ts';

/** Whether a participant's signaling connection is up or being resumed. */
export type SignalingView = 'connected' | 'reconnecting';

/**
 * Peer transport progress with the one peer, independent of signaling.
 * `recovering` means an earlier peer session ended and a fresh one is being
 * set up or awaited; `failed` means recovery stopped at its bound.
 */
export type PeerConnectionView =
  'negotiating' | 'connecting' | 'connected' | 'recovering' | 'failed';

export interface PeerView {
  readonly participantId: ParticipantId;
  /** The other participant's signaling presence, as the service reports it. */
  readonly signaling: SignalingView;
  readonly connection: PeerConnectionView;
  /** Why the latest peer session ended, if one did. */
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
  | 'host_timed_out'
  | 'room_expired'
  | 'guest_left'
  | 'guest_disconnected'
  | 'guest_timed_out'
  | 'guest_gone'
  | 'restored'
  | 'signaling_lost'
  | 'session_unrecoverable'
  | 'connect_failed'
  | 'protocol_error'
  | 'room_unavailable'
  | 'room_full'
  | 'rate_limited'
  | 'request_rejected'
  | 'invalid_join_details'
  | 'insecure_origin'
  | 'invalid_ice_config';

/** Notices shown inside a room. `restored` follows a recovered disruption. */
export type HostRoomNotice =
  'guest_left' | 'guest_disconnected' | 'guest_timed_out' | 'guest_gone' | 'restored';

/**
 * Room membership, this participant's signaling connection, and the peer
 * transport are independent: a room may be `in-room` with signaling
 * `reconnecting` and the peer data channel still `connected`.
 */
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
      readonly signaling: SignalingView;
      /** Null until a guest joins. */
      readonly peer: PeerView | null;
      readonly notice: HostRoomNotice | null;
    }
  | {
      readonly phase: 'in-room';
      readonly role: 'guest';
      readonly roomId: RoomId;
      readonly participantId: ParticipantId;
      readonly signaling: SignalingView;
      readonly peer: PeerView;
      readonly notice: 'restored' | null;
    }
  | { readonly phase: 'leaving' };

type InRoomState = Extract<RoomState, { phase: 'in-room' }>;

export interface RoomControllerOptions {
  readonly signalingUrl: SignalingUrlResult;
  /** Build-time STUN servers. */
  readonly iceServers: IceServersResult;
  /** The ICE transport policy; `all` unless a qualification build sets `relay`. */
  readonly iceTransportPolicy?: IceTransportPolicyResult;
  /**
   * `service`: after admission, and before a peer connection when needed,
   * ask the signaling service for ICE servers, including short-lived TURN
   * credentials, and use them with the build-time STUN servers. `none` (the
   * default) uses the build-time STUN servers only. The browser uses
   * `service`.
   */
  readonly rtcConfigSource?: 'service' | 'none';
  readonly createWebSocket: CreateWebSocket;
  readonly createPeerConnection: CreatePeerConnection;
  readonly createNegotiationId: () => NegotiationId;
  readonly proveResume: ProveResume;
  readonly clock: () => number;
  /** One-shot timers for the reconnect schedule; the browser's by default. */
  readonly timers?: Timers;
}

/**
 * The membership credentials, in memory only and never in `RoomState`, so
 * the interface never sees the resume secret. Dropped when the room ends.
 */
interface Membership {
  readonly role: 'host' | 'guest';
  readonly roomId: RoomId;
  readonly sessionId: SessionId;
  readonly participantId: ParticipantId;
  readonly resumeSecret: ResumeSecret;
}

/**
 * One bounded schedule of resume attempts after signaling was lost.
 *
 * - `resume`: resume the membership and continue the room.
 * - `leave`: the user left while signaling was down; resume the membership
 *   only to end it at once with `ROOM_LEAVE`. A resume under this purpose
 *   never restores the room.
 *
 * The purpose changes once at most, from `resume` to `leave`, when the user
 * leaves; an attempt already in flight then continues under the new purpose.
 */
interface Reconnect {
  purpose: 'resume' | 'leave';
  delays: readonly number[];
  /** Index of the next attempt in `delays`. */
  next: number;
  /** The pending delay or attempt timeout. */
  cancelTimer: Cancel | undefined;
}

const IDLE: RoomState = { phase: 'idle', notice: null };

const CLOSED_NOTICES: Readonly<Record<RoomClosedReason, RoomNotice>> = {
  EXPIRED: 'room_expired',
  HOST_LEFT: 'host_left',
  HOST_DISCONNECTED: 'host_disconnected',
  HOST_RECONNECT_TIMEOUT: 'host_timed_out',
};

const LEFT_NOTICES: Readonly<Record<ParticipantLeftReason, HostRoomNotice>> = {
  LEFT: 'guest_left',
  DISCONNECTED: 'guest_disconnected',
  RECONNECT_TIMEOUT: 'guest_timed_out',
};

/**
 * Owns one room session: the signaling client, the peer session, the resume
 * schedule, and the state the interface renders. It knows nothing about
 * React; the interface subscribes to `getState()` and calls the actions.
 *
 * Nothing touches the network until the user creates or joins a room. State
 * lives in memory only: the invite and resume secrets are held while the
 * room exists and dropped with it, and nothing is persisted, so a reload
 * cannot resume a room.
 *
 * Recovery is bounded and never replays anything:
 *
 * - When signaling is lost, a working peer data channel is kept, any
 *   unfinished negotiation is abandoned, and a new connection resumes the
 *   membership by answering a challenge with the resume secret, on a fixed,
 *   finite schedule. After `SESSION_RESUMED` the controller reconciles with
 *   the service's snapshot before anything else is sent.
 * - When the peer transport fails, the session is discarded, never repaired,
 *   and a fresh negotiation with a fresh connection and channel replaces it:
 *   the host sends a recovery offer, and the guest asks for one. A membership
 *   uses at most MAX_NEGOTIATIONS_PER_MEMBERSHIP negotiations.
 *
 * Messages that do not fit the current state, or that name a negotiation
 * other than the current one, are ignored, so a late event from an earlier
 * room, guest, negotiation, or connection never changes the current session.
 */
export class RoomController {
  readonly localSync = new LocalSyncController();
  readonly #options: RoomControllerOptions;
  readonly #timers: Timers;
  readonly #listeners = new Set<() => void>();
  /** Separate, so room-state subscribers are notified only of room-state changes. */
  readonly #diagnosticsListeners = new Set<() => void>();
  #state: RoomState = IDLE;
  #signaling: SignalingClient | undefined;
  /** Whether `#signaling` carries the membership, rather than resuming it. */
  #signalingReady = false;
  #reconnect: Reconnect | undefined;
  #membership: Membership | undefined;
  #peer: PeerSession | undefined;
  /** The latest negotiation the service holds for this guest membership, as known here. */
  #activeNegotiationId: NegotiationId | null = null;
  #negotiationCount = 0;
  /** The negotiation this guest last asked to replace, so it asks only once. */
  #recoveryRequestedFor: NegotiationId | undefined;
  /** Whether a peer session has ended and its replacement has not yet connected. */
  #recovering = false;
  /** Whether something was disrupted since the room was last fully connected. */
  #disrupted = false;
  /** The host's pending unprompted recovery after its own session failed. */
  #cancelHostRecovery: Cancel | undefined;
  /**
   * The host's latest offering session and the negotiation that was active
   * before it, so that an offer that never left this browser does not
   * change which negotiation the service is believed to hold.
   */
  #offering: { readonly peer: PeerSession; readonly previous: NegotiationId | null } | undefined;
  /** The notice to show if the service closes the connection after an error. */
  #closingNotice: RoomNotice | undefined;

  readonly #icePolicy: IceTransportPolicy;
  readonly #rtcConfigSource: 'service' | 'none';
  /** The service's latest usable ICE configuration, in memory only. */
  #runtimeIce: RuntimeIceConfig | undefined;
  /** The connection with an unanswered RTC_CONFIG_REQUEST, if any. */
  #rtcConfigOutstanding: SignalingClient | undefined;
  /** Peer connection starts waiting for the service's ICE configuration. */
  #rtcConfigWaiters: (() => void)[] = [];
  #cancelRtcConfigWait: Cancel | undefined;
  /** What each peer session's configuration offered, for diagnostics. */
  readonly #peerTurn = new WeakMap<PeerSession, TurnAvailability>();

  #diagnostics: ConnectionDiagnostics;
  /** Increases whenever a snapshot is started or discarded, so a late one is dropped. */
  #diagnosticsGeneration = 0;

  constructor(options: RoomControllerOptions) {
    this.#options = options;
    this.#timers = options.timers ?? browserTimers;
    const policy = options.iceTransportPolicy;
    this.#icePolicy = policy?.ok === true ? policy.policy : 'all';
    this.#rtcConfigSource = options.rtcConfigSource ?? 'none';
    this.#diagnostics = NO_DIAGNOSTICS(this.#icePolicy);
  }

  getState = (): RoomState => this.#state;

  /** The current peer connection's diagnostics; see `ConnectionDiagnostics`. */
  getDiagnostics = (): ConnectionDiagnostics => this.#diagnostics;

  subscribeDiagnostics = (listener: () => void): (() => void) => {
    this.#diagnosticsListeners.add(listener);
    return () => {
      this.#diagnosticsListeners.delete(listener);
    };
  };

  /**
   * Reads the current peer connection's states and statistics again. It is
   * observational only: it never restarts ICE, creates or closes a
   * connection, changes the ICE policy, or triggers recovery, and a failure
   * to read statistics only leaves the path `UNKNOWN`. Also run once each
   * time a peer connection becomes connected, including after recovery.
   */
  refreshDiagnostics(): void {
    const peer = this.#peer;
    if (peer === undefined) {
      this.#resetDiagnostics();
      return;
    }
    const generation = ++this.#diagnosticsGeneration;
    const previous = this.#diagnostics;
    this.#setDiagnostics({
      ...this.#observeDiagnostics(peer),
      status: 'collecting',
      // Same session, so the previous path still describes it until replaced.
      path: previous.path,
      collectedAt: previous.collectedAt,
    });
    peer.getStats().then(
      (report) => {
        if (generation !== this.#diagnosticsGeneration || this.#peer !== peer) return;
        this.#setDiagnostics({
          ...this.#observeDiagnostics(peer),
          status: 'ready',
          path: classifySelectedPath(report),
          collectedAt: this.#options.clock(),
        });
      },
      () => undefined,
    );
  }

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

  /**
   * Leaves the room, or abandons a pending create or join. While signaling
   * is reconnecting there is no connection to send the leave on, so the room
   * is left locally at once; the service ends the membership when its grace
   * period does.
   */
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
    if (!this.#signalingReady) {
      this.#beginTerminalLeave();
      return;
    }
    // The leave goes out before the peer teardown, so the service's notice
    // to the peer has a head start on the closing data channel.
    const sent = this.#signaling?.send({ type: 'ROOM_LEAVE', payload: {} }) === true;
    this.#closePeer();
    this.#forgetMembership();
    this.#setState({ phase: 'leaving' });
    if (!sent) {
      this.#closeSignaling();
      this.#setState({ phase: 'idle', notice: 'left' });
    }
  }

  /**
   * Leave while signaling is reconnecting. The peer session closes now and
   * nothing renegotiates. The room's credentials stay in private memory
   * only while a short, finite schedule tries to reach the service, resume
   * the membership, and end it with `ROOM_LEAVE`, so the service frees the
   * slot, or closes the host's room and invalidates its invite, at once.
   * If the service cannot be reached in that time the room is left locally
   * and the credentials discarded, and the service ends the membership when
   * its reconnect grace or the room's lifetime does.
   */
  #beginTerminalLeave(): void {
    const reconnect = this.#reconnect;
    if (reconnect === undefined || this.#membership === undefined) {
      this.#endRoom('left');
      return;
    }
    this.#closePeer();
    this.#resetNegotiation();
    reconnect.purpose = 'leave';
    reconnect.delays = LEAVE_RETRY_DELAYS_MS;
    this.#setState({ phase: 'leaving' });
    if (this.#signaling === undefined) {
      // Waiting between attempts: try at once instead.
      reconnect.cancelTimer?.();
      reconnect.cancelTimer = undefined;
      reconnect.next = 0;
      this.#scheduleAttempt();
    } else {
      // An attempt is in flight; it continues as the first leave attempt.
      reconnect.next = 1;
    }
  }

  /** Releases every resource and timer and returns to idle. The controller stays usable. */
  shutdown(): void {
    this.localSync.shutdown();
    this.#closePeer();
    this.#cancelReconnect();
    this.#closeSignaling();
    this.#forgetMembership();
    this.#setState(IDLE);
  }

  #configured(): boolean {
    const notice: RoomNotice | undefined = !this.#options.signalingUrl.ok
      ? 'insecure_origin'
      : !this.#options.iceServers.ok || this.#options.iceTransportPolicy?.ok === false
        ? 'invalid_ice_config'
        : undefined;
    if (notice === undefined) return true;
    this.#setState({ phase: 'idle', notice });
    return false;
  }

  /** A new signaling client whose callbacks act only while it is current. */
  #newSignalingClient(): SignalingClient | undefined {
    const { signalingUrl } = this.#options;
    if (!signalingUrl.ok) return undefined;
    const client: SignalingClient = new SignalingClient({
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
    return client;
  }

  /** Opens signaling if needed, then sends a create or join request. */
  async #request(body: ClientBody): Promise<void> {
    let client = this.#signaling;
    if (client === undefined) {
      client = this.#newSignalingClient();
      if (client === undefined) return;
      this.#signaling = client;
      this.#signalingReady = true;
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
    // A connection that is resuming the membership has not been told
    // anything about the room yet, and acts on nothing else.
    if (!this.#signalingReady) {
      this.#receiveWhileResuming(message);
      return;
    }
    const state = this.#state;
    switch (message.type) {
      case 'ROOM_CREATED':
        if (state.phase === 'opening' && state.intent === 'create') {
          const { roomId, sessionId, inviteSecret, resumeSecret, participantId } = message.payload;
          this.#beginMembership({ role: 'host', roomId, sessionId, participantId, resumeSecret });
          this.#setState({
            phase: 'in-room',
            role: 'host',
            roomId,
            inviteSecret,
            participantId,
            signaling: 'connected',
            peer: null,
            notice: null,
          });
          this.#requestRtcConfig();
        }
        return;
      case 'ROOM_JOINED':
        if (state.phase === 'opening' && state.intent === 'join') {
          const { roomId, sessionId, resumeSecret, participantId, peer } = message.payload;
          this.#beginMembership({ role: 'guest', roomId, sessionId, participantId, resumeSecret });
          // The guest waits for the host's offer; no connection exists yet.
          this.#setState({
            phase: 'in-room',
            role: 'guest',
            roomId,
            participantId,
            signaling: 'connected',
            peer: {
              participantId: peer.participantId,
              signaling: 'connected',
              connection: 'negotiating',
              failure: null,
            },
            notice: null,
          });
          this.#requestRtcConfig();
        }
        return;
      case 'ROOM_PARTICIPANT_JOINED':
        if (state.phase === 'in-room' && state.role === 'host' && state.peer === null) {
          this.#resetNegotiation();
          this.#setInRoom({
            ...state,
            peer: {
              participantId: message.payload.participant.participantId,
              signaling: 'connected',
              connection: 'negotiating',
              failure: null,
            },
            notice: null,
          });
          this.#renegotiate();
        }
        return;
      case 'ROOM_PARTICIPANT_LEFT':
        if (
          state.phase === 'in-room' &&
          state.role === 'host' &&
          state.peer?.participantId === message.payload.participantId
        ) {
          this.#closePeer();
          this.#resetNegotiation();
          this.#disrupted = false;
          this.#setState({ ...state, peer: null, notice: LEFT_NOTICES[message.payload.reason] });
        }
        return;
      case 'ROOM_PARTICIPANT_CONNECTION':
        if (
          state.phase === 'in-room' &&
          state.peer?.participantId === message.payload.participantId
        ) {
          const { participantId, signaling, ...negotiation } = message.payload;
          this.#reconcile({ participantId, signaling }, negotiation);
        }
        return;
      case 'ROOM_LEFT':
        if (state.phase === 'leaving') this.#leaveConfirmed();
        return;
      case 'ROOM_CLOSED':
        // The connection stays open for a later room.
        if (state.phase === 'in-room') this.#endRoom(CLOSED_NOTICES[message.payload.reason], true);
        else if (state.phase === 'leaving') this.#leaveConfirmed();
        return;
      case 'ERROR':
        this.#error(message.payload.code, message.payload.recoverable);
        return;
      case 'RTC_CONFIG':
        // Only the answer to this membership's own request on this connection.
        if (state.phase === 'in-room' && this.#rtcConfigOutstanding === this.#signaling) {
          this.#rtcConfigReceived(message);
        }
        return;
      case 'RTC_OFFER':
        if (
          state.phase === 'in-room' &&
          state.role === 'guest' &&
          this.#peer === undefined &&
          this.#activeNegotiationId === null
        ) {
          this.#acceptHostOffer(message.payload.negotiationId, message.payload.sdp);
        }
        return;
      case 'RTC_RECOVER':
        // Only a recovery of the negotiation this guest knows to be active.
        if (
          state.phase === 'in-room' &&
          state.role === 'guest' &&
          message.payload.previousNegotiationId === this.#activeNegotiationId
        ) {
          this.#closePeer();
          this.#recovering = true;
          this.#acceptHostOffer(message.payload.negotiationId, message.payload.sdp);
        }
        return;
      case 'RTC_RECOVERY_REQUEST':
        // The guest's transport failed: replace the negotiation it names, if current.
        if (
          state.phase === 'in-room' &&
          state.role === 'host' &&
          message.payload.negotiationId === this.#activeNegotiationId
        ) {
          this.#closePeer();
          this.#recovering = true;
          this.#renegotiate();
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
      case 'SESSION_RESUME_CHALLENGE':
      case 'SESSION_RESUMED':
        // Only meaningful on a resuming connection.
        return;
    }
  }

  /**
   * The service answers a request in order, so a recoverable error while a
   * create or join is pending is that request's answer. In a room, or while
   * leaving, a recoverable error can only be the refusal of a negotiation
   * message the service considered stale, for example a candidate sent just
   * before the peer's connection was lost; it is not a failure of the current
   * session and is ignored. A non-recoverable error is followed by the
   * service closing the connection, and that ends the room.
   */
  #error(code: ErrorCode, recoverable: boolean): void {
    const notice = errorNotice(code);
    if (!recoverable) this.#closingNotice = notice;
    else if (this.#state.phase === 'opening') this.#setState({ phase: 'idle', notice });
    // A terminal leave sent nothing but ROOM_LEAVE on this connection, so a
    // refusal means the membership is already gone.
    else if (this.#reconnect?.purpose === 'leave') this.#endRoom('left');
  }

  /** The service confirmed the leave, or closed the room first. */
  #leaveConfirmed(): void {
    if (this.#reconnect?.purpose === 'leave') this.#endRoom('left');
    else this.#setState({ phase: 'idle', notice: 'left' });
  }

  #signalingClosed(reason: SignalingCloseReason): void {
    // An unanswered configuration request is lost with its connection.
    this.#dropRtcConfigWait();
    if (this.#reconnect?.purpose === 'leave') {
      // A terminal-leave connection ended: before or after the resume, and
      // possibly before ROOM_LEAVE took effect. Try again within the
      // schedule; a later attempt finds the membership held again, or gone.
      this.#signaling = undefined;
      this.#signalingReady = false;
      if (reason === 'closed') this.#attemptFailed();
      else this.#endRoom('left');
      return;
    }
    const state = this.#state;
    // An ordinary loss of the connection carrying a room is resumable. A
    // protocol error, or a close after a non-recoverable error (a policy
    // closure by the service), is not: the service has ended the membership.
    if (
      state.phase === 'in-room' &&
      reason === 'closed' &&
      this.#closingNotice === undefined &&
      this.#membership !== undefined
    ) {
      this.#signaling = undefined;
      if (this.#signalingReady) this.#startReconnect(state);
      else this.#attemptFailed();
      return;
    }
    const wasIdle = state.phase === 'idle';
    const notice =
      reason === 'protocol_error' ? 'protocol_error' : (this.#closingNotice ?? 'signaling_lost');
    this.#signaling = undefined;
    this.#cancelReconnect();
    this.#closePeer();
    this.#forgetMembership();
    // An idle connection closes quietly.
    if (!wasIdle) {
      this.#setState({ phase: 'idle', notice: state.phase === 'leaving' ? 'left' : notice });
    }
  }

  /**
   * Signaling was lost while in a room. A connected peer session is kept;
   * an unfinished negotiation is abandoned, because its remaining messages
   * cannot be delivered and are never replayed. The first resume attempt is
   * immediate.
   */
  #startReconnect(state: InRoomState): void {
    this.#signalingReady = false;
    this.#abandonUnfinishedPeer();
    this.#setInRoom({ ...this.#withPeerProgress(state), signaling: 'reconnecting' });
    this.#reconnect = {
      purpose: 'resume',
      delays: RECONNECT_DELAYS_MS,
      next: 0,
      cancelTimer: undefined,
    };
    this.#scheduleAttempt();
  }

  /** Schedules the next attempt, or ends the room once the schedule is spent. */
  #scheduleAttempt(): void {
    const reconnect = this.#reconnect;
    if (reconnect === undefined) return;
    const delay = reconnect.delays[reconnect.next];
    if (delay === undefined) {
      // A leave that could not reach the service is still a leave.
      this.#endRoom(reconnect.purpose === 'leave' ? 'left' : 'session_unrecoverable');
      return;
    }
    reconnect.next += 1;
    reconnect.cancelTimer = this.#timers.schedule(delay, () => {
      if (this.#reconnect === reconnect) this.#runAttempt(reconnect);
    });
  }

  /** One attempt: a fresh connection, then BEGIN → CHALLENGE → PROVE → RESUMED. */
  #runAttempt(reconnect: Reconnect): void {
    const membership = this.#membership;
    const client = this.#newSignalingClient();
    if (membership === undefined || client === undefined) return;
    this.#signaling = client;
    this.#closingNotice = undefined;
    reconnect.cancelTimer = this.#timers.schedule(RESUME_ATTEMPT_TIMEOUT_MS, () => {
      if (this.#signaling === client) this.#attemptFailed();
    });
    client.open().then(
      () => {
        if (this.#signaling !== client) return;
        const sent = client.send({
          type: 'SESSION_RESUME_BEGIN',
          payload: { sessionId: membership.sessionId, participantId: membership.participantId },
        });
        if (!sent) this.#attemptFailed();
      },
      () => {
        if (this.#signaling === client) this.#attemptFailed();
      },
    );
  }

  /** Abandons the current attempt's connection and schedules the next attempt. */
  #attemptFailed(): void {
    const reconnect = this.#reconnect;
    if (reconnect === undefined) return;
    reconnect.cancelTimer?.();
    reconnect.cancelTimer = undefined;
    // Not a normal close: the service may have accepted the proof just now,
    // and must hold the membership rather than end it.
    this.#closeSignaling(ABANDONED_CLOSURE_CODE);
    this.#scheduleAttempt();
  }

  #receiveWhileResuming(message: ServerMessage): void {
    const membership = this.#membership;
    const client = this.#signaling;
    if (membership === undefined || client === undefined || this.#reconnect === undefined) return;
    switch (message.type) {
      case 'SESSION_RESUME_CHALLENGE': {
        const { challenge } = message.payload;
        void this.#options
          .proveResume(
            membership.resumeSecret,
            membership.sessionId,
            membership.participantId,
            challenge,
          )
          .then((proof) => {
            if (this.#signaling !== client) return;
            const sent =
              proof !== undefined &&
              client.send({ type: 'SESSION_RESUME_PROVE', payload: { challenge, proof } });
            if (!sent) this.#attemptFailed();
          });
        return;
      }
      case 'SESSION_RESUMED':
        if (this.#reconnect.purpose === 'leave') this.#resumedToLeave(membership, message.payload);
        else this.#resumed(membership, message.payload);
        return;
      case 'ERROR':
        // For a leave, an unavailable membership is already what the user
        // wants. Otherwise, or for any other refusal, this attempt is over.
        if (this.#reconnect.purpose === 'leave' && message.payload.code === 'SESSION_UNAVAILABLE') {
          this.#endRoom('left');
        } else {
          this.#attemptFailed();
        }
        return;
      default:
        // Nothing else is expected before the snapshot.
        this.#attemptFailed();
    }
  }

  /**
   * The membership is back on this connection, for the leave only: nothing
   * is reconciled or renegotiated, and the room view is not restored.
   * `ROOM_LEAVE` goes out at once. The attempt's timeout keeps running as
   * the bound on `ROOM_LEFT`; if the connection fails first, the next
   * attempt finds the membership held again or already gone.
   */
  #resumedToLeave(membership: Membership, snapshot: SessionResumedMessage['payload']): void {
    if (
      snapshot.sessionId !== membership.sessionId ||
      snapshot.participantId !== membership.participantId
    ) {
      this.#endRoom('left');
      return;
    }
    this.#signalingReady = true;
    if (this.#signaling?.send({ type: 'ROOM_LEAVE', payload: {} }) !== true) {
      this.#signalingReady = false;
      this.#attemptFailed();
    }
  }

  /**
   * The membership is back on this connection. The snapshot must describe
   * exactly this membership; then the controller reconciles with it before
   * sending anything else.
   */
  #resumed(membership: Membership, snapshot: SessionResumedMessage['payload']): void {
    const state = this.#state;
    if (
      state.phase !== 'in-room' ||
      snapshot.sessionId !== membership.sessionId ||
      snapshot.roomId !== membership.roomId ||
      snapshot.participantId !== membership.participantId ||
      snapshot.role !== membership.role
    ) {
      this.#endRoom('session_unrecoverable');
      return;
    }
    this.#cancelReconnect();
    this.#signalingReady = true;
    const { peer, activeNegotiationId, negotiationCount } = snapshot;
    this.#reconcile(
      peer === null ? null : { participantId: peer.participantId, signaling: peer.signaling },
      { activeNegotiationId, negotiationCount },
      'connected',
    );
  }

  /**
   * Converges on the service's authoritative state: the peer, its signaling
   * presence, and the negotiation. A local peer session survives only if it
   * is connected and belongs to the active negotiation; anything else is
   * closed, and a fresh negotiation is started or awaited once both
   * participants' signaling is connected. Nothing queued is replayed.
   */
  #reconcile(
    peer: { participantId: ParticipantId; signaling: ParticipantSignalingState } | null,
    negotiation: NegotiationSnapshot,
    ownSignaling?: SignalingView,
  ): void {
    const previous = this.#state;
    if (previous.phase !== 'in-room') return;
    // Applied in the same state change as the reconciliation.
    const state: InRoomState = { ...previous, signaling: ownSignaling ?? previous.signaling };
    this.#activeNegotiationId = negotiation.activeNegotiationId;
    this.#negotiationCount = negotiation.negotiationCount;
    // A recovery request sent before this point may not have been relayed;
    // the service accepts at most one per negotiation, so asking again is bounded.
    this.#recoveryRequestedFor = undefined;

    if (peer === null) {
      // Only a host can be alone: its guest left while it was away.
      if (state.role !== 'host') {
        this.#endRoom('session_unrecoverable');
        return;
      }
      this.#closePeer();
      this.#resetNegotiation();
      this.#disrupted = false;
      this.#setState({
        ...state,
        peer: null,
        notice: state.peer === null ? state.notice : 'guest_gone',
      });
      return;
    }

    let current = state.peer;
    if (current?.participantId !== peer.participantId) {
      // A guest's host never changes. A host may find a different guest,
      // who joined while it was away; the earlier guest's session is gone.
      if (state.role !== 'host') {
        this.#endRoom('session_unrecoverable');
        return;
      }
      this.#closePeer();
      this.#recovering = false;
      this.#recoveryRequestedFor = undefined;
      current = {
        participantId: peer.participantId,
        signaling: 'connected',
        connection: 'negotiating',
        failure: null,
      };
    }

    const local = this.#peer;
    const keep =
      local !== undefined &&
      local.state === 'connected' &&
      local.negotiationId === negotiation.activeNegotiationId;
    if (!keep && local !== undefined) {
      this.#closePeer();
      this.#recovering = true;
    }
    const signaling: SignalingView = peer.signaling === 'CONNECTED' ? 'connected' : 'reconnecting';
    const view: PeerView = {
      ...current,
      signaling,
      connection: keep ? 'connected' : this.#idleConnectionView(),
    };
    this.#setInRoom(state.role === 'host' ? { ...state, peer: view } : { ...state, peer: view });
    if (!keep && signaling === 'connected') this.#renegotiate();
  }

  /**
   * With no live peer session and both participants' signaling connected,
   * starts the next negotiation: the host offers, the first time, or sends a
   * recovery offer replacing the active one; the guest waits for the first
   * offer or asks once for a recovery offer. Stops at the bound.
   */
  #renegotiate(): void {
    this.#cancelHostRecovery?.();
    this.#cancelHostRecovery = undefined;
    const state = this.#state;
    if (
      state.phase !== 'in-room' ||
      state.peer === null ||
      this.#peer !== undefined ||
      !this.#signalingReady ||
      state.peer.signaling !== 'connected'
    ) {
      return;
    }
    if (this.#negotiationCount >= MAX_NEGOTIATIONS_PER_MEMBERSHIP) {
      this.#setInRoom({ ...state, peer: { ...state.peer, connection: 'failed' } });
      return;
    }
    const active = this.#activeNegotiationId;
    if (state.role === 'host') {
      this.#startHostNegotiation(active ?? undefined);
      return;
    }
    if (active === null || this.#recoveryRequestedFor === active) return;
    if (
      this.#signaling?.send({
        type: 'RTC_RECOVERY_REQUEST',
        payload: { negotiationId: active },
      }) === true
    ) {
      this.#recoveryRequestedFor = active;
    }
  }

  /** Host: a fresh negotiation, replacing `previous` if given. */
  #startHostNegotiation(previous: NegotiationId | undefined): void {
    const state = this.#state;
    const membership = this.#membership;
    if (
      state.phase !== 'in-room' ||
      state.role !== 'host' ||
      state.peer === null ||
      membership === undefined
    ) {
      return;
    }
    const negotiationId = this.#options.createNegotiationId();
    const before = this.#activeNegotiationId;
    this.#activeNegotiationId = negotiationId;
    // Counted even if the offer never leaves, so local failures stay bounded.
    this.#negotiationCount += 1;
    const peer = this.#createPeer('host', negotiationId, state.peer.participantId, previous);
    this.#offering = { peer, previous: before };
    this.#setInRoom({
      ...state,
      peer: { ...state.peer, connection: this.#recovering ? 'recovering' : 'negotiating' },
    });
    this.#withRtcConfig(() => {
      if (this.#peer === peer) void peer.start();
    });
  }

  /** Guest: a fresh session for the host's first or recovery offer. */
  #acceptHostOffer(negotiationId: NegotiationId, sdp: string): void {
    const state = this.#state;
    if (state.phase !== 'in-room' || state.role !== 'guest') return;
    if (this.#negotiationCount >= MAX_NEGOTIATIONS_PER_MEMBERSHIP) return;
    this.#activeNegotiationId = negotiationId;
    this.#negotiationCount += 1;
    this.#recoveryRequestedFor = undefined;
    const peer = this.#createPeer('guest', negotiationId, state.peer.participantId, undefined);
    this.#setInRoom({
      ...state,
      peer: { ...state.peer, connection: this.#recovering ? 'recovering' : 'negotiating' },
    });
    // The session exists already, so the host's trickled candidates are held
    // in its bounded queue while the configuration is awaited.
    this.#withRtcConfig(() => {
      if (this.#peer === peer) void peer.acceptOffer(sdp);
    });
  }

  #createPeer(
    role: 'host' | 'guest',
    negotiationId: NegotiationId,
    remoteParticipantId: ParticipantId,
    previousNegotiationId: NegotiationId | undefined,
  ): PeerSession {
    const membership = this.#membership;
    if (membership === undefined) throw new Error('No membership for a peer session.');
    const peer: PeerSession = new PeerSession({
      role,
      sessionId: membership.sessionId,
      negotiationId,
      ...(previousNegotiationId === undefined ? {} : { previousNegotiationId }),
      localParticipantId: membership.participantId,
      remoteParticipantId,
      configuration: () => this.#peerConfiguration(peer),
      createPeerConnection: this.#options.createPeerConnection,
      clock: this.#options.clock,
      // Signaling carries a session's messages only while it carries the
      // membership; nothing is queued for later.
      signal: (body) =>
        this.#peer === peer && this.#signalingReady && this.#signaling?.send(body) === true,
      onApplicationMessage: (body) => {
        if (this.#peer === peer) this.localSync.receive(body);
      },
      onStateChange: (peerState, failure) => {
        if (this.#peer === peer) this.#peerStateChanged(peerState, failure);
      },
    });
    this.#peer = peer;
    this.#resetDiagnostics();
    return peer;
  }

  /**
   * The configuration for one peer connection, built when it is created:
   * the build-time STUN servers, plus the service's ICE servers if a usable
   * configuration is held, and the ICE transport policy if it is `relay`.
   */
  #peerConfiguration(peer: PeerSession): RTCConfiguration {
    const { iceServers } = this.#options;
    const runtime = this.#usableRuntimeIce(0);
    const turn: TurnAvailability =
      this.#rtcConfigSource === 'none'
        ? 'not_requested'
        : runtime === undefined
          ? 'unavailable'
          : runtime.turn
            ? 'offered'
            : 'not_configured';
    this.#peerTurn.set(peer, turn);
    return {
      iceServers: [...(iceServers.ok ? iceServers.iceServers : []), ...(runtime?.iceServers ?? [])],
      ...(this.#icePolicy === 'relay' ? { iceTransportPolicy: 'relay' } : {}),
    };
  }

  /** The held configuration, if it stays usable for more than `marginMs`. */
  #usableRuntimeIce(marginMs: number): RuntimeIceConfig | undefined {
    const config = this.#runtimeIce;
    return config !== undefined && config.expiresAt - this.#options.clock() > marginMs
      ? config
      : undefined;
  }

  /**
   * Runs `start` once ICE servers are settled: at once without a service
   * configuration or with a usable one; otherwise after the service answers
   * a fresh request, or after RTC_CONFIG_WAIT_MS without TURN.
   */
  #withRtcConfig(start: () => void): void {
    if (
      this.#rtcConfigSource === 'none' ||
      this.#usableRuntimeIce(RTC_CONFIG_REFRESH_MARGIN_MS) !== undefined
    ) {
      start();
      return;
    }
    this.#rtcConfigWaiters.push(start);
    this.#requestRtcConfig();
    this.#cancelRtcConfigWait ??= this.#timers.schedule(RTC_CONFIG_WAIT_MS, () => {
      this.#cancelRtcConfigWait = undefined;
      this.#flushRtcConfigWaiters();
    });
  }

  /** Asks for this membership's ICE configuration, once per unanswered request. */
  #requestRtcConfig(): void {
    const client = this.#signaling;
    if (
      this.#rtcConfigSource !== 'service' ||
      client === undefined ||
      !this.#signalingReady ||
      this.#rtcConfigOutstanding === client
    ) {
      return;
    }
    if (client.send({ type: 'RTC_CONFIG_REQUEST', payload: {} })) {
      this.#rtcConfigOutstanding = client;
    }
  }

  #rtcConfigReceived(message: RtcConfigMessage): void {
    this.#rtcConfigOutstanding = undefined;
    // An unusable answer does not replace a configuration that is still usable.
    const accepted = acceptRtcConfig(message, this.#options.clock());
    if (accepted !== undefined) this.#runtimeIce = accepted;
    this.#flushRtcConfigWaiters();
  }

  #flushRtcConfigWaiters(): void {
    this.#cancelRtcConfigWait?.();
    this.#cancelRtcConfigWait = undefined;
    for (const start of this.#rtcConfigWaiters.splice(0)) start();
  }

  /** Forgets any unanswered request and pending start; their sessions are gone. */
  #dropRtcConfigWait(): void {
    this.#rtcConfigOutstanding = undefined;
    this.#rtcConfigWaiters.length = 0;
    this.#cancelRtcConfigWait?.();
    this.#cancelRtcConfigWait = undefined;
  }

  /** Browser-reported states and counts of a session, without statistics. */
  #observeDiagnostics(
    peer: PeerSession | undefined,
  ): Omit<ConnectionDiagnostics, 'status' | 'path' | 'collectedAt'> {
    const observed = peer?.observe();
    return {
      peerConnection: observed?.connectionState ?? null,
      iceConnection: observed?.iceConnectionState ?? null,
      dataChannel: observed?.channelState ?? null,
      negotiation:
        peer === undefined
          ? null
          : { count: this.#negotiationCount, max: MAX_NEGOTIATIONS_PER_MEMBERSHIP },
      turn: peer === undefined ? null : (this.#peerTurn.get(peer) ?? null),
      icePolicy: this.#icePolicy,
    };
  }

  /**
   * Discards the snapshot when the peer session it described is replaced or
   * closed, so diagnostics never show an earlier connection's path; any
   * statistics still being read for it are dropped when they arrive.
   */
  #resetDiagnostics(): void {
    this.#diagnosticsGeneration += 1;
    this.#setDiagnostics({
      ...this.#observeDiagnostics(this.#peer),
      status: 'none',
      path: NO_DIAGNOSTICS(this.#icePolicy).path,
      collectedAt: null,
    });
  }

  #setDiagnostics(diagnostics: ConnectionDiagnostics): void {
    // Every field is a state, token, or number, so this compares them all.
    if (JSON.stringify(diagnostics) === JSON.stringify(this.#diagnostics)) return;
    this.#diagnostics = diagnostics;
    for (const listener of [...this.#diagnosticsListeners]) listener();
  }

  #currentPeer(negotiationId: NegotiationId): PeerSession | undefined {
    const peer = this.#peer;
    return peer?.negotiationId === negotiationId ? peer : undefined;
  }

  #peerStateChanged(peerState: PeerSessionState, failure: PeerFailure | undefined): void {
    const state = this.#state;
    if (state.phase !== 'in-room' || state.peer === null || peerState === 'closed') return;
    if (peerState === 'failed') {
      this.localSync.setChannel(undefined);
      // The failed session is discarded, never resurrected. A fresh one
      // replaces it once both sides can signal.
      const offering = this.#offering;
      if (
        offering !== undefined &&
        offering.peer === this.#peer &&
        !offering.peer.descriptionSent
      ) {
        // The service never saw this negotiation: the next one replaces the
        // one it does hold.
        this.#activeNegotiationId = offering.previous;
      }
      this.#offering = undefined;
      this.#peer = undefined;
      this.#resetDiagnostics();
      this.#recovering = true;
      this.#setInRoom({
        ...state,
        peer: { ...state.peer, connection: 'recovering', failure: failure ?? null },
      });
      if (state.role === 'guest') {
        this.#renegotiate();
      } else {
        // The guest's request, or its departure, normally arrives first.
        this.#cancelHostRecovery?.();
        this.#cancelHostRecovery = this.#timers.schedule(HOST_RECOVERY_DELAY_MS, () => {
          this.#cancelHostRecovery = undefined;
          this.#renegotiate();
        });
      }
      return;
    }
    if (peerState === 'connected') {
      this.#recovering = false;
      const peer = this.#peer;
      if (peer)
        this.localSync.setChannel(
          (body) => this.#peer === peer && peer.sendApplicationMessage(body),
        );
    }
    const connection: PeerConnectionView =
      peerState !== 'connected' && this.#recovering ? 'recovering' : peerState;
    this.#setInRoom({ ...state, peer: { ...state.peer, connection } });
    // One snapshot per connected session, including each recovered one.
    if (peerState === 'connected') this.refreshDiagnostics();
  }

  /** Closes a peer session that is not connected; its negotiation cannot finish. */
  #abandonUnfinishedPeer(): void {
    const peer = this.#peer;
    if (peer !== undefined && peer.state !== 'connected') {
      this.#closePeer();
      this.#recovering = true;
    }
  }

  /** The peer view after abandoning an unfinished session. */
  #withPeerProgress(state: InRoomState): InRoomState {
    const peer = state.peer;
    if (peer === null || this.#peer?.state === 'connected') return state;
    const view = { ...peer, connection: this.#idleConnectionView() };
    return state.role === 'host' ? { ...state, peer: view } : { ...state, peer: view };
  }

  /** What to show while no peer session is live. */
  #idleConnectionView(): PeerConnectionView {
    if (!this.#recovering) return 'negotiating';
    return this.#negotiationCount >= MAX_NEGOTIATIONS_PER_MEMBERSHIP ? 'failed' : 'recovering';
  }

  #beginMembership(membership: Membership): void {
    this.localSync.playback.setRole(membership.role);
    this.localSync.setRoom(membership.sessionId);
    this.#membership = membership;
    this.#resetNegotiation();
    this.#disrupted = false;
  }

  #resetNegotiation(): void {
    this.#cancelHostRecovery?.();
    this.#cancelHostRecovery = undefined;
    this.#activeNegotiationId = null;
    this.#negotiationCount = 0;
    this.#recoveryRequestedFor = undefined;
    this.#recovering = false;
  }

  #forgetMembership(): void {
    this.localSync.playback.setRole(null);
    this.localSync.setRoom(null);
    this.#membership = undefined;
    this.#resetNegotiation();
    this.#disrupted = false;
    // The configuration and its TURN credential belong to this membership.
    this.#runtimeIce = undefined;
    this.#dropRtcConfigWait();
  }

  /**
   * Ends the room locally: the peer session, timers, and credentials are
   * released, and the signaling connection too unless it is kept for reuse.
   */
  #endRoom(notice: RoomNotice, keepSignaling = false): void {
    this.#closePeer();
    this.#cancelReconnect();
    if (!keepSignaling) this.#closeSignaling();
    this.#forgetMembership();
    this.#setState({ phase: 'idle', notice });
  }

  #cancelReconnect(): void {
    const reconnect = this.#reconnect;
    this.#reconnect = undefined;
    reconnect?.cancelTimer?.();
  }

  #closePeer(): void {
    this.localSync.setChannel(undefined);
    const peer = this.#peer;
    this.#peer = undefined;
    peer?.close();
    if (peer !== undefined) this.#resetDiagnostics();
  }

  #closeSignaling(code?: number): void {
    const client = this.#signaling;
    this.#signaling = undefined;
    this.#signalingReady = false;
    this.#dropRtcConfigWait();
    client?.close(code);
  }

  /**
   * Sets an in-room state, marking disruptions and announcing, once, when
   * everything is connected again.
   */
  #setInRoom(next: InRoomState): void {
    const peer = next.peer;
    const healthy =
      next.signaling === 'connected' &&
      peer?.signaling === 'connected' &&
      peer.connection === 'connected';
    let state = next;
    if (!healthy) {
      if (
        next.signaling === 'reconnecting' ||
        peer?.signaling === 'reconnecting' ||
        this.#recovering
      ) {
        this.#disrupted = true;
      }
      if (next.notice === 'restored') state = { ...next, notice: null };
    } else if (this.#disrupted) {
      this.#disrupted = false;
      state = { ...next, notice: 'restored' };
    }
    this.#setState(state);
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
    case 'SESSION_UNAVAILABLE':
      return 'session_unrecoverable';
    case 'INVALID_STATE':
    case 'SERVER_ERROR':
      return 'request_rejected';
  }
}
