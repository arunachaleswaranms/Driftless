import {
  MAX_NEGOTIATIONS_PER_MEMBERSHIP,
  PEER_CONTROL_CHANNEL_LABEL,
  type InviteSecret,
  type NegotiationId,
  type ParticipantId,
  type ResumeChallenge,
  type ResumeSecret,
  type RoomId,
  type SessionId,
} from '@driftless/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  FAKE_PROOF,
  FakeDataChannel,
  FakePeerConnection,
  FakeTimers,
  FakeWebSocket,
  fakeProver,
  flush,
  peerMessage,
  remoteCandidate,
} from '../../test/room.ts';
import {
  HOST_RECOVERY_DELAY_MS,
  RECONNECT_DELAYS_MS,
  RESUME_ATTEMPT_TIMEOUT_MS,
} from './reconnectSchedule.ts';
import { RoomController, type RoomState } from './roomController.ts';
import { statusText } from './roomText.ts';

// AUTOMATED UNIT EVIDENCE with deterministic fakes. No real socket, peer
// connection, or timer is involved.

const ROOM_ID = `${'R'.repeat(21)}Q` as RoomId;
const SECRET = `${'S'.repeat(42)}E` as InviteSecret;
const HOST_ID = 'H'.repeat(16) as ParticipantId;
const GUEST_ID = 'G'.repeat(16) as ParticipantId;
const NEXT_GUEST_ID = 'K'.repeat(16) as ParticipantId;
const SESSION_ID = 'Q'.repeat(27) as SessionId;
const HOST_RESUME = 'h'.repeat(44) as ResumeSecret;
const GUEST_RESUME = 'g'.repeat(44) as ResumeSecret;
const CHALLENGE = 'c'.repeat(32) as ResumeChallenge;
const OTHER = 'X'.repeat(24) as NegotiationId;

function setup() {
  const sockets: FakeWebSocket[] = [];
  const connections: FakePeerConnection[] = [];
  const timers = new FakeTimers();
  const prover = fakeProver();
  let negotiations = 0;
  const controller = new RoomController({
    signalingUrl: { ok: true, url: 'ws://localhost:4173/v1/signaling' },
    iceServers: { ok: true, iceServers: [] },
    createWebSocket: (url) => {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket;
    },
    createPeerConnection: (configuration) => {
      const connection = new FakePeerConnection(configuration);
      connections.push(connection);
      return connection.asPeerConnection();
    },
    createNegotiationId: () => {
      negotiations += 1;
      return String(negotiations).padStart(24, 'N') as NegotiationId;
    },
    proveResume: prover.prove,
    clock: () => 0,
    timers,
  });
  const socket = () => {
    const current = sockets.at(-1);
    if (current === undefined) throw new Error('no socket');
    return current;
  };
  const connection = (index = -1) => {
    const current = connections.at(index);
    if (current === undefined) throw new Error('no connection');
    return current;
  };
  return { controller, sockets, connections, timers, prover, socket, connection };
}

type Harness = ReturnType<typeof setup>;

function inRoom(state: RoomState) {
  if (state.phase !== 'in-room') throw new Error(`expected in-room, got ${state.phase}`);
  return state;
}

function idOf(index: number): NegotiationId {
  return String(index).padStart(24, 'N') as NegotiationId;
}

async function hostInRoom(harness: Harness = setup()) {
  harness.controller.createRoom();
  harness.socket().open();
  await flush();
  harness.socket().deliver({
    type: 'ROOM_CREATED',
    payload: {
      roomId: ROOM_ID,
      sessionId: SESSION_ID,
      inviteSecret: SECRET,
      resumeSecret: HOST_RESUME,
      participantId: HOST_ID,
      role: 'host',
      expiresAt: 1,
    },
  });
  return harness;
}

async function guestJoins(harness: Harness, guestId = GUEST_ID) {
  harness.socket().deliver({
    type: 'ROOM_PARTICIPANT_JOINED',
    payload: { participant: { participantId: guestId, role: 'guest' } },
  });
  await flush();
  return harness;
}

/** Drives the host's current peer session to connected; returns its pieces. */
async function connectHostSession(harness: Harness, guestId = GUEST_ID) {
  const pc = harness.connection();
  await pc.settle('createOffer');
  await pc.settle('setLocalDescription');
  const sent = harness.socket().sent.at(-1);
  if (sent?.type !== 'RTC_OFFER' && sent?.type !== 'RTC_RECOVER') throw new Error('no offer');
  const { negotiationId } = sent.payload;
  harness.socket().deliver({ type: 'RTC_ANSWER', payload: { negotiationId, sdp: 'v=0\r\n' } });
  await flush();
  await pc.settle('setRemoteDescription');
  const channel = pc.channels[0];
  if (channel === undefined) throw new Error('no channel');
  channel.open();
  const fromGuest = {
    sessionId: SESSION_ID,
    negotiationId,
    senderId: guestId,
    recipientId: HOST_ID,
  };
  channel.receive(peerMessage('PEER_HELLO', fromGuest, 0));
  channel.receive(peerMessage('PEER_READY', fromGuest, 1));
  return { negotiationId, channel, pc, sent };
}

async function connectedHost() {
  const harness = await guestJoins(await hostInRoom());
  const session = await connectHostSession(harness);
  expect(inRoom(harness.controller.getState()).peer?.connection).toBe('connected');
  return { harness, ...session };
}

async function guestInRoom(harness: Harness = setup()) {
  harness.controller.joinRoom(ROOM_ID, SECRET);
  harness.socket().open();
  await flush();
  harness.socket().deliver({
    type: 'ROOM_JOINED',
    payload: {
      roomId: ROOM_ID,
      sessionId: SESSION_ID,
      resumeSecret: GUEST_RESUME,
      participantId: GUEST_ID,
      role: 'guest',
      peer: { participantId: HOST_ID, role: 'host' },
      expiresAt: 1,
    },
  });
  return harness;
}

/** Drives a guest session for `negotiationId` to connected after the given offer message. */
async function connectGuestSession(harness: Harness, negotiationId: NegotiationId) {
  const pc = harness.connection();
  await pc.settle('setRemoteDescription');
  await pc.settle('createAnswer');
  await pc.settle('setLocalDescription');
  const channel = new FakeDataChannel(PEER_CONTROL_CHANNEL_LABEL, { ordered: true });
  pc.announceChannel(channel);
  channel.open();
  const fromHost = {
    sessionId: SESSION_ID,
    negotiationId,
    senderId: HOST_ID,
    recipientId: GUEST_ID,
  };
  channel.receive(peerMessage('PEER_HELLO', fromHost, 0));
  channel.receive(peerMessage('PEER_READY', fromHost, 1));
  return { pc, channel };
}

async function connectedGuest() {
  const harness = await guestInRoom();
  const negotiationId = idOf(1);
  harness.socket().deliver({ type: 'RTC_OFFER', payload: { negotiationId, sdp: 'v=0\r\n' } });
  await flush();
  const session = await connectGuestSession(harness, negotiationId);
  expect(inRoom(harness.controller.getState()).peer?.connection).toBe('connected');
  return { harness, negotiationId, ...session };
}

/** Runs the due resume attempt: opens its socket and answers the challenge. */
async function attemptUntilProof(harness: Harness, delay = 0) {
  const before = harness.sockets.length;
  await harness.timers.advance(delay);
  expect(harness.sockets).toHaveLength(before + 1);
  const socket = harness.socket();
  socket.open();
  await flush();
  socket.deliver({ type: 'SESSION_RESUME_CHALLENGE', payload: { challenge: CHALLENGE } });
  await flush();
  return socket;
}

function resumedPayload(
  role: 'host' | 'guest',
  options: {
    peerSignaling?: 'CONNECTED' | 'RECONNECTING';
    activeNegotiationId?: NegotiationId | null;
    negotiationCount?: number;
    peerId?: ParticipantId | null;
  } = {},
) {
  const {
    peerSignaling = 'CONNECTED',
    activeNegotiationId = null,
    negotiationCount = activeNegotiationId === null ? 0 : 1,
  } = options;
  const common = {
    sessionId: SESSION_ID,
    roomId: ROOM_ID,
    expiresAt: 1,
    activeNegotiationId,
    negotiationCount,
  };
  if (role === 'host') {
    const peerId = options.peerId === undefined ? GUEST_ID : options.peerId;
    return {
      ...common,
      participantId: HOST_ID,
      role: 'host' as const,
      peer:
        peerId === null
          ? null
          : { participantId: peerId, role: 'guest' as const, signaling: peerSignaling },
    };
  }
  return {
    ...common,
    participantId: GUEST_ID,
    role: 'guest' as const,
    peer: { participantId: HOST_ID, role: 'host' as const, signaling: peerSignaling },
  };
}

describe('signaling reconnect with a working data channel', () => {
  it('keeps the peer session, authenticates by proof, and restores the same membership', async () => {
    const { harness, pc, channel, negotiationId } = await connectedHost();
    const first = harness.socket();
    first.drop();

    // The data channel stays up; signaling is reconnecting.
    const reconnecting = inRoom(harness.controller.getState());
    expect(reconnecting.signaling).toBe('reconnecting');
    expect(reconnecting.peer?.connection).toBe('connected');
    expect(statusText(reconnecting)).toBe(
      'Peer data channel connected. Signaling is reconnecting…',
    );
    expect(pc.closed).toBe(false);
    expect(channel.closed).toBe(false);
    // The first attempt is immediate, and only one schedule exists.
    expect(harness.timers.pendingDelays).toStrictEqual([0]);

    const second = await attemptUntilProof(harness);
    expect(second.sent.map((message) => [message.type, message.sequence])).toStrictEqual([
      ['SESSION_RESUME_BEGIN', 0],
      ['SESSION_RESUME_PROVE', 1],
    ]);
    expect(second.sentOfType('SESSION_RESUME_BEGIN')[0]?.payload).toStrictEqual({
      sessionId: SESSION_ID,
      participantId: HOST_ID,
    });
    expect(second.sentOfType('SESSION_RESUME_PROVE')[0]?.payload).toStrictEqual({
      challenge: CHALLENGE,
      proof: FAKE_PROOF,
    });
    expect(harness.prover.calls).toStrictEqual([CHALLENGE]);
    // The resume secret itself is never sent.
    expect(second.sentText.join('')).not.toContain(HOST_RESUME);

    second.deliver({
      type: 'SESSION_RESUMED',
      payload: resumedPayload('host', { activeNegotiationId: negotiationId }),
    });
    await flush();
    const restored = inRoom(harness.controller.getState());
    expect(restored).toMatchObject({
      role: 'host',
      participantId: HOST_ID,
      signaling: 'connected',
      notice: 'restored',
      peer: { participantId: GUEST_ID, connection: 'connected', signaling: 'connected' },
    });
    expect(statusText(restored)).toBe('Connection restored. Peer data channel is connected.');
    // The same peer connection and channel, with no new negotiation.
    expect(harness.connections).toHaveLength(1);
    expect(pc.closed).toBe(false);
    expect(pc.channels).toHaveLength(1);
    expect(second.sentOfType('RTC_OFFER')).toStrictEqual([]);
    expect(second.sentOfType('RTC_RECOVER')).toStrictEqual([]);
    expect(harness.timers.pendingCount).toBe(0);
  });

  it('resumes a guest the same way', async () => {
    const { harness, pc, negotiationId } = await connectedGuest();
    harness.socket().drop();
    const second = await attemptUntilProof(harness);
    expect(second.sentOfType('SESSION_RESUME_BEGIN')[0]?.payload.participantId).toBe(GUEST_ID);
    second.deliver({
      type: 'SESSION_RESUMED',
      payload: resumedPayload('guest', { activeNegotiationId: negotiationId }),
    });
    await flush();
    expect(inRoom(harness.controller.getState())).toMatchObject({
      role: 'guest',
      participantId: GUEST_ID,
      signaling: 'connected',
      peer: { connection: 'connected' },
    });
    expect(pc.closed).toBe(false);
    expect(second.sentOfType('RTC_RECOVERY_REQUEST')).toStrictEqual([]);
  });

  it('makes the old socket powerless once a new one carries the membership', async () => {
    const { harness, pc, negotiationId } = await connectedHost();
    const old = harness.socket();
    old.drop();
    const second = await attemptUntilProof(harness);
    second.deliver({
      type: 'SESSION_RESUMED',
      payload: resumedPayload('host', { activeNegotiationId: negotiationId }),
    });
    await flush();
    const state = harness.controller.getState();
    // Late messages on the old socket change nothing, and nothing is sent on it.
    old.deliver({ type: 'ROOM_CLOSED', payload: { reason: 'EXPIRED' } });
    old.deliver({
      type: 'ICE_CANDIDATE',
      payload: { negotiationId, candidate: remoteCandidate(3) },
    });
    expect(harness.controller.getState()).toBe(state);
    expect(pc.addedCandidates).toStrictEqual([]);
    const oldSent = old.sentText.length;
    harness.controller.leaveRoom();
    expect(old.sentText).toHaveLength(oldSent);
    expect(second.sent.at(-1)?.type).toBe('ROOM_LEAVE');
  });
});

describe('bounded reconnect schedule', () => {
  it('backs off after a failed attempt and succeeds on a later one', async () => {
    const { harness, negotiationId } = await connectedHost();
    harness.socket().drop();
    await harness.timers.advance(0);
    // The first attempt cannot open.
    harness.socket().drop();
    await flush();
    expect(harness.timers.pendingDelays).toStrictEqual([RECONNECT_DELAYS_MS[1]]);
    // The second is refused: the session is not available.
    const refused = await attemptUntilProof(harness, 250);
    refused.deliver({
      type: 'ERROR',
      payload: { code: 'SESSION_UNAVAILABLE', message: 'x', recoverable: true },
    });
    await flush();
    // Abandoned, not ended: the service holds the membership on this close code.
    expect(refused.closeCalls).toStrictEqual([4000]);
    expect(harness.timers.pendingDelays).toStrictEqual([RECONNECT_DELAYS_MS[2]]);
    // The third succeeds.
    const third = await attemptUntilProof(harness, 500);
    third.deliver({
      type: 'SESSION_RESUMED',
      payload: resumedPayload('host', { activeNegotiationId: negotiationId }),
    });
    await flush();
    expect(inRoom(harness.controller.getState()).signaling).toBe('connected');
    expect(harness.sockets).toHaveLength(4);
    expect(harness.timers.pendingCount).toBe(0);
  });

  it('abandons an attempt that gets no answer in time', async () => {
    const { harness } = await connectedHost();
    harness.socket().drop();
    await harness.timers.advance(0);
    const hung = harness.socket();
    hung.open();
    await flush();
    expect(hung.sent.map((message) => message.type)).toStrictEqual(['SESSION_RESUME_BEGIN']);
    await harness.timers.advance(RESUME_ATTEMPT_TIMEOUT_MS - 1);
    expect(hung.closeCalls).toStrictEqual([]);
    await harness.timers.advance(1);
    expect(hung.closeCalls).toStrictEqual([4000]);
    expect(harness.timers.pendingDelays).toStrictEqual([RECONNECT_DELAYS_MS[1]]);
  });

  it('gives up after the last attempt and ends the room safely', async () => {
    const { harness, pc, channel } = await connectedHost();
    harness.socket().drop();
    // Every attempt reaches the service, which no longer knows the session,
    // as after a service restart.
    for (const delay of RECONNECT_DELAYS_MS) {
      const socket = await attemptUntilProof(harness, delay);
      socket.deliver({
        type: 'ERROR',
        payload: { code: 'SESSION_UNAVAILABLE', message: 'x', recoverable: true },
      });
      await flush();
    }
    expect(harness.controller.getState()).toStrictEqual({
      phase: 'idle',
      notice: 'session_unrecoverable',
    });
    // The peer session is not trusted beyond its room: it is closed.
    expect(pc.closed).toBe(true);
    expect(channel.closed).toBe(true);
    expect(harness.sockets).toHaveLength(1 + RECONNECT_DELAYS_MS.length);
    expect(harness.timers.pendingCount).toBe(0);
    await harness.timers.advance(600_000);
    expect(harness.sockets).toHaveLength(1 + RECONNECT_DELAYS_MS.length);
  });

  it('cancels the schedule when the user leaves, and leaves at once', async () => {
    const { harness, pc } = await connectedHost();
    harness.socket().drop();
    await harness.timers.advance(0);
    const attempt = harness.socket();
    harness.controller.leaveRoom();
    expect(harness.controller.getState()).toStrictEqual({ phase: 'idle', notice: 'left' });
    expect(pc.closed).toBe(true);
    expect(attempt.closeCalls).toStrictEqual([1000]);
    expect(harness.timers.pendingCount).toBe(0);
    await harness.timers.advance(60_000);
    expect(harness.sockets).toHaveLength(2);
  });

  it('cancels the schedule on shutdown and on a room closed after resume', async () => {
    const first = await connectedHost();
    first.harness.socket().drop();
    first.harness.controller.shutdown();
    expect(first.harness.timers.pendingCount).toBe(0);
    await first.harness.timers.advance(60_000);
    expect(first.harness.sockets).toHaveLength(1);

    const second = await connectedHost();
    second.harness.socket().drop();
    const socket = await attemptUntilProof(second.harness);
    socket.deliver({
      type: 'SESSION_RESUMED',
      payload: resumedPayload('host', { activeNegotiationId: second.negotiationId }),
    });
    socket.deliver({ type: 'ROOM_CLOSED', payload: { reason: 'EXPIRED' } });
    await flush();
    expect(second.harness.controller.getState()).toStrictEqual({
      phase: 'idle',
      notice: 'room_expired',
    });
    expect(second.harness.timers.pendingCount).toBe(0);
  });

  it('does not resume after a policy closure or a protocol error', async () => {
    const policy = await connectedHost();
    policy.harness.socket().deliver({
      type: 'ERROR',
      payload: { code: 'RATE_LIMITED', message: 'x', recoverable: false },
    });
    policy.harness.socket().drop();
    expect(policy.harness.controller.getState()).toStrictEqual({
      phase: 'idle',
      notice: 'rate_limited',
    });
    expect(policy.harness.timers.pendingCount).toBe(0);

    const protocol = await connectedHost();
    protocol.harness.socket().deliverRaw('{"protocolVersion":1}');
    expect(protocol.harness.controller.getState()).toStrictEqual({
      phase: 'idle',
      notice: 'protocol_error',
    });
    expect(protocol.harness.timers.pendingCount).toBe(0);
  });

  it('ends the room if the snapshot does not describe this membership', async () => {
    const { harness } = await connectedHost();
    harness.socket().drop();
    const socket = await attemptUntilProof(harness);
    socket.deliver({
      type: 'SESSION_RESUMED',
      payload: { ...resumedPayload('host'), participantId: NEXT_GUEST_ID },
    });
    await flush();
    expect(harness.controller.getState()).toStrictEqual({
      phase: 'idle',
      notice: 'session_unrecoverable',
    });
  });

  it('persists nothing while reconnecting', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { harness, negotiationId } = await connectedHost();
    harness.socket().drop();
    const socket = await attemptUntilProof(harness);
    socket.deliver({
      type: 'SESSION_RESUMED',
      payload: resumedPayload('host', { activeNegotiationId: negotiationId }),
    });
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length + sessionStorage.length).toBe(0);
    expect(window.location.search + window.location.hash).toBe('');
  });
});

describe('reconciliation with the service snapshot', () => {
  it('closes a local session for another negotiation and converges on the active one', async () => {
    const { harness, pc, channel } = await connectedHost();
    harness.socket().drop();
    const socket = await attemptUntilProof(harness);
    // The service holds a different negotiation than the local session's.
    socket.deliver({
      type: 'SESSION_RESUMED',
      payload: resumedPayload('host', { activeNegotiationId: OTHER, negotiationCount: 2 }),
    });
    await flush();
    expect(pc.closed).toBe(true);
    expect(channel.closed).toBe(true);
    expect(harness.connections).toHaveLength(2);
    await harness.connection().settle('createOffer');
    await harness.connection().settle('setLocalDescription');
    expect(socket.sentOfType('RTC_RECOVER')[0]?.payload).toMatchObject({
      previousNegotiationId: OTHER,
      negotiationId: idOf(2),
    });
    // Late callbacks from the closed session change nothing.
    const state = harness.controller.getState();
    pc.setConnectionState('failed');
    channel.remoteClose();
    expect(harness.controller.getState()).toBe(state);
    expect(inRoom(state).peer?.connection).toBe('recovering');
  });

  it('abandons a negotiation interrupted by signaling loss and starts afresh', async () => {
    const harness = await guestJoins(await hostInRoom());
    const pc = harness.connection();
    await pc.settle('createOffer');
    await pc.settle('setLocalDescription');
    const offered = harness.socket().sentOfType('RTC_OFFER')[0]?.payload.negotiationId;
    harness.socket().drop();
    // The unfinished negotiation cannot complete without signaling.
    expect(pc.closed).toBe(true);
    expect(inRoom(harness.controller.getState()).peer?.connection).toBe('recovering');
    const socket = await attemptUntilProof(harness);
    socket.deliver({
      type: 'SESSION_RESUMED',
      payload: resumedPayload('host', { activeNegotiationId: offered ?? null }),
    });
    await flush();
    await harness.connection().settle('createOffer');
    await harness.connection().settle('setLocalDescription');
    expect(socket.sentOfType('RTC_RECOVER')[0]?.payload.previousNegotiationId).toBe(offered);
    // No old offer, answer, or candidate is replayed on the new socket.
    expect(socket.sentOfType('RTC_OFFER')).toStrictEqual([]);
    expect(socket.sentOfType('ICE_CANDIDATE')).toStrictEqual([]);
  });

  it('starts the first negotiation if the service never accepted an offer', async () => {
    const harness = await guestJoins(await hostInRoom());
    harness.socket().drop();
    const socket = await attemptUntilProof(harness);
    socket.deliver({ type: 'SESSION_RESUMED', payload: resumedPayload('host') });
    await flush();
    await harness.connection().settle('createOffer');
    await harness.connection().settle('setLocalDescription');
    expect(socket.sentOfType('RTC_OFFER')).toHaveLength(1);
  });

  it('records a peer failure during the outage and recovers only after resume', async () => {
    const { harness, pc, negotiationId } = await connectedHost();
    harness.socket().drop();
    pc.setConnectionState('failed');
    expect(inRoom(harness.controller.getState()).peer?.connection).toBe('recovering');
    // Nothing is created or queued while signaling is down.
    expect(harness.connections).toHaveLength(1);
    const socket = await attemptUntilProof(harness);
    socket.deliver({
      type: 'SESSION_RESUMED',
      payload: resumedPayload('host', { activeNegotiationId: negotiationId }),
    });
    await flush();
    expect(harness.connections).toHaveLength(2);
    await connectHostSession(harness);
    expect(socket.sentOfType('RTC_RECOVER')[0]?.payload.previousNegotiationId).toBe(negotiationId);
    expect(inRoom(harness.controller.getState())).toMatchObject({
      notice: 'restored',
      peer: { connection: 'connected' },
    });
  });

  it('waits for the other participant when the snapshot says it is reconnecting', async () => {
    const { harness, pc, negotiationId } = await connectedHost();
    harness.socket().drop();
    pc.setConnectionState('failed');
    const socket = await attemptUntilProof(harness);
    socket.deliver({
      type: 'SESSION_RESUMED',
      payload: resumedPayload('host', {
        activeNegotiationId: negotiationId,
        peerSignaling: 'RECONNECTING',
      }),
    });
    await flush();
    expect(harness.connections).toHaveLength(1);
    expect(statusText(harness.controller.getState())).toBe(
      'The other participant is reconnecting…',
    );
    socket.deliver({
      type: 'ROOM_PARTICIPANT_CONNECTION',
      payload: {
        participantId: GUEST_ID,
        signaling: 'CONNECTED',
        activeNegotiationId: negotiationId,
        negotiationCount: 1,
      },
    });
    await flush();
    expect(harness.connections).toHaveLength(2);
  });

  it('a guest that resumes after a newer negotiation closes its stale session', async () => {
    const { harness, pc, channel } = await connectedGuest();
    harness.socket().drop();
    const socket = await attemptUntilProof(harness);
    socket.deliver({
      type: 'SESSION_RESUMED',
      payload: resumedPayload('guest', { activeNegotiationId: OTHER, negotiationCount: 2 }),
    });
    await flush();
    expect(pc.closed).toBe(true);
    expect(socket.sentOfType('RTC_RECOVERY_REQUEST').map((m) => m.payload)).toStrictEqual([
      { negotiationId: OTHER },
    ]);
    const state = harness.controller.getState();
    channel.remoteClose();
    pc.setConnectionState('failed');
    expect(harness.controller.getState()).toBe(state);
    // The host's recovery of the active negotiation is accepted with a fresh session.
    const next = idOf(7);
    socket.deliver({
      type: 'RTC_RECOVER',
      payload: { previousNegotiationId: OTHER, negotiationId: next, sdp: 'v=0\r\n' },
    });
    await flush();
    expect(harness.connections).toHaveLength(2);
    await connectGuestSession(harness, next);
    expect(inRoom(harness.controller.getState()).peer?.connection).toBe('connected');
  });

  it('shows a host that its guest left while it was away, or a new guest', async () => {
    const away = await connectedHost();
    away.harness.socket().drop();
    const socket = await attemptUntilProof(away.harness);
    socket.deliver({ type: 'SESSION_RESUMED', payload: resumedPayload('host', { peerId: null }) });
    await flush();
    expect(away.pc.closed).toBe(true);
    const alone = inRoom(away.harness.controller.getState());
    expect(alone.peer).toBeNull();
    expect(statusText(alone)).toBe(
      'The guest is no longer in the room. Room created. Waiting for a guest to join.',
    );

    const replaced = await connectedHost();
    replaced.harness.socket().drop();
    const next = await attemptUntilProof(replaced.harness);
    next.deliver({
      type: 'SESSION_RESUMED',
      payload: resumedPayload('host', { peerId: NEXT_GUEST_ID }),
    });
    await flush();
    expect(replaced.pc.closed).toBe(true);
    expect(inRoom(replaced.harness.controller.getState()).peer?.participantId).toBe(NEXT_GUEST_ID);
    await replaced.harness.connection().settle('createOffer');
    await replaced.harness.connection().settle('setLocalDescription');
    expect(next.sentOfType('RTC_OFFER')).toHaveLength(1);
  });
});

describe('the other participant reconnecting', () => {
  it('keeps a working channel while the peer reconnects and announces the restore once', async () => {
    const { harness, pc, negotiationId } = await connectedHost();
    harness.socket().deliver({
      type: 'ROOM_PARTICIPANT_CONNECTION',
      payload: {
        participantId: GUEST_ID,
        signaling: 'RECONNECTING',
        activeNegotiationId: negotiationId,
        negotiationCount: 1,
      },
    });
    const away = inRoom(harness.controller.getState());
    expect(away.peer?.signaling).toBe('reconnecting');
    expect(statusText(away)).toBe(
      'Peer data channel connected. The other participant is reconnecting…',
    );
    harness.socket().deliver({
      type: 'ROOM_PARTICIPANT_CONNECTION',
      payload: {
        participantId: GUEST_ID,
        signaling: 'CONNECTED',
        activeNegotiationId: negotiationId,
        negotiationCount: 1,
      },
    });
    const back = inRoom(harness.controller.getState());
    expect(back.notice).toBe('restored');
    expect(pc.closed).toBe(false);
    expect(harness.connections).toHaveLength(1);
  });

  it('abandons an unfinished negotiation when the peer goes away and recovers on its return', async () => {
    const harness = await guestJoins(await hostInRoom());
    const pc = harness.connection();
    await pc.settle('createOffer');
    await pc.settle('setLocalDescription');
    harness.socket().deliver({
      type: 'ROOM_PARTICIPANT_CONNECTION',
      payload: {
        participantId: GUEST_ID,
        signaling: 'RECONNECTING',
        activeNegotiationId: idOf(1),
        negotiationCount: 1,
      },
    });
    expect(pc.closed).toBe(true);
    // A failure meanwhile triggers nothing: the peer cannot receive.
    expect(harness.connections).toHaveLength(1);
    harness.socket().deliver({
      type: 'ROOM_PARTICIPANT_CONNECTION',
      payload: {
        participantId: GUEST_ID,
        signaling: 'CONNECTED',
        activeNegotiationId: idOf(1),
        negotiationCount: 1,
      },
    });
    await flush();
    await connectHostSession(harness);
    expect(harness.socket().sentOfType('RTC_RECOVER')[0]?.payload).toMatchObject({
      previousNegotiationId: idOf(1),
      negotiationId: idOf(2),
    });
  });

  it('closes the room for a guest whose host did not return in time', async () => {
    const { harness, pc } = await connectedGuest();
    harness
      .socket()
      .deliver({ type: 'ROOM_CLOSED', payload: { reason: 'HOST_RECONNECT_TIMEOUT' } });
    expect(pc.closed).toBe(true);
    expect(statusText(harness.controller.getState())).toBe(
      'The host did not reconnect in time, so the room is closed. You are not in a room.',
    );
  });

  it('tells a host whose guest did not return in time', async () => {
    const { harness, pc } = await connectedHost();
    harness.socket().deliver({
      type: 'ROOM_PARTICIPANT_LEFT',
      payload: { participantId: GUEST_ID, reason: 'RECONNECT_TIMEOUT' },
    });
    expect(pc.closed).toBe(true);
    expect(statusText(harness.controller.getState())).toBe(
      'The guest did not reconnect in time. Room created. Waiting for a guest to join.',
    );
  });
});

describe('peer transport recovery', () => {
  it('host: replaces a failed session with a fresh connection, negotiation, and handshake', async () => {
    const { harness, pc, channel, negotiationId } = await connectedHost();
    pc.setConnectionState('failed');
    expect(pc.closed).toBe(true);
    expect(channel.closed).toBe(true);
    expect(statusText(harness.controller.getState())).toBe('Peer connection lost. Recovering…');
    // Unprompted, the host waits briefly before it offers.
    expect(harness.timers.pendingDelays).toStrictEqual([HOST_RECOVERY_DELAY_MS]);
    await harness.timers.advance(HOST_RECOVERY_DELAY_MS - 1);
    expect(harness.connections).toHaveLength(1);
    await harness.timers.advance(1);
    expect(harness.connections).toHaveLength(2);
    const recovered = await connectHostSession(harness);
    expect(recovered.sent).toMatchObject({
      type: 'RTC_RECOVER',
      payload: { previousNegotiationId: negotiationId, negotiationId: idOf(2) },
    });
    expect(recovered.pc).not.toBe(pc);
    expect(recovered.channel).not.toBe(channel);
    // The fresh handshake binds the same session and participants to the new negotiation.
    expect(recovered.channel.sent.map((message) => message.payload)).toStrictEqual([
      { sessionId: SESSION_ID, negotiationId: idOf(2), senderId: HOST_ID, recipientId: GUEST_ID },
      { sessionId: SESSION_ID, negotiationId: idOf(2), senderId: HOST_ID, recipientId: GUEST_ID },
    ]);
    const state = inRoom(harness.controller.getState());
    expect(state).toMatchObject({ participantId: HOST_ID, role: 'host', notice: 'restored' });
    expect(state.peer).toMatchObject({ participantId: GUEST_ID, connection: 'connected' });
    // The old negotiation's ICE and handshake are refused.
    harness.socket().deliver({
      type: 'ICE_CANDIDATE',
      payload: { negotiationId, candidate: remoteCandidate(9) },
    });
    expect(recovered.pc.addedCandidates).toStrictEqual([]);
    channel.receive(
      peerMessage(
        'PEER_HELLO',
        { sessionId: SESSION_ID, negotiationId, senderId: GUEST_ID, recipientId: HOST_ID },
        5,
      ),
    );
    expect(harness.controller.getState()).toBe(state);
  });

  it('host: an offer that never left is not treated as the service’s negotiation', async () => {
    const harness = await guestJoins(await hostInRoom());
    // The first offer fails locally, before anything is sent.
    await harness.connection().settle('createOffer', 'reject');
    await harness.timers.advance(HOST_RECOVERY_DELAY_MS);
    expect(harness.connections).toHaveLength(2);
    await connectHostSession(harness);
    // The service holds no negotiation yet, so this is a first offer.
    expect(harness.socket().sentOfType('RTC_RECOVER')).toStrictEqual([]);
    expect(
      harness
        .socket()
        .sentOfType('RTC_OFFER')
        .map((m) => m.payload.negotiationId),
    ).toStrictEqual([idOf(2)]);

    // A recovery that fails locally names the negotiation the service holds.
    harness.connection().setConnectionState('failed');
    await harness.timers.advance(HOST_RECOVERY_DELAY_MS);
    await harness.connection().settle('createOffer', 'reject');
    await harness.timers.advance(HOST_RECOVERY_DELAY_MS);
    await connectHostSession(harness);
    expect(
      harness
        .socket()
        .sentOfType('RTC_RECOVER')
        .map((m) => m.payload),
    ).toMatchObject([{ previousNegotiationId: idOf(2), negotiationId: idOf(4) }]);
  });

  it('host: local offer failures still use up the negotiation budget', async () => {
    const harness = await guestJoins(await hostInRoom());
    for (let index = 0; index < MAX_NEGOTIATIONS_PER_MEMBERSHIP; index += 1) {
      await harness.connection().settle('createOffer', 'reject');
      await harness.timers.advance(HOST_RECOVERY_DELAY_MS);
    }
    await harness.timers.advance(HOST_RECOVERY_DELAY_MS * 10);
    expect(harness.connections).toHaveLength(MAX_NEGOTIATIONS_PER_MEMBERSHIP);
    expect(inRoom(harness.controller.getState()).peer?.connection).toBe('failed');
    expect(harness.timers.pendingCount).toBe(0);
  });

  it('host: a guest that leaves during the wait gets no recovery negotiation', async () => {
    const { harness, pc } = await connectedHost();
    pc.setConnectionState('failed');
    harness.socket().deliver({
      type: 'ROOM_PARTICIPANT_LEFT',
      payload: { participantId: GUEST_ID, reason: 'LEFT' },
    });
    expect(harness.timers.pendingCount).toBe(0);
    await harness.timers.advance(HOST_RECOVERY_DELAY_MS * 10);
    expect(harness.connections).toHaveLength(1);
    expect(harness.socket().sentOfType('RTC_RECOVER')).toStrictEqual([]);
  });

  it('host: a guest request during the wait starts recovery at once, and only once', async () => {
    const { harness, pc, negotiationId } = await connectedHost();
    pc.setConnectionState('failed');
    harness.socket().deliver({ type: 'RTC_RECOVERY_REQUEST', payload: { negotiationId } });
    expect(harness.connections).toHaveLength(2);
    expect(harness.timers.pendingCount).toBe(0);
    await harness.timers.advance(HOST_RECOVERY_DELAY_MS * 10);
    expect(harness.connections).toHaveLength(2);
  });

  it('host: a guest request replaces even a session that still looks connected', async () => {
    const { harness, pc, negotiationId } = await connectedHost();
    harness.socket().deliver({ type: 'RTC_RECOVERY_REQUEST', payload: { negotiationId: OTHER } });
    expect(pc.closed).toBe(false);
    harness.socket().deliver({ type: 'RTC_RECOVERY_REQUEST', payload: { negotiationId } });
    expect(pc.closed).toBe(true);
    await connectHostSession(harness);
    expect(harness.socket().sentOfType('RTC_RECOVER')).toHaveLength(1);
  });

  it('guest: requests recovery once, then accepts only the matching recovery offer', async () => {
    const { harness, pc, channel, negotiationId } = await connectedGuest();
    channel.remoteClose();
    expect(pc.closed).toBe(true);
    expect(
      harness
        .socket()
        .sentOfType('RTC_RECOVERY_REQUEST')
        .map((m) => m.payload),
    ).toStrictEqual([{ negotiationId }]);
    // A recovery offer naming another negotiation is ignored.
    harness.socket().deliver({
      type: 'RTC_RECOVER',
      payload: { previousNegotiationId: OTHER, negotiationId: idOf(5), sdp: 'v=0\r\n' },
    });
    await flush();
    expect(harness.connections).toHaveLength(1);
    harness.socket().deliver({
      type: 'RTC_RECOVER',
      payload: { previousNegotiationId: negotiationId, negotiationId: idOf(2), sdp: 'v=0\r\n' },
    });
    await flush();
    expect(harness.connections).toHaveLength(2);
    const { channel: fresh } = await connectGuestSession(harness, idOf(2));
    expect(harness.socket().sentOfType('RTC_ANSWER').at(-1)?.payload.negotiationId).toBe(idOf(2));
    expect(fresh).not.toBe(channel);
    expect(inRoom(harness.controller.getState())).toMatchObject({
      participantId: GUEST_ID,
      notice: 'restored',
      peer: { participantId: HOST_ID, connection: 'connected' },
    });
    expect(harness.socket().sentOfType('RTC_RECOVERY_REQUEST')).toHaveLength(1);
  });

  it('guest: asks again when the host returns, since an earlier request may never have arrived', async () => {
    const { harness, channel, negotiationId } = await connectedGuest();
    channel.remoteClose();
    harness.socket().deliver({
      type: 'ROOM_PARTICIPANT_CONNECTION',
      payload: {
        participantId: HOST_ID,
        signaling: 'RECONNECTING',
        activeNegotiationId: negotiationId,
        negotiationCount: 1,
      },
    });
    expect(harness.socket().sentOfType('RTC_RECOVERY_REQUEST')).toHaveLength(1);
    harness.socket().deliver({
      type: 'ROOM_PARTICIPANT_CONNECTION',
      payload: {
        participantId: HOST_ID,
        signaling: 'CONNECTED',
        activeNegotiationId: negotiationId,
        negotiationCount: 1,
      },
    });
    expect(
      harness
        .socket()
        .sentOfType('RTC_RECOVERY_REQUEST')
        .map((m) => m.payload),
    ).toStrictEqual([{ negotiationId }, { negotiationId }]);
  });

  it(`host: stops at ${String(MAX_NEGOTIATIONS_PER_MEMBERSHIP)} negotiations and lets the user leave`, async () => {
    const { harness } = await connectedHost();
    for (let index = 2; index <= MAX_NEGOTIATIONS_PER_MEMBERSHIP; index += 1) {
      harness.connection().setConnectionState('failed');
      await harness.timers.advance(HOST_RECOVERY_DELAY_MS);
      await connectHostSession(harness);
    }
    expect(harness.connections).toHaveLength(MAX_NEGOTIATIONS_PER_MEMBERSHIP);
    harness.connection().setConnectionState('failed');
    await harness.timers.advance(HOST_RECOVERY_DELAY_MS * 10);
    // No fifth negotiation, no loop, a safe failed state.
    expect(harness.connections).toHaveLength(MAX_NEGOTIATIONS_PER_MEMBERSHIP);
    const failed = inRoom(harness.controller.getState());
    expect(failed.peer?.connection).toBe('failed');
    expect(statusText(failed)).toBe('The peer connection to the guest could not be recovered.');
    const offers = [
      ...harness.socket().sentOfType('RTC_OFFER'),
      ...harness.socket().sentOfType('RTC_RECOVER'),
    ];
    expect(new Set(offers.map((m) => m.payload.negotiationId)).size).toBe(
      MAX_NEGOTIATIONS_PER_MEMBERSHIP,
    );
    harness.controller.leaveRoom();
    expect(harness.socket().sent.at(-1)?.type).toBe('ROOM_LEAVE');
  });

  it(`guest: does not ask again once ${String(MAX_NEGOTIATIONS_PER_MEMBERSHIP)} negotiations are used`, async () => {
    const { harness, negotiationId } = await connectedGuest();
    let previous = negotiationId;
    for (let index = 2; index <= MAX_NEGOTIATIONS_PER_MEMBERSHIP; index += 1) {
      harness.connection().setConnectionState('failed');
      harness.socket().deliver({
        type: 'RTC_RECOVER',
        payload: { previousNegotiationId: previous, negotiationId: idOf(index), sdp: 'v=0\r\n' },
      });
      await flush();
      await connectGuestSession(harness, idOf(index));
      previous = idOf(index);
    }
    const requests = harness.socket().sentOfType('RTC_RECOVERY_REQUEST').length;
    harness.connection().setConnectionState('failed');
    expect(harness.socket().sentOfType('RTC_RECOVERY_REQUEST')).toHaveLength(requests);
    expect(inRoom(harness.controller.getState()).peer?.connection).toBe('failed');
    // A further recovery offer would exceed the bound and is not accepted.
    harness.socket().deliver({
      type: 'RTC_RECOVER',
      payload: { previousNegotiationId: previous, negotiationId: idOf(9), sdp: 'v=0\r\n' },
    });
    await flush();
    expect(harness.connections).toHaveLength(MAX_NEGOTIATIONS_PER_MEMBERSHIP);
  });
});
