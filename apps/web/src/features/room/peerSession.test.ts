import {
  MAX_ICE_CANDIDATES_PER_NEGOTIATION,
  PEER_CONTROL_CHANNEL_LABEL,
  type NegotiationId,
  type ParticipantId,
  type SessionId,
} from '@driftless/protocol';
import { describe, expect, it } from 'vitest';
import {
  FakeDataChannel,
  FakePeerConnection,
  flush,
  nativeCandidate,
  peerMessage,
  remoteCandidate,
} from '../../test/room.ts';
import {
  MAX_QUEUED_REMOTE_CANDIDATE_BYTES,
  PeerSession,
  type NegotiationBody,
  type PeerFailure,
  type PeerSessionState,
} from './peerSession.ts';

const NEGOTIATION = 'N'.repeat(24) as NegotiationId;
const OTHER_NEGOTIATION = 'M'.repeat(24) as NegotiationId;
const HOST_ID = 'H'.repeat(16) as ParticipantId;
const GUEST_ID = 'G'.repeat(16) as ParticipantId;
const STRANGER_ID = 'S'.repeat(16) as ParticipantId;
const SESSION_ID = 'Q'.repeat(27) as SessionId;
const OTHER_SESSION_ID = 'P'.repeat(26).concat('A') as SessionId;

function setup(
  role: 'host' | 'guest',
  options: {
    signal?: (body: NegotiationBody) => boolean;
    previousNegotiationId?: NegotiationId;
  } = {},
) {
  const connections: FakePeerConnection[] = [];
  const signals: NegotiationBody[] = [];
  const states: { state: PeerSessionState; failure: PeerFailure | undefined }[] = [];
  const session = new PeerSession({
    role,
    sessionId: SESSION_ID,
    negotiationId: NEGOTIATION,
    ...(options.previousNegotiationId === undefined
      ? {}
      : { previousNegotiationId: options.previousNegotiationId }),
    localParticipantId: role === 'host' ? HOST_ID : GUEST_ID,
    remoteParticipantId: role === 'host' ? GUEST_ID : HOST_ID,
    configuration: { iceServers: [{ urls: ['stun:stun.example.org'] }] },
    createPeerConnection: (configuration) => {
      const connection = new FakePeerConnection(configuration);
      connections.push(connection);
      return connection.asPeerConnection();
    },
    signal:
      options.signal ??
      ((body) => {
        signals.push(body);
        return true;
      }),
    clock: () => 7,
    onStateChange: (state, failure) => states.push({ state, failure }),
  });
  const connection = () => {
    const current = connections[0];
    if (current === undefined) throw new Error('no connection');
    return current;
  };
  return { session, connections, connection, signals, states };
}

/** A host session whose offer has been sent. */
async function offeredHost() {
  const harness = setup('host');
  void harness.session.start();
  await flush();
  await harness.connection().settle('createOffer');
  await harness.connection().settle('setLocalDescription');
  return harness;
}

/** A guest session that has answered. */
async function answeredGuest() {
  const harness = setup('guest');
  void harness.session.acceptOffer('v=0\r\nremote-offer\r\n');
  await flush();
  await harness.connection().settle('setRemoteDescription');
  await harness.connection().settle('createAnswer');
  await harness.connection().settle('setLocalDescription');
  return harness;
}

const hello = (
  sequence: number,
  payload = {
    sessionId: SESSION_ID,
    negotiationId: NEGOTIATION,
    senderId: GUEST_ID,
    recipientId: HOST_ID,
  },
) => peerMessage('PEER_HELLO', payload, sequence);
const ready = (
  sequence: number,
  payload = {
    sessionId: SESSION_ID,
    negotiationId: NEGOTIATION,
    senderId: GUEST_ID,
    recipientId: HOST_ID,
  },
) => peerMessage('PEER_READY', payload, sequence);

describe('host negotiation', () => {
  it('creates exactly one ordered, reliable control channel and sends the offer', async () => {
    const { connection, connections, signals, session } = await offeredHost();
    expect(connections).toHaveLength(1);
    expect(connection().configuration).toStrictEqual({
      iceServers: [{ urls: ['stun:stun.example.org'] }],
    });
    expect(connection().channels.map((channel) => [channel.label, channel.init])).toStrictEqual([
      [PEER_CONTROL_CHANNEL_LABEL, { ordered: true }],
    ]);
    const [channel] = connection().channels;
    expect(channel?.maxRetransmits).toBeNull();
    expect(channel?.maxPacketLifeTime).toBeNull();
    expect(signals).toStrictEqual([
      { type: 'RTC_OFFER', payload: { negotiationId: NEGOTIATION, sdp: 'v=0\r\nfake-offer\r\n' } },
    ]);
    expect(session.state).toBe('negotiating');
    // No media of any kind.
    expect(connection().calls).not.toContain('addTrack');
    expect(connection().calls).not.toContain('addTransceiver');
  });

  it('applies the answer once, then moves to connecting', async () => {
    const { connection, session, states } = await offeredHost();
    void session.acceptAnswer('v=0\r\nanswer\r\n');
    void session.acceptAnswer('v=0\r\nsecond\r\n');
    await flush();
    await connection().settle('setRemoteDescription');
    expect(connection().remoteDescriptions).toStrictEqual([
      { type: 'answer', sdp: 'v=0\r\nanswer\r\n' },
    ]);
    expect(connection().hasPending('setRemoteDescription')).toBe(false);
    expect(states).toStrictEqual([{ state: 'connecting', failure: undefined }]);
  });

  it('ignores guest-only operations', async () => {
    const { session, connections } = setup('host');
    await session.acceptOffer('v=0\r\n');
    expect(connections).toHaveLength(0);
  });

  it('fails without retry when the offer cannot be created', async () => {
    const { session, connection, states, signals } = setup('host');
    void session.start();
    await flush();
    await connection().settle('createOffer', 'reject');
    expect(states).toStrictEqual([{ state: 'failed', failure: 'negotiation_failed' }]);
    expect(connection().closed).toBe(true);
    expect(connection().calls.filter((call) => call === 'createOffer')).toHaveLength(1);
    expect(signals).toStrictEqual([]);
  });
});

describe('guest negotiation', () => {
  it('applies the offer, sends the answer, and creates no channel of its own', async () => {
    const { connection, signals, states } = await answeredGuest();
    expect(connection().remoteDescriptions).toStrictEqual([
      { type: 'offer', sdp: 'v=0\r\nremote-offer\r\n' },
    ]);
    expect(connection().calls).not.toContain('createDataChannel');
    expect(signals).toStrictEqual([
      {
        type: 'RTC_ANSWER',
        payload: { negotiationId: NEGOTIATION, sdp: 'v=0\r\nfake-answer\r\n' },
      },
    ]);
    expect(states).toStrictEqual([{ state: 'connecting', failure: undefined }]);
  });

  it('accepts the expected control channel and binds it for binary-safe reads', async () => {
    const { connection, states } = await answeredGuest();
    const channel = new FakeDataChannel(PEER_CONTROL_CHANNEL_LABEL, { ordered: true });
    connection().announceChannel(channel);
    expect(channel.closed).toBe(false);
    expect(channel.binaryType).toBe('arraybuffer');
    expect(states.at(-1)?.state).toBe('connecting');
  });

  it.each([
    ['another label', new FakeDataChannel('driftless-media', { ordered: true })],
    ['an unordered channel', new FakeDataChannel(PEER_CONTROL_CHANNEL_LABEL, { ordered: false })],
    ['partial reliability', new FakeDataChannel(PEER_CONTROL_CHANNEL_LABEL, { maxRetransmits: 0 })],
    [
      'a lifetime limit',
      new FakeDataChannel(PEER_CONTROL_CHANNEL_LABEL, { maxPacketLifeTime: 100 }),
    ],
    ['a subprotocol', new FakeDataChannel(PEER_CONTROL_CHANNEL_LABEL, { protocol: 'x' })],
    [
      'a pre-negotiated channel',
      new FakeDataChannel(PEER_CONTROL_CHANNEL_LABEL, { negotiated: true, id: 0 }),
    ],
  ])('closes and fails on %s', async (_name, channel) => {
    const { connection, states } = await answeredGuest();
    connection().announceChannel(channel);
    expect(channel.closed).toBe(true);
    expect(states.at(-1)).toStrictEqual({ state: 'failed', failure: 'unexpected_channel' });
    expect(connection().closed).toBe(true);
  });

  it('does not trust a second channel', async () => {
    const { connection, states } = await answeredGuest();
    const first = new FakeDataChannel(PEER_CONTROL_CHANNEL_LABEL);
    const second = new FakeDataChannel(PEER_CONTROL_CHANNEL_LABEL);
    connection().announceChannel(first);
    connection().announceChannel(second);
    expect(second.closed).toBe(true);
    expect(first.closed).toBe(true);
    expect(states.at(-1)).toStrictEqual({ state: 'failed', failure: 'unexpected_channel' });
  });

  it('host rejects any channel the peer opens', async () => {
    const { connection, states } = await offeredHost();
    const intruder = new FakeDataChannel(PEER_CONTROL_CHANNEL_LABEL);
    connection().announceChannel(intruder);
    expect(intruder.closed).toBe(true);
    expect(states.at(-1)).toStrictEqual({ state: 'failed', failure: 'unexpected_channel' });
  });

  it('fails when the offer cannot be applied', async () => {
    const { session, connection, states, signals } = setup('guest');
    void session.acceptOffer('v=0\r\n');
    await flush();
    await connection().settle('setRemoteDescription', 'reject');
    expect(states).toStrictEqual([{ state: 'failed', failure: 'negotiation_failed' }]);
    expect(signals).toStrictEqual([]);
  });
});

describe('local ICE', () => {
  it('sends validated plain candidates after the description, then completion', async () => {
    const { session, connection, signals } = setup('host');
    void session.start();
    await flush();
    // Candidates gathered before the offer is sent are held, in order.
    connection().emitCandidate(nativeCandidate(1));
    await connection().settle('createOffer');
    connection().emitCandidate(nativeCandidate(2));
    connection().emitCandidate(null);
    expect(signals).toStrictEqual([]);
    await connection().settle('setLocalDescription');
    connection().emitCandidate(nativeCandidate(3));
    expect(signals.map((body) => body.type)).toStrictEqual([
      'RTC_OFFER',
      'ICE_CANDIDATE',
      'ICE_CANDIDATE',
      'ICE_COMPLETE',
    ]);
    expect(signals[1]).toStrictEqual({
      type: 'ICE_CANDIDATE',
      payload: { negotiationId: NEGOTIATION, candidate: nativeCandidate(1) },
    });
    // Nothing after completion is sent.
    expect(signals).toHaveLength(4);
  });

  it('serializes only the four browser fields, never the candidate object itself', async () => {
    const { connection, signals } = await offeredHost();
    connection().emitCandidate({
      ...nativeCandidate(1),
      address: '192.0.2.1',
      port: 1,
      toJSON: () => ({ leaked: true }),
    } as unknown as RTCIceCandidate);
    const body = signals.at(-1);
    if (body?.type !== 'ICE_CANDIDATE') throw new Error('expected a candidate');
    expect(Object.keys(body.payload.candidate)).toStrictEqual([
      'candidate',
      'sdpMid',
      'sdpMLineIndex',
      'usernameFragment',
    ]);
  });

  it('skips end-of-generation markers and out-of-bound candidates', async () => {
    const { connection, signals } = await offeredHost();
    connection().emitCandidate({ ...nativeCandidate(1), candidate: '' });
    connection().emitCandidate({ ...nativeCandidate(2), candidate: 'x'.repeat(2000) });
    connection().emitCandidate({ ...nativeCandidate(3), sdpMid: null, sdpMLineIndex: null });
    expect(signals.map((body) => body.type)).toStrictEqual(['RTC_OFFER']);
    for (let index = 0; index < MAX_ICE_CANDIDATES_PER_NEGOTIATION + 5; index += 1) {
      connection().emitCandidate(nativeCandidate(index));
    }
    expect(signals.filter((body) => body.type === 'ICE_CANDIDATE')).toHaveLength(
      MAX_ICE_CANDIDATES_PER_NEGOTIATION,
    );
  });

  it('fails when signaling cannot take a message', async () => {
    let accept = true;
    const { session, connection, states } = setup('host', { signal: () => accept });
    void session.start();
    await flush();
    await connection().settle('createOffer');
    await connection().settle('setLocalDescription');
    accept = false;
    connection().emitCandidate(nativeCandidate(1));
    expect(states.at(-1)).toStrictEqual({ state: 'failed', failure: 'signaling_unavailable' });
  });
});

describe('remote ICE', () => {
  it('holds candidates that arrive before the remote description, then applies them in order', async () => {
    const { session, connection } = setup('guest');
    void session.acceptOffer('v=0\r\n');
    await flush();
    session.addRemoteCandidate(remoteCandidate(1));
    session.addRemoteCandidate(remoteCandidate(2));
    expect(connection().addedCandidates).toStrictEqual([]);
    await connection().settle('setRemoteDescription');
    expect(connection().addedCandidates).toStrictEqual([remoteCandidate(1), remoteCandidate(2)]);
    session.addRemoteCandidate(remoteCandidate(3));
    expect(connection().addedCandidates.at(-1)).toStrictEqual(remoteCandidate(3));
  });

  it('host holds guest candidates until the answer is applied', async () => {
    const { session, connection } = await offeredHost();
    void session.acceptAnswer('v=0\r\n');
    session.addRemoteCandidate(remoteCandidate(1));
    await flush();
    expect(connection().addedCandidates).toStrictEqual([]);
    await connection().settle('setRemoteDescription');
    expect(connection().addedCandidates).toStrictEqual([remoteCandidate(1)]);
  });

  it('bounds the hold by aggregate size', async () => {
    const { session, connection, states } = setup('guest');
    void session.acceptOffer('v=0\r\n');
    await flush();
    const large = { ...remoteCandidate(1), candidate: `candidate:${'x'.repeat(1000)}` };
    const fits = Math.floor(MAX_QUEUED_REMOTE_CANDIDATE_BYTES / (large.candidate.length + 5));
    for (let index = 0; index < fits; index += 1) session.addRemoteCandidate(large);
    expect(states).toStrictEqual([]);
    session.addRemoteCandidate(large);
    expect(states).toStrictEqual([{ state: 'failed', failure: 'candidate_limit' }]);
    expect(connection().closed).toBe(true);
    // The hold was dropped: settling the description applies nothing.
    expect(connection().addedCandidates).toStrictEqual([]);
  });

  it('bounds the total number of remote candidates', async () => {
    const { session, connection, states } = await answeredGuest();
    for (let index = 0; index < MAX_ICE_CANDIDATES_PER_NEGOTIATION; index += 1) {
      session.addRemoteCandidate(remoteCandidate(index));
    }
    expect(connection().addedCandidates).toHaveLength(MAX_ICE_CANDIDATES_PER_NEGOTIATION);
    session.addRemoteCandidate(remoteCandidate(99));
    expect(states.at(-1)).toStrictEqual({ state: 'failed', failure: 'candidate_limit' });
  });

  it('refuses candidates after the peer completed gathering', async () => {
    const { session, connection, states } = await answeredGuest();
    session.addRemoteCandidate(remoteCandidate(1));
    session.remoteCandidatesComplete();
    expect(connection().calls.filter((call) => call === 'addIceCandidate')).toHaveLength(1);
    session.addRemoteCandidate(remoteCandidate(2));
    expect(states.at(-1)).toStrictEqual({ state: 'failed', failure: 'candidate_limit' });
    expect(connection().addedCandidates).toStrictEqual([remoteCandidate(1)]);
  });

  it('tolerates a candidate the browser cannot use', async () => {
    const { session, connection, states } = await answeredGuest();
    connection().rejectNextCandidate = true;
    session.addRemoteCandidate(remoteCandidate(1));
    session.addRemoteCandidate(remoteCandidate(2));
    await flush();
    expect(connection().addedCandidates).toHaveLength(2);
    expect(states.at(-1)?.state).toBe('connecting');
  });
});

describe('control channel handshake', () => {
  async function hostWithOpenChannel() {
    const harness = await offeredHost();
    const channel = harness.connection().channels[0];
    if (channel === undefined) throw new Error('no channel');
    channel.open();
    return { ...harness, channel };
  }

  it('connects only after each side has received the other handshake message', async () => {
    const { channel, states, session, connection } = await hostWithOpenChannel();
    connection().setConnectionState('connected');
    // A connected peer connection and an open channel are not yet enough.
    expect(session.state).toBe('negotiating');
    expect(channel.sent.map((message) => message.type)).toStrictEqual(['PEER_HELLO']);
    expect(channel.sent[0]?.payload).toStrictEqual({
      sessionId: SESSION_ID,
      negotiationId: NEGOTIATION,
      senderId: HOST_ID,
      recipientId: GUEST_ID,
    });
    channel.receive(hello(0));
    expect(channel.sent.map((message) => message.type)).toStrictEqual(['PEER_HELLO', 'PEER_READY']);
    expect(session.state).toBe('negotiating');
    channel.receive(ready(1));
    expect(session.state).toBe('connected');
    expect(states.at(-1)).toStrictEqual({ state: 'connected', failure: undefined });
    expect(channel.sent.map((message) => message.sequence)).toStrictEqual([0, 1]);
  });

  it('guest sends nothing until the host greets, then greets and connects symmetrically', async () => {
    const { connection, session } = await answeredGuest();
    const channel = new FakeDataChannel(PEER_CONTROL_CHANNEL_LABEL, { ordered: true });
    channel.readyState = 'open';
    connection().announceChannel(channel);
    channel.open();
    // An open channel alone does not make the guest send: the host's channel
    // may not have opened yet.
    expect(channel.sent).toStrictEqual([]);
    const fromHost = {
      sessionId: SESSION_ID,
      negotiationId: NEGOTIATION,
      senderId: HOST_ID,
      recipientId: GUEST_ID,
    };
    channel.receive(peerMessage('PEER_HELLO', fromHost, 0));
    expect(channel.sent.map((message) => [message.type, message.sequence])).toStrictEqual([
      ['PEER_HELLO', 0],
      ['PEER_READY', 1],
    ]);
    expect(session.state).toBe('connecting');
    channel.receive(peerMessage('PEER_READY', fromHost, 1));
    expect(session.state).toBe('connected');
  });

  it('guest refuses a PEER_READY that arrives before any greeting', async () => {
    const { connection, states } = await answeredGuest();
    const channel = new FakeDataChannel(PEER_CONTROL_CHANNEL_LABEL, { ordered: true });
    connection().announceChannel(channel);
    channel.open();
    channel.receive(
      peerMessage(
        'PEER_READY',
        {
          sessionId: SESSION_ID,
          negotiationId: NEGOTIATION,
          senderId: HOST_ID,
          recipientId: GUEST_ID,
        },
        0,
      ),
    );
    expect(states.at(-1)).toStrictEqual({ state: 'failed', failure: 'peer_protocol' });
  });

  it.each([
    [
      'a wrong negotiation',
      hello(0, {
        sessionId: SESSION_ID,
        negotiationId: OTHER_NEGOTIATION,
        senderId: GUEST_ID,
        recipientId: HOST_ID,
      }),
    ],
    [
      'another room session',
      hello(0, {
        sessionId: OTHER_SESSION_ID,
        negotiationId: NEGOTIATION,
        senderId: GUEST_ID,
        recipientId: HOST_ID,
      }),
    ],
    [
      'a wrong sender',
      hello(0, {
        sessionId: SESSION_ID,
        negotiationId: NEGOTIATION,
        senderId: STRANGER_ID,
        recipientId: HOST_ID,
      }),
    ],
    [
      'a wrong recipient',
      hello(0, {
        sessionId: SESSION_ID,
        negotiationId: NEGOTIATION,
        senderId: GUEST_ID,
        recipientId: STRANGER_ID,
      }),
    ],
    ['malformed JSON', '{'],
    [
      'an unknown message',
      '{"protocolVersion":1,"type":"PLAY","sequence":0,"sentAt":0,"payload":{}}',
    ],
    ['an oversized message', ' '.repeat(2000)],
    ['binary data', new ArrayBuffer(8)],
    [
      'a premature PEER_READY carrying the invite secret',
      `{"protocolVersion":1,"type":"PEER_READY","sequence":0,"sentAt":0,"payload":{"inviteSecret":"x"}}`,
    ],
  ])('fails on %s', async (_name, data) => {
    const { channel, states, connection } = await hostWithOpenChannel();
    channel.receive(data);
    expect(states.at(-1)).toStrictEqual({ state: 'failed', failure: 'peer_protocol' });
    expect(channel.closed).toBe(true);
    expect(connection().closed).toBe(true);
  });

  it('fails on a repeated handshake or a replayed sequence', async () => {
    const first = await hostWithOpenChannel();
    first.channel.receive(hello(0));
    first.channel.receive(hello(1));
    expect(first.states.at(-1)).toStrictEqual({ state: 'failed', failure: 'peer_protocol' });

    const second = await hostWithOpenChannel();
    second.channel.receive(hello(3));
    second.channel.receive(ready(3));
    expect(second.states.at(-1)).toStrictEqual({ state: 'failed', failure: 'peer_protocol' });

    const third = await hostWithOpenChannel();
    third.channel.receive(hello(0));
    third.channel.receive(ready(1));
    third.channel.receive(ready(2));
    expect(third.states.at(-1)).toStrictEqual({ state: 'failed', failure: 'peer_protocol' });
  });

  it('fails when the channel closes or the connection is lost, without retry', async () => {
    const closing = await hostWithOpenChannel();
    closing.channel.remoteClose();
    expect(closing.states.at(-1)).toStrictEqual({ state: 'failed', failure: 'channel_closed' });

    const connected = await hostWithOpenChannel();
    connected.channel.receive(hello(0));
    connected.channel.receive(ready(1));
    connected.connection().setConnectionState('disconnected');
    expect(connected.states.at(-1)).toStrictEqual({ state: 'failed', failure: 'connection_lost' });

    const failing = await offeredHost();
    failing.connection().setConnectionState('failed');
    expect(failing.states.at(-1)).toStrictEqual({ state: 'failed', failure: 'connection_failed' });
    // No second connection, offer, or ICE restart follows.
    await flush();
    expect(failing.connections).toHaveLength(1);
    expect(failing.connection().calls.filter((call) => call === 'createOffer')).toHaveLength(1);
  });
});

describe('cleanup and stale callbacks', () => {
  it('closes the channel and connection, detaches handlers, and reports nothing', async () => {
    const { session, connection, states, signals } = await offeredHost();
    const channel = connection().channels[0];
    session.addRemoteCandidate(remoteCandidate(1));
    session.close();
    session.close();
    expect(session.state).toBe('closed');
    expect(connection().closed).toBe(true);
    expect(channel?.closed).toBe(true);
    expect([
      connection().onicecandidate,
      connection().onconnectionstatechange,
      connection().ondatachannel,
      channel?.onopen,
      channel?.onmessage,
      channel?.onclose,
      channel?.onerror,
    ]).toStrictEqual([null, null, null, null, null, null, null]);
    expect(states).toStrictEqual([]);
    const sent = signals.length;
    // Late operations on a closed session do nothing.
    await session.acceptAnswer('v=0\r\n');
    session.addRemoteCandidate(remoteCandidate(2));
    session.remoteCandidatesComplete();
    expect(connection().addedCandidates).toStrictEqual([]);
    expect(signals).toHaveLength(sent);
  });

  it('ignores an async continuation that resolves after close', async () => {
    const { session, connection, signals, states } = setup('host');
    void session.start();
    await flush();
    await connection().settle('createOffer');
    session.close();
    await connection().settle('setLocalDescription');
    expect(signals).toStrictEqual([]);
    expect(states).toStrictEqual([]);
    expect(connection().hasPending('setLocalDescription')).toBe(false);
  });

  it('ignores a guest answer that completes after close', async () => {
    const { session, connection, signals } = setup('guest');
    void session.acceptOffer('v=0\r\n');
    await flush();
    await connection().settle('setRemoteDescription');
    await connection().settle('createAnswer');
    session.close();
    await connection().settle('setLocalDescription');
    expect(signals).toStrictEqual([]);
  });

  it('ignores events captured from a torn-down connection', async () => {
    const { session, connection, states, signals } = await offeredHost();
    const channel = connection().channels[0];
    const { onicecandidate, onconnectionstatechange } = connection();
    const channelMessage = channel?.onmessage;
    session.close();
    // Handlers that a browser had already queued run after teardown.
    onicecandidate?.call(
      connection() as unknown as RTCPeerConnection,
      {
        candidate: nativeCandidate(1),
      } as RTCPeerConnectionIceEvent,
    );
    onconnectionstatechange?.call(connection() as unknown as RTCPeerConnection, new Event('x'));
    channelMessage?.call(
      channel?.asChannel() as RTCDataChannel,
      new MessageEvent('message', { data: hello(0) }),
    );
    expect(states).toStrictEqual([]);
    expect(signals.map((body) => body.type)).toStrictEqual(['RTC_OFFER']);
  });

  it('reports a failure once', async () => {
    const { connection, states } = await offeredHost();
    const channel = connection().channels[0];
    const { onconnectionstatechange } = connection();
    connection().setConnectionState('failed');
    onconnectionstatechange?.call(connection() as unknown as RTCPeerConnection, new Event('x'));
    channel?.remoteClose();
    expect(states).toStrictEqual([{ state: 'failed', failure: 'connection_failed' }]);
  });
});

describe('recovery sessions and signaling loss', () => {
  it('sends a recovery offer naming the negotiation it replaces', async () => {
    const harness = setup('host', { previousNegotiationId: OTHER_NEGOTIATION });
    void harness.session.start();
    await flush();
    await harness.connection().settle('createOffer');
    await harness.connection().settle('setLocalDescription');
    expect(harness.signals[0]).toStrictEqual({
      type: 'RTC_RECOVER',
      payload: {
        previousNegotiationId: OTHER_NEGOTIATION,
        negotiationId: NEGOTIATION,
        sdp: 'v=0\r\nfake-offer\r\n',
      },
    });
    // A fresh connection and a fresh control channel.
    expect(harness.connections).toHaveLength(1);
    expect(harness.connection().channels.map((channel) => channel.label)).toStrictEqual([
      PEER_CONTROL_CHANNEL_LABEL,
    ]);
  });

  it('stays connected when signaling can no longer carry a late candidate', async () => {
    let signalingUp = true;
    const harness = setup('host', { signal: () => signalingUp });
    void harness.session.start();
    await flush();
    await harness.connection().settle('createOffer');
    await harness.connection().settle('setLocalDescription');
    const channel = harness.connection().channels[0];
    if (channel === undefined) throw new Error('no channel');
    channel.open();
    channel.receive(hello(0));
    channel.receive(ready(1));
    expect(harness.session.state).toBe('connected');
    signalingUp = false;
    harness.connection().emitCandidate(nativeCandidate(5));
    harness.connection().emitCandidate(null);
    expect(harness.session.state).toBe('connected');
    expect(harness.states.at(-1)).toStrictEqual({ state: 'connected', failure: undefined });
  });
});
