import {
  type ApplicationBody,
  type MediaFingerprint,
  type MediaSelectionId,
  PEER_CONTROL_CHANNEL_LABEL,
  type InviteSecret,
  type NegotiationId,
  type ParticipantId,
  type ResumeSecret,
  type RoomId,
  type SessionId,
} from '@driftless/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  FakeDataChannel,
  FakePeerConnection,
  FakeTimers,
  FakeWebSocket,
  fakeProver,
  flush,
  peerMessage,
  remoteCandidate,
} from '../../test/room.ts';
import type { IceServersResult } from './iceServers.ts';
import { RoomController, type RoomState } from './roomController.ts';
import type { SignalingUrlResult } from './signalingUrl.ts';
import { PEER_APPLICATION_RATE_BURST } from './peerSession.ts';
import { HOST_RECOVERY_DELAY_MS } from './reconnectSchedule.ts';

const ROOM_ID = `${'R'.repeat(21)}Q` as RoomId;
const OTHER_ROOM_ID = `${'Z'.repeat(21)}Q` as RoomId;
const SECRET = `${'S'.repeat(42)}E` as InviteSecret;
const HOST_ID = 'H'.repeat(16) as ParticipantId;
const GUEST_ID = 'G'.repeat(16) as ParticipantId;
const NEXT_GUEST_ID = 'K'.repeat(16) as ParticipantId;
const SESSION_ID = 'Q'.repeat(27) as SessionId;
const OTHER_SESSION_ID = 'W'.repeat(26).concat('A') as SessionId;
const HOST_RESUME = 'h'.repeat(44) as ResumeSecret;
const GUEST_RESUME = 'g'.repeat(44) as ResumeSecret;

function setup(options: { signalingUrl?: SignalingUrlResult; iceServers?: IceServersResult } = {}) {
  const sockets: FakeWebSocket[] = [];
  const connections: FakePeerConnection[] = [];
  const timers = new FakeTimers();
  const prover = fakeProver();
  let negotiations = 0;
  const controller = new RoomController({
    signalingUrl: options.signalingUrl ?? { ok: true, url: 'ws://localhost:4173/v1/signaling' },
    iceServers: options.iceServers ?? { ok: true, iceServers: [] },
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
  const states: RoomState[] = [];
  controller.subscribe(() => states.push(controller.getState()));
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
  return { controller, sockets, connections, states, socket, connection, timers, prover };
}

type Harness = ReturnType<typeof setup>;

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

async function guestJoins(harness: Harness, guestId: ParticipantId = GUEST_ID) {
  harness.socket().deliver({
    type: 'ROOM_PARTICIPANT_JOINED',
    payload: { participant: { participantId: guestId, role: 'guest' } },
  });
  await flush();
  return harness;
}

/** Drives a host's peer session to connected through its fakes. */
async function connectHost(harness: Harness, guestId: ParticipantId = GUEST_ID) {
  const pc = harness.connection();
  await pc.settle('createOffer');
  await pc.settle('setLocalDescription');
  const offer = harness.socket().sent.at(-1);
  if (offer?.type !== 'RTC_OFFER' && offer?.type !== 'RTC_RECOVER') throw new Error('no offer');
  const { negotiationId } = offer.payload;
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
  return { negotiationId, channel, pc };
}

async function guestInRoom(harness: Harness = setup()) {
  harness.controller.joinRoom(` ${ROOM_ID} `, ` ${SECRET} `);
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

function inRoom(state: RoomState) {
  if (state.phase !== 'in-room') throw new Error(`expected in-room, got ${state.phase}`);
  return state;
}

describe('peer application flooding and Local Sync recovery', () => {
  it('uses normal fresh-peer recovery, clears remote readiness, and reannounces retained identity', async () => {
    const h = await hostInRoom();
    await guestJoins(h);
    const old = await connectHost(h);
    const sync = h.controller.localSync;
    const localSelectionId = 'A'.repeat(22) as MediaSelectionId;
    const remoteSelectionId = ('B'.repeat(21) + 'A') as MediaSelectionId;
    const fingerprint = 'A'.repeat(43) as MediaFingerprint;
    sync.dispatch({ type: 'select', selectionId: localSelectionId, byteLength: 1 });
    sync.dispatch({ type: 'playback', selectionId: localSelectionId, status: 'ready' });
    sync.dispatch({ type: 'fingerprint', selectionId: localSelectionId, fingerprint });
    const info: ApplicationBody = {
      type: 'MEDIA_INFO',
      payload: {
        selectionId: remoteSelectionId,
        fingerprintVersion: 1,
        fingerprint,
        byteLength: 1,
      },
    };
    const match: ApplicationBody = {
      type: 'MEDIA_MATCH',
      payload: {
        localSelectionId: remoteSelectionId,
        remoteSelectionId: localSelectionId,
        fingerprint,
      },
    };
    const readyBody: ApplicationBody = { type: 'READY', payload: match.payload };
    const deliver = (peer: typeof old, body: ApplicationBody, sequence: number) => {
      peer.channel.receive(
        JSON.stringify({
          protocolVersion: 1,
          type: body.type,
          sequence,
          sentAt: 0,
          payload: {
            ...body.payload,
            sessionId: SESSION_ID,
            negotiationId: peer.negotiationId,
            senderId: GUEST_ID,
            recipientId: HOST_ID,
          },
        }),
      );
    };
    const receive = vi.spyOn(sync, 'receive');
    deliver(old, info, 2);
    deliver(old, match, 3);
    sync.dispatch({ type: 'ready' });
    deliver(old, readyBody, 4);
    const local = sync.getState().local;
    expect(sync.getState()).toMatchObject({
      connected: true,
      peerMatched: true,
      localReady: true,
      remoteReady: true,
    });
    for (let i = 3; i < PEER_APPLICATION_RATE_BURST; i++) deliver(old, readyBody, i + 2);
    expect(sync.getState().localReady).toBe(true);
    expect(sync.getState().remoteReady).toBe(true);
    expect(receive).toHaveBeenCalledTimes(PEER_APPLICATION_RATE_BURST);
    const sent = old.channel.sent.length;
    deliver(old, readyBody, PEER_APPLICATION_RATE_BURST + 2);
    expect(receive).toHaveBeenCalledTimes(PEER_APPLICATION_RATE_BURST);
    expect(old.channel.sent).toHaveLength(sent);
    expect(old.channel.closed).toBe(true);
    expect(old.pc.closed).toBe(true);
    expect(inRoom(h.controller.getState()).peer).toMatchObject({
      connection: 'recovering',
      failure: 'application_rate_limit',
    });
    expect(sync.getState()).toEqual({
      connected: false,
      local,
      remote: null,
      peerMatched: false,
      localReady: false,
      remoteReady: false,
    });
    expect(h.connections).toHaveLength(1);
    expect(h.timers.pendingDelays).toEqual([HOST_RECOVERY_DELAY_MS]);
    await h.timers.advance(HOST_RECOVERY_DELAY_MS);
    const fresh = await connectHost(h);
    expect(h.connections).toHaveLength(2);
    expect(fresh.negotiationId).not.toBe(old.negotiationId);
    expect(h.socket().sentOfType('RTC_RECOVER')[0]?.payload.previousNegotiationId).toBe(
      old.negotiationId,
    );
    expect(fresh.channel.sent.map((m) => m.type)).toEqual([
      'PEER_HELLO',
      'PEER_READY',
      'MEDIA_INFO',
    ]);
    expect(fresh.channel.sent[2]?.payload).toMatchObject({
      selectionId: localSelectionId,
      fingerprint,
      byteLength: 1,
      negotiationId: fresh.negotiationId,
    });
    expect(sync.getState().local).toBe(local);
    deliver(fresh, info, 2);
    deliver(fresh, match, 3);
    expect(sync.getState()).toMatchObject({
      connected: true,
      peerMatched: true,
      localReady: false,
      remoteReady: false,
    });
    sync.dispatch({ type: 'ready' });
    deliver(fresh, readyBody, 4);
    expect(sync.getState()).toMatchObject({ localReady: true, remoteReady: true });
    h.controller.leaveRoom();
    receive.mockRestore();
  });
});

describe('room entry', () => {
  it('opens no socket until the user acts', () => {
    const { sockets, connections } = setup();
    expect(sockets).toHaveLength(0);
    expect(connections).toHaveLength(0);
  });

  it('creates a room and holds the invite in memory for the host', async () => {
    const { controller, socket, connections } = await hostInRoom();
    expect(socket().url).toBe('ws://localhost:4173/v1/signaling');
    expect(socket().sent.map((message) => message.type)).toStrictEqual(['ROOM_CREATE']);
    expect(controller.getState()).toStrictEqual({
      phase: 'in-room',
      role: 'host',
      roomId: ROOM_ID,
      inviteSecret: SECRET,
      participantId: HOST_ID,
      signaling: 'connected',
      peer: null,
      notice: null,
    });
    // The resume secret never enters the rendered state.
    expect(JSON.stringify(controller.getState())).not.toContain(HOST_RESUME);
    // Waiting for a guest creates no peer connection.
    expect(connections).toHaveLength(0);
  });

  it('joins with trimmed, validated details and waits for the offer', async () => {
    const { controller, socket, connections } = await guestInRoom();
    expect(socket().sentOfType('ROOM_JOIN')[0]?.payload).toStrictEqual({
      roomId: ROOM_ID,
      inviteSecret: SECRET,
    });
    const state = inRoom(controller.getState());
    expect(state.role).toBe('guest');
    expect(state.peer).toStrictEqual({
      participantId: HOST_ID,
      signaling: 'connected',
      connection: 'negotiating',
      failure: null,
    });
    expect('inviteSecret' in state).toBe(false);
    expect(JSON.stringify(state)).not.toContain(GUEST_RESUME);
    expect(connections).toHaveLength(0);
  });

  it('refuses malformed join details without any request', () => {
    const { controller, sockets } = setup();
    controller.joinRoom('room', SECRET);
    expect(controller.getState()).toStrictEqual({ phase: 'idle', notice: 'invalid_join_details' });
    controller.joinRoom(ROOM_ID, 'secret');
    controller.joinRoom(SECRET, ROOM_ID);
    expect(sockets).toHaveLength(0);
  });

  it.each([
    ['ROOM_UNAVAILABLE', 'room_unavailable'],
    ['ROOM_FULL', 'room_full'],
    ['INVALID_STATE', 'request_rejected'],
  ] as const)(
    'maps a refused join (%s) to a sanitized notice and creates no peer',
    async (code, notice) => {
      const { controller, socket, connections } = setup();
      controller.joinRoom(ROOM_ID, SECRET);
      socket().open();
      await flush();
      socket().deliver({ type: 'ERROR', payload: { code, message: 'x', recoverable: true } });
      expect(controller.getState()).toStrictEqual({ phase: 'idle', notice });
      expect(connections).toHaveLength(0);
    },
  );

  it('reports configuration problems without opening anything', () => {
    const insecure = setup({ signalingUrl: { ok: false, reason: 'insecure_origin' } });
    insecure.controller.createRoom();
    expect(insecure.controller.getState()).toStrictEqual({
      phase: 'idle',
      notice: 'insecure_origin',
    });
    expect(insecure.sockets).toHaveLength(0);

    const badIce = setup({ iceServers: { ok: false, reason: 'invalid_ice_config' } });
    badIce.controller.joinRoom(ROOM_ID, SECRET);
    expect(badIce.controller.getState()).toStrictEqual({
      phase: 'idle',
      notice: 'invalid_ice_config',
    });
    expect(badIce.sockets).toHaveLength(0);
  });

  it('reports a socket that cannot be opened', async () => {
    const { controller, socket } = setup();
    controller.createRoom();
    socket().drop();
    await flush();
    expect(controller.getState()).toStrictEqual({ phase: 'idle', notice: 'connect_failed' });
  });

  it('abandons a pending request on cancel and ignores its late reply', async () => {
    const { controller, socket } = setup();
    controller.createRoom();
    const first = socket();
    controller.leaveRoom();
    expect(controller.getState()).toStrictEqual({ phase: 'idle', notice: null });
    first.open();
    await flush();
    expect(first.sentText).toStrictEqual([]);
    expect(first.closeCalls).toStrictEqual([1000]);
  });
});

describe('host negotiation', () => {
  it('starts one negotiation when a guest joins, with the configured ICE servers', async () => {
    const harness = setup({ iceServers: { ok: true, iceServers: [{ urls: ['stun:s.example'] }] } });
    await hostInRoom(harness);
    await guestJoins(harness);
    expect(harness.connections).toHaveLength(1);
    expect(harness.connection().configuration).toStrictEqual({
      iceServers: [{ urls: ['stun:s.example'] }],
    });
    expect(inRoom(harness.controller.getState()).peer?.connection).toBe('negotiating');
    const { negotiationId } = await connectHost(harness);
    expect(negotiationId).toBe('NNNNNNNNNNNNNNNNNNNNNNN1');
    expect(inRoom(harness.controller.getState()).peer).toStrictEqual({
      participantId: GUEST_ID,
      signaling: 'connected',
      connection: 'connected',
      failure: null,
    });
    // Signaling sequences keep increasing across room and negotiation messages.
    const sequences = harness.socket().sent.map((message) => message.sequence);
    expect(sequences).toStrictEqual(sequences.map((_, index) => index));
  });

  it('returns to waiting when the guest leaves and tears the peer down', async () => {
    const harness = await guestJoins(await hostInRoom());
    const { pc, channel } = await connectHost(harness);
    harness.socket().deliver({
      type: 'ROOM_PARTICIPANT_LEFT',
      payload: { participantId: GUEST_ID, reason: 'LEFT' },
    });
    expect(pc.closed).toBe(true);
    expect(channel.closed).toBe(true);
    const state = inRoom(harness.controller.getState());
    expect(state.peer).toBeNull();
    expect(state.role === 'host' && state.notice).toBe('guest_left');
  });

  it('ignores signaling for a negotiation that is not current', async () => {
    const harness = await guestJoins(await hostInRoom());
    harness.socket().deliver({
      type: 'RTC_ANSWER',
      payload: { negotiationId: 'X'.repeat(24) as NegotiationId, sdp: 'v=0\r\n' },
    });
    harness.socket().deliver({
      type: 'ICE_CANDIDATE',
      payload: { negotiationId: 'X'.repeat(24) as NegotiationId, candidate: remoteCandidate(1) },
    });
    await flush();
    expect(harness.connection().remoteDescriptions).toStrictEqual([]);
    expect(harness.connection().addedCandidates).toStrictEqual([]);
    // A host never accepts an offer.
    harness.socket().deliver({
      type: 'RTC_OFFER',
      payload: { negotiationId: 'X'.repeat(24) as NegotiationId, sdp: 'v=0\r\n' },
    });
    expect(harness.connections).toHaveLength(1);
  });

  it('treats a stale negotiation refusal as harmless', async () => {
    const harness = await guestJoins(await hostInRoom());
    const before = harness.controller.getState();
    harness.socket().deliver({
      type: 'ERROR',
      payload: { code: 'INVALID_STATE', message: 'x', recoverable: true },
    });
    expect(harness.controller.getState()).toBe(before);
  });
});

describe('guest negotiation', () => {
  it('accepts one offer, queues early candidates, and answers', async () => {
    const harness = await guestInRoom();
    const negotiationId = '1'.repeat(24) as NegotiationId;
    harness.socket().deliver({ type: 'RTC_OFFER', payload: { negotiationId, sdp: 'v=0\r\n' } });
    harness.socket().deliver({
      type: 'ICE_CANDIDATE',
      payload: { negotiationId, candidate: remoteCandidate(1) },
    });
    // A second offer is never accepted.
    harness.socket().deliver({
      type: 'RTC_OFFER',
      payload: { negotiationId: '2'.repeat(24) as NegotiationId, sdp: 'v=0\r\n' },
    });
    await flush();
    expect(harness.connections).toHaveLength(1);
    const pc = harness.connection();
    expect(pc.addedCandidates).toStrictEqual([]);
    await pc.settle('setRemoteDescription');
    expect(pc.addedCandidates).toStrictEqual([remoteCandidate(1)]);
    await pc.settle('createAnswer');
    await pc.settle('setLocalDescription');
    expect(harness.socket().sentOfType('RTC_ANSWER')[0]?.payload.negotiationId).toBe(negotiationId);
    expect(inRoom(harness.controller.getState()).peer?.connection).toBe('connecting');

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
    expect(inRoom(harness.controller.getState()).peer?.connection).toBe('connected');
  });

  it('asks the host for a fresh negotiation when its peer fails, and accepts no plain re-offer', async () => {
    const harness = await guestInRoom();
    const negotiationId = '1'.repeat(24) as NegotiationId;
    harness.socket().deliver({ type: 'RTC_OFFER', payload: { negotiationId, sdp: 'v=0\r\n' } });
    await flush();
    harness.connection().setConnectionState('failed');
    expect(inRoom(harness.controller.getState()).peer).toStrictEqual({
      participantId: HOST_ID,
      signaling: 'connected',
      connection: 'recovering',
      failure: 'connection_failed',
    });
    expect(
      harness
        .socket()
        .sentOfType('RTC_RECOVERY_REQUEST')
        .map((m) => m.payload),
    ).toStrictEqual([{ negotiationId }]);
    // A second plain offer is never accepted; only a recovery offer is.
    harness.socket().deliver({
      type: 'RTC_OFFER',
      payload: { negotiationId: '2'.repeat(24) as NegotiationId, sdp: 'v=0\r\n' },
    });
    await flush();
    expect(harness.connections).toHaveLength(1);
    expect(harness.sockets).toHaveLength(1);
  });

  it('closes everything when the host closes the room', async () => {
    const harness = await guestInRoom();
    harness.socket().deliver({
      type: 'RTC_OFFER',
      payload: { negotiationId: '1'.repeat(24) as NegotiationId, sdp: 'v=0\r\n' },
    });
    await flush();
    harness.socket().deliver({ type: 'ROOM_CLOSED', payload: { reason: 'HOST_LEFT' } });
    expect(harness.connection().closed).toBe(true);
    expect(harness.controller.getState()).toStrictEqual({ phase: 'idle', notice: 'host_left' });
  });
});

describe('stale asynchronous events', () => {
  it('room A negotiation → leave → room B → late events from A change nothing', async () => {
    const harness = await guestJoins(await hostInRoom());
    const roomA = harness.connection();
    const channelA = roomA.channels[0];
    await roomA.settle('createOffer');

    harness.controller.leaveRoom();
    harness.socket().deliver({ type: 'ROOM_LEFT', payload: {} });
    expect(harness.controller.getState()).toStrictEqual({ phase: 'idle', notice: 'left' });
    expect(roomA.closed).toBe(true);

    // Room B on the same socket.
    harness.controller.createRoom();
    await flush();
    harness.socket().deliver({
      type: 'ROOM_CREATED',
      payload: {
        roomId: OTHER_ROOM_ID,
        sessionId: OTHER_SESSION_ID,
        inviteSecret: SECRET,
        resumeSecret: HOST_RESUME,
        participantId: HOST_ID,
        role: 'host',
        expiresAt: 1,
      },
    });
    const roomB = harness.controller.getState();
    const sentBefore = harness.socket().sentText.length;

    // Late events from room A's session: its description resolves, its
    // channel opens, and its connection reports changes.
    await roomA.settle('setLocalDescription');
    channelA?.open();
    roomA.setConnectionState('failed');
    roomA.emitCandidate({ candidate: 'candidate:1 1 udp 1 a.local 1 typ host', sdpMid: '0' });
    // And stale signaling naming room A's negotiation.
    harness.socket().deliver({
      type: 'RTC_ANSWER',
      payload: { negotiationId: 'NNNNNNNNNNNNNNNNNNNNNNN1' as NegotiationId, sdp: 'v=0\r\n' },
    });
    await flush();
    expect(harness.controller.getState()).toBe(roomB);
    expect(harness.socket().sentText).toHaveLength(sentBefore);
    expect(channelA?.sentText).toStrictEqual([]);
  });

  it('guest A → leaves → guest B joins → late callbacks from A change nothing', async () => {
    const harness = await guestJoins(await hostInRoom());
    const sessionA = await connectHost(harness);
    harness.socket().deliver({
      type: 'ROOM_PARTICIPANT_LEFT',
      payload: { participantId: GUEST_ID, reason: 'DISCONNECTED' },
    });
    await guestJoins(harness, NEXT_GUEST_ID);
    expect(harness.connections).toHaveLength(2);
    const sessionB = harness.connection();
    expect(sessionB).not.toBe(sessionA.pc);
    // Only guest A's offer has been sent so far.
    expect(harness.socket().sentOfType('RTC_OFFER')).toHaveLength(1);
    await sessionB.settle('createOffer');
    await sessionB.settle('setLocalDescription');
    const negotiationB = harness.socket().sentOfType('RTC_OFFER')[1]?.payload.negotiationId;
    expect(negotiationB).toBe('NNNNNNNNNNNNNNNNNNNNNNN2');
    expect(negotiationB).not.toBe(sessionA.negotiationId);
    const stateB = harness.controller.getState();

    // Guest A's old connection and channel fire late.
    sessionA.pc.setConnectionState('failed');
    sessionA.channel.remoteClose();
    sessionA.pc.emitCandidate({ candidate: 'candidate:9 1 udp 1 a.local 1 typ host', sdpMid: '0' });
    // Late signaling for A's negotiation reaches B's session nowhere.
    harness.socket().deliver({
      type: 'ICE_CANDIDATE',
      payload: { negotiationId: sessionA.negotiationId, candidate: remoteCandidate(1) },
    });
    harness.socket().deliver({
      type: 'RTC_ANSWER',
      payload: { negotiationId: sessionA.negotiationId, sdp: 'v=0\r\n' },
    });
    await flush();
    expect(harness.controller.getState()).toBe(stateB);
    expect(sessionB.addedCandidates).toStrictEqual([]);
    expect(sessionB.remoteDescriptions).toStrictEqual([]);
    expect(inRoom(stateB).peer?.participantId).toBe(NEXT_GUEST_ID);
  });

  it('ignores late events from a dropped socket after a new one is opened', async () => {
    const harness = await hostInRoom();
    const first = harness.socket();
    first.drop();
    expect(inRoom(harness.controller.getState()).signaling).toBe('reconnecting');
    await harness.timers.advance(0);
    const second = harness.socket();
    expect(second).not.toBe(first);
    const before = harness.controller.getState();
    first.deliver({ type: 'ROOM_CLOSED', payload: { reason: 'EXPIRED' } });
    expect(harness.controller.getState()).toBe(before);
  });
});

describe('leave, disconnect, and cleanup', () => {
  it('leaves, releases the secret and the peer, and keeps the socket for reuse', async () => {
    const harness = await guestJoins(await hostInRoom());
    const { pc } = await connectHost(harness);
    harness.controller.leaveRoom();
    expect(pc.closed).toBe(true);
    expect(harness.controller.getState()).toStrictEqual({ phase: 'leaving' });
    expect(harness.socket().sent.at(-1)?.type).toBe('ROOM_LEAVE');
    harness.socket().deliver({ type: 'ROOM_LEFT', payload: {} });
    expect(harness.controller.getState()).toStrictEqual({ phase: 'idle', notice: 'left' });
    expect(JSON.stringify(harness.controller.getState())).not.toContain(SECRET);
    expect(harness.socket().closeCalls).toStrictEqual([]);
  });

  it('does not reconnect a connection that carried no room', async () => {
    const harness = await hostInRoom();
    harness.controller.leaveRoom();
    harness.socket().deliver({ type: 'ROOM_LEFT', payload: {} });
    harness.socket().drop();
    await harness.timers.advance(120_000);
    expect(harness.sockets).toHaveLength(1);
    expect(harness.timers.pendingCount).toBe(0);
    expect(harness.controller.getState()).toStrictEqual({ phase: 'idle', notice: 'left' });
  });

  it('reports the reason for a connection the service closed after an error', async () => {
    const harness = await hostInRoom();
    harness.socket().deliver({
      type: 'ERROR',
      payload: { code: 'RATE_LIMITED', message: 'x', recoverable: false },
    });
    harness.socket().drop();
    expect(harness.controller.getState()).toStrictEqual({ phase: 'idle', notice: 'rate_limited' });
  });

  it('fails closed on an invalid server message', async () => {
    const harness = await guestJoins(await hostInRoom());
    harness.socket().deliverRaw('{"protocolVersion":1,"type":"ROOM_CLOSED"}');
    expect(harness.connection().closed).toBe(true);
    expect(harness.controller.getState()).toStrictEqual({
      phase: 'idle',
      notice: 'protocol_error',
    });
  });

  it('shuts down everything and stays usable', async () => {
    const harness = await guestJoins(await hostInRoom());
    const socket = harness.socket();
    harness.controller.shutdown();
    expect(harness.connection().closed).toBe(true);
    expect(socket.closeCalls).toStrictEqual([1000]);
    expect(harness.controller.getState()).toStrictEqual({ phase: 'idle', notice: null });
    harness.controller.createRoom();
    expect(harness.sockets).toHaveLength(2);
  });

  it('persists nothing', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const harness = await guestJoins(await hostInRoom());
    await connectHost(harness);
    harness.controller.leaveRoom();
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length + sessionStorage.length).toBe(0);
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('');
  });
});
